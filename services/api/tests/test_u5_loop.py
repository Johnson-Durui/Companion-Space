import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.analysis.course_data import CourseData
from app.analysis.models import CourseInput
from app.learning.planner import compute_plan_diff
from app.learning.practice import get_run, save_answer, start_run, submit_run
from app.services.repository import SQLiteRepository


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def test_b4b_plan_diff_on_read_and_recap(client: TestClient, owner_token: str, isolated_settings):
    repo = SQLiteRepository(isolated_settings)
    course_id = CourseData(repo).create_course(CourseInput(name="Plan Diff Course")).id
    now = datetime(2026, 11, 20, 10, 0, tzinfo=timezone.utc).isoformat()
    with repo.connection() as conn:
        for idx, (kp_id, name) in enumerate(
            [("kp-a", "极限定义"), ("kp-b", "连续性"), ("kp-c", "导数概念"), ("kp-d", "中值定理")], 1
        ):
            conn.execute(
                """INSERT INTO knowledge_points
                   (id, space_id, name, norm_name, kind, summary, importance, difficulty, ord, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'concept', ?, 'core', 2, ?, ?, ?)""",
                (kp_id, course_id, name, kp_id, name, idx, now, now),
            )

    repo.replace_plan(
        course_id,
        {
            "items": [
                {"kind": "lesson", "title": "极限定义", "kp_ids": ["kp-a"], "est_minutes": 20, "why": []},
                {"kind": "lesson", "title": "连续性", "kp_ids": ["kp-b"], "est_minutes": 20, "why": []},
                {"kind": "lesson", "title": "中值定理", "kp_ids": ["kp-d"], "est_minutes": 20, "why": []},
            ],
            "deferred": [],
            "params": {},
        },
        reason="setup",
    )
    first = client.get(f"/api/v2/courses/{course_id}/plan", headers=_headers(owner_token))
    assert first.status_code == 200
    assert first.json().get("diff") is None

    # Version 2: kp-b moved earlier (1 -> 0), kp-a moved later (0 -> 1), kp-c added, kp-d deferred
    repo.replace_plan(
        course_id,
        {
            "items": [
                {"kind": "lesson", "title": "连续性", "kp_ids": ["kp-b"], "est_minutes": 20, "why": []},
                {"kind": "lesson", "title": "极限定义", "kp_ids": ["kp-a"], "est_minutes": 20, "why": []},
                {"kind": "lesson", "title": "导数概念", "kp_ids": ["kp-c"], "est_minutes": 20, "why": []},
            ],
            "deferred": ["kp-d"],
            "params": {},
        },
        reason="lesson_finished",
    )
    second = client.get(f"/api/v2/courses/{course_id}/plan", headers=_headers(owner_token))
    assert second.status_code == 200
    diff = second.json()["diff"]
    assert diff is not None
    assert [item["title"] for item in diff["moved_earlier"]] == ["连续性"]
    assert [item["title"] for item in diff["moved_later"]] == ["极限定义"]
    assert [item["title"] for item in diff["added"]] == ["导数概念"]
    assert diff["deferred"] == [{"kp_id": "kp-d", "kp_name": "中值定理"}]

    # Unit check pure helper directly
    pure = compute_plan_diff([], ["kp-d"], [], [], {"kp-d": "中值定理"})
    assert pure["deferred"] == [{"kp_id": "kp-d", "kp_name": "中值定理"}]


def test_b5_progress_weekly_minutes_timeline_and_week_summary(
    client: TestClient, owner_token: str, isolated_settings,
):
    repo = SQLiteRepository(isolated_settings)
    course_id = CourseData(repo).create_course(CourseInput(name="Progress Course")).id
    other_course_id = CourseData(repo).create_course(CourseInput(name="Other Course")).id
    repo.upsert_course_enrollment(course_id, {"full_score": 100, "target_score": 85})
    now = datetime.now(timezone.utc)
    start_iso = (now - timedelta(minutes=25)).isoformat()
    end_iso = now.isoformat()
    with repo.connection() as conn:
        conn.execute("INSERT INTO units(id, space_id, title, ord) VALUES ('u1', ?, '第一章', 1)", (course_id,))
        conn.execute(
            """INSERT INTO knowledge_points
               (id, space_id, unit_id, name, norm_name, kind, summary, importance, difficulty, ord, created_at, updated_at)
               VALUES ('kp1', ?, 'u1', '链式法则', 'chain', 'method', '复合求导', 'core', 2, 1, ?, ?)""",
            (course_id, start_iso, end_iso),
        )
        conn.execute(
            """INSERT INTO kp_exam_stats(kp_id, space_id, n_items, score_share, recency_weight, trend, weight, updated_at)
               VALUES ('kp1', ?, 3, 0.4, 1.0, 'up', 0.4, ?)""",
            (course_id, end_iso),
        )
        conn.execute(
            """INSERT INTO kp_mastery(space_id, kp_id, p, status, evidence_count)
               VALUES (?, 'kp1', 0.72, 'learning', 2)""",
            (course_id,),
        )
        conn.execute(
            """INSERT INTO evidence
               (id, space_id, kp_id, item_ref, source, verdict, item_type, judged_by, via, p_before, p_after, created_at)
               VALUES ('ev1', ?, 'kp1', 'i1', 'classroom', 'incorrect', 'choice', 'exact', 'control', 0.5, 0.35, ?),
                      ('ev2', ?, 'kp1', 'i2', 'review', 'correct', 'choice', 'exact', 'control', 0.35, 0.72, ?)""",
            (course_id, start_iso, course_id, end_iso),
        )
        conn.execute(
            "INSERT INTO study_plans(id, space_id, version, status, created_at) VALUES ('p1', ?, 1, 'active', ?)",
            (course_id, start_iso),
        )
        conn.execute(
            """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes, status)
               VALUES ('pi1', 'p1', ?, 0, 'lesson', '链式法则', '["kp1"]', 25, 'done')""",
            (course_id,),
        )
        conn.execute(
            """INSERT INTO lessons(id, space_id, plan_item_id, status, started_at, ended_at, state_json, recap_json)
               VALUES ('les1', ?, 'pi1', 'done', ?, ?, ?, ?)""",
            (course_id, start_iso, end_iso, json.dumps({"active_ms": 1_500_000}), json.dumps({"summary": "第一句小结。\n第二句细节。"})),
        )

    prog = client.get(f"/api/v2/courses/{course_id}/progress", headers=_headers(owner_token))
    assert prog.status_code == 200
    body = prog.json()
    assert body["target_score"] == 85.0
    assert body["lessons_completed"] == 1
    assert body["has_exam_stats"] is True
    assert len(body["weekly_minutes"]) == 8
    assert sum(entry["minutes"] for entry in body["weekly_minutes"]) >= 25
    assert body["points"][0]["unit_title"] == "第一章"
    assert body["points"][0]["weight"] == 0.4
    assert body["points"][0]["evidence_count"] == 2

    timeline = client.get(f"/api/v2/courses/{course_id}/kps/kp1/timeline", headers=_headers(owner_token))
    assert timeline.status_code == 200
    t_body = timeline.json()
    assert t_body["kp_name"] == "链式法则"
    assert len(t_body["events"]) == 2
    assert t_body["events"][0]["verdict"] == "correct"
    assert t_body["events"][1]["verdict"] == "incorrect"

    # Cross-course isolation
    cross = client.get(f"/api/v2/courses/{other_course_id}/kps/kp1/timeline", headers=_headers(owner_token))
    assert cross.status_code == 404

    week = client.get("/api/v2/learner/week-summary", headers=_headers(owner_token))
    assert week.status_code == 200
    w_body = week.json()
    assert len(w_body["days"]) == 7
    assert w_body["total_minutes"] >= 25
    assert w_body["lessons_completed"] == 1
    assert w_body["streak_days"] >= 1


def test_b6_history_includes_duration_summary_and_keypoints(client: TestClient, owner_token: str, isolated_settings):
    repo = SQLiteRepository(isolated_settings)
    course_id = CourseData(repo).create_course(CourseInput(name="History Course")).id
    now = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
    started = (now - timedelta(minutes=18)).isoformat()
    ended = now.isoformat()
    with repo.connection() as conn:
        conn.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance, difficulty, ord, created_at, updated_at)
               VALUES ('kp1', ?, '定积分', 'int', 'concept', '定积分', 'core', 2, 1, ?, ?)""",
            (course_id, started, ended),
        )
        conn.execute("INSERT INTO study_plans(id, space_id, version, status, created_at) VALUES ('pl1', ?, 1, 'active', ?)", (course_id, started))
        conn.execute(
            "INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes) VALUES ('item1', 'pl1', ?, 0, 'lesson', '定积分入门', '[\"kp1\"]', 20)",
            (course_id,),
        )
    saved_lp = repo.save_lesson_plan(
        course_id,
        "item1",
        plan={"title": "定积分入门", "est_minutes": 20, "segments": [{"id": "s1", "kp_id": "kp1", "keypoints": ["定义", "几何意义"], "checks": []}], "items": {}},
    )
    with repo.connection() as conn:
        conn.execute(
            """INSERT INTO lessons(id, space_id, plan_item_id, lesson_plan_id, status, started_at, ended_at, state_json, recap_json)
               VALUES ('l-hist', ?, 'item1', ?, 'done', ?, ?, ?, ?)""",
            (course_id, saved_lp["id"], started, ended, json.dumps({"active_ms": 1_080_000}), json.dumps({"summary": "今天理清了定积分的定义和几何意义。\n下次练换元法。"})),
        )

    res = client.get(f"/api/v2/courses/{course_id}/history", headers=_headers(owner_token))
    assert res.status_code == 200
    lesson = res.json()["lessons"][0]
    assert lesson["active_ms"] == 1_080_000
    assert lesson["summary_first_line"] == "今天理清了定积分的定义和几何意义。"
    assert lesson["keypoints_done"] == 2
    assert lesson["keypoints_total"] == 2


def test_b7_practice_preview_restore_and_debrief_details(client: TestClient, owner_token: str, isolated_settings):
    repo = SQLiteRepository(isolated_settings)
    course_id = CourseData(repo).create_course(CourseInput(name="Practice B7")).id
    repo.upsert_course_enrollment(course_id, {"self_level": "basic"})
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    q1 = {"stem": "1 + 1 = ?", "options": {"A": "1", "B": "2"}, "answer": "B", "solution": "基础加法。", "verify": {"status": "verified"}}
    q2 = {"stem": "3 × 3 = ?", "options": {"A": "6", "B": "9"}, "answer": "B", "solution": "基础乘法。", "verify": {"status": "verified"}}
    with repo.connection() as conn:
        conn.execute("INSERT INTO knowledge_points(id,space_id,name,norm_name,kind,summary,importance,difficulty,ord,created_at,updated_at) VALUES ('kp1',?,'四则运算','arith','skill','运算','core',1,1,?,?)", (course_id, now_iso, now_iso))
        conn.execute("INSERT INTO study_plans(id,space_id,version,status,created_at) VALUES ('sp1',?,1,'active',?)", (course_id, now_iso))
        conn.execute("INSERT INTO plan_items(id,plan_id,space_id,ord,kind,title,kp_ids_json,est_minutes) VALUES ('pi-prac','sp1',?,0,'practice','Practice','[\"kp1\"]',15)", (course_id,))
        conn.execute("INSERT INTO item_bank(id,space_id,kp_id,origin,purpose,type,item_json,verify_status,created_at) VALUES ('bq1',?,'kp1','generated','practice','choice',?,'verified',?)", (course_id, json.dumps(q1), now_iso))
        conn.execute("INSERT INTO item_bank(id,space_id,kp_id,origin,purpose,type,item_json,verify_status,created_at) VALUES ('bq2',?,'kp1','generated','practice','choice',?,'verified',?)", (course_id, json.dumps(q2), now_iso))

    preview = client.get("/api/v2/plan-items/pi-prac/practice/preview", headers=_headers(owner_token))
    assert preview.status_code == 200
    p_body = preview.json()
    assert p_body["item_count"] == 2
    assert p_body["est_minutes"] == 15
    assert p_body["kp_names"] == ["四则运算"]
    assert p_body["active_run_id"] is None

    run = start_run(repo, "pi-prac", now=now)
    assert save_answer(repo, run["id"], "bq1", "A", now=now)
    reloaded = get_run(repo, run["id"], reveal=False)
    assert reloaded["items"][0]["saved_answer"] == "A"
    assert reloaded["items"][1]["saved_answer"] is None

    submitted = submit_run(repo, run["id"], now=now)
    assert submitted["debrief"][0]["stem"] == "1 + 1 = ?"
    assert submitted["debrief"][0]["learner_answer"] == "A"
    assert submitted["debrief"][0]["kp_name"] == "四则运算"
    assert submitted["debrief"][1]["learner_answer"] is None


def test_b15_review_returns_before_mastery_and_mistake_item(client: TestClient, owner_token: str, isolated_settings):
    repo = SQLiteRepository(isolated_settings)
    course_id = CourseData(repo).create_course(CourseInput(name="Review B15")).id
    repo.upsert_course_enrollment(course_id, {"self_level": "basic"})
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    item = {"type": "choice", "stem": "2 + 3 = ?", "options": {"A": "4", "B": "5"}, "answer": "B", "solution": "等于 5。", "verify": {"status": "verified"}}
    with repo.connection() as conn:
        conn.execute("INSERT INTO knowledge_points(id,space_id,name,norm_name,kind,summary,importance,difficulty,ord,created_at,updated_at) VALUES ('kp1',?,'加法','add','skill','加法','core',1,1,?,?)", (course_id, now_iso, now_iso))
        conn.execute("INSERT INTO kp_mastery(space_id,kp_id,p,status,evidence_count) VALUES (?,'kp1',0.5,'learning',1)", (course_id,))
        conn.execute("INSERT INTO item_bank(id,space_id,kp_id,origin,purpose,type,item_json,verify_status,created_at) VALUES ('ri1',?,'kp1','generated','check','choice',?,'verified',?)", (course_id, json.dumps(item), now_iso))
        conn.execute(
            """INSERT INTO review_cards(id,space_id,kp_id,kind,front,back,item_ref,due_at,state,created_at,updated_at)
               VALUES ('rc-item',?,'kp1','item','2 + 3 = ?','等于 5。','ri1',?,'pending',?,?),
                      ('rc-flash',?,'kp1','flashcard','什么是加法','把两个数合在一起',NULL,?,'pending',?,?)""",
            (course_id, now_iso, now_iso, now_iso, course_id, now_iso, now_iso, now_iso),
        )

    ans = client.post("/api/v2/review/cards/rc-item/answer", json={"answer": "A"}, headers=_headers(owner_token))
    assert ans.status_code == 200
    a_body = ans.json()
    assert a_body["verdict"] == "incorrect"
    assert a_body["before_mastery"] == {"probability": 0.5, "status": "learning"}
    assert a_body["mastery"]["probability"] < 0.5
    assert a_body["kp_name"] == "加法"
    assert a_body["answer"] == "B"

    rate = client.post("/api/v2/review/cards/rc-flash/rate", json={"rating": "good"}, headers=_headers(owner_token))
    assert rate.status_code == 200
    r_body = rate.json()
    assert r_body["kp_name"] == "加法"
    assert r_body["before_mastery"]["probability"] == r_body["mastery"]["probability"]

    mistakes = client.get(f"/api/v2/courses/{course_id}/mistakes", headers=_headers(owner_token))
    assert mistakes.status_code == 200
    m_card = mistakes.json()["cards"][0]
    assert m_card["item"]["stem"] == "2 + 3 = ?"
    assert "answer" not in m_card["item"]
