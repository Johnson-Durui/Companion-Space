from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from pydantic import BaseModel, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.realtime_auth import REALTIME_PROTOCOL, authorize_websocket
from app.core.errors import ResourceNotFoundError
from app.services.settings_store import get_setting
from app.services.tutor_catalog import Character
from app.teaching.live import LiveLesson
from app.teaching.planner import LessonPlanner

router = APIRouter()
Container = Annotated[ServiceContainer, Depends(get_container)]
Owner = Annotated[str, Depends(require_owner)]


class PointLessonRequest(BaseModel):
    kp_id: str = Field(min_length=1, max_length=128)


class LessonView(BaseModel):
    id: str
    course_id: str
    title: str
    teacher: Character | None
    status: Literal["active", "paused", "done", "abandoned"]
    seq: int
    gen: int
    playback_after_seq: int | None = None
    recap: dict | None


class LessonEvent(BaseModel):
    lesson_id: str
    seq: int
    gen: int
    type: str
    data: dict
    t_ms: int


class LiveTicket(BaseModel):
    ticket: str
    expires_at: datetime


def _lesson(container: ServiceContainer, lesson_id: str) -> tuple[str, dict]:
    space_id = container.repository.lesson_course(lesson_id)
    lesson = container.repository.get_lesson(space_id, lesson_id) if space_id else None
    if space_id is None or lesson is None:
        raise ResourceNotFoundError("Classroom not found")
    return space_id, lesson


def _view(container: ServiceContainer, space_id: str, lesson: dict) -> LessonView:
    item = container.repository.get_plan_item(space_id, lesson["plan_item_id"])
    character_id = lesson["character_id"] or get_setting(container.repository, "default_character_id", None)
    return LessonView(
        id=lesson["id"], course_id=space_id, title=item["title"] if item else "",
        teacher=container.tutors.get_character(character_id) if character_id else None,
        status=lesson["status"], seq=lesson["seq"], gen=lesson["gen"], recap=lesson["recap"],
        playback_after_seq=lesson["state"].get("playback_after_seq"),
    )


@router.post("/courses/{course_id}/lessons")
async def prepare_lesson(course_id: str, payload: PointLessonRequest, container: Container, _: Owner) -> LessonView:
    repository = container.repository
    enrollment = await asyncio.to_thread(repository.get_course_enrollment, course_id) or {}
    item_id = await asyncio.to_thread(
        repository.create_point_lesson_item, course_id, payload.kp_id, minutes=enrollment.get("session_minutes", 25),
    )
    if item_id is None:
        raise ResourceNotFoundError("Knowledge point not found")
    if item_id in container.preparing_lessons:
        raise HTTPException(409, "This lesson is already being prepared")
    container.preparing_lessons.add(item_id)
    try:
        saved = await asyncio.to_thread(repository.get_lesson_plan, course_id, item_id)
        if saved is None:
            saved = await LessonPlanner(repository, container.gateway).prepare(course_id, item_id)
        profile = await asyncio.to_thread(repository.get_learner_profile) or {}
        character = await asyncio.to_thread(get_setting, repository, "default_character_id", None)
        if character is None:
            catalog = await asyncio.to_thread(container.tutors.list_characters)
            character = catalog[0].id if catalog else None
        lesson = await asyncio.to_thread(
            repository.create_or_resume_lesson, course_id, item_id, lesson_plan_id=saved["id"], character_id=character,
            state={"stage": "opening", "pace": profile.get("pace", "normal"),
                   "style_id": profile.get("preferred_style_id", "guided")},
        )
    finally:
        container.preparing_lessons.discard(item_id)
    if lesson is None:
        raise ResourceNotFoundError("Lesson plan is unavailable")
    return await asyncio.to_thread(_view, container, course_id, lesson)


@router.get("/lessons/{lesson_id}")
def get_lesson(lesson_id: str, container: Container, _: Owner) -> LessonView:
    space_id, lesson = _lesson(container, lesson_id)
    return _view(container, space_id, lesson)


@router.get("/lessons/{lesson_id}/events")
def get_events(lesson_id: str, container: Container, _: Owner, after: int = Query(default=0, ge=0)) -> list[LessonEvent]:
    space_id, _ = _lesson(container, lesson_id)
    return [LessonEvent.model_validate(row) for row in container.repository.list_lesson_events(space_id, lesson_id, after=after)]


@router.post("/lessons/{lesson_id}/ticket")
def issue_ticket(lesson_id: str, container: Container, owner: Owner) -> LiveTicket:
    _lesson(container, lesson_id)
    ticket, expires_at = container.vault.issue_realtime_ticket(owner, session_id=lesson_id)
    return LiveTicket(ticket=ticket, expires_at=expires_at)


@router.websocket("/lessons/{lesson_id}/live")
async def live_lesson(websocket: WebSocket, lesson_id: str, container: Container) -> None:
    owner = await authorize_websocket(websocket, settings=container.settings, vault=container.vault, lesson_id=lesson_id)
    if owner is None:
        return
    space_id = await asyncio.to_thread(container.repository.lesson_course, lesson_id)
    if space_id is None:
        await websocket.close(code=4404)
        return
    await websocket.accept(subprotocol=REALTIME_PROTOCOL)
    if lesson_id in container.live_lessons:
        await websocket.close(code=4409, reason="Classroom is open in another tab")
        return
    container.live_lessons.add(lesson_id)
    try:
        await LiveLesson(websocket, container, space_id, lesson_id).run()
    finally:
        container.live_lessons.discard(lesson_id)
