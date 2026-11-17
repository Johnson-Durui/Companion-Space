from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.models.domain import (
    CompanionEmotion,
)
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderTimeoutError,
)
from app.providers.local_neural_tts import (
    LOCAL_NEURAL_TTS_MODEL,
    LocalNeuralTTSProvider,
)


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
