from __future__ import annotations

import asyncio
import json
from contextlib import aclosing

import httpx
import pytest

from app.providers.base import LLMRequest, Message
from app.providers.errors import ProviderAuthenticationError, ProviderUnavailableError
from app.providers.openai_compatible import OpenAICompatibleProvider


class Events(httpx.AsyncByteStream):
    def __init__(self, events, *, interrupt=False):
        self.events = events
        self.interrupt = interrupt
        self.closed = False

    async def __aiter__(self):
        for event in self.events:
            wire = f"data: {json.dumps(event)}\n\n".encode()
            yield wire[:17]
            yield wire[17:]
        if self.interrupt:
            raise httpx.ReadError("test stream terminated")

    async def aclose(self):
        self.closed = True


def request():
    return LLMRequest(
        model="selected",
        system="Inspect the input.",
        messages=[Message(role="user", content=[
            {"type": "image", "image_b64": "AA==", "mime": "image/png"},
            {"type": "text", "text": "Read the image"},
        ])],
        extra_body={"thinking": {"type": "disabled"}},
        max_tokens=333,
        temperature=0.2,
    )


@pytest.mark.parametrize("path", ["/api/paas/v4", "/api/v3"])
def test_compatibility_stream_preserves_images_options_and_native_path(path):
    req = request()
    bodies = []
    events = Events([
        {"choices": [{"delta": {"content": None, "reasoning_content": "hidden"}}]},
        {"choices": [{"delta": {"content": "<th"}}]},
        {"choices": [{"delta": {"content": "ink>also hidden</thi"}}]},
        {"choices": [{"delta": {"content": "nk>Visible"}}]},
        {"choices": [{"delta": {}, "finish_reason": "length"}], "usage": {"prompt_tokens": 4, "completion_tokens": 5}},
    ])

    def handle(outbound):
        assert outbound.url.path == f"{path}/chat/completions"
        bodies.append(json.loads(outbound.content))
        return httpx.Response(200, stream=events)

    provider = OpenAICompatibleProvider(
        api_key="offline-test-token", provider_name="vendor",
        base_url=f"http://127.0.0.1:1234{path}/", timeout=3, transport=httpx.MockTransport(handle),
    )

    async def consume():
        return [chunk async for chunk in provider.stream(req)]

    chunks = asyncio.run(consume())
    assert events.closed
    assert "".join(chunk.text for chunk in chunks) == "Visible"
    assert "".join(chunk.reasoning for chunk in chunks) == "hiddenalso hidden"
    assert chunks[-1].finish_reason == "length"
    assert chunks[-1].usage.input_tokens == 4
    assert bodies[0]["thinking"] == req.extra_body["thinking"]
    assert bodies[0]["max_tokens"] == req.max_tokens
    assert bodies[0]["temperature"] == req.temperature
    assert bodies[0]["messages"][1]["content"][0]["image_url"]["url"] == "data:image/png;base64,AA=="


@pytest.mark.parametrize("statuses, attempts, error", [
    ([503, 429, 200], 3, None),
    ([401, 200], 1, ProviderAuthenticationError),
    ([200, 200], 1, ProviderUnavailableError),
])
def test_retries_only_before_visible_output(statuses, attempts, error):
    sent = []
    streams = []
    should_break = statuses[0] == 200

    def handle(_):
        status = statuses[len(sent)]
        sent.append(status)
        if status != 200:
            return httpx.Response(status)
        events = Events([{"choices": [{"delta": {"content": "hello"}}]}], interrupt=should_break)
        streams.append(events)
        return httpx.Response(status, stream=events)

    provider = OpenAICompatibleProvider(
        api_key="offline-test-token", provider_name="vendor",
        base_url="http://127.0.0.1:1234", timeout=3, transport=httpx.MockTransport(handle),
    )

    async def consume():
        async with aclosing(provider.stream(request())) as stream:
            return "".join([chunk.text async for chunk in stream])

    if error is not None:
        with pytest.raises(error):
            asyncio.run(consume())
    else:
        assert asyncio.run(consume()) == "hello"
    assert len(sent) == attempts
    assert all(stream.closed for stream in streams)


def test_cancelling_stream_closes_http_connection():
    entered = asyncio.Event()
    never = asyncio.Event()
    closed = asyncio.Event()

    class Blocking(httpx.AsyncByteStream):
        async def __aiter__(self):
            entered.set()
            await never.wait()
            yield b""

        async def aclose(self):
            closed.set()

    provider = OpenAICompatibleProvider(
        api_key="offline-test-token", provider_name="vendor",
        base_url="http://127.0.0.1:1234", timeout=3,
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Blocking())),
    )

    async def exercise():
        stream = provider.stream(request())
        task = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()

    asyncio.run(exercise())



def test_anthropic_native_payload_and_length_status():
    from app.providers.anthropic_provider import AnthropicLLMProvider

    seen = []
    events = Events([
        {"type": "message_start", "message": {"usage": {"input_tokens": 11}}},
        {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "private"}},
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "answer"}},
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 6}},
        {"type": "message_stop"},
    ])

    def handle(outbound):
        assert outbound.url.path == "/anthropic/v1/messages"
        seen.append(json.loads(outbound.content))
        return httpx.Response(200, stream=events)

    provider = AnthropicLLMProvider(
        api_key="offline-test-token", base_url="http://127.0.0.1:1234/anthropic/v1",
        transport=httpx.MockTransport(handle),
    )

    async def consume():
        return [chunk async for chunk in provider.stream(request())]

    chunks = asyncio.run(consume())
    body = seen[0]
    assert body["messages"][0]["content"][0]["source"] == {
        "type": "base64", "media_type": "image/png", "data": "AA==",
    }
    assert body["max_tokens"] == request().max_tokens
    assert body["temperature"] == request().temperature
    assert "".join(chunk.text for chunk in chunks) == "answer"
    assert "".join(chunk.reasoning for chunk in chunks) == "private"
    assert chunks[-1].finish_reason == "length"
    assert events.closed


def test_gemini_native_http_payload_and_reasoning_parts():
    from google import genai
    from google.genai import types

    from app.providers.gemini_provider import GeminiLLMProvider

    seen = []
    events = Events([
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "private", "thought": True}]}}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "answer"}]}, "finishReason": "MAX_TOKENS"}],
         "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 3, "thoughtsTokenCount": 9}},
    ])

    def handle(outbound):
        assert outbound.url.path == "/v1beta/models/selected:streamGenerateContent"
        seen.append(json.loads(outbound.content))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=events)

    def client_factory(*, api_key, timeout_seconds):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle), timeout=timeout_seconds)
        return genai.Client(api_key=api_key, http_options=types.HttpOptions(
            api_version="v1beta", httpx_async_client=client,
        ))

    provider = GeminiLLMProvider(api_key="offline-test-token", client_factory=client_factory)
    req = request().model_copy(update={
        "extra_body": {"generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}},
    })

    async def consume():
        return [chunk async for chunk in provider.stream(req)]

    chunks = asyncio.run(consume())
    body = seen[0]
    assert body["contents"][0]["parts"][0]["inlineData"] == {
        "mimeType": "image/png", "data": "AA==",
    }
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}
    assert body["generationConfig"]["maxOutputTokens"] == req.max_tokens
    assert body["generationConfig"]["temperature"] == req.temperature
    assert "".join(chunk.text for chunk in chunks) == "answer"
    assert "".join(chunk.reasoning for chunk in chunks) == "private"
    assert chunks[-1].finish_reason == "length"
    assert chunks[-1].usage.output_tokens == 12
    assert events.closed


@pytest.mark.parametrize("url", [
    "ftp://localhost/provider",
    "http://user:password@127.0.0.1/provider",
    "https://vendor.invalid/api?key=x",
    "https://bad.example:wrong-port",
    "https://localhost/provider#secret",
])
def test_base_url_policy_rejects_unsafe_shape_without_echoing_url(url):
    from app.providers.errors import ProviderConfigurationError
    from app.providers.url_policy import validate

    with pytest.raises(ProviderConfigurationError) as error:
        validate(url)
    assert url not in str(error.value)
