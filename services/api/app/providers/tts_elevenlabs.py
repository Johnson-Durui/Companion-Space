import base64

import httpx

from app.models.voice import VoiceSynthesisRequest, VoiceSynthesisResponse
from app.providers.pinned_http import build_pinned_http_transport
from app.providers.tts_base import TTSProvider


class ElevenLabsTTSProvider(TTSProvider):
    name = "elevenlabs"

    def __init__(
        self,
        *,
        api_key: str,
        voice_id: str,
        base_url: str = "https://api.elevenlabs.io",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("ElevenLabs API key is required")
        if not voice_id:
            raise ValueError("ElevenLabs Voice ID is required")
        self._api_key = api_key
        self.voice_id = voice_id
        self.base_url = base_url.rstrip("/")
        self._transport = transport

    async def synthesize(self, request: VoiceSynthesisRequest) -> VoiceSynthesisResponse:
        payload = {
            "text": request.text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {
                "stability": 0.45,
                "similarity_boost": 0.8,
            },
        }
        headers = {
            "xi-api-key": self._api_key,
            "accept": "audio/mpeg",
            "content-type": "application/json",
        }
        transport = self._transport
        if transport is None:
            transport = build_pinned_http_transport(
                self.base_url,
                provider=self.name,
            )
        async with httpx.AsyncClient(
            timeout=45.0,
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.post(
                f"{self.base_url}/v1/text-to-speech/{self.voice_id}",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        return VoiceSynthesisResponse(
            provider=self.name,
            voice_mode=request.voice_mode,
            audio_base64=base64.b64encode(response.content).decode("utf-8"),
            content_type="audio/mpeg",
            preview_text=request.text[:120],
        )
