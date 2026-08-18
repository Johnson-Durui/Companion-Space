from __future__ import annotations

import asyncio
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.models.domain import ProviderCapability
from app.providers.base import ProviderMessage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.gemini_provider import GeminiLLMProvider


class FakeAsyncIterator:
    def __init__(self, items: list[Any]) -> None:
        self._items = list(items)
        self._index = 0

    def __aiter__(self) -> FakeAsyncIterator:
        return self

    async def __anext__(self) -> Any:
        if self._index >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._index]
        self._index += 1
        return item


class FakePart:
    def __init__(self, *, text: str) -> None:
        self.text = text

    @classmethod
    def from_text(cls, *, text: str) -> FakePart:
        return cls(text=text)


class FakeContent:
    def __init__(self, *, role: str, parts: list[FakePart]) -> None:
        self.role = role
        self.parts = parts


class FakeGenerateContentConfig:
    def __init__(self, *, system_instruction: str) -> None:
        self.system_instruction = system_instruction


class FakeHttpOptions:
    def __init__(
        self,
        *,
        api_version: str,
        client_args: dict[str, Any] | None = None,
        async_client_args: dict[str, Any] | None = None,
    ) -> None:
        self.api_version = api_version
        self.client_args = client_args or {}
        self.async_client_args = async_client_args or {}


class FakeAPIError(Exception):
    def __init__(self, code: int, message: str = "sdk error") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class FakeAioNamespace:
    def __init__(self, models: Any) -> None:
        self.models = models
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class FakeClient:
    def __init__(self, *, aio_models: Any) -> None:
        self.aio = FakeAioNamespace(aio_models)


class FakeModelsAPI:
    def __init__(
        self,
        *,
        stream_chunks: list[Any] | None = None,
        models: list[Any] | None = None,
        embeddings: list[list[float]] | None = None,
        stream_error: Exception | None = None,
        list_error: Exception | None = None,
        embed_error: Exception | None = None,
    ) -> None:
        self.stream_chunks = stream_chunks or []
        self.models = models or []
        self.embeddings = embeddings or []
        self.stream_error = stream_error
        self.list_error = list_error
        self.embed_error = embed_error
        self.stream_calls: list[dict[str, Any]] = []
        self.list_calls = 0
        self.embed_calls: list[dict[str, Any]] = []

    async def generate_content_stream(self, *, model: str, contents: list[Any], config: Any) -> FakeAsyncIterator:
        self.stream_calls.append({"model": model, "contents": contents, "config": config})
        if self.stream_error is not None:
            raise self.stream_error
        return FakeAsyncIterator(self.stream_chunks)

    async def list(self) -> FakeAsyncIterator:
        self.list_calls += 1
        if self.list_error is not None:
            raise self.list_error
        return FakeAsyncIterator(self.models)

    async def embed_content(self, *, model: str, contents: list[str]) -> Any:
        self.embed_calls.append({"model": model, "contents": contents})
        if self.embed_error is not None:
            raise self.embed_error
        return SimpleNamespace(embeddings=[SimpleNamespace(values=item) for item in self.embeddings])


def _install_fake_google_genai(
    monkeypatch: pytest.MonkeyPatch,
    *,
    client_builder: Any,
) -> tuple[list[dict[str, Any]], dict[str, FakeClient]]:
    created_clients: list[dict[str, Any]] = []
    client_ref: dict[str, FakeClient] = {}

    class RecordingClient:
        def __init__(self, *, api_key: str, http_options: FakeHttpOptions) -> None:
            created_clients.append({"api_key": api_key, "http_options": http_options})
            client = client_builder()
            client_ref["client"] = client
            self.aio = client.aio

    google_module = ModuleType("google")
    google_module.__path__ = []
    genai_module = ModuleType("google.genai")
    genai_module.__path__ = []
    types_module = ModuleType("google.genai.types")
    errors_module = ModuleType("google.genai.errors")

    genai_module.Client = RecordingClient
    genai_module.types = types_module
    genai_module.errors = errors_module
    types_module.Content = FakeContent
    types_module.Part = FakePart
    types_module.GenerateContentConfig = FakeGenerateContentConfig
    types_module.HttpOptions = FakeHttpOptions
    errors_module.APIError = FakeAPIError
    google_module.genai = genai_module

    monkeypatch.setitem(sys.modules, "google", google_module)
    monkeypatch.setitem(sys.modules, "google.genai", genai_module)
    monkeypatch.setitem(sys.modules, "google.genai.types", types_module)
    monkeypatch.setitem(sys.modules, "google.genai.errors", errors_module)
    return created_clients, client_ref


def _chunk_text(chunk: Any) -> str:
    return getattr(chunk, "text", getattr(chunk, "text_delta", ""))


def _error_detail(error: Exception) -> str:
    return getattr(error, "public_detail", str(error))


async def _collect_chunks(stream: Any) -> list[Any]:
    return [chunk async for chunk in stream]


def test_generate_content_stream_maps_roles_usage_and_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    models_api = FakeModelsAPI(
        stream_chunks=[
            SimpleNamespace(
                text="Hello",
                usage_metadata=SimpleNamespace(prompt_token_count=11, candidates_token_count=2),
            ),
            SimpleNamespace(
                text=" world",
                usage_metadata={"promptTokenCount": 11, "candidatesTokenCount": 5},
            ),
        ]
    )
    created_clients, client_ref = _install_fake_google_genai(
        monkeypatch,
        client_builder=lambda: FakeClient(aio_models=models_api),
    )
    provider = GeminiLLMProvider(api_key="secret-key", timeout_seconds=12.5)

    chunks = asyncio.run(
        _collect_chunks(
            provider.generate_content_stream(
                model="gemini-2.5-flash",
                system_prompt="stay precise",
                history=[
                    ProviderMessage(role="user", content="first question"),
                    ProviderMessage(role="assistant", content="first answer"),
                ],
                user_message="follow up",
            )
        )
    )

    assert [_chunk_text(chunk) for chunk in chunks] == ["Hello", " world"]
    assert [chunk.input_tokens for chunk in chunks] == [11, 11]
    assert [chunk.output_tokens for chunk in chunks] == [2, 5]

    stream_call = models_api.stream_calls[0]
    assert stream_call["model"] == "gemini-2.5-flash"
    assert [content.role for content in stream_call["contents"]] == ["user", "model", "user"]
    assert [content.parts[0].text for content in stream_call["contents"]] == [
        "first question",
        "first answer",
        "follow up",
    ]
    assert stream_call["config"].system_instruction == "stay precise"

    assert created_clients == [
        {
            "api_key": "secret-key",
            "http_options": created_clients[0]["http_options"],
        }
    ]
    assert created_clients[0]["http_options"].api_version == "v1"
    assert created_clients[0]["http_options"].client_args == {"timeout": 12.5}
    assert created_clients[0]["http_options"].async_client_args == {"timeout": 12.5}
    assert client_ref["client"].aio.closed is True


def test_discover_models_filters_supported_actions() -> None:
    models_api = FakeModelsAPI(
        models=[
            SimpleNamespace(
                name="models/gemini-2.5-flash",
                supported_actions=["generateContent", "embedContent"],
            ),
            SimpleNamespace(
                name="models/gemini-embedding-001",
                supported_actions=["embedContent"],
            ),
            SimpleNamespace(
                name="models/ignored",
                supported_actions=["countTokens"],
            ),
        ]
    )
    provider = GeminiLLMProvider(api_key="secret", client_factory=lambda **_: FakeClient(aio_models=models_api))

    chat_models = asyncio.run(provider.discover_models(ProviderCapability.chat_llm))
    embedding_models = asyncio.run(provider.discover_models(ProviderCapability.embedding))

    assert chat_models == ["gemini-2.5-flash"]
    assert embedding_models == ["gemini-2.5-flash", "gemini-embedding-001"]
    assert models_api.list_calls == 2


def test_embed_returns_embedding_values_and_preserves_alias() -> None:
    models_api = FakeModelsAPI(embeddings=[[0.1, 0.2], [0.3, 0.4]])
    provider = GeminiLLMProvider(api_key="secret", client_factory=lambda **_: FakeClient(aio_models=models_api))

    vectors = asyncio.run(provider.embed(model="gemini-embedding-001", texts=["a", "b"]))
    alias_vectors = asyncio.run(provider.embed_texts(model="gemini-embedding-001", texts=["c"]))

    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert alias_vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert models_api.embed_calls == [
        {"model": "gemini-embedding-001", "contents": ["a", "b"]},
        {"model": "gemini-embedding-001", "contents": ["c"]},
    ]


@pytest.mark.parametrize(
    ("error", "expected_message", "expected_type"),
    [
        (FakeAPIError(401), "Gemini authentication failed.", ProviderAuthenticationError),
        (FakeAPIError(429), "Gemini rate limit exceeded.", ProviderRateLimitError),
        (FakeAPIError(504), "Gemini request timed out.", ProviderTimeoutError),
        (FakeAPIError(500), "Gemini service is temporarily unavailable.", ProviderUnavailableError),
        (TimeoutError(), "Gemini request timed out.", ProviderTimeoutError),
    ],
)
def test_stream_errors_are_mapped_and_client_is_closed(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    expected_message: str,
    expected_type: type[Exception],
) -> None:
    client = FakeClient(aio_models=FakeModelsAPI(stream_error=error))
    _install_fake_google_genai(monkeypatch, client_builder=lambda: client)
    provider = GeminiLLMProvider(api_key="secret-key")

    with pytest.raises(Exception) as exc_info:
        asyncio.run(
            _collect_chunks(
                provider.generate_content_stream(
                    model="gemini-2.5-flash",
                    system_prompt="do not leak secret-key",
                    history=[],
                    user_message="contains secret-key",
                )
            )
        )

    assert _error_detail(exc_info.value) == expected_message
    assert isinstance(exc_info.value, expected_type)
    assert "secret-key" not in str(exc_info.value)
    assert client.aio.closed is True


def test_rejects_custom_base_url_for_developer_api() -> None:
    with pytest.raises(ValueError, match="custom Base URL"):
        GeminiLLMProvider(api_key="secret", base_url="https://proxy.example.com")
