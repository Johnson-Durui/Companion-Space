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


class CharacterCrudMixin:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository

    def list_characters(self) -> list[CharacterPack]:
        characters = self.repository.list_characters()
        if characters:
            return characters
        return [self._seed_default_character()]

    def create_character(self, *, name: str, description: str = "", recipe: CharacterRecipe | None = None) -> CharacterPack:
        resolved_recipe = recipe or CharacterRecipe()
        self.ensure_relationship_allowed(resolved_recipe)
        now = datetime.now(timezone.utc)
        character = CharacterPack(
            id=str(uuid4()),
            name=name,
            description=description,
            recipe=resolved_recipe,
            asset_manifest={
                "pack_kind": "recipe-only",
                "render_mode": "vrm-or-2d-fallback",
            },
            created_at=now,
            updated_at=now,
        )
        self.repository.upsert_character(character)
        return character

    def get_character(self, character_id: str) -> CharacterPack | None:
        return self.repository.get_character(character_id)

    def require_character(self, character_id: str) -> CharacterPack:
        character = self.get_character(character_id)
        if character is None:
            raise ValueError("Character not found")
        return character

    def update_character(
        self,
        character_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        recipe: CharacterRecipe | None = None,
        asset_manifest: dict[str, Any] | None = None,
    ) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            return self._update_character_unlocked(
                character_id,
                name=name,
                description=description,
                recipe=recipe,
                asset_manifest=asset_manifest,
            )

    def _update_character_unlocked(
        self,
        character_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        recipe: CharacterRecipe | None = None,
        asset_manifest: dict[str, Any] | None = None,
    ) -> CharacterPack:
        existing = self.require_character(character_id)
        if name is not None and not name.strip():
            raise ValueError("Character name cannot be empty")
        if asset_manifest is not None:
            self._validate_manifest_keys(asset_manifest)

        updated = existing.model_copy(
            update={
                "name": name.strip() if name is not None else existing.name,
                "description": description if description is not None else existing.description,
                "recipe": recipe if recipe is not None else existing.recipe,
                "asset_manifest": self._clone_json_like(asset_manifest) if asset_manifest is not None else existing.asset_manifest,
                "updated_at": datetime.now(timezone.utc),
            },
            deep=True,
        )
        self.ensure_relationship_allowed(updated.recipe)
        return self.repository.upsert_character(updated)

    def duplicate_character(self, character_id: str, *, name: str | None = None) -> CharacterPack:
        with _AVATAR_LIFECYCLE_LOCK:
            return self._duplicate_character_unlocked(character_id, name=name)

    def _duplicate_character_unlocked(
        self,
        character_id: str,
        *,
        name: str | None = None,
    ) -> CharacterPack:
        source = self.require_character(character_id)
        self.ensure_relationship_allowed(source.recipe)
        duplicate_name = name.strip() if name is not None else f"{source.name} Copy"
        if not duplicate_name:
            raise ValueError("Character name cannot be empty")
        now = datetime.now(timezone.utc)
        duplicate = source.model_copy(
            update={
                "id": str(uuid4()),
                "name": duplicate_name,
                "created_at": now,
                "updated_at": now,
            },
            deep=True,
        )
        self._copy_character_assets(source, duplicate.id)
        try:
            return self.repository.upsert_character(duplicate)
        except Exception:
            shutil.rmtree(self._asset_root(duplicate.id), ignore_errors=True)
            raise

    def delete_character(self, character_id: str) -> bool:
        with _AVATAR_LIFECYCLE_LOCK:
            return self._delete_character_unlocked(character_id)

    def _delete_character_unlocked(self, character_id: str) -> bool:
        self.require_character(character_id)
        asset_root = self._asset_root(character_id)
        staged_dir: Path | None = None
        if asset_root.exists():
            staged_dir = self._contained_child(
                self.repository.settings.characters_root,
                f".deleting-{character_id}-{uuid4()}",
            )
            asset_root.rename(staged_dir)

        try:
            deleted = self.repository.delete_character(character_id)
        except Exception:
            if staged_dir is not None and staged_dir.exists() and not asset_root.exists():
                staged_dir.rename(asset_root)
            raise

        if not deleted:
            if staged_dir is not None and staged_dir.exists() and not asset_root.exists():
                staged_dir.rename(asset_root)
            return False
        if staged_dir is not None:
            shutil.rmtree(staged_dir)
        return True

    def _seed_default_character(self) -> CharacterPack:
        now = datetime.now(timezone.utc)
        character = CharacterPack(
            id="default-cool-companion",
            name="澄羽",
            description="温柔的复盘导航员。擅长整理笔记、回顾对话和稳定学习焦虑，会先接住情绪，再把散落的想法整理成下一步。",
            recipe=CharacterRecipe.model_validate(DEFAULT_CHARACTER_RECIPE_DATA),
            asset_manifest={
                "pack_kind": "recipe-only",
                "render_mode": "vrm-or-2d-fallback",
            },
            created_at=now,
            updated_at=now,
        )
        self.repository.upsert_character(character)
        return character
