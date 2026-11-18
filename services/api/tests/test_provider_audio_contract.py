from __future__ import annotations

import asyncio

import pytest

from app.providers.base import ProviderAdapter
from app.providers.errors import ProviderConfigurationError


class _NoAudioAdapter(ProviderAdapter):
    name = "no-audio"


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
