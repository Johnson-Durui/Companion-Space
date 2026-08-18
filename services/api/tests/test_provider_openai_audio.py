from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
)
from app.providers.openai_compatible import OpenAICompatibleProvider


class _AsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _provider(handler) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        api_key="test-key",
        base_url="https://api.example.com/custom-root",
        provider_name="openai-compatible",
        timeout=5.0,
        transport=httpx.MockTransport(handler),
    )


async def _collect_audio_chunks(provider: OpenAICompatibleProvider) -> list[bytes]:
    return [
        chunk
        async for chunk in provider.synthesize_speech_stream(
            model="gpt-4o-mini-tts",
            text="Speak clearly.",
            voice_id="alloy",
        )
    ]


async def _collect_stream_chunks(stream) -> list[bytes]:
    return [chunk async for chunk in stream]


def test_transcribe_pcm16_posts_in_memory_wav_multipart() -> None:
    pcm16 = b"\x01\x00\x02\x00\x03\x00\x04\x00"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/custom-root/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer test-key"
        assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
        assert b'name="model"' in request.content
        assert b"whisper-1" in request.content
        assert b'name="file"; filename="audio.wav"' in request.content
        assert b"audio/wav" in request.content
        assert b"RIFF" in request.content
        assert b"WAVE" in request.content
        assert b"fmt " in request.content
        assert b"data" in request.content
        assert pcm16 in request.content
        return httpx.Response(200, json={"text": "transcribed text"})

    provider = _provider(handler)

    text = asyncio.run(provider.transcribe_pcm16(model="whisper-1", pcm16=pcm16))

    assert text == "transcribed text"


def test_synthesize_speech_stream_filters_empty_chunks_and_realigns_pcm_frames() -> None:
    expected_audio = b"\x01\x00\x02\x00"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/custom-root/v1/audio/speech"
        assert request.headers["authorization"] == "Bearer test-key"
        body = json.loads(request.content.decode("utf-8"))
        assert body == {
            "model": "gpt-4o-mini-tts",
            "input": "Speak clearly.",
            "voice": "alloy",
            "speed": 1.0,
            "response_format": "pcm",
        }
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "application/octet-stream"},
            stream=_AsyncByteStream([b"\x01", b"\x00\x02", b"", b"\x00"]),
        )

    provider = _provider(handler)

    chunks = asyncio.run(_collect_audio_chunks(provider))

    assert chunks == [b"\x01\x00", b"\x02\x00"]
    assert b"".join(chunks) == expected_audio
    assert all(chunk and len(chunk) % 2 == 0 for chunk in chunks)


def test_synthesize_speech_stream_rejects_truncated_pcm_frame() -> None:
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


def test_transcribe_pcm16_preserves_sanitized_auth_errors() -> None:
    provider = _provider(
        lambda request: httpx.Response(
            401,
            request=request,
            json={"error": {"message": "bad key test-key"}},
        )
    )

    with pytest.raises(ProviderAuthenticationError) as exc_info:
        asyncio.run(provider.transcribe_pcm16(model="whisper-1", pcm16=b"\x00\x00"))

    assert exc_info.value.upstream_status == 401
    assert "test-key" not in str(exc_info.value)


def test_synthesize_speech_stream_rejects_out_of_range_speed() -> None:
    provider = _provider(lambda request: httpx.Response(200, request=request))

    with pytest.raises(ProviderConfigurationError, match="between 0.25 and 4.0"):
        asyncio.run(
            _collect_stream_chunks(
                provider.synthesize_speech_stream(
                    model="gpt-4o-mini-tts",
                    text="Speak clearly.",
                    voice_id="alloy",
                    speed=4.5,
                )
            )
        )
