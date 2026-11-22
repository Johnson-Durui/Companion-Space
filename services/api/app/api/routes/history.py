from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError

router = APIRouter(prefix="/courses", dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class LessonHistory(BaseModel):
    id: str
    title: str
    updated_at: datetime
    status: str
    active_ms: int = 0
    summary_first_line: str | None = None
    keypoints_done: int = 0
    keypoints_total: int = 0


class LegacyHistory(BaseModel):
    id: str
    updated_at: datetime


class CourseHistory(BaseModel):
    title: str
    lessons: list[LessonHistory]
    legacy: list[LegacyHistory]


def _first_line(recap_json: str | None) -> str | None:
    if not recap_json:
        return None
    try:
        summary = json.loads(recap_json).get("summary")
    except (ValueError, TypeError, AttributeError):
        return None
    if not isinstance(summary, str):
        return None
    for raw in summary.splitlines():
        line = raw.strip().lstrip("#*-• ").strip()
        if line:
            return line[:140]
    return None


def _active_ms(state_json: str | None, started_at: str | None, ended_at: str | None) -> int:
    if state_json:
        try:
            value = json.loads(state_json).get("active_ms")
            if isinstance(value, (int, float)) and value > 0:
                return int(value)
        except (ValueError, TypeError, AttributeError):
            pass
    if started_at and ended_at:
        try:
            delta = (datetime.fromisoformat(ended_at) - datetime.fromisoformat(started_at)).total_seconds()
            return max(0, int(delta * 1000))
        except ValueError:
            pass
    return 0


def _keypoint_counts(plan_json: str | None, state_json: str | None, status: str) -> tuple[int, int]:
    if not plan_json:
        return 0, 0
    try:
        plan = json.loads(plan_json)
    except (ValueError, TypeError):
        return 0, 0
    segments = plan.get("segments") if isinstance(plan, dict) else None
    if not isinstance(segments, list):
        return 0, 0
    coords: list[tuple[int, int]] = []
    for seg_idx, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        for kp_idx, raw_kp in enumerate(segment.get("keypoints") or []):
            if raw_kp is not None and str(raw_kp).strip():
                coords.append((seg_idx, kp_idx))
    total = len(coords)
    if total == 0:
        return 0, 0
    if status == "done":
        return total, total
    try:
        state = json.loads(state_json or "{}")
    except (ValueError, TypeError):
        state = {}
    seg_idx = int(state.get("seg_idx", 0) or 0)
    kp_cursor = int(state.get("kp_cursor", 0) or 0)
    done = sum(1 for coord in coords if coord < (seg_idx, kp_cursor))
    return done, total


@router.get("/{course_id}/history", response_model=CourseHistory)
def course_history(course_id: str, container: Container) -> CourseHistory:
    course = container.analysis.data.course(course_id)
    with container.repository.connection() as conn:
        rows = conn.execute(
            """SELECT lessons.id, plan_items.title, COALESCE(lessons.ended_at, lessons.started_at) AS updated_at,
                      lessons.status, lessons.started_at, lessons.ended_at, lessons.state_json, lessons.recap_json,
                      lesson_plans.plan_json
               FROM lessons
               JOIN plan_items ON plan_items.id = lessons.plan_item_id AND plan_items.space_id = lessons.space_id
               LEFT JOIN lesson_plans ON lesson_plans.id = lessons.lesson_plan_id AND lesson_plans.space_id = lessons.space_id
               WHERE lessons.space_id = ? AND lessons.status IN ('done', 'abandoned')
               ORDER BY updated_at DESC, lessons.id""",
            (course_id,),
        ).fetchall()
    lessons = []
    for row in rows:
        done, total = _keypoint_counts(row["plan_json"], row["state_json"], row["status"])
        lessons.append(
            LessonHistory(
                id=row["id"],
                title=row["title"],
                updated_at=row["updated_at"],
                status=row["status"],
                active_ms=_active_ms(row["state_json"], row["started_at"], row["ended_at"]),
                summary_first_line=_first_line(row["recap_json"]),
                keypoints_done=done,
                keypoints_total=total,
            )
        )
    return CourseHistory(
        title=course.name,
        lessons=lessons,
        legacy=[LegacyHistory(id=row.id, updated_at=row.updated_at) for row in container.repository.list_sessions(course_id)],
    )


def _quote_markdown(value: str) -> str:
    return "\n".join(f"> {line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}" for line in value.splitlines())


@router.get("/{course_id}/legacy/{session_id}/markdown", include_in_schema=False)
def legacy_markdown(course_id: str, session_id: str, container: Container) -> Response:
    session = container.repository.get_session(session_id)
    if session is None or session.space_id != course_id:
        raise ResourceNotFoundError("Legacy conversation not found.", code="legacy_session_not_found")
    course = container.analysis.data.course(course_id)
    doc = ["# Legacy conversation", _quote_markdown(course.name), "## Summary"]
    if session.summary or session.generated_summary:
        doc.append(_quote_markdown(session.summary or session.generated_summary))
    if session.notes:
        doc.extend(("## Notes", _quote_markdown(session.notes)))
    for turn in container.repository.list_turns(session.id):
        if turn.space_id != course_id:
            continue
        doc.extend((f"## {turn.role.value} · {turn.created_at.isoformat()}", _quote_markdown(turn.display_text)))
    return Response("\n\n".join(doc) + "\n", media_type="text/markdown",
                    headers={"Content-Disposition": 'attachment; filename="legacy-conversation.md"', "Cache-Control": "no-store"})
