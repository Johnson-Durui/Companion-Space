from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from google import genai
from google.genai import types

from app.models.domain import ProviderCapability
from app.providers.base import ProviderMessage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.gemini_provider import GeminiLLMProvider


def provider_with_transport(handler, *, timeout=12.5):
    closed = set()

    def create_client(*, api_key, timeout_seconds):
        assert timeout_seconds == timeout
        transport = httpx.MockTransport(handler)
        client = genai.Client(api_key=api_key, http_options=types.HttpOptions(
            api_version="v1beta",
            httpx_async_client=httpx.AsyncClient(transport=transport, timeout=timeout_seconds),
            retry_options=types.HttpRetryOptions(attempts=1),
        ))
        original = client.aio.aclose
        close_marker = object()

        async def recorded_close():
            await original()
            closed.add(close_marker)

        client.aio.aclose = recorded_close
        return client

    return GeminiLLMProvider(api_key="test-gemini-secret", timeout_seconds=timeout, client_factory=create_client), closed


async def consume(provider, history=None):
    return [
        chunk async for chunk in provider.generate_content_stream(
            model="chosen-model",
            system_prompt="stay precise",
            history=history or [],
            user_message="follow up",
        )
    ]


def test_generate_content_stream_maps_roles_usage_and_closes():
    def handler(request):
        assert request.url.path == "/v1beta/models/chosen-model:streamGenerateContent"
        assert request.headers["x-goog-api-key"] == "test-gemini-secret"
        body = json.loads(request.content)
        assert body["systemInstruction"]["parts"] == [{"text": "stay precise"}]
        assert [(item["role"], item["parts"][0]["text"]) for item in body["contents"]] == [
            ("user", "first question"), ("model", "first answer"), ("user", "follow up"),
        ]
        events = [
            {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello"}]}}],
             "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 2}},
            {"candidates": [{"content": {"role": "model", "parts": [{"text": " world"}]}}],
             "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 5}},
        ]
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"},
            text="".join(f"data: {json.dumps(event)}\n\n" for event in events),
        )

    provider, closed = provider_with_transport(handler)
    history = [
        ProviderMessage(role="user", content="first question"),
        ProviderMessage(role="assistant", content="first answer"),
    ]
    chunks = asyncio.run(consume(provider, history))
    assert [chunk.text for chunk in chunks] == ["Hello", " world"]
    assert [chunk.input_tokens for chunk in chunks] == [11, 11]
    assert [chunk.output_tokens for chunk in chunks] == [2, 5]
    assert len(closed) == 1


def test_discover_models_filters_supported_actions():
    def handler(request):
        assert request.url.path == "/v1beta/models"
        return httpx.Response(200, json={
            "models": [
                {"name": "models/dialogue", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/vector", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/unrelated", "supportedGenerationMethods": ["countTokens"]},
            ],
        })

    provider, closed = provider_with_transport(handler)
    assert asyncio.run(provider.discover_models(ProviderCapability.chat_llm)) == ["dialogue"]
    assert asyncio.run(provider.discover_models(ProviderCapability.embedding)) == ["vector"]
    assert len(closed) == 2


def test_embed_returns_embedding_values_and_preserves_alias():
    sent = []

    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/v1beta/models/selected-vector-model:batchEmbedContents"
        requests = json.loads(request.content)["requests"]
        texts = [body["content"]["parts"][0]["text"] for body in requests]
        sent.append(texts)
        return httpx.Response(200, json={"embeddings": [{"values": [len(text), 2.0]} for text in texts]})

    provider, closed = provider_with_transport(handler)
    vectors = asyncio.run(provider.embed(model="selected-vector-model", texts=["a", "bb"]))
    via_alias = asyncio.run(provider.embed_texts(model="selected-vector-model", texts=["ccc"]))
    assert vectors == [[1.0, 2.0], [2.0, 2.0]]
    assert via_alias == [[3.0, 2.0]]
    assert sent == [["a", "bb"], ["ccc"]]
    assert len(closed) == 2


@pytest.mark.parametrize(("status", "expected_type", "attempts"), [
    (401, ProviderAuthenticationError, 1),
    (429, ProviderRateLimitError, 3),
    (504, ProviderTimeoutError, 3),
    (500, ProviderUnavailableError, 3),
    (None, ProviderTimeoutError, 3),
])
def test_stream_errors_are_mapped_and_client_is_closed(status, expected_type, attempts):
    upstream_text = "test-gemini-secret and private conversation text"
    sent = []

    def handler(request):
        sent.append(request)
        if status is None:
            raise httpx.ReadTimeout(upstream_text, request=request)
        return httpx.Response(status, json={"error": {"code": status, "message": upstream_text}})

    provider, closed = provider_with_transport(handler)
    with pytest.raises(expected_type) as error:
        asyncio.run(consume(provider))
    assert error.value.upstream_status == status
    assert upstream_text not in str(error.value)
    assert len(sent) == len(closed) == attempts


def test_rejects_custom_base_url_for_developer_api():
    with pytest.raises(ValueError):
        GeminiLLMProvider(api_key="test-secret", base_url="https://proxy.example.com")
