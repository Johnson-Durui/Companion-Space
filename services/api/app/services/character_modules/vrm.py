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


class VrmValidationMixin:
    def _parse_vrm_bytes(self, data: bytes) -> dict[str, Any]:
        self._ensure_size_limit(len(data))
        document, _binary = self._parse_glb_json(
            data,
            error_message="Invalid VRM signature",
            allow_unknown_chunks=True,
        )

        extensions = document.get("extensions")
        if not isinstance(extensions, dict):
            raise ValueError("Invalid VRM signature")
        if isinstance(extensions.get("VRMC_vrm"), dict):
            extension = extensions["VRMC_vrm"]
            meta = extension.get("meta")
            if not isinstance(meta, dict):
                raise ValueError("VRM metadata is missing")
            return self._normalize_vrm1_meta(meta, extension.get("specVersion"))
        if isinstance(extensions.get("VRM"), dict):
            extension = extensions["VRM"]
            meta = extension.get("meta")
            if not isinstance(meta, dict):
                raise ValueError("VRM metadata is missing")
            return self._normalize_vrm0_meta(meta)
        raise ValueError("VRM metadata is missing")

    @staticmethod
    def _parse_glb_json(
        data: bytes,
        *,
        error_message: str,
        allow_unknown_chunks: bool,
    ) -> tuple[dict[str, Any], bytes | None]:
        if len(data) < 20 or data[:4] != b"glTF":
            raise ValueError(error_message)
        try:
            _magic, version, total_length = struct.unpack("<4sII", data[:12])
        except struct.error as exc:
            raise ValueError(error_message) from exc
        if version != 2 or total_length != len(data):
            raise ValueError(error_message)

        cursor = 12
        chunks: list[tuple[bytes, bytes]] = []
        while cursor < len(data):
            if cursor + 8 > len(data):
                raise ValueError(error_message)
            chunk_length, chunk_type = struct.unpack("<I4s", data[cursor : cursor + 8])
            cursor += 8
            if chunk_length % 4 != 0:
                raise ValueError(error_message)
            chunk_payload = data[cursor : cursor + chunk_length]
            if len(chunk_payload) != chunk_length:
                raise ValueError(error_message)
            cursor += chunk_length
            chunks.append((chunk_type, chunk_payload))
        if (
            not chunks
            or chunks[0][0] != b"JSON"
            or sum(chunk_type == b"JSON" for chunk_type, _payload in chunks) != 1
            or sum(chunk_type == b"BIN\0" for chunk_type, _payload in chunks) > 1
            or (
                not allow_unknown_chunks
                and any(chunk_type not in {b"JSON", b"BIN\0"} for chunk_type, _payload in chunks)
            )
        ):
            raise ValueError(error_message)
        json_chunk = chunks[0][1]
        binary = next(
            (payload for chunk_type, payload in chunks if chunk_type == b"BIN\0"),
            None,
        )

        try:
            document = json.loads(json_chunk.decode("utf-8").rstrip(" \t\r\n\0"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(error_message) from exc
        if not isinstance(document, dict):
            raise ValueError(error_message)
        return document, binary

    @staticmethod
    def _normalize_vrm0_meta(meta: dict[str, Any]) -> dict[str, Any]:
        license_name = str(meta.get("licenseName") or "").strip()
        hub_permissions = _parse_vroid_hub_permissions(meta)
        redistribution_allowed = hub_permissions.get(
            "redistribution_allowed",
            "yes"
            if license_name
            and license_name not in {"Redistribution_Prohibited", "Other"}
            else "no",
        )
        if hub_permissions:
            modification_allowed = hub_permissions["modification_allowed"]
            attribution_required = hub_permissions["attribution_required"]
        elif not license_name or license_name == "Other":
            modification_allowed = "unknown"
            attribution_required = "unknown"
        else:
            modification_allowed = "no" if license_name in _VRM0_NO_MODIFICATION_LICENSES else "yes"
            attribution_required = "no" if license_name == "CC0" else "yes"
        return {
            "spec_version": "0.x",
            "title": str(meta.get("title") or "").strip(),
            "name": str(meta.get("title") or "").strip(),
            "author": str(meta.get("author") or "").strip(),
            "authors": [str(meta.get("author") or "").strip()] if str(meta.get("author") or "").strip() else [],
            "license_name": license_name or "unknown",
            "license_url": "",
            "other_license_url": str(meta.get("otherLicenseUrl") or "").strip(),
            "redistribution_allowed": redistribution_allowed,
            "modification_allowed": modification_allowed,
            "attribution_required": attribution_required,
            "usage_restrictions": {
                "avatar_permission": str(meta.get("allowedUserName") or "").strip(),
                "violent_usage": str(meta.get("violentUssageName") or "").strip(),
                "sexual_usage": str(meta.get("sexualUssageName") or "").strip(),
                "commercial_usage": str(meta.get("commercialUssageName") or "").strip(),
                "other_permission_url": str(meta.get("otherPermissionUrl") or "").strip(),
            },
        }

    @staticmethod
    def _normalize_vrm1_meta(meta: dict[str, Any], spec_version: object) -> dict[str, Any]:
        authors = meta.get("authors")
        author_list = [str(item).strip() for item in authors] if isinstance(authors, list) else []
        author_list = [item for item in author_list if item]
        modification = str(meta.get("modification") or "").strip().lower()
        if not modification:
            modification_allowed = "unknown"
        elif "prohibit" in modification or modification == "disallow":
            modification_allowed = "no"
        else:
            modification_allowed = "yes"
        credit_notation = str(meta.get("creditNotation") or "").strip().lower()
        if credit_notation in {"required", "required_credit"}:
            attribution_required = "yes"
        elif credit_notation in {"unnecessary", "none", "notrequired"}:
            attribution_required = "no"
        else:
            attribution_required = "unknown"
        return {
            "spec_version": str(spec_version or "1.0").strip() or "1.0",
            "title": str(meta.get("name") or "").strip(),
            "name": str(meta.get("name") or "").strip(),
            "author": author_list[0] if author_list else "",
            "authors": author_list,
            "license_name": str(meta.get("licenseName") or "").strip(),
            "license_url": str(meta.get("licenseUrl") or "").strip(),
            "other_license_url": str(meta.get("otherLicenseUrl") or "").strip(),
            "redistribution_allowed": "yes" if bool(meta.get("allowRedistribution")) else "no",
            "modification_allowed": modification_allowed,
            "attribution_required": attribution_required,
            "usage_restrictions": {
                "avatar_permission": str(meta.get("avatarPermission") or "").strip(),
                "allow_excessively_violent_usage": bool(meta.get("allowExcessivelyViolentUsage")),
                "allow_excessively_sexual_usage": bool(meta.get("allowExcessivelySexualUsage")),
                "commercial_usage": str(meta.get("commercialUsage") or "").strip(),
                "allow_political_or_religious_usage": bool(meta.get("allowPoliticalOrReligiousUsage")),
                "allow_antisocial_or_hate_usage": bool(meta.get("allowAntisocialOrHateUsage")),
                "credit_notation": str(meta.get("creditNotation") or "").strip(),
                "modification": str(meta.get("modification") or "").strip(),
            },
        }
