from __future__ import annotations

import asyncio
from datetime import date, timedelta
import json

from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.learning.replanning import rebuild_course_plan
from app.main import create_app
from app.repositories.mixins.common import utcnow
from app.teaching.finish import finish_lesson
from fakes.e2e import BrowserHarnessGateway, seed_classroom
from test_teaching_storage import _seed_plan


def _auth_headers(container) -> dict[str, str]:
    container.vault.bootstrap()
    owner = container.vault.issue_owner_token()
    return {"Authorization": f"Bearer {owner}"}


def test_b9_journey_stages_and_onboarding_completed(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51001)) as client:
        headers = _auth_headers(container)

        # Fresh install with no courses -> onboarding_completed_at is None
        settings_initial = client.get("/api/v2/settings", headers=headers).json()
        assert settings_initial["onboarding_completed_at"] is None

        # Explicit onboarding completion persists
        updated = client.put(
            "/api/v2/settings", headers=headers, json={"onboarding_completed": True},
        )
        assert updated.status_code == 200
        assert updated.json()["onboarding_completed_at"] is not None

        # Create an empty course -> needs_materials (NEVER today_done!)
        course = client.post("/api/v2/courses", headers=headers, json={"name": "概率论"}).json()
        course_id = course["id"]

        j0 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j0["stage"] == "needs_materials"
        assert j0["next_step"] == "materials"
        assert j0["steps"]["materials"] == "active"
        assert j0["steps"]["placement"] == "waiting"
        assert j0["has_plan"] is False

        # Add a material without analysis -> analyzing (waiting for analysis), placement still waiting
        note = client.post(
            f"/api/v2/courses/{course_id}/materials/note",
            headers=headers,
            json={"title": "第一章", "content": "样本空间与事件", "role": "notes"},
        )
        assert note.status_code == 201
        j1 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j1["stage"] == "analyzing"
        assert j1["steps"]["materials"] == "done"
        assert j1["steps"]["placement"] == "waiting"

        # Seed KPs + verified diagnostic item -> materials ready -> interview stage
        now = utcnow().isoformat()
        with container.repository.connection() as conn:
            conn.execute(
                """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                                difficulty, ord, source_refs_json, created_at, updated_at)
                   VALUES ('kp-1', ?, '事件与概率', 'prob', 'concept', '概念', 'core', 2, 1, '[]', ?, ?)""",
                (course_id, now, now),
            )
            conn.execute(
                """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
                   VALUES ('diag-1', ?, 'kp-1', 'generated', 'diagnostic', 'choice',
                           '{"stem":"题干","options":{"A":"1","B":"2"},"answer":"A"}', 'verified', ?)""",
                (course_id, now),
            )
        j2 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j2["stage"] == "interview"
        assert j2["next_step"] == "interview"
        assert j2["steps"]["analysis"] == "done"
        assert j2["steps"]["placement"] == "todo"

        # Complete interview -> placement stage
        container.repository.update_enrollment_progress(course_id, interview_status="done")
        j3 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j3["stage"] == "placement"
        assert j3["next_step"] == "placement"
        assert j3["steps"]["interview"] == "done"
        assert j3["steps"]["placement"] == "active"

        # Complete placement -> plan_ready stage
        container.repository.update_enrollment_progress(course_id, placement_status="done")
        j4 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j4["stage"] == "plan_ready"
        assert j4["next_step"] == "plan"

        # Build plan with future item -> today_done; then schedule today -> learning; mark done -> all_done
        today = date.today()
        future_exam = (today + timedelta(days=14)).isoformat()
        client.put(
            f"/api/v2/courses/{course_id}/enrollment",
            headers=headers,
            json={
                "goal_type": "exam",
                "exam_name": "期末考",
                "exam_date": future_exam,
                "target_score": 85,
                "full_score": 100,
                "weekly_days": [1, 2, 3, 4, 5, 6, 7],
                "session_minutes": 30,
                "self_level": "basic",
                "hard_units": [],
                "teacher_hints": "",
            },
        )
        plan = client.post(
            f"/api/v2/courses/{course_id}/plan",
            headers=headers,
            json={"reason": "setup"},
        ).json()
        assert len(plan["items"]) >= 1
        j5 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j5["stage"] == "today_done"
        assert j5["has_plan"] is True

        # Schedule first item to today -> learning
        with container.repository.connection() as conn:
            conn.execute(
                "UPDATE plan_items SET scheduled_date = ? WHERE id = ?",
                (today.isoformat(), plan["items"][0]["id"]),
            )
        j6 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j6["stage"] == "learning"

        # Mark all items done -> all_done
        with container.repository.connection() as conn:
            conn.execute("UPDATE plan_items SET status = 'done' WHERE space_id = ?", (course_id,))
        j7 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j7["stage"] == "all_done"
        assert j7["all_done"] is True

        # Set exam_date in the past -> exam_passed
        past_exam = (today - timedelta(days=2)).isoformat()
        client.put(
            f"/api/v2/courses/{course_id}/enrollment",
            headers=headers,
            json={
                "goal_type": "exam",
                "exam_name": "期末考",
                "exam_date": past_exam,
                "target_score": 85,
                "full_score": 100,
                "weekly_days": [1, 2, 3, 4, 5, 6, 7],
                "session_minutes": 30,
                "self_level": "basic",
                "hard_units": [],
                "teacher_hints": "",
            },
        )
        j8 = client.get(f"/api/v2/courses/{course_id}/journey", headers=headers).json()
        assert j8["stage"] == "exam_passed"
        assert j8["exam_passed"] is True


def test_b15_dashboard_and_b4a_plan_explainability(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51002)) as client:
        headers = _auth_headers(container)
        course = client.post("/api/v2/courses", headers=headers, json={"name": "线性代数"}).json()
        course_id = course["id"]

        # Upgrade compat: once a course exists, settings treats onboarding as completed
        settings = client.get("/api/v2/settings", headers=headers).json()
        assert settings["onboarding_completed_at"] is not None

        now = utcnow().isoformat()
        today = date.today()
        with container.repository.connection() as conn:
            for idx, (kp_id, name, weight) in enumerate([
                ("kp-a", "矩阵乘法", 0.5),
                ("kp-b", "行列式", 0.35),
                ("kp-c", "秩与线性相关", 0.15),
            ], 1):
                conn.execute(
                    """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                                    difficulty, ord, source_refs_json, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'concept', '摘要', 'core', 2, ?, '[]', ?, ?)""",
                    (kp_id, course_id, name, kp_id, idx, now, now),
                )
                conn.execute(
                    """INSERT INTO kp_exam_stats(kp_id, space_id, n_items, score_share, recency_weight, trend, weight, updated_at)
                       VALUES (?, ?, 3, ?, 1.0, 'steady', ?, ?)""",
                    (kp_id, course_id, weight, weight, now),
                )
            conn.execute(
                "INSERT INTO kp_edges(space_id, from_kp, to_kp, source) VALUES (?, 'kp-a', 'kp-b', 'material')",
                (course_id,),
            )

        # Constrain capacity so at least one KP is deferred (exam in 2 days, 15 min/session)
        exam_date = (today + timedelta(days=2)).isoformat()
        client.put(
            f"/api/v2/courses/{course_id}/enrollment",
            headers=headers,
            json={
                "goal_type": "exam",
                "exam_name": "期中测验",
                "exam_date": exam_date,
                "target_score": 88,
                "full_score": 100,
                "weekly_days": [1, 2, 3, 4, 5, 6, 7],
                "session_minutes": 15,
                "self_level": "never",
                "hard_units": [],
                "teacher_hints": "",
            },
        )
        plan = client.post(
            f"/api/v2/courses/{course_id}/plan",
            headers=headers,
            json={"today": today.isoformat(), "reason": "setup"},
        ).json()
        assert plan["created_at"]
        assert plan["reason"] == "setup"
        assert "deferred_weight" in plan["params"]
        assert plan["deferred_weight"] == plan["params"]["deferred_weight"]
        assert plan["over_capacity"] == plan["params"]["over_capacity"]
        assert plan["capacity_minutes"] == plan["params"]["capacity_minutes"]
        assert len(plan["deferred"]) >= 1
        assert plan["deferred_items"][0]["kp_name"] in {"矩阵乘法", "行列式", "秩与线性相关"}
        assert plan["items"][0]["why"][0]["kp_name"]

        # Rebuild via replanning.py must ALSO persist deferred_weight/over_capacity/capacity_minutes
        rebuilt = asyncio.run(
            rebuild_course_plan(container.repository, container.gateway, course_id, today=today, reason="lesson_finished")
        )
        assert rebuilt is not None
        assert "deferred_weight" in rebuilt["params"]
        assert "over_capacity" in rebuilt["params"]
        assert "capacity_minutes" in rebuilt["params"]

        # Schedule a lesson AND a practice item for today; verify B15 dashboard fields
        first_item_id = rebuilt["items"][0]["id"]
        with container.repository.connection() as conn:
            conn.execute(
                "UPDATE plan_items SET scheduled_date = ? WHERE id = ?",
                (today.isoformat(), first_item_id),
            )
            conn.execute(
                """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json,
                                          est_minutes, scheduled_date, why_text, pinned, status)
                   VALUES ('prac-today', ?, ?, 99, 'practice', 'Practice', '["kp-a"]', 20, ?, '[]', 0, 'todo')""",
                (rebuilt["id"], course_id, today.isoformat()),
            )

        rows = client.get("/api/v2/courses/dashboard", headers=headers).json()
        row = next(entry for entry in rows if entry["course_id"] == course_id)
        assert row["target_score"] == 88
        assert row["exam_name"] == "期中测验"
        assert row["exam_date"] == exam_date
        assert row["today_lesson"]["id"] == first_item_id
        assert row["today_practice"]["id"] == "prac-today"
        assert row["today_practice"]["kind"] == "practice"
        assert row["lesson_index"] == 1
        assert row["lesson_total"] >= 1
        assert len(row["today_lesson_why"]) >= 1
        assert row["journey"]["stage"] == "learning"

        # Legacy plan without deferred_weight returns None (not 0)
        with container.repository.connection() as conn:
            conn.execute(
                "UPDATE study_plans SET params_json = '{}' WHERE id = ?",
                (rebuilt["id"],),
            )
        legacy = client.get(f"/api/v2/courses/{course_id}/plan", headers=headers).json()
        assert legacy["deferred_weight"] is None
        assert legacy["over_capacity"] is None
        assert legacy["capacity_minutes"] is None


def test_b2_recap_summary_and_review_cards_created(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")

    # Verify finish_lesson records review_cards_created in recap
    now = utcnow().isoformat()
    with container.repository.connection() as conn:
        _seed_plan(conn, "course-b2", "item-b2")
        conn.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, source_refs_json, created_at, updated_at)
               VALUES ('kp-b2', 'course-b2', '极限定义', 'lim', 'concept', '摘要', 'core', 2, 1, '[]', ?, ?)""",
            (now, now),
        )
        conn.execute(
            """INSERT INTO lessons(id, space_id, plan_item_id, character_id, status, state_json, board_json,
                                   started_at)
               VALUES ('lesson-b2', 'course-b2', 'item-b2', 'tutor-chutang', 'done', ?, '[]', ?)""",
            (json.dumps({"seg_idx": 1, "kp_cursor": 0, "stage": "done", "active_ms": 180000, "backfilled": ["kp-pre"]}), now),
        )
        conn.execute(
            """INSERT INTO lesson_events(lesson_id, seq, gen, type, data_json, t_ms)
               VALUES ('lesson-b2', 1, 1, 'turn.start', '{"action":"explain","style_id":"guided"}', 1000),
                      ('lesson-b2', 2, 2, 'turn.start', '{"action":"reexplain","style_id":"analogy"}', 2000)""",
        )
        conn.execute(
            """INSERT INTO kp_mastery(space_id, kp_id, p, status, evidence_count, inferred)
               VALUES ('course-b2', 'kp-b2', 0.72, 'shaky', 2, 0)""",
        )
        conn.execute(
            """INSERT INTO evidence(id, space_id, kp_id, item_ref, source, verdict, item_type,
                                    hint_level, retry, judged_by, via, p_before, p_after, lesson_id, created_at)
               VALUES ('ev-1', 'course-b2', 'kp-b2', 'q-1', 'lesson', 'correct', 'choice', 0, 0, 'exact', 'control', 0.30, 0.55, 'lesson-b2', ?),
                      ('ev-2', 'course-b2', 'kp-b2', 'q-2', 'lesson', 'correct', 'choice', 1, 0, 'exact', 'control', 0.55, 0.72, 'lesson-b2', ?)""",
            (now, now),
        )

    plan_payload = {
        "title": "极限课",
        "segments": [{"kp_id": "kp-b2", "keypoints": ["左右极限", "连续判定"]}],
        "items": {},
        "wrap": {"cards": [{"kp_id": "kp-b2", "front": "正面", "back": "背面"}]},
    }
    recap, cards = asyncio.run(
        finish_lesson(container.repository, container.gateway, "course-b2", "lesson-b2", plan_payload, {"seg_idx": 1})
    )
    assert recap["review_cards_created"] == len(cards) == 1

    # Save recap onto lesson-b2 and verify GET /recap-summary
    with container.repository.connection() as conn:
        conn.execute(
            "UPDATE lessons SET recap_json = ?, ended_at = ? WHERE id = 'lesson-b2'",
            (json.dumps(recap, ensure_ascii=False), now),
        )

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51003)) as client:
        headers = _auth_headers(container)
        summary = client.get("/api/v2/lessons/lesson-b2/recap-summary", headers=headers).json()
        assert summary["abandoned"] is False
        assert summary["review_cards_created"] == 1
        assert summary["stats"]["active_ms"] == 180000
        assert summary["stats"]["correct_count"] == 1
        assert summary["stats"]["correct_with_hint_count"] == 1
        assert summary["stats"]["style_switches"] == 1
        assert summary["stats"]["backfill_count"] == 1
        assert len(summary["mastery_changes"]) == 1
        assert summary["mastery_changes"][0]["kp_id"] == "kp-b2"
        assert summary["mastery_changes"][0]["p_before"] == 0.30
        assert summary["mastery_changes"][0]["p_after"] == 0.72
        assert summary["mastery_changes"][0]["status"] == "shaky"

        # Legacy lesson without review_cards_created returns None for that field
        legacy = client.get("/api/v2/lessons/browser-voice-lesson/recap-summary", headers=headers).json()
        assert legacy["review_cards_created"] is None


def test_b13_unified_tutor_speech_and_preview_compat(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51004)) as client:
        headers = _auth_headers(container)

        # With BrowserHarnessGateway (raises EdgeUnavailableError), /voice/speak returns unavailable cleanly
        res = client.post(
            "/api/v2/voice/speak",
            headers=headers,
            json={"character_id": "tutor-chutang", "text": "你好，我们开始吧。"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["kind"] == "unavailable"
        assert body["audio_b64"] is None
        assert body["reason_code"] == "tts_unavailable"

        # Backwards compatibility on /tts/preview
        legacy_preview = client.post(
            "/api/v2/tts/preview",
            headers=headers,
            json={"character_id": "tutor-chutang"},
        )
        assert legacy_preview.status_code == 200
        assert legacy_preview.json()["kind"] == "browser"
        assert legacy_preview.json()["warning"]

        # Rejects text longer than 240 chars
        too_long = client.post(
            "/api/v2/voice/speak",
            headers=headers,
            json={"character_id": "tutor-chutang", "text": "长" * 241},
        )
        assert too_long.status_code == 422

        # When gateway returns audio bytes, /voice/speak returns kind="audio"
        async def ok_audio(text: str, voice: str, rate: float = 1, pitch: int = 0) -> bytes:
            return b"ID3-fake-mp3-bytes"

        container.gateway.preview_voice = ok_audio  # type: ignore[method-assign]
        spoken = client.post(
            "/api/v2/voice/speak",
            headers=headers,
            json={"character_id": "tutor-chutang", "text": "这一步很棒！"},
        )
        assert spoken.status_code == 200
        spoken_body = spoken.json()
        assert spoken_body["kind"] == "audio"
        assert spoken_body["format"] == "mp3"
        assert spoken_body["audio_b64"]
        assert spoken_body["reason_code"] is None
