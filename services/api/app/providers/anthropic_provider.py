from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, LLMRequest, Message, StreamChunk, Usage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.sse import SSEJSONEvent, iter_sse_json
from app.providers.thinking import ThinkingFilter
from app.providers.url_policy import validate

DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_TIMEOUT_SECONDS = 45.0

AuthenticationProviderError = ProviderAuthenticationError
RateLimitProviderError = ProviderRateLimitError
TimeoutProviderError = ProviderTimeoutError
UpstreamProviderError = ProviderUnavailableError

__all__ = [
    "AnthropicLLMProvider",
    "AuthenticationProviderError",
    "ProviderAuthenticationError",
    "ProviderError",
    "ProviderRateLimitError",
    "ProviderTimeoutError",
    "ProviderUnavailableError",
    "RateLimitProviderError",
    "TimeoutProviderError",
    "UpstreamProviderError",
]


class AnthropicLLMProvider(LLMProvider):
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_ANTHROPIC_BASE_URL,
        version: str = DEFAULT_ANTHROPIC_VERSION,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("Anthropic API key is required")
        if timeout <= 0:
            raise ValueError("Anthropic timeout must be greater than 0")

        self._api_key = api_key
        try:
            self.base_url = validate(base_url, provider=self.name)
        except ProviderConfigurationError as error:
            raise ValueError(error.public_detail) from None
        self.version = version
        self.timeout = timeout
        self.transport = transport

    async def _stream_once(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        payload: dict[str, Any] = {
            **request.extra_body,
            "model": request.model,
            "max_tokens": request.max_tokens,
            "stream": True,
            "system": request.system,
            "messages": [_anthropic_message(message) for message in request.messages],
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.stop is not None:
            payload["stop_sequences"] = request.stop

        reasoning_filter = ThinkingFilter()
        try:
            async with self._build_client(request.timeout_s) as client:
                async with client.stream(
                    "POST", "messages", headers=self._headers(accept_sse=True), json=payload,
                ) as response:
                    await self._raise_for_status(response, operation="chat stream")
                    async for event in self._iter_sse_events(response):
                        body = self._coerce_mapping(event.data)
                        event_type = str(body.get("type") or event.event)
                        if event_type == "error" or event.event == "error":
                            self._raise_midstream_error(body)

                        if event_type == "message_start":
                            tokens = self._extract_usage_value(body, "input_tokens")
                            if tokens is not None:
                                yield StreamChunk(usage=Usage(input_tokens=tokens))
                        elif event_type == "message_delta":
                            tokens = self._extract_usage_value(body, "output_tokens")
                            reason = self._coerce_mapping(body.get("delta")).get("stop_reason")
                            visible, reasoning = reasoning_filter.finish()
                            reasoning_filter = ThinkingFilter()
                            yield StreamChunk(
                                text=visible,
                                reasoning=reasoning,
                                finish_reason="length" if reason == "max_tokens" else reason,
                                usage=Usage(output_tokens=tokens) if tokens is not None else None,
                            )
                        elif event_type == "content_block_delta":
                            delta = self._coerce_mapping(body.get("delta"))
                            if delta.get("type") == "thinking_delta":
                                yield StreamChunk(reasoning=str(delta.get("thinking") or ""))
                            if delta.get("type") == "text_delta":
                                visible, reasoning = reasoning_filter.feed(str(delta.get("text") or ""))
                                if visible or reasoning:
                                    yield StreamChunk(text=visible, reasoning=reasoning)
                        elif event_type in {"message_stop", "done"}:
                            break
                    visible, reasoning = reasoning_filter.finish()
                    if visible or reasoning:
                        yield StreamChunk(text=visible, reasoning=reasoning)
        except httpx.TimeoutException:
            raise self._build_error(ProviderTimeoutError, "Anthropic request timed out") from None
        except httpx.RequestError:
            raise self._build_error(ProviderUnavailableError, "Anthropic is currently unreachable") from None

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        _ = capability
        try:
            async with self._build_client() as client:
                response = await client.get("models", headers=self._headers())
                await self._raise_for_status(response, operation="model discovery")
        except httpx.TimeoutException as exc:
            raise self._build_error(
                ProviderTimeoutError,
                "Anthropic model discovery timed out",
            ) from exc
        except httpx.RequestError as exc:
            raise self._build_error(
                ProviderUnavailableError,
                "Anthropic is currently unreachable",
            ) from exc

        body = self._coerce_mapping(response.json())
        models: list[str] = []
        for item in body.get("data", []):
            model = self._coerce_mapping(item)
            model_id = model.get("id")
            if isinstance(model_id, str) and model_id:
                models.append(model_id)
        return models

    def _build_client(self, timeout: float | None = None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"{self.base_url}/",
            timeout=self.timeout if timeout is None else timeout,
            transport=self.transport,
            follow_redirects=False,
        )

    def _headers(self, *, accept_sse: bool = False) -> dict[str, str]:
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": self.version,
            "content-type": "application/json",
        }
        if accept_sse:
            headers["accept"] = "text/event-stream"
        return headers

    async def _raise_for_status(self, response: httpx.Response, *, operation: str) -> None:
        if response.is_success:
            return

        status_code = response.status_code
        retry_after = self._retry_after_seconds(response)
        if status_code in {401, 403}:
            raise self._build_error(
                ProviderAuthenticationError,
                f"Anthropic {operation} authentication failed. Check the API Key.",
                status_code=status_code,
                retry_after=retry_after,
            )
        if status_code == 429:
            raise self._build_error(
                ProviderRateLimitError,
                f"Anthropic {operation} rate limit reached. Try again later.",
                status_code=status_code,
                retry_after=retry_after,
            )
        raise self._build_error(
            ProviderUnavailableError if status_code >= 500 else ProviderProtocolError,
            f"Anthropic {operation} failed with status {status_code}.",
            status_code=status_code,
            retry_after=retry_after,
        )

    def _raise_midstream_error(self, body: dict[str, Any]) -> None:
        error = self._coerce_mapping(body.get("error") or body)
        error_type = str(error.get("type") or "upstream_error")
        lowered = error_type.lower()

        if "authentication" in lowered:
            raise self._build_error(
                ProviderAuthenticationError,
                "Anthropic authentication failed. Check the API Key.",
            )
        if "rate_limit" in lowered:
            raise self._build_error(
                ProviderRateLimitError,
                "Anthropic rate limit reached. Try again later.",
            )
        raise self._build_error(
            ProviderUnavailableError,
            "Anthropic stream failed. Try again later.",
        )

    async def _iter_sse_events(self, response: httpx.Response) -> AsyncIterator[SSEJSONEvent]:
        async for event in iter_sse_json(response.aiter_lines(), provider=self.name):
            yield event

    @staticmethod
    def _coerce_mapping(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        return {}

    @staticmethod
    def _extract_usage_value(payload: dict[str, Any], key: str) -> int | None:
        usage_candidates = [
            payload.get("usage"),
            AnthropicLLMProvider._coerce_mapping(payload.get("message")).get("usage"),
        ]
        for usage in usage_candidates:
            if not isinstance(usage, dict):
                continue
            value = usage.get(key)
            if isinstance(value, int):
                return value
        return None

    def _build_error(
        self,
        error_cls: type[ProviderError],
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
    ) -> ProviderError:
        return error_cls(
            provider=self.name,
            public_detail=message,
            upstream_status=status_code,
            retry_after=retry_after,
        )

    @staticmethod
    def _retry_after_seconds(response: httpx.Response) -> float | None:
        raw_value = response.headers.get("retry-after")
        if raw_value is None:
            return None
        try:
            return float(raw_value)
        except ValueError:
            return None


def _anthropic_message(message: Message) -> dict[str, Any]:
    if isinstance(message.content, str):
        return {"role": message.role, "content": message.content}
    parts: list[dict[str, Any]] = []
    for part in message.content:
        if part["type"] == "image":
            if not part.get("image_b64") or not part.get("mime"):
                raise ProviderConfigurationError(
                    provider="anthropic", public_detail="An image needs bytes and a MIME type.",
                )
            parts.append({
                "type": "image",
                "source": {"type": "base64", "media_type": part["mime"], "data": part["image_b64"]},
            })
        else:
            parts.append({"type": "text", "text": part.get("text", "")})
    return {"role": message.role, "content": parts}
