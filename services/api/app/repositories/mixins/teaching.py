from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from uuid import uuid4

from app.repositories.mixins.common import utcnow
from app.teaching.evidence import record_answer

_TERMINAL = {"done", "abandoned"}
_PROGRESS_COLUMNS = """
    COALESCE((SELECT MAX(seq) FROM lesson_events WHERE lesson_id = lessons.id), 0) AS seq,
    COALESCE((SELECT gen FROM lesson_events WHERE lesson_id = lessons.id ORDER BY seq DESC LIMIT 1), 0) AS gen
"""


def _encode(value) -> str | None:
    return None if value is None else json.dumps(value, ensure_ascii=False, allow_nan=False)


def _decode(row: sqlite3.Row) -> dict:
    result = dict(row)
    for key in row.keys():
        if key.endswith("_json"):
            value = result.pop(key)
            result[key.removesuffix("_json")] = json.loads(value) if value is not None else None
    return result


class TeachingMixin:
    """Store lesson plans, resumable snapshots, and their ordered event history."""

    def lesson_course(self, lesson_id: str) -> str | None:
        with self.connection() as conn:
            row = conn.execute("SELECT space_id FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
            return row["space_id"] if row else None

    def create_point_lesson_item(self, space_id: str, kp_id: str, *, minutes: int) -> str | None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            point = conn.execute(
                "SELECT name FROM knowledge_points WHERE space_id = ? AND id = ? AND status = 'active'",
                (space_id, kp_id),
            ).fetchone()
            if point is None:
                return None
            ids = _encode([kp_id])
            item = conn.execute(
                """SELECT plan_items.id FROM plan_items JOIN study_plans ON study_plans.id = plan_items.plan_id
                   WHERE plan_items.space_id = ? AND study_plans.status = 'on_demand'
                     AND kind = 'lesson' AND kp_ids_json = ? AND plan_items.status != 'abandoned'
                   ORDER BY plan_items.ord DESC LIMIT 1""",
                (space_id, ids),
            ).fetchone()
            if item:
                return item["id"]
            plan = conn.execute(
                "SELECT id FROM study_plans WHERE space_id = ? AND status = 'on_demand'", (space_id,),
            ).fetchone()
            plan_id = plan["id"] if plan else str(uuid4())
            if plan is None:
                conn.execute(
                    "INSERT INTO study_plans(id, space_id, version, status, created_at) VALUES (?, ?, 1, 'on_demand', ?)",
                    (plan_id, space_id, utcnow().isoformat()),
                )
            item_id = str(uuid4())
            conn.execute(
                """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
                   SELECT ?, ?, ?, COALESCE(MAX(ord), 0) + 1, 'lesson', ?, ?, ?
                   FROM plan_items WHERE space_id = ? AND plan_id = ?""",
                (item_id, plan_id, space_id, point["name"], ids, minutes, space_id, plan_id),
            )
            return item_id

    def get_plan_item(self, space_id: str, plan_item_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM plan_items WHERE space_id = ? AND id = ?",
                (space_id, plan_item_id),
            ).fetchone()
        return _decode(row) if row is not None else None

    def save_lesson_plan(
        self, space_id: str, plan_item_id: str, *, plan: dict,
        model: str | None = None, verify_stats: dict | None = None,
        generated_items: Sequence[dict] = (),
    ) -> dict | None:
        """Persist a validated plan and newly verified bank entries in one transaction."""
        now = utcnow().isoformat()
        with self.connection() as conn:
            row = conn.execute(
                """INSERT INTO lesson_plans(id, space_id, plan_item_id, status, plan_json, model,
                                            verify_stats_json, created_at)
                   SELECT ?, space_id, id, 'ready', ?, ?, ?, ?
                   FROM plan_items WHERE space_id = ? AND id = ? AND kind = 'lesson'
                   RETURNING *""",
                (str(uuid4()), _encode(plan), model, _encode(verify_stats), now, space_id, plan_item_id),
            ).fetchone()
            if row is None:
                return None
            for entry in generated_items:
                item = entry["item"]
                if (item.get("verify") or {}).get("status") != "verified":
                    raise ValueError("Generated questions must be verified before saving a lesson plan.")
                inserted = conn.execute(
                    """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, difficulty, variant_of,
                                             item_json, verify_status, created_at)
                       SELECT ?, space_id, id, 'generated', ?, ?, ?, ?, ?, 'verified', ?
                       FROM knowledge_points WHERE space_id = ? AND id = ? AND status = 'active'""",
                    (entry["id"], entry["purpose"], entry["type"], entry.get("difficulty"), entry.get("variant_of"),
                     _encode(item), now, space_id, entry["kp_id"]),
                )
                if inserted.rowcount != 1:
                    raise ValueError("A generated question must reference an active knowledge point in the course.")
            for item in plan.get("items", {}).values():
                if item.get("verify", {}).get("status") != "verified" or not conn.execute(
                    """SELECT 1 FROM item_bank
                       WHERE id = ? AND space_id = ? AND kp_id = ? AND verify_status = 'verified' AND reserved = 0""",
                    (item["bank_id"], space_id, item["kp_id"]),
                ).fetchone():
                    raise ValueError("A ready lesson cannot include a question outside the course's verified bank.")
        return _decode(row)

    def get_lesson_plan(
        self, space_id: str, plan_item_id: str, *, lesson_plan_id: str | None = None,
    ) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT * FROM lesson_plans
                   WHERE space_id = ? AND plan_item_id = ? AND status = 'ready' AND (? IS NULL OR id = ?)
                   ORDER BY rowid DESC LIMIT 1""",
                (space_id, plan_item_id, lesson_plan_id, lesson_plan_id),
            ).fetchone()
        return _decode(row) if row is not None else None

    def get_lesson_by_plan_item(self, space_id: str, plan_item_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                f"SELECT *, {_PROGRESS_COLUMNS} FROM lessons WHERE space_id = ? AND plan_item_id = ? LIMIT 1",
                (space_id, plan_item_id),
            ).fetchone()
        return _decode(row) if row is not None else None

    def latest_lesson_prepare_job(self, space_id: str, plan_item_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT id, status, error, created_at, updated_at FROM jobs
                   WHERE kind = 'lesson_prepare' AND space_id = ?
                     AND json_extract(payload_json, '$.plan_item_id') = ?
                   ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (space_id, plan_item_id),
            ).fetchone()
        return dict(row) if row is not None else None

    def kp_names_by_id(self, space_id: str, kp_ids: Sequence[str]) -> dict[str, str]:
        unique = [kp_id for kp_id in dict.fromkeys(kp_ids) if kp_id]
        if not unique:
            return {}
        placeholders = ",".join("?" for _ in unique)
        with self.connection() as conn:
            rows = conn.execute(
                f"SELECT id, name FROM knowledge_points WHERE space_id = ? AND id IN ({placeholders})",
                (space_id, *unique),
            ).fetchall()
        return {row["id"]: row["name"] for row in rows}

    def create_or_resume_lesson(
        self, space_id: str, plan_item_id: str, *, state: dict,
        board: dict | None = None, character_id: str | None = None, lesson_plan_id: str | None = None,
    ) -> dict | None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                f"SELECT *, {_PROGRESS_COLUMNS} FROM lessons WHERE space_id = ? AND plan_item_id = ?",
                (space_id, plan_item_id),
            ).fetchone()
            if existing is not None:
                return _decode(existing)

            row = conn.execute(
                """INSERT INTO lessons(id, space_id, plan_item_id, lesson_plan_id, character_id,
                                       status, state_json, board_json, started_at)
                   SELECT ?, space_id, plan_item_id, id, ?, 'active', ?, ?, ?
                   FROM lesson_plans WHERE space_id = ? AND plan_item_id = ? AND status = 'ready'
                     AND (? IS NULL OR id = ?)
                   ORDER BY rowid DESC LIMIT 1
                   RETURNING *, 0 AS seq, 0 AS gen""",
                (str(uuid4()), character_id, _encode(state), _encode(board), utcnow().isoformat(),
                 space_id, plan_item_id, lesson_plan_id, lesson_plan_id),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE plan_items SET lesson_id = ?, status = 'active' WHERE space_id = ? AND id = ?",
                (row["id"], space_id, plan_item_id),
            )
        return _decode(row)

    def get_lesson(self, space_id: str, lesson_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                f"SELECT *, {_PROGRESS_COLUMNS} FROM lessons WHERE space_id = ? AND id = ?",
                (space_id, lesson_id),
            ).fetchone()
        return _decode(row) if row is not None else None

    def reopen_abandoned_lesson(self, space_id: str, lesson_id: str) -> dict | None:
        """Transition an abandoned lesson back to paused so the classroom can resume."""
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                f"SELECT *, {_PROGRESS_COLUMNS} FROM lessons WHERE space_id = ? AND id = ?",
                (space_id, lesson_id),
            ).fetchone()
            if current is None:
                return None
            if current["status"] in {"paused", "active"}:
                return _decode(current)
            if current["status"] != "abandoned":
                raise ValueError("Only abandoned or paused lessons can be resumed")
            conn.execute(
                "UPDATE lessons SET status = 'paused', ended_at = NULL WHERE space_id = ? AND id = ?",
                (space_id, lesson_id),
            )
            if current["plan_item_id"]:
                conn.execute(
                    """UPDATE plan_items SET status = 'active'
                       WHERE space_id = ? AND id = ? AND (lesson_id = ? OR lesson_id IS NULL)""",
                    (space_id, current["plan_item_id"], lesson_id),
                )
            updated = conn.execute(
                f"SELECT *, {_PROGRESS_COLUMNS} FROM lessons WHERE space_id = ? AND id = ?",
                (space_id, lesson_id),
            ).fetchone()
        return _decode(updated) if updated is not None else None

    def append_lesson_events(
        self, space_id: str, lesson_id: str, *, gen: int, events: Sequence[dict], state: dict,
        board: dict | None, status: str, expected_seq: int | None = None,
        recap: dict | None = None, carry_over: dict | None = None, observation: dict | None = None,
        cards: Sequence[dict] = (),
    ) -> list[dict] | None:
        """Commit one batch and its checkpoint together. A stale writer must reload."""
        if not events:
            raise ValueError("A lesson checkpoint must include an event")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                f"""SELECT plan_item_id, status, {_PROGRESS_COLUMNS}
                    FROM lessons WHERE space_id = ? AND id = ?""",
                (space_id, lesson_id),
            ).fetchone()
            if current is None:
                return None
            if expected_seq is not None and current["seq"] != expected_seq:
                raise ValueError("Lesson event sequence has changed")
            if current["status"] in _TERMINAL:
                raise ValueError("Lesson has ended")
            if gen < current["gen"]:
                raise ValueError("Lesson generation has changed")

            recorded = [
                {
                    "lesson_id": lesson_id, "seq": seq, "gen": gen,
                    "type": event["type"], "data": event["data"], "t_ms": event["t_ms"],
                }
                for seq, event in enumerate(events, start=current["seq"] + 1)
            ]
            conn.executemany(
                "INSERT INTO lesson_events(lesson_id, seq, gen, type, data_json, t_ms) VALUES (?, ?, ?, ?, ?, ?)",
                [(lesson_id, e["seq"], gen, e["type"], _encode(e["data"]), e["t_ms"]) for e in recorded],
            )
            if observation is not None:
                record_answer(conn, space_id, lesson_id, observation)
            if cards and status != "done":
                raise ValueError("Review cards require a finished lesson")
            now = utcnow().isoformat()
            conn.executemany(
                """INSERT INTO review_cards(id, space_id, kp_id, kind, front, back, item_ref, due_at,
                                             state, source_lesson_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
                [(str(uuid4()), space_id, card["kp_id"], card["kind"], card["front"], card["back"],
                  card.get("item_ref"), card.get("due_at", now), lesson_id, now, now) for card in cards],
            )
            conn.execute(
                """UPDATE lessons SET state_json = ?, board_json = ?, status = ?,
                          recap_json = COALESCE(?, recap_json), carry_over_json = COALESCE(?, carry_over_json),
                          ended_at = ?
                   WHERE space_id = ? AND id = ?""",
                (_encode(state), _encode(board), status, _encode(recap), _encode(carry_over),
                 now if status in _TERMINAL else None, space_id, lesson_id),
            )
            conn.execute(
                "UPDATE plan_items SET status = ? WHERE space_id = ? AND id = ? AND lesson_id = ?",
                (status, space_id, current["plan_item_id"], lesson_id),
            )
        return recorded

    def list_lesson_events(self, space_id: str, lesson_id: str, *, after: int = 0) -> list[dict]:
        with self.connection() as conn:
            rows = conn.execute(
                """SELECT lesson_events.* FROM lesson_events JOIN lessons ON lessons.id = lesson_events.lesson_id
                   WHERE lessons.space_id = ? AND lesson_events.lesson_id = ? AND seq > ?
                   ORDER BY seq""",
                (space_id, lesson_id, after),
            ).fetchall()
        return [_decode(row) for row in rows]
