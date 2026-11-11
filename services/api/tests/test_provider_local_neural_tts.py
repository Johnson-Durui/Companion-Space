from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest

from app.api.deps import get_container
from app.main import app
from app.core.config import Settings
from app.models.domain import (
    CompanionEmotion,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    StudySpace,
)
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderTimeoutError,
)
from app.providers.base import ProviderAdapter
from app.providers.errors import ProviderUnavailableError
from app.providers.factory import build_provider_adapter
from app.providers.local_neural_tts import (
    LOCAL_NEURAL_TTS_DEFAULT_BASE_URL,
    LOCAL_NEURAL_TTS_MODEL,
    LocalNeuralTTSProvider,
)
from app.providers.pinned_http import resolve_provider_base_url
from app.services import provider_registry as provider_registry_module
from app.services.provider_registry import (
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_MOCK_TTS_MODEL,
    BUILTIN_NEURAL_TTS_CONNECTION_ID,
    ProviderRegistryService,
    PROVIDER_SPEECH_PREVIEW_MAX_BYTES,
    _is_retryable_sqlite_error,
    ensure_builtin_mock_connection,
)
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService
from app.services.vault import VaultService


class _AsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


class _BlockingAsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, entered: asyncio.Event) -> None:
        self._entered = entered

    async def __aiter__(self):
        self._entered.set()
        await asyncio.Future()
        yield b""

    async def aclose(self) -> None:
        return None


def test_neural_activation_retries_only_transient_sqlite_lock_errors() -> None:
    assert _is_retryable_sqlite_error(sqlite3.OperationalError("database is locked"))
    assert _is_retryable_sqlite_error(sqlite3.OperationalError("database is busy"))
    assert not _is_retryable_sqlite_error(sqlite3.OperationalError("no such table"))
    assert not _is_retryable_sqlite_error(sqlite3.IntegrityError("constraint failed"))


async def _collect(provider: LocalNeuralTTSProvider, text: str) -> list[bytes]:
    return [
        chunk
        async for chunk in provider.synthesize_speech_stream(
            model=LOCAL_NEURAL_TTS_MODEL,
            text=text,
            voice_id="unknown-sidecar-voice",
        )
    ]


def test_local_neural_tts_streams_pcm_and_splits_long_text_at_punctuation() -> None:
    requests: list[dict[str, object]] = []
    text = f"{'a' * 150}.{'b' * 150}."

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/octet-stream",
                "x-audio-format": "pcm_s16le",
                "x-audio-channels": "1",
                "x-audio-sample-rate": "24000",
            },
            stream=_AsyncByteStream([b"\x01", b"\x00\x02", b"\x00"]),
        )

    provider = LocalNeuralTTSProvider(
        transport=httpx.MockTransport(handler),
    )

    chunks = asyncio.run(_collect(provider, text))

    assert chunks == [b"\x01\x00", b"\x02\x00"] * 2
    assert [request["input"] for request in requests] == [
        f"{'a' * 150}.",
        f"{'b' * 150}.",
    ]
    assert all(
        request
        == {
            "model": LOCAL_NEURAL_TTS_MODEL,
            "input": request["input"],
            "voice": "unknown-sidecar-voice",
            "speed": 1.0,
            "emotion": "warm",
            "response_format": "pcm",
        }
        for request in requests
    )


def test_local_neural_tts_forwards_distinct_emotions_without_changing_voice_or_model() -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/octet-stream",
                "x-audio-format": "pcm_s16le",
                "x-audio-channels": "1",
                "x-audio-sample-rate": "24000",
            },
            content=b"\x00\x00",
        )

    provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))

    async def synthesize(emotion: CompanionEmotion) -> None:
        async for _ in provider.synthesize_speech_stream(
            model=LOCAL_NEURAL_TTS_MODEL,
            text="你好",
            voice_id="Vivian",
            emotion=emotion,
        ):
            pass

    asyncio.run(synthesize("playful"))
    asyncio.run(synthesize("concerned"))

    assert [request["emotion"] for request in requests] == ["playful", "concerned"]
    assert {request["model"] for request in requests} == {LOCAL_NEURAL_TTS_MODEL}
    assert {request["voice"] for request in requests} == {"Vivian"}
    assert {request["speed"] for request in requests} == {1.0}


def test_local_neural_tts_rejects_unknown_emotion_before_calling_sidecar() -> None:
    sidecar_called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal sidecar_called
        sidecar_called = True
        return httpx.Response(500, request=request)

    provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))

    async def synthesize() -> None:
        async for _ in provider.synthesize_speech_stream(
            model=LOCAL_NEURAL_TTS_MODEL,
            text="hello",
            voice_id="Vivian",
            emotion="angry",  # type: ignore[arg-type]
        ):
            pass

    with pytest.raises(
        ProviderConfigurationError,
        match="Unsupported companion speech emotion",
    ):
        asyncio.run(synthesize())

    assert sidecar_called is False


def test_local_neural_tts_maps_timeout_and_invalid_pcm() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderTimeoutError):
        asyncio.run(
            _collect(
                LocalNeuralTTSProvider(transport=httpx.MockTransport(timeout)),
                "hello",
            )
        )

    def invalid_pcm(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/octet-stream",
                "x-audio-format": "pcm_s16le",
                "x-audio-channels": "1",
                "x-audio-sample-rate": "24000",
            },
            stream=_AsyncByteStream([b"\x01"]),
        )

    with pytest.raises(ProviderProtocolError, match="audio response"):
        asyncio.run(
            _collect(
                LocalNeuralTTSProvider(transport=httpx.MockTransport(invalid_pcm)),
                "hello",
            )
        )


def test_local_neural_tts_rejects_incorrect_audio_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/json",
                "x-audio-format": "pcm_s16le",
                "x-audio-channels": "2",
                "x-audio-sample-rate": "16000",
            },
            content=b'{}',
        )

    with pytest.raises(ProviderProtocolError, match="audio response"):
        asyncio.run(
            _collect(
                LocalNeuralTTSProvider(transport=httpx.MockTransport(handler)),
                "hello",
            )
        )


def test_local_neural_tts_cancellation_deletes_the_active_inference() -> None:
    async def scenario() -> None:
        entered = asyncio.Event()
        post_inference_id: str | None = None
        deleted_inference_id: str | None = None

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal post_inference_id, deleted_inference_id
            if request.method == "POST":
                post_inference_id = request.headers["x-inference-id"]
                return httpx.Response(
                    200,
                    request=request,
                    headers={
                        "content-type": "application/octet-stream",
                        "x-audio-format": "pcm_s16le",
                        "x-audio-channels": "1",
                        "x-audio-sample-rate": "24000",
                    },
                    stream=_BlockingAsyncByteStream(entered),
                )
            deleted_inference_id = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(204, request=request)

        provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))
        task = asyncio.create_task(_collect(provider, "hello"))
        await entered.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        assert post_inference_id is not None
        assert deleted_inference_id == post_inference_id

    asyncio.run(scenario())


def test_local_neural_tts_cancel_accepts_an_already_finished_inference() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/v1/audio/speech/already-finished"
        return httpx.Response(404, request=request)

    provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))

    asyncio.run(provider._cancel_inference("already-finished"))


def test_local_neural_tts_logs_cancel_failure(caplog) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()

        def handler(request: httpx.Request) -> httpx.Response:
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
                    stream=_BlockingAsyncByteStream(entered),
                )
            return httpx.Response(500, request=request)

        provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))
        task = asyncio.create_task(_collect(provider, "hello"))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    with caplog.at_level("ERROR", logger="app.providers.local_neural_tts"):
        asyncio.run(scenario())

    assert "Failed to cancel local neural TTS inference" in caplog.text


def test_local_neural_tts_health_discovery_returns_public_model_slug() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/healthz"
        return httpx.Response(
            200,
            request=request,
            json={"status": "ready", "model": LOCAL_NEURAL_TTS_MODEL},
        )

    provider = LocalNeuralTTSProvider(transport=httpx.MockTransport(handler))

    assert asyncio.run(provider.discover_models()) == [
        "qwen3-tts-0.6b-customvoice"
    ]


def test_enabled_builtin_neural_connection_preserves_existing_assignments_after_readiness(
    tmp_path,
    monkeypatch,
) -> None:
    settings = Settings(
        object_storage_path=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=True,
        local_neural_tts_base_url="http://neural-sidecar:8001",
    )
    repository = SQLiteRepository(settings)
    ensure_builtin_mock_connection(repository)
    now = datetime.now(timezone.utc)
    for space_id in ("bootstrap", "explicit-mock", "custom"):
        repository.upsert_space(
            StudySpace(
                id=space_id,
                name=space_id,
                created_at=now,
                updated_at=now,
            )
        )
    custom = ProviderConnection(
        id="custom-tts",
        provider="openai-compatible",
        label="Custom",
        capabilities=[ProviderCapability.tts],
        created_at=now,
        updated_at=now,
    )
    repository.upsert_provider_connection(custom)
    for space_id, connection_id, model, bootstrap in (
        ("bootstrap", BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_TTS_MODEL, True),
        ("explicit-mock", BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_TTS_MODEL, False),
        ("custom", custom.id, "custom-model", True),
    ):
        repository.upsert_model_assignment(
            ModelAssignment(
                id=str(uuid4()),
                space_id=space_id,
                capability=ProviderCapability.tts,
                provider_connection_id=connection_id,
                model_name=model,
                is_bootstrap_default=bootstrap,
                created_at=now,
                updated_at=now,
            )
        )

    registry = ProviderRegistryService(repository, VaultService(settings, repository))

    builtin = repository.get_provider_connection(BUILTIN_NEURAL_TTS_CONNECTION_ID)
    assert builtin is not None
    assert builtin.base_url == "http://neural-sidecar:8001"
    before_ready = repository.list_model_assignments("bootstrap")[0]
    assert (before_ready.provider_connection_id, before_ready.model_name) == (
        BUILTIN_MOCK_CONNECTION_ID,
        BUILTIN_MOCK_TTS_MODEL,
    )

    async def ready_models(self, capability=None):
        assert capability in {None, ProviderCapability.tts}
        return [LOCAL_NEURAL_TTS_MODEL]

    monkeypatch.setattr(LocalNeuralTTSProvider, "discover_models", ready_models)
    assert asyncio.run(registry.activate_builtin_neural_tts_if_ready()) is True

    preserved = repository.list_model_assignments("bootstrap")[0]
    assert (preserved.provider_connection_id, preserved.model_name) == (
        BUILTIN_MOCK_CONNECTION_ID,
        BUILTIN_MOCK_TTS_MODEL,
    )
    assert (
        repository.list_model_assignments("explicit-mock")[0].provider_connection_id
        == BUILTIN_MOCK_CONNECTION_ID
    )
    assert repository.list_model_assignments("custom")[0].provider_connection_id == custom.id
    with pytest.raises(ValueError, match="cannot be edited"):
        registry.update_connection(BUILTIN_NEURAL_TTS_CONNECTION_ID, label="Changed")
    with pytest.raises(ValueError, match="cannot be deleted"):
        registry.delete_connection(BUILTIN_NEURAL_TTS_CONNECTION_ID)
    custom = registry.save_connection(provider="local-neural", label="Custom")
    assert custom["id"] != BUILTIN_NEURAL_TTS_CONNECTION_ID
    assert custom["base_url"] == LOCAL_NEURAL_TTS_DEFAULT_BASE_URL


def test_enabled_new_space_assigns_only_tts_to_ready_builtin_neural(
    tmp_path,
    monkeypatch,
) -> None:
    settings = Settings(
        object_storage_path=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=True,
    )
    repository = SQLiteRepository(settings)
    registry = ProviderRegistryService(repository, VaultService(settings, repository))
    spaces = StudySpaceService(settings, repository)
    spaces.set_provider_registry(registry)

    not_ready_space = spaces.create_space(name="Before ready")
    not_ready_tts = next(
        item
        for item in repository.list_model_assignments(not_ready_space.id)
        if item.capability is ProviderCapability.tts
    )
    assert not_ready_tts.provider_connection_id == BUILTIN_MOCK_CONNECTION_ID

    now = datetime.now(timezone.utc)
    real_chat = ProviderConnection(
        id="real-chat",
        provider="anthropic",
        label="Real chat",
        capabilities=[ProviderCapability.chat_llm],
        created_at=now,
        updated_at=now,
    )
    repository.upsert_provider_connection(real_chat)
    registry.save_assignment(
        space_id=not_ready_space.id,
        capability=ProviderCapability.chat_llm,
        provider_connection_id=real_chat.id,
        model_name="claude-test",
    )
    tts_after_chat_binding = next(
        item
        for item in repository.list_model_assignments(not_ready_space.id)
        if item.capability is ProviderCapability.tts
    )
    assert tts_after_chat_binding.provider_connection_id == BUILTIN_MOCK_CONNECTION_ID
    assert tts_after_chat_binding.is_bootstrap_default is True

    async def ready_models(self, capability=None):
        return [LOCAL_NEURAL_TTS_MODEL]

    monkeypatch.setattr(LocalNeuralTTSProvider, "discover_models", ready_models)
    assert asyncio.run(registry.activate_builtin_neural_tts_if_ready()) is True
    existing_tts = next(
        item
        for item in repository.list_model_assignments(not_ready_space.id)
        if item.capability is ProviderCapability.tts
    )
    assert existing_tts.provider_connection_id == BUILTIN_MOCK_CONNECTION_ID
    assert existing_tts.model_name == BUILTIN_MOCK_TTS_MODEL
    space = spaces.create_space(name="Neural")
    assignments = {
        item.capability: item for item in repository.list_model_assignments(space.id)
    }

    assert (
        assignments[ProviderCapability.tts].provider_connection_id
        == BUILTIN_NEURAL_TTS_CONNECTION_ID
    )
    assert assignments[ProviderCapability.tts].model_name == LOCAL_NEURAL_TTS_MODEL
    assert all(
        assignment.provider_connection_id == BUILTIN_MOCK_CONNECTION_ID
        for capability, assignment in assignments.items()
        if capability is not ProviderCapability.tts
    )
    connection = repository.get_provider_connection(BUILTIN_NEURAL_TTS_CONNECTION_ID)
    assert connection is not None
    adapter = build_provider_adapter(connection, api_key=None)
    assert isinstance(adapter, LocalNeuralTTSProvider)


def test_sidecar_status_is_public_and_honest_when_disabled(client) -> None:
    response = client.get("/api/v1/tts/sidecar")
    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["ready"] is False
    assert payload["new_spaces_use_neural"] is False
    assert payload["connection_id"] == BUILTIN_NEURAL_TTS_CONNECTION_ID
    assert payload["model"] is None
    assert "默认模型分配" in payload["how_to_switch"]


def test_sidecar_status_probe_does_not_activate_new_space_defaults(
    client,
    isolated_settings,
    monkeypatch,
) -> None:
    isolated_settings.builtin_neural_tts_enabled = True

    async def ready_probe(self) -> bool:
        return True

    monkeypatch.setattr(
        ProviderRegistryService,
        "probe_builtin_neural_tts_ready",
        ready_probe,
    )

    response = client.get("/api/v1/tts/sidecar")

    assert response.status_code == 200
    assert response.json()["ready"] is True
    assert response.json()["new_spaces_use_neural"] is False
    assert get_container().providers.is_builtin_neural_tts_ready is False


def test_sidecar_status_catches_provider_failures_but_surfaces_programming_errors(
    client,
    isolated_settings,
    monkeypatch,
) -> None:
    isolated_settings.builtin_neural_tts_enabled = True

    async def offline_probe(self) -> bool:
        raise ProviderTimeoutError(
            provider="local-neural",
            public_detail="Sidecar timed out",
        )

    monkeypatch.setattr(
        ProviderRegistryService,
        "probe_builtin_neural_tts_ready",
        offline_probe,
    )
    response = client.get("/api/v1/tts/sidecar")
    assert response.status_code == 200
    assert response.json()["ready"] is False

    async def broken_probe(self) -> bool:
        raise sqlite3.OperationalError("no such table: provider_connections")

    monkeypatch.setattr(
        ProviderRegistryService,
        "probe_builtin_neural_tts_ready",
        broken_probe,
    )
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        client.get("/api/v1/tts/sidecar")


def test_custom_local_neural_connections_default_update_and_store_no_secret(
    tmp_path,
    monkeypatch,
) -> None:
    settings = Settings(
        object_storage_path=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=False,
    )
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    registry = ProviderRegistryService(repository, vault)
    stored_secrets: list[tuple[str, str]] = []
    monkeypatch.setattr(
        vault,
        "put_provider_secret",
        lambda connection_id, secret: stored_secrets.append((connection_id, secret)),
    )

    descriptor = next(
        item for item in registry.list_registry() if item["provider"] == "local-neural"
    )
    assert descriptor["supports_custom_base_url"] is True
    assert descriptor["requires_api_key"] is False

    created = registry.save_connection(provider="local-neural", label="My Qwen voice")
    assert created["base_url"] == LOCAL_NEURAL_TTS_DEFAULT_BASE_URL
    assert created["capabilities"] == ["tts"]
    assert stored_secrets == []

    updated = registry.update_connection(
        created["id"],
        label="Private Qwen voice",
        base_url="http://192.168.50.20:9001",
    )
    assert updated["label"] == "Private Qwen voice"
    assert updated["base_url"] == "http://192.168.50.20:9001"
    assert stored_secrets == []

    with pytest.raises(ValueError, match="does not accept an API Key"):
        registry.update_connection(created["id"], api_key="must-not-be-stored")
    for unsafe_url in (
        "http://user:secret@127.0.0.1:8001",
        "http://127.0.0.1:8001?token=secret",
        "http://127.0.0.1:8001/#fragment",
        "http://metadata.google.internal/computeMetadata/v1",
    ):
        with pytest.raises(ValueError):
            registry.save_connection(
                provider="local-neural",
                label="Unsafe",
                base_url=unsafe_url,
            )


def test_local_neural_requests_and_cancel_use_the_same_pinned_transport_policy(
    monkeypatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(204, request=request)
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/octet-stream",
                "x-audio-format": "pcm_s16le",
                "x-audio-channels": "1",
                "x-audio-sample-rate": "24000",
            },
            content=b"\x01\x00",
        )

    def build_transport(base_url: str, *, provider: str) -> httpx.AsyncBaseTransport:
        calls.append((base_url, provider))
        return httpx.MockTransport(handler)

    monkeypatch.setattr(
        "app.providers.local_neural_tts.build_pinned_http_transport",
        build_transport,
    )
    provider = LocalNeuralTTSProvider(base_url="http://voice.lan:8001")

    assert asyncio.run(_collect(provider, "hello")) == [b"\x01\x00"]
    asyncio.run(provider._cancel_inference("finished"))
    assert calls == [
        ("http://voice.lan:8001", "local-neural"),
        ("http://voice.lan:8001", "local-neural"),
    ]


def test_local_neural_base_urls_allow_private_hosts_without_weakening_remote_policy() -> None:
    private = resolve_provider_base_url(
        "http://192.168.10.15:8001",
        provider="local-neural",
    )
    assert private.addresses == ("192.168.10.15",)
    assert resolve_provider_base_url(
        "http://127.0.0.1:8001",
        provider="local-neural",
    ).addresses == ("127.0.0.1",)
    assert resolve_provider_base_url(
        "http://[::1]:8001",
        provider="local-neural",
    ).addresses == ("::1",)
    assert resolve_provider_base_url(
        "http://[fd12:3456:789a::1]:8001",
        provider="local-neural",
    ).addresses == ("fd12:3456:789a::1",)

    with pytest.raises(ValueError, match="blocked network address"):
        resolve_provider_base_url(
            "http://192.168.10.15:8001",
            provider="openai-compatible",
        )
    with pytest.raises(ValueError, match="metadata service"):
        resolve_provider_base_url(
            "http://metadata.google.internal/computeMetadata/v1",
            provider="local-neural",
            resolver=lambda _host: ["169.254.169.254"],
        )
    for special_address in ("100.64.0.1", "100.100.100.200"):
        with pytest.raises(ValueError, match="blocked network address"):
            resolve_provider_base_url(
                f"http://{special_address}:8001",
                provider="local-neural",
            )


class _SpeechPreviewAdapter(ProviderAdapter):
    name = "local-neural"

    def __init__(self, chunks: list[bytes] | None = None, error: Exception | None = None) -> None:
        self.chunks = chunks if chunks is not None else [b"\x01\x00", b"\x02\x00"]
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ):
        self.calls.append(
            {
                "model": model,
                "text": text,
                "voice_id": voice_id,
                "speed": speed,
                "sample_rate_hz": sample_rate_hz,
            }
        )
        if self.error is not None:
            raise self.error
        for chunk in self.chunks:
            yield chunk


def _create_custom_local_neural(client, owner_token: str) -> dict[str, object]:
    response = client.post(
        "/api/v1/providers/connections",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={
            "provider": "local-neural",
            "label": "Preview voice",
            "base_url": "http://127.0.0.1:8001",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_provider_speech_preview_is_owner_only_and_forwards_real_synthesis_parameters(
    client,
    owner_token,
    monkeypatch,
) -> None:
    connection = _create_custom_local_neural(client, owner_token)
    adapter = _SpeechPreviewAdapter()
    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        lambda _connection, api_key: adapter if api_key is None else None,
    )
    path = f"/api/v1/providers/connections/{connection['id']}/speech-preview"
    payload = {
        "model": LOCAL_NEURAL_TTS_MODEL,
        "text": "真实试听",
        "voice_id": "vivian",
        "speaking_rate": 1.25,
    }

    assert client.post(path, json=payload).status_code == 401
    response = client.post(
        path,
        headers={
            "Authorization": f"Bearer {owner_token}",
            "Origin": "http://127.0.0.1:3000",
        },
        json=payload,
    )

    assert response.status_code == 200, response.text
    assert response.content == b"\x01\x00\x02\x00"
    assert response.headers["content-type"] == "audio/pcm;rate=24000"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-audio-channels"] == "1"
    assert response.headers["x-audio-sample-rate"] == "24000"
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    exposed_headers = {
        item.strip().lower()
        for item in response.headers["access-control-expose-headers"].split(",")
    }
    assert exposed_headers == {"x-audio-sample-rate", "x-audio-channels"}
    assert adapter.calls == [
        {
            "model": LOCAL_NEURAL_TTS_MODEL,
            "text": "真实试听",
            "voice_id": "vivian",
            "speed": 1.25,
            "sample_rate_hz": 24000,
        }
    ]
    assert "api_key" not in response.text.lower()


@pytest.mark.parametrize(
    ("chunks", "expected_status", "expected_detail"),
    [
        ([], 502, "empty"),
        ([b"\x00"], 502, "invalid audio"),
        ([b"\x00\x00" * (PROVIDER_SPEECH_PREVIEW_MAX_BYTES // 2 + 1)], 400, "size limit"),
    ],
)
def test_provider_speech_preview_rejects_invalid_pcm(
    client,
    owner_token,
    monkeypatch,
    chunks,
    expected_status,
    expected_detail,
) -> None:
    connection = _create_custom_local_neural(client, owner_token)
    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        lambda _connection, api_key: _SpeechPreviewAdapter(chunks=chunks),
    )
    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/speech-preview",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"model": "model", "text": "test", "voice_id": "voice"},
    )
    assert response.status_code == expected_status, response.text
    assert expected_detail in response.text.lower()


def test_provider_speech_preview_rejects_unknown_non_tts_invalid_and_upstream_errors(
    client,
    owner_token,
    monkeypatch,
) -> None:
    headers = {"Authorization": f"Bearer {owner_token}"}
    unknown = client.post(
        "/api/v1/providers/connections/missing/speech-preview",
        headers=headers,
        json={"model": "model", "text": "test", "voice_id": "voice"},
    )
    assert unknown.status_code == 404

    non_tts = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={"provider": "anthropic", "label": "Chat only", "api_key": "test-key"},
    )
    assert non_tts.status_code == 201
    rejected = client.post(
        f"/api/v1/providers/connections/{non_tts.json()['id']}/speech-preview",
        headers=headers,
        json={"model": "model", "text": "test", "voice_id": "voice"},
    )
    assert rejected.status_code == 424
    assert "does not provide tts" in rejected.text.lower()

    invalid = client.post(
        f"/api/v1/providers/connections/{non_tts.json()['id']}/speech-preview",
        headers=headers,
        json={"model": " ", "text": "", "voice_id": "voice", "speaking_rate": 2.1},
    )
    assert invalid.status_code == 422

    connection = _create_custom_local_neural(client, owner_token)
    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        lambda _connection, api_key: _SpeechPreviewAdapter(
            error=ProviderUnavailableError(
                provider="local-neural",
                public_detail="Local neural TTS is unavailable.",
            )
        ),
    )
    upstream = client.post(
        f"/api/v1/providers/connections/{connection['id']}/speech-preview",
        headers=headers,
        json={"model": "model", "text": "test", "voice_id": "voice"},
    )
    assert upstream.status_code == 503
    assert upstream.json()["code"] == "provider_unavailable"


def test_provider_speech_preview_http_disconnect_cancels_sidecar_inference(
    client,
    owner_token,
    monkeypatch,
) -> None:
    connection = _create_custom_local_neural(client, owner_token)

    async def scenario() -> None:
        entered = asyncio.Event()
        deleted = asyncio.Event()
        post_inference_id: str | None = None
        deleted_inference_id: str | None = None

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal post_inference_id, deleted_inference_id
            if request.method == "POST":
                post_inference_id = request.headers["x-inference-id"]
                return httpx.Response(
                    200,
                    request=request,
                    headers={
                        "content-type": "application/octet-stream",
                        "x-audio-format": "pcm_s16le",
                        "x-audio-channels": "1",
                        "x-audio-sample-rate": "24000",
                    },
                    stream=_BlockingAsyncByteStream(entered),
                )
            deleted_inference_id = request.url.path.rsplit("/", 1)[-1]
            deleted.set()
            return httpx.Response(204, request=request)

        monkeypatch.setattr(
            provider_registry_module,
            "build_provider_adapter",
            lambda _connection, api_key: LocalNeuralTTSProvider(
                transport=httpx.MockTransport(handler)
            ),
        )
        payload = json.dumps(
            {
                "model": LOCAL_NEURAL_TTS_MODEL,
                "text": "cancel this preview",
                "voice_id": "vivian",
            }
        ).encode()
        receive_count = 0

        async def receive() -> dict[str, object]:
            nonlocal receive_count
            receive_count += 1
            if receive_count == 1:
                return {"type": "http.request", "body": payload, "more_body": False}
            await entered.wait()
            return {"type": "http.disconnect"}

        sent: list[dict[str, object]] = []

        async def send(message: dict[str, object]) -> None:
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": f"/api/v1/providers/connections/{connection['id']}/speech-preview",
            "raw_path": (
                f"/api/v1/providers/connections/{connection['id']}/speech-preview"
            ).encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"host", b"127.0.0.1:8000"),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"authorization", f"Bearer {owner_token}".encode()),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            "state": {},
        }
        request_task = asyncio.create_task(app(scope, receive, send))
        await entered.wait()
        await asyncio.sleep(0.1)
        completed_after_disconnect = request_task.done()
        if not completed_after_disconnect:
            request_task.cancel()
        try:
            await request_task
        except asyncio.CancelledError:
            pass

        assert completed_after_disconnect, "HTTP disconnect did not stop speech synthesis"
        assert deleted.is_set(), "Sidecar inference cancellation was not requested"
        assert post_inference_id is not None
        assert deleted_inference_id == post_inference_id
        assert any(message.get("status") == 499 for message in sent)

    asyncio.run(scenario())
