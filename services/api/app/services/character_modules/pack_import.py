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


class CharacterPackImportMixin:
    def _import_character_pack_upload(self, *, filename: str, data: bytes) -> CharacterPack:
        self._ensure_size_limit(len(data))
        if not data.startswith(b"PK"):
            raise ValueError("Invalid character pack zip signature")
        self._validate_character_zip_index(data)
        airi_card: tuple[bytes, dict[str, Any], dict[str, bytes]] | None = None
        archive_files: dict[str, bytes] | None = None
        try:
            with ZipFile(BytesIO(data)) as archive:
                members = self._index_character_archive(archive)
                airi_card = self._read_airi_character_card_archive(
                    archive=archive,
                    members=members,
                )
                if airi_card is None:
                    archive_files = self._read_character_pack_archive(
                        archive=archive,
                        members=members,
                    )
        except (BadZipFile, NotImplementedError, OSError, RuntimeError) as exc:
            raise ValueError("Invalid character pack zip signature") from exc

        if airi_card is not None:
            card_data, manifest, asset_files = airi_card
            return self._import_character_card_upload(
                data=card_data,
                source_manifest=manifest,
                asset_files=asset_files,
            )
        assert archive_files is not None

        character_payload = self._read_json_object(archive_files["character.json"], "character.json")
        recipe = CharacterRecipe.model_validate(self._read_json_object(archive_files["recipe.json"], "recipe.json"))
        self.ensure_relationship_allowed(recipe)
        manifest = self._read_json_object(archive_files["asset_manifest.json"], "asset_manifest.json")
        self._validate_manifest_keys(manifest)
        if "managed_motions" in manifest:
            raise ValueError("Character pack asset_manifest.json contains reserved key managed_motions")
        self._strip_untrusted_airi_provenance(manifest)
        recipe_only = manifest.get("pack_kind") == "recipe-only"
        if recipe_only:
            self._ensure_recipe_only_manifest(manifest)
        else:
            self._ensure_import_license_requirements(manifest)

        asset_files: dict[str, bytes] = {}
        portable_asset_names: set[str] = set()
        for archive_name, content in archive_files.items():
            if archive_name in _PACK_METADATA_FILES:
                continue
            asset_name = archive_name[len("assets/") :] if archive_name.startswith("assets/") else archive_name
            if asset_name.casefold().startswith("managed-motions/"):
                raise ValueError("Character pack contains the reserved managed-motions asset namespace")
            portable_asset_name = self._portable_path_key(asset_name)
            if portable_asset_name in portable_asset_names:
                raise ValueError("Character pack contains a portable asset filename collision")
            portable_asset_names.add(portable_asset_name)
            asset_files[asset_name] = content
        if recipe_only and asset_files:
            raise ValueError("Recipe-only character packs cannot contain asset files")
        if not recipe_only and not asset_files:
            raise ValueError("Character pack does not contain any assets")

        if not recipe_only:
            for asset_name, content in asset_files.items():
                if asset_name.lower().endswith(".vrma"):
                    self._validate_vrma_bytes(content)
            self._validate_vrma_motion_references(recipe, manifest, asset_files)

        listed_paths = self._listed_asset_paths(manifest)
        if not listed_paths:
            listed_paths = sorted(asset_files)
        license_path = manifest.get("license_path")
        for relative_path in listed_paths:
            if relative_path not in asset_files:
                if isinstance(license_path, str) and relative_path == license_path:
                    raise ValueError("Character pack license file is missing")
                raise ValueError(f"Character pack asset is missing: {relative_path}")
        manifest["asset_paths"] = listed_paths

        model_path = manifest.get("model_path")
        display_format = manifest.get("format")
        if display_format in (_AIRI_ARCHIVE_DISPLAY_MODEL_FORMATS | {"vrm"}) and (
            not isinstance(model_path, str) or not model_path
        ):
            raise ValueError("Character pack display model format requires a model_path")
        if isinstance(model_path, str) and model_path:
            if model_path not in asset_files:
                raise ValueError("Character pack model_path does not exist in the archive")
            if display_format in _AIRI_ARCHIVE_DISPLAY_MODEL_FORMATS:
                if model_path != _AIRI_DISPLAY_MODEL_ASSET_PATH:
                    raise ValueError("Character pack archive display model must use its canonical ZIP path")
                display_files, display_manifest = self._build_airi_archive_display_model_bundle(
                    display_format=display_format,
                    filename=Path(model_path).name,
                    data=asset_files[model_path],
                )
                for key in (
                    "format",
                    "render_mode",
                    "validation_level",
                    "source_filename",
                    "model_path",
                    "license_path",
                    "entrypoint",
                    "sha256",
                    "license",
                    "redistribution_allowed",
                    "modification_allowed",
                    "attribution_required",
                    "usage_restrictions",
                ):
                    if manifest.get(key) != display_manifest[key]:
                        raise ValueError(f"Character pack display model {key} failed validation")
                if sorted(listed_paths) != display_manifest["asset_paths"]:
                    raise ValueError("Character pack display model asset_paths failed validation")
                expected_license = display_files[_AIRI_DISPLAY_MODEL_LICENSE_PATH]
                if asset_files.get(_AIRI_DISPLAY_MODEL_LICENSE_PATH) != expected_license:
                    raise ValueError("Character pack display model license facts failed validation")
            elif display_format == "vrm":
                if not model_path.lower().endswith(".vrm"):
                    raise ValueError("Character pack VRM format must reference a VRM model_path")
                parsed_meta = self._parse_vrm_bytes(asset_files[model_path])
                manifest = self._merge_manifest_with_vrm_meta(manifest, parsed_meta)
            elif model_path.lower().endswith(".vrm"):
                parsed_meta = self._parse_vrm_bytes(asset_files[model_path])
                manifest = self._merge_manifest_with_vrm_meta(manifest, parsed_meta)

        self._validate_manifest_keys(manifest)
        name = self._clean_name(
            character_payload.get("name")
            or manifest.get("vrm_meta", {}).get("name")
            or manifest.get("vrm_meta", {}).get("title")
            or Path(filename).stem
            or "Imported Character"
        )
        description = str(character_payload.get("description") or f"Imported from {Path(filename).name}")
        now = datetime.now(timezone.utc)
        character = CharacterPack(
            id=str(uuid4()),
            name=name,
            description=description,
            recipe=recipe,
            asset_manifest=manifest,
            created_at=now,
            updated_at=now,
        )
        if asset_files:
            self._write_asset_files(character.id, asset_files)
        try:
            self.repository.upsert_character(character)
        except Exception:
            shutil.rmtree(self._asset_root(character.id), ignore_errors=True)
            raise
        return character
