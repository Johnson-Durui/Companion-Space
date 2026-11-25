import json
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.analysis.course_data import CourseData
from app.analysis.models import CourseInput
from app.api.deps import get_container
from app.learning.practice import get_run, preview_run, save_answer, start_run, submit_run
from app.main import create_app
from app.providers.errors import ProviderUnavailableError
from app.services.repository import SQLiteRepository
from app.services.browser_session import CSRF_COOKIE_NAME, CSRF_HEADER_NAME
from fakes.teaching import LessonTestGateway


def _seed(repository: SQLiteRepository, kind: str = "practice") -> str:
    course_id = CourseData(repository).create_course(CourseInput(name="Practice course")).id
    repository.upsert_course_enrollment(course_id, {"self_level": "basic"})
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc).isoformat()
    item = {"stem": "2 + 2 = ?", "options": {"A": "3", "B": "4"}, "answer": "B", "solution": "Add two twice.", "verify": {"status": "verified"}}
    with repository.connection() as conn:
        conn.execute("INSERT INTO knowledge_points(id,space_id,name,norm_name,kind,summary,importance,difficulty,ord,created_at,updated_at) VALUES ('kp1',?,'Addition','addition','skill','Add','core',1,1,?,?)", (course_id, now, now))
        conn.execute("INSERT INTO study_plans(id,space_id,version,status,created_at) VALUES ('plan',?,1,'active',?)", (course_id, now))
        conn.execute("INSERT INTO plan_items(id,plan_id,space_id,ord,kind,title,kp_ids_json,est_minutes) VALUES ('work','plan',?,1,?,'Timed work','[\"kp1\"]',10)", (course_id, kind))
        conn.execute("INSERT INTO item_bank(id,space_id,kp_id,origin,purpose,type,item_json,verify_status,created_at) VALUES ('q1',?,'kp1','generated','practice','choice',?,'verified',?)", (course_id, json.dumps(item), now))
        if kind == "mock":
            conn.execute("INSERT INTO materials(id,space_id,title,kind,filename,storage_path,created_at,updated_at) VALUES ('mat',?,'Paper','document','paper.md','paper.md',?,?)", (course_id, now, now))
            conn.execute("INSERT INTO exam_papers(id,space_id,material_id,name,full_score,reserved_for_mock) VALUES ('paper',?,'mat','Paper',5,1)", (course_id,))
            conn.execute("INSERT INTO exam_items(id,space_id,paper_id,material_id,no,type,stem,answer,solution,score,answer_status,created_at) VALUES ('exam-q',?,'paper','mat','1','choice','2 + 2 = ?','B','Add two twice.',5,'verified',?)", (course_id, now))
            conn.execute("UPDATE item_bank SET exam_item_id='exam-q' WHERE id='q1'")
    return course_id


def test_timed_practice_scores_verified_items_and_creates_wrong_card(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id = _seed(repository)
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)

    run = start_run(repository, "work", now=now)
    assert run["deadline_at"] == "2026-11-17T09:10:00+00:00"
    assert "answer" not in run["items"][0]
    assert save_answer(repository, run["id"], "q1", "A", now=now)
    result = submit_run(repository, run["id"], now=now)

    assert (result["score"], result["max_score"]) == (0, 1)
    assert result["debrief"][0]["solution"] == "Add two twice."
    assert result["debrief"][0]["moves"] == ["SHOW_SOLUTION", "REEXPLAIN", "CHECK"]
    assert start_run(repository, "work", now=now)["id"] == run["id"]
    with repository.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence WHERE space_id=? AND source='practice'", (course_id,)).fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM review_cards WHERE space_id=? AND item_ref='q1'", (course_id,)).fetchone()[0] == 1


def test_practice_rejects_answers_after_deadline(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    run = start_run(repository, "work", now=now)
    assert not save_answer(repository, run["id"], "q1", "B", now=datetime(2026, 11, 17, 9, 11, tzinfo=timezone.utc))


def test_reserved_exam_uses_original_points(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository, "mock")
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    run = start_run(repository, "work", now=now)
    assert save_answer(repository, run["id"], "q1", "B", now=now)
    result = submit_run(repository, run["id"], now=now)
    assert (result["score"], result["max_score"]) == (5, 5)


def test_progress_api_reports_time_mastery_and_course_score_scale(client: TestClient, owner_token: str, isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id = _seed(repository)
    response = client.get(
        f"/api/v2/courses/{course_id}/progress", headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert response.status_code == 200
    assert response.json()["score_scale"] == 100
    assert response.json()["points"][0]["name"] == "Addition"


def test_submitted_item_can_request_verified_live_commentary(isolated_settings):
    app = create_app(settings=isolated_settings, gateway_factory=LessonTestGateway)
    container = app.dependency_overrides[get_container]()
    _seed(container.repository)
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    run = start_run(container.repository, "work", now=now)
    assert save_answer(container.repository, run["id"], "q1", "A", now=now)
    submit_run(container.repository, run["id"], now=now)

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        assert client.post("/api/v2/session/bootstrap").status_code == 200
        headers = {CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME], "Origin": "http://127.0.0.1:8000"}
        response = client.post(
            f"/api/v2/practice/{run['id']}/debrief/q1", json={"move": "SHOW_SOLUTION"}, headers=headers,
        )

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert response.json()["commentary"] == "Think about the rule."
    assert "Add two twice." in container.gateway.prompts[-1]
    assert "Do not invent examples, facts, questions" in container.gateway.prompts[-1]


def test_live_commentary_failure_keeps_verified_solution_recoverable(isolated_settings):
    class FailingGateway(LessonTestGateway):
        async def stream_text(self, role, system, messages, **options):
            if False:
                yield ""
            raise ProviderUnavailableError(provider="test", public_detail="offline")

    app = create_app(settings=isolated_settings, gateway_factory=FailingGateway)
    container = app.dependency_overrides[get_container]()
    _seed(container.repository)
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    run = start_run(container.repository, "work", now=now)
    assert save_answer(container.repository, run["id"], "q1", "A", now=now)
    submitted = submit_run(container.repository, run["id"], now=now)

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        assert client.post("/api/v2/session/bootstrap").status_code == 200
        headers = {CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME], "Origin": "http://127.0.0.1:8000"}
        response = client.post(
            f"/api/v2/practice/{run['id']}/debrief/q1", json={"move": "REEXPLAIN"}, headers=headers,
        )

    assert response.status_code == 200
    assert response.json()["available"] is False
    assert "verified solution remains available" in response.json()["reason"]
    assert submitted["debrief"][0]["solution"] == "Add two twice."


def test_practice_run_survives_deleted_item_bank_entries(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    course_id = _seed(repository)
    now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
    q2 = {
        "stem": "3 + 3 = ?",
        "options": {"A": "5", "B": "6"},
        "answer": "B",
        "solution": "Add three twice.",
        "verify": {"status": "verified"},
    }
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO item_bank(id,space_id,kp_id,origin,purpose,type,item_json,verify_status,created_at)
               VALUES ('q2',?,'kp1','generated','practice','choice',?,'verified',?)""",
            (course_id, json.dumps(q2), now.isoformat()),
        )

    run = start_run(repository, "work", now=now)
    assert [item["id"] for item in run["items"]] == ["q1", "q2"]
    assert save_answer(repository, run["id"], "q1", "B", now=now)

    # Delete one item from item_bank (simulating material deletion / re-analysis)
    with repository.connection() as conn:
        conn.execute("DELETE FROM item_bank WHERE id = 'q2'")

    preview = preview_run(repository, "work")
    assert preview is not None and preview["item_count"] == 1

    active = get_run(repository, run["id"], reveal=False)
    assert [item["id"] for item in active["items"]] == ["q1"]

    # Reveal before submission should still fill safe defaults when verdict/score are missing
    unsubmitted_reveal = get_run(repository, run["id"], reveal=True)
    assert len(unsubmitted_reveal["debrief"]) == 1
    assert unsubmitted_reveal["debrief"][0]["verdict"] == "dont_know"
    assert unsubmitted_reveal["debrief"][0]["score"] == 0.0
    assert unsubmitted_reveal["debrief"][0]["max_score"] == 1.0

    submitted = submit_run(repository, run["id"], now=now)
    assert [item["id"] for item in submitted["items"]] == ["q1"]
    assert [entry["item_id"] for entry in submitted["debrief"]] == ["q1"]
    assert submitted["debrief"][0]["verdict"] == "correct"

    # Deleting ALL items in item_bank should still not crash get_run or preview_run
    with repository.connection() as conn:
        conn.execute("DELETE FROM item_bank WHERE space_id = ?", (course_id,))
    emptied = get_run(repository, run["id"], reveal=True)
    assert emptied["items"] == []
    assert emptied["debrief"] == []
    assert preview_run(repository, "work")["item_count"] == 0

    # Empty item_refs_json must not fail with SQLite IN () syntax error
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO practice_runs
               (id, space_id, plan_item_id, kind, item_refs_json, duration_seconds, status, started_at, deadline_at)
               VALUES ('empty-run', ?, 'work', 'practice', '[]', 600, 'active', ?, ?)""",
            (course_id, now.isoformat(), now.isoformat()),
        )
    assert get_run(repository, "empty-run", reveal=True)["items"] == []
    submitted_empty = submit_run(repository, "empty-run", now=now)
    assert submitted_empty["items"] == []
    assert submitted_empty["debrief"] == []
