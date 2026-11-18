from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


@router.get("/courses/{course_id}/progress")
def course_progress(course_id: str, container: Container) -> dict:
    if container.repository.get_course_enrollment(course_id) is None:
        raise ResourceNotFoundError("Course not found")
    with container.repository.connection() as conn:
        points = [dict(row) for row in conn.execute(
            """SELECT k.id, k.name, k.unit_id, k.ord, COALESCE(m.p, 0) AS probability,
                      COALESCE(m.status, 'unseen') AS status, COALESCE(s.score_share, 0) AS score_share
               FROM knowledge_points k LEFT JOIN kp_mastery m ON m.space_id=k.space_id AND m.kp_id=k.id
               LEFT JOIN kp_exam_stats s ON s.space_id=k.space_id AND s.kp_id=k.id
               WHERE k.space_id=? AND k.status='active' ORDER BY k.ord, k.id""", (course_id,),
        )]
        lesson_seconds = conn.execute(
            """SELECT COALESCE(SUM((julianday(COALESCE(ended_at, started_at))-julianday(started_at))*86400), 0)
               FROM lessons WHERE space_id=?""", (course_id,),
        ).fetchone()[0]
        practice_seconds = conn.execute(
            """SELECT COALESCE(SUM(MIN(duration_seconds,
               (julianday(COALESCE(submitted_at, deadline_at))-julianday(started_at))*86400)), 0)
               FROM practice_runs WHERE space_id=?""", (course_id,),
        ).fetchone()[0]
        trend = [dict(row) for row in conn.execute(
            """SELECT substr(created_at,1,10) AS day, ROUND(AVG(p_after),4) AS probability,
                      COUNT(*) AS evidence_count FROM evidence WHERE space_id=?
               GROUP BY substr(created_at,1,10) ORDER BY day""", (course_id,),
        )]
        enrollment = conn.execute("SELECT enrollment_json FROM course_enrollment WHERE space_id=?", (course_id,)).fetchone()
    full_score = float(json.loads(enrollment["enrollment_json"]).get("full_score", 100)) if enrollment else 100.0
    secured = full_score * sum(point["score_share"] * point["probability"] for point in points)
    return {
        "points": points,
        "studied_minutes": round((lesson_seconds + practice_seconds) / 60),
        "secured_score": round(secured, 1),
        "score_scale": round(full_score, 1),
        "trend": trend,
    }
