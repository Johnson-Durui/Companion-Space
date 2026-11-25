"""Unit and FFmpeg integration tests for tools/tutorpack adaptive 14MB budget, intro_voice, and 27-slot ingest."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

import cli as tutorpack_cli  # noqa: E402
import media_ops  # noqa: E402


def _ffmpeg_pair() -> tuple[str | None, str | None]:
    ff = media_ops.find_binary("TUTORPACK_FFMPEG", "ffmpeg")
    fp = media_ops.find_ffprobe(ff) if ff else None
    return ff, fp


def _make_textured_anchor(width: int = 576, height: int = 1024, seed: int = 7) -> np.ndarray:
    """Create a deterministic, realistic-complexity RGB image with smooth gradients + fine detail."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    base = np.zeros((height, width, 3), dtype=np.float32)
    base[:, :, 0] = 150.0 + 45.0 * np.sin(xx / 45.0) + 25.0 * np.cos(yy / 70.0)
    base[:, :, 1] = 130.0 + 40.0 * np.cos(xx / 55.0) + 30.0 * np.sin(yy / 60.0)
    base[:, :, 2] = 175.0 + 35.0 * np.sin((xx + yy) / 80.0)
    # Add deterministic mid-frequency texture patch (character region)
    patch = rng.normal(0.0, 14.0, size=(height // 2, width // 2, 3)).astype(np.float32)
    base[height // 4 : height // 4 + height // 2, width // 4 : width // 4 + width // 2] += patch
    return np.clip(base, 12.0, 243.0)


def _write_synthetic_mp4(
    out_path: Path,
    *,
    hub: np.ndarray,
    ffmpeg: str,
    n_frames: int,
    fps: int = 24,
    motion_range: tuple[int, int] = (18, 72),
    motion_amp: float = 35.0,
    noise_sigma: float = 0.0,
    audio_range_sec: tuple[float, float] | None = None,
) -> None:
    """Write a synthetic H.264 (+ optional stereo AAC) 576x1024 MP4 starting and ending at hub."""
    h, w, _ = hub.shape
    rng = np.random.default_rng(int(n_frames * 13 + motion_amp))
    frames = np.repeat(hub[None, :, :, :], n_frames, axis=0)
    m0, m1 = motion_range
    for i in range(max(1, m0), min(n_frames - 1, m1)):
        phase = np.sin(np.pi * (i - m0) / max(1, (m1 - m0)))
        # Visible moving textured bar in central character region (deterministic spatial motion, fast VP9 encode)
        y_off = int(round(48 * phase))
        x_off = int(round(28 * np.sin(2.0 * np.pi * (i - m0) / max(1, (m1 - m0)))))
        y1 = max(0, h // 3 + y_off)
        y2 = min(h, h // 3 + 220 + y_off)
        x1 = max(0, w // 4 + x_off)
        x2 = min(w, 3 * w // 4 + x_off)
        stripe = np.sin(np.arange(y2 - y1, dtype=np.float32)[:, None] * 0.45 + i * 0.35)
        frames[i, y1:y2, x1:x2, 0] = np.clip(frames[i, y1:y2, x1:x2, 0] + motion_amp * phase + 18.0 * stripe, 0, 255)
        frames[i, y1:y2, x1:x2, 2] = np.clip(frames[i, y1:y2, x1:x2, 2] - motion_amp * 0.7 * phase - 14.0 * stripe, 0, 255)
        if noise_sigma > 0:
            frames[i] = np.clip(frames[i] + rng.normal(0.0, noise_sigma, size=(h, w, 3)), 0, 255)

    raw_u8 = np.clip(np.round(frames), 0, 255).astype(np.uint8).tobytes()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dur = n_frames / float(fps)

    cmd = [
        ffmpeg,
        "-y",
        "-v", "error",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{w}x{h}",
        "-r", str(fps),
        "-i", "pipe:0",
    ]
    if audio_range_sec is not None:
        a0, a1 = audio_range_sec
        expr = f"0.35*sin(2*PI*440*t)*between(t,{a0:.3f},{a1:.3f})"
        cmd.extend([
            "-f", "lavfi",
            "-i", f"aevalsrc='{expr}|{expr}':s=32000:d={dur:.4f}",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:a", "aac",
            "-ac", "2",
            "-b:a", "128k",
        ])
    else:
        cmd.append("-an")
    cmd.extend([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        str(out_path),
    ])
    res = subprocess.run(cmd, input=raw_u8, capture_output=True, check=False)
    assert res.returncode == 0, res.stderr.decode("utf-8", "ignore")


def _scaffold_temp_tutor_pack(packs_root: Path, pack_source: Path, *, slug: str = "lanyue", hub: np.ndarray) -> Path:
    tinfo = next(t for t in media_ops.load_tutors_data() if t["slug"] == slug)
    folder = f"{tinfo['num']}-{slug}"
    pack_dir = packs_root / tinfo["id"]
    (pack_dir / "clips").mkdir(parents=True, exist_ok=True)
    (pack_dir / "stills").mkdir(parents=True, exist_ok=True)

    anchor_im = Image.fromarray(np.clip(np.round(hub), 0, 255).astype(np.uint8), mode="RGB")
    anchor_im.resize((1080, 1920), Image.Resampling.LANCZOS).save(pack_dir / "anchor.webp", format="WEBP", quality=92)
    hub_dir = pack_source / "02-视频提示词" / "hub"
    hub_dir.mkdir(parents=True, exist_ok=True)
    anchor_im.save(hub_dir / f"{folder}-576x1024.png", format="PNG")

    manifest = {
        "schema_version": 1,
        "name": tinfo["name"],
        "aspect_ratio": "9:16",
        "crossfade_ms": 180,
        "canvas": {"width": 576, "height": 1024, "fps": 24},
        "anchor": "anchor.webp",
        "clips": {},
        "clip_meta": {},
        "stills": {},
        "license": {
            "author": "Companion Space (AI-generated)",
            "terms": "MiniMax H3 Community License",
            "license_url": None,
            "allow_redistribution": False,
        },
    }
    (pack_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (pack_source / "02-视频提示词" / "回传" / folder / "选中").mkdir(parents=True, exist_ok=True)
    return pack_dir


def test_plan_pack_budget_crfs_under_budget_noop() -> None:
    entries = [
        media_ops.BudgetClipEntry("idle_breathe", 32, 900_000, priority_offset=0),
        media_ops.BudgetClipEntry("idle_fidget", 32, 800_000, priority_offset=4),
    ]
    assert media_ops.plan_pack_budget_crfs(entries, pack_budget=14_000_000) == {}


def test_plan_pack_budget_crfs_tiered_priority_and_locked_caps() -> None:
    # 27 clips averaging ~900 KB at CRF 32 (~24.3 MB total) -> must compress into 14 MB prioritizing Tier 1.
    catalog = media_ops.load_catalog()
    active_slots = [c["id"] for c in catalog["clips"] if not c.get("reserved")]
    assert len(active_slots) == 27

    entries = [
        media_ops.BudgetClipEntry(
            slot=slot,
            current_crf=32,
            current_bytes=900_000,
            audio_bytes_est=48_000 if slot == "intro_voice" else 0,
            priority_offset=media_ops.clip_crf_priority_offset(slot),
        )
        for slot in active_slots
    ]
    plan = media_ops.plan_pack_budget_crfs(entries, pack_budget=14_000_000)
    assert plan
    # High-frequency core loops strictly preserve lower (higher quality) CRF than Tier-3 rare slots.
    assert plan["idle_breathe"] < plan["idle_fidget"]
    assert plan["speak_calm"] < plan["nod_yes"]
    assert plan["speak_explain_a"] <= plan["greet_wave"] <= plan["react_clap"]

    # Simulated bytes under plan must be <= 14 MB
    predicted = sum(
        media_ops._predict_entry_bytes(e, plan.get(e.slot, e.current_crf), media_ops.VP9_CRF_DECAY_PER_STEP)
        for e in entries
    )
    assert predicted <= 14_000_000

    # If a slot is capped at CRF 34 (e.g. hub_mae ceiling), remaining savings shift to unlocked slots.
    capped_entries = [
        media_ops.BudgetClipEntry(
            slot=e.slot,
            current_crf=32,
            current_bytes=900_000,
            priority_offset=e.priority_offset,
            crf_cap=34 if e.slot == "idle_fidget" else 54,
        )
        for e in entries
    ]
    capped_plan = media_ops.plan_pack_budget_crfs(capped_entries, pack_budget=14_000_000)
    assert capped_plan["idle_fidget"] <= 34
    predicted_capped = sum(
        media_ops._predict_entry_bytes(e, capped_plan.get(e.slot, e.current_crf), media_ops.VP9_CRF_DECAY_PER_STEP)
        for e in capped_entries
    )
    assert predicted_capped <= 14_000_000


def test_plan_pack_budget_crfs_accounts_for_fixed_non_selected_bytes() -> None:
    entries = [
        media_ops.BudgetClipEntry("idle_breathe", 32, 700_000, priority_offset=0),
        media_ops.BudgetClipEntry("nod_yes", 32, 700_000, priority_offset=4),
    ]
    # 1.4 MB selected + 13.0 MB untouched existing clips = 14.4 MB > 14.0 MB
    plan = media_ops.plan_pack_budget_crfs(entries, pack_budget=14_000_000, fixed_bytes=13_000_000)
    assert plan
    # Only the Tier-3 clip (or mostly Tier-3) should absorb the small 400 KB excess
    assert plan.get("nod_yes", 32) > plan.get("idle_breathe", 32)


def test_compute_oneshot_trim_bounds_preserves_audio_beyond_visual_motion() -> None:
    n = 192  # 8.0s @ 24fps
    hub = np.full((16, 16, 3), 100.0, dtype=np.float32)
    frames = np.repeat(hub[None, :, :, :], n, axis=0)
    # Visual motion only in frames 30..80 (1.25s..3.33s)
    frames[30:81] = 140.0
    # Speech audio active in frames 48..144 (2.0s..6.0s)
    audio_rms = np.zeros(n, dtype=np.float32)
    audio_rms[48:145] = 0.12

    vis_start, vis_end, _ = media_ops.compute_oneshot_trim_bounds(frames, hub, fps=24, audio_rms=None)
    aud_start, aud_end, settle_ms = media_ops.compute_oneshot_trim_bounds(frames, hub, fps=24, audio_rms=audio_rms)

    assert vis_end < 100
    assert aud_start == vis_start  # Starts at visual motion (30 - 6 = 24)
    assert aud_end >= 144 + media_ops.MIN_STILLNESS_PAD_FRAMES  # Preserves full audio tail + pad!
    assert settle_ms >= int(round((144 - aud_start) / 24.0 * 1000))


def test_apply_end_blend_if_needed_force_flag() -> None:
    hub = np.full((16, 16, 3), 100.0, dtype=np.float32)
    frames = np.repeat(hub[None, :, :, :], 20, axis=0)
    frames[0] = 102.0  # Within thresholds (seam_mae=2.0 <= 3.0, hub_mae=2.0 <= 5.0)
    out_auto, blended_auto = media_ops.apply_end_blend_if_needed(frames, hub, force=False)
    assert blended_auto is False
    assert float(out_auto[0].mean()) == 102.0

    out_forced, blended_forced = media_ops.apply_end_blend_if_needed(frames, hub, force=True)
    assert blended_forced is True
    assert float(out_forced[0].mean()) == 100.0
    assert float(out_forced[-1].mean()) == 100.0


@pytest.mark.skipif(not _ffmpeg_pair()[0] or not _ffmpeg_pair()[1], reason="External FFmpeg/ffprobe not configured")
def test_intro_voice_audio_sync_strict_validation_and_licenses(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _ffmpeg_pair()
    assert ffmpeg and ffprobe
    hub = _make_textured_anchor(seed=11)
    packs_root = tmp_path / "avatars" / "packs"
    pack_source = tmp_path / "expansion"
    pack_dir = _scaffold_temp_tutor_pack(packs_root, pack_source, slug="lanyue", hub=hub)
    selected_dir = pack_source / "02-视频提示词" / "回传" / "03-lanyue" / "选中"

    # Raw 6.5s intro_voice clip: visual motion 0.75s..2.5s, voice audio 1.2s..5.0s (stereo AAC)
    raw_intro = selected_dir / "03-lanyue__intro_voice__s3271__576x1024__p4fb988.mp4"
    _write_synthetic_mp4(
        raw_intro,
        hub=hub,
        ffmpeg=ffmpeg,
        n_frames=156,
        motion_range=(18, 60),
        audio_range_sec=(1.2, 5.0),
    )

    res = media_ops.ingest_selected_videos(
        pack_source,
        ["lanyue"],
        packs_root=packs_root,
        workers=1,
    )
    tutor_res = res["tutors"]["lanyue"]
    assert tutor_res["ingested_count"] == 1
    assert tutor_res["rejected_count"] == 0
    rec = tutor_res["ingested"]["intro_voice"]
    assert rec["has_audio"] is True
    assert rec["keyframes"] == 1
    # Visual motion starts ~0.9s, audio runs to 5.0s (+0.25s pad) -> duration covers full speech (~4.3s),
    # NOT truncated to visual-only end (~2.0s)!
    assert rec["duration_sec"] >= 4.2
    assert rec["settle_ms"] >= 3900

    out_clip = pack_dir / "clips" / "intro_voice.webm"
    probe = media_ops.probe_video(out_clip, ffprobe=ffprobe, ffmpeg=ffmpeg)
    assert probe is not None
    assert probe["codec"] == "vp9"
    assert "0" in probe["profile"]
    assert probe["pix_fmt"] == "yuv420p"
    assert probe["keyframes"] == 1
    assert len(probe["audio_streams"]) == 1
    assert probe["audio_streams"][0]["codec_name"] == "opus"
    assert int(probe["audio_streams"][0]["channels"]) == 1

    # Strict validation passes with zero unchecked items
    val = tutorpack_cli.validate_directory(pack_dir, check_media=True, strict_limits=True)
    assert val["unchecked_items"] == []
    assert "intro_voice" in val["present_slots"]

    # Sheet generation handles intro_voice cleanly
    sheets = media_ops.generate_review_sheets(["lanyue"], packs_root=packs_root, output_root=tmp_path / "review")
    assert Path(sheets["lanyue"]["clips_sheet"]).is_file()

    # License sync registers intro_voice.webm with MiniMax H3 + allow_redistribution: false
    lic = media_ops.sync_builtin_licenses(tmp_path / "avatars")
    assert lic["packs_updated"] == 1
    lic_text = (tmp_path / "avatars" / "LICENSES.md").read_text(encoding="utf-8")
    assert "`packs/tutor-lanyue/clips/intro_voice.webm`" in lic_text
    assert "VP9+Opus motion clip" in lic_text
    assert "allow_redistribution: false" in lic_text

    # Negative strict check: putting an audio stream into a silent slot MUST fail validate --strict
    manifest = json.loads((pack_dir / "manifest.json").read_text(encoding="utf-8"))
    (pack_dir / "clips" / "greet_wave.webm").write_bytes(out_clip.read_bytes())
    manifest["clips"]["greet_wave"] = "clips/greet_wave.webm"
    manifest["clip_meta"]["greet_wave"] = manifest["clip_meta"]["intro_voice"]
    (pack_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(ValueError, match="unexpected audio stream"):
        tutorpack_cli.validate_directory(pack_dir, check_media=True, strict_limits=True)


@pytest.mark.skipif(not _ffmpeg_pair()[0] or not _ffmpeg_pair()[1], reason="External FFmpeg/ffprobe not configured")
def test_adaptive_pack_budget_and_idempotency(tmp_path: Path) -> None:
    ffmpeg, _ffprobe = _ffmpeg_pair()
    assert ffmpeg
    hub = _make_textured_anchor(seed=23)
    packs_root = tmp_path / "avatars" / "packs"
    pack_source = tmp_path / "expansion"
    pack_dir = _scaffold_temp_tutor_pack(packs_root, pack_source, slug="lanyue", hub=hub)
    selected_dir = pack_source / "02-视频提示词" / "回传" / "03-lanyue" / "选中"

    # Build 3 textured clips spanning Tier 1, Tier 2, Tier 3 (fast VP9 encode, smooth CRF scaling)
    clip_specs = [
        ("idle_breathe", 98, (12, 86), None),
        ("greet_wave", 72, (12, 58), None),
        ("nod_yes", 72, (12, 58), None),
    ]
    for idx, (slot, n_frames, mrange, audio) in enumerate(clip_specs):
        _write_synthetic_mp4(
            selected_dir / f"03-lanyue__{slot}__s{3000 + idx}__576x1024__pa1b2c3.mp4",
            hub=hub,
            ffmpeg=ffmpeg,
            n_frames=n_frames,
            motion_range=mrange,
            motion_amp=48.0,
            noise_sigma=0.0,
            audio_range_sec=audio,
        )

    # First measure unconstrained pass-1 total (pack_budget=0)
    baseline = media_ops.ingest_selected_videos(
        pack_source,
        ["lanyue"],
        packs_root=packs_root,
        pack_budget=0,
        workers=3,
    )
    base_bytes = baseline["tutors"]["lanyue"]["total_clip_bytes"]
    assert base_bytes > 100_000

    # Set a tight budget (~62% of pass-1 total) to trigger adaptive tiered CRF re-encoding from raw MP4s
    tight_budget = int(base_bytes * 0.62)
    run1 = media_ops.ingest_selected_videos(
        pack_source,
        ["lanyue"],
        packs_root=packs_root,
        pack_budget=tight_budget,
        workers=3,
    )
    t1 = run1["tutors"]["lanyue"]
    assert t1["budget"]["within_budget"] is True
    assert t1["budget"]["pass1_total_clip_bytes"] > tight_budget
    assert t1["total_clip_bytes"] <= tight_budget
    assert t1["budget"]["reencoded_for_budget"] > 0

    # Core Tier-1 loop must preserve lower (higher quality) CRF than Tier-2 / Tier-3 slots
    ing = t1["ingested"]
    assert ing["idle_breathe"]["crf"] <= ing["greet_wave"]["crf"] <= ing["nod_yes"]["crf"]
    assert ing["idle_breathe"]["crf"] < ing["nod_yes"]["crf"]

    # Every clip remains 576x1024 @ 24fps VP9 Profile 0 yuv420p single keyframe and passes validate --strict
    val = tutorpack_cli.validate_directory(pack_dir, check_media=True, strict_limits=True)
    assert val["total_clip_bytes"] <= tight_budget
    for slot in [s[0] for s in clip_specs]:
        c = val["clips"][slot]
        assert (c["width"], c["height"]) == (576, 1024)
        assert c["codec"] == "vp9"
        assert c["keyframes"] == 1

    # Re-running ingest with identical inputs must be 100% idempotent
    manifest_after_1 = (pack_dir / "manifest.json").read_text(encoding="utf-8")
    run2 = media_ops.ingest_selected_videos(
        pack_source,
        ["lanyue"],
        packs_root=packs_root,
        pack_budget=tight_budget,
        workers=3,
    )
    manifest_after_2 = (pack_dir / "manifest.json").read_text(encoding="utf-8")
    assert manifest_after_2 == manifest_after_1
    assert run2["tutors"]["lanyue"]["total_clip_bytes"] == t1["total_clip_bytes"]
    for slot in ing:
        assert run2["tutors"]["lanyue"]["ingested"][slot]["crf"] == ing[slot]["crf"]


@pytest.mark.skipif(not _ffmpeg_pair()[0] or not _ffmpeg_pair()[1], reason="External FFmpeg/ffprobe not configured")
def test_full_27_slot_ingest_validate_sheet_idempotent(tmp_path: Path) -> None:
    ffmpeg, _ffprobe = _ffmpeg_pair()
    assert ffmpeg
    hub = _make_textured_anchor(seed=31)
    packs_root = tmp_path / "avatars" / "packs"
    pack_source = tmp_path / "expansion"
    pack_dir = _scaffold_temp_tutor_pack(packs_root, pack_source, slug="xuechuan", hub=hub)
    selected_dir = pack_source / "02-视频提示词" / "回传" / "01-xuechuan" / "选中"

    catalog = media_ops.load_catalog()
    active_entries = [c for c in catalog["clips"] if not c.get("reserved")]
    assert len(active_entries) == 27

    # Generate lightweight valid 576x1024 MP4 templates (1 loop 4.08s, 1 one_shot 2.5s, 1 intro_voice 3.0s with audio)
    tpl_dir = tmp_path / "templates"
    loop_tpl = tpl_dir / "loop.mp4"
    oneshot_tpl = tpl_dir / "oneshot.mp4"
    intro_tpl = tpl_dir / "intro.mp4"
    _write_synthetic_mp4(loop_tpl, hub=hub, ffmpeg=ffmpeg, n_frames=98, motion_range=(16, 80), motion_amp=18.0)
    _write_synthetic_mp4(oneshot_tpl, hub=hub, ffmpeg=ffmpeg, n_frames=60, motion_range=(12, 46), motion_amp=20.0)
    _write_synthetic_mp4(
        intro_tpl,
        hub=hub,
        ffmpeg=ffmpeg,
        n_frames=72,
        motion_range=(12, 52),
        motion_amp=18.0,
        audio_range_sec=(0.6, 2.4),
    )

    for idx, entry in enumerate(active_entries):
        slot = entry["id"]
        src_tpl = intro_tpl if entry.get("allow_audio") else (oneshot_tpl if entry["kind"] == "one_shot" else loop_tpl)
        dst = selected_dir / f"01-xuechuan__{slot}__s{1000 + idx}__576x1024__pdeadbe.mp4"
        dst.write_bytes(src_tpl.read_bytes())

    workers = min(4, max(1, (os.cpu_count() or 2) // 2))
    res = media_ops.ingest_selected_videos(
        pack_source,
        ["xuechuan"],
        packs_root=packs_root,
        pack_budget=media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN,
        workers=workers,
    )
    t_res = res["tutors"]["xuechuan"]
    assert t_res["ingested_count"] == 27
    assert t_res["rejected_count"] == 0
    assert t_res["total_clips"] == 27
    assert t_res["total_clip_bytes"] <= media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN

    manifest = json.loads((pack_dir / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["clips"]) == 27
    assert len(manifest["clip_meta"]) == 27
    for entry in active_entries:
        slot = entry["id"]
        assert slot in manifest["clips"]
        meta = manifest["clip_meta"][slot]
        assert "duration_ms" in meta
        if entry["kind"] == "one_shot":
            assert "settle_ms" in meta and meta["settle_ms"] >= 600
        else:
            assert "settle_ms" not in meta

    # Strict validation passes with 0 missing active slots
    val = tutorpack_cli.validate_directory(pack_dir, check_media=True, strict_limits=True)
    assert val["missing_slots"] == []
    assert val["unchecked_items"] == []
    assert val["total_clip_bytes"] <= media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN

    # Sheet renders all 27 rows cleanly (height = 27 * (320 + 28) = 9396)
    sheets = media_ops.generate_review_sheets(["xuechuan"], packs_root=packs_root, output_root=tmp_path / "review")
    sheet_path = Path(sheets["xuechuan"]["clips_sheet"])
    assert sheet_path.is_file()
    with Image.open(sheet_path) as im:
        assert im.size == (1080, 27 * (320 + 28))

    # Sync licenses registers all 27 clips cleanly
    media_ops.sync_builtin_licenses(tmp_path / "avatars")
    lic_text = (tmp_path / "avatars" / "LICENSES.md").read_text(encoding="utf-8")
    for entry in active_entries:
        assert f"`packs/tutor-xuechuan/clips/{entry['id']}.webm`" in lic_text

    # Idempotency check: second ingest produces identical manifest.json
    manifest_before = (pack_dir / "manifest.json").read_text(encoding="utf-8")
    media_ops.ingest_selected_videos(
        pack_source,
        ["xuechuan"],
        packs_root=packs_root,
        pack_budget=media_ops.MAX_PACK_CLIPS_BYTES_BUILTIN,
        workers=workers,
    )
    assert (pack_dir / "manifest.json").read_text(encoding="utf-8") == manifest_before
