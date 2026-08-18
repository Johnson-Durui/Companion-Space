from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
import sqlite3
from collections.abc import AsyncIterator
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.models.domain import Citation, SessionState
from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.providers.factory import (
    build_provider_adapter as original_build_provider_adapter,
)
from app.providers.openai_compatible import OpenAICompatibleProvider
from app.services import provider_registry as provider_registry_module


def _auth_headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def _create_space(client, owner_token: str) -> str:
    response = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={
            "name": "Metrics Space",
            "topic": "algorithms",
            "goal": "finish the local funnel",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _create_character(client, owner_token: str) -> str:
    response = client.post(
        "/api/v1/characters",
        headers=_auth_headers(owner_token),
        json={
            "name": "Metrics Companion",
            "description": "A metrics fixture character",
            "recipe": {"relationship_role": "friend"},
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _create_note_material(client, owner_token: str, *, space_id: str) -> str:
    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/note",
        headers=_auth_headers(owner_token),
        json={
            "title": "Metrics note",
            "content": "Binary search requires a monotonic decision boundary.",
        },
    )
    assert response.status_code == 201
    payload = response.json()
    completed = get_container().spaces.wait_for_ingestion(
        payload["job"]["id"],
        timeout_seconds=2.0,
    )
    assert completed.status == "completed"
    return payload["material"]["id"]


def _create_and_end_session(
    client,
    owner_token: str,
    *,
    space_id: str,
    character_id: str,
) -> str:
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={
            "space_id": space_id,
            "character_pack_id": character_id,
        },
    )
    assert session.status_code == 201
    session_id = session.json()["id"]

    ended = client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=_auth_headers(owner_token),
        json={"summary": "Metrics recap seed"},
    )
    assert ended.status_code == 200
    return session_id


def _create_session(
    client,
    owner_token: str,
    *,
    space_id: str,
    character_id: str | None = None,
) -> str:
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={
            "space_id": space_id,
            "character_pack_id": character_id,
        },
    )
    assert session.status_code == 201
    return session.json()["id"]


def _submit_turn(
    client,
    owner_token: str,
    *,
    session_id: str,
    text: str,
) -> dict[str, Any]:
    response = client.post(
        f"/api/v1/sessions/{session_id}/turns",
        headers=_auth_headers(owner_token),
        json={"text": text},
    )
    assert response.status_code == 200
    return response.json()


def _patch_remote_adapter(
    monkeypatch: pytest.MonkeyPatch,
    handler,
) -> None:
    def build_adapter_with_mock_transport(connection, *, api_key):
        if connection.provider != "openai-compatible":
            return original_build_provider_adapter(connection, api_key=api_key)
        return OpenAICompatibleProvider(
            api_key=api_key or "",
            base_url=connection.base_url or "https://api.openai.com/v1",
            provider_name=connection.provider,
            timeout=45.0,
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        build_adapter_with_mock_transport,
    )


def _record_event(name: str, **payload: Any) -> None:
    get_container().metrics.record_event(name, payload)


def _realtime_origin(client) -> str:
    return str(client.base_url).rstrip("/")


def _issue_realtime_ticket(client, owner_token: str, session_id: str) -> dict[str, str]:
    response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 200
    return response.json()


def _assign_mock_capability(
    space_id: str,
    capability: ProviderCapability,
    *,
    model_name: str,
) -> None:
    get_container().providers.save_assignment(
        space_id=space_id,
        capability=capability,
        provider_connection_id="builtin-mock",
        model_name=model_name,
    )


def _assign_mock_audio_capabilities(space_id: str) -> None:
    _assign_mock_capability(
        space_id,
        ProviderCapability.stt,
        model_name="mock-stt-v1",
    )
    _assign_mock_capability(
        space_id,
        ProviderCapability.tts,
        model_name="mock-voice-v1",
    )


class SlowMetricsRealtimeAdapter(LLMProvider):
    name = "metrics-realtime-mock"

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[Any],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = model
        _ = system_prompt
        _ = history
        _ = user_message
        await asyncio.sleep(0.1)
        yield ProviderStreamChunk(
            text='{"display_text":"稍等一下',
            input_tokens=8,
        )
        await asyncio.sleep(0.2)
        yield ProviderStreamChunk(
            text='。","spoken_text":"稍等一下。","emotion":"warm","suggested_actions":[]}',
            output_tokens=16,
        )

    async def transcribe_pcm16(
        self,
        *,
        model: str,
        pcm16: bytes,
        sample_rate_hz: int,
    ) -> str:
        _ = model
        _ = pcm16
        _ = sample_rate_hz
        return "继续"

    async def synthesize_speech_stream(
        self,
        *,
        model: str,
        text: str,
        voice_id: str | None,
        speed: float,
        sample_rate_hz: int,
    ) -> AsyncIterator[bytes]:
        _ = model
        _ = text
        _ = voice_id
        _ = speed
        _ = sample_rate_hz
        await asyncio.sleep(0.05)
        yield b"\x10\x00" * 240


class MetricsRemoteChatAdapter(LLMProvider):
    name = "openai-compatible"

    async def discover_models(
        self,
        capability: ProviderCapability | None = None,
    ) -> list[str]:
        _ = capability
        return ["gpt-4.1-mini"]

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[Any],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = model
        _ = system_prompt
        _ = history
        _ = user_message
        yield ProviderStreamChunk(
            text='{"display_text":"远端模型已连接。","spoken_text":"远端模型已连接。","emotion":"warm","suggested_actions":[]}',
            input_tokens=7,
            output_tokens=9,
        )


def _patch_realtime_adapter(
    monkeypatch: pytest.MonkeyPatch,
    adapter: LLMProvider,
) -> None:
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: adapter,
    )


def _patch_remote_chat_adapter(
    monkeypatch: pytest.MonkeyPatch,
    adapter: LLMProvider,
) -> None:
    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        lambda connection, api_key: (
            adapter
            if connection.provider == "openai-compatible"
            else original_build_provider_adapter(connection, api_key=api_key)
        ),
    )


def test_local_metrics_summary_requires_owner_session(client) -> None:
    response = client.get("/api/v1/metrics/local/summary")

    assert response.status_code == 401
    assert response.json() == {"detail": "Owner session required"}


def test_local_metrics_events_requires_owner_session(client) -> None:
    response = client.get("/api/v1/metrics/local/events")

    assert response.status_code == 401
    assert response.json() == {"detail": "Owner session required"}


def test_local_metrics_activation_funnel_is_recorded_for_mock_flow(
    client,
    owner_token: str,
) -> None:
    space_id = _create_space(client, owner_token)
    character_id = _create_character(client, owner_token)
    _create_note_material(client, owner_token, space_id=space_id)
    session_id = _create_session(
        client,
        owner_token,
        space_id=space_id,
        character_id=character_id,
    )
    before_turn = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert before_turn.status_code == 200
    assert (
        before_turn.json()["activation"]["provider_connected_or_mock"] == 0
    )
    _submit_turn(
        client,
        owner_token,
        session_id=session_id,
        text="什么是 monotonic decision boundary？",
    )
    ended = client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=_auth_headers(owner_token),
        json={"summary": "Metrics recap seed"},
    )
    assert ended.status_code == 200

    recap = client.get(
        f"/api/v1/sessions/{session_id}",
        headers=_auth_headers(owner_token),
    )
    assert recap.status_code == 200

    events = client.get(
        "/api/v1/metrics/local/events?limit=20",
        headers=_auth_headers(owner_token),
    )
    assert events.status_code == 200
    payload = events.json()
    activation_events = [
        item["event"]
        for item in payload["items"]
        if item["event"]
        in {
            "vault_initialized",
            "provider_connected_or_mock",
            "space_created",
            "material_ready",
            "character_saved",
            "session_ended",
            "recap_viewed",
        }
    ]
    assert len(activation_events) == 7
    assert set(activation_events) == {
        "vault_initialized",
        "provider_connected_or_mock",
        "space_created",
        "material_ready",
        "character_saved",
        "session_ended",
        "recap_viewed",
    }
    serialized = str(payload).lower()
    assert "prompt" not in serialized
    assert "document" not in serialized
    assert "transcript" not in serialized
    assert "api_key" not in serialized

    summary = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert summary.status_code == 200
    assert summary.json()["activation"] == {
        "vault_initialized": 1,
        "provider_connected_or_mock": 1,
        "space_created": 1,
        "material_ready": 1,
        "character_saved": 1,
        "session_ended": 1,
        "recap_viewed": 1,
    }


def test_local_metrics_provider_connection_requires_mock_use_or_verified_remote_test(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry_module,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    initial = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert initial.status_code == 200
    assert initial.json()["activation"]["provider_connected_or_mock"] == 0

    created = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Metrics remote provider",
            "api_key": "sk-test-metrics-provider",
            "base_url": "https://api.example.com/custom-root",
        },
    )
    assert created.status_code == 201

    after_create = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert after_create.status_code == 200
    assert after_create.json()["activation"]["provider_connected_or_mock"] == 0

    _patch_remote_adapter(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            json={"data": [{"id": "gpt-4.1-mini"}]},
            request=request,
        ),
    )
    tested = client.post(
        f"/api/v1/providers/connections/{created.json()['id']}/test",
        headers=_auth_headers(owner_token),
    )
    assert tested.status_code == 200

    after_test = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert after_test.status_code == 200
    assert after_test.json()["activation"]["provider_connected_or_mock"] == 1


def test_local_metrics_successful_remote_turn_marks_provider_connected_without_testing(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry_module,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    created = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Metrics remote chat provider",
            "api_key": "sk-test-metrics-chat-provider",
            "base_url": "https://api.example.com/custom-root",
        },
    )
    assert created.status_code == 201
    space_id = _create_space(client, owner_token)
    character_id = _create_character(client, owner_token)
    _create_note_material(client, owner_token, space_id=space_id)
    get_container().providers.save_assignment(
        space_id=space_id,
        capability=ProviderCapability.chat_llm,
        provider_connection_id=created.json()["id"],
        model_name="gpt-4.1-mini",
    )
    _patch_remote_chat_adapter(monkeypatch, MetricsRemoteChatAdapter())

    before_turn = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert before_turn.status_code == 200
    assert before_turn.json()["activation"]["provider_connected_or_mock"] == 0

    session_id = _create_session(
        client,
        owner_token,
        space_id=space_id,
        character_id=character_id,
    )
    _submit_turn(
        client,
        owner_token,
        session_id=session_id,
        text="Explain the monotonic decision boundary in binary search.",
    )

    after_turn = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert after_turn.status_code == 200
    assert after_turn.json()["activation"]["provider_connected_or_mock"] == 1


def test_local_metrics_citation_accuracy_uses_real_retrieval_hits(
    client,
    owner_token: str,
) -> None:
    space_id = _create_space(client, owner_token)
    character_id = _create_character(client, owner_token)
    _create_note_material(client, owner_token, space_id=space_id)
    session_id = _create_session(
        client,
        owner_token,
        space_id=space_id,
        character_id=character_id,
    )

    turn = _submit_turn(
        client,
        owner_token,
        session_id=session_id,
        text="Explain the monotonic decision boundary in binary search.",
    )

    assert turn["citations"]
    summary = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert summary.status_code == 200
    assert summary.json()["quality"]["citation_verified"] == {
        "matched": len(turn["citations"]),
        "total": len(turn["citations"]),
    }
    assert summary.json()["rates"]["citation_accuracy"] == 1.0

    events = client.get(
        "/api/v1/metrics/local/events?limit=20",
        headers=_auth_headers(owner_token),
    )
    assert events.status_code == 200
    citation_event = next(
        item
        for item in events.json()["items"]
        if item["event"] == "citation_verified"
    )
    assert citation_event["payload"] == {
        "session_id": session_id,
        "matched": True,
    }


def test_local_metrics_citation_accuracy_can_record_mismatches_without_sensitive_content(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space_id = _create_space(client, owner_token)
    character_id = _create_character(client, owner_token)
    _create_note_material(client, owner_token, space_id=space_id)
    session_id = _create_session(
        client,
        owner_token,
        space_id=space_id,
        character_id=character_id,
    )

    original_build_assistant_turn = get_container().companion._build_assistant_turn

    def build_with_bad_citation(*args, **kwargs):
        turn = original_build_assistant_turn(*args, **kwargs)
        return turn.model_copy(
            update={
                "citations": [
                    Citation(
                        chunk_id="chunk_fake",
                        material_id="material_fake",
                        title="Fake title should not reach metrics",
                        locator="p.fake",
                        excerpt="Fake excerpt should not reach metrics",
                    )
                ]
            }
        )

    monkeypatch.setattr(
        get_container().companion,
        "_build_assistant_turn",
        build_with_bad_citation,
    )

    turn = _submit_turn(
        client,
        owner_token,
        session_id=session_id,
        text="Explain the monotonic decision boundary in binary search.",
    )

    assert turn["citations"] == [
        {
            "chunk_id": "chunk_fake",
            "material_id": "material_fake",
            "title": "Fake title should not reach metrics",
            "locator": "p.fake",
            "excerpt": "Fake excerpt should not reach metrics",
        }
    ]
    summary = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert summary.status_code == 200
    assert summary.json()["quality"]["citation_verified"] == {
        "matched": 0,
        "total": 1,
    }
    assert summary.json()["rates"]["citation_accuracy"] == 0.0

    events = client.get(
        "/api/v1/metrics/local/events?limit=20",
        headers=_auth_headers(owner_token),
    )
    assert events.status_code == 200
    citation_event = next(
        item
        for item in events.json()["items"]
        if item["event"] == "citation_verified"
    )
    assert citation_event["payload"] == {
        "session_id": session_id,
        "matched": False,
    }
    assert "fake title" not in str(citation_event).lower()
    assert "fake excerpt" not in str(citation_event).lower()


def test_local_metrics_summary_groups_reliability_quality_and_performance_events(
    client,
    owner_token: str,
) -> None:
    _ = owner_token
    _record_event("api_error", route="/api/v1/sessions", status_code=429)
    _record_event("ws_attempt", session_id="session_alpha")
    _record_event("ws_error", session_id="session_alpha", code="broken_pipe")
    _record_event(
        "ingestion_failed",
        space_id="space_alpha",
        material_id="material_alpha",
        code="parser_failed",
    )
    _record_event(
        "model_timeout",
        capability="chat_llm",
        provider_kind="mock",
        code="timeout",
    )
    _record_event(
        "text_fallback_used",
        session_id="session_alpha",
        code="missing_realtime_audio",
    )
    _record_event(
        "illegal_state_transition",
        session_id="session_alpha",
        state_from="speaking",
        state_to="thinking",
        code="active_turn_conflict",
    )
    _record_event("citation_verified", session_id="session_alpha", matched=True)
    _record_event("recap_edited", session_id="session_alpha")
    _record_event(
        "memory_candidate_confirmed",
        space_id="space_alpha",
        memory_id="memory_alpha",
    )
    _record_event(
        "memory_candidate_rejected",
        space_id="space_alpha",
        memory_id="memory_beta",
    )
    _record_event("interrupt_latency_ms", session_id="session_alpha", value=180)
    _record_event("first_audio_latency_ms", session_id="session_alpha", value=640)
    _record_event("avatar_fps", session_id="session_alpha", value=58)
    _record_event("soak_memory_delta_mb", session_id="session_alpha", value=6)
    _record_event("audio_residue_scan", session_id="session_alpha", residue_found=False)

    response = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 200
    assert response.json()["reliability"] == {
        "api_error": 1,
        "ws_error": 1,
        "ingestion_failed": 1,
        "model_timeout": 1,
        "text_fallback_used": 1,
        "illegal_state_transition": 1,
    }
    assert response.json()["quality"] == {
        "citation_verified": {"matched": 1, "total": 1},
        "recap_edited": 1,
        "memory_candidate_confirmed": 1,
        "memory_candidate_rejected": 1,
    }
    assert response.json()["performance"] == {
        "interrupt_latency_ms": {"count": 1, "max": 180, "p50": 180},
        "first_audio_latency_ms": {"count": 1, "max": 640, "p50": 640},
        "avatar_fps": {"count": 1, "min": 58, "p50": 58},
        "soak_memory_delta_mb": {"count": 1, "max": 6, "p50": 6},
        "audio_residue_scan": {"clean": 1, "residue_found": 0},
    }
    assert response.json()["rates"]["ws_error_rate"] == 1.0
    assert "review_regeneration_rate" not in response.json()["rates"]


@pytest.mark.parametrize(
    ("event_name", "payload"),
    [
        ("prompt_dump", {"space_id": "space_alpha"}),
        ("space_created", {"prompt": "leak the full prompt"}),
        ("space_created", {"document_body": "secret material body"}),
        ("space_created", {"transcript_text": "full transcript"}),
        ("space_created", {"api_key": "sk-test-123"}),
        ("session_ended", {"space_id": "space_alpha", "session_id": "session_beta"}),
        ("session_ended", {"session_id": "sk-test-123"}),
    ],
)
def test_local_metrics_rejects_unknown_events_and_body_content(
    owner_token: str,
    event_name: str,
    payload: dict[str, Any],
) -> None:
    _ = owner_token
    with pytest.raises(ValueError):
        _record_event(event_name, **payload)


def test_local_metrics_preserves_safe_space_and_session_identifiers(
    client,
    owner_token: str,
) -> None:
    _record_event(
        "session_ended",
        space_id="space_alpha",
        session_id="session_beta",
        duration_ms=3200,
    )

    response = client.get(
        "/api/v1/metrics/local/events?limit=5",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 200
    session_event = next(
        item
        for item in response.json()["items"]
        if item["event"] == "session_ended"
    )
    assert session_event["payload"] == {
        "space_id": "space_alpha",
        "session_id": "session_beta",
        "duration_ms": 3200,
    }


def test_companion_set_state_records_illegal_transition_and_allows_recovery(
    client,
    owner_token: str,
) -> None:
    space_id = _create_space(client, owner_token)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space_id},
    )
    assert session.status_code == 201
    session_id = session.json()["id"]

    with pytest.raises(ValueError, match="Illegal session state transition"):
        get_container().companion.set_state(
            session_id,
            SessionState.speaking,
            reason_code="test_idle_to_speaking",
        )

    recovered_error = get_container().companion.set_state(
        session_id,
        SessionState.error,
        reason_code="test_mark_error",
    )
    assert recovered_error.state is SessionState.error

    same_state = get_container().companion.set_state(
        session_id,
        SessionState.error,
        reason_code="test_same_state_noop",
    )
    assert same_state.state is SessionState.error

    listening = get_container().companion.set_state(
        session_id,
        SessionState.listening,
        reason_code="test_error_recovery",
    )
    assert listening.state is SessionState.listening

    events = client.get(
        "/api/v1/metrics/local/events?limit=10",
        headers=_auth_headers(owner_token),
    )
    assert events.status_code == 200
    illegal = [
        item
        for item in events.json()["items"]
        if item["event"] == "illegal_state_transition"
    ]
    assert illegal == [
        {
            "id": illegal[0]["id"],
            "event": "illegal_state_transition",
            "payload": {
                "session_id": session_id,
                "state_from": "idle",
                "state_to": "speaking",
                "code": "test_idle_to_speaking",
            },
            "occurred_at": illegal[0]["occurred_at"],
        }
    ]


def test_local_metrics_ws_error_rate_counts_failed_handshakes(
    client,
    owner_token: str,
) -> None:
    space_id = _create_space(client, owner_token)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space_id},
    )
    assert session.status_code == 201
    session_id = session.json()["id"]

    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect(
            f"/api/v1/sessions/{session_id}/realtime",
            headers={"origin": _realtime_origin(client)},
        ):
            pass
    assert rejected.value.code == 4401

    summary = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert summary.status_code == 200
    assert summary.json()["reliability"]["ws_error"] == 1
    assert summary.json()["rates"]["ws_error_rate"] == 1.0


def test_local_metrics_records_illegal_state_transition_for_realtime_turn_conflicts(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_realtime_adapter(monkeypatch, SlowMetricsRealtimeAdapter())
    space_id = _create_space(client, owner_token)
    _assign_mock_audio_capabilities(space_id)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space_id},
    )
    assert session.status_code == 201
    session_id = session.json()["id"]
    ticket = _issue_realtime_ticket(client, owner_token, session_id)

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "开始"}})
        assert websocket.receive_json()["type"] == "asr.final"
        websocket.send_json({"type": "user.commit", "payload": {"text": "再来一次"}})
        error_event = websocket.receive_json()
        assert error_event["type"] == "error"
        assert "active turn" in error_event["payload"]["detail"].lower()

    events = client.get(
        "/api/v1/metrics/local/events?limit=10",
        headers=_auth_headers(owner_token),
    )
    assert events.status_code == 200
    illegal = next(
        item
        for item in events.json()["items"]
        if item["event"] == "illegal_state_transition"
    )
    assert illegal["payload"] == {
        "session_id": session_id,
        "state_from": "thinking",
        "state_to": "thinking",
        "code": "active_turn_conflict",
    }


def test_local_metric_client_signals_are_owner_only_and_forbid_extra_content(
    client,
    owner_token: str,
) -> None:
    space_id = _create_space(client, owner_token)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space_id},
    )
    assert session.status_code == 201
    signal = {
        "event": "avatar_fps",
        "session_id": session.json()["id"],
        "value": 59,
    }
    assert client.post(
        "/api/v1/metrics/local/signals",
        json=signal,
    ).status_code == 401
    assert client.post(
        "/api/v1/metrics/local/signals",
        headers=_auth_headers(owner_token),
        json={**signal, "api_key": "sk-test-must-not-be-ignored"},
    ).status_code == 422
    assert client.post(
        "/api/v1/metrics/local/signals",
        headers=_auth_headers(owner_token),
        json={**signal, "session_id": "session-not-real"},
    ).status_code == 404

    accepted = client.post(
        "/api/v1/metrics/local/signals",
        headers=_auth_headers(owner_token),
        json=signal,
    )
    assert accepted.status_code == 204
    fallback = client.post(
        "/api/v1/metrics/local/signals",
        headers=_auth_headers(owner_token),
        json={
            "event": "text_fallback_used",
            "session_id": session.json()["id"],
            "code": "microphone_denied",
        },
    )
    assert fallback.status_code == 204
    assert client.post(
        "/api/v1/metrics/local/signals",
        headers=_auth_headers(owner_token),
        json={
            "event": "text_fallback_used",
            "session_id": session.json()["id"],
            "code": "custom-secret-code",
        },
    ).status_code == 422
    summary = client.get(
        "/api/v1/metrics/local/summary",
        headers=_auth_headers(owner_token),
    )
    assert summary.json()["performance"]["avatar_fps"] == {
        "count": 1,
        "min": 59,
        "p50": 59,
    }
    assert summary.json()["reliability"]["text_fallback_used"] == 1


def test_local_metric_rows_never_store_provider_keys_or_material_text(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    api_key = "sk-local-metrics-plaintext-sentinel"
    material_text = "METRICS_DOCUMENT_BODY_MUST_NEVER_APPEAR"
    provider = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Metrics privacy provider",
            "api_key": api_key,
        },
    )
    assert provider.status_code == 201
    space_id = _create_space(client, owner_token)
    note = client.post(
        f"/api/v1/spaces/{space_id}/materials/note",
        headers=_auth_headers(owner_token),
        json={"title": "Private metric note", "content": material_text},
    )
    assert note.status_code == 201

    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        rows = connection.execute(
            "SELECT event_name, payload_json FROM local_metric_events"
        ).fetchall()
    serialized = repr(rows)
    assert api_key not in serialized
    assert material_text not in serialized
