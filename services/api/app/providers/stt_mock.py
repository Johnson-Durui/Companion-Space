from app.models.voice import VoiceTranscriptionResponse
from app.providers.stt_base import STTProvider


class MockSTTProvider(STTProvider):
    name = "mock_stt"

    def transcribe(self, *, audio_bytes: bytes, filename: str) -> VoiceTranscriptionResponse:
        _ = audio_bytes
        _ = filename
        return VoiceTranscriptionResponse(provider=self.name, text="这是一段用于联调语音链路的模拟转写。")
