from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator, Sequence

from pydantic import BaseModel, Field

from app.models.domain import ProviderCapability
from app.providers.errors import ProviderConfigurationError, ProviderProtocolError


class ProviderMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1)


class ProviderStreamChunk(BaseModel):
    text: str = ""
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class ProviderReply(BaseModel):
    provider: str
    model: str
    raw_text: str
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


# Temporary compatibility alias until remaining imports are migrated.
ProviderResult = ProviderReply


class ProviderAdapter(ABC):
    name: str

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        _ = capability
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail=f"{self.name} does not support model discovery.",
        )

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        _ = model
        _ = texts
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail=f"{self.name} does not support embeddings.",
        )

    async def transcribe_pcm16(
        self,
        model: str,
        pcm16: bytes,
        sample_rate_hz: int = 16000,
    ) -> str:
        _ = model
        _ = pcm16
        _ = sample_rate_hz
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail=f"{self.name} does not support speech-to-text.",
        )

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        _ = model
        _ = text
        _ = voice_id
        _ = speed
        _ = sample_rate_hz
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail=f"{self.name} does not support speech synthesis.",
        )
        yield b""


class LLMProvider(ProviderAdapter, ABC):
    @abstractmethod
    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        raise NotImplementedError

    async def generate_reply(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> ProviderReply:
        raw_text_parts: list[str] = []
        input_tokens = 0
        output_tokens = 0

        async for chunk in self.generate_reply_stream(
            model=model,
            system_prompt=system_prompt,
            history=history,
            user_message=user_message,
        ):
            if chunk.text:
                raw_text_parts.append(chunk.text)
            if chunk.input_tokens is not None:
                input_tokens = chunk.input_tokens
            if chunk.output_tokens is not None:
                output_tokens = chunk.output_tokens

        return ProviderReply(
            provider=self.name,
            model=model,
            raw_text="".join(raw_text_parts),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )


async def iter_pcm16_audio_chunks(
    chunks: AsyncIterator[bytes],
    *,
    provider: str,
) -> AsyncIterator[bytes]:
    pending = b""
    yielded = False

    async for chunk in chunks:
        if not chunk:
            continue
        data = pending + chunk
        even_length = len(data) - (len(data) % 2)
        if even_length:
            emitted = data[:even_length]
            if emitted:
                yielded = True
                yield emitted
        pending = data[even_length:]

    if pending or not yielded:
        raise ProviderProtocolError(
            provider=provider,
            public_detail="Provider returned an invalid audio response.",
        )
