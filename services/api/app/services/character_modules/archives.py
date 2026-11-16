from __future__ import annotations

# ruff: noqa: F401,F403,F405
import hashlib
import json
import logging
import math
import mimetypes
import os
import re
import shutil
import stat
import struct
import unicodedata
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from app.models.domain import CharacterPack, CharacterRecipe, DEFAULT_CHARACTER_RECIPE_DATA
from app.services.character_modules.common import *
from app.services.repository import SQLiteRepository


class CharacterArchiveMixin:
    def _read_character_pack_archive(
        self,
        *,
        archive: ZipFile,
        members: dict[str, Any],
    ) -> dict[str, bytes]:
        files: dict[str, bytes] = {}
        for normalized_name, info in members.items():
            content = archive.read(info)
            self._validate_archive_member_content(normalized_name, content)
            files[normalized_name] = content

        missing = [name for name in _PACK_METADATA_FILES if name not in files]
        if missing:
            raise ValueError(f"Character pack is missing required metadata files: {', '.join(sorted(missing))}")
        return files

    @staticmethod
    def _validate_character_zip_index(data: bytes) -> None:
        search_start = max(0, len(data) - (65_535 + 22))
        cursor = len(data)
        eocd_offset = -1
        while cursor > search_start:
            candidate = data.rfind(_ZIP_EOCD_SIGNATURE, search_start, cursor)
            if candidate < 0:
                break
            if candidate + 22 <= len(data):
                comment_length = struct.unpack_from("<H", data, candidate + 20)[0]
                if candidate + 22 + comment_length == len(data):
                    eocd_offset = candidate
                    break
            cursor = candidate
        if eocd_offset < 0:
            raise ValueError("Invalid character pack zip signature")

        disk_number, central_disk, disk_entries, total_entries = struct.unpack_from(
            "<HHHH",
            data,
            eocd_offset + 4,
        )
        central_size, central_offset = struct.unpack_from("<II", data, eocd_offset + 12)
        if disk_number != 0 or central_disk != 0 or disk_entries != total_entries:
            raise ValueError("Character pack cannot span multiple zip disks")
        if total_entries == 0xFFFF or central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF:
            raise ValueError("Character pack zip64 archives are not supported")
        if total_entries > _MAX_CHARACTER_ARCHIVE_MEMBERS:
            raise ValueError("Character pack contains too many files")
        if central_size > _MAX_CHARACTER_CENTRAL_DIRECTORY_BYTES:
            raise ValueError("Character pack central directory exceeds the size limit")
        if central_offset + central_size > eocd_offset:
            raise ValueError("Invalid character pack zip signature")

    def _write_asset_files(self, character_id: str, asset_files: dict[str, bytes]) -> None:
        asset_root = self._asset_root(character_id)
        if asset_root.exists() or _windows_io_path(asset_root).exists():
            raise ValueError("Character asset directory already exists")
        io_root = _windows_io_path(asset_root)
        try:
            io_root.mkdir(parents=True, exist_ok=False)
            for relative_path, content in asset_files.items():
                target = self._contained_child(asset_root, relative_path)
                io_target = _windows_io_path(target)
                io_target.parent.mkdir(parents=True, exist_ok=True)
                io_target.write_bytes(content)
        except Exception:
            shutil.rmtree(io_root, ignore_errors=True)
            shutil.rmtree(asset_root, ignore_errors=True)
            raise

    def _copy_character_assets(self, source: CharacterPack, duplicate_id: str) -> None:
        source_root = self._asset_root(source.id)
        if not source_root.exists():
            return
        asset_paths = self._listed_asset_paths(self._clone_json_like(source.asset_manifest))
        if not asset_paths:
            asset_paths = [
                path.relative_to(source_root).as_posix()
                for path in source_root.rglob("*")
                if path.is_file()
            ]
        asset_files: dict[str, bytes] = {}
        for relative_path in asset_paths:
            source_file = self._contained_child(source_root, relative_path)
            readable = _existing_io_file(source_file)
            if readable is None:
                raise ValueError(f"Character asset is missing or is not a file: {relative_path}")
            asset_files[relative_path] = readable.read_bytes()
        self._validate_managed_motion_files(
            self._clone_json_like(source.asset_manifest),
            asset_files,
        )
        if asset_files:
            self._write_asset_files(duplicate_id, asset_files)

    def _asset_root(self, character_id: str) -> Path:
        return self._contained_child(self.repository.settings.characters_root, character_id)

    @staticmethod
    def _clean_name(value: object) -> str:
        cleaned = str(value).strip()
        if not cleaned:
            raise ValueError("Character name cannot be empty")
        return cleaned

    @staticmethod
    def _contained_child(root: Path, relative_path: str) -> Path:
        if Path(relative_path).is_absolute():
            raise ValueError("Character asset path is outside its configured root")
        resolved_root = root.resolve()
        raw_candidate = resolved_root / relative_path
        cursor = resolved_root
        for part in Path(relative_path).parts:
            cursor /= part
            if cursor.is_symlink():
                raise ValueError("Character asset path is outside its configured root")
        candidate = raw_candidate.resolve()
        if not candidate.is_relative_to(resolved_root):
            raise ValueError("Character asset path is outside its configured root")
        return candidate

    @classmethod
    def _validate_manifest_keys(cls, manifest: dict[str, Any]) -> None:
        if not isinstance(manifest, dict):
            raise ValueError("Character asset manifest must be a JSON object")
        try:
            cls._walk_manifest_value(manifest)
        except RecursionError as exc:
            raise ValueError("Character asset manifest nesting exceeds the limit") from exc

    @staticmethod
    def _strip_untrusted_airi_provenance(manifest: dict[str, Any]) -> None:
        airi_only_keys = _AIRI_TRUSTED_PROVENANCE_KEYS - {"source_format"}
        if (
            manifest.get("source_format") != "airi-character-card"
            and not airi_only_keys.intersection(manifest)
        ):
            return
        for key in _AIRI_TRUSTED_PROVENANCE_KEYS:
            manifest.pop(key, None)

    @classmethod
    def _walk_manifest_value(cls, value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = str(key).lower().replace("-", "_")
                if any(part in normalized for part in _CREDENTIAL_KEY_PARTS):
                    raise ValueError("Character asset manifest contains a credential-shaped key")
                cls._walk_manifest_value(child)
            return
        if isinstance(value, list):
            for item in value:
                cls._walk_manifest_value(item)
            return
        if isinstance(value, str):
            cls._validate_manifest_string(value)
            return
        if value is None or isinstance(value, (int, float, bool)):
            return
        raise ValueError("Character asset manifest values must be JSON-serializable")

    @classmethod
    def _validate_manifest_string(cls, value: str) -> None:
        text = value.strip()
        if not text:
            return
        if cls._looks_like_credential_url(text):
            raise ValueError("Character asset manifest contains a credential-shaped string value")
        lowered = text.lower()
        if lowered.startswith(("http://", "https://")):
            return
        if any(pattern.search(text) for pattern in _CREDENTIAL_VALUE_PATTERNS):
            raise ValueError("Character asset manifest contains a credential-shaped string value")

    @staticmethod
    def _looks_like_credential_url(value: str) -> bool:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            return False
        if parsed.username or parsed.password:
            return True
        query = parse_qs(parsed.query, keep_blank_values=False)
        for key, values in query.items():
            normalized = key.lower().replace("-", "_")
            if any(part in normalized for part in _CREDENTIAL_KEY_PARTS) and any(
                item.strip() for item in values if isinstance(item, str)
            ):
                return True
        fragment = parsed.fragment.strip()
        if fragment and any(pattern.search(fragment) for pattern in _CREDENTIAL_VALUE_PATTERNS):
            return True
        return False

    @staticmethod
    def _clone_json_like(value: Any) -> Any:
        return json.loads(json.dumps(value, ensure_ascii=False))

    @staticmethod
    def _json_bytes(payload: object) -> bytes:
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
