from __future__ import annotations

import json

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
        return {
            **json.loads(row["enrollment_json"] or "{}"),
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
