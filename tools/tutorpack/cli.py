"""CLI toolchain for scaffolding, validating, and packing .tutorpack anime character packs.

Usage:
  python tools/tutorpack/cli.py scaffold "沐音" --anchor path/to/echo.png -o ./echo-pack
  python tools/tutorpack/cli.py validate ./echo-pack
  python tools/tutorpack/cli.py pack ./echo-pack -o echo.tutorpack
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

CLIP_SLOTS: tuple[str, ...] = (
    "idle_breathe",
    "listen_nod",
    "think_chin",
    "speak_explain_a",
    "speak_explain_b",
    "board_point",
    "react_praise",
    "react_comfort",
)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_SUFFIXES = {".webm", ".mp4"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_CLIP_BYTES = 15 * 1024 * 1024
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MIN_DIM = 256
MAX_DIM = 4096


def _validate_image_bytes(data: bytes, label: str) -> tuple[int, int, str]:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"{label}: image must be non-empty and at most 10 MB.")
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format or ""
            if fmt not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError(f"{label}: unsupported image format {fmt!r}.")
            width, height = img.size
            if not (MIN_DIM <= width <= MAX_DIM and MIN_DIM <= height <= MAX_DIM):
                raise ValueError(f"{label}: dimensions {width}x{height} outside 256..4096.")
            return width, height, fmt
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"{label}: invalid image data.") from exc


def _validate_clip_bytes(filename: str, data: bytes) -> None:
    suffix = Path(filename).suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise ValueError(f"{filename}: expected .webm or .mp4.")
    if not data or len(data) > MAX_CLIP_BYTES:
        raise ValueError(f"{filename}: clip must be non-empty and at most 15 MB.")
    if suffix == ".webm" and not data.startswith(b"\x1a\x45\xdf\xa3"):
        raise ValueError(f"{filename}: invalid WebM EBML header.")
    if suffix == ".mp4" and (len(data) < 12 or data[4:8] != b"ftyp"):
        raise ValueError(f"{filename}: invalid MP4 ftyp header.")


def _safe_rel(path_str: str) -> str:
    if "\\" in path_str or path_str.startswith("/") or ".." in Path(path_str).parts:
        raise ValueError(f"Unsafe relative path: {path_str}")
    return Path(path_str).as_posix()


def scaffold_pack(name: str, anchor: Path, output_dir: Path, *, author: str, terms: str) -> Path:
    if not anchor.is_file():
        raise ValueError(f"Anchor image not found: {anchor}")
    raw = anchor.read_bytes()
    _validate_image_bytes(raw, anchor.name)

    output_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = output_dir / "clips"
    clips_dir.mkdir(exist_ok=True)

    with Image.open(io.BytesIO(raw)) as img:
        normalized = ImageOps.exif_transpose(img)
        converted = normalized.convert("RGBA" if "A" in normalized.getbands() else "RGB")
        converted.save(output_dir / "anchor.webp", format="WEBP", quality=92, method=4)

    manifest = {
        "schema_version": 1,
        "name": name,
        "aspect_ratio": "9:16",
        "crossfade_ms": 180,
        "anchor": "anchor.webp",
        "clips": {},
        "persona": {
            "relationship": "1-on-1 anime tutor",
            "traits": ["温和", "耐心", "条理清晰"],
            "catchphrases": [],
            "address_user_as": "你",
        },
        "voice": {
            "engine": "edge",
            "voice_id": "zh-CN-XiaoxiaoNeural",
            "rate": 1.0,
            "pitch": 0,
        },
        "default_style_id": "guided",
        "license": {
            "author": author,
            "terms": terms,
            "license_url": None,
            "allow_redistribution": False,
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    prompt_src = Path(__file__).resolve().parent / "prompts" / "anime-8-clips.zh-CN.md"
    if prompt_src.is_file():
        (output_dir / "PROMPTS.md").write_text(prompt_src.read_text(encoding="utf-8"), encoding="utf-8")
    return output_dir


def validate_directory(pack_dir: Path) -> dict:
    if not pack_dir.is_dir():
        raise ValueError(f"Pack directory does not exist: {pack_dir}")
    manifest_file = pack_dir / "manifest.json"
    if not manifest_file.is_file():
        raise ValueError("Missing manifest.json in pack directory.")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must be a JSON object.")
    name = str(manifest.get("name") or "").strip()
    if not name:
        raise ValueError("manifest.json is missing a non-empty 'name'.")

    anchor_rel = _safe_rel(str(manifest.get("anchor") or "anchor.webp"))
    anchor_file = (pack_dir / anchor_rel).resolve()
    if not anchor_file.is_relative_to(pack_dir.resolve()) or not anchor_file.is_file():
        raise ValueError(f"Anchor image not found: {anchor_rel}")
    width, height, fmt = _validate_image_bytes(anchor_file.read_bytes(), anchor_rel)

    clips = manifest.get("clips") or {}
    if not isinstance(clips, dict):
        raise ValueError("'clips' in manifest.json must be an object.")
    present_slots: list[str] = []
    for slot, rel in clips.items():
        if slot not in CLIP_SLOTS:
            raise ValueError(f"Unknown clip slot: {slot}")
        clean_rel = _safe_rel(str(rel))
        clip_file = (pack_dir / clean_rel).resolve()
        if not clip_file.is_relative_to(pack_dir.resolve()) or not clip_file.is_file():
            raise ValueError(f"Clip file missing for slot {slot}: {clean_rel}")
        _validate_clip_bytes(clean_rel, clip_file.read_bytes())
        present_slots.append(slot)

    missing_slots = [slot for slot in CLIP_SLOTS if slot not in present_slots]
    return {
        "name": name,
        "anchor": {"path": anchor_rel, "width": width, "height": height, "format": fmt},
        "present_slots": present_slots,
        "missing_slots": missing_slots,
        "tier": "loop_pack" if "idle_breathe" in present_slots and "speak_explain_a" in present_slots else "static",
    }


def validate_archive(archive_path: Path) -> dict:
    if not archive_path.is_file():
        raise ValueError(f"Archive not found: {archive_path}")
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds 100 MB limit.")
    with zipfile.ZipFile(archive_path, "r") as zf:
        names = set(zf.namelist())
        if "manifest.json" not in names:
            raise ValueError("Archive is missing manifest.json.")
        manifest = json.loads(zf.read("manifest.json").decode("utf-8-sig"))
        anchor_rel = _safe_rel(str(manifest.get("anchor") or "anchor.webp"))
        if anchor_rel not in names:
            raise ValueError(f"Archive is missing anchor image: {anchor_rel}")
        width, height, fmt = _validate_image_bytes(zf.read(anchor_rel), anchor_rel)
        clips = manifest.get("clips") or {}
        present_slots: list[str] = []
        for slot, rel in clips.items():
            if slot not in CLIP_SLOTS:
                raise ValueError(f"Unknown clip slot: {slot}")
            clean_rel = _safe_rel(str(rel))
            if clean_rel not in names:
                raise ValueError(f"Archive is missing clip for {slot}: {clean_rel}")
            _validate_clip_bytes(clean_rel, zf.read(clean_rel))
            present_slots.append(slot)
    missing_slots = [slot for slot in CLIP_SLOTS if slot not in present_slots]
    return {
        "name": manifest["name"],
        "anchor": {"path": anchor_rel, "width": width, "height": height, "format": fmt},
        "present_slots": present_slots,
        "missing_slots": missing_slots,
        "tier": "loop_pack" if "idle_breathe" in present_slots and "speak_explain_a" in present_slots else "static",
    }


def auto_discover_clips_in_dir(pack_dir: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    clips_dir = pack_dir / "clips"
    if not clips_dir.is_dir():
        return found
    for slot in CLIP_SLOTS:
        for ext in (".webm", ".mp4"):
            candidate = clips_dir / f"{slot}{ext}"
            if candidate.is_file():
                found[slot] = f"clips/{slot}{ext}"
                break
    return found


def pack_directory(pack_dir: Path, output_file: Path, *, autodiscover: bool = True) -> dict:
    manifest_file = pack_dir / "manifest.json"
    if autodiscover and manifest_file.is_file():
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        if isinstance(manifest, dict) and not manifest.get("clips"):
            discovered = auto_discover_clips_in_dir(pack_dir)
            if discovered:
                manifest["clips"] = discovered
                manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = validate_directory(pack_dir)
    manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    anchor_rel = _safe_rel(str(manifest.get("anchor") or "anchor.webp"))
    files_to_pack = ["manifest.json", anchor_rel]
    for rel in (manifest.get("clips") or {}).values():
        files_to_pack.append(_safe_rel(str(rel)))

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_file, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in dict.fromkeys(files_to_pack):
            zf.write(pack_dir / rel, arcname=rel)
    if output_file.stat().st_size > MAX_ARCHIVE_BYTES:
        output_file.unlink(missing_ok=True)
        raise ValueError("Packed .tutorpack archive exceeds 100 MB limit.")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Companion Space .tutorpack CLI toolchain")
    sub = parser.add_subparsers(dest="command", required=True)

    p_scaffold = sub.add_parser("scaffold", help="Create a starter .tutorpack folder from a single anime image")
    p_scaffold.add_argument("name", help="Display name of the tutor")
    p_scaffold.add_argument("--anchor", required=True, type=Path, help="Path to anchor PNG/JPG/WebP image")
    p_scaffold.add_argument("-o", "--output", required=True, type=Path, help="Output pack folder")
    p_scaffold.add_argument("--author", default="User imported", help="Creator attribution")
    p_scaffold.add_argument("--terms", default="Local personal use", help="License terms")

    p_validate = sub.add_parser("validate", help="Validate a .tutorpack directory or archive")
    p_validate.add_argument("target", type=Path, help="Directory or .tutorpack archive")

    p_pack = sub.add_parser("pack", help="Validate and bundle a directory into a .tutorpack archive")
    p_pack.add_argument("source", type=Path, help="Pack directory containing manifest.json")
    p_pack.add_argument("-o", "--output", required=True, type=Path, help="Destination .tutorpack file")

    args = parser.parse_args(argv)
    try:
        if args.command == "scaffold":
            folder = scaffold_pack(args.name, args.anchor, args.output, author=args.author, terms=args.terms)
            print(json.dumps({"ok": True, "scaffolded": str(folder)}, ensure_ascii=False))
            return 0
        if args.command == "validate":
            report = validate_directory(args.target) if args.target.is_dir() else validate_archive(args.target)
            print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "pack":
            report = pack_directory(args.source, args.output)
            print(json.dumps({"ok": True, "archive": str(args.output), **report}, ensure_ascii=False, indent=2))
            return 0
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
