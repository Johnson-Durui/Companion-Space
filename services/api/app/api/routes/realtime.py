from __future__ import annotations

import asyncio
import json
import re
from contextlib import suppress
from urllib.parse import urlsplit

from fastapi import (
    APIRouter,
    WebSocket,
    WebSocketDisconnect,
)

from app.api.deps import (
    ServiceContainer,
    get_container,
)
from app.models.domain import (
    ProviderCapability,
    SessionRecord,
    SessionState,
    TtsPlaybackPolicy,
)
from app.providers.errors import (
    ProviderError,
    ProviderProtocolError,
    ProviderTimeoutError,
    provider_error_code,
    provider_error_payload,
)
from app.services.companion import (
    CharacterNotFoundError,
    CompanionStreamEvent,
    SessionNotFoundError,
)
from app.services.provider_registry import (
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_NEURAL_TTS_CONNECTION_ID,
    ResolvedProvider,
)
from app.services.realtime import (
    PCM16_SAMPLE_RATE_HZ,
    TTS_CONTENT_TYPE,
    TTS_SAMPLE_RATE_HZ,
    RealtimeConnectionState,
)

router = APIRouter()

REALTIME_PROTOCOL = "companion-v1"
REALTIME_TICKET_PREFIX = "ticket."
DEMO_REQUEST_PATTERN = re.compile(r"(演示一下|演示下|demo)", re.IGNORECASE)
DEMO_TOPIC_PREFIX_PATTERN = re.compile(
    r"^\s*(请|麻烦|帮我)?\s*(演示一下|演示下|demo)\s*[:：,， ]*\s*",
    re.IGNORECASE,
)


def _origin_allowed(
    origin: str | None, websocket: WebSocket, container: ServiceContainer
) -> bool:
    if not origin:
        return False
    candidate = origin.strip().lower()
    if candidate in container.settings.websocket_allowed_origins:
        return True
    parsed = urlsplit(candidate)
    host = websocket.headers.get("host", "").strip().lower()
    if not parsed.scheme or not parsed.netloc or not host:
        return False
    if parsed.netloc != host:
        return False
    return parsed.scheme in {"http", "https"}


def _extract_realtime_ticket(protocol_header: str | None) -> str | None:
    if not protocol_header:
        return None
    protocols = [item.strip() for item in protocol_header.split(",") if item.strip()]
    if REALTIME_PROTOCOL not in protocols:
        return None
    ticket_protocol = next(
        (item for item in protocols if item.startswith(REALTIME_TICKET_PREFIX)), None
    )
    if ticket_protocol is None:
        return None
    ticket = ticket_protocol[len(REALTIME_TICKET_PREFIX) :].strip()
    return ticket or None


def _is_demo_request(text: str) -> bool:
    return bool(DEMO_REQUEST_PATTERN.search(text))


def _derive_demo_topic(
    *,
    text: str,
    user_history: list[str],
    fallback_topic: str,
) -> str:
    stripped = DEMO_TOPIC_PREFIX_PATTERN.sub("", text).strip("：:，, 。.!?？")
    if stripped:
        return stripped
    for item in reversed(user_history):
        candidate = item.strip()
        if candidate and candidate != text.strip():
            return candidate[:240]
    fallback = fallback_topic.strip()
    return (fallback or "当前学习主题")[:240]


def _serialize_companion_event(
    session_id: str,
    event: CompanionStreamEvent,
) -> dict:
    payload: dict
    if event.type == "llm.delta":
        payload = {"text": event.text}
    elif event.turn is not None:
        payload = event.turn.model_dump(mode="json")
    elif event.payload is not None:
        payload = event.payload
    else:
        payload = {}
    return {
        "type": event.type,
        "session_id": session_id,
        "state": event.state.value,
        "payload": payload,
    }


def _serialize_provider_error_event(
    session_id: str,
    error: ProviderError,
) -> dict:
    payload = provider_error_payload(error)
    payload["message"] = payload["detail"]
    return _realtime_event(
        session_id,
        event_type="error",
        state=SessionState.error,
        payload=payload,
    )


def _realtime_event(
    session_id: str,
    *,
    event_type: str,
    state: SessionState,
    payload: dict,
) -> dict:
    return {
        "type": event_type,
        "session_id": session_id,
        "state": state.value,
        "payload": payload,
    }


def _error_event(session_id: str, *, detail: str) -> dict:
    return _realtime_event(
        session_id,
        event_type="error",
        state=SessionState.error,
        payload={
            "message": detail,
            "detail": detail,
            "code": "realtime_protocol_error",
        },
    )


def _parse_realtime_client_event(raw_text: str, *, session_id: str) -> dict:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid realtime JSON payload.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Realtime payload must be a JSON object.")
    payload_session_id = payload.get("session_id")
    if payload_session_id is not None and payload_session_id != session_id:
        raise ValueError("Realtime payload session_id mismatch.")
    return payload


def _resolve_realtime_audio_assignments(
    *,
    container: ServiceContainer,
    session: SessionRecord,
) -> tuple[ResolvedProvider, ResolvedProvider, TtsPlaybackPolicy]:
    stt_resolved = container.providers.resolve(
        space_id=session.space_id,
        capability=ProviderCapability.stt,
    )
    if (
        session.tts_connection_id is not None
        and session.tts_model_name is not None
        and session.tts_playback_policy is not None
    ):
        tts_resolved = container.providers.resolve_pinned(
            space_id=session.space_id,
            capability=ProviderCapability.tts,
            connection_id=session.tts_connection_id,
            model_name=session.tts_model_name,
        )
        tts_playback_policy = session.tts_playback_policy
    else:
        tts_resolved = container.providers.resolve(
            space_id=session.space_id,
            capability=ProviderCapability.tts,
        )
        tts_playback_policy = (
            "browser-compat"
            if tts_resolved.connection.id == BUILTIN_MOCK_CONNECTION_ID
            else "server-neural"
            if tts_resolved.connection.id == BUILTIN_NEURAL_TTS_CONNECTION_ID
            else "server"
        )
    return stt_resolved, tts_resolved, tts_playback_policy


@router.websocket("/sessions/{session_id}/realtime")
async def realtime_session(websocket: WebSocket, session_id: str) -> None:
    container = get_container()
    container.metrics.record_event_safe(
        "ws_attempt",
        {"session_id": session_id},
    )
    if websocket.query_params.get("token") or websocket.query_params.get("owner_token"):
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "query_token_rejected"},
        )
        await websocket.close(code=4401, reason="Owner session required")
        return
    if not _origin_allowed(websocket.headers.get("origin"), websocket, container):
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "origin_rejected"},
        )
        await websocket.close(code=4403, reason="Origin not allowed")
        return
    ticket = _extract_realtime_ticket(websocket.headers.get("sec-websocket-protocol"))
    owner_session_id = (
        container.vault.consume_realtime_ticket(ticket or "", session_id=session_id)
        if ticket
        else None
    )
    if owner_session_id is None:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "owner_session_required"},
        )
        await websocket.close(code=4401, reason="Owner session required")
        return

    try:
        session = container.companion.get_session(session_id)
        container.companion.get_session_character(session_id)
        (
            stt_resolved,
            tts_resolved,
            tts_playback_policy,
        ) = _resolve_realtime_audio_assignments(
            container=container,
            session=session,
        )
    except SessionNotFoundError:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "session_not_found"},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(code=4404, reason="Session not found")
        return
    except CharacterNotFoundError:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "session_character_unavailable"},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(code=4409, reason="Session character is unavailable")
        return
    except ProviderError as error:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": provider_error_code(error)},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(
            code=1011, reason="Realtime audio provider is unavailable"
        )
        return

    await websocket.accept(subprotocol=REALTIME_PROTOCOL)
    container.metrics.record_event_safe(
        "ws_connection",
        {"session_id": session_id},
    )
    runtime = RealtimeConnectionState()
    cleanup_tasks: set[asyncio.Task[object]] = set()

    def record_ws_error(code: str) -> None:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": code},
        )

    def track_turn_cleanup(task: asyncio.Task[object]) -> None:
        cleanup_tasks.add(task)

        def observe(completed: asyncio.Task[object]) -> None:
            cleanup_tasks.discard(completed)
            if completed.cancelled():
                return
            if completed.exception() is not None:
                record_ws_error("turn_cleanup_failed")

        task.add_done_callback(observe)

    def transition_state(
        target: SessionState,
        *,
        code: str,
    ) -> SessionState:
        try:
            return container.companion.set_state(
                session_id,
                target,
                reason_code=code,
            ).state
        except ValueError:
            return container.companion.get_session(session_id).state

    def record_provider_failure(
        error: ProviderError,
        *,
        capability: ProviderCapability,
    ) -> None:
        code = provider_error_code(error)
        record_ws_error(code)
        if isinstance(error, ProviderTimeoutError):
            container.metrics.record_event_safe(
                "model_timeout",
                {
                    "capability": capability.value,
                    "provider_kind": error.provider,
                    "code": code,
                },
            )

    async def send_json_event(event: dict, *, generation: int | None = None) -> bool:
        if generation is not None and not runtime.is_generation_current(generation):
            return False
        async with runtime.send_lock:
            if generation is not None and not runtime.is_generation_current(generation):
                return False
            if not container.vault.validate_owner_session(owner_session_id):
                with suppress(RuntimeError):
                    await websocket.close(code=4401, reason="Owner session required")
                return False
            await websocket.send_json(event)
        return True

    async def send_audio_bytes(chunk: bytes, *, generation: int) -> bool:
        if not chunk or not runtime.is_generation_current(generation):
            return False
        async with runtime.send_lock:
            if not runtime.is_generation_current(generation):
                return False
            if not container.vault.validate_owner_session(owner_session_id):
                with suppress(RuntimeError):
                    await websocket.close(code=4401, reason="Owner session required")
                return False
            await websocket.send_bytes(chunk)
        return True

    async def run_turn(
        *,
        generation: int,
        resolved_text: str,
    ) -> None:
        try:
            turn = None
            async for event in container.companion.stream_text_turn(
                session_id=session_id,
                text=resolved_text,
                defer_speaking=True,
            ):
                if not await send_json_event(
                    _serialize_companion_event(session_id, event),
                    generation=generation,
                ):
                    return
                if event.turn is not None:
                    turn = event.turn

            if turn is None:
                raise ProviderProtocolError(
                    provider="companion",
                    public_detail="The provider stream ended without a final reply.",
                )

            if not runtime.is_generation_current(generation):
                return

            if tts_playback_policy == "browser-compat":
                transition_state(SessionState.idle, code="tts_browser_compat")
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="tts.chunk",
                        state=SessionState.idle,
                        payload={
                            "final": True,
                            "sequence": 0,
                            "audio_bytes": 0,
                        },
                    ),
                    generation=generation,
                )
                return

            character = container.companion.get_session_character(session_id)
            total_audio_bytes = 0
            sequence = 0
            started_speaking = False
            speech_kwargs = {
                "model": tts_resolved.assignment.model_name,
                "text": turn.spoken_text,
                "voice_id": character.recipe.voice_id,
                "speed": character.recipe.speaking_rate,
                "sample_rate_hz": TTS_SAMPLE_RATE_HZ,
            }
            if getattr(tts_resolved.adapter, "supports_companion_emotion", False):
                speech_kwargs["emotion"] = turn.emotion
            async for chunk in tts_resolved.adapter.synthesize_speech_stream(
                **speech_kwargs
            ):
                if not chunk:
                    continue
                if not started_speaking:
                    transition_state(
                        SessionState.speaking,
                        code="tts_started",
                    )
                    started_speaking = True
                if not await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="tts.chunk",
                        state=SessionState.speaking,
                        payload={
                            "final": False,
                            "sequence": sequence,
                            "byte_length": len(chunk),
                            "content_type": TTS_CONTENT_TYPE,
                            "sample_rate_hz": TTS_SAMPLE_RATE_HZ,
                            "preview_text": turn.spoken_text,
                        },
                    ),
                    generation=generation,
                ):
                    return
                if not await send_audio_bytes(chunk, generation=generation):
                    return
                total_audio_bytes += len(chunk)
                sequence += 1

            if not runtime.is_generation_current(generation):
                return
            transition_state(SessionState.idle, code="tts_completed")
            await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="tts.chunk",
                    state=SessionState.idle,
                    payload={
                        "final": True,
                        "sequence": sequence,
                        "audio_bytes": total_audio_bytes,
                    },
                ),
                generation=generation,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.tts,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="tts_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )

    async def run_demo(
        *,
        generation: int,
        topic: str,
    ) -> None:
        try:
            transition_state(SessionState.thinking, code="demo_started")
            demo = await container.demos.create_demo(
                session_id=session_id,
                topic=topic,
            )
            if not runtime.is_generation_current(generation):
                return
            transition_state(SessionState.idle, code="demo_completed")
            await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="demo.ready",
                    state=SessionState.idle,
                    payload=demo,
                ),
                generation=generation,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.analysis_llm,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="demo_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )

    async def run_commit(
        *,
        generation: int,
        committed_text: str,
        committed_audio: bytes,
    ) -> None:
        try:
            resolved_text = committed_text
            if not resolved_text and committed_audio:
                resolved_text = (
                    await stt_resolved.adapter.transcribe_pcm16(
                        model=stt_resolved.assignment.model_name,
                        pcm16=committed_audio,
                        sample_rate_hz=PCM16_SAMPLE_RATE_HZ,
                    )
                ).strip()
            if not resolved_text:
                resolved_text = "继续陪我学习。"

            if not await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="asr.final",
                    state=SessionState.thinking,
                    payload={
                        "text": resolved_text,
                        "audio_bytes": len(committed_audio),
                    },
                ),
                generation=generation,
            ):
                return

            if _is_demo_request(resolved_text):
                space = container.spaces.require_space(session.space_id)
                await run_demo(
                    generation=generation,
                    topic=_derive_demo_topic(
                        text=resolved_text,
                        user_history=[
                            turn.display_text
                            for turn in container.repository.list_turns(session_id)
                            if turn.role.value == "user"
                        ],
                        fallback_topic=space.topic or space.goal,
                    ),
                )
                return

            await run_turn(
                generation=generation,
                resolved_text=resolved_text,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.stt,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="commit_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )
        except SessionNotFoundError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("session_not_found")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=4404,
                            reason="Session not found",
                        )
        except CharacterNotFoundError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("session_character_unavailable")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=4409,
                            reason="Session character is unavailable",
                        )
        except ValueError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("invalid_session_state")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=1011,
                            reason="Realtime session state is invalid",
                        )
        finally:
            runtime.finish_turn(generation)

    await send_json_event(
        _realtime_event(
            session_id,
            event_type="session.open",
            state=SessionState.idle,
            payload={
                "tts_playback_policy": tts_playback_policy,
                "tts_connection_id": tts_resolved.connection.id,
                "tts_model": tts_resolved.assignment.model_name,
            },
        )
    )
    try:
        while True:
            if not container.vault.validate_owner_session(owner_session_id):
                await websocket.close(code=4401, reason="Owner session required")
                break
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if not container.vault.validate_owner_session(owner_session_id):
                await websocket.close(code=4401, reason="Owner session required")
                break
            if message.get("bytes") is not None:
                try:
                    buffered_audio_bytes = runtime.append_audio_frame(message["bytes"])
                except ValueError as error:
                    record_ws_error("invalid_audio_frame")
                    transition_state(
                        SessionState.error,
                        code="invalid_audio_frame",
                    )
                    await send_json_event(_error_event(session_id, detail=str(error)))
                    continue
                if runtime.has_active_turn():
                    partial_state = container.companion.get_session(session_id).state
                    if partial_state not in {
                        SessionState.thinking,
                        SessionState.speaking,
                    }:
                        partial_state = SessionState.thinking
                else:
                    partial_state = SessionState.listening
                    transition_state(
                        SessionState.listening,
                        code="audio_frame_received",
                    )
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="asr.partial",
                        state=partial_state,
                        payload={"buffered_audio_bytes": buffered_audio_bytes},
                    )
                )
                continue

            if message.get("text") is None:
                continue
            try:
                payload = _parse_realtime_client_event(
                    message["text"],
                    session_id=session_id,
                )
            except ValueError as error:
                record_ws_error("invalid_event_payload")
                transition_state(
                    SessionState.error,
                    code="invalid_event_payload",
                )
                await send_json_event(_error_event(session_id, detail=str(error)))
                continue
            event_type = payload.get("type")
            if not isinstance(event_type, str) or not event_type:
                record_ws_error("missing_event_type")
                transition_state(
                    SessionState.error,
                    code="missing_event_type",
                )
                await send_json_event(
                    _error_event(session_id, detail="Realtime event type is required.")
                )
                continue
            event_payload = payload.get("payload", {})
            if event_payload is None:
                event_payload = {}
            if not isinstance(event_payload, dict):
                record_ws_error("invalid_event_body")
                transition_state(
                    SessionState.error,
                    code="invalid_event_body",
                )
                await send_json_event(
                    _error_event(
                        session_id, detail="Realtime payload.payload must be an object."
                    )
                )
                continue
            if event_type == "heartbeat":
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="heartbeat",
                        state=container.companion.get_session(session_id).state,
                        payload={},
                    )
                )
                continue
            if event_type == "turn.interrupt":
                if event_payload.get("clear_audio_buffer") is True:
                    runtime.clear_audio_buffer()
                pending_task = runtime.interrupt_active_turn()
                if pending_task is None:
                    current_state = container.companion.get_session(session_id).state
                    if current_state == SessionState.listening:
                        current_state = transition_state(
                            SessionState.idle,
                            code="audio_buffer_cleared",
                        )
                    await send_json_event(
                        _realtime_event(
                            session_id,
                            event_type="turn.interrupted",
                            state=current_state,
                            payload={"active": False},
                        )
                    )
                    continue
                track_turn_cleanup(pending_task)
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="turn.interrupted",
                        state=SessionState.interrupted,
                        payload={"active": True},
                    )
                )
                # Acknowledge cancellation before a slow SQLite commit. Await
                # persistence off-loop before accepting the next client event.
                await asyncio.to_thread(
                    transition_state,
                    SessionState.interrupted,
                    code="turn_interrupted",
                )
                continue
            if event_type != "user.commit":
                record_ws_error("unsupported_event")
                transition_state(
                    SessionState.error,
                    code="unsupported_event",
                )
                await send_json_event(
                    _error_event(session_id, detail="Unsupported realtime event.")
                )
                continue

            current_session_state = container.companion.get_session(session_id).state
            if runtime.has_active_turn() or current_session_state in {
                SessionState.thinking,
                SessionState.speaking,
            }:
                record_ws_error("active_turn_conflict")
                container.companion.record_illegal_state_transition(
                    session_id,
                    SessionState.thinking,
                    reason_code="active_turn_conflict",
                )
                transition_state(
                    SessionState.error,
                    code="active_turn_conflict_error",
                )
                await send_json_event(
                    _error_event(
                        session_id,
                        detail="Realtime session already has an active turn.",
                    )
                )
                continue
            text_payload = event_payload.get("text")
            committed_text = (
                text_payload.strip() if isinstance(text_payload, str) else ""
            )
            committed_audio = runtime.consume_audio_buffer()
            generation = runtime.reserve_generation()
            task = asyncio.create_task(
                run_commit(
                    generation=generation,
                    committed_text=committed_text,
                    committed_audio=committed_audio,
                )
            )
            runtime.bind_turn(generation=generation, task=task)
    except WebSocketDisconnect:
        return
    except SessionNotFoundError:
        record_ws_error("session_not_found")
        with suppress(RuntimeError):
            await websocket.close(code=4404, reason="Session not found")
        return
    except CharacterNotFoundError:
        record_ws_error("session_character_unavailable")
        with suppress(RuntimeError):
            await websocket.close(code=4409, reason="Session character is unavailable")
        return
    except RuntimeError:
        record_ws_error("runtime_error")
        return
    finally:
        pending_task = runtime.interrupt_active_turn()
        if pending_task is not None:
            track_turn_cleanup(pending_task)
        if cleanup_tasks:
            await asyncio.gather(*tuple(cleanup_tasks), return_exceptions=True)
        runtime.clear_audio_buffer()
        with suppress(ValueError):
            container.companion.end_session(session_id)
            container.companion.schedule_learning_artifacts(
                session_id=session_id,
                include_candidates=True,
            )
