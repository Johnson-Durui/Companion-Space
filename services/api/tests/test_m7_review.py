import json
from datetime import date, datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.analysis.course_data import CourseData
from app.analysis.models import CourseInput
from app.learning.review import answer_item, rate_flashcard
from app.services.repository import SQLiteRepository


def _seed(repository: SQLiteRepository) -> tuple[str, datetime]:
    course_id = CourseData(repository).create_course(CourseInput(name="Review course")).id
    repository.upsert_course_enrollment(course_id, {"self_level": "basic"})
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    item = {
        "type": "choice", "stem": "2 + 2 = ?", "options": {"A": "3", "B": "4"},
        "answer": "B", "verify": {"status": "verified"},
    }
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO knowledge_points
               (id, space_id, name, norm_name, kind, summary, importance, difficulty, ord, created_at, updated_at)
               VALUES ('kp1', ?, 'Addition', 'addition', 'skill', 'Add values', 'core', 1, 1, ?, ?)""",
            (course_id, now.isoformat(), now.isoformat()),
        )
        conn.execute(
            """INSERT INTO item_bank
               (id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES ('item1', ?, 'kp1', 'generated', 'check', 'choice', ?, 'verified', ?)""",
            (course_id, json.dumps(item), now.isoformat()),
        )
        conn.executemany(
            """INSERT INTO review_cards
               (id, space_id, kp_id, kind, front, back, item_ref, due_at, state, created_at, updated_at)
               VALUES (?, ?, 'kp1', ?, ?, ?, ?, ?, 'pending', ?, ?)""",
            [
                ("flash1", course_id, "flashcard", "2 + 2", "4", None, now.isoformat(), now.isoformat(), now.isoformat()),
                ("item-card", course_id, "item", "2 + 2 = ?", "B", "item1", now.isoformat(), now.isoformat(), now.isoformat()),
            ],
        )
    return course_id, now


def test_flashcards_use_fsrs_without_creating_mastery_evidence(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id, now = _seed(repository)

    reviewed = rate_flashcard(repository, "flash1", "good", now=now)

    assert reviewed["state"] == "active"
    assert reviewed["fsrs"]["last_review"] == now.isoformat()
    assert reviewed["due_at"] > now.isoformat()
    with repository.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence WHERE space_id = ?", (course_id,)).fetchone()[0] == 0


def test_item_review_updates_mastery_and_archives_after_two_clean_days(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id, now = _seed(repository)

    wrong = answer_item(repository, "item-card", "A", now=now)
    same_day = answer_item(repository, "item-card", "B", now=now + timedelta(hours=1))
    next_day = answer_item(repository, "item-card", "B", now=now + timedelta(days=1))

    assert wrong["rating"] == "again"
    assert same_day["state"] == "active"
    assert next_day["state"] == "archived"
    with repository.connection() as conn:
        mastery = conn.execute(
            "SELECT evidence_count, clean_correct_count, clean_days FROM kp_mastery WHERE space_id = ? AND kp_id = 'kp1'",
            (course_id,),
        ).fetchone()
        assert tuple(mastery) == (3, 1, 2)
        details = json.loads(conn.execute(
            "SELECT detail_json FROM evidence WHERE space_id = ? AND verdict = 'incorrect'",
            (course_id,),
        ).fetchone()[0])
        assert details["answer"] == "A"


def test_due_queue_and_mistake_book_are_course_scoped(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id, now = _seed(repository)
    answer_item(repository, "item-card", "A", now=now)

    queue = repository.due_review_cards(course_id, due_at=now.isoformat())
    mistakes = repository.mistake_cards(course_id)

    assert [card["id"] for card in queue] == ["flash1"]
    assert mistakes[0]["original_mistake"]["detail"]["answer"] == "A"


def test_review_api_hides_item_solution_and_applies_rating(client: TestClient, owner_token: str, isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id, _ = _seed(repository)
    headers = {"Authorization": f"Bearer {owner_token}"}

    response = client.get(f"/api/v2/courses/{course_id}/review", headers=headers)
    assert response.status_code == 200
    cards = response.json()["cards"]
    item = next(card for card in cards if card["kind"] == "item")
    assert "back" not in item and item["item"]["options"]["B"] == "4"
    rated = client.post("/api/v2/review/cards/flash1/rate", headers=headers, json={"rating": "good"})
    assert rated.status_code == 200
    assert rated.json()["state"] == "active"


def test_course_dashboard_batches_today_review_and_score_projection(
    client: TestClient, owner_token: str, isolated_settings,
):
    repository = SQLiteRepository(isolated_settings)
    course_id, _ = _seed(repository)
    today = date.today()
    repository.upsert_course_enrollment(course_id, {
        "exam_date": (today + timedelta(days=10)).isoformat(), "full_score": 120,
    })
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO study_plans(id,space_id,version,status,created_at) VALUES ('today-plan',?,1,'active',?)",
            (course_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.execute(
            """INSERT INTO plan_items(id,plan_id,space_id,ord,kind,title,kp_ids_json,
                                      est_minutes,scheduled_date,status)
               VALUES ('today-lesson','today-plan',?,0,'lesson','Addition','[\"kp1\"]',20,?,'todo')""",
            (course_id, today.isoformat()),
        )
        conn.execute(
            """INSERT INTO kp_exam_stats(kp_id,space_id,n_items,score_share,recency_weight,
                                         trend,weight,updated_at)
               VALUES ('kp1',?,1,1,1,'stable',1,?)""",
            (course_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.execute(
            "INSERT INTO kp_mastery(space_id,kp_id,p,status) VALUES (?,'kp1',0.5,'learning')",
            (course_id,),
        )
    auth = {"Authorization": f"Bearer {owner_token}"}
    unplanned = client.post(
        "/api/v2/courses", json={"name": "Unplanned"}, headers=auth,
    ).json()["id"]
    response = client.get("/api/v2/courses/dashboard", headers=auth)
    assert response.status_code == 200
    summary = next(item for item in response.json() if item["course_id"] == course_id)
    assert {
        k: summary[k]
        for k in ("course_id", "has_plan", "due_review_count", "remaining_days", "secured_score", "score_scale")
    } == {
        "course_id": course_id, "has_plan": True, "due_review_count": 2,
        "remaining_days": 10, "secured_score": 60.0, "score_scale": 120.0,
    }
    assert summary["today_lesson"] == {
        "id": "today-lesson", "title": "Addition", "est_minutes": 20,
        "status": "todo", "kind": "lesson", "lesson_id": None,
    }
    assert summary["today_practice"] is None
    assert summary["lesson_index"] == 1
    assert summary["lesson_total"] == 1
    assert summary["journey"]["stage"] == "learning"
    unplanned_summary = next(item for item in response.json() if item["course_id"] == unplanned)
    assert unplanned_summary["has_plan"] is False
    assert unplanned_summary["today_lesson"] is None
    assert unplanned_summary["journey"]["stage"] == "needs_materials"
    assert client.get("/api/v2/courses/dashboard").status_code == 401


def test_warmup_prioritizes_direct_prerequisites(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id, now = _seed(repository)
    with repository.connection() as conn:
        for kp_id, order in (("kp2", 2), ("kp3", 3)):
            conn.execute("INSERT INTO knowledge_points(id,space_id,name,norm_name,kind,summary,importance,difficulty,ord,created_at,updated_at) VALUES (?,?,?,?,'skill','', 'core',1,?,?,?)", (kp_id, course_id, kp_id, kp_id, order, now.isoformat(), now.isoformat()))
        conn.execute("INSERT INTO kp_edges(space_id,from_kp,to_kp,source) VALUES (?,'kp1','kp2','analysis')", (course_id,))
        conn.execute("INSERT INTO study_plans(id,space_id,version,status,created_at) VALUES ('plan',?,1,'active',?)", (course_id, now.isoformat()))
        conn.execute("INSERT INTO plan_items(id,plan_id,space_id,ord,kind,title,kp_ids_json,est_minutes) VALUES ('lesson','plan',?,1,'lesson','Target','[\"kp2\"]',20)", (course_id,))
        conn.execute("INSERT INTO review_cards(id,space_id,kp_id,kind,front,back,due_at,state,created_at,updated_at) VALUES ('other',?,'kp3','flashcard','x','y',?,'pending',?,?)", (course_id, (now - timedelta(days=1)).isoformat(), now.isoformat(), now.isoformat()))
    cards = repository.due_review_cards(course_id, due_at=now.isoformat(), plan_item_id="lesson", limit=5)
    assert cards[0]["kp_id"] == "kp1"
