from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from pydantic import BaseModel, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.realtime_auth import REALTIME_PROTOCOL, authorize_websocket
from app.core.errors import ResourceNotFoundError
from app.learning.styles import STYLE_IDS, initial_lesson_style
from app.services.settings_store import get_setting
from app.services.tutor_catalog import Character, StyleId
from app.teaching.live import LiveLesson
from app.teaching.planner import LessonPlanner

router = APIRouter()
Container = Annotated[ServiceContainer, Depends(get_container)]
Owner = Annotated[str, Depends(require_owner)]


class PointLessonRequest(BaseModel):
    kp_id: str = Field(min_length=1, max_length=128)


class PointPlanItemView(BaseModel):
    plan_item_id: str
    course_id: str
    title: str
    est_minutes: int


class OutlinePoint(BaseModel):
    kp_id: str
    kp_name: str
    text: str
    seg_idx: int
    kp_idx: int


class LessonProgress(BaseModel):
    seg_idx: int
    kp_cursor: int
    current_index: int
    total: int


class LessonView(BaseModel):
    id: str
    course_id: str
    title: str
    est_minutes: int | None = None
    teacher: Character | None
    status: Literal["active", "paused", "done", "abandoned"]
    seq: int
    gen: int
    playback_after_seq: int | None = None
    recap: dict | None
    outline: list[OutlinePoint] = Field(default_factory=list)
    progress: LessonProgress | None = None
    style_id: str | None = None
    active_ms: int = 0


class LessonPrepareStatus(BaseModel):
    status: Literal["preparing", "ready", "failed", "has_lesson", "missing"]
    course_id: str | None = None
    title: str | None = None
    est_minutes: int | None = None
    lesson_id: str | None = None
    error_code: str | None = None
    started_at: str | None = None
    outline: list[OutlinePoint] = Field(default_factory=list)
    teacher: Character | None = None


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
        raise ResourceNotFoundError("Classroom not found", code="lesson_not_found")
    return space_id, lesson


def _build_outline(container: ServiceContainer, space_id: str, saved_plan: dict | None) -> list[OutlinePoint]:
    if not saved_plan or not isinstance(saved_plan.get("plan"), dict):
        return []
    segments = saved_plan["plan"].get("segments") or []
    kp_ids = [
        str(segment.get("kp_id"))
        for segment in segments
        if isinstance(segment, dict) and segment.get("kp_id")
    ]
    kp_names = container.repository.kp_names_by_id(space_id, kp_ids)
    outline: list[OutlinePoint] = []
    for seg_idx, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        kp_id = str(segment.get("kp_id") or "")
        kp_name = kp_names.get(kp_id, "")
        keypoints = segment.get("keypoints") or []
        for kp_idx, raw_kp in enumerate(keypoints):
            text = str(raw_kp).strip() if raw_kp is not None else ""
            if not text:
                continue
            outline.append(
                OutlinePoint(kp_id=kp_id, kp_name=kp_name, text=text, seg_idx=seg_idx, kp_idx=kp_idx)
            )
    return outline


def _build_progress(outline: list[OutlinePoint], state: dict) -> LessonProgress | None:
    total = len(outline)
    if total == 0:
        return None
    seg_idx = int(state.get("seg_idx", 0) or 0)
    kp_cursor = int(state.get("kp_cursor", 0) or 0)
    stage = state.get("stage")
    if stage in {"wrap", "done"}:
        current_index = total
    else:
        matched = next(
            (idx + 1 for idx, pt in enumerate(outline) if pt.seg_idx == seg_idx and pt.kp_idx == kp_cursor),
            None,
        )
        if matched is not None:
            current_index = matched
        else:
            preceding = sum(1 for pt in outline if (pt.seg_idx, pt.kp_idx) <= (seg_idx, kp_cursor))
            current_index = max(1, min(total, preceding or 1))
    return LessonProgress(seg_idx=seg_idx, kp_cursor=kp_cursor, current_index=current_index, total=total)


def _default_teacher(container: ServiceContainer, character_id: str | None = None) -> Character | None:
    resolved_id = character_id or get_setting(container.repository, "default_character_id", None)
    return container.tutors.resolve_active_character(resolved_id)


def _view(container: ServiceContainer, space_id: str, lesson: dict) -> LessonView:
    item = container.repository.get_plan_item(space_id, lesson["plan_item_id"])
    saved_plan = container.repository.get_lesson_plan(
        space_id, lesson["plan_item_id"], lesson_plan_id=lesson.get("lesson_plan_id"),
    )
    outline = _build_outline(container, space_id, saved_plan)
    state = lesson.get("state") or {}
    progress = _build_progress(outline, state)
    raw_style = state.get("style_id")
    style_id = raw_style if isinstance(raw_style, str) and raw_style in STYLE_IDS else None
    est_minutes = item["est_minutes"] if item and isinstance(item.get("est_minutes"), int) else (
        saved_plan["plan"].get("est_minutes") if saved_plan and isinstance(saved_plan.get("plan"), dict) else None
    )
    return LessonView(
        id=lesson["id"],
        course_id=space_id,
        title=item["title"] if item else "",
        est_minutes=est_minutes if isinstance(est_minutes, int) else None,
        teacher=_default_teacher(container, lesson.get("character_id")),
        status=lesson["status"],
        seq=lesson["seq"],
        gen=lesson["gen"],
        recap=lesson["recap"],
        playback_after_seq=state.get("playback_after_seq"),
        outline=outline,
        progress=progress,
        style_id=style_id,
        active_ms=int(state.get("active_ms", 0) or 0),
    )


def _prepare_status_sync(container: ServiceContainer, plan_item_id: str) -> LessonPrepareStatus:
    item = container.repository.locate_teachable_plan_item(plan_item_id)
    if item is None:
        return LessonPrepareStatus(status="missing")
    space_id = item["space_id"]
    title = item.get("title") or ""
    est_minutes = item.get("est_minutes") if isinstance(item.get("est_minutes"), int) else None
    lesson = container.repository.get_lesson_by_plan_item(space_id, plan_item_id)
    if lesson is not None:
        saved_plan = container.repository.get_lesson_plan(
            space_id, plan_item_id, lesson_plan_id=lesson.get("lesson_plan_id"),
        )
        return LessonPrepareStatus(
            status="has_lesson",
            course_id=space_id,
            title=title,
            est_minutes=est_minutes,
            lesson_id=lesson["id"],
            outline=_build_outline(container, space_id, saved_plan),
            teacher=_default_teacher(container, lesson.get("character_id")),
        )
    saved_plan = container.repository.get_lesson_plan(space_id, plan_item_id)
    teacher = _default_teacher(container)
    if saved_plan is not None:
        return LessonPrepareStatus(
            status="ready",
            course_id=space_id,
            title=title,
            est_minutes=est_minutes,
            outline=_build_outline(container, space_id, saved_plan),
            teacher=teacher,
        )
    job = container.repository.latest_lesson_prepare_job(space_id, plan_item_id)
    if plan_item_id in container.preparing_lessons or (job and job["status"] in {"queued", "running"}):
        return LessonPrepareStatus(
            status="preparing",
            course_id=space_id,
            title=title,
            est_minutes=est_minutes,
            started_at=job["created_at"] if job else None,
            teacher=teacher,
        )
    if job and job["status"] == "failed":
        code = job["error"] if isinstance(job["error"], str) and job["error"].strip() else "lesson_prepare_failed"
        if " " in code:
            code = "lesson_prepare_failed"
        return LessonPrepareStatus(
            status="failed",
            course_id=space_id,
            title=title,
            est_minutes=est_minutes,
            error_code=code,
            started_at=job["created_at"],
            teacher=teacher,
        )
    return LessonPrepareStatus(
        status="preparing",
        course_id=space_id,
        title=title,
        est_minutes=est_minutes,
        teacher=teacher,
    )


@router.post("/courses/{course_id}/point-plan-items")
async def create_point_plan_item(
    course_id: str, payload: PointLessonRequest, container: Container, _: Owner,
) -> PointPlanItemView:
    repository = container.repository
    enrollment = await asyncio.to_thread(repository.get_course_enrollment, course_id) or {}
    minutes = int(enrollment.get("session_minutes", 25) or 25)
    item_id = await asyncio.to_thread(
        repository.create_point_lesson_item, course_id, payload.kp_id, minutes=minutes,
    )
    if item_id is None:
        raise ResourceNotFoundError("Knowledge point not found", code="knowledge_point_not_found")
    item = await asyncio.to_thread(repository.get_plan_item, course_id, item_id)
    return PointPlanItemView(
        plan_item_id=item_id,
        course_id=course_id,
        title=item["title"] if item else "",
        est_minutes=item["est_minutes"] if item and isinstance(item.get("est_minutes"), int) else minutes,
    )


@router.post("/plan-items/{plan_item_id}/prepare")
async def prepare_plan_item(plan_item_id: str, container: Container, _: Owner) -> LessonPrepareStatus:
    item = await asyncio.to_thread(container.repository.locate_teachable_plan_item, plan_item_id)
    if item is None:
        return LessonPrepareStatus(status="missing")
    space_id = item["space_id"]
    current = await asyncio.to_thread(_prepare_status_sync, container, plan_item_id)
    if current.status in {"has_lesson", "ready"}:
        return current
    latest_job = await asyncio.to_thread(container.repository.latest_lesson_prepare_job, space_id, plan_item_id)
    if plan_item_id in container.preparing_lessons or (
        latest_job is not None and latest_job["status"] in {"queued", "running"}
    ):
        return LessonPrepareStatus(
            status="preparing",
            course_id=space_id,
            title=item.get("title") or "",
            est_minutes=item.get("est_minutes") if isinstance(item.get("est_minutes"), int) else None,
            started_at=latest_job["created_at"] if latest_job else None,
            teacher=current.teacher,
        )
    job = await container.jobs.submit(
        "lesson_prepare", space_id=space_id, payload={"plan_item_id": plan_item_id},
    )
    return LessonPrepareStatus(
        status="preparing",
        course_id=space_id,
        title=item.get("title") or "",
        est_minutes=item.get("est_minutes") if isinstance(item.get("est_minutes"), int) else None,
        started_at=job.created_at.isoformat(),
        teacher=current.teacher,
    )


@router.get("/plan-items/{plan_item_id}/prepare-status")
async def get_plan_item_prepare_status(plan_item_id: str, container: Container, _: Owner) -> LessonPrepareStatus:
    return await asyncio.to_thread(_prepare_status_sync, container, plan_item_id)


@router.post("/courses/{course_id}/lessons")
async def prepare_lesson(course_id: str, payload: PointLessonRequest, container: Container, _: Owner) -> LessonView:
    repository = container.repository
    enrollment = await asyncio.to_thread(repository.get_course_enrollment, course_id) or {}
    item_id = await asyncio.to_thread(
        repository.create_point_lesson_item, course_id, payload.kp_id, minutes=enrollment.get("session_minutes", 25),
    )
    if item_id is None:
        raise ResourceNotFoundError("Knowledge point not found", code="knowledge_point_not_found")
    return await _open_plan_item(container, course_id, item_id)


async def _open_plan_item(container: ServiceContainer, course_id: str, item_id: str) -> LessonView:
    repository = container.repository
    if item_id in container.preparing_lessons:
        raise HTTPException(
            409, detail={"code": "lesson_preparing", "message": "This lesson is already being prepared"},
        )
    container.preparing_lessons.add(item_id)
    try:
        saved = await asyncio.to_thread(repository.get_lesson_plan, course_id, item_id)
        if saved is None:
            saved = await LessonPlanner(repository, container.gateway).prepare(course_id, item_id)
        profile = await asyncio.to_thread(repository.get_learner_profile)
        saved_character = await asyncio.to_thread(get_setting, repository, "default_character_id", None)
        tutor = await asyncio.to_thread(container.tutors.resolve_active_character, saved_character)
        character = tutor.id if tutor else None
        explicit_fields = await asyncio.to_thread(
            get_setting, repository, "learner_profile_explicit_fields", None,
        )
        raw_plan_style = saved["plan"].get("style_id")
        plan_style: StyleId | None = raw_plan_style if isinstance(raw_plan_style, str) and raw_plan_style in STYLE_IDS else None
        lesson = await asyncio.to_thread(
            repository.create_or_resume_lesson, course_id, item_id, lesson_plan_id=saved["id"], character_id=character,
            state={
                "stage": "opening", "pace": profile.get("pace", "normal") if profile else "normal",
                "style_id": initial_lesson_style(
                    profile=profile, tutor=tutor, explicit_profile_fields=explicit_fields, plan_style=plan_style,
                ),
            },
        )
    finally:
        container.preparing_lessons.discard(item_id)
    if lesson is None:
        raise ResourceNotFoundError("Lesson plan is unavailable", code="lesson_plan_unavailable")
    return await asyncio.to_thread(_view, container, course_id, lesson)


@router.post("/plan-items/{plan_item_id}/lesson", name="open_plan_item_lesson")
async def open_plan_item_lesson(plan_item_id: str, container: Container, _: Owner) -> LessonView:
    item = await asyncio.to_thread(container.repository.locate_teachable_plan_item, plan_item_id)
    if item is None:
        raise ResourceNotFoundError("Lesson plan item not found", code="plan_item_not_found")
    return await _open_plan_item(container, item["space_id"], plan_item_id)


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
async def live_lesson(
    websocket: WebSocket,
    lesson_id: str,
    container: Container,
    takeover: bool = Query(default=False),
) -> None:
    owner = await authorize_websocket(websocket, settings=container.settings, vault=container.vault, lesson_id=lesson_id)
    if owner is None:
        return
    space_id = await asyncio.to_thread(container.repository.lesson_course, lesson_id)
    if space_id is None:
        await websocket.close(code=4404)
        return
    await websocket.accept(subprotocol=REALTIME_PROTOCOL)
    existing = container.live_lessons.get(lesson_id)
    if existing is not None:
        if not takeover:
            await websocket.close(code=4409, reason="other_tab")
            return
        container.live_lessons[lesson_id] = websocket
        with suppress(Exception):
            await existing.close(code=4409, reason="taken_over")
    else:
        container.live_lessons[lesson_id] = websocket
    try:
        await LiveLesson(websocket, container, space_id, lesson_id).run()
    finally:
        if container.live_lessons.get(lesson_id) is websocket:
            del container.live_lessons[lesson_id]
