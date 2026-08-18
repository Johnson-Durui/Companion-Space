from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from app.providers.anthropic_provider import AnthropicLLMProvider
from app.providers.base import ProviderMessage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class _AsyncLineStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _sse_response(request: httpx.Request, events: list[tuple[str, dict[str, Any]]]) -> httpx.Response:
    lines: list[bytes] = []
    for event_name, payload in events:
        lines.append(f"event: {event_name}\n".encode("utf-8"))
        lines.append(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        request=request,
        stream=_AsyncLineStream(lines),
    )


async def _collect_chunks(provider: AnthropicLLMProvider) -> list[Any]:
    return [
        chunk
        async for chunk in provider.generate_reply_stream(
            model="claude-sonnet-test",
            system_prompt="Keep it brief.",
            history=[ProviderMessage(role="assistant", content="Earlier reply.")],
            user_message="Hello there.",
        )
    ]


def _chunk_text(chunk: Any) -> str:
    for field_name in ("text", "delta", "content", "delta_text"):
        value = getattr(chunk, field_name, None)
        if isinstance(value, str):
            return value
    if isinstance(chunk, dict):
        for field_name in ("text", "delta", "content", "delta_text"):
            value = chunk.get(field_name)
            if isinstance(value, str):
                return value
    return ""


def _chunk_usage_value(chunk: Any, *field_names: str) -> int | None:
    for field_name in field_names:
        value = getattr(chunk, field_name, None)
        if isinstance(value, int):
            return value
    if isinstance(chunk, dict):
        for field_name in field_names:
            value = chunk.get(field_name)
            if isinstance(value, int):
                return value

    usage = getattr(chunk, "usage", None)
    if isinstance(usage, dict):
        for field_name in field_names:
            value = usage.get(field_name)
            if isinstance(value, int):
                return value

    return None


def test_anthropic_provider_streams_text_and_usage_without_leaking_key() -> None:
    requests: list[httpx.Request] = []
    secret = "test-anthropic-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "POST"
        assert request.url.path == "/v1/messages"
        assert request.headers["x-api-key"] == secret
        assert request.headers["anthropic-version"] == "2023-06-01"
        assert request.headers["accept"] == "text/event-stream"

        payload = json.loads(request.content.decode("utf-8"))
        assert payload["stream"] is True
        assert payload["model"] == "claude-sonnet-test"
        assert payload["messages"][-1] == {"role": "user", "content": "Hello there."}

        return _sse_response(
            request,
            [
                ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 11}}}),
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}},
                ),
                ("ping", {"type": "ping"}),
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world"}},
                ),
                ("message_delta", {"type": "message_delta", "usage": {"output_tokens": 7}}),
                ("message_stop", {"type": "message_stop"}),
            ],
        )

    provider = AnthropicLLMProvider(api_key=secret, transport=httpx.MockTransport(handler))

    chunks = asyncio.run(_collect_chunks(provider))
    texts = [_chunk_text(chunk) for chunk in chunks if _chunk_text(chunk)]
    assert texts == ["Hello", " world"]
    assert any(_chunk_usage_value(chunk, "input_tokens", "prompt_tokens") == 11 for chunk in chunks)
    assert any(_chunk_usage_value(chunk, "output_tokens", "completion_tokens") == 7 for chunk in chunks)

    reply = asyncio.run(
        provider.generate_reply(
            model="claude-sonnet-test",
            system_prompt="Keep it brief.",
            history=[],
            user_message="Hello there.",
        )
    )
    assert reply.raw_text == "Hello world"
    assert secret not in repr(reply)
    assert secret not in repr(provider)
    assert len(requests) == 2


def test_anthropic_provider_discovers_models_via_api() -> None:
    seen_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers["x-api-key"] = request.headers["x-api-key"]
        assert request.method == "GET"
        assert request.url.path == "/v1/models"
        return httpx.Response(
            200,
            request=request,
            json={
                "data": [
                    {"id": "claude-3-5-sonnet-20241022"},
                    {"id": "claude-3-5-haiku-20241022"},
                ]
            },
        )

    provider = AnthropicLLMProvider(
        api_key="test-anthropic-secret",
        transport=httpx.MockTransport(handler),
    )

    models = asyncio.run(provider.discover_models())
    assert models == ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"]
    assert seen_headers["x-api-key"] == "test-anthropic-secret"


def test_anthropic_provider_maps_midstream_error_event() -> None:
    secret_upstream_message = "sk-secret prompt and retrieved document text"

    def handler(request: httpx.Request) -> httpx.Response:
        return _sse_response(
            request,
            [
                (
                    "error",
                    {
                        "type": "error",
                        "error": {
                            "type": "api_error",
                            "message": secret_upstream_message,
                        },
                    },
                )
            ],
        )

    provider = AnthropicLLMProvider(
        api_key="test-anthropic-secret",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderError, match="Anthropic stream failed") as exc_info:
        asyncio.run(_collect_chunks(provider))

    assert secret_upstream_message not in str(exc_info.value)


@pytest.mark.parametrize(
    ("status_code", "error_type", "public_detail"),
    [
        (401, ProviderAuthenticationError, "Anthropic chat stream authentication failed. Check the API Key."),
        (429, ProviderRateLimitError, "Anthropic chat stream rate limit reached. Try again later."),
    ],
)
def test_anthropic_provider_maps_http_statuses(
    status_code: int,
    error_type: type[Exception],
    public_detail: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            request=request,
            json={"error": {"message": f"status-{status_code}", "type": "api_error"}},
        )

    provider = AnthropicLLMProvider(
        api_key="test-anthropic-secret",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(error_type) as exc_info:
        asyncio.run(_collect_chunks(provider))

    assert exc_info.value.provider == "anthropic"
    assert exc_info.value.upstream_status == status_code
    assert exc_info.value.public_detail == public_detail
    assert f"status-{status_code}" not in str(exc_info.value)


def test_anthropic_provider_maps_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    provider = AnthropicLLMProvider(
        api_key="test-anthropic-secret",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderTimeoutError, match="timed out"):
        asyncio.run(_collect_chunks(provider))


def test_anthropic_provider_maps_network_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    provider = AnthropicLLMProvider(
        api_key="test-anthropic-secret",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderUnavailableError, match="unreachable"):
        asyncio.run(provider.discover_models())


def test_anthropic_provider_validates_base_url() -> None:
    with pytest.raises(ValueError, match="absolute http"):
        AnthropicLLMProvider(api_key="test-anthropic-secret", base_url="api.anthropic.com")
