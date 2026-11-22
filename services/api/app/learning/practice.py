from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.learning.mastery import Evidence, classify_mastery, initial_mastery_probability, update_mastery_probability
from app.teaching.understanding import grade_objective

OBJECTIVE = ("choice", "multi", "numeric", "short")


def _now(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _item(row) -> dict:
    value = json.loads(row["item_json"])
    value.update(id=row["id"], kp_id=row["kp_id"], type=row["type"])
    value.setdefault("verify", {"status": "verified"})
    return value


def _select_items(conn, plan) -> list:
    if plan["kind"] == "mock":
        return conn.execute(
            """SELECT b.* FROM item_bank b JOIN exam_items i ON i.id = b.exam_item_id
               JOIN exam_papers p ON p.id = i.paper_id
               WHERE b.space_id = ? AND b.verify_status = 'verified' AND b.type IN (?, ?, ?, ?)
                 AND p.reserved_for_mock = 1 ORDER BY i.rowid""",
            (plan["space_id"], *OBJECTIVE),
        ).fetchall()
    kp_ids = json.loads(plan["kp_ids_json"])
    if not kp_ids:
        return []
    return conn.execute(
        """SELECT * FROM item_bank WHERE space_id = ? AND kp_id IN (%s)
           AND verify_status = 'verified' AND reserved = 0 AND type IN (?, ?, ?, ?)
           ORDER BY difficulty, id LIMIT 12""" % ",".join("?" for _ in kp_ids),
        (plan["space_id"], *kp_ids, *OBJECTIVE),
    ).fetchall()


def preview_run(repository, plan_item_id: str) -> dict | None:
    with repository.connection() as conn:
        plan = conn.execute(
            "SELECT * FROM plan_items WHERE id = ? AND kind IN ('practice', 'mock')",
            (plan_item_id,),
        ).fetchone()
        if plan is None:
            return None
        current = conn.execute(
            "SELECT id, status, item_refs_json FROM practice_runs WHERE plan_item_id = ? ORDER BY started_at DESC LIMIT 1",
            (plan_item_id,),
        ).fetchone()
        kp_names_map = {
            row["id"]: row["name"]
            for row in conn.execute(
                "SELECT id, name FROM knowledge_points WHERE space_id = ?",
                (plan["space_id"],),
            )
        }
        if current is not None:
            refs = json.loads(current["item_refs_json"] or "[]")
            rows = (
                conn.execute(
                    "SELECT kp_id FROM item_bank WHERE id IN (%s)" % ",".join("?" for _ in refs),
                    refs,
                ).fetchall()
                if refs
                else []
            )
            item_count = len(refs)
        else:
            rows = _select_items(conn, plan)
            item_count = len(rows)
        seen_kps: list[str] = []
        for row in rows:
            kp_id = row["kp_id"]
            if kp_id and kp_id not in seen_kps:
                seen_kps.append(kp_id)
        if not seen_kps:
            for kp_id in json.loads(plan["kp_ids_json"] or "[]"):
                if kp_id and kp_id not in seen_kps:
                    seen_kps.append(kp_id)
        return {
            "plan_item_id": plan["id"],
            "course_id": plan["space_id"],
            "kind": plan["kind"],
            "title": plan["title"],
            "est_minutes": max(1, int(plan["est_minutes"] or 15)),
            "item_count": item_count,
            "kp_names": [kp_names_map.get(kp_id, kp_id) for kp_id in seen_kps],
            "active_run_id": current["id"] if current and current["status"] == "active" else None,
            "submitted_run_id": current["id"] if current and current["status"] == "submitted" else None,
        }


def start_run(repository, plan_item_id: str, *, now: datetime | None = None) -> dict | None:
    started = _now(now)
    with repository.connection() as conn:
        plan = conn.execute(
            "SELECT * FROM plan_items WHERE id = ? AND kind IN ('practice', 'mock')", (plan_item_id,),
        ).fetchone()
        if plan is None:
            return None
        current = conn.execute(
            "SELECT id, status FROM practice_runs WHERE plan_item_id = ? ORDER BY started_at DESC LIMIT 1",
            (plan_item_id,),
        ).fetchone()
        if current:
            return get_run(repository, current["id"], reveal=current["status"] == "submitted")
        rows = _select_items(conn, plan)
        if not rows:
            return None
        run_id = str(uuid4())
        duration = max(1, plan["est_minutes"]) * 60
        conn.execute(
            """INSERT INTO practice_runs
               (id, space_id, plan_item_id, kind, item_refs_json, duration_seconds, status, started_at, deadline_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
            (run_id, plan["space_id"], plan_item_id, plan["kind"],
             json.dumps([row["id"] for row in rows]), duration, started.isoformat(),
             (started + timedelta(seconds=duration)).isoformat()),
        )
        conn.execute("UPDATE plan_items SET status = 'active' WHERE id = ?", (plan_item_id,))
    return get_run(repository, run_id)


def get_run(repository, run_id: str, *, reveal: bool = False) -> dict | None:
    with repository.connection() as conn:
        run = conn.execute("SELECT * FROM practice_runs WHERE id = ?", (run_id,)).fetchone()
        if run is None:
            return None
        refs = json.loads(run["item_refs_json"])
        rows = conn.execute(
            "SELECT * FROM item_bank WHERE id IN (%s)" % ",".join("?" for _ in refs), refs,
        ).fetchall()
        by_id = {row["id"]: _item(row) for row in rows}
        saved = {row["item_ref"]: dict(row) for row in conn.execute(
            "SELECT * FROM practice_answers WHERE run_id = ?", (run_id,),
        )}
        kp_names = {
            row["id"]: row["name"]
            for row in conn.execute(
                "SELECT id, name FROM knowledge_points WHERE space_id = ?",
                (run["space_id"],),
            )
        }
    items = []
    for ref in refs:
        item = by_id[ref]
        saved_row = saved.get(ref)
        saved_val = json.loads(saved_row["answer_json"]) if saved_row and saved_row.get("answer_json") else None
        public = {key: item.get(key) for key in ("id", "kp_id", "type", "stem", "options")}
        public["kp_name"] = kp_names.get(item.get("kp_id"), "")
        public["answer_saved"] = ref in saved
        public["saved_answer"] = saved_val
        if reveal:
            public.update(answer=item.get("answer"), solution=item.get("solution") or str(item.get("answer", "")))
        items.append(public)
    result = dict(run)
    result.pop("item_refs_json")
    result["items"] = items
    if reveal:
        result["debrief"] = [{
            "item_id": ref,
            "kp_id": by_id[ref].get("kp_id"),
            "kp_name": kp_names.get(by_id[ref].get("kp_id"), ""),
            "type": by_id[ref].get("type"),
            "stem": by_id[ref].get("stem", ""),
            "options": by_id[ref].get("options"),
            "learner_answer": json.loads(saved[ref]["answer_json"]) if ref in saved and saved[ref].get("answer_json") else None,
            "verdict": saved[ref]["verdict"],
            "score": saved[ref]["score"],
            "max_score": saved[ref]["max_score"],
            "answer": by_id[ref].get("answer"),
            "solution": by_id[ref].get("solution") or str(by_id[ref].get("answer", "")),
            "moves": ["SHOW_SOLUTION", "REEXPLAIN", "CHECK"]
            if saved[ref]["verdict"] != "correct" else ["CHECK"],
        } for ref in refs]
    return result


def get_debrief_item(repository, run_id: str, item_ref: str) -> dict | None:
    """Load the immutable, verified source used for a submitted practice result."""
    with repository.connection() as conn:
        run = conn.execute("SELECT * FROM practice_runs WHERE id = ?", (run_id,)).fetchone()
        if run is None or run["status"] != "submitted" or item_ref not in json.loads(run["item_refs_json"]):
            return None
        row = conn.execute(
            "SELECT * FROM item_bank WHERE id = ? AND verify_status = 'verified'", (item_ref,),
        ).fetchone()
        answer = conn.execute(
            "SELECT * FROM practice_answers WHERE run_id = ? AND item_ref = ?", (run_id, item_ref),
        ).fetchone()
    if row is None or answer is None:
        return None
    item = _item(row)
    item["verify"] = {"status": "verified"}
    return {
        "item": item,
        "learner_answer": json.loads(answer["answer_json"]) if answer["answer_json"] else None,
        "verdict": answer["verdict"],
        "score": answer["score"],
        "max_score": answer["max_score"],
    }


def save_answer(repository, run_id: str, item_ref: str, answer: object, *, now: datetime | None = None) -> bool:
    submitted = _now(now)
    with repository.connection() as conn:
        run = conn.execute("SELECT * FROM practice_runs WHERE id = ?", (run_id,)).fetchone()
        if run is None or run["status"] != "active" or submitted > datetime.fromisoformat(run["deadline_at"]):
            return False
        if item_ref not in json.loads(run["item_refs_json"]):
            return False
        conn.execute(
            """INSERT INTO practice_answers(run_id, item_ref, answer_json, submitted_at)
               VALUES (?, ?, ?, ?) ON CONFLICT(run_id, item_ref) DO UPDATE SET
               answer_json = excluded.answer_json, submitted_at = excluded.submitted_at""",
            (run_id, item_ref, json.dumps(answer, ensure_ascii=False), submitted.isoformat()),
        )
    return True


def submit_run(repository, run_id: str, *, now: datetime | None = None) -> dict | None:
    submitted = _now(now)
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        run = conn.execute("SELECT * FROM practice_runs WHERE id = ?", (run_id,)).fetchone()
        if run is None:
            return None
        if run["status"] == "submitted":
            return get_run(repository, run_id, reveal=True)
        refs = json.loads(run["item_refs_json"])
        rows = conn.execute(
            "SELECT * FROM item_bank WHERE id IN (%s)" % ",".join("?" for _ in refs), refs,
        ).fetchall()
        answers = {row["item_ref"]: json.loads(row["answer_json"]) if row["answer_json"] else None for row in conn.execute(
            "SELECT item_ref, answer_json FROM practice_answers WHERE run_id = ?", (run_id,),
        )}
        total = 0.0
        debrief = []
        for row in rows:
            item = _item(row)
            result = grade_objective(item, answers.get(row["id"]), dont_know=row["id"] not in answers)
            points = conn.execute("SELECT score FROM exam_items WHERE id = ?", (row["exam_item_id"],)).fetchone()
            maximum = float(points["score"] if points and points["score"] is not None else 1)
            earned = maximum if result["verdict"] == "correct" else 0.0
            total += earned
            conn.execute(
                """INSERT INTO practice_answers(run_id, item_ref, answer_json, verdict, score, max_score, submitted_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, item_ref) DO UPDATE SET
                   verdict = excluded.verdict, score = excluded.score, max_score = excluded.max_score""",
                (run_id, row["id"], json.dumps(answers.get(row["id"]), ensure_ascii=False), result["verdict"],
                 earned, maximum, submitted.isoformat()),
            )
            _record_evidence(conn, run["space_id"], item, result, submitted)
            if result["verdict"] != "correct":
                _add_wrong_card(conn, run["space_id"], item, submitted)
            debrief.append({
                "item_id": row["id"], "verdict": result["verdict"], "score": earned,
                "max_score": maximum, "answer": item.get("answer"),
                "solution": item.get("solution") or str(item.get("answer", "")),
                "moves": ["SHOW_SOLUTION", "REEXPLAIN", "CHECK"] if result["verdict"] != "correct" else ["CHECK"],
            })
        maximum_total = sum(entry["max_score"] for entry in debrief)
        conn.execute(
            """UPDATE practice_runs SET status = 'submitted', submitted_at = ?, score = ?, max_score = ? WHERE id = ?""",
            (submitted.isoformat(), total, maximum_total, run_id),
        )
        if run["plan_item_id"]:
            conn.execute("UPDATE plan_items SET status = 'done' WHERE id = ?", (run["plan_item_id"],))
    return get_run(repository, run_id, reveal=True)


def _record_evidence(conn, space_id: str, item: dict, result: dict, now: datetime) -> None:
    current = conn.execute(
        "SELECT * FROM kp_mastery WHERE space_id = ? AND kp_id = ?", (space_id, item["kp_id"]),
    ).fetchone()
    enrollment = conn.execute("SELECT enrollment_json FROM course_enrollment WHERE space_id = ?", (space_id,)).fetchone()
    settings = json.loads(enrollment["enrollment_json"]) if enrollment else {}
    before = current["p"] if current else initial_mastery_probability(settings.get("self_level", "never"))
    option_count = len(item.get("options") or []) if item["type"] == "choice" else None
    evidence = Evidence("practice", result["verdict"], 0, item["type"], "exact", option_count)
    after = update_mastery_probability(before, evidence)
    clean = result["verdict"] == "correct"
    clean_item = clean and conn.execute(
        "SELECT 1 FROM evidence WHERE space_id = ? AND item_ref = ? AND verdict = 'correct' AND hint_level = 0",
        (space_id, item["id"]),
    ).fetchone()
    day = now.date().isoformat()
    clean_day = clean and current and current["last_clean_day"] == day
    count = (current["evidence_count"] if current else 0) + 1
    clean_count = (current["clean_correct_count"] if current else 0) + int(clean and not clean_item)
    days = (current["clean_days"] if current else 0) + int(clean and not clean_day)
    objective = bool(current and current["objective_clean"]) or clean
    status = classify_mastery(after, evidence_count=count, taught=bool(current and current["taught_at"]),
                              clean_correct_count=clean_count, clean_days=days, objective_clean=objective)
    conn.execute(
        """INSERT INTO evidence(id, space_id, kp_id, item_ref, source, verdict, item_type, n_options,
           judged_by, via, p_before, p_after, detail_json, created_at)
           VALUES (?, ?, ?, ?, 'practice', ?, ?, ?, 'exact', 'control', ?, ?, ?, ?)""",
        (str(uuid4()), space_id, item["kp_id"], item["id"], result["verdict"], item["type"], option_count,
         before, after, json.dumps({"answer": result.get("value"), "gap": result.get("gap", "")}, ensure_ascii=False), now.isoformat()),
    )
    conn.execute(
        """INSERT INTO kp_mastery(space_id, kp_id, p, status, evidence_count, clean_correct_count,
           clean_days, last_clean_day, objective_clean, inferred, last_evidence_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(space_id, kp_id) DO UPDATE SET
           p=excluded.p, status=excluded.status, evidence_count=excluded.evidence_count,
           clean_correct_count=excluded.clean_correct_count, clean_days=excluded.clean_days,
           last_clean_day=excluded.last_clean_day, objective_clean=excluded.objective_clean,
           inferred=0, last_evidence_at=excluded.last_evidence_at""",
        (space_id, item["kp_id"], after, status, count, clean_count, days,
         day if clean else (current["last_clean_day"] if current else None), objective, now.isoformat()),
    )


def _add_wrong_card(conn, space_id: str, item: dict, now: datetime) -> None:
    if conn.execute(
        "SELECT 1 FROM review_cards WHERE space_id = ? AND item_ref = ? AND state != 'archived'",
        (space_id, item["id"]),
    ).fetchone():
        return
    conn.execute(
        """INSERT INTO review_cards(id, space_id, kp_id, kind, front, back, item_ref, due_at, state, created_at, updated_at)
           VALUES (?, ?, ?, 'item', ?, ?, ?, ?, 'pending', ?, ?)""",
        (str(uuid4()), space_id, item["kp_id"], item.get("stem", ""), item.get("solution") or str(item.get("answer", "")),
         item["id"], now.isoformat(), now.isoformat(), now.isoformat()),
    )
