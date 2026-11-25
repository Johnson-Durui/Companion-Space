from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.teaching.solve import (
    _MAX_IMAGE_BYTES,
    create_solve_session,
    generate_mimic_items,
    get_solve_session,
    list_solve_sessions,
    resolve_solve_image_path,
    step_solve_session,
    submit_mimic_answer,
)

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class CreateSolveTextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stem: str = Field(min_length=1, max_length=6000)
    kp_id: str | None = Field(default=None, max_length=128)


class SolveActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["submit_idea", "hint", "show_solution", "locate_step", "finish"]
    text: str = Field(default="", max_length=3000)
    step_index: int | None = Field(default=None, ge=0, le=32)


class MimicGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int = Field(default=1, ge=1, le=2)


class MimicAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str | list[str] | float | None = None
    dont_know: bool = False


class SolveSessionSummary(BaseModel):
    id: str
    course_id: str
    source_kind: str
    stem_preview: str
    has_image: bool
    verify_status: str
    status: str
    solved: bool
    revealed: bool
    mimic_count: int
    created_at: str
    updated_at: str


class SolveMappedKp(BaseModel):
    id: str
    name: str
    mastery_p: float | None = None
    mastery_status: str
    exam_weight: float | None = None
    exam_count: int = 0


class SolveHintItem(BaseModel):
    level: int
    text: str


class SolveMimicOption(BaseModel):
    key: str
    text: str


class SolveMimicResult(BaseModel):
    item_id: str
    verdict: str
    learner_answer: Any = None
    hint_level: int = 0
    p_before: float
    p_after: float
    mastery_status: str
    answer: str | None = None
    solution: str | None = None
    submitted_at: str


class SolveMimicItem(BaseModel):
    id: str
    kp_id: str
    type: str
    difficulty: int
    stem: str
    options: list[SolveMimicOption] | None = None
    result: SolveMimicResult | None = None
    answer: str | None = None
    solution: str | None = None


class SolveSessionDetail(BaseModel):
    id: str
    course_id: str
    source_kind: str
    stem: str
    has_image: bool
    image_url: str | None = None
    verify_status: str
    verify_reason: str
    status: str
    mapped_kps: list[SolveMappedKp]
    approach_prompt: str
    key_formula: str
    hint_level: int
    max_hint_level: int
    hints: list[SolveHintItem]
    revealed: bool
    solved: bool
    steps: list[str]
    pitfalls: list[str]
    verified_answer: str | None = None
    step_explanations: dict[str, dict[str, Any]]
    turns: list[dict[str, Any]]
    mimic_items: list[SolveMimicItem]
    created_at: str
    updated_at: str


class MimicAnswerResponse(BaseModel):
    session: SolveSessionDetail
    result: SolveMimicResult


@router.get("/courses/{course_id}/solve", response_model=list[SolveSessionSummary])
async def list_course_solve_sessions(course_id: str, container: Container) -> list[dict[str, Any]]:
    return await asyncio.to_thread(list_solve_sessions, container.repository, course_id)


@router.post("/courses/{course_id}/solve", status_code=201, response_model=SolveSessionDetail)
async def create_text_solve(
    course_id: str,
    payload: CreateSolveTextRequest,
    container: Container,
) -> dict[str, Any]:
    return await create_solve_session(
        container.repository,
        container.gateway,
        course_id,
        stem=payload.stem,
        kp_id=payload.kp_id,
    )


@router.post("/courses/{course_id}/solve/image", status_code=201, response_model=SolveSessionDetail)
async def create_image_solve(
    course_id: str,
    container: Container,
    file: UploadFile = File(...),
    stem: str = Form(""),
    kp_id: str | None = Form(None),
) -> dict[str, Any]:
    try:
        raw = await file.read(_MAX_IMAGE_BYTES + 1)
    finally:
        await file.close()
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            413,
            detail={"code": "solve_image_invalid", "message": "Image must be non-empty and at most 8 MB."},
        )
    return await create_solve_session(
        container.repository,
        container.gateway,
        course_id,
        stem=stem,
        kp_id=kp_id,
        image_bytes=raw,
        image_mime=file.content_type or "image/jpeg",
    )


@router.get("/courses/{course_id}/solve/{session_id}", response_model=SolveSessionDetail)
async def read_solve_session(course_id: str, session_id: str, container: Container) -> dict[str, Any]:
    return await asyncio.to_thread(get_solve_session, container.repository, course_id, session_id)


@router.get("/courses/{course_id}/solve/{session_id}/image")
async def read_solve_image(course_id: str, session_id: str, container: Container) -> FileResponse:
    path = await asyncio.to_thread(resolve_solve_image_path, container.repository, course_id, session_id)
    return FileResponse(path, media_type="image/jpeg")


@router.post("/courses/{course_id}/solve/{session_id}/action", response_model=SolveSessionDetail)
async def perform_solve_action(
    course_id: str,
    session_id: str,
    payload: SolveActionRequest,
    container: Container,
) -> dict[str, Any]:
    return await step_solve_session(
        container.repository,
        container.gateway,
        course_id,
        session_id,
        action=payload.action,
        text=payload.text,
        step_index=payload.step_index,
    )


@router.post("/courses/{course_id}/solve/{session_id}/mimic", response_model=SolveSessionDetail)
async def create_solve_mimic(
    course_id: str,
    session_id: str,
    payload: MimicGenerateRequest,
    container: Container,
) -> dict[str, Any]:
    return await generate_mimic_items(
        container.repository,
        container.gateway,
        course_id,
        session_id,
        count=payload.count,
    )


@router.post(
    "/courses/{course_id}/solve/{session_id}/mimic/{item_id}/answer",
    response_model=MimicAnswerResponse,
)
async def answer_solve_mimic(
    course_id: str,
    session_id: str,
    item_id: str,
    payload: MimicAnswerRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        submit_mimic_answer,
        container.repository,
        course_id,
        session_id,
        item_id,
        answer=payload.answer,
        dont_know=payload.dont_know,
    )
