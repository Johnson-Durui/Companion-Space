from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.core.config import Settings
from app.models.domain import CompanionEmotion, ProviderCapability, ProviderConnection
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.services.provider_registry import (
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_MOCK_TTS_MODEL,
    ProviderRegistryService,
)
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService
from app.services.vault import VaultService


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _realtime_origin(client) -> str:
    return str(client.base_url).rstrip("/")


def _issue_realtime_ticket(client, owner_token: str, session_id: str) -> dict[str, str]:
    response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 200
    return response.json()


def _iter_storage_files(storage_root: Path) -> list[Path]:
    return [path for path in storage_root.rglob("*") if path.is_file()]


def _storage_contains(storage_root: Path, needle: bytes) -> bool:
    return any(needle in path.read_bytes() for path in _iter_storage_files(storage_root))


def _assert_storage_omits_bytes(storage_root: Path, *needles: bytes) -> None:
    for needle in needles:
        if _storage_contains(storage_root, needle):
            raise AssertionError("sensitive audio bytes were persisted to storage")


def _assign_mock_capability(
    space_id: str,
    capability: ProviderCapability,
    *,
    model_name: str,
    provider_connection_id: str = "builtin-mock",
) -> None:
    get_container().providers.save_assignment(
        space_id=space_id,
        capability=capability,
        provider_connection_id=provider_connection_id,
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


class RealtimeMockAdapter(LLMProvider):
    name = "realtime-mock"

    def __init__(
        self,
        *,
        transcript: str = "这是一段用于联调语音链路的模拟转写。",
        llm_chunks: list[str] | None = None,
        tts_chunks: list[bytes] | None = None,
    ) -> None:
        self.transcript = transcript
        self.llm_chunks = llm_chunks or [
            '{"display_text":"这是一个实时语音回复',
            '。","spoken_text":"这是一个实时语音回复。","emotion":"warm","suggested_actions":[]}',
        ]
        self.tts_chunks = tts_chunks or [b"\x10\x00" * 480]
        self.transcribe_calls: list[dict[str, Any]] = []
        self.tts_calls: list[dict[str, Any]] = []

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[Any],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = system_prompt
        _ = history
        for index, chunk in enumerate(self.llm_chunks):
            yield ProviderStreamChunk(
                text=chunk,
                input_tokens=max(len(user_message) // 4, 1),
                output_tokens=16 if index == len(self.llm_chunks) - 1 else None,
            )

    async def transcribe_pcm16(
        self,
        model: str,
        pcm16: bytes,
        *,
        sample_rate_hz: int = 16000,
    ) -> str:
        self.transcribe_calls.append(
            {
                "model": model,
                "pcm16": pcm16,
                "sample_rate_hz": sample_rate_hz,
            }
        )
        return self.transcript

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        *,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        self.tts_calls.append(
            {
                "model": model,
                "text": text,
                "voice_id": voice_id,
                "speed": speed,
                "sample_rate_hz": sample_rate_hz,
            }
        )
        for chunk in self.tts_chunks:
            yield chunk


def _patch_realtime_adapter(
    monkeypatch: pytest.MonkeyPatch,
    adapter: LLMProvider,
) -> None:
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: adapter,
    )


def test_vault_and_provider_registry_flow(client, owner_token) -> None:
    registry = client.get("/api/v1/providers/registry", headers=_auth_headers(owner_token))
    assert registry.status_code == 200
    assert any(item["provider"] == "mock" for item in registry.json())

    create = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={"provider": "mock", "label": "Local Mock", "api_key": "mock-key"},
    )
    assert create.status_code == 201
    connection_id = create.json()["id"]

    models = client.get(f"/api/v1/providers/connections/{connection_id}/models", headers=_auth_headers(owner_token))
    assert models.status_code == 200
    assert "mock-companion-v1" in models.json()["models"]

    health = client.post(f"/api/v1/providers/connections/{connection_id}/test", headers=_auth_headers(owner_token))
    assert health.status_code == 200
    assert health.json()["ok"] is True


def test_realtime_session_keeps_audio_ephemeral(client, owner_token, caplog: pytest.LogCaptureFixture) -> None:
    storage_root = get_container().settings.storage_root
    probe = storage_root / "probe-audio.bin"
    probe.write_bytes(b"RIFF" + b"\x00" * 8 + b"WAVE" + b"ephemeral-audio-probe")
    assert not any(path.suffix in {".wav", ".pcm"} for path in storage_root.rglob("*"))
    assert _storage_contains(storage_root, b"ephemeral-audio-probe") is True
    probe.unlink()

    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    pcm_canary = (b"RIFF" + b"companion-space-audio-canary" + b"WAVE") * 18
    pcm_canary = pcm_canary[:640].ljust(640, b"Z")

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        opened = websocket.receive_json()
        assert opened["type"] == "session.open"
        websocket.send_bytes(pcm_canary)
        partial = websocket.receive_json()
        assert partial["type"] == "asr.partial"
        websocket.send_json({"type": "user.commit", "payload": {"text": "帮我复盘刚才的重点"}})
        final_asr = websocket.receive_json()
        assert final_asr["type"] == "asr.final"
        events = []
        while True:
            event = websocket.receive_json()
            events.append(event)
            if event["type"] == "llm.final":
                break
        tts_chunk = websocket.receive_json()
        deltas = [event for event in events if event["type"] == "llm.delta"]
        assert len(deltas) >= 2
        llm_final = events[-1]
        assert llm_final["type"] == "llm.final"
        assert llm_final["payload"]["role"] == "assistant"
        assert tts_chunk["type"] == "tts.chunk"

    transcript = client.get(f"/api/v1/sessions/{session['id']}", headers=_auth_headers(owner_token))
    assert transcript.status_code == 200
    turns = transcript.json()["turns"]
    assert len(turns) == 2
    assert not any(path.suffix in {".wav", ".pcm"} for path in storage_root.rglob("*"))
    _assert_storage_omits_bytes(
        storage_root,
        pcm_canary,
        b"companion-space-audio-canary",
        b"RIFF",
        b"WAVE",
    )
    assert "companion-space-audio-canary" not in caplog.text
    assert "RIFF" not in caplog.text
    assert "WAVE" not in caplog.text


def test_realtime_ticket_is_one_time_and_session_bound(client, owner_token) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    first_session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    second_session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, first_session["id"])
    origin = _realtime_origin(client)

    with client.websocket_connect(
        f"/api/v1/sessions/{first_session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": origin},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"

    with pytest.raises(WebSocketDisconnect) as reused:
        with client.websocket_connect(
            f"/api/v1/sessions/{first_session['id']}/realtime",
            subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
            headers={"origin": origin},
        ):
            pass
    assert reused.value.code == 4401

    rebound_ticket = _issue_realtime_ticket(client, owner_token, first_session["id"])
    with pytest.raises(WebSocketDisconnect) as wrong_session:
        with client.websocket_connect(
            f"/api/v1/sessions/{second_session['id']}/realtime",
            subprotocols=["companion-v1", f"ticket.{rebound_ticket['ticket']}"],
            headers={"origin": origin},
        ):
            pass
    assert wrong_session.value.code == 4401


def test_realtime_ticket_expires_and_is_invalidated_when_vault_locks(client, owner_token) -> None:
    container = get_container()
    container.settings.realtime_ticket_ttl_seconds = 1
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    origin = _realtime_origin(client)

    expiring_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    record = container.repository.get_realtime_ticket(expiring_ticket["ticket"])
    assert record is not None
    with container.repository.connection() as connection:
        connection.execute(
            "UPDATE realtime_tickets SET expires_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00+00:00", record.id),
        )
    with pytest.raises(WebSocketDisconnect) as expired:
        with client.websocket_connect(
            f"/api/v1/sessions/{session['id']}/realtime",
            subprotocols=["companion-v1", f"ticket.{expiring_ticket['ticket']}"],
            headers={"origin": origin},
        ):
            pass
    assert expired.value.code == 4401

    live_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{live_ticket['ticket']}"],
        headers={"origin": origin},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        locked = client.post("/api/v1/vault/lock", headers=_auth_headers(owner_token))
        assert locked.status_code == 200
        websocket.send_json({"type": "heartbeat"})
        closed = websocket.receive()
    assert closed["type"] == "websocket.close"
    assert closed["code"] == 4401


def test_realtime_rejects_query_token_and_untrusted_origin(client, owner_token) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with pytest.raises(WebSocketDisconnect) as query_token:
        with client.websocket_connect(
            f"/api/v1/sessions/{session['id']}/realtime?token={owner_token}",
            subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
            headers={"origin": _realtime_origin(client)},
        ):
            pass
    assert query_token.value.code == 4401

    blocked_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    with pytest.raises(WebSocketDisconnect) as blocked_origin:
        with client.websocket_connect(
            f"/api/v1/sessions/{session['id']}/realtime",
            subprotocols=["companion-v1", f"ticket.{blocked_ticket['ticket']}"],
            headers={"origin": "https://attacker.invalid"},
        ):
            pass
    assert blocked_origin.value.code == 4403


def test_realtime_commit_without_text_uses_stt_transcript_when_assigned(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    adapter = RealtimeMockAdapter()
    _patch_realtime_adapter(monkeypatch, adapter)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x00\x01" * 320)
        assert websocket.receive_json()["type"] == "asr.partial"
        websocket.send_json({"type": "user.commit", "payload": {}})

        final_asr = websocket.receive_json()
        assert final_asr["type"] == "asr.final"
        assert final_asr["payload"]["text"] == adapter.transcript
        assert final_asr["payload"]["audio_bytes"] == 640
        assert adapter.transcribe_calls == [
            {
                "model": "mock-stt-v1",
                "pcm16": b"\x00\x01" * 320,
                "sample_rate_hz": 16000,
            }
        ]


def test_realtime_rejects_non_20ms_pcm16_audio_frames(client, owner_token) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x00\x01" * 319)

        error_event = websocket.receive_json()
        assert error_event["type"] == "error"
        assert "640" in error_event["payload"]["message"]


def test_realtime_tts_assignment_streams_binary_audio(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    server_tts_connection = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={"provider": "mock", "label": "Server TTS", "api_key": "mock-key"},
    ).json()
    _assign_mock_capability(
        space["id"],
        ProviderCapability.tts,
        model_name="mock-voice-v1",
        provider_connection_id=server_tts_connection["id"],
    )
    adapter = RealtimeMockAdapter(
        tts_chunks=[b"\x7f\x00" * 240, b"\x55\x00" * 120]
    )
    _patch_realtime_adapter(monkeypatch, adapter)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "请讲一下今天的重点。"}})
        assert websocket.receive_json()["type"] == "asr.final"
        while True:
            event = websocket.receive_json()
            if event["type"] == "llm.final":
                assert event["state"] == "thinking"
                break
        tts_chunk = websocket.receive_json()
        assert tts_chunk == {
            "type": "tts.chunk",
            "session_id": session["id"],
            "state": "speaking",
            "payload": {
                "final": False,
                "sequence": 0,
                "byte_length": 480,
                "content_type": "audio/pcm;rate=24000",
                "sample_rate_hz": 24000,
                "preview_text": "这是一个实时语音回复。",
            },
        }
        assert websocket.receive_bytes() == b"\x7f\x00" * 240
        next_chunk = websocket.receive_json()
        assert next_chunk == {
            "type": "tts.chunk",
            "session_id": session["id"],
            "state": "speaking",
            "payload": {
                "final": False,
                "sequence": 1,
                "byte_length": 240,
                "content_type": "audio/pcm;rate=24000",
                "sample_rate_hz": 24000,
                "preview_text": "这是一个实时语音回复。",
            },
        }
        assert websocket.receive_bytes() == b"\x55\x00" * 120
        tts_final = websocket.receive_json()
        assert tts_final == {
            "type": "tts.chunk",
            "session_id": session["id"],
            "state": "idle",
            "payload": {"final": True, "sequence": 2, "audio_bytes": 720},
        }
        assert adapter.tts_calls == [
            {
                "model": "mock-voice-v1",
                "text": "这是一个实时语音回复。",
                "voice_id": "Serena",
                "speed": 1.0,
                "sample_rate_hz": 24000,
            }
        ]


def test_realtime_forwards_assistant_emotion_only_to_local_neural_tts(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class NeuralRealtimeAdapter(RealtimeMockAdapter):
        supports_companion_emotion = True

        async def synthesize_speech_stream(
            self,
            model: str,
            text: str,
            voice_id: str,
            *,
            speed: float = 1.0,
            sample_rate_hz: int = 24000,
            emotion: CompanionEmotion = "warm",
        ) -> AsyncIterator[bytes]:
            self.tts_calls.append(
                {
                    "model": model,
                    "text": text,
                    "voice_id": voice_id,
                    "speed": speed,
                    "sample_rate_hz": sample_rate_hz,
                    "emotion": emotion,
                }
            )
            for chunk in self.tts_chunks:
                yield chunk

    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Neural emotion", "topic": "support", "goal": "respond gently"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    server_tts_connection = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={"provider": "mock", "label": "Neural contract", "api_key": "mock-key"},
    ).json()
    _assign_mock_capability(
        space["id"],
        ProviderCapability.tts,
        model_name="qwen3-tts-0.6b-customvoice",
        provider_connection_id=server_tts_connection["id"],
    )
    adapter = NeuralRealtimeAdapter(
        llm_chunks=[
            '{"display_text":"Take care.","spoken_text":"Take care.",'
            '"emotion":"concerned","suggested_actions":[]}'
        ],
        tts_chunks=[b"\x01\x00"],
    )
    _patch_realtime_adapter(monkeypatch, adapter)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "I need help."}})
        while True:
            event = websocket.receive_json()
            if event["type"] == "tts.chunk" and event["payload"]["final"] is True:
                break
            if event["type"] == "tts.chunk" and event["payload"]["final"] is False:
                assert websocket.receive_bytes() == b"\x01\x00"

    assert adapter.tts_calls == [
        {
            "model": "qwen3-tts-0.6b-customvoice",
            "text": "Take care.",
            "voice_id": "Serena",
            "speed": 1.0,
            "sample_rate_hz": 24000,
            "emotion": "concerned",
        }
    ]


def test_session_tts_snapshot_survives_assignment_changes_and_skips_mock_pcm(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Pinned browser voice"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    container = get_container()
    created = container.repository.get_session(session["id"])
    assert created is not None
    assert (
        created.tts_connection_id,
        created.tts_model_name,
        created.tts_playback_policy,
    ) == ("builtin-mock", "mock-voice-v1", "browser-compat")

    replacement = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={"provider": "mock", "label": "Replacement TTS", "api_key": "mock-key"},
    ).json()
    _assign_mock_capability(
        space["id"],
        ProviderCapability.tts,
        model_name="replacement-voice",
        provider_connection_id=replacement["id"],
    )
    attempted_rebind = created.model_copy(
        update={
            "tts_connection_id": replacement["id"],
            "tts_model_name": "replacement-voice",
            "tts_playback_policy": "server",
        }
    )
    preserved = container.repository.upsert_session(attempted_rebind)
    assert (
        preserved.tts_connection_id,
        preserved.tts_model_name,
        preserved.tts_playback_policy,
    ) == ("builtin-mock", "mock-voice-v1", "browser-compat")
    assert container.providers.delete_assignment(
        space_id=space["id"],
        capability=ProviderCapability.tts,
    ) is True

    adapter = RealtimeMockAdapter()
    _patch_realtime_adapter(monkeypatch, adapter)
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        opened = websocket.receive_json()
        assert opened["payload"] == {
            "tts_playback_policy": "browser-compat",
            "tts_connection_id": "builtin-mock",
            "tts_model": "mock-voice-v1",
        }
        websocket.send_json(
            {"type": "user.commit", "payload": {"text": "summarize this"}}
        )
        assert websocket.receive_json()["type"] == "asr.final"
        while True:
            event = websocket.receive_json()
            if event["type"] == "tts.chunk":
                break
        assert event == {
            "type": "tts.chunk",
            "session_id": session["id"],
            "state": "idle",
            "payload": {"final": True, "sequence": 0, "audio_bytes": 0},
        }
    assert adapter.tts_calls == []


def test_existing_v1_database_adds_nullable_session_tts_snapshot_columns(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(object_storage_path=str(tmp_path / "storage"))
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.metadata_db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                character_pack_id TEXT,
                state TEXT NOT NULL,
                summary TEXT NOT NULL,
                generated_summary TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                artifacts_status TEXT NOT NULL DEFAULT 'idle',
                artifacts_error TEXT,
                artifacts_updated_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                ended_at TEXT
            );
            INSERT INTO sessions VALUES (
                'legacy-session', 'legacy-space', NULL, 'idle', '', '', '',
                'idle', NULL, NULL,
                '2026-01-01T00:00:00+00:00',
                '2026-01-01T00:00:00+00:00', NULL
            );
            PRAGMA user_version = 1;
            """
        )
    monkeypatch.setattr(
        SQLiteRepository,
        "migrate_material_storage_paths",
        lambda self: None,
    )

    repository = SQLiteRepository(settings)

    with repository.connection() as connection:
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(sessions)").fetchall()
        }
    assert {
        "tts_connection_id",
        "tts_model_name",
        "tts_playback_policy",
    } <= columns
    legacy = repository.get_session("legacy-session")
    assert legacy is not None
    assert legacy.tts_connection_id is None
    assert legacy.tts_model_name is None
    assert legacy.tts_playback_policy is None


def test_real_chat_assignment_preserves_pending_neural_bootstrap_tts(
    tmp_path: Path,
) -> None:
    settings = Settings(
        object_storage_path=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=True,
    )
    repository = SQLiteRepository(settings)
    registry = ProviderRegistryService(
        repository,
        VaultService(settings, repository),
    )
    spaces = StudySpaceService(settings, repository)
    spaces.set_provider_registry(registry)
    space = spaces.create_space(name="Pending neural voice")
    now = datetime.now(timezone.utc)
    real_chat = repository.upsert_provider_connection(
        ProviderConnection(
            id="real-chat",
            provider="openai-compatible",
            label="Real chat",
            capabilities=[ProviderCapability.chat_llm],
            created_at=now,
            updated_at=now,
        )
    )

    registry.save_assignment(
        space_id=space.id,
        capability=ProviderCapability.chat_llm,
        provider_connection_id=real_chat.id,
        model_name="real-chat-model",
    )

    tts_assignment = next(
        item
        for item in repository.list_model_assignments(space.id)
        if item.capability is ProviderCapability.tts
    )
    assert (
        tts_assignment.provider_connection_id,
        tts_assignment.model_name,
        tts_assignment.is_bootstrap_default,
    ) == (BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_TTS_MODEL, True)


@pytest.mark.parametrize(
    ("raw_message", "expected_fragment"),
    [
        ("{", "json"),
        ("[]", "object"),
        ('{"type":"heartbeat","session_id":"wrong","payload":{}}', "session_id"),
    ],
)
def test_realtime_rejects_invalid_json_payloads(
    client,
    owner_token,
    raw_message: str,
    expected_fragment: str,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_text(raw_message)
        error_event = websocket.receive_json()
        assert error_event["type"] == "error"
        assert expected_fragment in error_event["payload"]["message"].lower()


def test_realtime_rejects_duplicate_commit_while_turn_is_active(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    class BlockingRealtimeAdapter(RealtimeMockAdapter):
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
            yield ProviderStreamChunk(text='{"display_text":"阻塞中')
            await asyncio.sleep(1)
            yield ProviderStreamChunk(
                text='。","spoken_text":"阻塞中。","emotion":"warm","suggested_actions":[]}'
            )

    _patch_realtime_adapter(monkeypatch, BlockingRealtimeAdapter())

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "先开始"}})
        assert websocket.receive_json()["type"] == "asr.final"
        websocket.send_json({"type": "user.commit", "payload": {"text": "重复提交"}})
        while True:
            error_event = websocket.receive_json()
            if error_event["type"] == "error":
                break
        assert error_event["type"] == "error"
        assert "active turn" in error_event["payload"]["message"].lower()


def test_realtime_clears_audio_buffer_after_limit_error(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime", "topic": "english", "goal": "practice speaking"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    realtime_ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    monkeypatch.setattr("app.services.realtime.MAX_REALTIME_BUFFER_BYTES", 1280)

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{realtime_ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x00\x01" * 320)
        assert websocket.receive_json()["payload"]["buffered_audio_bytes"] == 640
        websocket.send_bytes(b"\x00\x01" * 320)
        assert websocket.receive_json()["payload"]["buffered_audio_bytes"] == 1280
        websocket.send_bytes(b"\x00\x01" * 320)
        error_event = websocket.receive_json()
        assert error_event["type"] == "error"
        assert "buffer" in error_event["payload"]["message"].lower()
        websocket.send_bytes(b"\x00\x01" * 320)
        assert websocket.receive_json()["payload"]["buffered_audio_bytes"] == 640
