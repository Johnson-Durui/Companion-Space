from __future__ import annotations

import json

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
)
from fastapi.responses import StreamingResponse

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_owner,
)
from app.api.routes.realtime import (
    _resolve_realtime_audio_assignments,
    _serialize_companion_event,
    _serialize_provider_error_event,
)
from app.models.api_v1 import (
    RealtimeTicketResponse,
    SessionCreateRequest,
    SessionDemoRequest,
    SessionDemoResponse,
    SessionRecapUpdateRequest,
    SessionSummaryRequest,
    SessionTranscriptResponse,
    SessionTurnRequest,
)
from app.providers.errors import (
    ProviderError,
    ProviderProtocolError,
)
from app.services.companion import (
    CharacterNotFoundError,
    SessionNotFoundError,
)

router = APIRouter()


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    session = container.companion.create_session(
        space_id=payload.space_id,
        character_pack_id=payload.character_pack_id,
    )
    container.metrics.record_event_safe(
        "session_started",
        {"space_id": session.space_id, "session_id": session.id},
        once=True,
    )
    return session


@router.get("/spaces/{space_id}/sessions")
def list_sessions(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.companion.list_sessions(space_id)


@router.get("/sessions/{session_id}", response_model=SessionTranscriptResponse)
def get_session_transcript(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.get_session(session_id)
    turns = container.repository.list_turns(session_id)
    if session.ended_at is not None:
        container.metrics.record_event_safe(
            "recap_viewed",
            {"space_id": session.space_id, "session_id": session.id},
            once=True,
        )
    return SessionTranscriptResponse(
        session=session,
        turns=turns,
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )


@router.post(
    "/sessions/{session_id}/realtime-ticket", response_model=RealtimeTicketResponse
)
def issue_realtime_ticket(
    session_id: str,
    owner_token: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> RealtimeTicketResponse:
    try:
        session = container.companion.get_session(session_id)
    except SessionNotFoundError as error:
        raise HTTPException(status_code=404, detail="Session not found") from error
    try:
        container.companion.get_session_character(session_id)
    except CharacterNotFoundError as error:
        raise HTTPException(
            status_code=409,
            detail="Session character is unavailable",
        ) from error
    try:
        _resolve_realtime_audio_assignments(
            container=container,
            session=session,
        )
    except (ProviderError, ValueError):
        container.metrics.record_event_safe(
            "text_fallback_used",
            {
                "session_id": session_id,
                "code": "missing_realtime_audio",
            },
        )
        raise
    ticket, expires_at = container.vault.issue_realtime_ticket(
        owner_token, session_id=session_id
    )
    return RealtimeTicketResponse(ticket=ticket, expires_at=expires_at)


@router.post("/sessions/{session_id}/turns")
async def create_turn(
    session_id: str,
    payload: SessionTurnRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return await container.companion.submit_text_turn(
        session_id=session_id, text=payload.text
    )


@router.post("/sessions/{session_id}/demos", response_model=SessionDemoResponse)
async def create_demo(
    session_id: str,
    payload: SessionDemoRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionDemoResponse:
    demo = await container.demos.create_demo(
        session_id=session_id,
        topic=payload.topic,
    )
    return SessionDemoResponse.model_validate(demo)


@router.post("/sessions/{session_id}/turns/stream")
async def stream_turn(
    session_id: str,
    payload: SessionTurnRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> StreamingResponse:
    stream = container.companion.stream_text_turn(
        session_id=session_id,
        text=payload.text,
    )
    try:
        first_event = await stream.__anext__()
    except StopAsyncIteration as exc:
        raise ProviderProtocolError(
            provider="companion",
            public_detail="The provider stream ended without a reply.",
        ) from exc

    async def event_lines():
        yield (
            json.dumps(
                _serialize_companion_event(session_id, first_event),
                ensure_ascii=False,
            )
            + "\n"
        )
        try:
            async for event in stream:
                yield (
                    json.dumps(
                        _serialize_companion_event(session_id, event),
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except ProviderError as error:
            yield (
                json.dumps(
                    _serialize_provider_error_event(session_id, error),
                    ensure_ascii=False,
                )
                + "\n"
            )

    return StreamingResponse(
        event_lines(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/sessions/{session_id}/end")
async def end_session(
    session_id: str,
    payload: SessionSummaryRequest | None = None,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    session = container.companion.end_session(
        session_id,
        summary=payload.summary if payload else "",
    )
    container.companion.schedule_learning_artifacts(
        session_id=session_id,
        include_candidates=True,
    )
    duration_ms = 0
    if session.ended_at is not None:
        duration_ms = max(
            int((session.ended_at - session.created_at).total_seconds() * 1000),
            0,
        )
    container.metrics.record_event_safe(
        "session_ended",
        {
            "space_id": session.space_id,
            "session_id": session.id,
            "duration_ms": duration_ms,
        },
        once=True,
    )
    return session


@router.put("/sessions/{session_id}/recap", response_model=SessionTranscriptResponse)
def update_session_recap(
    session_id: str,
    payload: SessionRecapUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.update_session_recap(
        session_id=session_id,
        summary=payload.summary,
        notes=payload.notes,
    )
    container.metrics.record_event_safe(
        "recap_edited",
        {"session_id": session.id},
        once=True,
    )
    return SessionTranscriptResponse(
        session=session,
        turns=container.repository.list_turns(session_id),
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )


@router.post(
    "/sessions/{session_id}/recap/undo", response_model=SessionTranscriptResponse
)
def undo_session_recap(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.undo_session_recap(session_id)
    return SessionTranscriptResponse(
        session=session,
        turns=container.repository.list_turns(session_id),
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )
