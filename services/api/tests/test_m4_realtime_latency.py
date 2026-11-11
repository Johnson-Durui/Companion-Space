from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from threading import Event
from time import monotonic, sleep
from typing import Any

import httpx
import pytest

from app.api.deps import get_container
from app.models.domain import ProviderCapability, ProviderConnection
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.providers.local_neural_tts import (
    LOCAL_NEURAL_TTS_MODEL,
    LocalNeuralTTSProvider,
)


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _realtime_origin(client) -> str:
    return str(client.base_url).rstrip("/")


def _assign_mock_audio_capabilities(space_id: str) -> None:
    container = get_container()
    for capability, model_name in (
        (ProviderCapability.stt, "mock-stt-v1"),
        (ProviderCapability.tts, "mock-voice-v1"),
    ):
        container.providers.save_assignment(
            space_id=space_id,
            capability=capability,
            provider_connection_id="builtin-mock",
            model_name=model_name,
        )


def _issue_realtime_ticket(client, owner_token: str, session_id: str) -> dict[str, str]:
    response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 200
    return response.json()


class TimedRealtimeAdapter(LLMProvider):
    name = "timed-realtime"

    def __init__(self, *, llm_block_seconds: float = 1.0) -> None:
        self.llm_block_seconds = llm_block_seconds
        self.cancelled = asyncio.Event()

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
        try:
            yield ProviderStreamChunk(text='{"display_text":"正在生成')
            await asyncio.sleep(self.llm_block_seconds)
            yield ProviderStreamChunk(
                text='。","spoken_text":"正在生成。","emotion":"warm","suggested_actions":[]}'
            )
        except asyncio.CancelledError:
            self.cancelled.set()
            raise

    async def transcribe_pcm16(
        self,
        model: str,
        pcm16: bytes,
        *,
        sample_rate_hz: int = 16000,
    ) -> str:
        _ = model
        _ = pcm16
        _ = sample_rate_hz
        return "请帮我总结"

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        *,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        _ = model
        _ = text
        _ = voice_id
        _ = speed
        _ = sample_rate_hz
        await asyncio.sleep(0.05)
        yield b"\x34\x12" * 240


class _SignaledBlockingStream(httpx.AsyncByteStream):
    def __init__(self, entered: Event) -> None:
        self._entered = entered

    async def __aiter__(self):
        self._entered.set()
        await asyncio.Future()
        yield b""

    async def aclose(self) -> None:
        return None


class _SlowCancelTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.synthesis_started = Event()
        self.delete_started = Event()
        self.delete_release = Event()
        self.delete_finished = Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                200,
                request=request,
                headers={
                    "content-type": "application/octet-stream",
                    "x-audio-format": "pcm_s16le",
                    "x-audio-channels": "1",
                    "x-audio-sample-rate": "24000",
                },
                stream=_SignaledBlockingStream(self.synthesis_started),
            )
        self.delete_started.set()
        while not self.delete_release.is_set():
            await asyncio.sleep(0.01)
        self.delete_finished.set()
        return httpx.Response(204, request=request)


class SlowCleanupRealtimeAdapter(TimedRealtimeAdapter):
    def __init__(self, transport: httpx.AsyncBaseTransport) -> None:
        super().__init__(llm_block_seconds=0)
        self._tts = LocalNeuralTTSProvider(transport=transport)

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[Any],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = model, system_prompt, history, user_message
        yield ProviderStreamChunk(
            text=(
                '{"display_text":"ok","spoken_text":"hello",'
                '"emotion":"warm","suggested_actions":[]}'
            )
        )

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        *,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        async for chunk in self._tts.synthesize_speech_stream(
            model=LOCAL_NEURAL_TTS_MODEL,
            text=text,
            voice_id=voice_id,
            speed=speed,
            sample_rate_hz=sample_rate_hz,
        ):
            yield chunk


def _patch_realtime_adapter(
    monkeypatch: pytest.MonkeyPatch,
    adapter: LLMProvider,
) -> None:
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: adapter,
    )


def test_mock_realtime_commit_emits_first_binary_under_800ms(
    client,
    owner_token,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime latency"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        started = monotonic()
        websocket.send_json({"type": "user.commit", "payload": {"text": "总结一下"}})
        assert websocket.receive_json()["type"] == "asr.final"
        while True:
            event = websocket.receive_json()
            if event["type"] == "tts.chunk":
                break
        elapsed_ms = (monotonic() - started) * 1000

    assert event["payload"] == {"final": True, "sequence": 0, "audio_bytes": 0}
    assert elapsed_ms < 800


def test_mock_realtime_voice_commit_emits_first_binary_under_800ms(
    client,
    owner_token,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime voice latency"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x00\x00" * 320)
        assert websocket.receive_json()["type"] == "asr.partial"

        started = monotonic()
        websocket.send_json({"type": "user.commit", "payload": {}})
        assert websocket.receive_json()["type"] == "asr.final"
        while True:
            event = websocket.receive_json()
            if event["type"] == "tts.chunk":
                break
        elapsed_ms = (monotonic() - started) * 1000

    assert event["payload"] == {"final": True, "sequence": 0, "audio_bytes": 0}
    assert elapsed_ms < 800


def test_realtime_interrupt_ack_under_250ms_and_cancels_turn(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Realtime interrupt"},
    ).json()
    _assign_mock_audio_capabilities(space["id"])
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])
    adapter = TimedRealtimeAdapter(llm_block_seconds=5.0)
    _patch_realtime_adapter(monkeypatch, adapter)

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "开始生成"}})
        assert websocket.receive_json()["type"] == "asr.final"
        assert websocket.receive_json()["type"] == "llm.delta"
        websocket.send_bytes(b"\x00\x01" * 320)
        barge_in = websocket.receive_json()
        assert barge_in["type"] == "asr.partial"
        assert barge_in["state"] == "thinking"
        websocket.send_json({"type": "heartbeat", "payload": {}})
        assert websocket.receive_json()["state"] == "thinking"
        started = monotonic()
        websocket.send_json({"type": "turn.interrupt", "payload": {}})
        interrupted = websocket.receive_json()
        elapsed_ms = (monotonic() - started) * 1000
        assert interrupted["type"] == "turn.interrupted"
        assert interrupted["state"] == "interrupted"
        websocket.send_bytes(b"\x00\x01" * 320)
        resumed_partial = websocket.receive_json()
        assert resumed_partial["type"] == "asr.partial"
        assert resumed_partial["state"] == "listening"
        sleep(0.1)
        websocket.send_json({"type": "heartbeat", "payload": {}})
        heartbeat = websocket.receive_json()

    assert elapsed_ms < 250
    assert heartbeat["type"] == "heartbeat"
    assert heartbeat["state"] == "listening"
    assert adapter.cancelled.is_set()
    turns = get_container().repository.list_turns(session["id"])
    assert [turn.role.value for turn in turns] == ["user"]


def test_realtime_interrupt_ack_does_not_wait_for_neural_delete(
    client,
    owner_token,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Slow neural cleanup"},
    ).json()
    container = get_container()
    now = datetime.now(timezone.utc)
    connection = ProviderConnection(
        id="slow-cleanup",
        provider="mock",
        label="Slow cleanup",
        capabilities=list(ProviderCapability),
        created_at=now,
        updated_at=now,
    )
    container.repository.upsert_provider_connection(connection)
    for capability in (
        ProviderCapability.chat_llm,
        ProviderCapability.stt,
        ProviderCapability.tts,
    ):
        container.providers.save_assignment(
            space_id=space["id"],
            capability=capability,
            provider_connection_id=connection.id,
            model_name="slow-test",
        )

    transport = _SlowCancelTransport()
    adapter = SlowCleanupRealtimeAdapter(transport)
    _patch_realtime_adapter(monkeypatch, adapter)
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "hello"}})
        assert websocket.receive_json()["type"] == "asr.final"
        while websocket.receive_json()["type"] != "llm.final":
            pass
        assert transport.synthesis_started.wait(2)

        started = monotonic()
        websocket.send_json({"type": "turn.interrupt", "payload": {}})
        interrupted = websocket.receive_json()
        elapsed_ms = (monotonic() - started) * 1000

        assert interrupted["type"] == "turn.interrupted"
        assert elapsed_ms < 250
        assert transport.delete_started.wait(2)
        assert not transport.delete_finished.is_set()
        transport.delete_release.set()
        assert transport.delete_finished.wait(2)

    assert transport.delete_finished.is_set()
