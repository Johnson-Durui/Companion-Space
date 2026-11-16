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

    @classmethod
    def _normalize_archive_member_name(cls, name: str) -> str:
        return cls._normalize_relative_posix_path(name, traversal_message="Character pack contains an unsafe path traversal entry")

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

    @classmethod
    def _validate_archive_member(cls, info, name: str) -> None:
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError("Character pack cannot contain symlinks")
        if info.is_dir():
            return
        if mode & 0o111:
            raise ValueError("Character pack cannot contain executable files")
        if cls._is_executable_name(name):
            raise ValueError("Character pack cannot contain executable files")

    @classmethod
    def _validate_archive_member_content(cls, name: str, content: bytes) -> None:
        if any(content.startswith(signature) for signature in _EXECUTABLE_SIGNATURES):
            raise ValueError(f"Character pack cannot contain executable file content: {name}")

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

    @staticmethod
    def _read_json_object(data: bytes, label: str) -> dict[str, Any]:
        try:
            value = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
            raise ValueError(f"{label} must be valid UTF-8 JSON") from exc
        if not isinstance(value, dict):
            raise ValueError(f"{label} must contain a JSON object")
        return value
