from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from app.providers.base import ProviderMessage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from app.providers.openai_compatible import OpenAICompatibleProvider
from app.providers.sse import iter_sse_json


def _provider(handler) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        api_key="test-key",
        base_url="https://api.example.com/custom-root",
        provider_name="openai-compatible",
        timeout=5.0,
        transport=httpx.MockTransport(handler),
    )


async def _collect_events(lines) -> list[tuple[str, Any]]:
    return [(event.event, event.data) async for event in iter_sse_json(lines, provider="openai-compatible")]


def test_iter_sse_json_handles_multiline_unknown_events_and_done() -> None:
    async def lines():
        for line in (
            "event: metrics",
            'data: {"alpha": 1,',
            'data: "beta": 2}',
            "",
            'data: {"message": "ok"}',
            "",
            "data: [DONE]",
            "",
        ):
            yield line

    events = asyncio.run(_collect_events(lines()))

    assert events == [
        ("metrics", {"alpha": 1, "beta": 2}),
        ("message", {"message": "ok"}),
    ]


def test_generate_reply_collects_stream_text_and_final_usage_once() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/custom-root/v1/chat/completions"
        body = json.loads(request.content.decode("utf-8"))
        assert body["stream"] is True
        assert body["stream_options"] == {"include_usage": True}
        assert body["messages"] == [
            {"role": "system", "content": "system prompt"},
            {"role": "assistant", "content": "old reply"},
            {"role": "user", "content": "new prompt"},
        ]
        stream_text = "\n".join(
            [
                'data: {"choices":[{"delta":{"content":"Hel"}}]}',
                "",
                'data: {"choices":[{"delta":{"content":"lo"}}]}',
                "",
                'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
                "",
                "data: [DONE]",
                "",
            ]
        )
        return httpx.Response(200, text=stream_text, headers={"content-type": "text/event-stream"})

    provider = _provider(handler)
    reply = asyncio.run(
        provider.generate_reply(
            model="gpt-test",
            system_prompt="system prompt",
            history=[ProviderMessage(role="assistant", content="old reply")],
            user_message="new prompt",
        )
    )

    assert reply.provider == "openai-compatible"
    assert reply.model == "gpt-test"
    assert reply.raw_text == "Hello"
    assert reply.input_tokens == 11
    assert reply.output_tokens == 7


def test_discover_models_makes_real_request() -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "gpt-4.1-mini"},
                    {"id": "gpt-4.1"},
                ]
            },
        )

    provider = _provider(handler)
    models = asyncio.run(provider.discover_models())

    assert requests == [("GET", "/custom-root/v1/models")]
    assert models == ["gpt-4.1-mini", "gpt-4.1"]


def test_embed_sorts_embeddings_by_index() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/custom-root/v1/embeddings"
        body = json.loads(request.content.decode("utf-8"))
        assert body == {"model": "text-embedding-3-small", "input": ["first", "second"]}
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.3, 0.4]},
                    {"index": 0, "embedding": [0.1, 0.2]},
                ]
            },
        )

    provider = _provider(handler)
    embeddings = asyncio.run(provider.embed(model="text-embedding-3-small", texts=["first", "second"]))

    assert embeddings == [[0.1, 0.2], [0.3, 0.4]]


@pytest.mark.parametrize(
    ("base_url", "message"),
    [
        ("ftp://api.example.com", "valid http"),
        ("https://user:pass@api.example.com", "credentials"),
        ("https://api.example.com/v1?debug=1", "query strings or fragments"),
        ("https://api.example.com/v1#frag", "query strings or fragments"),
    ],
)
def test_base_url_validation(base_url: str, message: str) -> None:
    with pytest.raises(ProviderConfigurationError, match=message):
        OpenAICompatibleProvider(
            api_key="test-key",
            base_url=base_url,
            provider_name="openai-compatible",
            timeout=5.0,
        )


def test_401_maps_to_authentication_error() -> None:
    provider = _provider(lambda request: httpx.Response(401, json={"error": {"message": "bad key"}}))

    with pytest.raises(ProviderAuthenticationError) as exc_info:
        asyncio.run(provider.discover_models())

    assert exc_info.value.provider == "openai-compatible"
    assert exc_info.value.upstream_status == 401
    assert "test-key" not in str(exc_info.value)


def test_429_maps_to_rate_limit_error_with_retry_after() -> None:
    provider = _provider(
        lambda request: httpx.Response(
            429,
            json={"error": {"message": "slow down"}},
            headers={"retry-after": "7"},
        )
    )

    with pytest.raises(ProviderRateLimitError) as exc_info:
        asyncio.run(provider.embed(model="text-embedding-3-small", texts=["hello"]))

    assert exc_info.value.upstream_status == 429
    assert exc_info.value.retry_after == 7.0


def test_redirect_is_not_followed_and_is_rejected_as_protocol_error() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302,
            headers={"location": "https://attacker.test/v1/models"},
        )

    provider = _provider(handler)

    with pytest.raises(ProviderProtocolError) as exc_info:
        asyncio.run(provider.discover_models())

    assert len(requests) == 1
    assert exc_info.value.upstream_status == 302
    assert exc_info.value.public_detail == "Provider request failed with status 302."


def test_timeout_maps_to_timeout_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    provider = _provider(handler)

    with pytest.raises(ProviderTimeoutError) as exc_info:
        asyncio.run(
            provider.generate_reply(
                model="gpt-test",
                system_prompt="system prompt",
                history=[],
                user_message="hello",
            )
        )

    assert exc_info.value.provider == "openai-compatible"
