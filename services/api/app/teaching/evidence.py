from __future__ import annotations

import json
import sqlite3
from uuid import uuid4

from app.learning.mastery import Evidence, classify_mastery, initial_mastery_probability, update_mastery_probability
from app.repositories.mixins.common import utcnow

OBJECTIVE_TYPES = frozenset({"choice", "multi", "numeric", "short"})
_SOURCE = {"check": "lesson_check", "prereq": "backfill", "verify_skip": "skip_verify"}


def record_answer(conn: sqlite3.Connection, space_id: str, lesson_id: str, observation: dict) -> None:
    item = observation["item"]
    point_id, item_id = item["kp_id"], item["bank_id"]
    # The plan pinned the verified item before any later course analysis replaced the live bank.
    if not conn.execute(
        """SELECT 1 FROM lessons
           JOIN lesson_plans ON lesson_plans.id = lessons.lesson_plan_id AND lesson_plans.space_id = lessons.space_id
           JOIN json_each(lesson_plans.plan_json, '$.items') AS item
           WHERE lessons.id = ? AND lessons.space_id = ?
             AND item.value ->> '$.bank_id' = ? AND item.value ->> '$.kp_id' = ?
             AND item.value ->> '$.verify.status' = 'verified'""",
        (lesson_id, space_id, item_id, point_id),
    ).fetchone():
        raise ValueError("Evidence must reference a verified item from the saved lesson plan")
    current = conn.execute(
        "SELECT * FROM kp_mastery WHERE space_id = ? AND kp_id = ?", (space_id, point_id),
    ).fetchone()
    seen = conn.execute(
        "SELECT 1 FROM evidence WHERE space_id = ? AND lesson_id = ? AND item_ref = ?",
        (space_id, lesson_id, item_id),
    ).fetchone()
    source = _SOURCE.get(observation["purpose"], observation["purpose"])
    kind = item["type"]
    judged_by = "exact" if kind in OBJECTIVE_TYPES else "model"
    option_count = len(item.get("options") or []) or None
    evidence = Evidence(source, observation["verdict"], observation["hint_level"], kind, judged_by, option_count, bool(seen))
    now = utcnow()
    date = now.date().isoformat()
    enrollment = conn.execute("SELECT enrollment_json FROM course_enrollment WHERE space_id = ?", (space_id,)).fetchone()
    setup = json.loads(enrollment["enrollment_json"]) if enrollment else {}
    before = current["p"] if current else initial_mastery_probability(setup.get("self_level", "never"))
    after = update_mastery_probability(before, evidence)
    clean = evidence.verdict == "correct" and evidence.hint_level == 0 and not evidence.retry
    previously_clean = clean and conn.execute(
        """SELECT 1 FROM evidence
           WHERE space_id = ? AND item_ref = ? AND verdict = 'correct' AND hint_level = 0 AND retry = 0""",
        (space_id, item_id),
    ).fetchone()
    count = (current["evidence_count"] if current else 0) + 1
    clean_count = (current["clean_correct_count"] if current else 0) + int(clean and not previously_clean)
    previous_date = current["last_clean_day"] if current else None
    days = (current["clean_days"] if current else 0) + int(clean and previous_date != date)
    objective_clean = bool(current and current["objective_clean"]) or (clean and judged_by == "exact")
    status = classify_mastery(
        after, evidence_count=count, taught=True, clean_correct_count=clean_count,
        clean_days=days, objective_clean=objective_clean,
    )
    conn.execute(
        """INSERT INTO evidence
           (id, space_id, kp_id, lesson_id, item_ref, source, verdict, hint_level, item_type,
            n_options, judged_by, via, retry, p_before, p_after, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (str(uuid4()), space_id, point_id, lesson_id, item_id, source, evidence.verdict, evidence.hint_level,
         kind, option_count, judged_by, observation["via"], evidence.retry, before, after,
         json.dumps(observation.get("detail", {}), ensure_ascii=False), now.isoformat()),
    )
    conn.execute(
        """INSERT INTO kp_mastery (
               space_id, kp_id, p, status, evidence_count, clean_correct_count, clean_days,
               last_clean_day, objective_clean, inferred, last_evidence_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(space_id, kp_id) DO UPDATE SET
               p = excluded.p, status = excluded.status, evidence_count = excluded.evidence_count,
               clean_correct_count = excluded.clean_correct_count, clean_days = excluded.clean_days,
               last_clean_day = excluded.last_clean_day, objective_clean = excluded.objective_clean,
               inferred = 0, last_evidence_at = excluded.last_evidence_at""",
        (space_id, point_id, after, status, count, clean_count, days, date if clean else previous_date,
         objective_clean, now.isoformat()),
    )
    approach = observation.get("approach_kind")
    if approach:
        conn.execute(
            """INSERT INTO approach_stats(kind, n, success) VALUES (?, 1, ?)
               ON CONFLICT(kind) DO UPDATE SET n = n + 1, success = success + excluded.success""",
            (approach, int(evidence.verdict == "correct")),
        )
