from __future__ import annotations

from app.models.domain import ProviderConnection
from app.providers.anthropic_provider import DEFAULT_ANTHROPIC_BASE_URL, AnthropicLLMProvider
from app.providers.base import LLMProvider, ProviderAdapter
from app.providers.elevenlabs_provider import ElevenLabsProviderAdapter
from app.providers.errors import ProviderConfigurationError
from app.providers.gemini_provider import GeminiLLMProvider
from app.providers.local_neural_tts import LOCAL_NEURAL_TTS_DEFAULT_BASE_URL, LocalNeuralTTSProvider
from app.providers.openai_compatible import OpenAICompatibleProvider
from app.providers.url_policy import is_local_endpoint

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1"
GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1"


def build_provider_adapter(
    connection: ProviderConnection, *, api_key: str | None,
) -> ProviderAdapter:
    provider = connection.provider
    if provider == "local-neural":
        return LocalNeuralTTSProvider(base_url=connection.base_url or LOCAL_NEURAL_TTS_DEFAULT_BASE_URL)
    roots = {
        "openai-compatible": OPENAI_DEFAULT_BASE_URL,
        "ollama": OLLAMA_DEFAULT_BASE_URL,
        "lm-studio": LM_STUDIO_DEFAULT_BASE_URL,
    }
    if provider in roots:
        if provider == "openai-compatible" and not api_key and not is_local_endpoint(connection.base_url):
            raise _missing_key(provider)
        return OpenAICompatibleProvider(
            api_key=api_key, base_url=connection.base_url or roots[provider],
            provider_name=provider, timeout=45,
        )
    if provider in {"anthropic", "gemini", "elevenlabs"} and not api_key:
        raise _missing_key(provider)
    if provider == "anthropic":
        return AnthropicLLMProvider(api_key=api_key, base_url=connection.base_url or DEFAULT_ANTHROPIC_BASE_URL)
    if provider == "gemini":
        return GeminiLLMProvider(api_key=api_key)
    if provider == "elevenlabs":
        return ElevenLabsProviderAdapter(api_key=api_key, base_url=connection.base_url or ELEVENLABS_DEFAULT_BASE_URL)
    raise ProviderConfigurationError(provider="connection", public_detail="Select a supported provider.")


def _missing_key(provider: str) -> ProviderConfigurationError:
    return ProviderConfigurationError(
        provider=provider, public_detail="Store a valid API key for this connection in Settings.",
    )


def build_llm_provider(connection: ProviderConnection, *, api_key: str | None) -> LLMProvider:
    adapter = build_provider_adapter(connection, api_key=api_key)
    if not isinstance(adapter, LLMProvider):
        raise ProviderConfigurationError(
            provider=connection.provider, public_detail="This connection does not support model conversations.",
        )
    return adapter
