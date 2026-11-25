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
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
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

# Adaptive pack-budget VP9 encoding parameters
DEFAULT_START_CRF = 32
MAX_ENCODE_CRF = 54
VP9_CRF_DECAY_PER_STEP = 0.895
OPUS_MONO_BITRATE_BPS = 64_000

# Frequency-tiered CRF offsets (only applied when pack exceeds MAX_PACK_CLIPS_BYTES_BUILTIN):
# 0 = highest-frequency classroom loops preserve top visual quality;
# +2 = regular classroom loops & primary gestures;
# +4 = infrequent inserts, secondary reactions & optional clips yield bitrate first.
HIGH_FREQ_SLOTS = frozenset({
    "idle_breathe",
    "speak_calm",
    "speak_explain_a",
    "speak_explain_b",
    "listen_nod",
    "wait_gentle",
})
MEDIUM_FREQ_SLOTS = frozenset({
    "idle_glance",
    "listen_tilt",
    "think_gaze",
    "think_chin",
    "prepare_notes",
    "read_answer",
    "speak_board",
    "greet_wave",
    "farewell_wave",
    "react_praise",
    "react_comfort",
})


def clip_crf_priority_offset(slot: str) -> int:
    """Return tiered CRF offset for pack-budget compression (0 = highest quality priority)."""
    if slot in HIGH_FREQ_SLOTS:
        return 0
    if slot in MEDIUM_FREQ_SLOTS:
        return 2
    return 4


@dataclass
class BudgetClipEntry:
    slot: str
    current_crf: int
    current_bytes: int
    audio_bytes_est: int = 0
    priority_offset: int = 0
    crf_cap: int = MAX_ENCODE_CRF


def estimate_audio_bytes(duration_sec: float, *, bitrate_bps: int = OPUS_MONO_BITRATE_BPS) -> int:
    """Rough fixed Opus audio + container overhead in bytes so VP9 scaling only applies to video bytes."""
    if duration_sec <= 0:
        return 0
    return int(round(duration_sec * (bitrate_bps / 8.0)))


def _predict_entry_bytes(entry: BudgetClipEntry, target_crf: int, decay_per_crf: float) -> float:
    delta = target_crf - entry.current_crf
    if delta <= 0:
        return float(entry.current_bytes)
    video_bytes = max(1.0, float(entry.current_bytes - entry.audio_bytes_est))
    return float(entry.audio_bytes_est) + video_bytes * (decay_per_crf**delta)


def plan_pack_budget_crfs(
    entries: list[BudgetClipEntry],
    *,
    pack_budget: int = MAX_PACK_CLIPS_BYTES_BUILTIN,
    fixed_bytes: int = 0,
    start_crf: int = DEFAULT_START_CRF,
    max_crf: int = MAX_ENCODE_CRF,
    decay_per_crf: float = VP9_CRF_DECAY_PER_STEP,
    headroom_ratio: float = 0.975,
) -> dict[str, int]:
    """Compute minimal per-slot CRF upgrades to bring pack total within pack_budget while prioritizing core loops.

    Returns a mapping ``{slot: target_crf}`` containing ONLY slots whose CRF should increase.
    """
    if pack_budget <= 0 or not entries:
        return {}
    available = pack_budget - fixed_bytes
    current_total = sum(e.current_bytes for e in entries)
    if current_total <= available:
        return {}
    if available <= 0:
        return {
            e.slot: min(max_crf, e.crf_cap)
            for e in entries
            if min(max_crf, e.crf_cap) > e.current_crf
        }

    # Target slightly under available bytes so empirical pass-2 converges cleanly in one pass.
    est_target = max(1.0, float(available) * headroom_ratio)

    def _assignment_for_base(base_crf: int) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in entries:
            cap = min(max_crf, e.crf_cap)
            cand = max(e.current_crf, min(cap, base_crf + e.priority_offset))
            out[e.slot] = cand
        return out

    def _predicted_total(assignment: dict[str, int]) -> float:
        return sum(_predict_entry_bytes(e, assignment[e.slot], decay_per_crf) for e in entries)

    by_slot = {e.slot: e for e in entries}
    min_base = start_crf - 4
    chosen_base = max_crf
    for base in range(min_base, max_crf + 1):
        if _predicted_total(_assignment_for_base(base)) <= est_target:
            chosen_base = base
            break

    # Fine-grained trim: step back one base level and bump lowest-priority / largest clips one-by-one
    # so we do not needlessly raise CRF on high-priority Tier-1 loops when only a few clips need +1.
    if chosen_base > min_base:
        prev_assign = _assignment_for_base(chosen_base - 1)
        if _predicted_total(prev_assign) > est_target:
            assign = dict(prev_assign)
            bump_order = sorted(
                entries,
                key=lambda e: (assign[e.slot] - e.priority_offset, -e.priority_offset, -e.current_bytes, e.slot),
            )
            for e in bump_order:
                cap = min(max_crf, e.crf_cap)
                if assign[e.slot] < cap:
                    assign[e.slot] += 1
                    if _predicted_total(assign) <= est_target:
                        break
            if _predicted_total(assign) > est_target:
                assign = _assignment_for_base(chosen_base)
        else:
            assign = prev_assign
    else:
        assign = _assignment_for_base(chosen_base)

    # If still above target because priority_offset left headroom on unlocked clips, keep bumping greedily.
    while _predicted_total(assign) > est_target:
        candidates = [
            e
            for e in entries
            if assign[e.slot] < min(max_crf, e.crf_cap)
        ]
        if not candidates:
            break
        candidates.sort(
            key=lambda e: (
                assign[e.slot] - e.priority_offset,
                -e.priority_offset,
                -_predict_entry_bytes(e, assign[e.slot], decay_per_crf),
                e.slot,
            )
        )
        pick = candidates[0]
        assign[pick.slot] += 1

    return {
        slot: crf
        for slot, crf in assign.items()
        if crf > by_slot[slot].current_crf
    }

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
        "-an",
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
    frames *= 255.0 / 65535.0
    return frames


def decode_edge_frames(
    video_path: Path,
    *,
    width: int,
    height: int,
    fps: int = DEFAULT_FPS,
    ffmpeg: str,
) -> np.ndarray:
    """Decode only the first and last frames of an 8-bit video as float32 (2, H, W, 3) for fast seam/hub checks."""
    cmd = [
        ffmpeg,
        "-v", "error",
        "-i", str(video_path),
        "-an",
        "-vf", f"scale={width}:{height}:flags=lanczos,fps={fps}",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1",
    ]
    res = subprocess.run(cmd, capture_output=True, check=False)
    if res.returncode != 0:
        raise ValueError(f"ffmpeg decode failed for {video_path}: {res.stderr.decode('utf-8', 'ignore').strip()}")
    frame_bytes = width * height * 3
    n_frames = len(res.stdout) // frame_bytes
    if n_frames <= 0:
        raise ValueError(f"Decoded 0 frames from {video_path}")
    first = np.frombuffer(res.stdout, dtype=np.uint8, count=frame_bytes, offset=0).reshape((height, width, 3))
    last_off = (n_frames - 1) * frame_bytes
    last = np.frombuffer(res.stdout, dtype=np.uint8, count=frame_bytes, offset=last_off).reshape((height, width, 3))
    return np.stack((first.astype(np.float32), last.astype(np.float32)), axis=0)


def decode_sampled_frames(
    video_path: Path,
    *,
    width: int,
    height: int,
    fps: int = DEFAULT_FPS,
    ffmpeg: str,
) -> tuple[int, np.ndarray]:
    """Decode 5 evenly-spaced frames (0%, 25%, 50%, 75%, 100%) as float32 (5, H, W, 3); return (total_frames, samples)."""
    cmd = [
        ffmpeg,
        "-v", "error",
        "-i", str(video_path),
        "-an",
        "-vf", f"scale={width}:{height}:flags=lanczos,fps={fps}",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1",
    ]
    res = subprocess.run(cmd, capture_output=True, check=False)
    if res.returncode != 0:
        raise ValueError(f"ffmpeg decode failed for {video_path}: {res.stderr.decode('utf-8', 'ignore').strip()}")
    frame_bytes = width * height * 3
    n_frames = len(res.stdout) // frame_bytes
    if n_frames <= 0:
        raise ValueError(f"Decoded 0 frames from {video_path}")
    picks = [0, n_frames // 4, n_frames // 2, (3 * n_frames) // 4, n_frames - 1]
    samples = np.stack(
        [
            np.frombuffer(res.stdout, dtype=np.uint8, count=frame_bytes, offset=idx * frame_bytes)
            .reshape((height, width, 3))
            .astype(np.float32)
            for idx in picks
        ],
        axis=0,
    )
    return n_frames, samples


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


def extract_audio_frame_rms(
    video_path: Path,
    *,
    fps: int = DEFAULT_FPS,
    n_frames: int,
    ffmpeg: str,
) -> np.ndarray | None:
    """Extract mono audio RMS aligned to video frames (shape: (n_frames,)). Returns None if no audio track."""
    if n_frames <= 0:
        return None
    sample_rate = fps * 1000
    cmd = [
        ffmpeg,
        "-v", "error",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "f32le",
        "pipe:1",
    ]
    res = subprocess.run(cmd, capture_output=True, check=False)
    if res.returncode != 0 or not res.stdout:
        return None
    samples = np.frombuffer(res.stdout, dtype="<f4")
    spf = 1000
    avail_frames = len(samples) // spf
    if avail_frames <= 0:
        return None
    rms_raw = np.sqrt(np.mean(samples[: avail_frames * spf].reshape((avail_frames, spf)) ** 2, axis=1))
    out = np.zeros(n_frames, dtype=np.float32)
    take = min(n_frames, avail_frames)
    out[:take] = rms_raw[:take]
    return out


def compute_oneshot_trim_bounds(
    frames: np.ndarray,
    hub: np.ndarray,
    *,
    fps: int = DEFAULT_FPS,
    audio_rms: np.ndarray | None = None,
) -> tuple[int, int, int]:
    """Return (start_frame, end_frame_inclusive, settle_ms) preserving >=6 still frames and any active audio."""
    n = frames.shape[0]
    maes = np.abs(frames - hub[None, :, :, :]).mean(axis=(1, 2, 3))
    edge_window = min(8, max(1, n // 6))
    baseline = float(min(maes[:edge_window].min(), maes[-edge_window:].min()))
    peak = float(maes.max())
    threshold = max(baseline + 1.4, baseline + (peak - baseline) * 0.16)

    vis_active = np.where(maes > threshold)[0]
    aud_active = np.array([], dtype=np.int64)
    if audio_rms is not None and len(audio_rms) == n:
        aud_peak = float(audio_rms.max())
        if aud_peak > 0.005:
            aud_thresh = max(0.008, aud_peak * 0.05)
            aud_active = np.where(audio_rms > aud_thresh)[0]

    if len(vis_active) == 0 and len(aud_active) == 0:
        duration_ms = int(round(n / fps * 1000))
        return 0, n - 1, int(round(duration_ms * 0.75))

    starts: list[int] = []
    ends: list[int] = []
    if len(vis_active) > 0:
        starts.append(int(vis_active[0]))
        ends.append(int(vis_active[-1]))
    if len(aud_active) > 0:
        starts.append(int(aud_active[0]))
        ends.append(int(aud_active[-1]))

    first_act = min(starts)
    last_act = max(ends)
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

    trimmed_len = end - start + 1
    settle_idx = min(trimmed_len - 1, max(1, (last_act - start) + 3))
    settle_ms = int(round(settle_idx / fps * 1000))
    duration_ms = int(round(trimmed_len / fps * 1000))
    settle_ms = max(600, min(duration_ms, settle_ms))
    return start, end, settle_ms


def trim_oneshot_and_settle(
    frames: np.ndarray,
    hub: np.ndarray,
    *,
    fps: int = DEFAULT_FPS,
    audio_rms: np.ndarray | None = None,
) -> tuple[np.ndarray, int]:
    """Trim excess leading/trailing stillness while keeping >=6 still frames on both ends; return (frames, settle_ms)."""
    start, end, settle_ms = compute_oneshot_trim_bounds(frames, hub, fps=fps, audio_rms=audio_rms)
    return frames[start : end + 1], settle_ms


def apply_end_blend_if_needed(
    frames: np.ndarray,
    hub: np.ndarray,
    *,
    force: bool = False,
) -> tuple[np.ndarray, bool]:
    """Apply <=4-frame cosine transition to hub at start/end ONLY when seam/hub exceeds §5 thresholds (or force=True)."""
    if not force:
        m = measure_frame_metrics(frames, hub)
        needs_blend = (
            m["seam_mae"] > MAX_SEAM_MAE
            or m["seam_block_max"] > MAX_SEAM_BLOCK_MAE
            or m["hub_first_mae"] > MAX_HUB_MAE
            or m["hub_last_mae"] > MAX_HUB_MAE
        )
    else:
        needs_blend = True
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
    audio_start_sec: float = 0.0,
    audio_duration_sec: float | None = None,
    max_bytes: int = MAX_CLIP_BYTES_BUILTIN,
    start_crf: int = DEFAULT_START_CRF,
    max_crf: int = MAX_ENCODE_CRF,
    crf_step: int = 2,
    fixed_crf: int | None = None,
    threads: int | None = None,
) -> dict[str, Any]:
    """Encode float32 RGB frames to VP9 profile 0 yuv420p single-keyframe WebM (<= max_bytes)."""
    n, h, w, _ = frames.shape
    u16 = np.clip(np.round(frames * (65535.0 / 255.0)), 0, 65535).astype("<u2")
    raw_bytes = memoryview(u16).cast("B")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    kf_dist = max(240, n + 10)
    if fixed_crf is not None:
        crfs = [fixed_crf]
        if fixed_crf < max_crf:
            crfs.extend(range(fixed_crf + max(1, crf_step), max_crf + 1, max(1, crf_step)))
            if crfs[-1] != max_crf:
                crfs.append(max_crf)
    else:
        step = max(1, crf_step)
        crfs = list(range(start_crf, max_crf + 1, step))
        if not crfs:
            crfs = [start_crf]
        elif crfs[-1] != max_crf:
            crfs.append(max_crf)

    video_dur = audio_duration_sec if audio_duration_sec is not None else (n / float(fps))

    for idx, crf in enumerate(crfs):
        is_last = idx == len(crfs) - 1
        tmp_out = output_path.with_name(f"{output_path.stem}.crf{crf}.tmp.webm")
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
            "-g", str(kf_dist),
            "-keyint_min", str(kf_dist),
            "-row-mt", "1",
            "-deadline", "good",
            "-cpu-used", "1",
            "-pix_fmt", "yuv420p",
        ])
        if threads is not None and threads > 0:
            cmd.extend(["-threads", str(threads)])
        if audio_source is not None:
            fade_d = min(0.015, video_dur * 0.1)
            af_parts = [
                f"atrim=start={max(0.0, audio_start_sec):.6f}:duration={video_dur:.6f}",
                "asetpts=PTS-STARTPTS",
            ]
            if audio_start_sec > 0.001 and fade_d > 0.001:
                af_parts.append(f"afade=t=in:st=0:d={fade_d:.4f}")
            if video_dur > fade_d * 2 and fade_d > 0.001:
                af_parts.append(f"afade=t=out:st={max(0.0, video_dur - fade_d):.6f}:d={fade_d:.4f}")
            cmd.extend([
                "-af", ",".join(af_parts),
                "-c:a", "libopus",
                "-ac", "1",
                "-b:a", "64k",
                "-shortest",
            ])
        cmd.append(str(tmp_out))

        res = subprocess.run(cmd, input=raw_bytes, capture_output=True, check=False)
        if res.returncode != 0:
            tmp_out.unlink(missing_ok=True)
            raise ValueError(f"ffmpeg VP9 encode failed: {res.stderr.decode('utf-8', 'ignore').strip()}")
        size = tmp_out.stat().st_size
        if size <= max_bytes or is_last:
            tmp_out.replace(output_path)
            return {"crf": crf, "bytes": size, "frames": n, "duration_ms": int(round(n / fps * 1000))}
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


def _verify_encoded_clip(
    stage_path: Path,
    *,
    width: int,
    height: int,
    fps: int,
    ffmpeg: str,
    ffprobe: str | None,
    hub: np.ndarray,
    anchor_hub: np.ndarray | None,
    enc: dict[str, Any],
    is_oneshot: bool,
    allow_audio: bool,
    max_clip_bytes: int = MAX_CLIP_BYTES_BUILTIN,
) -> tuple[dict[str, float], dict[str, float], dict[str, Any] | None, float, list[str]]:
    """Decode & probe staged WebM and return (hub_metrics, anchor_metrics, probe, duration_sec, failures)."""
    edge_frames = decode_edge_frames(stage_path, width=width, height=height, fps=fps, ffmpeg=ffmpeg)
    final_metrics = measure_frame_metrics(edge_frames, hub)
    anchor_metrics = measure_frame_metrics(edge_frames, anchor_hub) if anchor_hub is not None else dict(final_metrics)
    probe = probe_video(stage_path, ffprobe=ffprobe, ffmpeg=ffmpeg)
    duration_sec = probe["duration_sec"] if probe else round(enc["duration_ms"] / 1000.0, 3)

    failures: list[str] = []
    if enc["bytes"] > max_clip_bytes:
        failures.append(f"size {enc['bytes']} > {max_clip_bytes}")
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
    if anchor_hub is not None and (
        anchor_metrics["hub_first_mae"] > MAX_HUB_MAE or anchor_metrics["hub_last_mae"] > MAX_HUB_MAE
    ):
        failures.append(
            f"anchor_hub_mae ({anchor_metrics['hub_first_mae']}, {anchor_metrics['hub_last_mae']}) > {MAX_HUB_MAE}"
        )
    if probe:
        if probe["codec"] != "vp9":
            failures.append(f"codec {probe['codec']} != vp9")
        if "0" not in probe["profile"]:
            failures.append(f"profile {probe['profile']} != Profile 0")
        if probe["pix_fmt"] != "yuv420p":
            failures.append(f"pix_fmt {probe['pix_fmt']} != yuv420p")
        if probe["keyframes"] != 1:
            failures.append(f"keyframes {probe['keyframes']} != 1")
        if not allow_audio and probe["audio_streams"]:
            failures.append("unexpected audio stream")
        elif allow_audio and probe["audio_streams"]:
            if len(probe["audio_streams"]) != 1:
                failures.append(f"expected 1 audio stream, got {len(probe['audio_streams'])}")
            else:
                astream = probe["audio_streams"][0]
                if astream.get("codec_name") != "opus" or int(astream.get("channels") or 0) != 1:
                    failures.append(
                        f"audio must be opus mono, got {astream.get('codec_name')}/{astream.get('channels')}ch"
                    )
    return final_metrics, anchor_metrics, probe, duration_sec, failures


def _preprocess_selected_clip(
    src: Path,
    *,
    width: int,
    height: int,
    fps: int,
    ffmpeg: str,
    hub: np.ndarray,
    is_oneshot: bool,
    allow_audio: bool,
    trim_bounds: tuple[int, int, int] | None = None,
    force_end_blend: bool = False,
) -> dict[str, Any]:
    """Decode raw clip, apply color calibration, audio-aware one-shot trim, and conditional end blend."""
    frames = decode_video_frames(src, width=width, height=height, fps=fps, ffmpeg=ffmpeg)
    frames, color_calibrated = calibrate_color_to_hub(frames, hub)

    audio_rms: np.ndarray | None = None
    has_audio_track = False
    if allow_audio:
        audio_rms = extract_audio_frame_rms(src, fps=fps, n_frames=frames.shape[0], ffmpeg=ffmpeg)
        has_audio_track = audio_rms is not None

    settle_ms: int | None = None
    start_frame = 0
    end_frame = frames.shape[0] - 1
    if is_oneshot:
        if trim_bounds is not None:
            start_frame, end_frame, settle_ms = trim_bounds
        else:
            start_frame, end_frame, settle_ms = compute_oneshot_trim_bounds(
                frames, hub, fps=fps, audio_rms=audio_rms
            )
        frames = frames[start_frame : end_frame + 1]

    pre_metrics = measure_frame_metrics(frames, hub)
    frames, end_blended = apply_end_blend_if_needed(frames, hub, force=force_end_blend)
    return {
        "frames": frames,
        "color_calibrated": color_calibrated,
        "end_blended": end_blended,
        "pre_metrics": pre_metrics,
        "settle_ms": settle_ms,
        "start_frame": start_frame,
        "end_frame": end_frame,
        "has_audio_track": has_audio_track,
    }


def ingest_selected_videos(
    pack_source_root: Path,
    tutor_slugs: list[str],
    *,
    packs_root: Path | None = None,
    width: int = DEFAULT_CANVAS_W,
    height: int = DEFAULT_CANVAS_H,
    fps: int = DEFAULT_FPS,
    allow_marginal: bool = False,
    pack_budget: int = MAX_PACK_CLIPS_BYTES_BUILTIN,
    start_crf: int = DEFAULT_START_CRF,
    max_crf: int = MAX_ENCODE_CRF,
    workers: int = 0,
) -> dict[str, Any]:
    """Ingest owner-selected MP4 clips from 02-视频提示词/回传/<num>-<slug>/选中/ into built-in packs.

    When total pack clip bytes exceed ``pack_budget`` (default 14,000,000 B), adaptively re-encodes
    from original raw MP4 sources in ``选中/`` with frequency-tiered VP9 CRFs (preserving 576x1024 @ 24fps
    single-keyframe profile 0 and never re-encoding lossy .webm files) until within budget.
    """
    ffmpeg = require_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg)
    catalog = load_catalog()
    clip_catalog = {c["id"]: c for c in catalog["clips"]}
    tutors_map = _tutor_by_slug()
    packs_dir = packs_root or (REPO_ROOT / "assets" / "avatars" / "packs")

    cpu_count = os.cpu_count() or 2
    effective_workers = workers if workers > 0 else min(4, max(1, cpu_count // 4))
    ffmpeg_threads = max(2, min(4, cpu_count // effective_workers)) if effective_workers > 1 else None

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

        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        anchor_file = target_pack / str(manifest.get("anchor") or "anchor.webp")
        anchor_hub = load_hub_frame(anchor_file, width, height) if anchor_file.is_file() else None

        hub_cand = hub_dir / f"{folder_name}-{width}x{height}.png"
        if hub_cand.is_file():
            hub = load_hub_frame(hub_cand, width, height)
            compare_anchor_hub = anchor_hub
        else:
            hub = anchor_hub if anchor_hub is not None else load_hub_frame(target_pack / "anchor.webp", width, height)
            compare_anchor_hub = None

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

        clips_map: dict[str, str] = dict(manifest.get("clips") or {})
        clip_meta: dict[str, dict[str, Any]] = dict(manifest.get("clip_meta") or {})
        ingested_report: dict[str, Any] = {}
        rejected_report: dict[str, Any] = {}

        with tempfile.TemporaryDirectory() as tmpd:
            stage_root = Path(tmpd)
            staged_info: dict[str, dict[str, Any]] = {}

            def _encode_one(
                slot: str,
                src: Path,
                *,
                fixed_crf: int | None = None,
                trim_bounds: tuple[int, int, int] | None = None,
                stage_name: str | None = None,
                force_end_blend: bool = False,
            ) -> tuple[str, dict[str, Any]]:
                entry = clip_catalog[slot]
                is_oneshot = entry["kind"] == "one_shot"
                allow_audio = bool(entry.get("allow_audio"))
                prep = _preprocess_selected_clip(
                    src,
                    width=width,
                    height=height,
                    fps=fps,
                    ffmpeg=ffmpeg,
                    hub=hub,
                    is_oneshot=is_oneshot,
                    allow_audio=allow_audio,
                    trim_bounds=trim_bounds,
                    force_end_blend=force_end_blend,
                )
                frames = prep["frames"]
                audio_src = src if (allow_audio and prep["has_audio_track"]) else None
                audio_start = prep["start_frame"] / float(fps)
                audio_dur = frames.shape[0] / float(fps)

                out_file = stage_root / (stage_name or f"{slot}.webm")
                enc = encode_frames_vp9(
                    frames,
                    out_file,
                    fps=fps,
                    ffmpeg=ffmpeg,
                    audio_source=audio_src,
                    audio_start_sec=audio_start,
                    audio_duration_sec=audio_dur,
                    start_crf=start_crf,
                    max_crf=max_crf,
                    fixed_crf=fixed_crf,
                    threads=ffmpeg_threads,
                )
                final_metrics, anchor_metrics, probe, duration_sec, failures = _verify_encoded_clip(
                    out_file,
                    width=width,
                    height=height,
                    fps=fps,
                    ffmpeg=ffmpeg,
                    ffprobe=ffprobe,
                    hub=hub,
                    anchor_hub=compare_anchor_hub,
                    enc=enc,
                    is_oneshot=is_oneshot,
                    allow_audio=allow_audio,
                )
                # If VP9 quantization pushed an unblended borderline clip slightly over §5 seam/hub thresholds,
                # retry once with the spec-sanctioned <=4-frame cosine transition to hub.
                if (
                    not prep["end_blended"]
                    and not force_end_blend
                    and any(
                        reason.startswith(("seam_mae", "seam_block_max", "hub_mae", "anchor_hub_mae"))
                        for reason in failures
                    )
                ):
                    return _encode_one(
                        slot,
                        src,
                        fixed_crf=fixed_crf,
                        trim_bounds=(prep["start_frame"], prep["end_frame"], prep["settle_ms"])
                        if prep["settle_ms"] is not None
                        else trim_bounds,
                        stage_name=stage_name,
                        force_end_blend=True,
                    )
                record = {
                    "source": src.name,
                    "bytes": enc["bytes"],
                    "crf": enc["crf"],
                    "duration_sec": duration_sec,
                    "duration_ms": enc["duration_ms"],
                    "settle_ms": prep["settle_ms"],
                    "color_calibrated": prep["color_calibrated"],
                    "end_blended": prep["end_blended"],
                    "has_audio": bool(probe["audio_streams"]) if probe else (audio_src is not None),
                    "pre_metrics": prep["pre_metrics"],
                    "final_metrics": final_metrics,
                    "anchor_metrics": anchor_metrics,
                    "keyframes": probe["keyframes"] if probe else None,
                }
                return slot, {
                    "slot": slot,
                    "src": src,
                    "stage_path": out_file,
                    "record": record,
                    "failures": failures,
                    "trim_bounds": (prep["start_frame"], prep["end_frame"], prep["settle_ms"])
                    if prep["settle_ms"] is not None
                    else None,
                    "end_blended": prep["end_blended"],
                    "has_audio_track": prep["has_audio_track"],
                    "allow_audio": allow_audio,
                }

            # Stage 1: initial encode of all selected clips from raw MP4 sources
            ordered_items = [(slot, paths[0]) for slot, paths in sorted(by_slot.items())]
            if effective_workers > 1 and len(ordered_items) > 1:
                with ThreadPoolExecutor(max_workers=min(effective_workers, len(ordered_items))) as pool:
                    pass1_results = dict(pool.map(lambda item: _encode_one(item[0], item[1]), ordered_items))
            else:
                pass1_results = dict(_encode_one(slot, src) for slot, src in ordered_items)

            for slot, _src in ordered_items:
                res = pass1_results[slot]
                if res["failures"] and not allow_marginal:
                    rejected_report[slot] = {**res["record"], "reasons": res["failures"]}
                    continue
                staged_info[slot] = res

            # Compute bytes contributed by untouched existing clips in target_pack (not replaced by staged_info)
            non_selected_bytes = sum(
                (target_pack / rel).stat().st_size
                for existing_slot, rel in clips_map.items()
                if existing_slot not in staged_info and (target_pack / rel).is_file()
            )
            pass1_staged_bytes = sum(info["record"]["bytes"] for info in staged_info.values())
            pass1_total_bytes = non_selected_bytes + pass1_staged_bytes

            # Stage 2: adaptive pack-level budget fitting (re-encodes ONLY from raw MP4 sources in 选中/)
            budget_iterations = 0
            budget_reencoded_slots: set[str] = set()
            budget_warning: str | None = None

            if pack_budget > 0 and staged_info and pass1_total_bytes > pack_budget:
                budget_entries: dict[str, BudgetClipEntry] = {
                    slot: BudgetClipEntry(
                        slot=slot,
                        current_crf=int(info["record"]["crf"]),
                        current_bytes=int(info["record"]["bytes"]),
                        audio_bytes_est=estimate_audio_bytes(info["record"]["duration_sec"])
                        if info["record"]["has_audio"]
                        else 0,
                        priority_offset=clip_crf_priority_offset(slot),
                        crf_cap=max_crf,
                    )
                    for slot, info in staged_info.items()
                }
                empirical_decay = VP9_CRF_DECAY_PER_STEP
                decay_samples: list[float] = []

                for iteration in range(1, 7):
                    current_total = non_selected_bytes + sum(e.current_bytes for e in budget_entries.values())
                    if current_total <= pack_budget:
                        break
                    ratio_over = current_total / float(pack_budget)
                    headroom = 0.975 if iteration == 1 else (0.992 if ratio_over <= 1.08 else 0.982)
                    plan = plan_pack_budget_crfs(
                        list(budget_entries.values()),
                        pack_budget=pack_budget,
                        fixed_bytes=non_selected_bytes,
                        start_crf=start_crf,
                        max_crf=max_crf,
                        decay_per_crf=empirical_decay,
                        headroom_ratio=headroom,
                    )
                    if not plan:
                        break
                    budget_iterations = iteration

                    reencode_jobs = [
                        (
                            slot,
                            staged_info[slot]["src"],
                            target_crf,
                            staged_info[slot]["trim_bounds"],
                            staged_info[slot]["end_blended"],
                        )
                        for slot, target_crf in sorted(plan.items())
                    ]
                    if effective_workers > 1 and len(reencode_jobs) > 1:
                        with ThreadPoolExecutor(max_workers=min(effective_workers, len(reencode_jobs))) as pool:
                            reencode_results = dict(
                                pool.map(
                                    lambda job: _encode_one(
                                        job[0],
                                        job[1],
                                        fixed_crf=job[2],
                                        trim_bounds=job[3],
                                        stage_name=f"{job[0]}.iter{iteration}.webm",
                                        force_end_blend=job[4],
                                    ),
                                    reencode_jobs,
                                )
                            )
                    else:
                        reencode_results = dict(
                            _encode_one(
                                job[0],
                                job[1],
                                fixed_crf=job[2],
                                trim_bounds=job[3],
                                stage_name=f"{job[0]}.iter{iteration}.webm",
                                force_end_blend=job[4],
                            )
                            for job in reencode_jobs
                        )

                    any_progress = False
                    for slot, _src, target_crf, _bounds, _blended in reencode_jobs:
                        cand = reencode_results[slot]
                        entry = budget_entries[slot]
                        prev_crf = entry.current_crf
                        prev_bytes = entry.current_bytes
                        if cand["failures"] and not allow_marginal:
                            # Raising CRF broke §5 metrics (e.g. anchor_hub_mae > 5.0); lock this slot at prior CRF
                            cand["stage_path"].unlink(missing_ok=True)
                            entry.crf_cap = prev_crf
                            continue
                        new_crf = int(cand["record"]["crf"])
                        new_bytes = int(cand["record"]["bytes"])
                        if new_bytes < prev_bytes:
                            # Calibrate empirical VP9 decay factor for any follow-up refinement
                            delta = new_crf - prev_crf
                            prev_v = max(1, prev_bytes - entry.audio_bytes_est)
                            new_v = max(1, new_bytes - entry.audio_bytes_est)
                            if delta > 0 and 0 < new_v < prev_v:
                                ratio = (new_v / float(prev_v)) ** (1.0 / delta)
                                if 0.78 <= ratio <= 0.97:
                                    decay_samples.append(ratio)
                            old_stage = staged_info[slot]["stage_path"]
                            if old_stage != cand["stage_path"]:
                                old_stage.unlink(missing_ok=True)
                            staged_info[slot] = cand
                            entry.current_crf = new_crf
                            entry.current_bytes = new_bytes
                            budget_reencoded_slots.add(slot)
                            any_progress = True
                        else:
                            cand["stage_path"].unlink(missing_ok=True)
                            entry.crf_cap = prev_crf

                    if decay_samples:
                        empirical_decay = float(np.median(decay_samples))
                    if not any_progress:
                        break

            final_staged_bytes = sum(info["record"]["bytes"] for info in staged_info.values())
            final_total_bytes = non_selected_bytes + final_staged_bytes
            if pack_budget > 0 and final_total_bytes > pack_budget:
                msg = (
                    f"{tinfo['id']}: total clip bytes {final_total_bytes} exceeds pack budget {pack_budget} "
                    f"(selected={final_staged_bytes}, non_selected={non_selected_bytes}, max_crf={max_crf})"
                )
                if not allow_marginal:
                    raise ValueError(msg)
                budget_warning = msg

            # Commit accepted staged clips atomically to target_pack
            for slot in sorted(staged_info.keys()):
                info = staged_info[slot]
                record = dict(info["record"])
                out_rel = f"clips/{slot}.webm"
                out_path = target_pack / out_rel
                out_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(info["stage_path"], out_path)
                clips_map[slot] = out_rel
                meta_entry: dict[str, Any] = {"duration_ms": record["duration_ms"]}
                if record["settle_ms"] is not None:
                    meta_entry["settle_ms"] = record["settle_ms"]
                clip_meta[slot] = meta_entry
                if info["failures"]:
                    record["warnings"] = info["failures"]
                record["reencoded_for_budget"] = slot in budget_reencoded_slots
                ingested_report[slot] = record

        manifest["canvas"] = {"width": width, "height": height, "fps": fps}
        manifest["clips"] = clips_map
        manifest["clip_meta"] = dict(sorted(clip_meta.items()))
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
        tutor_summary: dict[str, Any] = {
            "pack": tinfo["id"],
            "total_clip_bytes": total_clip_bytes,
            "total_clips": len(clips_map),
            "ingested_count": len(ingested_report),
            "rejected_count": len(rejected_report),
            "budget": {
                "pack_budget_bytes": pack_budget,
                "non_selected_clip_bytes": non_selected_bytes,
                "pass1_total_clip_bytes": pass1_total_bytes,
                "final_total_clip_bytes": total_clip_bytes,
                "reencoded_for_budget": len(budget_reencoded_slots),
                "iterations": budget_iterations,
                "within_budget": (pack_budget <= 0) or (total_clip_bytes <= pack_budget),
            },
            "ingested": ingested_report,
            "rejected": rejected_report,
        }
        if budget_warning:
            tutor_summary["budget_warning"] = budget_warning
        report["tutors"][slug] = tutor_summary

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
                n, sampled = decode_sampled_frames(clip_path, width=cw, height=ch, fps=cfps, ffmpeg=ffmpeg)
                metrics = measure_frame_metrics(sampled, hub)
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
                for c_idx in range(5):
                    im = Image.fromarray(np.clip(sampled[c_idx], 0, 255).astype(np.uint8), mode="RGB").resize(
                        (thumb_w, thumb_h), Image.Resampling.LANCZOS
                    )
                    sheet.paste(im, (c_idx * thumb_w, y0 + header_h))
                # Column 6: 8x amplified |last - first| difference map
                diff_vis = np.clip(np.abs(sampled[-1] - sampled[0]) * 8.0, 0, 255).astype(np.uint8)
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
    audio_slots = {c["id"] for c in load_catalog()["clips"] if c.get("allow_audio")}

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
                clip_desc = (
                    f"Companion Space VP9+Opus motion clip ({zh} / `{slot}`)."
                    if slot in audio_slots
                    else f"Companion Space silent VP9 motion clip ({zh} / `{slot}`)."
                )
                lines.append(
                    f"| `{rel}` | MiniMax H3-Base FL2VA (AI-generated, regional restrictions) | {clip_desc} | MiniMax H3 Community License (`allow_redistribution: false`; EU/UK/KR/US excluded). |"
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

