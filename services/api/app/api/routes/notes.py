from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.learning.notes import (
    add_note_block,
    answer_reader_quick_check,
    ask_reader_page,
    create_course_note,
    create_flashcard_from_note_block,
    delete_course_note,
    delete_note_block,
    export_course_note,
    get_course_note,
    get_reader_overview,
    get_reader_page,
    list_course_notes,
    suggest_note_additions,
    update_note_block,
)

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class ReaderKpBadge(BaseModel):
    id: str
    name: str
    mastery_p: float | None = None
    mastery_status: str
    exam_count: int = 0
    exam_weight: float | None = None


class ReaderPageSummary(BaseModel):
    page_no: int
    has_image: bool
    kps: list[ReaderKpBadge]


class ReaderOverviewResponse(BaseModel):
    course_id: str
    material_id: str
    title: str
    role: str
    parse_status: str
    page_count: int
    sections: list[dict[str, Any]]
    pages: list[ReaderPageSummary]


class ReaderQuickQuiz(BaseModel):
    id: str
    kp_id: str
    type: str
    difficulty: int
    stem: str
    options: list[dict[str, str]] | None = None


class ReaderPageResponse(BaseModel):
    course_id: str
    material_id: str
    material_title: str
    page_no: int
    total_pages: int
    section_title: str | None = None
    markdown: str
    has_image: bool
    image_url: str | None = None
    kps: list[ReaderKpBadge]
    quick_quiz: ReaderQuickQuiz | None = None


class ReaderAskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passage: str = Field(min_length=1, max_length=3000)
    question: str = Field(default="", max_length=500)


class ReaderAskResponse(BaseModel):
    explanation: str
    key_takeaway: str
    suggested_block: dict[str, Any]


class ReaderQuizAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str | list[str] | float | None = None
    dont_know: bool = False


class ReaderQuizAnswerResponse(BaseModel):
    item_id: str
    verdict: str
    p_before: float
    p_after: float
    mastery_status: str
    answer: str | None = None
    solution: str | None = None


class CourseNoteSummary(BaseModel):
    id: str
    course_id: str
    title: str
    kp_id: str | None = None
    kp_name: str = ""
    block_count: int
    created_at: str
    updated_at: str


class NoteBlockItem(BaseModel):
    id: str
    ord: int
    block_type: str
    title: str | None = None
    content: str
    source_ref: dict[str, Any] | None = None
    created_at: str
    updated_at: str


class CourseNoteDetail(BaseModel):
    id: str
    course_id: str
    title: str
    kp_id: str | None = None
    kp_name: str = ""
    blocks: list[NoteBlockItem]
    created_at: str
    updated_at: str


class CreateNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    kp_id: str | None = Field(default=None, max_length=128)


class AddNoteBlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    block_type: str = Field(default="text", max_length=32)
    title: str | None = Field(default=None, max_length=120)
    content: str = Field(min_length=1, max_length=8000)
    source_ref: dict[str, Any] | None = None
    default_title: str = Field(default="Notebook", max_length=120)


class UpdateNoteBlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, max_length=120)
    content: str | None = Field(default=None, min_length=1, max_length=8000)
    ord: int | None = Field(default=None, ge=0, le=1000)


class NoteSuggestionItem(BaseModel):
    id: str
    reason: str
    block_type: str
    title: str
    content: str


class NoteFlashcardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    front: str | None = Field(default=None, max_length=400)
    back: str | None = Field(default=None, max_length=2000)


class NoteFlashcardResponse(BaseModel):
    card_id: str
    front: str
    back: str


@router.get("/courses/{course_id}/materials/{material_id}/reader", response_model=ReaderOverviewResponse)
async def read_material_overview(course_id: str, material_id: str, container: Container) -> dict[str, Any]:
    return await asyncio.to_thread(get_reader_overview, container.repository, course_id, material_id)


@router.get("/courses/{course_id}/materials/{material_id}/pages/{page_no}/reader", response_model=ReaderPageResponse)
async def read_material_page_detail(
    course_id: str,
    material_id: str,
    page_no: int,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(get_reader_page, container.repository, course_id, material_id, page_no)


@router.post("/courses/{course_id}/materials/{material_id}/pages/{page_no}/ask", response_model=ReaderAskResponse)
async def ask_about_material_page(
    course_id: str,
    material_id: str,
    page_no: int,
    payload: ReaderAskRequest,
    container: Container,
) -> dict[str, Any]:
    return await ask_reader_page(
        container.repository,
        container.gateway,
        course_id,
        material_id,
        page_no,
        passage=payload.passage,
        question=payload.question,
    )


@router.post("/courses/{course_id}/reader/quiz/{item_id}/answer", response_model=ReaderQuizAnswerResponse)
async def submit_reader_quick_check(
    course_id: str,
    item_id: str,
    payload: ReaderQuizAnswerRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        answer_reader_quick_check,
        container.repository,
        course_id,
        item_id,
        answer=payload.answer,
        dont_know=payload.dont_know,
    )


@router.get("/courses/{course_id}/notes", response_model=list[CourseNoteSummary])
async def list_notes(course_id: str, container: Container) -> list[dict[str, Any]]:
    return await asyncio.to_thread(list_course_notes, container.repository, course_id)


@router.post("/courses/{course_id}/notes", status_code=201, response_model=CourseNoteDetail)
async def create_note(course_id: str, payload: CreateNoteRequest, container: Container) -> dict[str, Any]:
    return await asyncio.to_thread(
        create_course_note,
        container.repository,
        course_id,
        title=payload.title,
        kp_id=payload.kp_id,
    )


@router.get("/courses/{course_id}/notes/{note_id}", response_model=CourseNoteDetail)
async def read_note(course_id: str, note_id: str, container: Container) -> dict[str, Any]:
    return await asyncio.to_thread(get_course_note, container.repository, course_id, note_id)


@router.delete("/courses/{course_id}/notes/{note_id}", status_code=204)
async def remove_note(course_id: str, note_id: str, container: Container) -> None:
    await asyncio.to_thread(delete_course_note, container.repository, course_id, note_id)


@router.post("/courses/{course_id}/notes/{note_id}/blocks", status_code=201, response_model=CourseNoteDetail)
async def append_note_block(
    course_id: str,
    note_id: str,
    payload: AddNoteBlockRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        add_note_block,
        container.repository,
        course_id,
        note_id,
        block_type=payload.block_type,
        content=payload.content,
        title=payload.title,
        source_ref=payload.source_ref,
        default_title=payload.default_title,
    )


@router.patch("/courses/{course_id}/notes/{note_id}/blocks/{block_id}", response_model=CourseNoteDetail)
async def patch_note_block(
    course_id: str,
    note_id: str,
    block_id: str,
    payload: UpdateNoteBlockRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        update_note_block,
        container.repository,
        course_id,
        note_id,
        block_id,
        content=payload.content,
        title=payload.title,
        ord=payload.ord,
    )


@router.delete("/courses/{course_id}/notes/{note_id}/blocks/{block_id}", response_model=CourseNoteDetail)
async def remove_note_block(
    course_id: str,
    note_id: str,
    block_id: str,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(delete_note_block, container.repository, course_id, note_id, block_id)


@router.post("/courses/{course_id}/notes/{note_id}/suggest", response_model=list[NoteSuggestionItem])
async def suggest_for_note(course_id: str, note_id: str, container: Container) -> list[dict[str, str]]:
    return await suggest_note_additions(container.repository, container.gateway, course_id, note_id)


@router.post(
    "/courses/{course_id}/notes/{note_id}/blocks/{block_id}/flashcard",
    status_code=201,
    response_model=NoteFlashcardResponse,
)
async def note_block_to_flashcard(
    course_id: str,
    note_id: str,
    block_id: str,
    payload: NoteFlashcardRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        create_flashcard_from_note_block,
        container.repository,
        course_id,
        note_id,
        block_id,
        front=payload.front,
        back=payload.back,
    )


@router.get("/courses/{course_id}/notes/{note_id}/export")
async def export_note(
    course_id: str,
    note_id: str,
    container: Container,
    format: Literal["md", "anki_tsv"] = Query(default="md"),
) -> PlainTextResponse:
    content, media_type, filename = await asyncio.to_thread(
        export_course_note,
        container.repository,
        course_id,
        note_id,
        fmt=format,
    )
    return PlainTextResponse(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
