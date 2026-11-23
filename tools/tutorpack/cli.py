"""CLI toolchain for scaffolding, validating, ingesting, reviewing, and packing .tutorpack character packs.

Usage:
  python tools/tutorpack/cli.py scaffold "沐音" --anchor path/to/anchor.png -o ./pack
  python tools/tutorpack/cli.py validate ./pack
  python tools/tutorpack/cli.py pack ./pack -o tutor.tutorpack
  python tools/tutorpack/cli.py legacy-fix ./assets/avatars/packs/tutor-chutang
  python tools/tutorpack/cli.py ingest --pack outputs/老师素材扩展-20261122 --tutor all
  python tools/tutorpack/cli.py stills --pack outputs/老师素材扩展-20261122 --tutor all
  python tools/tutorpack/cli.py sheet --tutor all
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import media_ops  # noqa: E402

_CATALOG = media_ops.load_catalog()
CLIP_CATALOG_BY_ID: dict[str, dict[str, Any]] = {entry["id"]: entry for entry in _CATALOG["clips"]}
CLIP_SLOTS: tuple[str, ...] = tuple(entry["id"] for entry in _CATALOG["clips"])
ACTIVE_CLIP_SLOTS: tuple[str, ...] = tuple(entry["id"] for entry in _CATALOG["clips"] if not entry.get("reserved"))
STILL_SLOTS: tuple[str, ...] = tuple(_CATALOG["stills"])

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_SUFFIXES = {".webm", ".mp4"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_CLIP_BYTES = int(_CATALOG["limits"]["max_clip_bytes"])
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = int(_CATALOG["limits"]["max_archive_files"])
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
    (output_dir / "clips").mkdir(exist_ok=True)
    (output_dir / "stills").mkdir(exist_ok=True)

    with Image.open(io.BytesIO(raw)) as img:
        normalized = ImageOps.exif_transpose(img)
        converted = normalized.convert("RGBA" if "A" in normalized.getbands() else "RGB")
        converted.save(output_dir / "anchor.webp", format="WEBP", quality=92, method=4)

    manifest = {
        "schema_version": 1,
        "name": name,
        "aspect_ratio": "9:16",
        "crossfade_ms": 180,
        "canvas": {"width": 576, "height": 1024, "fps": 24},
        "anchor": "anchor.webp",
        "clips": {},
        "clip_meta": {},
        "stills": {},
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
    return output_dir


def validate_directory(pack_dir: Path, *, check_media: bool = True, strict_limits: bool = False) -> dict[str, Any]:
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
    clip_meta = manifest.get("clip_meta") or {}
    if not isinstance(clip_meta, dict):
        raise ValueError("'clip_meta' in manifest.json must be an object.")
    for slot in clip_meta:
        if slot not in CLIP_CATALOG_BY_ID:
            raise ValueError(f"Unknown clip slot in clip_meta: {slot}")

    stills = manifest.get("stills") or {}
    if not isinstance(stills, dict):
        raise ValueError("'stills' in manifest.json must be an object.")
    present_stills: list[str] = []
    still_reports: dict[str, Any] = {}
    for still_key, rel in stills.items():
        if still_key not in STILL_SLOTS:
            raise ValueError(f"Unknown still slot: {still_key}")
        clean_rel = _safe_rel(str(rel))
        still_file = (pack_dir / clean_rel).resolve()
        if not still_file.is_relative_to(pack_dir.resolve()) or not still_file.is_file():
            raise ValueError(f"Still file missing for {still_key}: {clean_rel}")
        sw, sh, sfmt = _validate_image_bytes(still_file.read_bytes(), clean_rel)
        present_stills.append(still_key)
        still_reports[still_key] = {
            "path": clean_rel,
            "width": sw,
            "height": sh,
            "format": sfmt,
            "bytes": still_file.stat().st_size,
        }

    present_slots: list[str] = []
    total_clip_bytes = 0
    clip_reports: dict[str, Any] = {}
    media_failures: list[str] = []
    unchecked_items: list[str] = []

    ffmpeg_bin = media_ops.find_binary("TUTORPACK_FFMPEG", "ffmpeg") if check_media else None
    ffprobe_bin = media_ops.find_ffprobe(ffmpeg_bin) if check_media else None
    if check_media and not ffprobe_bin:
        unchecked_items.extend(["codec", "profile", "pix_fmt", "canvas_dimensions", "fps", "audio_streams", "keyframes", "duration"])
    if check_media and not ffmpeg_bin:
        unchecked_items.extend(["seam_mae", "seam_block_max", "hub_mae"])

    declared_canvas = manifest.get("canvas")
    seen_dims: set[tuple[int, int]] = set()
    hub_cache: dict[tuple[int, int], Any] = {}

    for slot, rel in clips.items():
        if slot not in CLIP_CATALOG_BY_ID:
            raise ValueError(f"Unknown clip slot: {slot}")
        clean_rel = _safe_rel(str(rel))
        clip_file = (pack_dir / clean_rel).resolve()
        if not clip_file.is_relative_to(pack_dir.resolve()) or not clip_file.is_file():
            raise ValueError(f"Clip file missing for slot {slot}: {clean_rel}")
        data = clip_file.read_bytes()
        _validate_clip_bytes(clean_rel, data)
        present_slots.append(slot)
        size = len(data)
        total_clip_bytes += size

        entry = CLIP_CATALOG_BY_ID[slot]
        is_ingested = slot in clip_meta and isinstance(clip_meta.get(slot), dict) and "duration_ms" in clip_meta[slot]
        c_rep: dict[str, Any] = {"path": clean_rel, "bytes": size, "ingested": is_ingested}

        if strict_limits and size > media_ops.MAX_CLIP_BYTES_BUILTIN:
            media_failures.append(f"{slot}: size {size} exceeds {media_ops.MAX_CLIP_BYTES_BUILTIN}")

        if check_media and ffprobe_bin:
            probe = media_ops.probe_video(clip_file, ffprobe=ffprobe_bin, ffmpeg=ffmpeg_bin)
            if probe:
                c_rep.update(probe)
                seen_dims.add((probe["width"], probe["height"]))
                if strict_limits:
                    if probe["codec"] != "vp9":
                        media_failures.append(f"{slot}: codec={probe['codec']} (expected vp9)")
                    if probe["pix_fmt"] != "yuv420p":
                        media_failures.append(f"{slot}: pix_fmt={probe['pix_fmt']} (expected yuv420p)")
                    if (probe["width"], probe["height"]) not in {(576, 1024), (480, 864)}:
                        media_failures.append(f"{slot}: canvas {probe['width']}x{probe['height']} not 576x1024 or 480x864")
                    if declared_canvas:
                        if probe["width"] != declared_canvas.get("width") or probe["height"] != declared_canvas.get("height"):
                            media_failures.append(f"{slot}: canvas mismatch vs manifest.canvas")
                    if abs(probe["fps"] - 24.0) > 0.2:
                        media_failures.append(f"{slot}: fps={probe['fps']} (expected 24)")
                    allow_audio = bool(entry.get("allow_audio"))
                    if not allow_audio and probe["audio_streams"]:
                        media_failures.append(f"{slot}: unexpected audio stream")
                    if probe["keyframes"] > 1:
                        media_failures.append(f"{slot}: keyframes={probe['keyframes']} (expected 1)")

                if ffmpeg_bin and probe["width"] > 0 and probe["height"] > 0:
                    dim = (probe["width"], probe["height"])
                    if dim not in hub_cache:
                        hub_cache[dim] = media_ops.load_hub_frame(anchor_file, dim[0], dim[1])
                    frames = media_ops.decode_video_frames(
                        clip_file, width=dim[0], height=dim[1], fps=24, ffmpeg=ffmpeg_bin
                    )
                    fm = media_ops.measure_frame_metrics(frames, hub_cache[dim])
                    c_rep.update(fm)
                    # Judge duration/seam/hub ONLY for newly ingested clips (§5)
                    if strict_limits and is_ingested:
                        is_oneshot = entry["kind"] == "one_shot"
                        dur = probe["duration_sec"]
                        if is_oneshot and not (media_ops.ONESHOT_MIN_SEC <= dur <= media_ops.ONESHOT_MAX_SEC):
                            media_failures.append(f"{slot}: one-shot duration {dur}s outside 2.0..8.5s")
                        if not is_oneshot and not (media_ops.LOOP_MIN_SEC <= dur <= media_ops.LOOP_MAX_SEC):
                            media_failures.append(f"{slot}: loop duration {dur}s outside 4.0..9.0s")
                        if fm["seam_mae"] > media_ops.MAX_SEAM_MAE:
                            media_failures.append(f"{slot}: seam_mae {fm['seam_mae']} > {media_ops.MAX_SEAM_MAE}")
                        if fm["seam_block_max"] > media_ops.MAX_SEAM_BLOCK_MAE:
                            media_failures.append(f"{slot}: seam_block_max {fm['seam_block_max']} > {media_ops.MAX_SEAM_BLOCK_MAE}")
                        if fm["hub_first_mae"] > media_ops.MAX_HUB_MAE or fm["hub_last_mae"] > media_ops.MAX_HUB_MAE:
                            media_failures.append(f"{slot}: hub_mae ({fm['hub_first_mae']}, {fm['hub_last_mae']}) > {media_ops.MAX_HUB_MAE}")

        clip_reports[slot] = c_rep

    if strict_limits and len(seen_dims) > 1:
        media_failures.append(f"non-uniform canvas dimensions across pack: {sorted(seen_dims)}")
    if strict_limits and total_clip_bytes > media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN:
        media_failures.append(
            f"total clip bytes {total_clip_bytes} exceeds {media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN}"
        )

    if media_failures:
        raise ValueError("Media validation failed: " + "; ".join(media_failures))

    has_speak = any(s in present_slots for s in ("speak_calm", "speak_explain_a", "speak_explain_b"))
    missing_slots = [slot for slot in ACTIVE_CLIP_SLOTS if slot not in present_slots]
    return {
        "name": name,
        "anchor": {"path": anchor_rel, "width": width, "height": height, "format": fmt},
        "canvas": declared_canvas,
        "present_slots": present_slots,
        "missing_slots": missing_slots,
        "present_stills": present_stills,
        "missing_stills": [s for s in STILL_SLOTS if s not in present_stills],
        "total_clip_bytes": total_clip_bytes,
        "clips": clip_reports,
        "stills": still_reports,
        "unchecked_items": unchecked_items,
        "tier": "loop_pack" if "idle_breathe" in present_slots and has_speak else "static",
    }


def validate_archive(archive_path: Path) -> dict[str, Any]:
    if not archive_path.is_file():
        raise ValueError(f"Archive not found: {archive_path}")
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds 100 MB limit.")
    with zipfile.ZipFile(archive_path, "r") as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_ARCHIVE_FILES:
            raise ValueError(f"Archive exceeds {MAX_ARCHIVE_FILES} file limit ({len(infos)}).")
        names = {i.filename for i in infos}
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
            if slot not in CLIP_CATALOG_BY_ID:
                raise ValueError(f"Unknown clip slot: {slot}")
            clean_rel = _safe_rel(str(rel))
            if clean_rel not in names:
                raise ValueError(f"Archive is missing clip for {slot}: {clean_rel}")
            _validate_clip_bytes(clean_rel, zf.read(clean_rel))
            present_slots.append(slot)
        stills = manifest.get("stills") or {}
        present_stills: list[str] = []
        for still_key, rel in stills.items():
            if still_key not in STILL_SLOTS:
                raise ValueError(f"Unknown still slot: {still_key}")
            clean_rel = _safe_rel(str(rel))
            if clean_rel not in names:
                raise ValueError(f"Archive is missing still for {still_key}: {clean_rel}")
            _validate_image_bytes(zf.read(clean_rel), clean_rel)
            present_stills.append(still_key)
    has_speak = any(s in present_slots for s in ("speak_calm", "speak_explain_a", "speak_explain_b"))
    missing_slots = [slot for slot in ACTIVE_CLIP_SLOTS if slot not in present_slots]
    return {
        "name": manifest["name"],
        "anchor": {"path": anchor_rel, "width": width, "height": height, "format": fmt},
        "present_slots": present_slots,
        "missing_slots": missing_slots,
        "present_stills": present_stills,
        "tier": "loop_pack" if "idle_breathe" in present_slots and has_speak else "static",
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


def auto_discover_stills_in_dir(pack_dir: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    stills_dir = pack_dir / "stills"
    if not stills_dir.is_dir():
        return found
    for still_key in STILL_SLOTS:
        for ext in (".webp", ".png", ".jpg", ".jpeg"):
            candidate = stills_dir / f"{still_key}{ext}"
            if candidate.is_file():
                found[still_key] = f"stills/{still_key}{ext}"
                break
    return found


def pack_directory(pack_dir: Path, output_file: Path, *, autodiscover: bool = True) -> dict[str, Any]:
    manifest_file = pack_dir / "manifest.json"
    if autodiscover and manifest_file.is_file():
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        changed = False
        if isinstance(manifest, dict) and not manifest.get("clips"):
            discovered = auto_discover_clips_in_dir(pack_dir)
            if discovered:
                manifest["clips"] = discovered
                changed = True
        if isinstance(manifest, dict) and not manifest.get("stills"):
            discovered_stills = auto_discover_stills_in_dir(pack_dir)
            if discovered_stills:
                manifest["stills"] = discovered_stills
                changed = True
        if changed:
            manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = validate_directory(pack_dir, check_media=False)
    manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    anchor_rel = _safe_rel(str(manifest.get("anchor") or "anchor.webp"))
    files_to_pack = ["manifest.json", anchor_rel]
    for rel in (manifest.get("clips") or {}).values():
        files_to_pack.append(_safe_rel(str(rel)))
    for rel in (manifest.get("stills") or {}).values():
        files_to_pack.append(_safe_rel(str(rel)))

    unique_files = list(dict.fromkeys(files_to_pack))
    if len(unique_files) > MAX_ARCHIVE_FILES:
        raise ValueError(f"Pack exceeds {MAX_ARCHIVE_FILES} file limit ({len(unique_files)}).")

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_file, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in unique_files:
            zf.write(pack_dir / rel, arcname=rel)
    if output_file.stat().st_size > MAX_ARCHIVE_BYTES:
        output_file.unlink(missing_ok=True)
        raise ValueError("Packed .tutorpack archive exceeds 100 MB limit.")
    return report


def _resolve_tutors_arg(raw: str) -> list[str]:
    all_slugs = [t["slug"] for t in media_ops.load_tutors_data()]
    if raw.strip().lower() == "all":
        return all_slugs
    return [part.strip().lower() for part in raw.split(",") if part.strip()]


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
    p_validate.add_argument("--strict", action="store_true", help="Enforce spec §5 built-in thresholds via ffprobe/ffmpeg")
    p_validate.add_argument("--no-media", action="store_true", help="Skip ffprobe/ffmpeg frame checks")

    p_pack = sub.add_parser("pack", help="Validate and bundle a directory into a .tutorpack archive")
    p_pack.add_argument("source", type=Path, help="Pack directory containing manifest.json")
    p_pack.add_argument("-o", "--output", required=True, type=Path, help="Destination .tutorpack file")

    p_legacy = sub.add_parser("legacy-fix", help="Crop legacy 480x864 padding, scale to 576x1024, re-encode VP9")
    p_legacy.add_argument("target", type=Path, help="Pack directory (or parent packs directory with --all)")
    p_legacy.add_argument("--all", action="store_true", help="Process all tutor-* folders under target")

    p_ingest = sub.add_parser("ingest", help="Ingest owner-selected videos from 选中/ into built-in packs")
    p_ingest.add_argument("--pack", required=True, type=Path, help="Media expansion pack folder")
    p_ingest.add_argument("--tutor", default="all", help="Tutor slug(s) comma-separated, or 'all'")
    p_ingest.add_argument("--packs-root", type=Path, default=None, help="Override target packs directory")
    p_ingest.add_argument("--allow-marginal", action="store_true", help="Record warnings instead of rejecting marginal clips")

    p_stills = sub.add_parser("stills", help="Register, composite background, and export selected expression stills")
    p_stills.add_argument("--pack", required=True, type=Path, help="Media expansion pack folder")
    p_stills.add_argument("--tutor", default="all", help="Tutor slug(s) comma-separated, or 'all'")
    p_stills.add_argument("--packs-root", type=Path, default=None, help="Override target packs directory")
    p_stills.add_argument("--allow-marginal", action="store_true", help="Export even if raw shift > 9px (still aligns)")

    p_sheet = sub.add_parser("sheet", help="Generate clip 5-frame + diff and still contact sheets for review")
    p_sheet.add_argument("--tutor", default="all", help="Tutor slug(s) comma-separated, or 'all'")
    p_sheet.add_argument("--packs-root", type=Path, default=None, help="Override packs directory")
    p_sheet.add_argument("--out", type=Path, default=None, help="Override output directory (default docs/rebuild/review/UM)")

    args = parser.parse_args(argv)
    try:
        if args.command == "scaffold":
            folder = scaffold_pack(args.name, args.anchor, args.output, author=args.author, terms=args.terms)
            print(json.dumps({"ok": True, "scaffolded": str(folder)}, ensure_ascii=False))
            return 0
        if args.command == "validate":
            if args.target.is_dir():
                report = validate_directory(args.target, check_media=not args.no_media, strict_limits=args.strict)
            else:
                report = validate_archive(args.target)
            print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "pack":
            report = pack_directory(args.source, args.output)
            print(json.dumps({"ok": True, "archive": str(args.output), **report}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "legacy-fix":
            if args.all:
                results = [media_ops.legacy_fix_pack(p) for p in sorted(args.target.glob("tutor-*")) if p.is_dir()]
                print(json.dumps({"ok": True, "packs": results}, ensure_ascii=False, indent=2))
            else:
                res = media_ops.legacy_fix_pack(args.target)
                print(json.dumps({"ok": True, **res}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "ingest":
            res = media_ops.ingest_selected_videos(
                args.pack,
                _resolve_tutors_arg(args.tutor),
                packs_root=args.packs_root,
                allow_marginal=args.allow_marginal,
            )
            print(json.dumps({"ok": True, **res}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "stills":
            res = media_ops.ingest_selected_stills(
                args.pack,
                _resolve_tutors_arg(args.tutor),
                packs_root=args.packs_root,
                allow_marginal=args.allow_marginal,
            )
            print(json.dumps({"ok": True, **res}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "sheet":
            res = media_ops.generate_review_sheets(
                _resolve_tutors_arg(args.tutor),
                packs_root=args.packs_root,
                output_root=args.out,
            )
            print(json.dumps({"ok": True, "sheets": res}, ensure_ascii=False, indent=2))
            return 0
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
