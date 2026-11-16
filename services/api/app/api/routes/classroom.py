from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import ServiceContainer, get_container, require_owner
from app.models.classroom import (
    ClassroomEventRequest,
    ClassroomSnapshot,
    ClassroomStartRequest,
    FlashcardListResponse,
    FlashcardRatingRequest,
    FlashcardRecord,
)
from app.services.companion import SessionNotFoundError
from app.services.pedagogical_orchestrator import (
    ClassroomNotStartedError,
    PedagogicalOrchestrator,
)

router = APIRouter()


def _orchestrator(container: ServiceContainer) -> PedagogicalOrchestrator:
    return PedagogicalOrchestrator(
        container.repository,
        container.spaces,
        container.companion,
        container.demos,
    )


def _not_found(error: ValueError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


@router.get("/sessions/{session_id}/classroom", response_model=ClassroomSnapshot)
def get_classroom(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ClassroomSnapshot:
    try:
        return _orchestrator(container).get(session_id)
    except (SessionNotFoundError, ClassroomNotStartedError) as error:
        raise _not_found(error) from error


@router.post("/sessions/{session_id}/classroom/start", response_model=ClassroomSnapshot)
async def start_classroom(
    session_id: str,
    payload: ClassroomStartRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ClassroomSnapshot:
    try:
        return await _orchestrator(container).start(session_id=session_id, topic=payload.topic)
    except SessionNotFoundError as error:
        raise _not_found(error) from error


@router.post("/sessions/{session_id}/classroom/events", response_model=ClassroomSnapshot)
async def send_classroom_event(
    session_id: str,
    payload: ClassroomEventRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ClassroomSnapshot:
    try:
        return await _orchestrator(container).handle_event(session_id=session_id, event=payload)
    except (SessionNotFoundError, ClassroomNotStartedError) as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post(
    "/sessions/{session_id}/classroom/flashcards",
    response_model=FlashcardListResponse,
)
def propose_classroom_flashcards(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> FlashcardListResponse:
    try:
        items = _orchestrator(container).propose_flashcards(session_id)
    except (SessionNotFoundError, ClassroomNotStartedError) as error:
        raise _not_found(error) from error
    return FlashcardListResponse(items=items)


@router.get(
    "/spaces/{space_id}/classroom/flashcards",
    response_model=FlashcardListResponse,
)
def list_classroom_flashcards(
    space_id: str,
    status_filter: Literal["proposed", "active", "due"] | None = None,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> FlashcardListResponse:
    if container.repository.get_space(space_id) is None:
        raise HTTPException(status_code=404, detail="Study space not found")
    store = _orchestrator(container).store
    items = store.list_flashcards(
        space_id=space_id,
        status="active" if status_filter == "due" else status_filter,
        due_before=datetime.now(timezone.utc) if status_filter == "due" else None,
    )
    return FlashcardListResponse(items=items)


@router.post(
    "/spaces/{space_id}/classroom/flashcards/{card_id}/confirm",
    response_model=FlashcardRecord,
)
def confirm_classroom_flashcard(
    space_id: str,
    card_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> FlashcardRecord:
    try:
        return _orchestrator(container).confirm_flashcard(space_id=space_id, card_id=card_id)
    except ValueError as error:
        raise _not_found(error) from error


@router.post(
    "/spaces/{space_id}/classroom/flashcards/{card_id}/rate",
    response_model=FlashcardRecord,
)
def rate_classroom_flashcard(
    space_id: str,
    card_id: str,
    payload: FlashcardRatingRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> FlashcardRecord:
    try:
        return _orchestrator(container).rate_flashcard(
            space_id=space_id,
            card_id=card_id,
            rating=payload.rating,
        )
    except ValueError as error:
        if str(error) == "Flashcard not found":
            raise _not_found(error) from error
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
