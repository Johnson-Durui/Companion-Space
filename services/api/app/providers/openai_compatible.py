from __future__ import annotations

import io
import wave
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, AsyncIterator, Sequence
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.models.domain import ProviderCapability
from app.providers.base import (
    LLMProvider,
    ProviderMessage,
    ProviderStreamChunk,
    iter_pcm16_audio_chunks,
)
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.pinned_http import build_pinned_http_transport
from app.providers.sse import iter_sse_json


class OpenAICompatibleProvider(LLMProvider):
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        provider_name: str,
        timeout: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        normalized_provider_name = provider_name.strip()
        if not normalized_provider_name:
            raise ProviderConfigurationError(
                provider="provider",
                public_detail="Provider name is required.",
            )

        normalized_api_key = api_key.strip()
        if not normalized_api_key:
            raise ProviderConfigurationError(
                provider=normalized_provider_name,
                public_detail="API key is required.",
            )

        if timeout <= 0:
            raise ProviderConfigurationError(
                provider=normalized_provider_name,
                public_detail="Timeout must be greater than zero.",
            )

        self.name = normalized_provider_name
        self._api_key = normalized_api_key
        self.base_url = _normalize_api_root(base_url, provider_name=self.name)
        self.timeout = timeout
        self._transport = transport

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        payload = {
            "model": model,
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [
                {"role": "system", "content": system_prompt},
                *({"role": turn.role, "content": turn.content} for turn in history),
                {"role": "user", "content": user_message},
            ],
        }

        async with self._client() as client:
            try:
                async with client.stream("POST", "chat/completions", json=payload) as response:
                    self._raise_for_status(response)
                    async for event in iter_sse_json(response.aiter_lines(), provider=self.name):
                        yield self._parse_chat_stream_event(event.data)
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="The provider timed out. Please retry.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="The provider is unavailable. Please retry.",
                ) from exc

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        _ = capability
        data = await self._request_json("GET", "models")
        models = data.get("data")
        if not isinstance(models, list):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid models response.",
            )

        model_ids: list[str] = []
        for item in models:
            if not isinstance(item, dict):
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Provider returned an invalid models response.",
                )
            model_id = item.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Provider returned an invalid models response.",
                )
            model_ids.append(model_id)
        return model_ids

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []

        data = await self._request_json(
            "POST",
            "embeddings",
            json_body={"model": model, "input": list(texts)},
        )
        rows = data.get("data")
        if not isinstance(rows, list):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid embeddings response.",
            )

        ordered_rows: list[tuple[int, list[float]]] = []
        for row in rows:
            if not isinstance(row, dict):
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Provider returned an invalid embeddings response.",
                )
            index = row.get("index")
            embedding = row.get("embedding")
            if not isinstance(index, int) or not isinstance(embedding, list):
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Provider returned an invalid embeddings response.",
                )
            vector = [float(value) for value in embedding]
            ordered_rows.append((index, vector))

        ordered_rows.sort(key=lambda item: item[0])
        return [vector for _, vector in ordered_rows]

    async def transcribe_pcm16(
        self,
        model: str,
        pcm16: bytes,
        sample_rate_hz: int = 16000,
    ) -> str:
        _validate_input_pcm16(
            provider=self.name,
            pcm16=pcm16,
            sample_rate_hz=sample_rate_hz,
        )

        files = {"file": ("audio.wav", _pcm16_to_wav(pcm16, sample_rate_hz), "audio/wav")}
        data = {"model": model}

        async with self._client() as client:
            try:
                response = await client.post("audio/transcriptions", data=data, files=files)
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="The provider timed out. Please retry.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="The provider is unavailable. Please retry.",
                ) from exc

        self._raise_for_status(response)

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid transcription response.",
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid transcription response.",
            )

        text = payload.get("text")
        if not isinstance(text, str) or not text:
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid transcription response.",
            )
        return text

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        _validate_tts_request(
            provider=self.name,
            text=text,
            voice_id=voice_id,
            speed=speed,
            sample_rate_hz=sample_rate_hz,
        )

        payload = {
            "model": model,
            "input": text,
            "voice": voice_id,
            "speed": speed,
            "response_format": "pcm",
        }

        async with self._client() as client:
            try:
                async with client.stream("POST", "audio/speech", json=payload) as response:
                    self._raise_for_status(response)
                    async for chunk in iter_pcm16_audio_chunks(
                        response.aiter_bytes(),
                        provider=self.name,
                    ):
                        yield chunk
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="The provider timed out. Please retry.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="The provider is unavailable. Please retry.",
                ) from exc

    def _client(self) -> httpx.AsyncClient:
        transport = self._transport
        if transport is None:
            transport = build_pinned_http_transport(
                self.base_url,
                provider=self.name,
            )
        return httpx.AsyncClient(
            base_url=f"{self.base_url}/",
            headers={
                "authorization": f"Bearer {self._api_key}",
            },
            timeout=self.timeout,
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        )

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with self._client() as client:
            try:
                response = await client.request(method, path, json=json_body)
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError(
                    provider=self.name,
                    public_detail="The provider timed out. Please retry.",
                ) from exc
            except httpx.RequestError as exc:
                raise ProviderUnavailableError(
                    provider=self.name,
                    public_detail="The provider is unavailable. Please retry.",
                ) from exc

        self._raise_for_status(response)

        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid JSON response.",
            ) from exc

        if not isinstance(data, dict):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid JSON response.",
            )
        return data

    def _parse_chat_stream_event(self, payload: Any) -> ProviderStreamChunk:
        if not isinstance(payload, dict):
            raise ProviderProtocolError(
                provider=self.name,
                public_detail="Provider returned an invalid streaming response.",
            )

        text = ""
        choices = payload.get("choices")
        if choices is not None:
            if not isinstance(choices, list):
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Provider returned an invalid streaming response.",
                )
            first_choice = choices[0] if choices else {}
            if first_choice:
                if not isinstance(first_choice, dict):
                    raise ProviderProtocolError(
                        provider=self.name,
                        public_detail="Provider returned an invalid streaming response.",
                    )
                delta = first_choice.get("delta", {})
                if not isinstance(delta, dict):
                    raise ProviderProtocolError(
                        provider=self.name,
                        public_detail="Provider returned an invalid streaming response.",
                    )
                text = _extract_delta_text(delta.get("content"), provider_name=self.name)

        input_tokens, output_tokens = _extract_usage(payload.get("usage"), provider_name=self.name)
        return ProviderStreamChunk(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    def _raise_for_status(self, response: httpx.Response) -> None:
        status = response.status_code
        if 200 <= status < 300:
            return

        retry_after = _parse_retry_after(response.headers.get("retry-after"))
        if status in {401, 403}:
            raise ProviderAuthenticationError(
                provider=self.name,
                public_detail="Authentication failed. Check the provider API key.",
                upstream_status=status,
            )
        if status == 429:
            raise ProviderRateLimitError(
                provider=self.name,
                public_detail="Provider rate limit reached. Please retry later.",
                upstream_status=status,
                retry_after=retry_after,
            )
        if status >= 500:
            raise ProviderUnavailableError(
                provider=self.name,
                public_detail="The provider is unavailable. Please retry.",
                upstream_status=status,
                retry_after=retry_after,
            )
        raise ProviderProtocolError(
            provider=self.name,
            public_detail=f"Provider request failed with status {status}.",
            upstream_status=status,
            retry_after=retry_after,
        )


def _normalize_api_root(base_url: str, *, provider_name: str) -> str:
    candidate = base_url.strip()
    if not candidate:
        raise ProviderConfigurationError(
            provider=provider_name,
            public_detail="Base URL is required.",
        )

    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProviderConfigurationError(
            provider=provider_name,
            public_detail="Base URL must be a valid http(s) URL.",
        )
    if parsed.username or parsed.password:
        raise ProviderConfigurationError(
            provider=provider_name,
            public_detail="Base URL must not include credentials.",
        )
    if parsed.query or parsed.fragment:
        raise ProviderConfigurationError(
            provider=provider_name,
            public_detail="Base URL must not include query strings or fragments.",
        )

    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1"
    elif not path.endswith("/v1"):
        path = f"{path}/v1"

    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _extract_delta_text(content: Any, *, provider_name: str) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                raise ProviderProtocolError(
                    provider=provider_name,
                    public_detail="Provider returned an invalid streaming response.",
                )
            text = item.get("text")
            if text is None:
                continue
            if not isinstance(text, str):
                raise ProviderProtocolError(
                    provider=provider_name,
                    public_detail="Provider returned an invalid streaming response.",
                )
            parts.append(text)
        return "".join(parts)
    raise ProviderProtocolError(
        provider=provider_name,
        public_detail="Provider returned an invalid streaming response.",
    )


def _extract_usage(usage: Any, *, provider_name: str) -> tuple[int | None, int | None]:
    if usage is None:
        return None, None
    if not isinstance(usage, dict):
        raise ProviderProtocolError(
            provider=provider_name,
            public_detail="Provider returned an invalid usage payload.",
        )

    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    total_tokens = usage.get("total_tokens")

    input_tokens = _coerce_optional_int(prompt_tokens, provider_name=provider_name)
    output_tokens = _coerce_optional_int(completion_tokens, provider_name=provider_name)

    if input_tokens is None and output_tokens is None:
        if total_tokens is None:
            return None, None
        _coerce_optional_int(total_tokens, provider_name=provider_name)
        return None, None

    return input_tokens, output_tokens


def _coerce_optional_int(value: Any, *, provider_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProviderProtocolError(
            provider=provider_name,
            public_detail="Provider returned an invalid numeric payload.",
        )
    return value


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        return max(parsed.timestamp() - datetime.now(parsed.tzinfo).timestamp(), 0.0)


def _validate_input_pcm16(
    *,
    provider: str,
    pcm16: bytes,
    sample_rate_hz: int,
) -> None:
    if sample_rate_hz <= 0:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Sample rate must be greater than zero.",
        )
    if not pcm16 or len(pcm16) % 2 != 0:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="PCM16 audio must be non-empty and aligned to 16-bit samples.",
        )


def _validate_tts_request(
    *,
    provider: str,
    text: str,
    voice_id: str,
    speed: float,
    sample_rate_hz: int,
) -> None:
    if not text.strip():
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Text is required for speech synthesis.",
        )
    if not voice_id.strip():
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Voice ID is required for speech synthesis.",
        )
    if sample_rate_hz != 24000:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Only 24000 Hz PCM speech synthesis is supported.",
        )
    if not 0.25 <= speed <= 4.0:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Speech synthesis speed must be between 0.25 and 4.0.",
        )


def _pcm16_to_wav(pcm16: bytes, sample_rate_hz: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate_hz)
        wav_file.writeframes(pcm16)
    return buffer.getvalue()
