from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.learning.memory import (
    distill_course_memories,
    get_memory_archive,
    list_course_memories,
    refresh_memory_archive,
    update_course_memory,
    update_global_memory_note,
)

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class MemoryEvidenceRef(BaseModel):
    kind: str
    id: str
    href: str | None = None


class CourseMemoryFact(BaseModel):
    id: str
    course_id: str
    course_name: str | None = None
    kp_id: str | None = None
    kp_name: str = ""
    kind: str
    statement: str
    evidence_refs: list[MemoryEvidenceRef]
    status: str
    user_edited: bool
    created_at: str
    updated_at: str


class GlobalSynthesisNote(BaseModel):
    id: str
    statement: str
    source_memory_ids: list[str]
    status: str
    user_edited: bool = False
    updated_at: str | None = None


class MemoryArchiveResponse(BaseModel):
    synthesis_notes: list[GlobalSynthesisNote]
    course_memories: list[CourseMemoryFact]
    total_active_facts: int
    updated_at: str | None = None


class MemoryPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    statement: str | None = Field(default=None, min_length=1, max_length=160)
    status: Literal["active", "pinned", "dismissed"] | None = None


@router.get("/courses/{course_id}/memories", response_model=list[CourseMemoryFact])
async def read_course_memories(
    course_id: str,
    container: Container,
    include_dismissed: bool = Query(default=False),
) -> list[dict[str, Any]]:
    return await asyncio.to_thread(
        list_course_memories,
        container.repository,
        course_id,
        include_dismissed=include_dismissed,
    )


@router.post("/courses/{course_id}/memories/refresh", response_model=list[CourseMemoryFact])
async def refresh_course_memories(course_id: str, container: Container) -> list[dict[str, Any]]:
    return await distill_course_memories(container.repository, container.gateway, course_id)


@router.patch("/courses/{course_id}/memories/{memory_id}", response_model=CourseMemoryFact)
async def patch_course_memory(
    course_id: str,
    memory_id: str,
    payload: MemoryPatchRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        update_course_memory,
        container.repository,
        course_id,
        memory_id,
        statement=payload.statement,
        status=payload.status,
    )


@router.get("/learner/memory-archive", response_model=MemoryArchiveResponse)
async def read_memory_archive(
    container: Container,
    include_dismissed: bool = Query(default=False),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        get_memory_archive,
        container.repository,
        include_dismissed=include_dismissed,
    )


@router.post("/learner/memory-archive/refresh", response_model=MemoryArchiveResponse)
async def rebuild_memory_archive(container: Container) -> dict[str, Any]:
    return await refresh_memory_archive(container.repository, container.gateway)


@router.patch("/learner/memory-archive/{note_id}", response_model=MemoryArchiveResponse)
async def patch_global_memory_note(
    note_id: str,
    payload: MemoryPatchRequest,
    container: Container,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        update_global_memory_note,
        container.repository,
        note_id,
        statement=payload.statement,
        status=payload.status,
    )
