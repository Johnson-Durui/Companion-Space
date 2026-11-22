from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


def _parse_iso_day(value: str | None) -> date | None:
    if not value or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _week_monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _duration_seconds(started_at: str | None, ended_at: str | None, state_json: str | None = None) -> float:
    if state_json:
        try:
            active_ms = json.loads(state_json).get("active_ms")
            if isinstance(active_ms, (int, float)) and active_ms > 0:
                return float(active_ms) / 1000.0
        except (ValueError, TypeError):
            pass
    if not started_at or not ended_at:
        return 0.0
    try:
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(ended_at)
        return max(0.0, (end - start).total_seconds())
    except ValueError:
        return 0.0


@router.get("/courses/{course_id}/progress")
def course_progress(course_id: str, container: Container) -> dict:
    if container.repository.get_course_enrollment(course_id) is None:
        raise ResourceNotFoundError("Course not found", code="course_not_found")
    today = date.today()
    this_monday = _week_monday(today)
    week_starts = [this_monday - timedelta(weeks=offset) for offset in range(7, -1, -1)]
    weekly_seconds: dict[date, float] = {ws: 0.0 for ws in week_starts}

    with container.repository.connection() as conn:
        points = [dict(row) for row in conn.execute(
            """SELECT k.id, k.name, k.unit_id, COALESCE(u.title, '') AS unit_title, k.ord,
                      COALESCE(m.p, 0) AS probability,
                      COALESCE(m.status, 'unseen') AS status,
                      COALESCE(m.evidence_count, 0) AS evidence_count,
                      COALESCE(s.score_share, 0) AS score_share,
                      COALESCE(s.weight, 0) AS weight
               FROM knowledge_points k
               LEFT JOIN units u ON u.space_id = k.space_id AND u.id = k.unit_id
               LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
               LEFT JOIN kp_exam_stats s ON s.space_id = k.space_id AND s.kp_id = k.id
               WHERE k.space_id = ? AND k.status = 'active'
               ORDER BY k.ord, k.id""",
            (course_id,),
        )]
        lesson_rows = conn.execute(
            "SELECT started_at, ended_at, status, state_json FROM lessons WHERE space_id = ?",
            (course_id,),
        ).fetchall()
        practice_rows = conn.execute(
            "SELECT started_at, submitted_at, deadline_at, duration_seconds FROM practice_runs WHERE space_id = ?",
            (course_id,),
        ).fetchall()
        trend = [dict(row) for row in conn.execute(
            """SELECT substr(created_at, 1, 10) AS day, ROUND(AVG(p_after), 4) AS probability,
                      COUNT(*) AS evidence_count FROM evidence WHERE space_id = ?
               GROUP BY substr(created_at, 1, 10) ORDER BY day""",
            (course_id,),
        )]
        enrollment = conn.execute(
            "SELECT enrollment_json FROM course_enrollment WHERE space_id = ?",
            (course_id,),
        ).fetchone()

    lesson_seconds = 0.0
    lessons_completed = 0
    for row in lesson_rows:
        if row["status"] == "done":
            lessons_completed += 1
        secs = _duration_seconds(row["started_at"], row["ended_at"], row["state_json"])
        lesson_seconds += secs
        day = _parse_iso_day(row["ended_at"] or row["started_at"])
        if day:
            wk = _week_monday(day)
            if wk in weekly_seconds:
                weekly_seconds[wk] += secs

    practice_seconds = 0.0
    for row in practice_rows:
        raw_secs = _duration_seconds(row["started_at"], row["submitted_at"] or row["deadline_at"])
        capped = min(float(row["duration_seconds"] or 0), raw_secs)
        practice_seconds += capped
        day = _parse_iso_day(row["submitted_at"] or row["started_at"])
        if day:
            wk = _week_monday(day)
            if wk in weekly_seconds:
                weekly_seconds[wk] += capped

    enrollment_data = json.loads(enrollment["enrollment_json"] or "{}") if enrollment else {}
    full_score = float(enrollment_data.get("full_score", 100))
    raw_target = enrollment_data.get("target_score")
    target_score = float(raw_target) if isinstance(raw_target, (int, float)) else None
    has_exam_stats = any(float(point["score_share"] or 0) > 0 for point in points)
    secured = full_score * sum(point["score_share"] * point["probability"] for point in points)
    weekly_minutes = [
        {"week_start": ws.isoformat(), "minutes": round(weekly_seconds[ws] / 60)}
        for ws in week_starts
    ]
    return {
        "points": points,
        "studied_minutes": round((lesson_seconds + practice_seconds) / 60),
        "lessons_completed": lessons_completed,
        "secured_score": round(secured, 1),
        "score_scale": round(full_score, 1),
        "target_score": round(target_score, 1) if target_score is not None else None,
        "has_exam_stats": has_exam_stats,
        "trend": trend,
        "weekly_minutes": weekly_minutes,
    }


@router.get("/courses/{course_id}/kps/{kp_id}/timeline")
def kp_timeline(course_id: str, kp_id: str, container: Container) -> dict:
    if container.repository.get_course_enrollment(course_id) is None:
        raise ResourceNotFoundError("Course not found", code="course_not_found")
    with container.repository.connection() as conn:
        kp = conn.execute(
            """SELECT k.id, k.name, COALESCE(m.p, 0) AS probability, COALESCE(m.status, 'unseen') AS status
               FROM knowledge_points k
               LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
               WHERE k.space_id = ? AND k.id = ? AND k.status = 'active'""",
            (course_id, kp_id),
        ).fetchone()
        if kp is None:
            raise ResourceNotFoundError("Knowledge point not found", code="knowledge_point_not_found")
        events = [dict(row) for row in conn.execute(
            """SELECT id, created_at, source, verdict, p_before, p_after
               FROM evidence
               WHERE space_id = ? AND kp_id = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT 50""",
            (course_id, kp_id),
        )]
    return {
        "kp_id": kp["id"],
        "kp_name": kp["name"],
        "probability": round(float(kp["probability"]), 4),
        "status": kp["status"],
        "events": events,
    }


@router.get("/learner/week-summary")
def learner_week_summary(container: Container) -> dict:
    today = date.today()
    days_list = [today - timedelta(days=offset) for offset in range(6, -1, -1)]
    day_seconds: dict[date, float] = {d: 0.0 for d in days_list}
    active_days_all: set[date] = set()
    lessons_completed = 0

    with container.repository.connection() as conn:
        for row in conn.execute("SELECT started_at, ended_at, status, state_json FROM lessons"):
            day = _parse_iso_day(row["ended_at"] or row["started_at"])
            secs = _duration_seconds(row["started_at"], row["ended_at"], row["state_json"])
            if day:
                if row["status"] == "done" and day in day_seconds:
                    lessons_completed += 1
                if secs > 0 or row["status"] == "done":
                    active_days_all.add(day)
                if day in day_seconds:
                    day_seconds[day] += secs
        for row in conn.execute("SELECT started_at, submitted_at, deadline_at, duration_seconds FROM practice_runs"):
            day = _parse_iso_day(row["submitted_at"] or row["started_at"])
            raw_secs = _duration_seconds(row["started_at"], row["submitted_at"] or row["deadline_at"])
            capped = min(float(row["duration_seconds"] or 0), raw_secs)
            if day:
                active_days_all.add(day)
                if day in day_seconds:
                    day_seconds[day] += capped
        for row in conn.execute("SELECT DISTINCT substr(created_at, 1, 10) AS day FROM evidence"):
            day = _parse_iso_day(row["day"])
            if day:
                active_days_all.add(day)

    # Calculate current streak (starting today or yesterday if today not yet studied)
    streak = 0
    cursor = today if today in active_days_all else today - timedelta(days=1)
    while cursor in active_days_all:
        streak += 1
        cursor -= timedelta(days=1)

    return {
        "days": [
            {
                "day": d.isoformat(),
                "minutes": round(day_seconds[d] / 60),
                "active": d in active_days_all,
            }
            for d in days_list
        ],
        "total_minutes": round(sum(day_seconds.values()) / 60),
        "lessons_completed": lessons_completed,
        "streak_days": streak,
    }
