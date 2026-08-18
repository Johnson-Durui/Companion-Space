from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.providers.elevenlabs_provider import ElevenLabsProviderAdapter
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
)


class _AsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _provider(handler) -> ElevenLabsProviderAdapter:
    return ElevenLabsProviderAdapter(
        api_key="test-elevenlabs-key",
        transport=httpx.MockTransport(handler),
    )


async def _collect_audio_chunks(provider: ElevenLabsProviderAdapter) -> list[bytes]:
    return [
        chunk
        async for chunk in provider.synthesize_speech_stream(
            model="eleven_flash_v2_5",
            text="测试流式语音。",
            voice_id="voice-123",
        )
    ]


def test_elevenlabs_transcribe_defaults_to_configuration_error() -> None:
    provider = _provider(lambda request: httpx.Response(200, request=request))

    with pytest.raises(ProviderConfigurationError, match="speech-to-text"):
        asyncio.run(provider.transcribe_pcm16(model="unused", pcm16=b"\x00\x00"))


def test_elevenlabs_streams_pcm_audio_with_even_non_empty_chunks() -> None:
    expected_audio = b"\x10\x00\x20\x00"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/text-to-speech/voice-123/stream"
        assert request.url.params["output_format"] == "pcm_24000"
        assert request.headers["xi-api-key"] == "test-elevenlabs-key"
        body = json.loads(request.content.decode("utf-8"))
        assert body == {
            "text": "测试流式语音。",
            "model_id": "eleven_flash_v2_5",
            "voice_settings": {"speed": 1.0},
        }
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "application/octet-stream"},
            stream=_AsyncByteStream([b"\x10", b"\x00\x20", b"", b"\x00"]),
        )

    provider = _provider(handler)

    chunks = asyncio.run(_collect_audio_chunks(provider))

    assert chunks == [b"\x10\x00", b"\x20\x00"]
    assert b"".join(chunks) == expected_audio
    assert all(chunk and len(chunk) % 2 == 0 for chunk in chunks)


def test_elevenlabs_stream_rejects_truncated_pcm_frame() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "application/octet-stream"},
            stream=_AsyncByteStream([b"\x01"]),
        )

    provider = _provider(handler)

    with pytest.raises(ProviderProtocolError, match="audio response"):
        asyncio.run(_collect_audio_chunks(provider))


def test_elevenlabs_stream_preserves_retry_after_mapping() -> None:
    provider = _provider(
        lambda request: httpx.Response(
            429,
            request=request,
            json={"detail": "slow down"},
            headers={"retry-after": "9"},
        )
    )

    with pytest.raises(ProviderRateLimitError) as exc_info:
        asyncio.run(
            _collect_audio_chunks(provider)
        )

    assert exc_info.value.upstream_status == 429
    assert exc_info.value.retry_after == 9.0


def test_elevenlabs_redirect_is_not_followed_and_is_rejected() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            307,
            request=request,
            headers={"location": "https://attacker.test/audio"},
        )

    provider = _provider(handler)

    with pytest.raises(ProviderProtocolError) as exc_info:
        asyncio.run(_collect_audio_chunks(provider))

    assert len(requests) == 1
    assert exc_info.value.upstream_status == 307
