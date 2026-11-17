from __future__ import annotations

import json
import mimetypes
import shutil
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlsplit

from app.models.domain import CharacterPack
from app.services.character_modules.common import (
    _CREDENTIAL_KEY_PARTS,
    _CREDENTIAL_VALUE_PATTERNS,
    _EXECUTABLE_SUFFIXES,
    _WINDOWS_INVALID_PATH_CHARACTERS,
    _WINDOWS_RESERVED_PATH_NAMES,
    _existing_io_file,
    _windows_io_path,
)


class CharacterPathMixin:
    @classmethod
    def _listed_asset_paths(cls, manifest: dict[str, Any]) -> list[str]:
        paths: list[str] = []
        asset_paths = manifest.get("asset_paths")
        if asset_paths is not None:
            if not isinstance(asset_paths, list) or not all(isinstance(item, str) and item.strip() for item in asset_paths):
                raise ValueError("Character asset manifest asset_paths must be a list of non-empty strings")
            paths.extend(item.strip() for item in asset_paths)
        for key, value in manifest.items():
            if isinstance(value, str) and value.strip() and key.lower().endswith("_path"):
                paths.append(value.strip())
        deduped: list[str] = []
        seen: set[str] = set()
        for path in paths:
            if path not in seen:
                seen.add(path)
                deduped.append(path)
        return deduped

    @staticmethod
    def _portable_path_key(path: str) -> str:
        return unicodedata.normalize("NFC", path).casefold()

    @classmethod
    def _normalize_requested_asset_path(cls, path: str) -> str:
        return cls._normalize_relative_posix_path(path, traversal_message="Character asset path is outside its configured root")

    @classmethod
    def _normalize_relative_posix_path(cls, path_value: str, *, traversal_message: str) -> str:
        name = str(path_value or "")
        if "\\" in name:
            raise ValueError(traversal_message)
        path = PurePosixPath(name)
        if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
            raise ValueError(traversal_message)
        for part in path.parts:
            normalized = unicodedata.normalize("NFC", part)
            if normalized.endswith((" ", ".")):
                raise ValueError(traversal_message)
            if any(character in _WINDOWS_INVALID_PATH_CHARACTERS or ord(character) < 32 for character in normalized):
                raise ValueError(traversal_message)
            if normalized.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_PATH_NAMES:
                raise ValueError(traversal_message)
        return path.as_posix()

    @staticmethod
    def _is_executable_name(path: str) -> bool:
        return Path(path).suffix.lower() in _EXECUTABLE_SUFFIXES

    @staticmethod
    def _guess_media_type(path: str) -> str:
        if path.lower().endswith((".vrm", ".vrma")):
            return "model/gltf-binary"
        if path.lower().endswith(".zip"):
            return "application/zip"
        guessed, _encoding = mimetypes.guess_type(path)
        return guessed or "application/octet-stream"

    def _ensure_size_limit(self, size: int) -> None:
        if size > self.repository.settings.max_character_pack_size_bytes:
            raise ValueError("Character pack exceeds the configured size limit")

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
