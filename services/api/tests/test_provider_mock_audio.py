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


def test_mock_provider_streams_non_empty_even_pcm_chunks() -> None:
    provider = MockLLMProvider()

    chunks = asyncio.run(_collect_audio_chunks(provider))

    assert chunks
    assert all(chunk for chunk in chunks)
    assert all(len(chunk) % 2 == 0 for chunk in chunks)
