from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlparse

import httpx

from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, ProviderMessage, ProviderStreamChunk
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.pinned_http import build_pinned_http_transport
from app.providers.sse import SSEJSONEvent, iter_sse_json

DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
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
        self.base_url = self._validate_base_url(base_url)
        self.version = version
        self.timeout = timeout
        self.transport = transport

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
            "max_tokens": 1024,
            "stream": True,
            "system": system_prompt,
            "messages": [
                *({"role": turn.role, "content": turn.content} for turn in history),
                {"role": "user", "content": user_message},
            ],
        }

        input_tokens: int | None = None
        output_tokens: int | None = None

        try:
            async with self._build_client() as client:
                async with client.stream(
                    "POST",
                    "/v1/messages",
                    headers=self._headers(accept_sse=True),
                    json=payload,
                ) as response:
                    await self._raise_for_status(response, operation="chat stream")
                    async for event in self._iter_sse_events(response):
                        body = self._coerce_mapping(event.data)
                        event_type = str(body.get("type") or event.event)

                        if event_type == "message_start":
                            input_tokens = self._extract_usage_value(body, "input_tokens") or input_tokens
                            continue
                        if event_type == "message_delta":
                            output_tokens = self._extract_usage_value(body, "output_tokens") or output_tokens
                            continue
                        if event_type in {"content_block_start", "content_block_stop", "ping"}:
                            continue
                        if event_type in {"message_stop", "done"}:
                            if input_tokens is not None or output_tokens is not None:
                                yield self._build_stream_chunk(
                                    text="",
                                    input_tokens=input_tokens,
                                    output_tokens=output_tokens,
                                )
                            return
                        if event_type == "error" or event.event == "error":
                            self._raise_midstream_error(body)
                        if event_type != "content_block_delta":
                            continue

                        delta = self._coerce_mapping(body.get("delta"))
                        if delta.get("type") != "text_delta":
                            continue

                        text = str(delta.get("text") or "")
                        if not text:
                            continue

                        yield self._build_stream_chunk(
                            text=text,
                            input_tokens=input_tokens,
                            output_tokens=output_tokens,
                        )
        except httpx.TimeoutException as exc:
            raise self._build_error(
                ProviderTimeoutError,
                "Anthropic request timed out",
            ) from exc
        except httpx.RequestError as exc:
            raise self._build_error(
                ProviderUnavailableError,
                "Anthropic is currently unreachable",
            ) from exc

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        _ = capability
        try:
            async with self._build_client() as client:
                response = await client.get("/v1/models", headers=self._headers())
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

    def _build_client(self) -> httpx.AsyncClient:
        transport = self.transport
        if transport is None:
            transport = build_pinned_http_transport(
                self.base_url,
                provider=self.name,
            )
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(self.timeout),
            transport=transport,
            trust_env=False,
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
        await response.aread()
        retry_after = self._retry_after_seconds(response)
        if status_code == 401:
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
            ProviderUnavailableError,
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

    def _build_stream_chunk(
        self,
        *,
        text: str,
        input_tokens: int | None,
        output_tokens: int | None,
    ) -> ProviderStreamChunk:
        return ProviderStreamChunk(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

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

    @staticmethod
    def _validate_base_url(base_url: str) -> str:
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Anthropic base_url must be an absolute http(s) URL")
        if parsed.query or parsed.fragment:
            raise ValueError("Anthropic base_url must not include query or fragment")
        if parsed.path not in {"", "/"}:
            raise ValueError("Anthropic base_url must not include a path")
        return f"{parsed.scheme}://{parsed.netloc}"

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
