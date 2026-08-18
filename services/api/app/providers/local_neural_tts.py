from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

import httpx
from uuid import uuid4

from app.models.domain import CompanionEmotion, ProviderCapability
from app.providers.base import ProviderAdapter, iter_pcm16_audio_chunks
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


LOCAL_NEURAL_TTS_MODEL = "qwen3-tts-0.6b-customvoice"
LOCAL_NEURAL_TTS_DEFAULT_BASE_URL = "http://127.0.0.1:8001"
_MAX_TEXT_CHARS = 240
_BREAK_CHARS = frozenset("\u3002\uff01\uff1f!?\uff1b;\uff0c,\u3001.:\uff1a\n")
_ALLOWED_EMOTIONS = frozenset(
    {"neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned"}
)
logger = logging.getLogger(__name__)


class LocalNeuralTTSProvider(ProviderAdapter):
    name = "local-neural"
    supports_companion_emotion = True

    def __init__(
        self,
        *,
        base_url: str = LOCAL_NEURAL_TTS_DEFAULT_BASE_URL,
        timeout: float = 45.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def discover_models(
        self,
        capability: ProviderCapability | None = None,
    ) -> list[str]:
        if capability not in {None, ProviderCapability.tts}:
            return []
        async with self._client() as client:
            try:
                response = await client.get("healthz")
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="Local neural TTS health check timed out.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="Local neural TTS is unavailable.",
                ) from exc
        self._raise_for_status(response)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Local neural TTS returned an invalid health response.",
                upstream_status=response.status_code,
            ) from exc
        if not isinstance(payload, dict) or payload.get("status") != "ready" or payload.get("model") != LOCAL_NEURAL_TTS_MODEL:
            raise ProviderUnavailableError(
                provider=self.name,
                public_detail="Local neural TTS is still loading.",
                upstream_status=response.status_code,
            )
        return [LOCAL_NEURAL_TTS_MODEL]

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
        emotion: CompanionEmotion = "warm",
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
        if speed <= 0:
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Speech synthesis speed must be greater than zero.",
            )
        if emotion not in _ALLOWED_EMOTIONS:
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Unsupported companion speech emotion.",
            )

        async with self._client() as client:
            for segment in _split_text(text):
                inference_id = str(uuid4())
                payload = {
                    "model": model,
                    "input": segment,
                    "voice": voice_id,
                    "speed": speed,
                    "emotion": emotion,
                    "response_format": "pcm",
                }
                try:
                    async with client.stream(
                        "POST",
                        "v1/audio/speech",
                        json=payload,
                        headers={"X-Inference-ID": inference_id},
                    ) as response:
                        self._raise_for_status(response)
                        self._validate_audio_response(response)
                        async for chunk in iter_pcm16_audio_chunks(
                            response.aiter_bytes(),
                            provider=self.name,
                        ):
                            yield chunk
                except asyncio.CancelledError:
                    try:
                        await asyncio.shield(self._cancel_inference(inference_id))
                    except Exception:
                        logger.exception(
                            "Failed to cancel local neural TTS inference %s",
                            inference_id,
                        )
                    raise
                except httpx.TimeoutException as exc:
                    raise ProviderTimeoutError(
                        provider=self.name,
                        public_detail="Local neural TTS timed out.",
                    ) from exc
                except httpx.RequestError as exc:
                    raise ProviderUnavailableError(
                        provider=self.name,
                        public_detail="Local neural TTS is unavailable.",
                    ) from exc

    async def _cancel_inference(self, inference_id: str) -> None:
        async with httpx.AsyncClient(
            base_url=f"{self._base_url}/",
            timeout=5.0,
            transport=self._transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.delete(f"v1/audio/speech/{inference_id}")
            if response.status_code not in {204, 404}:
                self._raise_for_status(response)

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"{self._base_url}/",
            timeout=self._timeout,
            transport=self._transport,
            trust_env=False,
            follow_redirects=False,
        )

    def _raise_for_status(self, response: httpx.Response) -> None:
        if 200 <= response.status_code < 300:
            return
        if response.status_code >= 500:
            raise ProviderUnavailableError(
                provider=self.name,
                public_detail="Local neural TTS is unavailable.",
                upstream_status=response.status_code,
            )
        raise ProviderProtocolError(
            provider=self.name,
            public_detail="Local neural TTS request failed.",
            upstream_status=response.status_code,
        )

    def _validate_audio_response(self, response: httpx.Response) -> None:
        content_type = response.headers.get("content-type", "").partition(";")[0]
        if (
            content_type != "application/octet-stream"
            or response.headers.get("x-audio-format") != "pcm_s16le"
            or response.headers.get("x-audio-channels") != "1"
            or response.headers.get("x-audio-sample-rate") != "24000"
        ):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Local neural TTS returned an invalid audio response.",
                upstream_status=response.status_code,
            )


def _split_text(text: str) -> list[str]:
    remaining = text.strip()
    segments: list[str] = []
    while remaining:
        if len(remaining) <= _MAX_TEXT_CHARS:
            segments.append(remaining)
            break
        boundary = max(
            (
                index + 1
                for index, char in enumerate(remaining[:_MAX_TEXT_CHARS])
                if char in _BREAK_CHARS
            ),
            default=_MAX_TEXT_CHARS,
        )
        segments.append(remaining[:boundary].strip())
        remaining = remaining[boundary:].strip()
    return segments
