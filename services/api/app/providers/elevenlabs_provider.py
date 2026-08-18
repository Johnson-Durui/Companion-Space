from __future__ import annotations

from typing import Any, AsyncIterator

import httpx

from app.models.domain import ProviderCapability
from app.providers.base import ProviderAdapter, iter_pcm16_audio_chunks
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.pinned_http import build_pinned_http_transport


class ElevenLabsProviderAdapter(ProviderAdapter):
    name = "elevenlabs"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.elevenlabs.io/v1",
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("ElevenLabs API key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def discover_models(
        self,
        capability: ProviderCapability | None = None,
    ) -> list[str]:
        if capability not in {None, ProviderCapability.tts}:
            return []
        try:
            async with self._client() as client:
                response = await client.get("models")
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                provider=self.name,
                public_detail="ElevenLabs model discovery timed out.",
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderUnavailableError(
                provider=self.name,
                public_detail="ElevenLabs is currently unreachable.",
            ) from exc

        self._raise_for_status(response)
        try:
            payload: Any = response.json()
        except ValueError as exc:
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="ElevenLabs returned an invalid response.",
                upstream_status=response.status_code,
            ) from exc
        items = payload if isinstance(payload, list) else payload.get("models", [])
        if not isinstance(items, list):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="ElevenLabs returned an invalid models list.",
                upstream_status=response.status_code,
            )
        return [
            model_id
            for item in items
            if isinstance(item, dict)
            and isinstance((model_id := item.get("model_id") or item.get("id")), str)
            and model_id
        ]

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        if not text.strip():
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Text is required for speech synthesis.",
            )
        if not voice_id.strip():
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Voice ID is required for speech synthesis.",
            )
        if sample_rate_hz != 24000:
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Only 24000 Hz PCM speech synthesis is supported.",
            )
        if not 0.7 <= speed <= 1.2:
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="ElevenLabs speech synthesis speed must be between 0.7 and 1.2.",
            )

        payload = {
            "text": text,
            "model_id": model,
            "voice_settings": {"speed": speed},
        }

        async with self._client() as client:
            try:
                async with client.stream(
                    "POST",
                    f"text-to-speech/{voice_id}/stream",
                    params={"output_format": "pcm_24000"},
                    json=payload,
                ) as response:
                    self._raise_for_status(response)
                    async for chunk in iter_pcm16_audio_chunks(
                        response.aiter_bytes(),
                        provider=self.name,
                    ):
                        yield chunk
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="ElevenLabs speech synthesis timed out.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="ElevenLabs is currently unreachable.",
                ) from exc

    def _client(self) -> httpx.AsyncClient:
        transport = self._transport
        if transport is None:
            transport = build_pinned_http_transport(
                self._base_url,
                provider=self.name,
            )
        return httpx.AsyncClient(
            base_url=f"{self._base_url}/",
            headers={"xi-api-key": self._api_key},
            timeout=self._timeout,
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        )

    def _raise_for_status(self, response: httpx.Response) -> None:
        if 200 <= response.status_code < 300:
            return
        if response.status_code in {401, 403}:
            raise ProviderAuthenticationError(
                provider=self.name,
                public_detail="ElevenLabs rejected this API Key.",
                upstream_status=response.status_code,
            )
        if response.status_code == 429:
            raise ProviderRateLimitError(
                provider=self.name,
                public_detail="ElevenLabs rate limit reached. Try again later.",
                upstream_status=429,
                retry_after=self._retry_after(response),
            )
        if response.status_code >= 500:
            raise ProviderUnavailableError(
                provider=self.name,
                public_detail="ElevenLabs is temporarily unavailable.",
                upstream_status=response.status_code,
            )
        raise ProviderProtocolError(
            provider=self.name,
            public_detail="ElevenLabs request failed.",
            upstream_status=response.status_code,
        )

    @staticmethod
    def _retry_after(response: httpx.Response) -> float | None:
        raw_value = response.headers.get("retry-after")
        if raw_value is None:
            return None
        try:
            return float(raw_value)
        except ValueError:
            return None
