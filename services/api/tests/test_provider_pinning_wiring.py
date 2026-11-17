from __future__ import annotations

import asyncio

import httpx
import pytest

import app.providers.anthropic_provider as anthropic_module
import app.providers.elevenlabs_provider as elevenlabs_module
import app.providers.local_neural_tts as local_neural_module
import app.providers.openai_compatible as openai_module
from app.providers.anthropic_provider import AnthropicLLMProvider
from app.providers.elevenlabs_provider import ElevenLabsProviderAdapter
from app.providers.local_neural_tts import LocalNeuralTTSProvider
from app.providers.openai_compatible import OpenAICompatibleProvider


def test_openai_and_ollama_use_pinned_transport_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def build_transport(base_url: str, *, provider: str) -> httpx.AsyncBaseTransport:
        calls.append((base_url, provider))
        return httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"data": []})
        )

    monkeypatch.setattr(openai_module, "build_pinned_http_transport", build_transport)
    provider = OpenAICompatibleProvider(
        api_key="ollama",
        base_url="http://127.0.0.1:11434/v1",
        provider_name="ollama",
        timeout=5.0,
    )

    assert asyncio.run(provider.discover_models()) == []
    assert calls == [("http://127.0.0.1:11434/v1", "ollama")]


def test_local_neural_uses_pinned_transport_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def build_transport(base_url: str, *, provider: str) -> httpx.AsyncBaseTransport:
        calls.append((base_url, provider))
        return httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                request=request,
                json={"status": "ready", "model": "qwen3-tts-0.6b-customvoice"},
            )
        )

    monkeypatch.setattr(
        local_neural_module,
        "build_pinned_http_transport",
        build_transport,
    )
    provider = LocalNeuralTTSProvider(base_url="http://127.0.0.1:8001")

    assert asyncio.run(provider.discover_models()) == ["qwen3-tts-0.6b-customvoice"]
    assert calls == [("http://127.0.0.1:8001", "local-neural")]


def test_anthropic_uses_pinned_transport_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def build_transport(base_url: str, *, provider: str) -> httpx.AsyncBaseTransport:
        calls.append((base_url, provider))
        return httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"data": []})
        )

    monkeypatch.setattr(
        anthropic_module,
        "build_pinned_http_transport",
        build_transport,
    )
    provider = AnthropicLLMProvider(api_key="test-anthropic-key")

    assert asyncio.run(provider.discover_models()) == []
    assert calls == [("https://api.anthropic.com", "anthropic")]


def test_elevenlabs_uses_pinned_transport_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter_calls: list[tuple[str, str]] = []

    def build_adapter_transport(
        base_url: str,
        *,
        provider: str,
    ) -> httpx.AsyncBaseTransport:
        adapter_calls.append((base_url, provider))
        return httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"models": []})
        )

    monkeypatch.setattr(
        elevenlabs_module,
        "build_pinned_http_transport",
        build_adapter_transport,
    )

    adapter = ElevenLabsProviderAdapter(api_key="test-elevenlabs-key")
    assert asyncio.run(adapter.discover_models()) == []

    assert adapter_calls == [("https://api.elevenlabs.io/v1", "elevenlabs")]


def test_explicit_transports_bypass_pinned_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_if_called(*args, **kwargs):
        _ = args, kwargs
        raise AssertionError("Explicit transports must bypass DNS resolution")

    monkeypatch.setattr(openai_module, "build_pinned_http_transport", fail_if_called)
    monkeypatch.setattr(anthropic_module, "build_pinned_http_transport", fail_if_called)
    monkeypatch.setattr(elevenlabs_module, "build_pinned_http_transport", fail_if_called)
    monkeypatch.setattr(local_neural_module, "build_pinned_http_transport", fail_if_called)

    openai = OpenAICompatibleProvider(
        api_key="test-key",
        base_url="https://api.example.com/v1",
        provider_name="openai-compatible",
        timeout=5.0,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"data": []})
        ),
    )
    anthropic = AnthropicLLMProvider(
        api_key="test-key",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"data": []})
        ),
    )
    elevenlabs = ElevenLabsProviderAdapter(
        api_key="test-key",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, request=request, json={"models": []})
        ),
    )
    local_neural = LocalNeuralTTSProvider(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                request=request,
                json={"status": "ready", "model": "qwen3-tts-0.6b-customvoice"},
            )
        )
    )

    assert asyncio.run(openai.discover_models()) == []
    assert asyncio.run(anthropic.discover_models()) == []
    assert asyncio.run(elevenlabs.discover_models()) == []
    assert asyncio.run(local_neural.discover_models()) == ["qwen3-tts-0.6b-customvoice"]
