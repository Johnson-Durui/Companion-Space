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
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

from app.core.errors import ResourceNotFoundError
from app.models.domain import CharacterPack, CharacterRecipe, DEFAULT_CHARACTER_RECIPE_DATA
from app.services.character_modules.common import *
from app.services.repository import SQLiteRepository


class CharacterAssetLifecycleMixin:
    def import_character_upload(self, *, filename: str, data: bytes) -> CharacterPack:
        if Path(filename or "").suffix.lower() != ".vrm":
            raise ValueError("Character import only supports .vrm files")
        return self._import_vrm_upload(filename=filename, data=data)

    def replace_character_avatar(
        self,
        character_id: str,
        *,
        filename: str,
        data: bytes,
    ) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            existing = self.require_character(character_id)
            if Path(filename or "").suffix.lower() != ".vrm":
                raise ValueError("Character avatar only supports .vrm files")
            asset_files, manifest = self._build_vrm_asset_bundle(filename=filename, data=data)
            managed_files, managed_motions = self._managed_motion_assets(existing)
            if managed_motions:
                asset_files.update(managed_files)
                manifest["managed_motions"] = managed_motions
                manifest["asset_paths"] = sorted(asset_files)
            self._ensure_projected_asset_size(asset_files)
            updated = existing.model_copy(
                update={
                    "recipe": self._recipe_without_imported_vrma(existing.recipe),
                    "asset_manifest": manifest,
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            return self._replace_asset_layer(existing, updated, asset_files)

    def remove_character_avatar(self, character_id: str) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            existing = self.require_character(character_id)
            managed_files, managed_motions = self._managed_motion_assets(existing)
            if managed_motions:
                manifest: dict[str, Any] = {
                    "pack_kind": "managed-motion-only",
                    "render_mode": "vrm-or-2d-fallback",
                    "managed_motions": managed_motions,
                    "asset_paths": sorted(managed_files),
                }
            else:
                manifest = {
                    "pack_kind": "recipe-only",
                    "render_mode": "vrm-or-2d-fallback",
                }
            updated = existing.model_copy(
                update={
                    "recipe": self._recipe_without_imported_vrma(existing.recipe),
                    "asset_manifest": manifest,
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            return self._replace_asset_layer(existing, updated, managed_files)

    def put_managed_motion(
        self,
        character_id: str,
        state: str,
        *,
        filename: str,
        data: bytes,
    ) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            self._validate_managed_motion_state(state)
            source_filename = self._clean_managed_motion_filename(filename)
            self._validate_vrma_bytes(data)
            existing = self.require_character(character_id)
            asset_files = self._character_asset_files(existing)
            manifest = self._clone_json_like(existing.asset_manifest)
            managed = self._trusted_managed_motions(manifest)
            previous = managed.get(state)
            digest = hashlib.sha256(data).hexdigest()
            path = f"managed-motions/{state}-{digest}.vrma"
            portable_path = self._portable_path_key(path)
            previous_path = previous["path"] if previous is not None else None
            if any(
                existing_path != previous_path
                and self._portable_path_key(existing_path) == portable_path
                for existing_path in asset_files
            ):
                raise ValueError("Managed motion asset path collides with an existing asset")
            if previous_path is not None:
                asset_files.pop(previous_path, None)
            asset_files[path] = data
            managed[state] = {
                "path": path,
                "source_filename": source_filename,
                "sha256": digest,
                "provenance": "owner_upload",
                "redistribution_allowed": "no",
            }
            if manifest.get("pack_kind") == "recipe-only":
                manifest["pack_kind"] = "managed-motion-only"
            manifest["managed_motions"] = managed
            manifest["asset_paths"] = sorted(asset_files)
            self._validate_manifest_keys(manifest)
            self._ensure_projected_asset_size(asset_files)
            updated = existing.model_copy(
                update={
                    "asset_manifest": manifest,
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            return self._replace_asset_layer(existing, updated, asset_files)

    def delete_managed_motion(self, character_id: str, state: str) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            self._validate_managed_motion_state(state)
            existing = self.require_character(character_id)
            manifest = self._clone_json_like(existing.asset_manifest)
            managed = self._trusted_managed_motions(manifest)
            removed = managed.pop(state, None)
            if removed is None:
                return existing
            asset_files = self._character_asset_files(existing)
            asset_files.pop(removed["path"], None)
            if managed:
                manifest["managed_motions"] = managed
            else:
                manifest.pop("managed_motions", None)
            if asset_files:
                manifest["asset_paths"] = sorted(asset_files)
            else:
                manifest.pop("asset_paths", None)
                if manifest.get("pack_kind") == "managed-motion-only":
                    manifest["pack_kind"] = "recipe-only"
            updated = existing.model_copy(
                update={
                    "asset_manifest": manifest,
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            return self._replace_asset_layer(existing, updated, asset_files)

    def ensure_relationship_allowed(self, recipe: CharacterRecipe) -> None:
        normalized = " ".join(recipe.relationship_role.casefold().split())
        if _ADULT_RELATIONSHIP_PATTERN.search(normalized) or any(
            term in normalized for term in _ADULT_RELATIONSHIP_TERMS
        ):
            raise ValueError("Adult relationship roles are not supported")

    def resolve_character_asset(self, character_id: str, asset_path: str) -> tuple[Path, str]:
        with _AVATAR_LIFECYCLE_LOCK:
            return self._resolve_character_asset_unlocked(character_id, asset_path)

    def read_character_asset(self, character_id: str, asset_path: str) -> tuple[bytes, str]:
        # ponytail: a bounded immutable snapshot is the local single-worker tradeoff.
        with _AVATAR_LIFECYCLE_LOCK:
            target, media_type = self._resolve_character_asset_unlocked(character_id, asset_path)
            self._ensure_size_limit(target.stat().st_size)
            content = target.read_bytes()
            self._ensure_size_limit(len(content))
            manifest = self._clone_json_like(self.require_character(character_id).asset_manifest)
            managed = self._trusted_managed_motions(manifest)
            for state, item in managed.items():
                if item["path"] == self._normalize_requested_asset_path(asset_path):
                    self._validate_managed_motion_content(state, item, content)
                    break
            return content, media_type

    def _resolve_character_asset_unlocked(
        self,
        character_id: str,
        asset_path: str,
    ) -> tuple[Path, str]:
        character = self.require_character(character_id)
        manifest = self._clone_json_like(character.asset_manifest)
        self._validate_manifest_keys(manifest)
        normalized_path = self._normalize_requested_asset_path(asset_path)
        if normalized_path not in self._listed_asset_paths(manifest):
            raise ResourceNotFoundError("Character asset not found")
        target = self._contained_child(self._asset_root(character_id), normalized_path)
        readable = _existing_io_file(target)
        if readable is None or self._is_executable_name(normalized_path):
            raise ResourceNotFoundError("Character asset not found")
        return readable, self._guess_media_type(normalized_path)
