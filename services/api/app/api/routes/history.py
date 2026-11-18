from __future__ import annotations

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


class LegacyHistory(BaseModel):
    id: str
    updated_at: datetime


class CourseHistory(BaseModel):
    title: str
    lessons: list[LessonHistory]
    legacy: list[LegacyHistory]


@router.get("/{course_id}/history", response_model=CourseHistory)
def course_history(course_id: str, container: Container) -> CourseHistory:
    course = container.analysis.data.course(course_id)
    with container.repository.connection() as conn:
        lessons = conn.execute(
            """SELECT lessons.id, plan_items.title, COALESCE(lessons.ended_at, lessons.started_at) AS updated_at, lessons.status
               FROM lessons JOIN plan_items ON plan_items.id = lessons.plan_item_id AND plan_items.space_id = lessons.space_id
               WHERE lessons.space_id = ? AND lessons.status IN ('done', 'abandoned')
               ORDER BY updated_at DESC, lessons.id""",
            (course_id,),
        ).fetchall()
    return CourseHistory(
        title=course.name, lessons=[LessonHistory.model_validate(dict(row)) for row in lessons],
        legacy=[LegacyHistory(id=row.id, updated_at=row.updated_at) for row in container.repository.list_sessions(course_id)],
    )


def _quote_markdown(value: str) -> str:
    return "\n".join(f"> {line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}" for line in value.splitlines())


@router.get("/{course_id}/legacy/{session_id}/markdown", include_in_schema=False)
def legacy_markdown(course_id: str, session_id: str, container: Container) -> Response:
    session = container.repository.get_session(session_id)
    if session is None or session.space_id != course_id:
        raise ResourceNotFoundError("Legacy conversation not found.")
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
