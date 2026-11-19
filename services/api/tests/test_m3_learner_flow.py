import json
import asyncio
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.learning.interview import TOPICS, extract_slots, map_teacher_hints, render_question
from app.learning.placement import PlacementCandidate, inferred_updates, select_candidate
from app.learning.planner import PlanningPoint, build_plan, persist_plan, stabilize_plan
from app.learning.styles import initial_lesson_style
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository


def _seed_learning_course(client: TestClient, owner_token: str, repository) -> str:
    headers = {"Authorization": f"Bearer {owner_token}"}
    course_id = client.post("/api/v2/courses", headers=headers, json={"name": "Course"}).json()["id"]
    now = utcnow().isoformat()
    item = {"stem": "Choose the supported answer.", "options": {"A": "no", "B": "yes"}, "answer": "B"}
    with repository.connection() as connection:
        connection.execute("INSERT INTO units(id, space_id, title, ord) VALUES ('u1', ?, 'Unit', 1)", (course_id,))
        for kp_id, name, order, weight in (("kp1", "Foundation", 1, 0.7), ("kp2", "Application", 2, 0.3)):
            connection.execute(
                """INSERT INTO knowledge_points(id, space_id, unit_id, name, norm_name, kind, summary,
                       importance, difficulty, ord, created_at, updated_at)
                   VALUES (?, ?, 'u1', ?, ?, 'concept', ?, 'core', 2, ?, ?, ?)""",
                (kp_id, course_id, name, name.lower(), name, order, now, now),
            )
            connection.execute(
                """INSERT INTO kp_exam_stats(kp_id, space_id, n_items, score_share, recency_weight,
                       trend, types_json, novel_json, weight, updated_at)
                   VALUES (?, ?, 1, ?, 1, 'stable', '{}', '[]', ?, ?)""",
                (kp_id, course_id, weight, weight, now),
            )
        connection.execute("INSERT INTO kp_edges VALUES (?, 'kp1', 'kp2', 'analysis')", (course_id,))
        connection.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, difficulty,
                                      item_json, verify_status, reserved, created_at)
               VALUES ('diag-1', ?, 'kp1', 'generated', 'diagnostic', 'choice', 2, ?, 'verified', 0, ?)""",
            (course_id, json.dumps(item), now),
        )
    return course_id


def test_six_topic_interview_diagnostic_and_plan_flow(client, owner_token, isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id = _seed_learning_course(client, owner_token, repository)
    headers = {"Authorization": f"Bearer {owner_token}"}
    enrollment = {"goal_type": "exam", "exam_date": "2027-02-01", "weekly_days": [1, 3, 5],
                  "session_minutes": 30, "self_level": "basic"}
    assert client.put(f"/api/v2/courses/{course_id}/enrollment", headers=headers, json=enrollment).status_code == 200

    interview_path = f"/api/v2/courses/{course_id}/interview"
    assert client.get(interview_path, headers=headers).json()["current"] == TOPICS[0]
    out_of_order = client.post(
        f"{interview_path}/answer", headers=headers, json={"topic": TOPICS[1], "values": {}},
    )
    assert out_of_order.status_code == 400
    for topic in TOPICS:
        values = {"nickname": "Lin", "level": "undergrad"} if topic == "identity" else {}
        result = client.post(f"{interview_path}/answer", headers=headers, json={"topic": topic, "values": values})
        assert result.status_code == 200
    assert result.json()["status"] == "done"
    assert client.get("/api/v2/learner/profile", headers=headers).json()["nickname"] == "Lin"

    placement = client.get(f"/api/v2/courses/{course_id}/placement", headers=headers).json()
    assert placement["question"]["item_id"] == "diag-1"
    answered = client.post(
        f"/api/v2/courses/{course_id}/placement/answer", headers=headers,
        json={"item_id": "diag-1", "answer": "B"},
    )
    assert answered.status_code == 200
    assert answered.json()["status"] == "done"
    assert set(placement["question"]) == {"item_id", "kp_id", "type", "stem", "options", "answered", "started_at"}

    planned = client.post(
        f"/api/v2/courses/{course_id}/plan", headers=headers,
        json={"today": "2027-01-01", "reason": "diagnostic"},
    )
    assert planned.status_code == 200, planned.json()
    body = planned.json()
    assert body["version"] == 1
    assert body["items"][0]["kp_ids"][0] == "kp1"
    assert body["items"][0]["why"][0]["mastery"] > 0.5
    assert client.get(f"/api/v2/courses/{course_id}/plan", headers=headers).json() == body
    adjusted = client.patch(
        f"/api/v2/plan-items/{body['items'][0]['id']}", headers=headers,
        json={"direction": "first"},
    )
    assert adjusted.status_code == 200
    assert adjusted.json()["items"][0]["pinned"] == 1
    with repository.connection() as connection:
        connection.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, difficulty,
                                      item_json, verify_status, reserved, created_at)
               VALUES ('diag-2', ?, 'kp2', 'generated', 'diagnostic', 'choice', 2, ?, 'verified', 0, ?)""",
            (course_id, json.dumps({"stem": "Choose", "options": {"A": "Yes", "B": "No"}, "answer": "A"}), utcnow().isoformat()),
        )
    item_id = body["items"][0]["id"]
    quiz = client.post(f"/api/v2/plan-items/{item_id}/skip-quiz", headers=headers, json={}).json()
    assert quiz["available"] is True
    passed = client.post(
        f"/api/v2/plan-items/{item_id}/skip-quiz", headers=headers,
        json={"answers": {"diag-1": "B", "diag-2": "A"}},
    ).json()
    assert passed["passed"] is True
    assert repository.locate_plan_item(item_id)["status"] == "skipped"
    with repository.connection() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM evidence WHERE space_id = ? AND source = 'skip_verify'", (course_id,),
        ).fetchone()[0] == 2
    repository.save_lesson_plan(
        course_id, item_id, plan={"title": "Prepared", "est_minutes": 10, "segments": [], "items": {}},
    )
    opened = client.post(f"/api/v2/plan-items/{item_id}/lesson", headers=headers)
    assert opened.status_code == 200, opened.json()
    assert opened.json()["course_id"] == course_id


def test_placement_selection_propagation_and_planner_are_deterministic():
    candidates = [
        PlacementCandidate("later", "u2", 2, 0.4, 0.5),
        PlacementCandidate("foundation", "u1", 1, 0.3, 0.5, successor_weight=0.4),
    ]
    assert select_candidate(candidates).kp_id == "foundation"
    assert inferred_updates(
        kp_id="foundation", verdict="incorrect", probability=0.2, item_type="choice",
        prerequisites={"foundation": [], "later": ["foundation"]},
        probabilities={"foundation": 0.2, "later": 0.5}, evidenced={"foundation"},
    ) == {"later": 0.3}

    points = [
        PlanningPoint("pre", "Prerequisite", "concept", 2, 1, (), 0.2, 0.2),
        PlanningPoint("target", "Target", "skill", 2, 2, ("pre",), 0.8, 0.2),
    ]
    first = build_plan(
        points, today=date(2027, 1, 1), exam_date=date(2027, 1, 30), weekly_days=[1, 3, 5],
        session_minutes=30, has_practice=set(), has_mock=False,
    )
    second = build_plan(
        points, today=date(2027, 1, 1), exam_date=date(2027, 1, 30), weekly_days=[1, 3, 5],
        session_minutes=30, has_practice=set(), has_mock=False,
    )
    assert first == second
    assert [kp for item in first["items"] for kp in item["kp_ids"]] == ["pre", "target"]


def test_plan_ready_callback_receives_the_persisted_plan_id():
    calls = []

    class Repository:
        def replace_plan(self, course_id, result, *, reason):
            assert (course_id, result, reason) == ("course", {"items": []}, "diagnostic")
            return {"id": "plan-1", "items": []}

    saved = persist_plan(
        Repository(), "course", {"items": []}, reason="diagnostic", on_plan_ready=calls.append,
    )
    assert saved["id"] == "plan-1"
    assert calls == ["plan-1"]


def test_tutor_default_style_seeds_only_unconfigured_future_lessons():
    tutor = SimpleNamespace(default_style_id="rigorous")
    first_style = initial_lesson_style(
        profile=None, tutor=tutor, explicit_profile_fields=[], plan_style=None,
    )
    assert first_style == "rigorous"

    tutor.default_style_id = "analogy"
    assert first_style == "rigorous"
    assert initial_lesson_style(
        profile={"preferred_style_id": "direct"}, tutor=tutor,
        explicit_profile_fields={"preferred_style_id"}, plan_style=None,
    ) == "direct"
    assert initial_lesson_style(
        profile={"preferred_style_id": "guided"}, tutor=tutor,
        explicit_profile_fields=set(), plan_style=None,
    ) == "analogy"
    assert initial_lesson_style(
        profile=None, tutor=tutor, explicit_profile_fields=set(), plan_style="exam",
    ) == "exam"


def test_replan_preserves_pinned_items_and_requires_a_meaningful_priority_change():
    def item(key, weight, order, *, pinned=0):
        return {
            "kind": "lesson", "kp_ids": [key], "title": key, "est_minutes": 10,
            "why": [{"kp_id": key, "weight": weight, "mastery": 0}],
            "ord": order, "status": "todo", "pinned": pinned,
        }

    previous = {"items": [item("a", 0.40, 0, pinned=1), item("b", 0.30, 1), item("c", 0.29, 2)]}
    low_churn = {"items": [item("c", 0.29, 0), item("b", 0.30, 1), item("a", 0.40, 2)]}
    result = stabilize_plan(low_churn, previous)
    assert [entry["kp_ids"][0] for entry in result["items"]] == ["a", "b", "c"]
    assert result["items"][0]["pinned"] == 1

    strong_change = {"items": [item("c", 0.50, 0), item("b", 0.30, 1), item("a", 0.20, 2)]}
    result = stabilize_plan(strong_change, previous)
    assert [entry["kp_ids"][0] for entry in result["items"]] == ["a", "c", "b"]


def test_role_rendered_interview_slot_extraction_hint_mapping_and_gold_fixture():
    class Gateway:
        async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
            if prompt_name == "live/interview_ask":
                return parse("<question>How should I address you?</question>")
            if prompt_name == "live/interview_slot":
                return parse('<slots>{"nickname":"Lin","level":"undergrad"}</slots>')
            if prompt_name == "analysis/hints_to_kp":
                return parse("<kp>kp1</kp>")
            raise AssertionError(prompt_name)

    gateway = Gateway()
    assert asyncio.run(render_question(
        gateway, topic="identity", tutor={"name": "Tutor"}, context={},
    )) == "How should I address you?"
    assert asyncio.run(extract_slots(
        gateway, topic="identity", text="Call me Lin", context={},
    )) == {"nickname": "Lin", "level": "undergrad"}
    assert asyncio.run(map_teacher_hints(
        gateway, text="Focus on the first topic", points=[{"id": "kp1", "name": "First"}],
    )) == {"kp1"}
    gold = json.loads((Path(__file__).parents[3] / "evals/gold/interview/cases.json").read_text(encoding="utf-8"))
    assert len(gold) == 30
    assert all(case["topic"] in TOPICS and case["text"] and case["expected"] is not None for case in gold)
