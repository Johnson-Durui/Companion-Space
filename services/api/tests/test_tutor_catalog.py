from __future__ import annotations

import asyncio
import io
import json
import sys
import zipfile

from PIL import Image

from app.api.deps import get_container
from app.core.config import APP_ROOT
from app.services.settings_store import put_setting
from app.teaching.lsp_parser import LspEvent
from app.teaching.runtime import LessonRuntime

_MINIMAL_WEBM = b"\x1a\x45\xdf\xa3" + b"\x9f\x42\x86\x81\x01" + b"\x00" * 64
_MINIMAL_MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 32


def _make_png_bytes(width: int = 320, height: int = 480) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=(110, 175, 195))
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_tutorpack(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_single_image_import_persona_update_and_delete(client, owner_token):
    png = _make_png_bytes()
    headers = {"Authorization": f"Bearer {owner_token}", "X-Filename": "anime-tutor.png"}
    imported = client.post("/api/v2/characters/import", headers=headers, content=png)
    assert imported.status_code == 201, imported.json()
    character = imported.json()
    assert character["schema_version"] == 3
    assert character["appearance"]["kind"] == "portrait"
    assert character["video_avatar"]["preferred_tier"] == "static"
    assert character["pack_metadata"]["source_kind"] == "imported_image"

    source = character["video_avatar"]["anchor_image"]
    assert client.get(source).status_code == 401
    asset = client.get(source, headers={"Authorization": f"Bearer {owner_token}"})
    assert asset.status_code == 200
    assert asset.headers["content-type"] == "image/webp"

    edit = {
        "name": "Anime Sensei",
        "relationship": "Patient 1-on-1 tutor",
        "traits": ["Warm", "Clear"],
        "catchphrases": [],
        "address_user_as": "Learner",
        "default_style_id": "rigorous",
        "preferred_tier": "static",
    }
    updated = client.put(
        f"/api/v2/characters/{character['id']}",
        headers={"Authorization": f"Bearer {owner_token}"},
        json=edit,
    )
    assert updated.status_code == 200, updated.json()
    assert updated.json()["name"] == "Anime Sensei"
    assert updated.json()["default_style_id"] == "rigorous"

    # Set as default then delete: default should gracefully fall back to a built-in teacher.
    set_default = client.put(
        "/api/v2/settings/default-character",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"character_id": character["id"]},
    )
    assert set_default.status_code == 200
    deleted = client.delete(
        f"/api/v2/characters/{character['id']}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert deleted.status_code == 204
    settings = client.get("/api/v2/settings", headers={"Authorization": f"Bearer {owner_token}"}).json()
    assert settings["default_character_id"] in {"tutor-chutang", "tutor-xuechuan"}

    # Built-in teachers cannot be deleted.
    builtin_delete = client.delete(
        "/api/v2/characters/tutor-chutang",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert builtin_delete.status_code == 400


def test_tutorpack_import_range_streaming_and_partial_fallback(client, owner_token):
    manifest = {
        "schema_version": 1,
        "name": "Echo Loop",
        "aspect_ratio": "9:16",
        "crossfade_ms": 180,
        "anchor": "anchor.png",
        "clips": {
            "idle_breathe": "clips/idle_breathe.webm",
            "speak_explain_a": "clips/speak_explain_a.mp4",
            "react_praise": "clips/react_praise.webm",
        },
        "license": {
            "author": "Companion Space",
            "terms": "Apache-2.0",
            "allow_redistribution": True,
        },
    }
    archive = _make_tutorpack({
        "manifest.json": json.dumps(manifest).encode("utf-8"),
        "anchor.png": _make_png_bytes(),
        "clips/idle_breathe.webm": _MINIMAL_WEBM,
        "clips/speak_explain_a.mp4": _MINIMAL_MP4,
        "clips/react_praise.webm": _MINIMAL_WEBM,
    })
    headers = {"Authorization": f"Bearer {owner_token}", "X-Filename": "echo-loop.tutorpack"}
    imported = client.post("/api/v2/characters/import", headers=headers, content=archive)
    assert imported.status_code == 201, imported.json()
    character = imported.json()
    assert character["appearance"]["kind"] == "video_pack"
    assert character["video_avatar"]["preferred_tier"] == "loop_pack"
    clip_url = character["video_avatar"]["loop_pack"]["clips"]["idle_breathe"]
    ranged = client.get(
        clip_url,
        headers={"Authorization": f"Bearer {owner_token}", "Range": "bytes=0-15"},
    )
    assert ranged.status_code == 206
    assert len(ranged.content) == 16
    assert ranged.headers["content-type"] == "video/webm"


def test_import_rejects_vrm_zip_slip_executables_and_spoofed_media(client, owner_token):
    auth = {"Authorization": f"Bearer {owner_token}"}

    # Retired .vrm upload is rejected.
    res_vrm = client.post("/api/v2/characters/import", headers={**auth, "X-Filename": "old.vrm"}, content=b"glTF")
    assert res_vrm.status_code == 400

    # Zip-slip traversal is rejected.
    traversal = _make_tutorpack({"../escape.txt": b"bad", "manifest.json": b"{}"})
    res_slip = client.post("/api/v2/characters/import", headers={**auth, "X-Filename": "bad.tutorpack"}, content=traversal)
    assert res_slip.status_code == 400

    # Executable entry is rejected.
    exe_pack = _make_tutorpack({"manifest.json": b"{}", "clips/run.ps1": b"Write-Host hi"})
    res_exe = client.post("/api/v2/characters/import", headers={**auth, "X-Filename": "exe.tutorpack"}, content=exe_pack)
    assert res_exe.status_code == 400

    # Windows reserved name is rejected.
    reserved = _make_tutorpack({"manifest.json": b"{}", "clips/CON.webm": _MINIMAL_WEBM})
    res_reserved = client.post("/api/v2/characters/import", headers={**auth, "X-Filename": "res.tutorpack"}, content=reserved)
    assert res_reserved.status_code == 400

    # Spoofed WebM without EBML header is rejected.
    manifest = {
        "schema_version": 1,
        "name": "Spoofed",
        "anchor": "anchor.png",
        "clips": {"idle_breathe": "clips/idle_breathe.webm"},
    }
    spoofed = _make_tutorpack({
        "manifest.json": json.dumps(manifest).encode("utf-8"),
        "anchor.png": _make_png_bytes(),
        "clips/idle_breathe.webm": b"not a real webm video",
    })
    res_spoof = client.post("/api/v2/characters/import", headers={**auth, "X-Filename": "spoof.tutorpack"}, content=spoofed)
    assert res_spoof.status_code == 400


def test_legacy_v2_portrait_upgrade_and_retired_vrm_fallback(client, owner_token):
    container = get_container()
    auth = {"Authorization": f"Bearer {owner_token}"}
    v2_portrait = {
        "id": "legacy-portrait-tutor",
        "name": "Legacy Portrait",
        "schema_version": 2,
        "appearance": {"kind": "portrait", "src": "/static/avatars/portraits/chutang.webp"},
        "voice": {"engine": "edge", "voice_id": "zh-CN-XiaoxiaoNeural", "rate": 1, "pitch": 0},
        "persona": {"relationship": "Tutor", "traits": ["Calm"], "catchphrases": [], "address_user_as": "你"},
        "default_style_id": "guided",
        "license": "Apache-2.0",
    }
    v2_vrm = {
        **v2_portrait,
        "id": "legacy-retired-vrm",
        "name": "Old 3D Tutor",
        "appearance": {"kind": "vrm", "src": "/static/avatars/models/old.vrm"},
    }
    with container.repository.connection() as conn:
        for row in (v2_portrait, v2_vrm):
            conn.execute(
                """INSERT INTO character_packs
                   (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                   VALUES (?, ?, '', ?, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')""",
                (row["id"], row["name"], json.dumps(row)),
            )
    put_setting(container.repository, "default_character_id", "legacy-retired-vrm")

    roster = client.get("/api/v2/characters", headers=auth).json()
    ids = {entry["id"] for entry in roster}
    assert "legacy-portrait-tutor" in ids
    assert "legacy-retired-vrm" not in ids

    # Retired row remains untouched in SQLite (non-destructive).
    with container.repository.connection() as conn:
        kept = conn.execute("SELECT id FROM character_packs WHERE id = 'legacy-retired-vrm'").fetchone()
    assert kept is not None

    # Default character setting and resolver gracefully fall back to an active anime teacher.
    settings = client.get("/api/v2/settings", headers=auth).json()
    assert settings["default_character_id"] in {"tutor-chutang", "tutor-xuechuan"}
    fallback = container.tutors.resolve_active_character("legacy-retired-vrm")
    assert fallback is not None and fallback.id in {"tutor-chutang", "tutor-xuechuan"}
    legacy_echo = container.tutors.resolve_active_character("tutor-echo")
    assert legacy_echo is not None and legacy_echo.id == "tutor-chutang"


def test_tutorpack_cli_roundtrip_into_backend_import(tmp_path, client, owner_token):
    tools_dir = str(APP_ROOT / "tools" / "tutorpack")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    import cli as tutorpack_cli

    anchor = tmp_path / "source.png"
    anchor.write_bytes(_make_png_bytes())
    pack_dir = tmp_path / "echo-pack"
    assert tutorpack_cli.main([
        "scaffold", "CLI Echo", "--anchor", str(anchor), "-o", str(pack_dir),
        "--author", "UnitTest", "--terms", "Apache-2.0",
    ]) == 0
    (pack_dir / "clips" / "idle_breathe.webm").write_bytes(_MINIMAL_WEBM)
    (pack_dir / "clips" / "speak_explain_a.webm").write_bytes(_MINIMAL_WEBM)

    out_archive = tmp_path / "echo-cli.tutorpack"
    assert tutorpack_cli.main(["pack", str(pack_dir), "-o", str(out_archive)]) == 0
    assert tutorpack_cli.main(["validate", str(out_archive)]) == 0

    imported = client.post(
        "/api/v2/characters/import",
        headers={"Authorization": f"Bearer {owner_token}", "X-Filename": out_archive.name},
        content=out_archive.read_bytes(),
    )
    assert imported.status_code == 201, imported.json()
    assert imported.json()["video_avatar"]["preferred_tier"] == "loop_pack"


def test_objective_answer_triggers_on_judge_before_realizer_runs(isolated_settings):
    from test_teaching_storage import _seed_plan

    container = get_container()
    repository = container.repository
    course_id, item_id, kp_id, bank_id = "judge-course", "judge-plan-item", "judge-kp", "judge-bank"
    with repository.connection() as conn:
        _seed_plan(conn, course_id, item_id)
        conn.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, created_at, updated_at)
               VALUES (?, ?, 'Limit', 'limit', 'concept', 'Limit', 'core', 1, 1, '2026-01-01', '2026-01-01')""",
            (kp_id, course_id),
        )
        conn.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES (?, ?, ?, 'generated', 'check', 'choice', '{}', 'verified', '2026-01-01')""",
            (bank_id, course_id, kp_id),
        )

    plan = {
        "title": "Limit",
        "est_minutes": 10,
        "segments": [{"id": "seg1", "kp_id": kp_id, "keypoints": ["k1"], "checks": ["q1"], "approaches": [{"kind": "direct", "keypoint": "all", "outline": "o"}]}],
        "items": {
            "q1": {
                "type": "choice", "kp_id": kp_id, "bank_id": bank_id, "keypoints": [0],
                "stem": "Pick A", "answer": "A", "verify": {"status": "verified"},
                "options": [{"key": "A", "text": "Yes"}, {"key": "B", "text": "No"}],
            }
        },
    }
    saved = repository.save_lesson_plan(course_id, item_id, plan=plan)
    lesson = repository.create_or_resume_lesson(
        course_id, item_id, lesson_plan_id=saved["id"], character_id="tutor-chutang",
        state={"stage": "teaching", "seg_idx": 0, "active_ask": {"kind": "item", "purpose": "check", "item_id": "q1"}},
    )

    order: list[str] = []
    captured_context: dict = {}

    class RecordingRealizer:
        async def run(self, decision, *, context, board, item=None, cancel=None):
            order.append("realizer")
            captured_context.update(context)
            yield LspEvent("say", {"text": "Great job!", "emotion": "cheerful"})

    runtime = LessonRuntime(repository, container.gateway, course_id, lesson["id"])
    runtime.realizer = RecordingRealizer()  # type: ignore[assignment]

    async def on_judge(verdict: str) -> None:
        order.append(f"judge:{verdict}")

    rows = asyncio.run(
        runtime.step(
            {"type": "student_answer", "item_id": "q1", "value": "A", "via": "control", "dont_know": False},
            on_judge=on_judge,
        )
    )
    assert order == ["judge:correct", "realizer"]
    assert captured_context.get("recent_avatar_action") == "praise_thumbs_up"
    assert any(row["type"] == "judge" and row["data"]["verdict"] == "correct" for row in rows)


def test_builtin_six_teachers_auto_discover_full_loop_packs(client, owner_token):
    auth = {"Authorization": f"Bearer {owner_token}"}
    roster = client.get("/api/v2/characters", headers=auth).json()
    builtin_ids = {
        "tutor-xuechuan",
        "tutor-shenyan",
        "tutor-lanyue",
        "tutor-chutang",
        "tutor-qingheng",
        "tutor-lanyin",
    }
    by_id = {entry["id"]: entry for entry in roster}
    assert builtin_ids <= by_id.keys()
    for char_id in builtin_ids:
        teacher = by_id[char_id]
        assert teacher["appearance"]["kind"] == "video_pack"
        assert teacher["video_avatar"]["preferred_tier"] == "loop_pack"
        clips = teacher["video_avatar"]["loop_pack"]["clips"]
        assert len(clips) == 8
    sample_url = by_id["tutor-chutang"]["video_avatar"]["loop_pack"]["clips"]["idle_breathe"]
    resp = client.get(sample_url)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("video/webm")
    assert resp.content[:4] == b"\x1a\x45\xdf\xa3"


def test_builtin_themes_default_merge_and_preserve_user_edits(client, owner_token):
    container = get_container()
    auth = {"Authorization": f"Bearer {owner_token}"}
    expected = {
        "tutor-xuechuan": "xuechuan",
        "tutor-shenyan": "shenyan",
        "tutor-lanyue": "lanyue",
        "tutor-chutang": "chutang",
        "tutor-qingheng": "qingheng",
        "tutor-lanyin": "lanyin",
    }

    # Simulate an existing installation where stored built-in recipe JSON lacks "theme"
    # and user has already customized the teacher's name.
    with container.repository.connection() as conn:
        row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = 'tutor-xuechuan'").fetchone()
        legacy_recipe = json.loads(row["recipe_json"])
        legacy_recipe.pop("theme", None)
        legacy_recipe["name"] = "雪川学长"
        conn.execute(
            "UPDATE character_packs SET name = ?, recipe_json = ? WHERE id = 'tutor-xuechuan'",
            (legacy_recipe["name"], json.dumps(legacy_recipe)),
        )

    roster = client.get("/api/v2/characters", headers=auth).json()
    by_id = {entry["id"]: entry for entry in roster}
    for char_id, theme_id in expected.items():
        assert by_id[char_id]["theme"] == theme_id
    # User's edited name was preserved while missing theme was merged from defaults.
    assert by_id["tutor-xuechuan"]["name"] == "雪川学长"

    # Explicit theme edit persists and is not overwritten by subsequent unrelated edits.
    updated = client.put(
        "/api/v2/characters/tutor-xuechuan",
        headers=auth,
        json={
            "name": "雪川学长",
            "relationship": by_id["tutor-xuechuan"]["persona"]["relationship"],
            "traits": by_id["tutor-xuechuan"]["persona"]["traits"],
            "catchphrases": by_id["tutor-xuechuan"]["persona"]["catchphrases"],
            "address_user_as": by_id["tutor-xuechuan"]["persona"]["address_user_as"],
            "default_style_id": "guided",
            "theme": "neutral",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["theme"] == "neutral"

    # Subsequent edit without theme keeps user's chosen theme.
    updated2 = client.put(
        "/api/v2/characters/tutor-xuechuan",
        headers=auth,
        json={
            "name": "雪川",
            "relationship": by_id["tutor-xuechuan"]["persona"]["relationship"],
            "traits": by_id["tutor-xuechuan"]["persona"]["traits"],
            "catchphrases": by_id["tutor-xuechuan"]["persona"]["catchphrases"],
            "address_user_as": by_id["tutor-xuechuan"]["persona"]["address_user_as"],
            "default_style_id": "guided",
        },
    )
    assert updated2.status_code == 200
    assert updated2.json()["theme"] == "neutral"
