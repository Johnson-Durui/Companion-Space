from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import pytest

from app.repositories import migrations
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository


def _seed_plan(conn: sqlite3.Connection, space_id: str, item_id: str) -> None:
    now = utcnow().isoformat()
    conn.execute(
        "INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (space_id, "Course", "Topic", "Goal", now, now),
    )
    plan_id = f"plan:{space_id}"
    conn.execute(
        "INSERT INTO study_plans(id, space_id, version, status, created_at) VALUES (?, ?, ?, ?, ?)",
        (plan_id, space_id, 1, "active", now),
    )
    conn.execute(
        """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
           VALUES (?, ?, ?, 1, 'lesson', 'Lesson', '["kp1"]', 25)""",
        (item_id, plan_id, space_id),
    )


def test_upgrade_preserves_legacy_review_card_and_its_source(isolated_settings, monkeypatch) -> None:
    with monkeypatch.context() as patch:
        patch.setattr("app.repositories.mixins.infrastructure.CURRENT_SCHEMA_VERSION", 8)
        patch.setattr(migrations, "MIGRATIONS", tuple(m for m in migrations.MIGRATIONS if m.target_version <= 8))
        old_repository = SQLiteRepository(isolated_settings)
        with old_repository.connection() as conn:
            _seed_plan(conn, "course", "item")
            now = utcnow().isoformat()
            conn.execute(
                """INSERT INTO review_items(
                       id, space_id, prompt, answer, due_at, status, source_session_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("legacy", "course", "Prompt", "Answer", now, "pending", "old-session", now, now),
            )

    repository = SQLiteRepository(isolated_settings)
    path = isolated_settings.metadata_db_path
    with closing(sqlite3.connect(path.with_name(f"{path.name}.v8.bak"))) as backup:
        assert backup.execute("SELECT answer FROM review_items WHERE id = 'legacy'").fetchone() == ("Answer",)
    with repository.connection() as conn:
        card = conn.execute("SELECT * FROM review_cards WHERE id = 'legacy'").fetchone()
        assert (card["kind"], card["front"], card["back"], card["due_at"]) == ("flashcard", "Prompt", "Answer", now)
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'review_items'").fetchone() is None
    assert repository.list_session_review_items("old-session")[0].source_session_id == "old-session"
    assert repository.list_review_items("other-course") == []


def test_preparation_commits_generated_items_and_plan_together(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    now = utcnow().isoformat()
    with repository.connection() as conn:
        _seed_plan(conn, "course", "item")
        _seed_plan(conn, "other", "other-item")
        conn.executemany(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance, difficulty,
                                            ord, created_at, updated_at)
               VALUES (?, ?, 'Point', 'point', 'concept', 'Summary', 'core', 1, 1, ?, ?)""",
            [("kp1", "course", now, now), ("kp2", "other", now, now)],
        )
    question = {
        "id": "bank-1", "kp_id": "kp1", "purpose": "check", "type": "numeric", "difficulty": 1,
        "item": {"stem": "Enter the result", "type": "numeric", "answer": "2", "verify": {"status": "verified"}},
    }
    plan = {"items": {"c1": {**question["item"], "bank_id": question["id"], "kp_id": question["kp_id"]}}}
    with pytest.raises(ValueError, match="course"):
        repository.save_lesson_plan(
            "course", "item", plan=plan, generated_items=[question, {**question, "id": "bank-2", "kp_id": "kp2"}],
        )
    assert repository.get_lesson_plan("course", "item") is None
    with repository.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM item_bank").fetchone()[0] == 0
    saved = repository.save_lesson_plan("course", "item", plan=plan, generated_items=[question])
    assert saved["plan"] == plan
    with repository.connection() as conn:
        row = conn.execute("SELECT * FROM item_bank WHERE id = ?", (question["id"],)).fetchone()
        assert (row["space_id"], row["origin"], row["verify_status"], row["reserved"]) == (
            "course", "generated", "verified", 0,
        )
        assert "Enter the result" in row["item_json"]


def test_lesson_create_resume_replay_and_commit_are_course_scoped(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    with repository.connection() as conn:
        _seed_plan(conn, "course", "item")
        _seed_plan(conn, "other", "other-item")
    initial = {"stage": "open"}
    assert repository.create_or_resume_lesson("course", "item", state=initial) is None
    assert repository.get_plan_item("other", "item") is None
    assert repository.save_lesson_plan("other", "item", plan={}) is None

    plan = repository.save_lesson_plan("course", "item", plan={"segments": ["first"]}, model="configured")
    assert repository.get_lesson_plan("course", "item") == plan
    assert repository.get_plan_item("course", "item")["kp_ids"] == ["kp1"]
    other_plan = repository.save_lesson_plan("other", "other-item", plan={"segments": ["elsewhere"]})
    assert repository.create_or_resume_lesson(
        "course", "item", state=initial, lesson_plan_id=other_plan["id"],
    ) is None
    replacement = repository.save_lesson_plan("course", "item", plan={"segments": ["replacement"]})

    with ThreadPoolExecutor(max_workers=2) as pool:
        attempts = list(pool.map(
            lambda _: repository.create_or_resume_lesson(
                "course", "item", state=initial, lesson_plan_id=plan["id"],
            ), range(2),
        ))
    assert attempts[0] == attempts[1]
    lesson_id = attempts[0]["id"]
    assert attempts[0]["lesson_plan_id"] == plan["id"]
    assert repository.get_lesson_plan("course", "item") == replacement
    assert repository.get_lesson_plan("course", "item", lesson_plan_id=plan["id"]) == plan
    assert repository.get_plan_item("course", "item")["lesson_id"] == lesson_id
    assert repository.get_lesson("other", lesson_id) is None

    state = {"stage": "segment", "active_ask": "item-ref"}
    board = {"pages": [{"blocks": [{"id": "b1"}]}]}
    events = [{"type": "board", "data": {"id": "b1"}, "t_ms": 10}, {"type": "ask", "data": {}, "t_ms": 20}]
    assert repository.append_lesson_events(
        "other", lesson_id, gen=1, events=events, state=state, board=board, status="paused", expected_seq=0,
    ) is None
    recorded = repository.append_lesson_events(
        "course", lesson_id, gen=1, events=events, state=state, board=board, status="paused", expected_seq=0,
    )
    assert [event["seq"] for event in recorded] == [1, 2]
    assert repository.list_lesson_events("course", lesson_id, after=1) == [recorded[1]]
    assert repository.list_lesson_events("other", lesson_id) == []
    reopened = SQLiteRepository(isolated_settings)
    resumed = reopened.create_or_resume_lesson("course", "item", state=initial)
    assert (resumed["state"], resumed["board"], resumed["status"], resumed["seq"]) == (state, board, "paused", 2)

    with pytest.raises(ValueError, match="sequence"):
        reopened.append_lesson_events(
            "course", lesson_id, gen=1, events=events, state=initial, board=None, status="active", expected_seq=0,
        )
    assert reopened.list_lesson_events("course", lesson_id) == recorded
    assert reopened.get_lesson("course", lesson_id) == resumed

    with pytest.raises(ValueError, match="generation"):
        reopened.append_lesson_events(
            "course", lesson_id, gen=0, events=events, state=initial, board=None, status="active", expected_seq=2,
        )

    with pytest.raises(sqlite3.IntegrityError):
        reopened.append_lesson_events(
            "course", lesson_id, gen=2, events=[events[0], {**events[1], "t_ms": -1}],
            state=initial, board=None, status="active", expected_seq=2,
        )
    assert reopened.list_lesson_events("course", lesson_id) == recorded
    assert reopened.get_lesson("course", lesson_id) == resumed

    reopened.append_lesson_events(
        "course", lesson_id, gen=2, events=[{"type": "state", "data": {}, "t_ms": 30}],
        state={"stage": "done"}, board=board, status="done", expected_seq=2, recap={"learned": []},
    )
    finished = reopened.get_lesson("course", lesson_id)
    assert finished["ended_at"] and finished["recap"] == {"learned": []}
    assert reopened.get_plan_item("course", "item")["status"] == "done"
    assert reopened.create_or_resume_lesson("course", "item", state=initial) == finished
    assert reopened.delete_space("course")
    assert reopened.list_lesson_events("course", lesson_id) == []
    assert reopened.get_plan_item("other", "other-item") is not None
