from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from fsrs import Card, Rating, Scheduler

from app.learning.mastery import Evidence, classify_mastery, initial_mastery_probability, update_mastery_probability
from app.teaching.understanding import grade_objective

RATINGS = {
    "again": Rating.Again,
    "hard": Rating.Hard,
    "good": Rating.Good,
    "easy": Rating.Easy,
}
_SCHEDULER = Scheduler(enable_fuzzing=False)


def _now(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _schedule(card: dict, rating: str, now: datetime) -> tuple[str, str]:
    state = Card.from_json(json.dumps(card["fsrs"])) if card.get("fsrs") else Card(due=now)
    state, _ = _SCHEDULER.review_card(state, RATINGS[rating], review_datetime=now)
    return state.to_json(), state.due.isoformat()


def rate_flashcard(repository, card_id: str, rating: str, *, now: datetime | None = None) -> dict | None:
    card = repository.review_card(card_id)
    if card is None or card["kind"] != "flashcard" or rating not in RATINGS:
        return None
    reviewed_at = _now(now)
    fsrs_json, due_at = _schedule(card, rating, reviewed_at)
    with repository.connection() as conn:
        conn.execute(
            """UPDATE review_cards SET fsrs_json = ?, due_at = ?, state = 'active', updated_at = ?
               WHERE id = ? AND kind = 'flashcard'""",
            (fsrs_json, due_at, reviewed_at.isoformat(), card_id),
        )
        kp_row = (
            conn.execute(
                """SELECT k.name, COALESCE(m.p, 0) AS p, COALESCE(m.status, 'unseen') AS status
                   FROM knowledge_points k
                   LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
                   WHERE k.space_id = ? AND k.id = ?""",
                (card["space_id"], card["kp_id"]),
            ).fetchone()
            if card.get("kp_id")
            else None
        )
    mastery = {"probability": float(kp_row["p"]), "status": kp_row["status"]} if kp_row else None
    return {
        **card,
        "fsrs": json.loads(fsrs_json),
        "due_at": due_at,
        "state": "active",
        "kp_name": kp_row["name"] if kp_row else None,
        "before_mastery": mastery,
        "mastery": mastery,
    }


def answer_item(
    repository, card_id: str, answer: object, *, dont_know: bool = False,
    hint_level: int = 0, now: datetime | None = None,
) -> dict | None:
    card = repository.review_card(card_id)
    if card is None or card["kind"] != "item" or not card["item_ref"]:
        return None
    reviewed_at = _now(now)
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """SELECT id, kp_id, type, item_json, verify_status FROM item_bank
               WHERE id = ? AND space_id = ? AND verify_status = 'verified'""",
            (card["item_ref"], card["space_id"]),
        ).fetchone()
        if row is None:
            return None
        item = json.loads(row["item_json"])
        item.update(id=row["id"], kp_id=row["kp_id"], type=row["type"])
        item.setdefault("verify", {"status": row["verify_status"]})
        result = grade_objective(item, answer, dont_know=dont_know)
        verdict = result["verdict"]
        rating = "again" if verdict != "correct" else ("hard" if hint_level else "good")
        fsrs_json, due_at = _schedule(card, rating, reviewed_at)

        current = conn.execute(
            "SELECT * FROM kp_mastery WHERE space_id = ? AND kp_id = ?",
            (card["space_id"], card["kp_id"]),
        ).fetchone()
        enrollment = conn.execute(
            "SELECT enrollment_json FROM course_enrollment WHERE space_id = ?", (card["space_id"],),
        ).fetchone()
        settings = json.loads(enrollment["enrollment_json"]) if enrollment else {}
        before = current["p"] if current else initial_mastery_probability(settings.get("self_level", "never"))
        before_status = current["status"] if current and current["status"] else "unseen"
        kp_row = (
            conn.execute(
                "SELECT name FROM knowledge_points WHERE space_id = ? AND id = ?",
                (card["space_id"], card["kp_id"]),
            ).fetchone()
            if card.get("kp_id")
            else None
        )
        option_count = len(item.get("options") or []) if item["type"] == "choice" else None
        evidence = Evidence("review", verdict, hint_level, item["type"], "exact", option_count)
        after = update_mastery_probability(before, evidence)
        day = reviewed_at.date().isoformat()
        clean = verdict == "correct" and hint_level == 0
        clean_item = clean and conn.execute(
            """SELECT 1 FROM evidence WHERE space_id = ? AND item_ref = ? AND source = 'review'
               AND verdict = 'correct' AND hint_level = 0""",
            (card["space_id"], card["item_ref"]),
        ).fetchone()
        clean_today = clean and conn.execute(
            """SELECT 1 FROM evidence WHERE space_id = ? AND item_ref = ? AND source = 'review'
               AND verdict = 'correct' AND hint_level = 0 AND substr(created_at, 1, 10) = ?""",
            (card["space_id"], card["item_ref"], day),
        ).fetchone()
        count = (current["evidence_count"] if current else 0) + 1
        clean_count = (current["clean_correct_count"] if current else 0) + int(clean and not clean_item)
        clean_days = (current["clean_days"] if current else 0) + int(clean and not clean_today)
        objective_clean = bool(current and current["objective_clean"]) or clean
        status = classify_mastery(
            after, evidence_count=count, taught=bool(current and current["taught_at"]),
            clean_correct_count=clean_count, clean_days=clean_days, objective_clean=objective_clean,
        )
        detail = {"answer": result.get("value"), "gap": result.get("gap", "")}
        conn.execute(
            """INSERT INTO evidence
               (id, space_id, kp_id, item_ref, source, verdict, hint_level, item_type, n_options,
                judged_by, via, retry, p_before, p_after, detail_json, created_at)
               VALUES (?, ?, ?, ?, 'review', ?, ?, ?, ?, 'exact', 'control', 0, ?, ?, ?, ?)""",
            (str(uuid4()), card["space_id"], card["kp_id"], card["item_ref"], verdict, hint_level,
             item["type"], option_count, before, after, json.dumps(detail, ensure_ascii=False), reviewed_at.isoformat()),
        )
        conn.execute(
            """INSERT INTO kp_mastery
               (space_id, kp_id, p, status, evidence_count, clean_correct_count, clean_days,
                last_clean_day, objective_clean, inferred, last_evidence_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
               ON CONFLICT(space_id, kp_id) DO UPDATE SET p = excluded.p, status = excluded.status,
                evidence_count = excluded.evidence_count, clean_correct_count = excluded.clean_correct_count,
                clean_days = excluded.clean_days, last_clean_day = excluded.last_clean_day,
                objective_clean = excluded.objective_clean, inferred = 0,
                last_evidence_at = excluded.last_evidence_at""",
            (card["space_id"], card["kp_id"], after, status, count, clean_count, clean_days,
             day if clean else (current["last_clean_day"] if current else None), objective_clean,
             reviewed_at.isoformat()),
        )
        item_clean_days = conn.execute(
            """SELECT COUNT(DISTINCT substr(created_at, 1, 10)) FROM evidence
               WHERE space_id = ? AND item_ref = ? AND source = 'review'
                 AND verdict = 'correct' AND hint_level = 0""",
            (card["space_id"], card["item_ref"]),
        ).fetchone()[0]
        state = "archived" if item_clean_days >= 2 else "active"
        conn.execute(
            """UPDATE review_cards SET fsrs_json = ?, due_at = ?, state = ?, updated_at = ? WHERE id = ?""",
            (fsrs_json, due_at, state, reviewed_at.isoformat(), card_id),
        )
    return {
        "card_id": card_id,
        "verdict": verdict,
        "rating": rating,
        "answer": item.get("answer"),
        "solution": card["back"],
        "due_at": due_at,
        "state": state,
        "kp_id": card.get("kp_id"),
        "kp_name": kp_row["name"] if kp_row else None,
        "before_mastery": {"probability": before, "status": before_status},
        "mastery": {"probability": after, "status": status},
    }
