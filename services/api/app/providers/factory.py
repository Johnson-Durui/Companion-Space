from __future__ import annotations

from app.models.domain import ProviderConnection
from app.providers.anthropic_provider import AnthropicLLMProvider
from app.providers.base import LLMProvider, ProviderAdapter
from app.providers.elevenlabs_provider import ElevenLabsProviderAdapter
from app.providers.errors import ProviderConfigurationError
from app.providers.gemini_provider import GeminiLLMProvider
from app.providers.local_neural_tts import (
    LOCAL_NEURAL_TTS_DEFAULT_BASE_URL,
    LocalNeuralTTSProvider,
)
from app.providers.mock_provider import MockLLMProvider
from app.providers.openai_compatible import OpenAICompatibleProvider


OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"


def build_provider_adapter(
    connection: ProviderConnection,
    *,
    api_key: str | None,
) -> ProviderAdapter:
    provider = connection.provider
    if provider == "mock":
        return MockLLMProvider()
    if provider == "local-neural":
        return LocalNeuralTTSProvider(
            base_url=connection.base_url or LOCAL_NEURAL_TTS_DEFAULT_BASE_URL,
        )
    if provider == "ollama":
        return OpenAICompatibleProvider(
            api_key=api_key or "ollama",
            base_url=connection.base_url or OLLAMA_DEFAULT_BASE_URL,
            provider_name="ollama",
            timeout=45.0,
        )
    if not api_key:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail=f"{connection.label} has no API Key in the unlocked vault.",
        )
    if provider == "openai-compatible":
        return OpenAICompatibleProvider(
            api_key=api_key,
            base_url=connection.base_url or OPENAI_DEFAULT_BASE_URL,
            provider_name=provider,
            timeout=45.0,
        )
    if provider == "anthropic":
        return AnthropicLLMProvider(api_key=api_key)
    if provider == "gemini":
        return GeminiLLMProvider(api_key=api_key)
    if provider == "elevenlabs":
        return ElevenLabsProviderAdapter(api_key=api_key)
    raise ProviderConfigurationError(
        provider=provider,
        public_detail=f"Unsupported provider: {provider}.",
    )


def build_llm_provider(
    connection: ProviderConnection,
    *,
    api_key: str | None,
) -> LLMProvider:
    adapter = build_provider_adapter(connection, api_key=api_key)
    if not isinstance(adapter, LLMProvider):
        raise ProviderConfigurationError(
            provider=connection.provider,
            public_detail=f"{connection.label} does not provide chat.",
        )
    return adapter
