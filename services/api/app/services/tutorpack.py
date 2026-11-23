from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field, StringConstraints

from app.core.config import APP_ROOT
from app.core.errors import CodedValueError
from app.services.character_modules.paths import CharacterPathMixin

_CATALOG_PATH = APP_ROOT / "libs" / "schemas" / "tutor_media_catalog.json"


def load_tutor_media_catalog() -> dict:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8-sig"))


_CATALOG = load_tutor_media_catalog()

VideoTier = Literal["static", "loop_pack", "local_sidecar", "cloud_live"]
CLIP_SLOTS: tuple[str, ...] = tuple(entry["id"] for entry in _CATALOG["clips"])
STILL_SLOTS: tuple[str, ...] = tuple(_CATALOG["stills"])
ClipSlot = Literal[*CLIP_SLOTS]
StillSlot = Literal[*STILL_SLOTS]

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_SUFFIXES = {".webm", ".mp4"}
ARCHIVE_SUFFIXES = {".tutorpack", ".zip"}

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024
MAX_CLIP_BYTES = int(_CATALOG["limits"]["max_clip_bytes"])
MAX_ARCHIVE_FILES = int(_CATALOG["limits"]["max_archive_files"])
MIN_IMAGE_DIM = 256
MAX_IMAGE_DIM = 4096
MAX_IMAGE_PIXELS = 16_777_216

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


def safe_http_url(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    return value.strip()


class PackCanvas(BaseModel):
    width: int = Field(ge=256, le=4096)
    height: int = Field(ge=256, le=4096)
    fps: int = Field(ge=12, le=60)


class ClipMeta(BaseModel):
    settle_ms: int | None = Field(default=None, ge=0, le=30_000)
    duration_ms: int | None = Field(default=None, ge=0, le=60_000)


class PackMediaInfo(BaseModel):
    generator: str = Field(default="", max_length=240)
    ai_generated: bool = False
    image_generator: str | None = Field(default=None, max_length=240)
    video_generator: str | None = Field(default=None, max_length=240)


class PackLicenseInput(BaseModel):
    author: str = Field(default="User imported", max_length=160)
    terms: str = Field(default="Local personal use", max_length=240)
    license_url: str | None = Field(default=None, max_length=512)
    allow_redistribution: bool = False


class PackPersonaInput(BaseModel):
    relationship: str = Field(default="", max_length=160)
    traits: list[ShortText] = Field(default_factory=list, max_length=8)
    catchphrases: list[ShortText] = Field(default_factory=list, max_length=8)
    address_user_as: str = Field(default="你", max_length=160)


class PackVoiceInput(BaseModel):
    engine: str = Field(default="edge", max_length=40)
    voice_id: str = Field(default="zh-CN-XiaoxiaoNeural", max_length=120)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: int = Field(default=0, ge=-100, le=100)


class TutorPackManifest(BaseModel):
    schema_version: Literal[1, 3] = 1
    name: ShortText
    aspect_ratio: Literal["9:16", "3:4"] = "9:16"
    crossfade_ms: int = Field(default=180, ge=0, le=600)
    canvas: PackCanvas | None = None
    anchor: str = Field(default="anchor.webp", max_length=240)
    clips: dict[ClipSlot, str] = Field(default_factory=dict)
    clip_meta: dict[ClipSlot, ClipMeta] = Field(default_factory=dict)
    stills: dict[StillSlot, str] = Field(default_factory=dict)
    media: PackMediaInfo | None = None
    persona: PackPersonaInput = Field(default_factory=PackPersonaInput)
    voice: PackVoiceInput = Field(default_factory=PackVoiceInput)
    default_style_id: Literal["guided", "direct", "analogy", "exam", "rigorous"] = "guided"
    license: PackLicenseInput = Field(default_factory=PackLicenseInput)


@dataclass(frozen=True)
class ParsedTutorPack:
    name: str
    aspect_ratio: Literal["9:16", "3:4"]
    crossfade_ms: int
    canvas: PackCanvas | None
    anchor_rel_path: str
    clip_rel_paths: dict[ClipSlot, str]
    clip_meta: dict[ClipSlot, ClipMeta]
    still_rel_paths: dict[StillSlot, str]
    media: PackMediaInfo | None
    asset_files: dict[str, bytes]
    persona: PackPersonaInput
    voice: PackVoiceInput
    default_style_id: Literal["guided", "direct", "analogy", "exam", "rigorous"]
    author: str
    terms: str
    license_url: str | None
    allow_redistribution: bool
    source_kind: Literal["imported_image", "imported_pack"]


@dataclass(frozen=True)
class DiscoveredBuiltinPack:
    crossfade_ms: int
    canvas: PackCanvas | None
    clips: dict[ClipSlot, str]
    clip_meta: dict[ClipSlot, ClipMeta]
    stills: dict[StillSlot, str]
    media: PackMediaInfo | None
    license_info: PackLicenseInput | None


def sanitize_anchor_image(data: bytes) -> bytes:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise CodedValueError("tutor_image_too_large", "Choose an image file up to 10 MB.")
    original_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format not in {"PNG", "JPEG", "WEBP"}:
                raise CodedValueError("tutor_image_format_invalid", "Unsupported image format. Use PNG, JPEG, or WebP.")
            width, height = img.size
            if (
                width < MIN_IMAGE_DIM
                or height < MIN_IMAGE_DIM
                or width > MAX_IMAGE_DIM
                or height > MAX_IMAGE_DIM
                or width * height > MAX_IMAGE_PIXELS
            ):
                raise CodedValueError(
                    "tutor_image_dimensions_invalid",
                    "Image dimensions must be between 256 and 4096 pixels.",
                )
            normalized = ImageOps.exif_transpose(img)
            converted = normalized.convert("RGBA" if "A" in normalized.getbands() else "RGB")
            out = io.BytesIO()
            converted.save(out, format="WEBP", quality=90, method=4)
            return out.getvalue()
    except Image.DecompressionBombError as exc:
        raise CodedValueError("tutor_image_dimensions_invalid", "Image exceeds the allowed pixel limit.") from exc
    except (UnidentifiedImageError, OSError) as exc:
        raise CodedValueError("tutor_image_format_invalid", "The uploaded file is not a valid image.") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = original_limit


def validate_video_clip_bytes(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise CodedValueError("tutor_archive_invalid", f"Unsupported clip format for {filename}. Use .webm or .mp4.")
    if not data or len(data) > MAX_CLIP_BYTES:
        raise CodedValueError("tutor_archive_invalid", f"Video clip {filename} must be non-empty and at most 15 MB.")
    if suffix == ".webm":
        if not data.startswith(b"\x1a\x45\xdf\xa3"):
            raise CodedValueError("tutor_archive_invalid", f"Video clip {filename} does not have a valid WebM header.")
        return "video/webm"
    if len(data) < 12 or data[4:8] != b"ftyp":
        raise CodedValueError("tutor_archive_invalid", f"Video clip {filename} does not have a valid MP4 header.")
    return "video/mp4"


def parse_single_image_upload(filename: str, data: bytes) -> ParsedTutorPack:
    suffix = Path(filename).suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        raise CodedValueError("tutor_unsupported_file", "Choose a PNG, JPG, or WebP image.")
    clean_webp = sanitize_anchor_image(data)
    stem = Path(filename).stem.strip() or "Custom tutor"
    safe_name = stem[:160]
    return ParsedTutorPack(
        name=safe_name,
        aspect_ratio="9:16",
        crossfade_ms=180,
        canvas=None,
        anchor_rel_path="anchor.webp",
        clip_rel_paths={},
        clip_meta={},
        still_rel_paths={},
        media=None,
        asset_files={"anchor.webp": clean_webp},
        persona=PackPersonaInput(),
        voice=PackVoiceInput(),
        default_style_id="guided",
        author="User imported",
        terms="Local personal use",
        license_url=None,
        allow_redistribution=False,
        source_kind="imported_image",
    )


def _is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    return ((info.external_attr >> 16) & 0o170000) == 0o120000


def parse_tutorpack_archive(filename: str, data: bytes) -> ParsedTutorPack:
    suffix = Path(filename).suffix.lower()
    if suffix not in ARCHIVE_SUFFIXES:
        raise CodedValueError("tutor_unsupported_file", "Choose a .tutorpack or .zip archive.")
    if not data or len(data) > MAX_ARCHIVE_BYTES:
        raise CodedValueError("tutor_archive_invalid", "The .tutorpack archive must be non-empty and at most 100 MB.")

    try:
        archive = zipfile.ZipFile(io.BytesIO(data), "r")
    except zipfile.BadZipFile as exc:
        raise CodedValueError("tutor_archive_invalid", "The uploaded file is not a valid .tutorpack ZIP archive.") from exc

    with archive:
        entries: dict[str, bytes] = {}
        seen_keys: set[str] = set()
        total_uncompressed = 0

        for info in archive.infolist():
            if info.is_dir():
                continue
            if _is_zip_symlink(info):
                raise CodedValueError("tutor_archive_invalid", "Symbolic links are not allowed in a .tutorpack archive.")
            if len(entries) >= MAX_ARCHIVE_FILES:
                raise CodedValueError("tutor_archive_invalid", "The .tutorpack archive contains too many files.")
            try:
                normalized = CharacterPathMixin._normalize_relative_posix_path(
                    info.filename,
                    traversal_message="Archive entry path is invalid or attempts path traversal.",
                )
            except ValueError as exc:
                raise CodedValueError("tutor_archive_invalid", str(exc)) from exc
            if CharacterPathMixin._is_executable_name(normalized):
                raise CodedValueError("tutor_archive_invalid", f"Executable files are not allowed in a .tutorpack archive: {normalized}")
            portable_key = CharacterPathMixin._portable_path_key(normalized)
            if portable_key in seen_keys:
                raise CodedValueError("tutor_archive_invalid", f"Duplicate archive entry path: {normalized}")
            seen_keys.add(portable_key)

            if info.file_size > MAX_UNCOMPRESSED_BYTES:
                raise CodedValueError("tutor_archive_invalid", "Archive entry exceeds the allowed uncompressed size limit.")
            with archive.open(info, "r") as stream:
                remaining = MAX_UNCOMPRESSED_BYTES - total_uncompressed
                chunk = stream.read(remaining + 1)
            if len(chunk) > remaining:
                raise CodedValueError("tutor_archive_invalid", "Archive uncompressed size exceeds the 150 MB safety limit.")
            total_uncompressed += len(chunk)
            entries[normalized] = chunk

    manifest_raw = entries.get("manifest.json")
    if manifest_raw is None:
        raise CodedValueError("tutor_archive_invalid", "The .tutorpack archive is missing manifest.json.")
    try:
        manifest_obj = json.loads(manifest_raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CodedValueError("tutor_archive_invalid", "manifest.json must be valid UTF-8 JSON.") from exc
    if not isinstance(manifest_obj, dict):
        raise CodedValueError("tutor_archive_invalid", "manifest.json must be a JSON object.")
    try:
        manifest = TutorPackManifest.model_validate(manifest_obj)
    except ValueError as exc:
        raise CodedValueError("tutor_archive_invalid", str(exc)) from exc

    try:
        anchor_path = CharacterPathMixin._normalize_relative_posix_path(
            manifest.anchor,
            traversal_message="Invalid anchor image path in manifest.json.",
        )
    except ValueError as exc:
        raise CodedValueError("tutor_archive_invalid", str(exc)) from exc
    anchor_bytes = entries.get(anchor_path)
    if anchor_bytes is None:
        raise CodedValueError("tutor_archive_invalid", f"Anchor image is missing from archive: {anchor_path}")
    clean_anchor = sanitize_anchor_image(anchor_bytes)

    asset_files: dict[str, bytes] = {"anchor.webp": clean_anchor}
    clip_rel_paths: dict[ClipSlot, str] = {}
    for slot, raw_clip_path in manifest.clips.items():
        try:
            clip_path = CharacterPathMixin._normalize_relative_posix_path(
                raw_clip_path,
                traversal_message=f"Invalid clip path for {slot} in manifest.json.",
            )
        except ValueError as exc:
            raise CodedValueError("tutor_archive_invalid", str(exc)) from exc
        clip_bytes = entries.get(clip_path)
        if clip_bytes is None:
            raise CodedValueError("tutor_archive_invalid", f"Video clip for {slot} is missing from archive: {clip_path}")
        validate_video_clip_bytes(clip_path, clip_bytes)
        clip_suffix = Path(clip_path).suffix.lower()
        target_rel = f"clips/{slot}{clip_suffix}"
        asset_files[target_rel] = clip_bytes
        clip_rel_paths[slot] = target_rel

    still_rel_paths: dict[StillSlot, str] = {}
    for still_key, raw_still_path in manifest.stills.items():
        try:
            still_path = CharacterPathMixin._normalize_relative_posix_path(
                raw_still_path,
                traversal_message=f"Invalid still path for {still_key} in manifest.json.",
            )
        except ValueError as exc:
            raise CodedValueError("tutor_archive_invalid", str(exc)) from exc
        still_bytes = entries.get(still_path)
        if still_bytes is None:
            raise CodedValueError("tutor_archive_invalid", f"Still image for {still_key} is missing from archive: {still_path}")
        clean_still = sanitize_anchor_image(still_bytes)
        target_rel = f"stills/{still_key}.webp"
        asset_files[target_rel] = clean_still
        still_rel_paths[still_key] = target_rel

    return ParsedTutorPack(
        name=manifest.name,
        aspect_ratio=manifest.aspect_ratio,
        crossfade_ms=manifest.crossfade_ms,
        canvas=manifest.canvas,
        anchor_rel_path="anchor.webp",
        clip_rel_paths=clip_rel_paths,
        clip_meta=dict(manifest.clip_meta),
        still_rel_paths=still_rel_paths,
        media=manifest.media,
        asset_files=asset_files,
        persona=manifest.persona,
        voice=manifest.voice,
        default_style_id=manifest.default_style_id,
        author=manifest.license.author.strip() or "User imported",
        terms=manifest.license.terms.strip() or "Local personal use",
        license_url=safe_http_url(manifest.license.license_url),
        allow_redistribution=manifest.license.allow_redistribution,
        source_kind="imported_pack",
    )


def _discover_pack_from_dir(pack_dir: Path, url_prefix: str) -> DiscoveredBuiltinPack | None:
    manifest_file = pack_dir / "manifest.json"
    if not manifest_file.is_file():
        return None
    try:
        raw = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, dict):
            return None
        manifest = TutorPackManifest.model_validate(raw)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    pack_root = pack_dir.resolve()
    resolved_clips: dict[ClipSlot, str] = {}
    for slot, raw_rel in manifest.clips.items():
        try:
            rel = CharacterPathMixin._normalize_relative_posix_path(
                raw_rel,
                traversal_message="Invalid builtin clip path.",
            )
        except ValueError:
            continue
        candidate = (pack_dir / rel).resolve()
        if candidate.is_relative_to(pack_root) and candidate.is_file():
            resolved_clips[slot] = f"{url_prefix}/{rel}"

    resolved_stills: dict[StillSlot, str] = {}
    for still_key, raw_rel in manifest.stills.items():
        try:
            rel = CharacterPathMixin._normalize_relative_posix_path(
                raw_rel,
                traversal_message="Invalid builtin still path.",
            )
        except ValueError:
            continue
        candidate = (pack_dir / rel).resolve()
        if candidate.is_relative_to(pack_root) and candidate.is_file():
            resolved_stills[still_key] = f"{url_prefix}/{rel}"

    resolved_meta: dict[ClipSlot, ClipMeta] = {
        slot: meta for slot, meta in manifest.clip_meta.items() if slot in resolved_clips
    }
    license_info = manifest.license if "license" in raw else None
    return DiscoveredBuiltinPack(
        crossfade_ms=manifest.crossfade_ms,
        canvas=manifest.canvas,
        clips=resolved_clips,
        clip_meta=resolved_meta,
        stills=resolved_stills,
        media=manifest.media,
        license_info=license_info,
    )


def discover_builtin_pack(
    repo_root: Path,
    character_id: str,
    storage_root: Path | None = None,
) -> DiscoveredBuiltinPack | None:
    repo_pack = _discover_pack_from_dir(
        repo_root / "assets" / "avatars" / "packs" / character_id,
        f"/static/avatars/packs/{character_id}",
    )
    data_pack: DiscoveredBuiltinPack | None = None
    if storage_root is not None:
        data_pack = _discover_pack_from_dir(
            storage_root / "avatar_packs" / character_id,
            f"/api/v2/characters/{character_id}/assets",
        )
    if data_pack is None:
        return repo_pack
    if repo_pack is None:
        return data_pack

    merged_clips = dict(repo_pack.clips)
    merged_clips.update(data_pack.clips)
    merged_meta = dict(repo_pack.clip_meta)
    merged_meta.update(data_pack.clip_meta)
    merged_stills = dict(repo_pack.stills)
    merged_stills.update(data_pack.stills)
    return DiscoveredBuiltinPack(
        crossfade_ms=data_pack.crossfade_ms,
        canvas=data_pack.canvas or repo_pack.canvas,
        clips=merged_clips,
        clip_meta=merged_meta,
        stills=merged_stills,
        media=data_pack.media or repo_pack.media,
        license_info=data_pack.license_info or repo_pack.license_info,
    )


def discover_builtin_pack_clips(repo_root: Path, character_id: str) -> tuple[int, dict[ClipSlot, str]] | None:
    discovered = discover_builtin_pack(repo_root, character_id)
    if discovered is None or not discovered.clips:
        return None
    return discovered.crossfade_ms, discovered.clips
