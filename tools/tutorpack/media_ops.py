"""FFmpeg/NumPy/Pillow media processing operations for tools/tutorpack.

All external binaries (ffmpeg / ffprobe) are discovered via environment variables
TUTORPACK_FFMPEG / TUTORPACK_FFPROBE (falling back to PATH) and are never bundled.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "libs" / "schemas" / "tutor_media_catalog.json"
TUTORS_DATA_PATH = Path(__file__).resolve().parent / "tutors-data.json"

DEFAULT_CANVAS_W = 576
DEFAULT_CANVAS_H = 1024
DEFAULT_FPS = 24
STILL_W = 1080
STILL_H = 1920

# Spec §5 thresholds
MAX_CLIP_BYTES_BUILTIN = 1_200_000
MAX_PACK_CLIPS_BYTES_BUILTIN = 14_000_000
LOOP_MIN_SEC = 4.0
LOOP_MAX_SEC = 9.0
ONESHOT_MIN_SEC = 2.0
ONESHOT_MAX_SEC = 8.5
MAX_SEAM_MAE = 3.0
MAX_SEAM_BLOCK_MAE = 6.0
MAX_HUB_MAE = 5.0
MAX_STILL_SHIFT_PX = 9.0
END_BLEND_MAX_FRAMES = 4
MIN_STILLNESS_PAD_FRAMES = 6

_RAW_VIDEO_RE = re.compile(
    r"^(?P<num>\d{2})-(?P<slug>[a-z]+)__(?P<slot>[a-z0-9_]+)__s(?P<seed>\d+)__(?P<w>\d+)x(?P<h>\d+)(?:-[^_]+)?__p(?P<rev>[a-f0-9]+)\.(?:mp4|webm)$"
)
_RAW_STILL_RE = re.compile(
    r"^(?P<num>\d{2})-(?P<slug>[a-z]+)__(?P<job>[a-z0-9_]+)__v(?P<ver>\d+)\.(?:png|webp|jpg|jpeg)$"
)


def load_catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8-sig"))


def load_tutors_data() -> list[dict[str, Any]]:
    return json.loads(TUTORS_DATA_PATH.read_text(encoding="utf-8-sig"))


def find_binary(env_var: str, exe_name: str, *, sibling_of: str | None = None) -> str | None:
    explicit = os.environ.get(env_var, "").strip()
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return str(path)
        raise ValueError(f"{env_var} points to a non-existent file: {explicit}")
    if sibling_of:
        sib_base = Path(sibling_of).parent
        for name in (f"{exe_name}.exe", exe_name):
            cand = sib_base / name
            if cand.is_file():
                return str(cand)
    found = shutil.which(exe_name)
    if found:
        return found
    return None


def require_ffmpeg() -> str:
    ffmpeg = find_binary("TUTORPACK_FFMPEG", "ffmpeg")
    if not ffmpeg:
        raise ValueError(
            "FFmpeg executable not found. Set environment variable TUTORPACK_FFMPEG "
            "(and optionally TUTORPACK_FFPROBE) to your local FFmpeg binary path."
        )
    return ffmpeg


def find_ffprobe(ffmpeg_path: str | None = None) -> str | None:
    return find_binary("TUTORPACK_FFPROBE", "ffprobe", sibling_of=ffmpeg_path)


def probe_video(video_path: Path, *, ffprobe: str | None = None, ffmpeg: str | None = None) -> dict[str, Any] | None:
    probe_bin = ffprobe or find_ffprobe(ffmpeg)
    if not probe_bin:
        return None
    cmd = [
        probe_bin,
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-select_streams", "v:0",
        "-of", "json",
        str(video_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise ValueError(f"ffprobe failed for {video_path}: {res.stderr.strip()}")
    info = json.loads(res.stdout)

    # Also check audio streams separately
    audio_cmd = [
        probe_bin,
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_name,channels",
        "-of", "json",
        str(video_path),
    ]
    audio_res = subprocess.run(audio_cmd, capture_output=True, text=True, check=False)
    audio_streams = json.loads(audio_res.stdout).get("streams", []) if audio_res.returncode == 0 else []

    # Count keyframes via packet flags
    kf_cmd = [
        probe_bin,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=flags",
        "-of", "csv=p=0",
        str(video_path),
    ]
    kf_res = subprocess.run(kf_cmd, capture_output=True, text=True, check=False)
    keyframes = 0
    if kf_res.returncode == 0:
        keyframes = sum(1 for line in kf_res.stdout.splitlines() if "K" in line)

    vstream = (info.get("streams") or [{}])[0]
    fmt = info.get("format") or {}
    r_fps = str(vstream.get("r_frame_rate") or vstream.get("avg_frame_rate") or "0/1")
    num, _, den = r_fps.partition("/")
    fps = (float(num) / float(den)) if den and float(den) > 0 else 0.0
    duration = float(vstream.get("duration") or fmt.get("duration") or 0.0)
    return {
        "codec": str(vstream.get("codec_name") or ""),
        "profile": str(vstream.get("profile") or ""),
        "pix_fmt": str(vstream.get("pix_fmt") or ""),
        "width": int(vstream.get("width") or 0),
        "height": int(vstream.get("height") or 0),
        "fps": round(fps, 3),
        "duration_sec": round(duration, 3),
        "keyframes": keyframes,
        "audio_streams": audio_streams,
        "bytes": video_path.stat().st_size,
    }


def decode_video_frames(
    video_path: Path,
    *,
    width: int,
    height: int,
    fps: int = DEFAULT_FPS,
    ffmpeg: str,
    vf_prefix: str | None = None,
) -> np.ndarray:
    """Decode video to float32 RGB array of shape (N, H, W, 3) in [0, 255]."""
    vf_parts: list[str] = []
    if vf_prefix:
        vf_parts.append(vf_prefix)
    vf_parts.append(f"scale={width}:{height}:flags=lanczos")
    vf_parts.append(f"fps={fps}")
    cmd = [
        ffmpeg,
        "-v", "error",
        "-i", str(video_path),
        "-vf", ",".join(vf_parts),
        "-f", "rawvideo",
        "-pix_fmt", "rgb48le",
        "pipe:1",
    ]
    res = subprocess.run(cmd, capture_output=True, check=False)
    if res.returncode != 0:
        raise ValueError(f"ffmpeg decode failed for {video_path}: {res.stderr.decode('utf-8', 'ignore').strip()}")
    raw = np.frombuffer(res.stdout, dtype="<u2")
    frame_elems = width * height * 3
    n_frames = len(raw) // frame_elems
    if n_frames <= 0:
        raise ValueError(f"Decoded 0 frames from {video_path}")
    frames = raw[: n_frames * frame_elems].reshape((n_frames, height, width, 3)).astype(np.float32)
    return frames * (255.0 / 65535.0)


def load_hub_frame(anchor_or_hub: Path, width: int, height: int) -> np.ndarray:
    with Image.open(anchor_or_hub) as im:
        rgb = im.convert("RGB")
        if rgb.size != (width, height):
            rgb = rgb.resize((width, height), Image.Resampling.LANCZOS)
        return np.asarray(rgb, dtype=np.float32)


def compute_block_max_mae(frame_a: np.ndarray, frame_b: np.ndarray, block: int = 48) -> float:
    diff = np.abs(frame_a - frame_b)
    h, w, _ = diff.shape
    max_val = 0.0
    for y in range(0, h, block):
        for x in range(0, w, block):
            patch = diff[y : min(y + block, h), x : min(x + block, w)]
            val = float(patch.mean())
            if val > max_val:
                max_val = val
    return max_val


def measure_frame_metrics(frames: np.ndarray, hub: np.ndarray) -> dict[str, float]:
    first = frames[0]
    last = frames[-1]
    seam_mae = float(np.abs(last - first).mean())
    seam_block_max = compute_block_max_mae(last, first, block=48)
    hub_first_mae = float(np.abs(first - hub).mean())
    hub_last_mae = float(np.abs(last - hub).mean())
    return {
        "seam_mae": round(seam_mae, 3),
        "seam_block_max": round(seam_block_max, 3),
        "hub_first_mae": round(hub_first_mae, 3),
        "hub_last_mae": round(hub_last_mae, 3),
    }


def calibrate_color_to_hub(frames: np.ndarray, hub: np.ndarray) -> tuple[np.ndarray, bool]:
    """Per-channel linear gain+bias calibration estimated from first/last frames vs hub (float32)."""
    n = frames.shape[0]
    if n < 2:
        return frames, False
    before = 0.5 * (float(np.abs(frames[0] - hub).mean()) + float(np.abs(frames[-1] - hub).mean()))

    hub_mean = hub.reshape(-1, 3).mean(axis=0)
    hub_std = np.maximum(hub.reshape(-1, 3).std(axis=0), 1.0)

    f0_mean = frames[0].reshape(-1, 3).mean(axis=0)
    f0_std = np.maximum(frames[0].reshape(-1, 3).std(axis=0), 1.0)
    fn_mean = frames[-1].reshape(-1, 3).mean(axis=0)
    fn_std = np.maximum(frames[-1].reshape(-1, 3).std(axis=0), 1.0)

    g0 = np.clip(hub_std / f0_std, 0.90, 1.10)
    b0 = np.clip(hub_mean - g0 * f0_mean, -10.0, 10.0)
    gn = np.clip(hub_std / fn_std, 0.90, 1.10)
    bn = np.clip(hub_mean - gn * fn_mean, -10.0, 10.0)

    t = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None, None, None]
    gain = g0[None, None, None, :] * (1.0 - t) + gn[None, None, None, :] * t
    bias = b0[None, None, None, :] * (1.0 - t) + bn[None, None, None, :] * t
    calibrated = np.clip(frames * gain + bias, 0.0, 255.0)

    after = 0.5 * (float(np.abs(calibrated[0] - hub).mean()) + float(np.abs(calibrated[-1] - hub).mean()))
    if after < before - 0.05:
        return calibrated, True
    return frames, False


def trim_oneshot_and_settle(
    frames: np.ndarray,
    hub: np.ndarray,
    *,
    fps: int = DEFAULT_FPS,
) -> tuple[np.ndarray, int]:
    """Trim excess leading/trailing stillness while keeping >=6 still frames on both ends; return (frames, settle_ms)."""
    n = frames.shape[0]
    maes = np.abs(frames - hub[None, :, :, :]).mean(axis=(1, 2, 3))
    edge_window = min(8, max(1, n // 6))
    baseline = float(min(maes[:edge_window].min(), maes[-edge_window:].min()))
    peak = float(maes.max())
    threshold = max(baseline + 1.4, baseline + (peak - baseline) * 0.16)

    active = np.where(maes > threshold)[0]
    if len(active) == 0:
        duration_ms = int(round(n / fps * 1000))
        return frames, int(round(duration_ms * 0.75))

    first_act = int(active[0])
    last_act = int(active[-1])
    start = max(0, first_act - MIN_STILLNESS_PAD_FRAMES)
    end = min(n - 1, last_act + MIN_STILLNESS_PAD_FRAMES)

    min_frames = int(round(ONESHOT_MIN_SEC * fps))
    max_frames = int(round(ONESHOT_MAX_SEC * fps))
    while (end - start + 1) < min_frames and (start > 0 or end < n - 1):
        if end < n - 1:
            end += 1
        if (end - start + 1) < min_frames and start > 0:
            start -= 1
    if (end - start + 1) > max_frames:
        end = start + max_frames - 1

    trimmed = frames[start : end + 1]
    settle_idx = min(trimmed.shape[0] - 1, max(1, (last_act - start) + 3))
    settle_ms = int(round(settle_idx / fps * 1000))
    duration_ms = int(round(trimmed.shape[0] / fps * 1000))
    settle_ms = max(600, min(duration_ms, settle_ms))
    return trimmed, settle_ms


def apply_end_blend_if_needed(frames: np.ndarray, hub: np.ndarray) -> tuple[np.ndarray, bool]:
    """Apply <=4-frame cosine transition to hub at start/end ONLY when seam/hub exceeds §5 thresholds."""
    m = measure_frame_metrics(frames, hub)
    needs_blend = (
        m["seam_mae"] > MAX_SEAM_MAE
        or m["seam_block_max"] > MAX_SEAM_BLOCK_MAE
        or m["hub_first_mae"] > MAX_HUB_MAE
        or m["hub_last_mae"] > MAX_HUB_MAE
    )
    if not needs_blend or frames.shape[0] < END_BLEND_MAX_FRAMES * 2 + 2:
        return frames, False

    out = frames.copy()
    k = END_BLEND_MAX_FRAMES
    for i in range(k):
        # Cosine weight: i=0 -> 1.0 (hub), i=k-1 -> gentle transition into motion
        w = 0.5 * (1.0 + math.cos(math.pi * i / k))
        out[i] = out[i] * (1.0 - w) + hub * w
        out[-(i + 1)] = out[-(i + 1)] * (1.0 - w) + hub * w
    return out, True


def encode_frames_vp9(
    frames: np.ndarray,
    output_path: Path,
    *,
    fps: int = DEFAULT_FPS,
    ffmpeg: str,
    audio_source: Path | None = None,
    max_bytes: int = MAX_CLIP_BYTES_BUILTIN,
) -> dict[str, Any]:
    """Encode float32 RGB frames to VP9 profile 0 yuv420p single-keyframe WebM (<= max_bytes)."""
    n, h, w, _ = frames.shape
    u16 = np.clip(np.round(frames * (65535.0 / 255.0)), 0, 65535).astype("<u2")
    raw_bytes = u16.tobytes()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    used_crf = 32
    for crf in (32, 34, 36, 38, 40, 42):
        used_crf = crf
        tmp_out = output_path.with_suffix(".tmp.webm")
        cmd = [
            ffmpeg,
            "-y",
            "-v", "error",
            "-f", "rawvideo",
            "-pix_fmt", "rgb48le",
            "-s", f"{w}x{h}",
            "-r", str(fps),
            "-i", "pipe:0",
        ]
        if audio_source is not None:
            cmd.extend(["-i", str(audio_source), "-map", "0:v:0", "-map", "1:a:0?"])
        else:
            cmd.append("-an")
        cmd.extend([
            "-c:v", "libvpx-vp9",
            "-profile:v", "0",
            "-crf", str(crf),
            "-b:v", "0",
            "-g", "240",
            "-keyint_min", "240",
            "-row-mt", "1",
            "-deadline", "good",
            "-cpu-used", "1",
            "-pix_fmt", "yuv420p",
        ])
        if audio_source is not None:
            cmd.extend(["-c:a", "libopus", "-ac", "1", "-b:a", "64k"])
        cmd.append(str(tmp_out))

        res = subprocess.run(cmd, input=raw_bytes, capture_output=True, check=False)
        if res.returncode != 0:
            tmp_out.unlink(missing_ok=True)
            raise ValueError(f"ffmpeg VP9 encode failed: {res.stderr.decode('utf-8', 'ignore').strip()}")
        size = tmp_out.stat().st_size
        if size <= max_bytes or crf == 42:
            tmp_out.replace(output_path)
            return {"crf": used_crf, "bytes": size, "frames": n, "duration_ms": int(round(n / fps * 1000))}
        tmp_out.unlink(missing_ok=True)
    raise ValueError("Unexpected encode exit")


def legacy_fix_pack(
    pack_dir: Path,
    *,
    width: int = DEFAULT_CANVAS_W,
    height: int = DEFAULT_CANVAS_H,
    fps: int = DEFAULT_FPS,
) -> dict[str, Any]:
    """Crop 5px top/bottom letterbox padding from legacy 480x864 clips, rescale to 576x1024, re-encode VP9."""
    ffmpeg = require_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg)
    manifest_file = pack_dir / "manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    clips = manifest.get("clips") or {}
    before_total = 0
    after_total = 0
    details: dict[str, Any] = {}

    for slot, rel in clips.items():
        clip_path = pack_dir / rel
        if not clip_path.is_file():
            continue
        before_bytes = clip_path.stat().st_size
        before_total += before_bytes
        info = probe_video(clip_path, ffprobe=ffprobe, ffmpeg=ffmpeg) if ffprobe else None
        vf_prefix = None
        if info and info["width"] == 480 and info["height"] == 864:
            vf_prefix = "crop=480:854:0:5"
        frames = decode_video_frames(clip_path, width=width, height=height, fps=fps, ffmpeg=ffmpeg, vf_prefix=vf_prefix)
        enc = encode_frames_vp9(frames, clip_path, fps=fps, ffmpeg=ffmpeg)
        after_total += enc["bytes"]
        details[slot] = {
            "before_bytes": before_bytes,
            "after_bytes": enc["bytes"],
            "crf": enc["crf"],
            "duration_ms": enc["duration_ms"],
            "cropped_legacy_padding": vf_prefix is not None,
        }

    manifest["canvas"] = {"width": width, "height": height, "fps": fps}
    manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "pack": pack_dir.name,
        "before_total_bytes": before_total,
        "after_total_bytes": after_total,
        "clips": details,
    }


def _tutor_by_slug() -> dict[str, dict[str, Any]]:
    return {t["slug"]: t for t in load_tutors_data()}


def ingest_selected_videos(
    pack_source_root: Path,
    tutor_slugs: list[str],
    *,
    packs_root: Path | None = None,
    width: int = DEFAULT_CANVAS_W,
    height: int = DEFAULT_CANVAS_H,
    fps: int = DEFAULT_FPS,
    allow_marginal: bool = False,
) -> dict[str, Any]:
    """Ingest owner-selected MP4 clips from 02-视频提示词/回传/<num>-<slug>/选中/ into built-in packs."""
    ffmpeg = require_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg)
    catalog = load_catalog()
    clip_catalog = {c["id"]: c for c in catalog["clips"]}
    tutors_map = _tutor_by_slug()
    packs_dir = packs_root or (REPO_ROOT / "assets" / "avatars" / "packs")

    video_root = pack_source_root / "02-视频提示词"
    hub_dir = video_root / "hub"
    return_root = video_root / "回传"

    report: dict[str, Any] = {"tutors": {}}

    for slug in tutor_slugs:
        if slug not in tutors_map:
            raise ValueError(f"Unknown tutor slug: {slug}")
        tinfo = tutors_map[slug]
        folder_name = f"{tinfo['num']}-{slug}"
        selected_dir = return_root / folder_name / "选中"
        target_pack = packs_dir / tinfo["id"]
        manifest_file = target_pack / "manifest.json"
        if not manifest_file.is_file():
            raise ValueError(f"Target pack manifest not found: {manifest_file}")

        hub_cand = hub_dir / f"{folder_name}-{width}x{height}.png"
        if not hub_cand.is_file():
            hub_cand = target_pack / "anchor.webp"
        hub = load_hub_frame(hub_cand, width, height)

        if not selected_dir.is_dir():
            report["tutors"][slug] = {"ingested": {}, "rejected": {}, "missing_dir": str(selected_dir)}
            continue

        by_slot: dict[str, list[Path]] = {}
        for item in sorted(selected_dir.iterdir()):
            if not item.is_file():
                continue
            m = _RAW_VIDEO_RE.match(item.name)
            if not m:
                continue
            slot = m.group("slot")
            if slot not in clip_catalog:
                raise ValueError(f"Selected video has unknown catalog slot '{slot}': {item}")
            by_slot.setdefault(slot, []).append(item)

        duplicates = {slot: [p.name for p in paths] for slot, paths in by_slot.items() if len(paths) > 1}
        if duplicates:
            raise ValueError(
                f"Multiple selected videos found for {slug} (owner must choose one): {json.dumps(duplicates, ensure_ascii=False)}"
            )

        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        clips_map: dict[str, str] = dict(manifest.get("clips") or {})
        clip_meta: dict[str, dict[str, Any]] = dict(manifest.get("clip_meta") or {})
        ingested_report: dict[str, Any] = {}
        rejected_report: dict[str, Any] = {}

        for slot, paths in sorted(by_slot.items()):
            src = paths[0]
            entry = clip_catalog[slot]
            is_oneshot = entry["kind"] == "one_shot"
            allow_audio = bool(entry.get("allow_audio"))

            frames = decode_video_frames(src, width=width, height=height, fps=fps, ffmpeg=ffmpeg)
            frames, color_calibrated = calibrate_color_to_hub(frames, hub)

            settle_ms: int | None = None
            if is_oneshot:
                frames, settle_ms = trim_oneshot_and_settle(frames, hub, fps=fps)

            pre_metrics = measure_frame_metrics(frames, hub)
            frames, end_blended = apply_end_blend_if_needed(frames, hub)

            out_rel = f"clips/{slot}.webm"
            out_path = target_pack / out_rel
            with tempfile.TemporaryDirectory() as tmpd:
                stage_path = Path(tmpd) / f"{slot}.webm"
                enc = encode_frames_vp9(
                    frames,
                    stage_path,
                    fps=fps,
                    ffmpeg=ffmpeg,
                    audio_source=src if allow_audio else None,
                )
                # Verify encoded clip metrics against §5
                decoded_back = decode_video_frames(stage_path, width=width, height=height, fps=fps, ffmpeg=ffmpeg)
                final_metrics = measure_frame_metrics(decoded_back, hub)
                probe = probe_video(stage_path, ffprobe=ffprobe, ffmpeg=ffmpeg)
                duration_sec = probe["duration_sec"] if probe else round(enc["duration_ms"] / 1000.0, 3)

                failures: list[str] = []
                if enc["bytes"] > MAX_CLIP_BYTES_BUILTIN:
                    failures.append(f"size {enc['bytes']} > {MAX_CLIP_BYTES_BUILTIN}")
                if is_oneshot:
                    if not (ONESHOT_MIN_SEC <= duration_sec <= ONESHOT_MAX_SEC):
                        failures.append(f"one-shot duration {duration_sec}s outside {ONESHOT_MIN_SEC}..{ONESHOT_MAX_SEC}s")
                else:
                    if not (LOOP_MIN_SEC <= duration_sec <= LOOP_MAX_SEC):
                        failures.append(f"loop duration {duration_sec}s outside {LOOP_MIN_SEC}..{LOOP_MAX_SEC}s")
                if final_metrics["seam_mae"] > MAX_SEAM_MAE:
                    failures.append(f"seam_mae {final_metrics['seam_mae']} > {MAX_SEAM_MAE}")
                if final_metrics["seam_block_max"] > MAX_SEAM_BLOCK_MAE:
                    failures.append(f"seam_block_max {final_metrics['seam_block_max']} > {MAX_SEAM_BLOCK_MAE}")
                if final_metrics["hub_first_mae"] > MAX_HUB_MAE or final_metrics["hub_last_mae"] > MAX_HUB_MAE:
                    failures.append(
                        f"hub_mae ({final_metrics['hub_first_mae']}, {final_metrics['hub_last_mae']}) > {MAX_HUB_MAE}"
                    )
                if probe and probe["keyframes"] > 1:
                    failures.append(f"keyframes {probe['keyframes']} > 1")

                record = {
                    "source": src.name,
                    "bytes": enc["bytes"],
                    "crf": enc["crf"],
                    "duration_sec": duration_sec,
                    "duration_ms": enc["duration_ms"],
                    "settle_ms": settle_ms,
                    "color_calibrated": color_calibrated,
                    "end_blended": end_blended,
                    "pre_metrics": pre_metrics,
                    "final_metrics": final_metrics,
                    "keyframes": probe["keyframes"] if probe else None,
                }

                if failures and not allow_marginal:
                    rejected_report[slot] = {**record, "reasons": failures}
                    continue

                out_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(stage_path, out_path)
                clips_map[slot] = out_rel
                meta_entry: dict[str, Any] = {"duration_ms": enc["duration_ms"]}
                if settle_ms is not None:
                    meta_entry["settle_ms"] = settle_ms
                clip_meta[slot] = meta_entry
                if failures:
                    record["warnings"] = failures
                ingested_report[slot] = record

        manifest["canvas"] = {"width": width, "height": height, "fps": fps}
        manifest["clips"] = clips_map
        manifest["clip_meta"] = clip_meta
        manifest["media"] = {
            "generator": "OpenAI Images 2.6 + MiniMax H3-Base (FL2VA)",
            "ai_generated": True,
            "image_generator": "OpenAI Images 2.6",
            "video_generator": "MiniMax H3-Base (FL2VA, local ComfyUI)",
        }
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        total_clip_bytes = sum(
            (target_pack / rel).stat().st_size for rel in clips_map.values() if (target_pack / rel).is_file()
        )
        report["tutors"][slug] = {
            "pack": tinfo["id"],
            "total_clip_bytes": total_clip_bytes,
            "total_clips": len(clips_map),
            "ingested_count": len(ingested_report),
            "rejected_count": len(rejected_report),
            "ingested": ingested_report,
            "rejected": rejected_report,
        }

    return report


def _sobel_edges(gray: np.ndarray) -> np.ndarray:
    gx = (
        -gray[:-2, :-2] + gray[:-2, 2:]
        - 2.0 * gray[1:-1, :-2] + 2.0 * gray[1:-1, 2:]
        - gray[2:, :-2] + gray[2:, 2:]
    )
    gy = (
        -gray[:-2, :-2] - 2.0 * gray[:-2, 1:-1] - gray[:-2, 2:]
        + gray[2:, :-2] + 2.0 * gray[2:, 1:-1] + gray[2:, 2:]
    )
    return np.hypot(gx, gy)


def estimate_head_shift(anchor_rgb: np.ndarray, cand_rgb: np.ndarray, head_box: list[float]) -> tuple[float, float]:
    """Phase correlation on Sobel edge maps inside head_box; returns (dx, dy) candidate shift relative to anchor."""
    h, w, _ = anchor_rgb.shape
    x1, y1, x2, y2 = (
        int(round(head_box[0] * w)),
        int(round(head_box[1] * h)),
        int(round(head_box[2] * w)),
        int(round(head_box[3] * h)),
    )
    a_gray = anchor_rgb[y1:y2, x1:x2].mean(axis=2)
    c_gray = cand_rgb[y1:y2, x1:x2].mean(axis=2)

    ea = _sobel_edges(a_gray)
    ec = _sobel_edges(c_gray)
    wy = np.hanning(ea.shape[0])[:, None]
    wx = np.hanning(ea.shape[1])[None, :]
    win = wy * wx

    fa = np.fft.fft2(ea * win)
    fc = np.fft.fft2(ec * win)
    cross = fa * np.conj(fc)
    denom = np.abs(cross) + 1e-8
    corr = np.fft.ifft2(cross / denom).real

    peak_y, peak_x = np.unravel_index(np.argmax(corr), corr.shape)
    ch, cw = corr.shape

    def _subpixel(vals: np.ndarray, idx: int, size: int) -> float:
        l_val = vals[(idx - 1) % size]
        c_val = vals[idx]
        r_val = vals[(idx + 1) % size]
        d = l_val - 2.0 * c_val + r_val
        offset = 0.5 * (l_val - r_val) / d if abs(d) > 1e-9 else 0.0
        offset = max(-0.5, min(0.5, float(offset)))
        pos = idx + offset
        if pos > size / 2:
            pos -= size
        return pos

    # peak gives shift of anchor relative to candidate -> negate for candidate displacement
    dy = -_subpixel(corr[:, peak_x], int(peak_y), ch)
    dx = -_subpixel(corr[peak_y, :], int(peak_x), cw)
    return round(dx, 2), round(dy, 2)


def align_and_composite_still(
    anchor_im: Image.Image,
    cand_im: Image.Image,
    head_box: list[float],
    landmarks: dict[str, float],
) -> tuple[Image.Image, float, float]:
    """Resize candidate to 1080x1920, align via head-box edge phase correlation, and stabilize outer background."""
    anchor = anchor_im.convert("RGB")
    if anchor.size != (STILL_W, STILL_H):
        anchor = anchor.resize((STILL_W, STILL_H), Image.Resampling.LANCZOS)
    cand = cand_im.convert("RGB")
    if cand.size != (STILL_W, STILL_H):
        cand = cand.resize((STILL_W, STILL_H), Image.Resampling.LANCZOS)

    a_arr = np.asarray(anchor, dtype=np.float32)
    c_arr = np.asarray(cand, dtype=np.float32)
    dx, dy = estimate_head_shift(a_arr, c_arr, head_box)

    # Shift candidate by (-dx, -dy) to register onto anchor
    shifted = cand.transform(
        (STILL_W, STILL_H),
        Image.Transform.AFFINE,
        (1.0, 0.0, dx, 0.0, 1.0, dy),
        resample=Image.Resampling.BICUBIC,
    )
    s_arr = np.asarray(shifted, dtype=np.float32)

    # Fill any uncovered shift border pixels from anchor
    valid_mask = np.ones((STILL_H, STILL_W), dtype=np.float32)
    pad_l = max(0, int(math.ceil(-dx)))
    pad_r = max(0, int(math.ceil(dx)))
    pad_t = max(0, int(math.ceil(-dy)))
    pad_b = max(0, int(math.ceil(dy)))
    if pad_l:
        valid_mask[:, :pad_l] = 0.0
    if pad_r:
        valid_mask[:, STILL_W - pad_r :] = 0.0
    if pad_t:
        valid_mask[:pad_t, :] = 0.0
    if pad_b:
        valid_mask[STILL_H - pad_b :, :] = 0.0

    # Safe outer static background mask: above crown and far side margins where subject/hands do not enter.
    # Also gated by pixel similarity so hair tips/ribbons/hands are NEVER clipped.
    yy, xx = np.mgrid[0:STILL_H, 0:STILL_W]
    yn = yy / float(STILL_H)
    xn = xx / float(STILL_W)
    crown_y = float(landmarks.get("crownY", 0.15))

    # Elliptical subject protect zone covering head, hair, shoulders, torso, and lower hand area
    cx = 0.5
    cy = 0.58
    rx = 0.40
    ry = max(0.45, cy - (crown_y - 0.03))
    dist = np.hypot((xn - cx) / rx, (yn - cy) / ry)
    outer_zone = np.clip((dist - 1.0) / 0.16, 0.0, 1.0)

    # Pixel diff gate: if candidate differs strongly (>26), keep candidate (protects raised hands/hair/accessories)
    diff = np.abs(s_arr - a_arr).mean(axis=2)
    sim_gate = np.clip((26.0 - diff) / 14.0, 0.0, 1.0)

    # Anchor weight: 1 on shift-border margins, soft feathered in outer static background
    bg_weight = np.maximum(1.0 - valid_mask, outer_zone * sim_gate)
    # Feather mask smoothly with Pillow GaussianBlur
    mask_im = Image.fromarray(np.clip(bg_weight * 255.0, 0, 255).astype(np.uint8), mode="L").filter(
        ImageFilter.GaussianBlur(radius=6)
    )
    w_arr = (np.asarray(mask_im, dtype=np.float32) / 255.0)[:, :, None]

    blended = np.clip(s_arr * (1.0 - w_arr) + a_arr * w_arr, 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(blended, mode="RGB"), dx, dy


def ingest_selected_stills(
    pack_source_root: Path,
    tutor_slugs: list[str],
    *,
    packs_root: Path | None = None,
    allow_marginal: bool = False,
) -> dict[str, Any]:
    """Process owner-selected expression stills from 01-图片提示词/回传/<num>-<slug>/选中/."""
    catalog = load_catalog()
    valid_stills = set(catalog["stills"])
    tutors_map = _tutor_by_slug()
    packs_dir = packs_root or (REPO_ROOT / "assets" / "avatars" / "packs")

    img_root = pack_source_root / "01-图片提示词"
    return_root = img_root / "回传"

    report: dict[str, Any] = {"tutors": {}}

    for slug in tutor_slugs:
        if slug not in tutors_map:
            raise ValueError(f"Unknown tutor slug: {slug}")
        tinfo = tutors_map[slug]
        folder_name = f"{tinfo['num']}-{slug}"
        selected_dir = return_root / folder_name / "选中"
        target_pack = packs_dir / tinfo["id"]
        manifest_file = target_pack / "manifest.json"
        if not manifest_file.is_file():
            raise ValueError(f"Target pack manifest not found: {manifest_file}")

        anchor_src = img_root / f"{folder_name}-anchor-1080x1920.png"
        if not anchor_src.is_file():
            anchor_src = target_pack / "anchor.webp"
        anchor_im = Image.open(anchor_src)

        if not selected_dir.is_dir():
            report["tutors"][slug] = {"ingested": {}, "rejected": {}, "ignored": [], "missing_dir": str(selected_dir)}
            continue

        by_still: dict[str, list[Path]] = {}
        ignored: list[str] = []
        for item in sorted(selected_dir.iterdir()):
            if not item.is_file():
                continue
            m = _RAW_STILL_RE.match(item.name)
            if not m:
                ignored.append(item.name)
                continue
            job = m.group("job")
            if job.startswith("expr_"):
                key = job.removeprefix("expr_")
                if key in valid_stills:
                    by_still.setdefault(key, []).append(item)
                    continue
            ignored.append(item.name)

        duplicates = {k: [p.name for p in ps] for k, ps in by_still.items() if len(ps) > 1}
        if duplicates:
            raise ValueError(
                f"Multiple selected stills found for {slug}: {json.dumps(duplicates, ensure_ascii=False)}"
            )

        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        stills_map: dict[str, str] = dict(manifest.get("stills") or {})
        stills_dir = target_pack / "stills"
        stills_dir.mkdir(parents=True, exist_ok=True)

        ingested: dict[str, Any] = {}
        rejected: dict[str, Any] = {}

        for still_key, paths in sorted(by_still.items()):
            src = paths[0]
            with Image.open(src) as cand_im:
                out_im, dx, dy = align_and_composite_still(
                    anchor_im, cand_im, tinfo["headBox"], tinfo["landmarks"]
                )
            shift_ok = abs(dx) <= MAX_STILL_SHIFT_PX and abs(dy) <= MAX_STILL_SHIFT_PX
            # Re-verify residual shift after alignment
            res_dx, res_dy = estimate_head_shift(
                np.asarray(anchor_im.convert("RGB").resize((STILL_W, STILL_H), Image.Resampling.LANCZOS), dtype=np.float32),
                np.asarray(out_im, dtype=np.float32),
                tinfo["headBox"],
            )
            entry = {
                "source": src.name,
                "raw_shift_px": [dx, dy],
                "aligned_residual_px": [res_dx, res_dy],
                "within_9px": shift_ok,
            }
            if not shift_ok and not allow_marginal:
                rejected[still_key] = {**entry, "reason": f"raw shift ({dx}, {dy}) exceeds ±{MAX_STILL_SHIFT_PX}px"}
                continue

            out_rel = f"stills/{still_key}.webp"
            out_path = target_pack / out_rel
            out_im.save(out_path, format="WEBP", quality=90, method=4)
            entry["bytes"] = out_path.stat().st_size
            stills_map[still_key] = out_rel
            ingested[still_key] = entry

        anchor_im.close()
        manifest["stills"] = stills_map
        if "media" not in manifest or not isinstance(manifest.get("media"), dict):
            manifest["media"] = {
                "generator": "OpenAI Images 2.6 + MiniMax H3-Base (FL2VA)",
                "ai_generated": True,
                "image_generator": "OpenAI Images 2.6",
                "video_generator": "MiniMax H3-Base (FL2VA, local ComfyUI)",
            }
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        report["tutors"][slug] = {
            "pack": tinfo["id"],
            "ingested_count": len(ingested),
            "rejected_count": len(rejected),
            "ignored_non_expr": ignored,
            "crops": tinfo["crops"],
            "ingested": ingested,
            "rejected": rejected,
        }

    return report


def generate_review_sheets(
    tutor_slugs: list[str],
    *,
    packs_root: Path | None = None,
    output_root: Path | None = None,
) -> dict[str, Any]:
    """Generate clip 5-frame + start/end diff contact sheets and stills comparison sheets in docs/rebuild/review/UM/."""
    ffmpeg = require_ffmpeg()
    tutors_map = _tutor_by_slug()
    packs_dir = packs_root or (REPO_ROOT / "assets" / "avatars" / "packs")
    out_dir = output_root or (REPO_ROOT / "docs" / "rebuild" / "review" / "UM")
    out_dir.mkdir(parents=True, exist_ok=True)

    outputs: dict[str, Any] = {}
    for slug in tutor_slugs:
        tinfo = tutors_map[slug]
        pack_dir = packs_dir / tinfo["id"]
        manifest = json.loads((pack_dir / "manifest.json").read_text(encoding="utf-8-sig"))
        tutor_out = out_dir / slug
        tutor_out.mkdir(parents=True, exist_ok=True)

        canvas_info = manifest.get("canvas") or {"width": DEFAULT_CANVAS_W, "height": DEFAULT_CANVAS_H, "fps": DEFAULT_FPS}
        cw, ch, cfps = int(canvas_info["width"]), int(canvas_info["height"]), int(canvas_info.get("fps", DEFAULT_FPS))
        hub = load_hub_frame(pack_dir / manifest.get("anchor", "anchor.webp"), cw, ch)

        # 1. Clips contact sheet (first, 25%, 50%, 75%, last + 8x amplified diff map)
        clips = manifest.get("clips") or {}
        clip_meta = manifest.get("clip_meta") or {}
        thumb_w, thumb_h = 180, 320
        header_h = 28
        cols = 6
        if clips:
            rows = len(clips)
            sheet = Image.new("RGB", (thumb_w * cols, (thumb_h + header_h) * rows), (18, 22, 28))
            draw = ImageDraw.Draw(sheet)
            for r_idx, (slot, rel) in enumerate(sorted(clips.items())):
                clip_path = pack_dir / rel
                if not clip_path.is_file():
                    continue
                frames = decode_video_frames(clip_path, width=cw, height=ch, fps=cfps, ffmpeg=ffmpeg)
                n = frames.shape[0]
                picks = [0, n // 4, n // 2, (3 * n) // 4, n - 1]
                metrics = measure_frame_metrics(frames, hub)
                y0 = r_idx * (thumb_h + header_h)
                meta = clip_meta.get(slot) or {}
                settle_str = f" settle={meta['settle_ms']}ms" if "settle_ms" in meta else ""
                kb = clip_path.stat().st_size / 1024.0
                label = (
                    f"{slot} | {n / cfps:.2f}s | {kb:.0f}KB | "
                    f"seam={metrics['seam_mae']:.2f} blk={metrics['seam_block_max']:.2f} "
                    f"hub=({metrics['hub_first_mae']:.2f},{metrics['hub_last_mae']:.2f}){settle_str}"
                )
                draw.text((8, y0 + 6), label, fill=(240, 244, 248))
                for c_idx, f_idx in enumerate(picks):
                    im = Image.fromarray(np.clip(frames[f_idx], 0, 255).astype(np.uint8), mode="RGB").resize(
                        (thumb_w, thumb_h), Image.Resampling.LANCZOS
                    )
                    sheet.paste(im, (c_idx * thumb_w, y0 + header_h))
                # Column 6: 8x amplified |last - first| difference map
                diff_vis = np.clip(np.abs(frames[-1] - frames[0]) * 8.0, 0, 255).astype(np.uint8)
                diff_im = Image.fromarray(diff_vis, mode="RGB").resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
                sheet.paste(diff_im, (5 * thumb_w, y0 + header_h))

            clips_sheet_path = tutor_out / "clips-sheet.jpg"
            sheet.save(clips_sheet_path, quality=88)
        else:
            clips_sheet_path = None

        # 2. Stills contact sheet (anchor + all stills)
        stills = manifest.get("stills") or {}
        st_w, st_h = 216, 384
        items = [("anchor", manifest.get("anchor", "anchor.webp"))] + sorted(stills.items())
        st_sheet = Image.new("RGB", (st_w * len(items), st_h + header_h), (18, 22, 28))
        st_draw = ImageDraw.Draw(st_sheet)
        for idx, (label, rel) in enumerate(items):
            p = pack_dir / rel
            if not p.is_file():
                continue
            with Image.open(p) as im:
                thumb = im.convert("RGB").resize((st_w, st_h), Image.Resampling.LANCZOS)
                st_sheet.paste(thumb, (idx * st_w, header_h))
            st_draw.text((idx * st_w + 8, 6), label, fill=(240, 244, 248))
        stills_sheet_path = tutor_out / "stills-sheet.jpg"
        st_sheet.save(stills_sheet_path, quality=90)

        outputs[slug] = {
            "clips_sheet": str(clips_sheet_path) if clips_sheet_path else None,
            "stills_sheet": str(stills_sheet_path),
        }
    return outputs


def sync_builtin_licenses(avatars_root: Path | None = None) -> dict[str, Any]:
    """Update the 6 built-in pack manifests' license/media fields and regenerate assets/avatars/LICENSES.md."""
    assets = avatars_root or (REPO_ROOT / "assets" / "avatars")
    tutors_map = {t["id"]: t for t in load_tutors_data()}
    slug_name = {t["slug"]: t["name"] for t in load_tutors_data()}

    # 1. Update each built-in pack manifest's license & media fields to real provenance
    packs_updated = 0
    for pack_dir in sorted((assets / "packs").glob("tutor-*")):
        manifest_file = pack_dir / "manifest.json"
        if not manifest_file.is_file():
            continue
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        has_clips = bool(manifest.get("clips"))
        manifest["media"] = {
            "generator": (
                "OpenAI Images 2.6 + MiniMax H3-Base (FL2VA)" if has_clips else "OpenAI Images 2.6"
            ),
            "ai_generated": True,
            "image_generator": "OpenAI Images 2.6",
            "video_generator": "MiniMax H3-Base (FL2VA, local ComfyUI)" if has_clips else None,
        }
        manifest["license"] = {
            "author": "Companion Space (AI-generated)",
            "terms": (
                "Images: OpenAI Images 2.6 (Apache-2.0); Video clips: MiniMax H3 Community License (regional restrictions apply)"
                if has_clips
                else "OpenAI Images 2.6 (Apache-2.0)"
            ),
            "license_url": (
                "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE" if has_clips else None
            ),
            "allow_redistribution": not has_clips,
        }
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        packs_updated += 1

    # 2. Scan all active media files under assets/avatars and write LICENSES.md
    asset_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4", ".wav"}
    all_files = sorted(
        p.relative_to(assets).as_posix()
        for p in assets.rglob("*")
        if p.is_file() and p.suffix.lower() in asset_suffixes
    )

    lines = [
        "# Avatar asset licenses",
        "",
        "This directory is outside the source-code Apache-2.0 license grant. Each",
        "asset follows the generator and license terms recorded below. See [Third-party notices](../THIRD_PARTY_NOTICES.md)",
        "for full provenance and regional restriction notes.",
        "",
        "3D VRM sample models were retired on 2026-11-19 and archived under",
        "`assets-archive/retired-vrm/`. Legacy v0.x/v1 portraits were retired on",
        "2026-11-20 and archived under `assets-archive/retired-portraits/`.",
        "",
        "| File | Generator | Source and author | License and redistribution |",
        "| --- | --- | --- | --- |",
    ]

    for rel in all_files:
        parts = rel.split("/")
        if parts[0] == "portraits":
            slug = Path(rel).stem
            zh = slug_name.get(slug, slug)
            lines.append(
                f"| `{rel}` | OpenAI Images 2.6 (AI-generated) | Companion Space original anime anchor portrait ({zh}). | Apache-2.0 (`allow_redistribution: true`; disclose AI-generated). |"
            )
        elif parts[0] == "backgrounds":
            lines.append(
                f"| `{rel}` | OpenAI image generation (AI-generated) | Companion Space original observatory background. | Apache-2.0 (`allow_redistribution: true`; disclose AI-generated). |"
            )
        elif parts[0] == "voices":
            slug = Path(rel).stem.replace("-ref-24k", "")
            zh = slug_name.get(slug, slug)
            lines.append(
                f"| `{rel}` | MiniMax H3-Base (AI-generated, regional restrictions) | Companion Space 24kHz dry voice reference ({zh}); must not train/fine-tune AI models. | MiniMax H3 Community License (`allow_redistribution: false`; EU/UK/KR/US excluded). |"
            )
        elif parts[0] == "packs" and len(parts) >= 3:
            tid = parts[1]
            tinfo = tutors_map.get(tid)
            zh = tinfo["name"] if tinfo else tid
            if parts[2] == "anchor.webp":
                lines.append(
                    f"| `{rel}` | OpenAI Images 2.6 (AI-generated) | Companion Space original anchor portrait ({zh} / {tid}). | Apache-2.0 (`allow_redistribution: true`; disclose AI-generated). |"
                )
            elif parts[2] == "stills" and len(parts) == 4:
                still_key = Path(parts[3]).stem
                lines.append(
                    f"| `{rel}` | OpenAI Images 2.6 (AI-generated) | Companion Space expression still ({zh} / `{still_key}`), registered to anchor. | Apache-2.0 (`allow_redistribution: true`; disclose AI-generated). |"
                )
            elif parts[2] == "clips" and len(parts) == 4:
                slot = Path(parts[3]).stem
                lines.append(
                    f"| `{rel}` | MiniMax H3-Base FL2VA (AI-generated, regional restrictions) | Companion Space silent VP9 motion clip ({zh} / `{slot}`). | MiniMax H3 Community License (`allow_redistribution: false`; EU/UK/KR/US excluded). |"
                )
            else:
                lines.append(
                    f"| `{rel}` | Companion Space | Pack asset ({zh}). | See pack manifest (`allow_redistribution: false`). |"
                )
        else:
            lines.append(
                f"| `{rel}` | Companion Space | Avatar asset. | See THIRD_PARTY_NOTICES.md (`allow_redistribution: false`). |"
            )

    (assets / "LICENSES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"packs_updated": packs_updated, "assets_registered": len(all_files)}

