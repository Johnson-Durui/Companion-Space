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


class AiriImportMixin:
    def _read_airi_character_card_archive(
        self,
        *,
        archive: ZipFile,
        members: dict[str, Any],
    ) -> tuple[bytes, dict[str, Any], dict[str, bytes]] | None:
        if _AIRI_MANIFEST_PATH not in members:
            return None

        native_complete = _PACK_METADATA_FILES.issubset(members)
        manifest_info = members[_AIRI_MANIFEST_PATH]
        if manifest_info.file_size > CHARACTER_CARD_MAX_BYTES:
            if native_complete:
                return None
            raise ValueError("AIRI manifest metadata exceeds the size limit")
        manifest_bytes = archive.read(manifest_info)
        if len(manifest_bytes) > CHARACTER_CARD_MAX_BYTES:
            if native_complete:
                return None
            raise ValueError("AIRI manifest metadata exceeds the size limit")
        try:
            manifest = self._read_json_object(manifest_bytes, "AIRI manifest.json")
        except ValueError:
            if native_complete:
                return None
            raise
        if manifest.get("format") != "airi-character-card":
            if native_complete:
                return None
            raise ValueError("Unsupported AIRI manifest format")
        if _PACK_METADATA_FILES & members.keys():
            raise ValueError("Character pack is ambiguous between native and AIRI formats")

        card_ref = manifest.get("card")
        if type(manifest.get("version")) is not int or manifest["version"] != 1:
            raise ValueError("Unsupported AIRI manifest version")
        if not isinstance(card_ref, dict) or card_ref.get("path") != _AIRI_CARD_PATH:
            raise ValueError("AIRI manifest card.path must be card.json")
        if card_ref.get("spec") != "chara_card_v3":
            raise ValueError("AIRI manifest card.spec must be chara_card_v3")
        card_info = members.get(_AIRI_CARD_PATH)
        if card_info is None:
            raise ValueError("AIRI character card archive is missing card.json")
        if card_info.file_size > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("AIRI card metadata exceeds the size limit")

        card_bytes = archive.read(card_info)
        if len(card_bytes) > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("AIRI card metadata exceeds the size limit")
        card_payload = self._read_json_object(card_bytes, "AIRI card.json")
        if card_payload.get("spec") != "chara_card_v3":
            raise ValueError("AIRI manifest card.spec does not match card.json spec")
        if card_payload.get("spec_version") != "3.0":
            raise ValueError("AIRI card.json spec_version must be 3.0")
        card_data = card_payload.get("data")
        if not isinstance(card_data, dict):
            raise ValueError("Character card data must be a JSON object")
        for field in ("character_version", "creator_notes"):
            if field in card_data and not isinstance(card_data[field], str):
                raise ValueError(f"AIRI card.json data.{field} must be a string")
        if "extensions" in card_data and not isinstance(card_data["extensions"], dict):
            raise ValueError("AIRI card.json data.extensions must be a JSON object")
        sanitized_card_bytes = json.dumps(
            {
                "spec": "chara_card_v3",
                "spec_version": "3.0",
                "data": {
                    key: value
                    for key, value in card_data.items()
                    if key in _AIRI_PERSONA_IMPORT_FIELDS
                },
            },
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii")

        provenance: dict[str, Any] = {
            "source_format": "airi-character-card",
            "source_container_version": 1,
            "source_card_spec": "chara_card_v3",
        }
        asset_files: dict[str, bytes] = {}
        resources = manifest.get("resources")
        if resources is not None:
            if not isinstance(resources, dict):
                raise ValueError("AIRI manifest resources must be a JSON object")
            display_model = resources.get("displayModel")
            if not isinstance(display_model, dict):
                raise ValueError("AIRI manifest resources.displayModel must be a JSON object")
            display_format = display_model.get("format")
            if not isinstance(display_format, str) or display_format not in _AIRI_DISPLAY_MODEL_FORMATS:
                raise ValueError("Unsupported AIRI display model format")
            display_path = display_model.get("path")
            if not isinstance(display_path, str) or not display_path:
                raise ValueError("AIRI manifest display model path must be a string")
            normalized_path = self._normalize_archive_member_name(display_path)
            display_info = members.get(normalized_path)
            if display_info is None:
                raise ValueError("AIRI character card archive is missing its display model")
            if display_info.file_size <= 0:
                raise ValueError("AIRI display model is empty")
            display_name = display_model.get("name")
            if not isinstance(display_name, str):
                raise ValueError("AIRI manifest display model name must be a string")
            display_name = self._clean_character_card_text(display_name).strip()
            if len(display_name) > 255:
                raise ValueError("AIRI display model name exceeds the field limit")
            self._validate_manifest_string(display_name)
            provenance["source_display_model_format"] = display_format
            if display_name:
                provenance["source_display_model_name"] = display_name
            if display_format == "vrm":
                display_bytes = archive.read(display_info)
                if not display_bytes:
                    raise ValueError("AIRI display model is empty")
                asset_files, vrm_manifest = self._build_vrm_asset_bundle(
                    filename=Path(normalized_path).name,
                    data=display_bytes,
                )
                provenance = {**vrm_manifest, **provenance}
                provenance["source_display_model_imported"] = True
            else:
                display_bytes = archive.read(display_info)
                if not display_bytes:
                    raise ValueError("AIRI display model is empty")
                asset_files, display_manifest = self._build_airi_archive_display_model_bundle(
                    display_format=display_format,
                    filename=Path(normalized_path).name,
                    data=display_bytes,
                )
                provenance = {**display_manifest, **provenance}
                provenance["source_display_model_imported"] = True
        if not asset_files:
            provenance = {
                "pack_kind": "recipe-only",
                "render_mode": "vrm-or-2d-fallback",
                **provenance,
            }
        self._validate_manifest_keys(provenance)
        return sanitized_card_bytes, provenance, asset_files

    def _build_airi_archive_display_model_bundle(
        self,
        *,
        display_format: str,
        filename: str,
        data: bytes,
    ) -> tuple[dict[str, bytes], dict[str, Any]]:
        if display_format not in _AIRI_ARCHIVE_DISPLAY_MODEL_FORMATS:
            raise ValueError("Unsupported AIRI archive display model format")
        self._ensure_size_limit(len(data))
        if not data.startswith(b"PK"):
            raise ValueError("Invalid AIRI display model zip signature")
        self._validate_character_zip_index(data)
        try:
            with ZipFile(BytesIO(data)) as archive:
                members = self._index_character_archive(archive)
                files: dict[str, bytes] = {}
                for name, info in members.items():
                    content = archive.read(info)
                    self._validate_archive_member_content(name, content)
                    files[name] = content
        except (BadZipFile, NotImplementedError, OSError, RuntimeError) as exc:
            raise ValueError("Invalid AIRI display model zip signature") from exc
        if not files:
            raise ValueError("AIRI display model zip is empty")

        entrypoint = (
            self._validate_live2d_archive(files)
            if display_format == "live2d-zip"
            else self._validate_spine_archive(files)
        )
        digest = hashlib.sha256(data).hexdigest()
        source_filename = self._clean_character_card_text(Path(filename).name).strip()
        if not source_filename or len(source_filename) > 255:
            raise ValueError("AIRI display model source filename is invalid")
        self._validate_manifest_string(source_filename)
        license_facts = {
            "format": display_format,
            "validation_level": "structure-only",
            "rights_verified": False,
            "redistribution_allowed": "no",
            "local_only": True,
            "sha256": digest,
        }
        asset_files = {
            _AIRI_DISPLAY_MODEL_ASSET_PATH: data,
            _AIRI_DISPLAY_MODEL_LICENSE_PATH: self._json_bytes(license_facts),
        }
        manifest = {
            "format": display_format,
            "render_mode": display_format.removesuffix("-zip"),
            "validation_level": "structure-only",
            "source_filename": source_filename,
            "model_path": _AIRI_DISPLAY_MODEL_ASSET_PATH,
            "license_path": _AIRI_DISPLAY_MODEL_LICENSE_PATH,
            "asset_paths": sorted(asset_files),
            "entrypoint": entrypoint,
            "sha256": digest,
            "license": "unverified local-only AIRI import",
            "redistribution_allowed": "no",
            "modification_allowed": "unknown",
            "attribution_required": "unknown",
            "usage_restrictions": {
                "local_only": True,
                "rights_verified": False,
            },
        }
        self._validate_manifest_keys(manifest)
        return asset_files, manifest
