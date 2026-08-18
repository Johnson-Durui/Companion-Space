from __future__ import annotations

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
from threading import RLock
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from app.models.domain import CharacterPack, CharacterRecipe, DEFAULT_CHARACTER_RECIPE_DATA
from app.services.repository import SQLiteRepository


logger = logging.getLogger(__name__)


def _windows_io_path(path: Path) -> Path:
    """Prefix Windows paths so nested VRMA files can exceed MAX_PATH."""
    if os.name != "nt":
        return path
    text = os.fspath(path)
    if text.startswith("\\\\?\\") or text.startswith("\\\\.\\"):
        return path
    resolved = os.path.abspath(text)
    if resolved.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + resolved.removeprefix("\\\\"))
    return Path("\\\\?\\" + resolved)


def _existing_io_file(path: Path) -> Path | None:
    io_path = _windows_io_path(path)
    if io_path.is_file():
        return io_path
    if path.is_file():
        return path
    return None


# ponytail: one local owner and one uvicorn worker only; use a process-shared lock before adding workers.
_AVATAR_LIFECYCLE_LOCK = RLock()
_CREDENTIAL_KEY_PARTS = ("api_key", "apikey", "credential", "password", "secret", "token")
_ADULT_RELATIONSHIP_PATTERN = re.compile(
    r"\b(?:lover|romantic(?:\s+partner)?|girlfriend|boyfriend|spouse|husband|wife)\b",
    re.IGNORECASE,
)
_ADULT_RELATIONSHIP_TERMS = (
    "恋人",
    "情侣",
    "男友",
    "女友",
    "爱人",
    "伴侣",
    "亲密关系",
    "浪漫关系",
)
_REDISTRIBUTION_ALLOWED = {"1", "allowed", "true", "yes"}
_PACK_METADATA_FILES = {
    "asset_manifest.json",
    "character.json",
    "recipe.json",
}
_EXECUTABLE_SUFFIXES = {
    ".app",
    ".bat",
    ".bin",
    ".cmd",
    ".com",
    ".cpl",
    ".csh",
    ".dll",
    ".dylib",
    ".exe",
    ".jar",
    ".js",
    ".mjs",
    ".cjs",
    ".ksh",
    ".msi",
    ".ps1",
    ".py",
    ".rb",
    ".run",
    ".scr",
    ".sh",
    ".so",
}
_VRM0_NO_MODIFICATION_LICENSES = {
    "CC_BY_ND",
    "CC_BY_NC_ND",
    "Redistribution_Prohibited",
}
_VRMA_REQUIRED_HUMAN_BONES = frozenset(
    {
        "hips",
        "spine",
        "head",
        "leftUpperLeg",
        "leftLowerLeg",
        "leftFoot",
        "rightUpperLeg",
        "rightLowerLeg",
        "rightFoot",
        "leftUpperArm",
        "leftLowerArm",
        "leftHand",
        "rightUpperArm",
        "rightLowerArm",
        "rightHand",
    }
)
_VRMA_RENDERING_PAYLOAD_KEYS = frozenset(
    {"cameras", "images", "materials", "meshes", "samplers", "skins", "textures"}
)
_VRMA_MAX_KEYFRAMES = 100_000
_BUILT_IN_VRMA_URLS = frozenset(
    f"/assets/characters/motions/companion-{state}.vrma"
    for state in ("idle", "listening", "thinking", "speaking")
)
_MANAGED_MOTION_STATES = frozenset({"idle", "listening", "thinking", "speaking"})
_EXECUTABLE_SIGNATURES = (
    b"#!",
    b"MZ",
    b"\x7fELF",
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
)
_CREDENTIAL_VALUE_PATTERNS = (
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|credential)\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(?:authorization|bearer)\b\s*[:=]?\s+[a-z0-9._\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{12,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"),
)
CHARACTER_CARD_MAX_BYTES = 1_000_000
_AIRI_MANIFEST_PATH = "manifest.json"
_AIRI_CARD_PATH = "card.json"
_AIRI_DISPLAY_MODEL_FORMATS = {"vrm", "live2d-zip", "spine-zip"}
_AIRI_ARCHIVE_DISPLAY_MODEL_FORMATS = {"live2d-zip", "spine-zip"}
_AIRI_DISPLAY_MODEL_ASSET_PATH = "display-model/model.zip"
_AIRI_DISPLAY_MODEL_LICENSE_PATH = "licenses/airi-display-model.json"
_AIRI_TRUSTED_PROVENANCE_KEYS = frozenset(
    {
        "source_format",
        "source_container_version",
        "source_card_spec",
        "source_card_spec_version",
        "source_display_model_format",
        "source_display_model_name",
        "source_display_model_imported",
    }
)
_AIRI_PERSONA_IMPORT_FIELDS = frozenset(
    {
        "name",
        "nickname",
        "description",
        "personality",
        "scenario",
        "first_mes",
        "alternate_greetings",
        "system_prompt",
        "post_history_instructions",
    }
)
_WINDOWS_RESERVED_PATH_NAMES = frozenset(
    {"aux", "con", "nul", "prn"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)
_WINDOWS_INVALID_PATH_CHARACTERS = frozenset('<>:"|?*')
_MAX_CHARACTER_ARCHIVE_MEMBERS = 4096
_MAX_CHARACTER_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024
_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_CHARACTER_CARD_V3_VERSION = re.compile(r"3\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?")
_CHARACTER_CARD_TEXT_FIELDS = (
    ("description", "Description"),
    ("personality", "Personality"),
    ("scenario", "Scenario"),
    ("first_mes", "First message"),
    ("mes_example", "Message examples"),
)
_CHARACTER_CARD_IGNORED_PROMPT_FIELDS = (
    "system_prompt",
    "post_history_instructions",
)
_CHARACTER_CARD_MAX_FIELD_LENGTH = 20_000
_CHARACTER_CARD_MAX_TOTAL_TEXT_LENGTH = 100_000
_CHARACTER_CARD_MAX_ALTERNATE_GREETINGS = 32
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_UNICODE_SURROGATES = re.compile(r"[\ud800-\udfff]")
_CHARACTER_CARD_PLACEHOLDERS = re.compile(
    r"\{\{\s*(char|user)\s*\}\}|<(char|bot|user)>",
    re.IGNORECASE,
)


def _parse_vroid_hub_permissions(meta: dict[str, Any]) -> dict[str, str]:
    for raw_url in (meta.get("otherPermissionUrl"), meta.get("otherLicenseUrl")):
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        parsed = urlsplit(raw_url)
        if parsed.scheme != "https" or parsed.hostname != "hub.vroid.com":
            continue
        query = {
            key: values[-1].strip().lower()
            for key, values in parse_qs(parsed.query, keep_blank_values=False).items()
            if values
        }
        return {
            "redistribution_allowed": (
                "yes" if query.get("redistribution") == "allow" else "no"
            ),
            "modification_allowed": (
                "yes" if query.get("modification") == "allow" else "no"
            ),
            "attribution_required": (
                "no" if query.get("credit") == "unnecessary" else "yes"
            ),
        }
    return {}


class CharacterService:
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

    def import_character_upload(self, *, filename: str, data: bytes) -> CharacterPack:
        suffix = Path(filename or "").suffix.lower()
        if suffix == ".vrm":
            return self._import_vrm_upload(filename=filename, data=data)
        if suffix == ".zip":
            return self._import_character_pack_upload(filename=filename, data=data)
        if suffix == ".json":
            return self._import_character_card_upload(data=data)
        raise ValueError("Character import only supports .vrm, .zip, and .json files")

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
        if not self.relationship_requires_adult_mode(recipe.relationship_role):
            return
        preferences = self.repository.get_owner_preferences()
        if not preferences.adult_relationships_enabled:
            raise ValueError(
                "Adult relationship mode is disabled; the local owner must "
                "confirm they are 18 or older before using this relationship"
            )

    @staticmethod
    def relationship_requires_adult_mode(relationship_role: str) -> bool:
        normalized = " ".join(relationship_role.casefold().split())
        return bool(_ADULT_RELATIONSHIP_PATTERN.search(normalized)) or any(
            term in normalized for term in _ADULT_RELATIONSHIP_TERMS
        )

    def export_character_pack(self, character_id: str) -> bytes:
        with _AVATAR_LIFECYCLE_LOCK:
            return self._export_character_pack_unlocked(character_id)

    def _export_character_pack_unlocked(self, character_id: str) -> bytes:
        character = self.require_character(character_id)
        manifest = self._clone_json_like(character.asset_manifest)
        self._validate_manifest_keys(manifest)
        managed = self._trusted_managed_motions(manifest)
        if managed:
            state = next(state for state in ("idle", "listening", "thinking", "speaking") if state in managed)
            raise ValueError(
                f"Managed motion '{state}' cannot be exported because owner uploads are local-only"
            )

        asset_root = self._asset_root(character_id)
        files: dict[str, Path] = {}
        total_size = 0
        asset_paths = self._listed_asset_paths(manifest)
        for relative_path in asset_paths:
            source = self._contained_child(asset_root, relative_path)
            if not source.is_file():
                raise ValueError(f"Character asset is missing or is not a file: {relative_path}")
            if self._is_executable_name(relative_path):
                raise ValueError("Character pack cannot export executable assets")
            archive_name = f"assets/{Path(relative_path).as_posix()}"
            if archive_name in files:
                continue
            total_size += source.stat().st_size
            if total_size > self.repository.settings.max_character_pack_size_bytes:
                raise ValueError("Character pack exceeds the configured size limit")
            files[archive_name] = source
        if asset_paths:
            if self._permission_flag(manifest.get("redistribution_allowed")) != "yes":
                raise ValueError("Character assets cannot be exported without explicit redistribution permission")
            self._ensure_export_license_requirements(manifest)

        character_payload = {
            "id": character.id,
            "name": character.name,
            "description": character.description,
            "created_at": character.created_at.isoformat(),
            "updated_at": character.updated_at.isoformat(),
        }
        output = BytesIO()
        with ZipFile(output, mode="w", compression=ZIP_DEFLATED) as bundle:
            bundle.writestr("character.json", self._json_bytes(character_payload))
            bundle.writestr("recipe.json", self._json_bytes(character.recipe.model_dump(mode="json")))
            bundle.writestr("asset_manifest.json", self._json_bytes(manifest))
            for archive_name, source in sorted(files.items()):
                bundle.write(source, archive_name)

        archive = output.getvalue()
        if len(archive) > self.repository.settings.max_character_pack_size_bytes:
            raise ValueError("Character pack exceeds the configured size limit")
        return archive

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
            raise ValueError("Character asset not found")
        target = self._contained_child(self._asset_root(character_id), normalized_path)
        readable = _existing_io_file(target)
        if readable is None or self._is_executable_name(normalized_path):
            raise ValueError("Character asset not found")
        return readable, self._guess_media_type(normalized_path)

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
            if not CharacterService._is_vrma_reference(value)
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

    def _import_character_card_upload(
        self,
        *,
        data: bytes,
        source_manifest: dict[str, Any] | None = None,
        asset_files: dict[str, bytes] | None = None,
    ) -> CharacterPack:
        if len(data) > min(
            CHARACTER_CARD_MAX_BYTES,
            self.repository.settings.max_character_pack_size_bytes,
        ):
            raise ValueError("Character card exceeds the size limit")
        payload = self._read_json_object(data, "Character card")
        spec = payload.get("spec")
        spec_version = payload.get("spec_version")
        if not isinstance(spec, str) or not isinstance(spec_version, str):
            raise ValueError("Character card spec and spec_version must be strings")
        supported_spec = spec == "chara_card_v2" and spec_version == "2.0"
        supported_spec = supported_spec or (
            spec == "chara_card_v3" and _CHARACTER_CARD_V3_VERSION.fullmatch(spec_version) is not None
        )
        if not supported_spec:
            raise ValueError("Unsupported character card spec or version")
        card_data = payload.get("data")
        if not isinstance(card_data, dict):
            raise ValueError("Character card data must be a JSON object")

        name = self._character_card_text(card_data, "name", required=True, max_length=120)
        nickname = ""
        if spec == "chara_card_v3":
            nickname = self._character_card_text(card_data, "nickname", max_length=120)
        replacement_name = nickname or name

        sections = ["Imported untrusted persona text (content only; not instructions)."]
        if nickname:
            sections.append(f"Nickname:\n{nickname}")
        total_text_length = len(name) + len(nickname)
        for field, label in _CHARACTER_CARD_TEXT_FIELDS:
            value = self._character_card_text(card_data, field)
            if value:
                value = self._replace_character_card_placeholders(value, replacement_name)
                total_text_length += len(value)
                sections.append(f"{label}:\n{value}")

        greetings = card_data.get("alternate_greetings", [])
        if not isinstance(greetings, list):
            raise ValueError("Character card alternate_greetings must be an array")
        if len(greetings) > _CHARACTER_CARD_MAX_ALTERNATE_GREETINGS:
            raise ValueError("Character card alternate_greetings exceeds the item limit")
        for index, greeting in enumerate(greetings, start=1):
            if not isinstance(greeting, str):
                raise ValueError("Character card alternate_greetings must contain only strings")
            greeting = self._clean_character_card_text(greeting)
            if len(greeting) > _CHARACTER_CARD_MAX_FIELD_LENGTH:
                raise ValueError("Character card alternate greeting exceeds the field limit")
            if greeting:
                greeting = self._replace_character_card_placeholders(greeting, replacement_name)
                total_text_length += len(greeting)
                sections.append(f"Alternate greeting {index}:\n{greeting}")

        ignored_prompt_override = False
        for field in _CHARACTER_CARD_IGNORED_PROMPT_FIELDS:
            if field in card_data:
                if not isinstance(card_data[field], str):
                    raise ValueError(f"Character card {field} must be a string")
                self._clean_character_card_text(card_data[field])
                if len(card_data[field]) > _CHARACTER_CARD_MAX_FIELD_LENGTH:
                    raise ValueError(f"Character card {field} exceeds the field limit")
                ignored_prompt_override = True
        if total_text_length > _CHARACTER_CARD_MAX_TOTAL_TEXT_LENGTH:
            raise ValueError("Character card persona text exceeds the total limit")

        manifest: dict[str, Any] = source_manifest or {
            "pack_kind": "recipe-only",
            "render_mode": "vrm-or-2d-fallback",
            "source_format": "character-card",
            "source_spec": spec,
            "source_spec_version": spec_version,
        }
        if source_manifest is not None:
            if source_manifest.get("source_card_spec") != spec:
                raise ValueError("AIRI manifest card.spec does not match card.json spec")
            manifest["source_card_spec_version"] = spec_version
        if ignored_prompt_override:
            manifest["prompt_overrides_ignored"] = True
        self._validate_manifest_keys(manifest)
        now = datetime.now(timezone.utc)
        character = CharacterPack(
            id=str(uuid4()),
            name=name,
            description="\n\n".join(sections),
            recipe=CharacterRecipe(),
            asset_manifest=manifest,
            created_at=now,
            updated_at=now,
        )
        if asset_files:
            self._write_asset_files(character.id, asset_files)
        try:
            self.repository.upsert_character(character)
        except Exception:
            if asset_files:
                try:
                    shutil.rmtree(self._asset_root(character.id))
                except OSError as cleanup_error:
                    raise RuntimeError(
                        "Character card import failed and asset rollback was incomplete"
                    ) from cleanup_error
            raise
        return character

    @classmethod
    def _character_card_text(
        cls,
        card_data: dict[str, Any],
        field: str,
        *,
        required: bool = False,
        max_length: int = _CHARACTER_CARD_MAX_FIELD_LENGTH,
    ) -> str:
        if field not in card_data and not required:
            return ""
        value = card_data.get(field)
        if not isinstance(value, str):
            raise ValueError(f"Character card {field} must be a string")
        cleaned = cls._clean_character_card_text(value).strip()
        if required and not cleaned:
            raise ValueError("Character card name cannot be empty")
        if len(cleaned) > max_length:
            raise ValueError(f"Character card {field} exceeds the field limit")
        return cleaned

    @staticmethod
    def _clean_character_card_text(value: str) -> str:
        if _UNICODE_SURROGATES.search(value):
            raise ValueError("Character card text contains invalid Unicode")
        return _CONTROL_CHARACTERS.sub("", value.replace("\r\n", "\n").replace("\r", "\n"))

    @staticmethod
    def _replace_character_card_placeholders(value: str, character_name: str) -> str:
        def replacement(match: re.Match[str]) -> str:
            placeholder = (match.group(1) or match.group(2)).casefold()
            return "the user" if placeholder == "user" else character_name

        return _CHARACTER_CARD_PLACEHOLDERS.sub(replacement, value)

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

    @classmethod
    def _validate_live2d_archive(cls, files: dict[str, bytes]) -> str:
        files = {
            path: content
            for path, content in files.items()
            if not any(part.casefold() == "__macosx" for part in PurePosixPath(path).parts)
            and not PurePosixPath(path).name.startswith("._")
        }
        model_paths = sorted(
            path for path in files if path.casefold().endswith((".model3.json", ".model.json"))
        )
        if not model_paths:
            moc_paths = sorted(path for path in files if path.casefold().endswith(".moc3"))
            if len(moc_paths) != 1:
                raise ValueError("Live2D archive must contain one model JSON or one MOC3 entrypoint")
            if not files[moc_paths[0]].startswith(b"MOC3"):
                raise ValueError("Live2D MOC3 signature is invalid")
            if not any(
                path.casefold().endswith((".png", ".jpg", ".jpeg", ".webp"))
                for path in files
            ):
                raise ValueError("Live2D MOC3 archive must contain a local texture")
            return moc_paths[0]
        if len(model_paths) != 1:
            raise ValueError("Live2D archive must contain exactly one model JSON entrypoint")

        entrypoint = model_paths[0]
        if len(files[entrypoint]) > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("Live2D model metadata exceeds the size limit")
        model = cls._read_json_object(files[entrypoint], "Live2D model JSON")
        raw_references = model.get("FileReferences", model)
        if not isinstance(raw_references, dict):
            raise ValueError("Live2D model FileReferences must be a JSON object")
        reference_map = {str(key).casefold(): value for key, value in raw_references.items()}
        moc = reference_map.get("moc", reference_map.get("model"))
        textures = reference_map.get("textures")
        if not isinstance(moc, str) or not moc.strip():
            raise ValueError("Live2D model must reference a core MOC asset")
        if (
            not isinstance(textures, list)
            or not textures
            or not all(isinstance(item, str) and item.strip() for item in textures)
        ):
            raise ValueError("Live2D model must reference one or more local textures")
        references = [moc, *textures]
        for key in ("physics", "pose", "displayinfo", "userdata"):
            value = reference_map.get(key)
            if value is None:
                continue
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Live2D model {key} reference must be a string or null")
            references.append(value)

        expressions = reference_map.get("expressions")
        if expressions is not None:
            if not isinstance(expressions, list):
                raise ValueError("Live2D model expressions must be a list")
            for expression in expressions:
                if isinstance(expression, str) and expression.strip():
                    references.append(expression)
                    continue
                if isinstance(expression, dict):
                    expression_map = {str(key).casefold(): value for key, value in expression.items()}
                    expression_file = expression_map.get("file")
                    if isinstance(expression_file, str) and expression_file.strip():
                        references.append(expression_file)
                        continue
                raise ValueError("Live2D model expression must be a path or contain File")

        motions = reference_map.get("motions")
        if motions is not None:
            stack = [motions]
            while stack:
                value = stack.pop()
                if isinstance(value, dict):
                    for key, child in value.items():
                        if str(key).casefold() in {"file", "sound"}:
                            if not isinstance(child, str) or not child.strip():
                                raise ValueError("Live2D motion reference must be a string")
                            references.append(child)
                        else:
                            stack.append(child)
                elif isinstance(value, list):
                    stack.extend(value)

        resolved_references = cls._require_local_archive_references(
            entrypoint,
            references,
            files,
            "Live2D model",
        )
        if not files[resolved_references[0]].startswith(b"MOC3"):
            raise ValueError("Live2D MOC3 signature is invalid")
        return entrypoint

    @classmethod
    def _validate_spine_archive(cls, files: dict[str, bytes]) -> str:
        files = {
            path: content
            for path, content in files.items()
            if not any(part.casefold() == "__macosx" for part in PurePosixPath(path).parts)
            and not PurePosixPath(path).name.startswith("._")
        }
        skeletons = sorted(
            path
            for path in files
            if path.casefold().endswith(".skel")
            or (path.casefold().endswith(".json") and not path.casefold().endswith(".model.json"))
        )
        atlases = sorted(
            path
            for path in files
            if path.casefold().endswith((".atlas", ".atlas.txt"))
        )
        if not skeletons or not atlases:
            raise ValueError("Spine archive must contain a skeleton and atlas pair")
        same_directory_pairs = [
            (skeleton, atlas)
            for skeleton in skeletons
            for atlas in atlases
            if PurePosixPath(skeleton).parent == PurePosixPath(atlas).parent
        ]
        exact_pairs = [
            (skeleton, atlas)
            for skeleton, atlas in same_directory_pairs
            if PurePosixPath(skeleton).with_suffix("")
            == PurePosixPath(atlas.removesuffix(".txt")).with_suffix("")
        ]
        runnable_pairs = exact_pairs or same_directory_pairs
        if len(runnable_pairs) != 1:
            raise ValueError("Spine archive must contain one unambiguous same-directory pair")
        skeleton, atlas = runnable_pairs[0]
        if skeleton.casefold().endswith(".json"):
            if len(files[skeleton]) > CHARACTER_CARD_MAX_BYTES:
                raise ValueError("Spine skeleton metadata exceeds the size limit")
            cls._read_json_object(files[skeleton], "Spine skeleton JSON")
        elif not files[skeleton]:
            raise ValueError("Spine skeleton is empty")
        if len(files[atlas]) > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("Spine atlas metadata exceeds the size limit")
        try:
            lines = files[atlas].decode("utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise ValueError("Spine atlas must be valid UTF-8 text") from exc
        textures = [
            line.strip()
            for line in lines
            if line.strip().casefold().endswith((".png", ".jpg", ".jpeg", ".webp"))
            and ":" not in line
        ]
        if not textures:
            raise ValueError("Spine atlas does not reference a local texture")
        cls._require_local_archive_references(atlas, textures, files, "Spine atlas")
        return skeleton

    @classmethod
    def _require_local_archive_references(
        cls,
        entrypoint: str,
        references: list[str],
        files: dict[str, bytes],
        label: str,
    ) -> list[str]:
        parent_parts = list(PurePosixPath(entrypoint).parent.parts)
        resolved_references: list[str] = []
        for reference in references:
            raw_reference = reference.strip()
            if re.search(r"%(?![0-9a-fA-F]{2})", raw_reference):
                raise ValueError(f"{label} contains an unsafe local reference")
            try:
                decoded_reference = unquote(raw_reference, encoding="utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise ValueError(f"{label} contains an unsafe local reference") from exc
            parsed = urlsplit(decoded_reference)
            if (
                parsed.scheme
                or parsed.netloc
                or parsed.query
                or parsed.fragment
                or decoded_reference.startswith(("//", "/"))
                or "\\" in decoded_reference
            ):
                raise ValueError(f"{label} cannot reference remote resources")
            try:
                stack = list(parent_parts)
                for part in parsed.path.split("/"):
                    if part in {"", "."}:
                        continue
                    if part == "..":
                        if not stack:
                            raise ValueError
                        stack.pop()
                        continue
                    normalized_part = cls._normalize_relative_posix_path(
                        part,
                        traversal_message=f"{label} contains an unsafe local reference",
                    )
                    stack.append(normalized_part)
                if not stack:
                    raise ValueError
                resolved = "/".join(stack)
            except ValueError as exc:
                raise ValueError(f"{label} contains an unsafe local reference") from exc
            if resolved not in files:
                raise ValueError(f"{label} references a missing local asset: {reference}")
            resolved_references.append(resolved)
        return resolved_references

    def _index_character_archive(self, archive: ZipFile) -> dict[str, Any]:
        members: dict[str, Any] = {}
        archive_names: set[str] = set()
        portable_names: set[str] = set()
        total_uncompressed_size = 0
        infos = archive.infolist()
        if len(infos) > _MAX_CHARACTER_ARCHIVE_MEMBERS:
            raise ValueError("Character pack contains too many files")
        for info in infos:
            normalized_name = self._normalize_archive_member_name(info.filename)
            self._validate_archive_member(info, normalized_name)
            if normalized_name in archive_names:
                raise ValueError("Character pack contains duplicate files")
            archive_names.add(normalized_name)
            portable_name = self._portable_path_key(normalized_name)
            if portable_name in portable_names:
                raise ValueError("Character pack contains a portable filename collision")
            portable_names.add(portable_name)
            if info.flag_bits & 0x1:
                raise ValueError("Character pack cannot contain encrypted files")
            total_uncompressed_size += info.file_size
            if total_uncompressed_size > self.repository.settings.max_character_pack_size_bytes:
                raise ValueError("Character pack exceeds the configured size limit")
            if info.is_dir():
                continue
            members[normalized_name] = info
        return members

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

    def _ensure_export_license_requirements(self, manifest: dict[str, Any]) -> None:
        if not isinstance(manifest.get("license"), str) or not manifest["license"].strip():
            raise ValueError("Character asset manifest must include a license")
        if not isinstance(manifest.get("license_path"), str) or not manifest["license_path"].strip():
            raise ValueError("Character asset manifest must include a license_path")

    def _ensure_import_license_requirements(self, manifest: dict[str, Any]) -> None:
        self._ensure_export_license_requirements(manifest)
        listed_paths = self._listed_asset_paths(manifest)
        if manifest["license_path"] not in listed_paths:
            raise ValueError("Character asset manifest license_path must be listed in asset_paths")

    @classmethod
    def _ensure_recipe_only_manifest(cls, manifest: dict[str, Any]) -> None:
        if cls._listed_asset_paths(manifest):
            raise ValueError("Recipe-only character packs cannot declare asset paths")

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

    def _validate_vrma_bytes(self, data: bytes) -> None:
        document, binary = self._parse_glb_json(
            data,
            error_message="Invalid VRMA signature",
            allow_unknown_chunks=False,
        )
        asset = document.get("asset")
        if not isinstance(asset, dict) or asset.get("version") != "2.0":
            raise ValueError("Invalid VRMA signature")
        extensions_used = document.get("extensionsUsed")
        if not isinstance(extensions_used, list) or "VRMC_vrm_animation" not in extensions_used:
            raise ValueError("VRMA must declare VRMC_vrm_animation in extensionsUsed")
        extensions = document.get("extensions")
        if not isinstance(extensions, dict) or not isinstance(extensions.get("VRMC_vrm_animation"), dict):
            raise ValueError("VRMA is missing the VRMC_vrm_animation extension")
        extension = extensions["VRMC_vrm_animation"]
        if extension.get("specVersion") != "1.0":
            raise ValueError("VRMA specVersion must be 1.0")
        if {"expressions", "lookAt"}.intersection(extension):
            raise ValueError("Companion Space VRMA assets must be body-only")
        if _VRMA_RENDERING_PAYLOAD_KEYS.intersection(document):
            raise ValueError("VRMA cannot contain rendering payload")
        nodes = document.get("nodes")
        humanoid = extension.get("humanoid")
        human_bones = humanoid.get("humanBones") if isinstance(humanoid, dict) else None
        if not isinstance(nodes, list) or not isinstance(human_bones, dict):
            raise ValueError("VRMA humanoid mapping is missing")
        missing_bones = _VRMA_REQUIRED_HUMAN_BONES.difference(human_bones)
        if missing_bones:
            raise ValueError("VRMA humanoid mapping is missing required bones")
        humanoid_node_indexes: set[int] = set()
        human_bone_node_indexes: list[int] = []
        for bone in human_bones.values():
            node_index = bone.get("node") if isinstance(bone, dict) else None
            if type(node_index) is not int or not 0 <= node_index < len(nodes):
                raise ValueError("VRMA humanoid mapping contains an invalid node")
            humanoid_node_indexes.add(node_index)
            human_bone_node_indexes.append(node_index)
        if len(human_bone_node_indexes) != len(humanoid_node_indexes):
            raise ValueError("VRMA human bones must use unique nodes")
        if any(
            isinstance(node, dict) and {"camera", "mesh", "skin", "weights"}.intersection(node)
            for node in nodes
        ):
            raise ValueError("VRMA cannot contain rendering payload")

        buffers = document.get("buffers")
        buffer_views = document.get("bufferViews")
        accessors = document.get("accessors")
        if (
            not isinstance(buffers, list)
            or len(buffers) != 1
            or not isinstance(buffer_views, list)
            or not isinstance(accessors, list)
        ):
            raise ValueError("VRMA must contain one embedded animation buffer")
        buffer = buffers[0]
        buffer_length = buffer.get("byteLength") if isinstance(buffer, dict) else None
        if (
            type(buffer_length) is not int
            or buffer_length <= 0
            or "uri" in buffer
        ):
            raise ValueError("VRMA must contain one embedded animation buffer")
        if binary is None:
            raise ValueError("VRMA must contain exactly one BIN chunk")
        if not buffer_length <= len(binary) <= buffer_length + 3:
            raise ValueError("VRMA BIN padding must be between zero and three bytes")
        for view in buffer_views:
            if not isinstance(view, dict) or view.get("buffer") != 0:
                raise ValueError("VRMA contains an invalid buffer view")
            offset = view.get("byteOffset", 0)
            length = view.get("byteLength")
            if (
                type(offset) is not int
                or type(length) is not int
                or offset < 0
                or length <= 0
                or offset + length > buffer_length
            ):
                raise ValueError("VRMA contains an invalid buffer view")

        animations = document.get("animations")
        if not isinstance(animations, list) or not animations:
            raise ValueError("VRMA must contain a playable rotation animation")
        playable_tracks = 0
        channel_targets: set[tuple[int, str]] = set()
        accessor_cache: dict[tuple[int, str], list[tuple[float, ...]]] = {}
        for animation in animations:
            channels = animation.get("channels") if isinstance(animation, dict) else None
            samplers = animation.get("samplers") if isinstance(animation, dict) else None
            if not isinstance(channels, list) or not channels or not isinstance(samplers, list):
                raise ValueError("VRMA must contain a playable rotation animation")
            for channel in channels:
                target = channel.get("target") if isinstance(channel, dict) else None
                sampler_index = channel.get("sampler") if isinstance(channel, dict) else None
                if (
                    not isinstance(target, dict)
                    or target.get("path") != "rotation"
                    or type(sampler_index) is not int
                    or not 0 <= sampler_index < len(samplers)
                ):
                    raise ValueError("Companion Space VRMA assets only support in-place rotation channels")
                node_index = target.get("node")
                if type(node_index) is not int or node_index not in humanoid_node_indexes:
                    raise ValueError("VRMA rotation channels must target declared humanoid bones")
                target_key = (node_index, "rotation")
                if target_key in channel_targets:
                    raise ValueError("VRMA contains a duplicate channel target")
                channel_targets.add(target_key)
                sampler = samplers[sampler_index]
                input_index = sampler.get("input") if isinstance(sampler, dict) else None
                output_index = sampler.get("output") if isinstance(sampler, dict) else None
                interpolation = sampler.get("interpolation", "LINEAR") if isinstance(sampler, dict) else None
                if (
                    type(input_index) is not int
                    or type(output_index) is not int
                    or not 0 <= input_index < len(accessors)
                    or not 0 <= output_index < len(accessors)
                    or interpolation not in {"LINEAR", "STEP", "CUBICSPLINE"}
                ):
                    raise ValueError("VRMA contains an invalid animation sampler")
                input_accessor = accessors[input_index]
                output_accessor = accessors[output_index]
                input_count = input_accessor.get("count") if isinstance(input_accessor, dict) else None
                output_count = output_accessor.get("count") if isinstance(output_accessor, dict) else None
                count_factor = 3 if interpolation == "CUBICSPLINE" else 1
                if type(input_count) is not int or type(output_count) is not int:
                    raise ValueError("VRMA contains an invalid animation accessor")
                if input_count <= 0 or output_count <= 0:
                    raise ValueError("VRMA accessor bounds are invalid")
                if input_count > _VRMA_MAX_KEYFRAMES:
                    raise ValueError("VRMA animation exceeds the keyframe limit")
                if output_count != input_count * count_factor:
                    if interpolation == "CUBICSPLINE":
                        raise ValueError("VRMA CUBICSPLINE output count must be three times input count")
                    raise ValueError("VRMA animation input and output counts must match")
                input_key = (input_index, "SCALAR")
                if input_key not in accessor_cache:
                    accessor_cache[input_key] = self._read_vrma_accessor(
                        input_accessor,
                        buffer_views,
                        binary,
                        accessor_type="SCALAR",
                        max_count=_VRMA_MAX_KEYFRAMES,
                    )
                input_values = accessor_cache[input_key]
                output_key = (output_index, "VEC4")
                if output_key not in accessor_cache:
                    accessor_cache[output_key] = self._read_vrma_accessor(
                        output_accessor,
                        buffer_views,
                        binary,
                        accessor_type="VEC4",
                        max_count=_VRMA_MAX_KEYFRAMES * count_factor,
                    )
                output_values = accessor_cache[output_key]
                times = [value[0] for value in input_values]
                if not all(math.isfinite(value) for value in times):
                    raise ValueError("VRMA animation input times must be finite")
                if any(current <= previous for previous, current in zip(times, times[1:])):
                    raise ValueError("VRMA animation input times must be strictly increasing")
                if not all(math.isfinite(component) for value in output_values for component in value):
                    raise ValueError("VRMA animation output must contain finite quaternions")
                key_quaternions = output_values[1::3] if interpolation == "CUBICSPLINE" else output_values
                norms = [math.sqrt(sum(component * component for component in value)) for value in key_quaternions]
                if any(norm <= 1e-8 for norm in norms):
                    raise ValueError("VRMA animation output must contain non-zero quaternions")
                if any(not 0.98 <= norm <= 1.02 for norm in norms):
                    raise ValueError("VRMA animation output must contain unit quaternions")
                playable_tracks += 1
        if playable_tracks == 0:
            raise ValueError("VRMA must contain a playable rotation animation")

    @staticmethod
    def _read_vrma_accessor(
        accessor: object,
        buffer_views: list[object],
        binary: bytes,
        *,
        accessor_type: str,
        max_count: int,
    ) -> list[tuple[float, ...]]:
        if (
            not isinstance(accessor, dict)
            or accessor.get("componentType") != 5126
            or accessor.get("type") != accessor_type
            or "sparse" in accessor
        ):
            raise ValueError("VRMA contains an invalid animation accessor")
        view_index = accessor.get("bufferView")
        if type(view_index) is not int or not 0 <= view_index < len(buffer_views):
            raise ValueError("VRMA contains an invalid animation accessor")
        view = buffer_views[view_index]
        if not isinstance(view, dict):
            raise ValueError("VRMA contains an invalid animation accessor")
        offset = accessor.get("byteOffset", 0)
        count = accessor.get("count")
        if (
            type(offset) is not int
            or offset < 0
            or offset % 4 != 0
            or type(count) is not int
            or count <= 0
        ):
            raise ValueError("VRMA accessor bounds are invalid")
        if count > max_count:
            raise ValueError("VRMA animation exceeds the keyframe limit")
        component_count = 1 if accessor_type == "SCALAR" else 4
        element_size = component_count * 4
        stride = view.get("byteStride", element_size)
        if type(stride) is not int or stride < element_size or stride > 252 or stride % 4 != 0:
            raise ValueError("VRMA accessor stride is invalid")
        view_length = view["byteLength"]
        span = offset + (count - 1) * stride + element_size
        start = view.get("byteOffset", 0) + offset
        if start % 4 != 0 or span > view_length:
            raise ValueError("VRMA accessor span exceeds its buffer view")
        format_string = "<f" if component_count == 1 else "<4f"
        try:
            return [struct.unpack_from(format_string, binary, start + index * stride) for index in range(count)]
        except struct.error as exc:
            raise ValueError("VRMA accessor span exceeds its buffer view") from exc

    @classmethod
    def _validate_vrma_motion_references(
        cls,
        recipe: CharacterRecipe,
        manifest: dict[str, Any],
        asset_files: dict[str, bytes],
    ) -> None:
        declared_paths = manifest.get("asset_paths")
        declared = (
            {path for path in declared_paths if isinstance(path, str)}
            if isinstance(declared_paths, list)
            else set()
        )
        for motion_path in recipe.motions.values():
            if motion_path in _BUILT_IN_VRMA_URLS:
                continue
            if not motion_path.lower().endswith(".vrma"):
                continue
            try:
                normalized = cls._normalize_relative_posix_path(
                    motion_path,
                    traversal_message="Character recipe VRMA motion path is unsafe",
                )
            except ValueError as exc:
                raise ValueError("Character recipe VRMA motion path is unsafe") from exc
            if ":" in PurePosixPath(normalized).parts[0]:
                raise ValueError("Character recipe VRMA motion path is unsafe")
            if normalized not in declared:
                raise ValueError("Character recipe VRMA motion path must be listed in asset_paths")
            if normalized not in asset_files:
                raise ValueError("Character recipe VRMA motion asset is missing")

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
