from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, ProviderMessage, ProviderStreamChunk
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)

DEFAULT_TIMEOUT_SECONDS = 45.0
_CAPABILITY_ACTIONS: dict[str, frozenset[str]] = {
    ProviderCapability.chat_llm.value: frozenset({"generateContent"}),
    ProviderCapability.analysis_llm.value: frozenset({"generateContent"}),
    ProviderCapability.embedding.value: frozenset({"embedContent"}),
}


class GeminiLLMProvider(LLMProvider):
    name = "gemini"

    def __init__(
        self,
        *,
        api_key: str,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        base_url: str | None = None,
        client_factory: Callable[..., Any] | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("Gemini API key cannot be empty")
        if base_url not in (None, ""):
            raise ValueError("Gemini Developer API does not support a custom Base URL")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._client_factory = client_factory

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        async for chunk in self.generate_content_stream(
            model=model,
            system_prompt=system_prompt,
            history=history,
            user_message=user_message,
        ):
            yield chunk

    async def generate_content_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        client = self._build_client()
        _, sdk_types = self._load_sdk_modules()
        contents = self._build_contents(
            sdk_types=sdk_types,
            history=history,
            user_message=user_message,
        )
        config = sdk_types.GenerateContentConfig(system_instruction=system_prompt)

        try:
            stream = await client.aio.models.generate_content_stream(
                model=model,
                contents=contents,
                config=config,
            )
            async for chunk in stream:
                usage = getattr(chunk, "usage_metadata", None)
                yield ProviderStreamChunk(
                    text=getattr(chunk, "text", "") or "",
                    input_tokens=self._usage_value(usage, "prompt_token_count", "promptTokenCount"),
                    output_tokens=self._usage_value(usage, "candidates_token_count", "candidatesTokenCount"),
                )
        except Exception as exc:
            raise self._map_error(exc) from exc
        finally:
            await client.aio.aclose()

    async def discover_models(self, capability: ProviderCapability | str | None = None) -> list[str]:
        client = self._build_client()
        try:
            listed = await client.aio.models.list()
            items = await self._collect_items(listed)
            models: list[str] = []
            for item in items:
                if not self._supports_capability(item=item, capability=capability):
                    continue
                name = self._normalize_model_name(getattr(item, "name", None))
                if name:
                    models.append(name)
            return models
        except Exception as exc:
            raise self._map_error(exc) from exc
        finally:
            await client.aio.aclose()

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        client = self._build_client()
        try:
            response = await client.aio.models.embed_content(model=model, contents=list(texts))
            embeddings = getattr(response, "embeddings", None)
            if embeddings is None and getattr(response, "embedding", None) is not None:
                embeddings = [response.embedding]

            vectors: list[list[float]] = []
            for item in embeddings or []:
                values = getattr(item, "values", None)
                if values is None:
                    continue
                vectors.append([float(value) for value in values])
            return vectors
        except Exception as exc:
            raise self._map_error(exc) from exc
        finally:
            await client.aio.aclose()

    async def embed_texts(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        return await self.embed(model=model, texts=texts)

    def _build_client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory(
                api_key=self._api_key,
                timeout_seconds=self._timeout_seconds,
            )

        sdk_genai, sdk_types = self._load_sdk_modules()
        http_options = sdk_types.HttpOptions(
            api_version="v1",
            client_args={"timeout": self._timeout_seconds},
            async_client_args={"timeout": self._timeout_seconds},
        )
        return sdk_genai.Client(api_key=self._api_key, http_options=http_options)

    @staticmethod
    def _build_contents(*, sdk_types: Any, history: list[ProviderMessage], user_message: str) -> list[Any]:
        contents = [
            sdk_types.Content(
                role="user" if turn.role == "user" else "model",
                parts=[sdk_types.Part.from_text(text=turn.content)],
            )
            for turn in history
        ]
        contents.append(
            sdk_types.Content(
                role="user",
                parts=[sdk_types.Part.from_text(text=user_message)],
            )
        )
        return contents

    @staticmethod
    async def _collect_items(listed: Any) -> list[Any]:
        if hasattr(listed, "__aiter__"):
            return [item async for item in listed]
        return list(listed)

    @staticmethod
    def _load_sdk_modules() -> tuple[Any, Any]:
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise ProviderConfigurationError(
                provider="gemini",
                public_detail="Gemini SDK is not installed on the server.",
            ) from exc
        return genai, types

    @staticmethod
    def _supports_capability(*, item: Any, capability: ProviderCapability | str | None) -> bool:
        if capability is None:
            return True

        capability_value = capability.value if isinstance(capability, ProviderCapability) else str(capability)
        required_actions = _CAPABILITY_ACTIONS.get(capability_value)
        if required_actions is None:
            return True

        supported_actions = getattr(item, "supported_actions", None)
        if supported_actions is None and isinstance(item, dict):
            supported_actions = item.get("supported_actions")
        if not supported_actions:
            return False
        return bool(required_actions.intersection(str(action) for action in supported_actions))

    @staticmethod
    def _normalize_model_name(name: Any) -> str:
        if not isinstance(name, str) or not name:
            return ""
        if name.startswith("models/"):
            return name.split("/", 1)[1]
        return name

    @staticmethod
    def _usage_value(usage: Any, snake_name: str, camel_name: str) -> int:
        if isinstance(usage, dict):
            value = usage.get(snake_name, usage.get(camel_name))
        else:
            value = getattr(usage, snake_name, None)
            if value is None:
                value = getattr(usage, camel_name, None)

        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _provider_error(
        error_cls: type[ProviderError],
        *,
        public_detail: str,
        status_code: int | None,
    ) -> ProviderError:
        return error_cls(
            provider="gemini",
            public_detail=public_detail,
            upstream_status=status_code,
        )

    @staticmethod
    def _status_code_from_error(exc: Exception) -> int | None:
        for attr in ("code", "status_code", "status"):
            value = getattr(exc, attr, None)
            if value is None:
                continue
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
        return None

    @classmethod
    def _map_error(cls, exc: Exception) -> Exception:
        if isinstance(exc, ProviderError):
            return exc

        status_code = cls._status_code_from_error(exc)
        if isinstance(exc, TimeoutError) or status_code in {408, 504}:
            return cls._provider_error(
                ProviderTimeoutError,
                public_detail="Gemini request timed out.",
                status_code=status_code,
            )
        if status_code in {401, 403}:
            return cls._provider_error(
                ProviderAuthenticationError,
                public_detail="Gemini authentication failed.",
                status_code=status_code,
            )
        if status_code == 429:
            return cls._provider_error(
                ProviderRateLimitError,
                public_detail="Gemini rate limit exceeded.",
                status_code=status_code,
            )
        if status_code is not None and status_code >= 500:
            return cls._provider_error(
                ProviderUnavailableError,
                public_detail="Gemini service is temporarily unavailable.",
                status_code=status_code,
            )
        return cls._provider_error(
            ProviderProtocolError,
            public_detail="Gemini request failed.",
            status_code=status_code,
        )
