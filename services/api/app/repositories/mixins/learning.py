from __future__ import annotations

import json
from uuid import uuid4

from app.repositories.mixins.common import utcnow


class LearningMixin:
    """Persistence primitives shared by learner and planning services."""

    def get_learner_profile(self) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT profile_json FROM learner_profile WHERE id = 1"
            ).fetchone()
        return json.loads(row["profile_json"]) if row else None

    def upsert_learner_profile(self, profile: dict) -> None:
        with self.connection() as conn:
            conn.execute(
                """INSERT INTO learner_profile(id, profile_json, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     profile_json = excluded.profile_json,
                     updated_at = excluded.updated_at""",
                (json.dumps(profile, ensure_ascii=False), utcnow().isoformat()),
            )

    def get_course_enrollment(self, space_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT enrollment_json, COALESCE(interview_status, 'todo') AS interview_status,
                          COALESCE(placement_status, 'todo') AS placement_status
                   FROM study_spaces LEFT JOIN course_enrollment ON course_enrollment.space_id = study_spaces.id
                   WHERE study_spaces.id = ?""",
                (space_id,),
            ).fetchone()
        if row is None:
            return None
        settings = {key: value for key, value in json.loads(row["enrollment_json"] or "{}").items()
                    if not key.startswith("_")}
        return {
            **settings,
            "interview_status": row["interview_status"],
            "placement_status": row["placement_status"],
        }

    def upsert_course_enrollment(self, space_id: str, enrollment: dict) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """INSERT INTO course_enrollment(space_id, enrollment_json, updated_at)
                   SELECT id, ?, ? FROM study_spaces WHERE id = ?
                   ON CONFLICT(space_id) DO UPDATE SET
                     enrollment_json = excluded.enrollment_json,
                     updated_at = excluded.updated_at
                   RETURNING interview_status, placement_status""",
                (json.dumps(enrollment, ensure_ascii=False), utcnow().isoformat(), space_id),
            ).fetchone()
        return {**enrollment, **dict(row)} if row is not None else None

    def get_interview_state(self, space_id: str) -> dict:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT enrollment_json FROM course_enrollment WHERE space_id = ?", (space_id,),
            ).fetchone()
        return json.loads(row["enrollment_json"]).get("_interview", {}) if row else {}

    def save_interview_state(self, space_id: str, state: dict) -> bool:
        enrollment = self.get_course_enrollment(space_id)
        if enrollment is None:
            return False
        interview_status = enrollment.pop("interview_status")
        placement_status = enrollment.pop("placement_status")
        enrollment["_interview"] = state
        with self.connection() as conn:
            cursor = conn.execute(
                """INSERT INTO course_enrollment(space_id, enrollment_json, interview_status,
                                                  placement_status, updated_at)
                   SELECT id, ?, ?, ?, ? FROM study_spaces WHERE id = ?
                   ON CONFLICT(space_id) DO UPDATE SET enrollment_json = excluded.enrollment_json,
                     interview_status = excluded.interview_status,
                     placement_status = excluded.placement_status, updated_at = excluded.updated_at""",
                (json.dumps(enrollment, ensure_ascii=False), interview_status, placement_status,
                 utcnow().isoformat(), space_id),
            )
        return cursor.rowcount == 1

    def update_enrollment_progress(
        self, space_id: str, *, enrollment: dict | None = None,
        interview_status: str | None = None, placement_status: str | None = None,
    ) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT enrollment_json, interview_status, placement_status FROM study_spaces
                   LEFT JOIN course_enrollment ON course_enrollment.space_id = study_spaces.id
                   WHERE study_spaces.id = ?""", (space_id,),
            ).fetchone()
            if row is None:
                return None
            current = json.loads(row["enrollment_json"] or "{}")
            statuses = {
                "interview_status": interview_status or row["interview_status"] or "todo",
                "placement_status": placement_status or row["placement_status"] or "todo",
            }
            payload = enrollment if enrollment is not None else current
            conn.execute(
                """INSERT INTO course_enrollment(space_id, enrollment_json, interview_status,
                                                  placement_status, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(space_id) DO UPDATE SET enrollment_json = excluded.enrollment_json,
                     interview_status = excluded.interview_status,
                     placement_status = excluded.placement_status,
                     updated_at = excluded.updated_at""",
                (space_id, json.dumps(payload, ensure_ascii=False), statuses["interview_status"],
                 statuses["placement_status"], utcnow().isoformat()),
            )
        public = {key: value for key, value in payload.items() if not key.startswith("_")}
        return {**public, **statuses}

    def learning_points(self, space_id: str) -> list[dict]:
        with self.connection() as conn:
            records = [dict(row) for row in conn.execute(
                """SELECT k.id, k.unit_id, k.name, k.summary, k.kind, k.importance, k.difficulty, k.assumed,
                          k.ord, COALESCE(s.weight, 0) AS weight, m.p, m.status, m.inferred,
                          m.evidence_count
                   FROM knowledge_points k
                   LEFT JOIN kp_exam_stats s ON s.space_id = k.space_id AND s.kp_id = k.id
                   LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
                   WHERE k.space_id = ? AND k.status = 'active' ORDER BY k.ord, k.id""", (space_id,),
            )]
            prerequisites = {}
            for row in conn.execute(
                "SELECT from_kp, to_kp FROM kp_edges WHERE space_id = ?", (space_id,),
            ):
                prerequisites.setdefault(row["to_kp"], []).append(row["from_kp"])
        for record in records:
            record["prerequisite_ids"] = sorted(prerequisites.get(record["id"], []))
        return records

    def diagnostic_items(self, space_id: str) -> list[dict]:
        with self.connection() as conn:
            records = [dict(row) for row in conn.execute(
                """SELECT id, kp_id, type, difficulty, item_json FROM item_bank
                   WHERE space_id = ? AND purpose = 'diagnostic' AND verify_status = 'verified'
                     AND reserved = 0 AND type IN ('choice', 'multi', 'numeric')
                   ORDER BY kp_id, difficulty, id""", (space_id,),
            )]
        for record in records:
            record.update(json.loads(record.pop("item_json")))
        return records

    def save_mastery(self, space_id: str, kp_id: str, *, probability: float, inferred: bool) -> None:
        with self.connection() as conn:
            conn.execute(
                """INSERT INTO kp_mastery(space_id, kp_id, p, status, inferred)
                   SELECT ?, id, ?, 'unseen', ? FROM knowledge_points
                   WHERE space_id = ? AND id = ?
                   ON CONFLICT(space_id, kp_id) DO UPDATE SET p = excluded.p,
                     inferred = excluded.inferred""",
                (space_id, probability, inferred, space_id, kp_id),
            )

    def save_diagnostic_evidence(
        self, space_id: str, kp_id: str, item_ref: str, *, verdict: str,
        item_type: str, n_options: int | None, p_before: float, p_after: float,
        source: str = "diagnostic",
    ) -> None:
        from app.learning.mastery import classify_mastery

        now = utcnow().isoformat()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT * FROM kp_mastery WHERE space_id = ? AND kp_id = ?", (space_id, kp_id),
            ).fetchone()
            count = (current["evidence_count"] if current else 0) + 1
            status = classify_mastery(p_after, evidence_count=count, taught=False)
            conn.execute(
                """INSERT INTO kp_mastery(space_id, kp_id, p, status, evidence_count,
                                            inferred, last_evidence_at)
                   VALUES (?, ?, ?, ?, ?, 0, ?)
                   ON CONFLICT(space_id, kp_id) DO UPDATE SET p = excluded.p,
                     status = excluded.status, evidence_count = excluded.evidence_count,
                     inferred = 0, last_evidence_at = excluded.last_evidence_at""",
                (space_id, kp_id, p_after, status, count, now),
            )
            conn.execute(
                """INSERT INTO evidence(id, space_id, kp_id, item_ref, source, verdict,
                         item_type, n_options, judged_by, via, p_before, p_after, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exact', 'control', ?, ?, ?)""",
                (str(uuid4()), space_id, kp_id, item_ref, source, verdict, item_type, n_options,
                 p_before, p_after, now),
            )

    def answered_diagnostic_items(self, space_id: str) -> set[str]:
        with self.connection() as conn:
            return {row["item_ref"] for row in conn.execute(
                "SELECT item_ref FROM evidence WHERE space_id = ? AND source = 'diagnostic'", (space_id,),
            )}

    def current_plan(self, space_id: str) -> dict | None:
        with self.connection() as conn:
            plan = conn.execute(
                """SELECT * FROM study_plans WHERE space_id = ? AND status = 'active'
                   ORDER BY version DESC LIMIT 1""", (space_id,),
            ).fetchone()
            if plan is None:
                return None
            items = [dict(row) for row in conn.execute(
                "SELECT * FROM plan_items WHERE space_id = ? AND plan_id = ? ORDER BY ord, id",
                (space_id, plan["id"]),
            )]
            kp_names = {
                row["id"]: row["name"]
                for row in conn.execute(
                    "SELECT id, name FROM knowledge_points WHERE space_id = ?", (space_id,),
                )
            }
            prereq_ids = {
                row["from_kp"]
                for row in conn.execute(
                    "SELECT DISTINCT from_kp FROM kp_edges WHERE space_id = ?", (space_id,),
                )
            }
            prev_plan = conn.execute(
                """SELECT id, deferred_json FROM study_plans
                   WHERE space_id = ? AND version < ?
                   ORDER BY version DESC LIMIT 1""",
                (space_id, plan["version"]),
            ).fetchone()
            prev_items = [
                {**dict(row), "kp_ids": json.loads(row["kp_ids_json"])}
                for row in conn.execute(
                    "SELECT kind, title, kp_ids_json, ord FROM plan_items WHERE space_id = ? AND plan_id = ? ORDER BY ord, id",
                    (space_id, prev_plan["id"]),
                )
            ] if prev_plan is not None else None
            prev_deferred = json.loads(prev_plan["deferred_json"] or "[]") if prev_plan is not None else None
        result = dict(plan)
        params = json.loads(result.pop("params_json") or "{}")
        result["params"] = params
        deferred = json.loads(result.pop("deferred_json") or "[]")
        result["deferred"] = deferred
        result["deferred_items"] = [
            {"kp_id": kp_id, "kp_name": kp_names.get(kp_id, kp_id)}
            for kp_id in deferred
            if isinstance(kp_id, str)
        ]
        result["deferred_weight"] = params.get("deferred_weight") if "deferred_weight" in params else None
        result["over_capacity"] = params.get("over_capacity") if "over_capacity" in params else None
        result["capacity_minutes"] = params.get("capacity_minutes") if "capacity_minutes" in params else None
        highlighted = set(params.get("highlighted_kp_ids") or [])
        for item in items:
            item["kp_ids"] = json.loads(item.pop("kp_ids_json"))
            raw_why = json.loads(item.pop("why_text") or "[]")
            enriched_why = []
            for entry in raw_why:
                if not isinstance(entry, dict):
                    continue
                kp_id = str(entry.get("kp_id", ""))
                enriched_why.append({
                    **entry,
                    "kp_name": kp_names.get(kp_id, ""),
                    "highlighted": kp_id in highlighted,
                    "is_prereq": kp_id in prereq_ids,
                })
            item["why"] = enriched_why
        result["items"] = items
        if prev_items is not None:
            from app.learning.planner import compute_plan_diff

            result["diff"] = compute_plan_diff(items, deferred, prev_items, prev_deferred or [], kp_names)
        else:
            result["diff"] = None
        return result

    def replace_plan(self, space_id: str, plan: dict, *, reason: str) -> dict:
        now, plan_id = utcnow().isoformat(), str(uuid4())
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            version = conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM study_plans WHERE space_id = ?", (space_id,),
            ).fetchone()[0]
            conn.execute("UPDATE study_plans SET status = 'superseded' WHERE space_id = ? AND status = 'active'", (space_id,))
            conn.execute(
                """INSERT INTO study_plans(id, space_id, version, status, reason, params_json,
                                           deferred_json, created_at)
                   SELECT ?, id, ?, 'active', ?, ?, ?, ? FROM study_spaces WHERE id = ?""",
                (plan_id, version, reason, json.dumps(plan.get("params", {}), ensure_ascii=False),
                 json.dumps(plan.get("deferred", []), ensure_ascii=False), now, space_id),
            )
            for order, item in enumerate(plan["items"]):
                conn.execute(
                    """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json,
                                               est_minutes, scheduled_date, why_text, pinned, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid4()), plan_id, space_id, order, item["kind"], item["title"],
                     json.dumps(item.get("kp_ids", [])), item["est_minutes"], item.get("scheduled_date"),
                     json.dumps(item.get("why", []), ensure_ascii=False), int(bool(item.get("pinned"))),
                     item.get("status", "todo")),
                )
        return self.current_plan(space_id) or {}

    def adjust_plan_item(
        self, item_id: str, *, direction: str | None = None, pinned: bool | None = None,
    ) -> dict | None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                """SELECT p.* FROM plan_items p JOIN study_plans s ON s.id = p.plan_id
                   WHERE p.id = ? AND s.status = 'active'""", (item_id,),
            ).fetchone()
            if current is None:
                return None
            rows = list(conn.execute(
                "SELECT id, ord, scheduled_date FROM plan_items WHERE plan_id = ? ORDER BY ord, id",
                (current["plan_id"],),
            ))
            index = next(i for i, row in enumerate(rows) if row["id"] == item_id)
            target = index
            if direction == "first":
                target = 0
            elif direction == "earlier":
                target = max(0, index - 1)
            elif direction == "later":
                target = min(len(rows) - 1, index + 1)
            if target != index:
                moved = rows.pop(index)
                rows.insert(target, moved)
            dates = sorted((row["scheduled_date"] for row in rows if row["scheduled_date"] is not None))
            for order, row in enumerate(rows):
                scheduled = dates[order] if order < len(dates) else None
                conn.execute(
                    "UPDATE plan_items SET ord = ?, scheduled_date = ? WHERE id = ?",
                    (order, scheduled, row["id"]),
                )
            if pinned is not None or direction is not None:
                conn.execute(
                    "UPDATE plan_items SET pinned = ? WHERE id = ?",
                    (int(True if pinned is None else pinned), item_id),
                )
            space_id = current["space_id"]
        return self.current_plan(space_id)

    def locate_plan_item(self, item_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT p.* FROM plan_items p JOIN study_plans s
                   ON s.id = p.plan_id AND s.space_id = p.space_id
                   WHERE p.id = ? AND s.status = 'active'""", (item_id,),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["kp_ids"] = json.loads(item.pop("kp_ids_json"))
        return item

    def locate_teachable_plan_item(self, item_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT p.*, s.status AS plan_status FROM plan_items p JOIN study_plans s
                   ON s.id = p.plan_id AND s.space_id = p.space_id
                   WHERE p.id = ? AND s.status IN ('active', 'on_demand') AND p.kind = 'lesson'""",
                (item_id,),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["kp_ids"] = json.loads(item.pop("kp_ids_json"))
        return item

    def skip_quiz_items(self, space_id: str, kp_ids: list[str]) -> list[dict]:
        result = []
        with self.connection() as conn:
            for kp_id in kp_ids:
                row = conn.execute(
                    """SELECT id, kp_id, type, item_json FROM item_bank
                       WHERE space_id = ? AND kp_id = ? AND verify_status = 'verified'
                         AND reserved = 0 AND type IN ('choice', 'multi', 'numeric')
                       ORDER BY CASE purpose WHEN 'diagnostic' THEN 0 ELSE 1 END, difficulty, id LIMIT 1""",
                    (space_id, kp_id),
                ).fetchone()
                if row is None:
                    return []
                item = dict(row)
                item.update(json.loads(item.pop("item_json")))
                result.append(item)
        return result


    def mark_plan_item_skipped(self, space_id: str, item_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                "UPDATE plan_items SET status = 'skipped' WHERE space_id = ? AND id = ? AND status = 'todo'",
                (space_id, item_id),
            )
        return cursor.rowcount == 1
