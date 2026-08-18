from __future__ import annotations

import asyncio

import pytest

from app.providers.base import ProviderAdapter
from app.providers.errors import ProviderConfigurationError
from app.providers.mock_provider import MockLLMProvider


class _NoAudioAdapter(ProviderAdapter):
    name = "no-audio"


async def _collect_audio_chunks(provider: MockLLMProvider) -> list[bytes]:
    return [
        chunk
        async for chunk in provider.synthesize_speech_stream(
            model="mock-voice-v1",
            text="你好，开始联调音频链路。",
            voice_id="mock-voice",
        )
    ]


def test_provider_adapter_audio_methods_default_to_configuration_error() -> None:
    adapter = _NoAudioAdapter()

    with pytest.raises(ProviderConfigurationError, match="speech-to-text"):
        asyncio.run(adapter.transcribe_pcm16(model="test-model", pcm16=b"\x00\x00"))

    with pytest.raises(ProviderConfigurationError, match="speech synthesis"):
        asyncio.run(
            adapter.synthesize_speech_stream(
                model="test-model",
                text="hello",
                voice_id="voice-id",
            )
            .__anext__()
        )


def test_mock_provider_transcribes_pcm16_to_deterministic_text() -> None:
    provider = MockLLMProvider()

    text = asyncio.run(
        provider.transcribe_pcm16(
            model="mock-stt-v1",
            pcm16=b"\x00\x00\x01\x00\x02\x00\x03\x00",
        )
    )

    assert text == "这是一段用于联调语音链路的模拟转写。"


def test_mock_provider_streams_non_empty_even_pcm_chunks() -> None:
    provider = MockLLMProvider()

    chunks = asyncio.run(_collect_audio_chunks(provider))

    assert chunks
    assert all(chunk for chunk in chunks)
    assert all(len(chunk) % 2 == 0 for chunk in chunks)
    duration_seconds = sum(len(chunk) for chunk in chunks) / (2 * 24_000)
    assert duration_seconds == 2.0
