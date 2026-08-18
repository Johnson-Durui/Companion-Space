from importlib.util import find_spec

from app.providers.stt_base import STTProvider
from app.providers.stt_faster_whisper import FasterWhisperSTTProvider
from app.providers.stt_mock import MockSTTProvider
from app.providers.tts_base import TTSProvider
from app.providers.tts_elevenlabs import ElevenLabsTTSProvider
from app.providers.tts_mock import MockTTSProvider


def build_stt_provider(provider: str) -> STTProvider:
    if provider == "faster_whisper":
        if find_spec("faster_whisper") is not None:
            return FasterWhisperSTTProvider()
        raise RuntimeError("faster-whisper is not installed")
    if provider == "mock":
        return MockSTTProvider()
    raise RuntimeError(f"Unsupported STT provider: {provider}")


def build_tts_provider(
    provider: str,
    *,
    api_key: str = "",
    voice_id: str = "",
    base_url: str = "https://api.elevenlabs.io",
) -> TTSProvider:
    if provider == "elevenlabs":
        return ElevenLabsTTSProvider(
            api_key=api_key,
            voice_id=voice_id,
            base_url=base_url,
        )
    if provider == "mock":
        return MockTTSProvider()
    raise RuntimeError(f"Unsupported TTS provider: {provider}")
