from __future__ import annotations

import json
import mimetypes
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, StringConstraints

from app.services.character_modules.common import _existing_io_file, _windows_io_path
from app.services.character_modules.paths import CharacterPathMixin
from app.services.repository import SQLiteRepository
from app.services.settings_store import get_setting, put_setting
from app.services.tutorpack import (
    ARCHIVE_SUFFIXES,
    IMAGE_SUFFIXES,
    VIDEO_SUFFIXES,
    ClipSlot,
    ParsedTutorPack,
    VideoTier,
    discover_builtin_pack_clips,
    parse_single_image_upload,
    parse_tutorpack_archive,
    safe_http_url,
)

type StyleId = Literal["guided", "direct", "analogy", "exam", "rigorous"]
ShortLine = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
_FALLBACK_ORDER = (
    "tutor-chutang",
    "tutor-xuechuan",
    "tutor-qingheng",
    "tutor-shenyan",
    "tutor-lanyue",
    "tutor-lanyin",
)
_ALLOWED_ASSET_SUFFIXES = IMAGE_SUFFIXES | VIDEO_SUFFIXES


class PackMetadata(BaseModel):
    author: str = "Companion Space"
    terms: str = ""
    license_url: str | None = None
    allow_redistribution: bool = False
    source_kind: Literal["builtin", "imported_image", "imported_pack"] = "builtin"


class LoopPackConfig(BaseModel):
    crossfade_ms: int = Field(default=180, ge=0, le=600)
    clips: dict[ClipSlot, str] = Field(default_factory=dict)


class LocalSidecarAvatarConfig(BaseModel):
    driver_id: str | None = Field(default=None, max_length=120)
    fps: int = Field(default=25, ge=10, le=60)
    resolution: str = Field(default="512x896", max_length=32)


class CloudLiveAvatarConfig(BaseModel):
    connection_id: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=160)
    idle_suspend_sec: int = Field(default=30, ge=5, le=300)
    max_session_minutes: int = Field(default=10, ge=1, le=120)
    max_session_cost_cny: float = Field(default=20.0, ge=1.0, le=500.0)
    action_prompts: dict[str, str] = Field(default_factory=dict, max_length=16)


class VideoAvatarConfig(BaseModel):
    aspect_ratio: Literal["9:16", "3:4"] = "9:16"
    preferred_tier: VideoTier = "static"
    anchor_image: str
    loop_pack: LoopPackConfig = Field(default_factory=LoopPackConfig)
    local_sidecar: LocalSidecarAvatarConfig = Field(default_factory=LocalSidecarAvatarConfig)
    cloud_live: CloudLiveAvatarConfig = Field(default_factory=CloudLiveAvatarConfig)


class Appearance(BaseModel):
    kind: Literal["portrait", "video_pack"]
    src: str
    framing: dict[str, str | float] = Field(default_factory=dict)


class Voice(BaseModel):
    engine: str = "edge"
    voice_id: str
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: int = Field(default=0, ge=-100, le=100)


class Persona(BaseModel):
    relationship: str
    traits: list[str]
    catchphrases: list[str]
    address_user_as: str


class Character(BaseModel):
    id: str
    name: str
    schema_version: Literal[3] = 3
    appearance: Appearance
    video_avatar: VideoAvatarConfig
    voice: Voice
    persona: Persona
    default_style_id: str
    license: str
    pack_metadata: PackMetadata = Field(default_factory=PackMetadata)


class TutorUpdate(BaseModel):
    name: ShortLine
    relationship: str = Field(max_length=160)
    traits: list[ShortLine] = Field(max_length=8)
    catchphrases: list[ShortLine] = Field(max_length=8)
    address_user_as: str = Field(max_length=160)
    default_style_id: StyleId
    preferred_tier: VideoTier | None = None
    local_sidecar_driver_id: str | None = Field(default=None, max_length=120)


def _guess_asset_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".webm":
        return "video/webm"
    if suffix == ".mp4":
        return "video/mp4"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


class TutorCatalog:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository

    def _builtin_ids(self) -> set[str]:
        root = self.repository.settings.repo_root
        ids: set[str] = set()
        for path in (root / "content/characters").glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8-sig"))
                if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                    ids.add(raw["id"])
            except (OSError, json.JSONDecodeError):
                continue
        return ids

    def _normalize_recipe(self, raw: dict) -> Character | None:
        version = raw.get("schema_version")
        if version not in (2, 3):
            return None
        appearance = raw.get("appearance")
        if not isinstance(appearance, dict):
            return None
        if appearance.get("kind") == "vrm":
            return None
        src = str(appearance.get("src") or "").strip()
        if not src:
            return None

        normalized = dict(raw)
        normalized["schema_version"] = 3
        video_raw = normalized.get("video_avatar")
        if not isinstance(video_raw, dict):
            video_raw = {
                "aspect_ratio": "9:16",
                "preferred_tier": "static",
                "anchor_image": src,
            }
        else:
            video_raw = dict(video_raw)
            video_raw.setdefault("anchor_image", src)

        char_id = str(normalized.get("id") or "")
        pack_meta_raw = normalized.get("pack_metadata")
        if not isinstance(pack_meta_raw, dict):
            is_builtin = char_id.startswith("tutor-") and src.startswith("/static/avatars/")
            license_text = str(normalized.get("license") or "")
            pack_meta_raw = {
                "author": "Companion Space" if is_builtin else "User imported",
                "terms": license_text,
                "license_url": None,
                "allow_redistribution": license_text == "Apache-2.0",
                "source_kind": "builtin" if is_builtin else "imported_image",
            }
        else:
            pack_meta_raw = dict(pack_meta_raw)
            pack_meta_raw["license_url"] = safe_http_url(pack_meta_raw.get("license_url"))

        if pack_meta_raw.get("source_kind") == "builtin":
            discovered = discover_builtin_pack_clips(self.repository.settings.repo_root, char_id)
            if discovered is not None:
                crossfade_ms, clips = discovered
                existing_loop = video_raw.get("loop_pack")
                existing_clips = existing_loop.get("clips") if isinstance(existing_loop, dict) else None
                if not existing_clips:
                    video_raw["loop_pack"] = {"crossfade_ms": crossfade_ms, "clips": clips}
                    if not normalized.get("_tier_explicit") and "idle_breathe" in clips and "speak_explain_a" in clips:
                        video_raw["preferred_tier"] = "loop_pack"

        clips_dict = (video_raw.get("loop_pack") or {}).get("clips") if isinstance(video_raw.get("loop_pack"), dict) else {}
        appearance_kind: Literal["portrait", "video_pack"] = "video_pack" if clips_dict else "portrait"
        normalized["appearance"] = {
            "kind": appearance_kind,
            "src": str(video_raw.get("anchor_image") or src),
            "framing": appearance.get("framing") if isinstance(appearance.get("framing"), dict) else {},
        }
        normalized["video_avatar"] = video_raw
        normalized["pack_metadata"] = pack_meta_raw
        normalized.pop("model_metadata", None)
        return Character.model_validate(normalized)

    def seed(self) -> None:
        root = self.repository.settings.repo_root
        characters: list[Character] = []
        for path in sorted((root / "content/characters").glob("*.json")):
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            parsed = self._normalize_recipe(raw)
            if parsed is not None:
                characters.append(parsed)
        now = datetime.now(timezone.utc).isoformat()
        with self.repository.connection() as conn:
            conn.executemany(
                """
                INSERT INTO character_packs
                    (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                VALUES (?, ?, '', ?, '{}', ?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                [(character.id, character.name, character.model_dump_json(), now, now) for character in characters],
            )

    def list_characters(self) -> list[Character]:
        with self.repository.connection() as conn:
            rows = conn.execute("SELECT recipe_json FROM character_packs ORDER BY rowid").fetchall()
        result: list[Character] = []
        for row in rows:
            character = self._normalize_recipe(json.loads(row["recipe_json"]))
            if character is not None:
                result.append(character)
        return result

    def get_character(self, character_id: str) -> Character | None:
        with self.repository.connection() as conn:
            row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", (character_id,)).fetchone()
        if row is None:
            return None
        return self._normalize_recipe(json.loads(row["recipe_json"]))

    def resolve_active_character(self, character_id: str | None) -> Character | None:
        if character_id:
            found = self.get_character(character_id)
            if found is not None:
                return found
        roster = self.list_characters()
        if not roster:
            return None
        by_id = {entry.id: entry for entry in roster}
        for preferred in _FALLBACK_ORDER:
            if preferred in by_id:
                return by_id[preferred]
        return roster[0]

    def _store_parsed_pack(self, parsed: ParsedTutorPack) -> Character:
        identifier = f"tutor-{uuid4().hex}"
        anchor_url = f"/api/v2/characters/{identifier}/assets/{parsed.anchor_rel_path}"
        clip_urls: dict[ClipSlot, str] = {
            slot: f"/api/v2/characters/{identifier}/assets/{rel}"
            for slot, rel in parsed.clip_rel_paths.items()
        }
        has_core_clips = "idle_breathe" in clip_urls and "speak_explain_a" in clip_urls
        preferred_tier: VideoTier = "loop_pack" if has_core_clips else "static"
        appearance_kind: Literal["portrait", "video_pack"] = "video_pack" if clip_urls else "portrait"

        character = Character(
            id=identifier,
            name=parsed.name,
            appearance=Appearance(kind=appearance_kind, src=anchor_url),
            video_avatar=VideoAvatarConfig(
                aspect_ratio=parsed.aspect_ratio,
                preferred_tier=preferred_tier,
                anchor_image=anchor_url,
                loop_pack=LoopPackConfig(crossfade_ms=parsed.crossfade_ms, clips=clip_urls),
            ),
            voice=Voice(**parsed.voice.model_dump()),
            persona=Persona(**parsed.persona.model_dump()),
            default_style_id=parsed.default_style_id,
            license=parsed.terms,
            pack_metadata=PackMetadata(
                author=parsed.author,
                terms=parsed.terms,
                license_url=parsed.license_url,
                allow_redistribution=parsed.allow_redistribution,
                source_kind=parsed.source_kind,
            ),
        )

        asset_root = CharacterPathMixin._contained_child(self.repository.settings.characters_root, identifier)
        io_root = _windows_io_path(asset_root)
        io_root.mkdir(parents=True, exist_ok=False)
        now = datetime.now(timezone.utc).isoformat()
        manifest = {"asset_paths": sorted(parsed.asset_files.keys())}
        try:
            for rel_path, content in parsed.asset_files.items():
                target = CharacterPathMixin._contained_child(asset_root, rel_path)
                io_target = _windows_io_path(target)
                io_target.parent.mkdir(parents=True, exist_ok=True)
                io_target.write_bytes(content)
            with self.repository.connection() as conn:
                conn.execute(
                    """INSERT INTO character_packs
                    (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                    VALUES (?, ?, '', ?, ?, ?, ?)""",
                    (identifier, character.name, character.model_dump_json(), json.dumps(manifest), now, now),
                )
        except Exception:
            shutil.rmtree(io_root, ignore_errors=True)
            shutil.rmtree(asset_root, ignore_errors=True)
            raise
        return character

    def import_upload(self, filename: str, data: bytes) -> Character:
        suffix = Path(filename).suffix.lower()
        if suffix in IMAGE_SUFFIXES:
            parsed = parse_single_image_upload(filename, data)
        elif suffix in ARCHIVE_SUFFIXES:
            parsed = parse_tutorpack_archive(filename, data)
        else:
            raise ValueError("Choose a .tutorpack, .zip, .png, .jpg, or .webp file.")
        return self._store_parsed_pack(parsed)

    def update_character(self, identifier: str, payload: TutorUpdate) -> Character | None:
        with self.repository.connection() as conn:
            row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", (identifier,)).fetchone()
            if row is None:
                return None
            existing = self._normalize_recipe(json.loads(row["recipe_json"]))
            if existing is None:
                return None
            data = existing.model_dump()
            data["name"] = payload.name
            data["default_style_id"] = payload.default_style_id
            data["persona"] = payload.model_dump(include={"relationship", "traits", "catchphrases", "address_user_as"})
            if payload.preferred_tier is not None:
                data["video_avatar"]["preferred_tier"] = payload.preferred_tier
            if "local_sidecar_driver_id" in payload.model_fields_set:
                data["video_avatar"]["local_sidecar"]["driver_id"] = payload.local_sidecar_driver_id
            character = Character.model_validate(data)
            stored = character.model_dump()
            if payload.preferred_tier is not None:
                stored["_tier_explicit"] = True
            conn.execute(
                "UPDATE character_packs SET name = ?, recipe_json = ?, updated_at = ? WHERE id = ?",
                (character.name, json.dumps(stored), datetime.now(timezone.utc).isoformat(), identifier),
            )
        return character

    def delete_character(self, identifier: str) -> bool:
        with self.repository.connection() as conn:
            row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", (identifier,)).fetchone()
            if row is None:
                return False
            character = self._normalize_recipe(json.loads(row["recipe_json"]))
            if character is None:
                return False
            if character.pack_metadata.source_kind == "builtin" or identifier in self._builtin_ids():
                raise ValueError("Built-in teachers cannot be deleted.")
            conn.execute("DELETE FROM character_packs WHERE id = ?", (identifier,))

        asset_root = CharacterPathMixin._contained_child(self.repository.settings.characters_root, identifier)
        shutil.rmtree(_windows_io_path(asset_root), ignore_errors=True)
        shutil.rmtree(asset_root, ignore_errors=True)

        current_default = get_setting(self.repository, "default_character_id", None)
        if current_default == identifier:
            fallback = self.resolve_active_character(None)
            put_setting(self.repository, "default_character_id", fallback.id if fallback else None)
        return True

    def asset_file(self, identifier: str, relative_path: str) -> tuple[Path, str] | None:
        character = self.get_character(identifier)
        if character is None or character.pack_metadata.source_kind == "builtin":
            return None
        try:
            normalized = CharacterPathMixin._normalize_requested_asset_path(relative_path)
        except ValueError:
            return None
        if Path(normalized).suffix.lower() not in _ALLOWED_ASSET_SUFFIXES:
            return None
        location = CharacterPathMixin._contained_child(
            self.repository.settings.characters_root, f"{identifier}/{normalized}"
        )
        existing = _existing_io_file(location)
        if existing is None:
            return None
        return existing, _guess_asset_media_type(location)

    def read_anchor_image(self, identifier: str) -> tuple[bytes, str] | None:
        character = self.resolve_active_character(identifier)
        if character is None:
            return None
        anchor = character.video_avatar.anchor_image
        if anchor.startswith("/static/avatars/"):
            rel = anchor.removeprefix("/static/avatars/")
            try:
                normalized = CharacterPathMixin._normalize_requested_asset_path(rel)
            except ValueError:
                return None
            avatars_root = self.repository.settings.repo_root / "assets" / "avatars"
            location = CharacterPathMixin._contained_child(avatars_root, normalized)
            existing = _existing_io_file(location)
            if existing is None:
                return None
            return existing.read_bytes(), _guess_asset_media_type(location)
        prefix = f"/api/v2/characters/{character.id}/assets/"
        if anchor.startswith(prefix):
            rel = anchor.removeprefix(prefix)
            found = self.asset_file(character.id, rel)
            if found is None:
                return None
            path, mime = found
            return path.read_bytes(), mime
        return None
