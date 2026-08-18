from datetime import datetime, timezone

import pytest

from app.models.domain import ProviderConnection
from app.providers.anthropic_provider import AnthropicLLMProvider
from app.providers.elevenlabs_provider import ElevenLabsProviderAdapter
from app.providers.errors import ProviderConfigurationError
from app.providers.factory import (
    OLLAMA_DEFAULT_BASE_URL,
    build_llm_provider,
    build_provider_adapter,
)
from app.providers.gemini_provider import GeminiLLMProvider
from app.providers.mock_provider import MockLLMProvider
from app.providers.openai_compatible import OpenAICompatibleProvider


def _connection(
    provider: str,
    *,
    base_url: str | None = None,
) -> ProviderConnection:
    now = datetime.now(timezone.utc)
    return ProviderConnection(
        id=f"connection-{provider}",
        provider=provider,
        label=f"{provider} test",
        base_url=base_url,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.parametrize(
    ("provider", "expected_type"),
    [
        ("mock", MockLLMProvider),
        ("openai-compatible", OpenAICompatibleProvider),
        ("anthropic", AnthropicLLMProvider),
        ("gemini", GeminiLLMProvider),
        ("elevenlabs", ElevenLabsProviderAdapter),
    ],
)
def test_provider_factory_builds_only_the_requested_adapter(
    provider: str,
    expected_type: type,
) -> None:
    adapter = build_provider_adapter(
        _connection(provider),
        api_key=None if provider == "mock" else "test-secret",
    )

    assert isinstance(adapter, expected_type)


def test_ollama_uses_openai_compatibility_without_persisted_dummy_key() -> None:
    adapter = build_provider_adapter(
        _connection("ollama"),
        api_key=None,
    )

    assert isinstance(adapter, OpenAICompatibleProvider)
    assert adapter.name == "ollama"
    assert adapter.base_url == OLLAMA_DEFAULT_BASE_URL


def test_provider_factory_never_falls_back_for_unknown_provider() -> None:
    with pytest.raises(
        ProviderConfigurationError,
        match="Unsupported provider",
    ):
        build_provider_adapter(
            _connection("unknown"),
            api_key="test-secret",
        )


def test_provider_factory_requires_key_for_remote_provider() -> None:
    with pytest.raises(
        ProviderConfigurationError,
        match="no API Key",
    ):
        build_provider_adapter(
            _connection("anthropic"),
            api_key=None,
        )


def test_non_chat_adapter_cannot_be_used_as_llm() -> None:
    with pytest.raises(
        ProviderConfigurationError,
        match="does not provide chat",
    ):
        build_llm_provider(
            _connection("elevenlabs"),
            api_key="test-secret",
        )
