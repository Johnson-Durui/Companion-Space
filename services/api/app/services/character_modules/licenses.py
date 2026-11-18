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


class CharacterLicenseMixin:
    @staticmethod
    def _permission_flag(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        lowered = value.strip().lower()
        if not lowered:
            return None
        if lowered in _REDISTRIBUTION_ALLOWED:
            return "yes"
        if lowered in {"0", "disallowed", "false", "no", "prohibited", "unknown"}:
            return "no"
        return None

    @classmethod
    def _merge_manifest_with_vrm_meta(cls, manifest: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
        merged = cls._clone_json_like(manifest)
        merged["vrm_meta"] = meta
        merged["license"] = merged.get("license") or meta.get("license_name") or meta.get("license_url") or "unknown"
        merged["author"] = merged.get("author") or meta.get("author") or ", ".join(meta.get("authors", []))
        merged["source_url"] = merged.get("source_url") or meta.get("license_url") or meta.get("other_license_url") or ""
        merged["redistribution_allowed"] = cls._combine_binary_permission(
            merged.get("redistribution_allowed"),
            meta.get("redistribution_allowed"),
        )
        merged["modification_allowed"] = cls._combine_ternary_permission(
            merged.get("modification_allowed"),
            meta.get("modification_allowed"),
        )
        merged["attribution_required"] = cls._combine_attribution_requirement(
            merged.get("attribution_required"),
            meta.get("attribution_required"),
        )
        merged["usage_restrictions"] = meta.get("usage_restrictions", {})
        return merged

    @classmethod
    def _combine_binary_permission(cls, left: object, right: object) -> str:
        left_flag = cls._permission_flag(left)
        right_flag = cls._permission_flag(right)
        if left_flag == "yes" and right_flag == "yes":
            return "yes"
        if left_flag is None:
            return right_flag or "no"
        if right_flag is None:
            return left_flag
        return "no"

    @staticmethod
    def _combine_ternary_permission(left: object, right: object) -> str:
        values = {str(item).strip().lower() for item in (left, right) if isinstance(item, str) and item.strip()}
        if "no" in values:
            return "no"
        if "yes" in values and values <= {"yes"}:
            return "yes"
        if not values:
            return "unknown"
        return "unknown"

    @staticmethod
    def _combine_attribution_requirement(left: object, right: object) -> str:
        values = {str(item).strip().lower() for item in (left, right) if isinstance(item, str) and item.strip()}
        if "yes" in values:
            return "yes"
        if values == {"no"}:
            return "no"
        return "unknown"
