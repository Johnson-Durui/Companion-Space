import asyncio
import json

from app.api.deps import get_container
from app.main import create_app
from app.repositories.mixins.common import utcnow
from app.teaching.runtime import LessonRuntime
from fakes.teaching import LessonTestGateway
from test_teaching_storage import _seed_plan


def test_text_lesson_resume_answer_and_finish_are_persistent(isolated_settings):
    app = create_app(settings=isolated_settings, gateway_factory=LessonTestGateway)
    container = app.dependency_overrides[get_container]()
    repository = container.repository
    item = {
        "type": "numeric", "kp_id": "kp1", "bank_id": "bank-1", "keypoints": [0],
        "stem": "What is the next score?", "answer": "314", "verify": {"status": "verified"},
    }
    with repository.connection() as conn:
        _seed_plan(conn, "course", "plan-item")
        now = utcnow().isoformat()
        conn.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, created_at, updated_at)
               VALUES ('kp1', 'course', 'A procedure', 'procedure', 'concept', 'A procedure', 'core', 1, 1, ?, ?)""",
            (now, now),
        )
        conn.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES ('bank-1', 'course', 'kp1', 'generated', 'check', 'numeric', ?, 'verified', ?)""",
            (json.dumps(item), now),
        )
    plan = {
        "title": "Lesson",
        "segments": [{
            "id": "s1", "kp_id": "kp1", "keypoints": ["A procedure"], "checks": ["q1"],
            "approaches": [{"kind": "visual", "keypoint": "all", "outline": "Read the source"}],
        }],
        "items": {"q1": item},
    }
    repository.save_lesson_plan("course", "plan-item", plan=plan)
    repository.upsert_course_enrollment("course", {})
    lesson = repository.create_or_resume_lesson("course", "plan-item", state={"stage": "opening"})
    lesson_id = lesson["id"]

    async def run():
        runtime = LessonRuntime(repository, container.gateway, "course", lesson_id)
        await runtime.step({"type": "control", "action": "pause"})
        result = await runtime.step({"type": "lesson_resume"})
        assert any(event["type"] == "board" for event in result)
        assert next(event["data"]["move"] for event in result if event["type"] == "beat.start") == "OPEN"
        prepared = await runtime.prepare_next()
        assert prepared is not None
        prepared_calls = len(container.gateway.prompts)
        await runtime.step({"type": "beat_done"}, prepared=prepared)
        assert len(container.gateway.prompts) == prepared_calls
        call_count = len(container.gateway.prompts)
        replay = await runtime.step({"type": "lesson_resume"})
        assert next(event["data"]["move"] for event in replay if event["type"] == "beat.start") == "EXPLAIN"
        assert len(container.gateway.prompts) == call_count
        result = await runtime.step({"type": "beat_done"})
        ask = next(event["data"] for event in result if event["type"] == "ask")
        assert ask["widget"]["stem"] == item["stem"]
        assert "314" not in json.dumps(ask)
        assert all("314" not in prompt for prompt in container.gateway.prompts)

        resumed = LessonRuntime(repository, container.gateway, "course", lesson_id)
        result = await resumed.step({"type": "silence"}, elapsed_ms=60_000)
        assert next(event["data"]["move"] for event in result if event["type"] == "beat.start") == "NUDGE"
        await resumed.step({"type": "silence"}, elapsed_ms=60_000)
        paused = repository.get_lesson("course", lesson_id)
        assert paused["status"] == "paused" and paused["state"]["active_ms"] == 120_000
        with repository.connection() as conn:
            assert conn.execute("SELECT COUNT(*) FROM evidence WHERE lesson_id = ?", (lesson_id,)).fetchone()[0] == 0
        call_count = len(container.gateway.prompts)
        result = await resumed.step({"type": "lesson_resume"})
        assert next(event["data"] for event in result if event["type"] == "ask") == ask
        assert len(container.gateway.prompts) == call_count
        with repository.connection() as conn:
            conn.execute("DELETE FROM item_bank WHERE id = 'bank-1'")
        answer = {"type": "student_answer", "item_id": "q1", "value": "314", "via": "control"}
        hint = await resumed.step({**answer, "value": "271"})
        assert next(event["data"]["move"] for event in hint if event["type"] == "beat.start") == "HINT"
        assert "314" not in json.dumps(hint)
        result = await resumed.step(answer)
        assert next(event["data"] for event in result if event["type"] == "judge") == {
            "item_id": "q1", "verdict": "correct",
        }
        assert any(event["data"].get("stale") for event in await resumed.step(answer))
        await resumed.step({"type": "control", "action": "end"})
        await resumed.step({"type": "beat_done"})

    try:
        asyncio.run(run())
    finally:
        container.close()
    with repository.connection() as conn:
        evidence = conn.execute(
            "SELECT verdict, retry, p_before, p_after FROM evidence WHERE lesson_id = ? ORDER BY rowid", (lesson_id,),
        ).fetchall()
        cards = conn.execute(
            "SELECT item_ref FROM review_cards WHERE space_id = ? AND source_lesson_id = ?", ("course", lesson_id),
        ).fetchall()
        approach = conn.execute("SELECT n, success FROM approach_stats WHERE kind = 'visual'").fetchone()
    assert [(row["verdict"], row["retry"]) for row in evidence] == [("incorrect", 0), ("correct", 1)]
    assert evidence[0]["p_after"] < evidence[0]["p_before"]
    assert evidence[1]["p_after"] > evidence[1]["p_before"]
    assert [row["item_ref"] for row in cards] == ["bank-1"]
    assert tuple(approach) == (1, 0)
    finished = repository.get_lesson("course", lesson_id)
    assert finished["status"] == "done"
    assert finished["recap"]["items_done"] == {"q1": "correct"}
    assert finished["recap"]["summary"] == "The learner answered the check correctly."
    current_plan = repository.current_plan("course")
    assert current_plan["version"] == 2
    assert current_plan["reason"] == "lesson_finished"
