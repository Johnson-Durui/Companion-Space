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


class RecapStats(BaseModel):
    active_ms: int = 0
    keypoints_done: int = 0
    keypoints_total: int = 0
    correct_count: int = 0
    correct_with_hint_count: int = 0
    incorrect_count: int = 0
    dont_know_count: int = 0
    revealed_count: int = 0
    style_switches: int = 0
    backfill_count: int = 0


class MasteryChange(BaseModel):
    kp_id: str
    kp_name: str
    p_before: float
    p_after: float
    status: str


class NextPlanItem(BaseModel):
    id: str
    kind: str
    title: str
    scheduled_date: str | None = None
    est_minutes: int
    lesson_id: str | None = None


class RecapPlanChange(BaseModel):
    changed: bool = True
    reason: str
    version: int


class LessonRecapSummary(BaseModel):
    lesson_id: str
    course_id: str
    title: str
    status: Literal["active", "paused", "done", "abandoned"]
    abandoned: bool
    finished_at: str | None = None
    summary: str | None = None
    review_cards_created: int | None = None
    stats: RecapStats
    mastery_changes: list[MasteryChange] = Field(default_factory=list)
    next: NextPlanItem | None = None
    plan_change: RecapPlanChange | None = None


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


@router.get("/lessons/{lesson_id}/recap-summary")
def get_lesson_recap_summary(lesson_id: str, container: Container, _: Owner) -> LessonRecapSummary:
    space_id, lesson = _lesson(container, lesson_id)
    item = container.repository.get_plan_item(space_id, lesson["plan_item_id"])
    saved_plan = container.repository.get_lesson_plan(
        space_id, lesson["plan_item_id"], lesson_plan_id=lesson.get("lesson_plan_id"),
    )
    outline = _build_outline(container, space_id, saved_plan)
    state = lesson.get("state") or {}
    recap = lesson.get("recap") if isinstance(lesson.get("recap"), dict) else {}
    events = container.repository.list_lesson_events(space_id, lesson_id)

    style_switches = 0
    last_style: str | None = None
    backfill_events = 0
    for event in events:
        etype = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        if etype == "turn.start":
            action = data.get("action")
            if action == "reexplain":
                style_switches += 1
            elif action == "backfill":
                backfill_events += 1
            style = data.get("style_id")
            if isinstance(style, str) and style:
                if last_style is not None and style != last_style and action != "reexplain":
                    style_switches += 1
                last_style = style

    backfilled_state = state.get("backfilled") if isinstance(state.get("backfilled"), list) else []
    backfill_count = max(len(set(backfilled_state)), backfill_events)

    with container.repository.connection() as conn:
        evidence_rows = [
            dict(row)
            for row in conn.execute(
                """SELECT kp_id, verdict, hint_level, p_before, p_after
                   FROM evidence WHERE space_id = ? AND lesson_id = ? ORDER BY rowid""",
                (space_id, lesson_id),
            )
        ]
        kp_info = {
            row["id"]: {"name": row["name"], "status": row["status"] or "unseen"}
            for row in conn.execute(
                """SELECT k.id, k.name, m.status
                   FROM knowledge_points k
                   LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
                   WHERE k.space_id = ?""",
                (space_id,),
            )
        }
        next_row = conn.execute(
            """SELECT p.id, p.kind, p.title, p.scheduled_date, p.est_minutes, p.lesson_id
               FROM plan_items p
               JOIN study_plans s ON s.id = p.plan_id AND s.space_id = p.space_id
               WHERE s.space_id = ? AND s.status = 'active' AND p.status IN ('todo', 'active')
               ORDER BY p.ord, p.id LIMIT 1""",
            (space_id,),
        ).fetchone()
        latest_plan = conn.execute(
            """SELECT version, reason, created_at FROM study_plans
               WHERE space_id = ? AND status = 'active'
               ORDER BY version DESC LIMIT 1""",
            (space_id,),
        ).fetchone()

    correct_count = 0
    correct_with_hint = 0
    incorrect_count = 0
    dont_know_count = 0
    revealed_count = 0
    per_kp: dict[str, tuple[float, float]] = {}
    kp_order: list[str] = []
    for row in evidence_rows:
        verdict = row.get("verdict")
        hint_level = int(row.get("hint_level") or 0)
        if verdict == "correct":
            if hint_level > 0:
                correct_with_hint += 1
            else:
                correct_count += 1
        elif verdict in {"incorrect", "partial"}:
            incorrect_count += 1
        elif verdict == "dont_know":
            dont_know_count += 1
        elif verdict == "revealed":
            revealed_count += 1
        kp_id = str(row.get("kp_id") or "")
        if kp_id:
            p_before = float(row.get("p_before") or 0.0)
            p_after = float(row.get("p_after") or 0.0)
            if kp_id not in per_kp:
                per_kp[kp_id] = (p_before, p_after)
                kp_order.append(kp_id)
            else:
                per_kp[kp_id] = (per_kp[kp_id][0], p_after)

    mastery_changes = [
        MasteryChange(
            kp_id=kp_id,
            kp_name=kp_info.get(kp_id, {}).get("name", kp_id),
            p_before=round(per_kp[kp_id][0], 4),
            p_after=round(per_kp[kp_id][1], 4),
            status=str(kp_info.get(kp_id, {}).get("status", "unseen")),
        )
        for kp_id in kp_order
    ]

    keypoints_total = len(outline)
    if lesson["status"] == "done":
        keypoints_done = keypoints_total
    else:
        seg_idx = int(state.get("seg_idx", 0) or 0)
        kp_cursor = int(state.get("kp_cursor", 0) or 0)
        keypoints_done = sum(1 for pt in outline if (pt.seg_idx, pt.kp_idx) < (seg_idx, kp_cursor))

    plan_change: RecapPlanChange | None = None
    ended_at = lesson.get("ended_at")
    if latest_plan and latest_plan["reason"] == "lesson_finished":
        plan_created = latest_plan["created_at"]
        if not ended_at or not plan_created or plan_created >= ended_at:
            plan_change = RecapPlanChange(
                changed=True,
                reason=str(latest_plan["reason"]),
                version=int(latest_plan["version"]),
            )

    raw_cards_created = recap.get("review_cards_created")
    review_cards_created = int(raw_cards_created) if isinstance(raw_cards_created, int) else None
    raw_summary = recap.get("summary")
    summary_text = raw_summary if isinstance(raw_summary, str) and raw_summary.strip() else None

    return LessonRecapSummary(
        lesson_id=lesson["id"],
        course_id=space_id,
        title=item["title"] if item else "",
        status=lesson["status"],
        abandoned=lesson["status"] == "abandoned",
        finished_at=ended_at,
        summary=summary_text,
        review_cards_created=review_cards_created,
        stats=RecapStats(
            active_ms=int(state.get("active_ms", 0) or 0),
            keypoints_done=keypoints_done,
            keypoints_total=keypoints_total,
            correct_count=correct_count,
            correct_with_hint_count=correct_with_hint,
            incorrect_count=incorrect_count,
            dont_know_count=dont_know_count,
            revealed_count=revealed_count,
            style_switches=style_switches,
            backfill_count=backfill_count,
        ),
        mastery_changes=mastery_changes,
        next=NextPlanItem(**dict(next_row)) if next_row else None,
        plan_change=plan_change,
    )


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
