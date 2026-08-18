from app.models.voice import VoiceSynthesisRequest, VoiceSynthesisResponse
from app.providers.tts_base import TTSProvider


class MockTTSProvider(TTSProvider):
    name = "mock_tts"

    async def synthesize(self, request: VoiceSynthesisRequest) -> VoiceSynthesisResponse:
        return VoiceSynthesisResponse(
            provider=self.name,
            voice_mode=request.voice_mode,
            preview_text=request.text[:120],
        )
