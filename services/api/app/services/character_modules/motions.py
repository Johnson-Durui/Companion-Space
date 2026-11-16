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


class CharacterMotionMixin:
    def _import_vrm_upload(self, *, filename: str, data: bytes) -> CharacterPack:
        asset_files, manifest = self._build_vrm_asset_bundle(filename=filename, data=data)
        meta = manifest["vrm_meta"]
        name = self._clean_name(meta.get("name") or meta.get("title") or Path(filename).stem or "Imported Character")
        now = datetime.now(timezone.utc)
        character = CharacterPack(
            id=str(uuid4()),
            name=name,
            description=f"Imported from {Path(filename).name}",
            recipe=CharacterRecipe(),
            asset_manifest=manifest,
            created_at=now,
            updated_at=now,
        )
        self._write_asset_files(character.id, asset_files)
        try:
            self.repository.upsert_character(character)
        except Exception:
            shutil.rmtree(self._asset_root(character.id), ignore_errors=True)
            raise
        return character

    def _build_vrm_asset_bundle(
        self,
        *,
        filename: str,
        data: bytes,
    ) -> tuple[dict[str, bytes], dict[str, Any]]:
        meta = self._parse_vrm_bytes(data)
        asset_files = {
            "model.vrm": data,
            "licenses/vrm-meta.json": self._json_bytes(meta),
        }
        manifest: dict[str, Any] = {
            "format": "vrm",
            "render_mode": "vrm-or-2d-fallback",
            "source_filename": Path(filename).name,
            "model_path": "model.vrm",
            "license_path": "licenses/vrm-meta.json",
            "asset_paths": sorted(asset_files),
            "license": meta.get("license_name") or meta.get("license_url") or "unknown",
            "author": meta.get("author") or ", ".join(meta.get("authors", [])),
            "source_url": meta.get("license_url") or meta.get("other_license_url") or "",
            "redistribution_allowed": meta["redistribution_allowed"],
            "modification_allowed": meta["modification_allowed"],
            "attribution_required": meta["attribution_required"],
            "usage_restrictions": meta["usage_restrictions"],
            "vrm_meta": meta,
        }
        self._validate_manifest_keys(manifest)
        return asset_files, manifest

    @staticmethod
    def _recipe_without_imported_vrma(recipe: CharacterRecipe) -> CharacterRecipe:
        motions = {
            name: value
            for name, value in recipe.motions.items()
            if not CharacterMotionMixin._is_vrma_reference(value)
            or value in _BUILT_IN_VRMA_URLS
        }
        return recipe.model_copy(update={"motions": motions}, deep=True)

    @staticmethod
    def _is_vrma_reference(value: str) -> bool:
        try:
            path = urlsplit(value).path
        except ValueError:
            path = value
        return path.casefold().endswith(".vrma")

    def _replace_asset_layer(
        self,
        existing: CharacterPack,
        updated: CharacterPack,
        asset_files: dict[str, bytes],
    ) -> CharacterPack:
        asset_root = self._asset_root(existing.id)
        staged_new: Path | None = None
        staged_old: Path | None = None
        old_staged = False
        new_installed = False
        if asset_files:
            staged_new = self._contained_child(
                self.repository.settings.characters_root,
                f".n-{uuid4().hex}",
            )
            self._write_asset_files(staged_new.name, asset_files)

        try:
            if asset_root.exists():
                staged_old = self._contained_child(
                    self.repository.settings.characters_root,
                    f".replaced-{existing.id}-{uuid4()}",
                )
                asset_root.rename(staged_old)
                old_staged = True
            if staged_new is not None:
                staged_new.rename(asset_root)
                new_installed = True
            saved = self.repository.upsert_character(updated)
        except Exception:
            if new_installed and staged_new is not None and asset_root.exists():
                try:
                    asset_root.rename(staged_new)
                except OSError as rollback_error:
                    raise RuntimeError(
                        "Character avatar update failed and the new asset layer could not be staged for rollback"
                    ) from rollback_error
            if old_staged and staged_old is not None and staged_old.exists():
                try:
                    staged_old.rename(asset_root)
                except OSError as rollback_error:
                    raise RuntimeError(
                        "Character avatar update failed and the previous asset layer could not be restored"
                    ) from rollback_error
            if staged_new is not None and staged_new.exists():
                try:
                    shutil.rmtree(staged_new)
                except OSError as rollback_error:
                    raise RuntimeError(
                        "Character avatar update failed and staged replacement cleanup was incomplete"
                    ) from rollback_error
            raise

        if staged_old is not None:
            try:
                shutil.rmtree(_windows_io_path(staged_old))
            except OSError as cleanup_error:
                logger.warning(
                    "Committed character avatar update left recoverable old assets at %s: %s",
                    staged_old,
                    cleanup_error,
                )
        return saved

    @staticmethod
    def _validate_managed_motion_state(state: str) -> None:
        if state not in _MANAGED_MOTION_STATES:
            raise ValueError("Managed motion state must be idle, listening, thinking, or speaking")

    def _character_asset_files(self, character: CharacterPack) -> dict[str, bytes]:
        manifest = self._clone_json_like(character.asset_manifest)
        asset_root = self._asset_root(character.id)
        files: dict[str, bytes] = {}
        for relative_path in self._listed_asset_paths(manifest):
            source = self._contained_child(asset_root, relative_path)
            readable = _existing_io_file(source)
            if readable is None:
                raise ValueError(f"Character asset is missing or is not a file: {relative_path}")
            files[relative_path] = readable.read_bytes()
        self._validate_managed_motion_files(manifest, files)
        return files

    def _managed_motion_assets(
        self,
        character: CharacterPack,
    ) -> tuple[dict[str, bytes], dict[str, dict[str, str]]]:
        manifest = self._clone_json_like(character.asset_manifest)
        managed = self._trusted_managed_motions(manifest)
        all_files = self._character_asset_files(character)
        return ({item["path"]: all_files[item["path"]] for item in managed.values()}, managed)

    @classmethod
    def _trusted_managed_motions(
        cls,
        manifest: dict[str, Any],
    ) -> dict[str, dict[str, str]]:
        value = manifest.get("managed_motions")
        if value is None:
            return {}
        if not isinstance(value, dict) or not set(value).issubset(_MANAGED_MOTION_STATES):
            raise ValueError("Character asset manifest managed_motions is invalid")
        asset_paths = manifest.get("asset_paths")
        listed_paths = (
            {path for path in asset_paths if isinstance(path, str)}
            if isinstance(asset_paths, list)
            else set()
        )
        trusted: dict[str, dict[str, str]] = {}
        expected = {"path", "source_filename", "sha256", "provenance", "redistribution_allowed"}
        for state, item in value.items():
            if (
                not isinstance(item, dict)
                or set(item) != expected
                or not all(isinstance(item[key], str) and item[key] for key in expected)
                or item["provenance"] != "owner_upload"
                or item["redistribution_allowed"] != "no"
                or cls._clean_managed_motion_filename(item["source_filename"])
                != item["source_filename"]
                or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
                or item["path"] != f"managed-motions/{state}-{item['sha256']}.vrma"
                or item["path"] not in listed_paths
            ):
                raise ValueError(f"Character asset manifest managed_motions.{state} is invalid")
            trusted[state] = dict(item)
        return trusted

    @classmethod
    def _clean_managed_motion_filename(cls, filename: str) -> str:
        cleaned = cls._clean_character_card_text(str(filename or "")).strip()
        if (
            not cleaned
            or len(cleaned) > 255
            or "/" in cleaned
            or "\\" in cleaned
            or Path(cleaned).name != cleaned
            or Path(cleaned).suffix.lower() != ".vrma"
        ):
            raise ValueError(
                "Managed motion filename must be a non-empty basename ending with .vrma and at most 255 characters"
            )
        cls._validate_manifest_string(cleaned)
        return cleaned

    @classmethod
    def _validate_managed_motion_files(
        cls,
        manifest: dict[str, Any],
        files: dict[str, bytes],
    ) -> None:
        for state, item in cls._trusted_managed_motions(manifest).items():
            content = files.get(item["path"])
            if content is None:
                raise ValueError(f"Managed motion '{state}' asset is missing")
            cls._validate_managed_motion_content(state, item, content)

    @staticmethod
    def _validate_managed_motion_content(
        state: str,
        item: dict[str, str],
        content: bytes,
    ) -> None:
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise ValueError(f"Managed motion '{state}' failed SHA256 integrity validation")

    def _ensure_projected_asset_size(self, asset_files: dict[str, bytes]) -> None:
        self._ensure_size_limit(sum(len(content) for content in asset_files.values()))
