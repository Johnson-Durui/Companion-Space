from __future__ import annotations

from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_owner,
)
from app.models.api_v1 import (
    MemoryListResponse,
    MemoryUpdateRequest,
    ReviewListResponse,
    ReviewUpdateRequest,
)
from app.models.domain import (
    MemoryItem,
    MemoryStatus,
    ReviewItem,
)

router = APIRouter()


@router.get("/memory/{space_id}", response_model=MemoryListResponse)
def list_memory(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MemoryListResponse:
    return MemoryListResponse(items=container.repository.list_memory_items(space_id))


@router.put("/memory/{space_id}/{memory_id}")
def update_memory(
    space_id: str,
    memory_id: str,
    payload: MemoryUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MemoryItem:
    existing = next(
        (
            item
            for item in container.repository.list_memory_items(space_id)
            if item.id == memory_id
        ),
        None,
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Memory item not found")
    next_status = MemoryStatus(payload.status)
    if (
        existing.sensitive
        and existing.status is MemoryStatus.candidate
        and next_status is MemoryStatus.confirmed
    ):
        raise HTTPException(
            status_code=409,
            detail="Sensitive memory candidates require the explicit confirm action",
        )
    item = existing.model_copy(
        update={
            "content": payload.content,
            "status": next_status,
            "sensitive": payload.sensitive,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    saved = container.repository.upsert_memory_item(item)
    if next_status is MemoryStatus.confirmed:
        container.metrics.record_event_safe(
            "memory_candidate_confirmed",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    elif next_status is MemoryStatus.discarded:
        container.metrics.record_event_safe(
            "memory_candidate_rejected",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    return saved


@router.post("/memory/{space_id}/{memory_id}/confirm")
def confirm_memory(
    space_id: str,
    memory_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MemoryItem:
    existing = next(
        (
            item
            for item in container.repository.list_memory_items(space_id)
            if item.id == memory_id
        ),
        None,
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Memory item not found")
    confirmed = existing.model_copy(
        update={
            "status": MemoryStatus.confirmed,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    saved = container.repository.upsert_memory_item(confirmed)
    container.metrics.record_event_safe(
        "memory_candidate_confirmed",
        {"space_id": space_id, "memory_id": memory_id},
        once=True,
    )
    return saved


@router.delete(
    "/memory/{space_id}/{memory_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_memory(
    space_id: str,
    memory_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    existing = next(
        (
            item
            for item in container.repository.list_memory_items(space_id)
            if item.id == memory_id
        ),
        None,
    )
    if not container.repository.delete_memory_item(
        space_id=space_id,
        memory_id=memory_id,
    ):
        raise HTTPException(status_code=404, detail="Memory item not found")
    if existing is not None and existing.status is MemoryStatus.candidate:
        container.metrics.record_event_safe(
            "memory_candidate_rejected",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/review-items/{space_id}", response_model=ReviewListResponse)
def list_review(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ReviewListResponse:
    return ReviewListResponse(items=container.repository.list_review_items(space_id))


@router.put("/review-items/{space_id}/{review_id}")
def update_review(
    space_id: str,
    review_id: str,
    payload: ReviewUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ReviewItem:
    existing = next(
        (
            item
            for item in container.repository.list_review_items(space_id)
            if item.id == review_id
        ),
        None,
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Review item not found")
    changes: dict[str, object] = {
        "updated_at": datetime.now(timezone.utc),
    }
    if payload.prompt is not None:
        changes["prompt"] = payload.prompt
    if payload.answer is not None:
        changes["answer"] = payload.answer
    if "due_at" in payload.model_fields_set:
        changes["due_at"] = payload.due_at
    if payload.status is not None:
        changes["status"] = payload.status
    item = existing.model_copy(update=changes)
    saved = container.repository.upsert_review_item(item)
    container.metrics.record_event_safe(
        "review_item_updated",
        {"space_id": space_id, "review_id": review_id},
    )
    return saved


@router.delete(
    "/review-items/{space_id}/{review_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_review(
    space_id: str,
    review_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    if not container.repository.delete_review_item(
        space_id=space_id,
        review_id=review_id,
    ):
        raise HTTPException(status_code=404, detail="Review item not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
