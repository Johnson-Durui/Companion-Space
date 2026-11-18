from __future__ import annotations

import asyncio
from abc import ABC
from collections.abc import AsyncIterator, Sequence
from contextlib import aclosing
from typing import Literal, NotRequired, TypedDict

from pydantic import BaseModel, Field, JsonValue

from app.models.domain import ProviderCapability
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class ContentPart(TypedDict):
    type: Literal["text", "image"]
    text: NotRequired[str]
    image_b64: NotRequired[str]
    mime: NotRequired[str]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str | list[ContentPart] = Field(min_length=1)


ProviderMessage = Message


class LLMRequest(BaseModel):
    model: str = Field(min_length=1)
    system: str
    messages: list[Message] = Field(min_length=1)
    max_tokens: int = Field(default=2048, ge=1)
    temperature: float | None = None
    stop: list[str] | None = None
    extra_body: dict[str, JsonValue] = Field(default_factory=dict)
    timeout_s: float = Field(default=60, gt=0)
    json_object: bool = False


class Usage(BaseModel):
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class StreamChunk(BaseModel):
    text: str = ""
    reasoning: str = ""
    finish_reason: str | None = None
    usage: Usage | None = None


class ProviderStreamChunk(Usage):
    text: str = ""


class ProviderReply(BaseModel):
    provider: str
    model: str
    raw_text: str
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


ProviderResult = ProviderReply


class ProviderAdapter(ABC):
    name: str

    async def list_models(self) -> list[str]:
        return await self.discover_models()

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail="This connection does not support model discovery.",
        )

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail="This connection does not support embeddings.",
        )

    async def transcribe_pcm16(
        self, model: str, pcm16: bytes, sample_rate_hz: int = 16000,
    ) -> str:
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail="This connection does not support speech-to-text.",
        )

    async def synthesize_speech_stream(
        self, model: str, text: str, voice_id: str, speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        raise ProviderConfigurationError(
            provider=self.name,
            public_detail="This connection does not support speech synthesis.",
        )
        yield b""


class LLMProvider(ProviderAdapter):
    def _stream_once(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        raise NotImplementedError

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        for attempt in range(3):
            started = False
            try:
                async with aclosing(self._stream_once(request)) as chunks:
                    async for chunk in chunks:
                        started = started or bool(chunk.text or chunk.reasoning or chunk.finish_reason)
                        yield chunk
                return
            except (ProviderRateLimitError, ProviderTimeoutError, ProviderUnavailableError) as error:
                if started or attempt == 2:
                    raise
                await asyncio.sleep(min(8, max(0.2 * 2**attempt, error.retry_after or 0)))

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        request = LLMRequest(
            model=model, system=system_prompt,
            messages=[*history, Message(role="user", content=user_message)],
            timeout_s=getattr(self, "timeout", 60),
        )
        async with aclosing(self.stream(request)) as chunks:
            async for chunk in chunks:
                if chunk.text or chunk.usage:
                    yield ProviderStreamChunk(
                        text=chunk.text,
                        **(chunk.usage.model_dump() if chunk.usage else {}),
                    )

    async def generate_reply(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> ProviderReply:
        parts: list[str] = []
        input_tokens = output_tokens = 0
        async for chunk in self.generate_reply_stream(
            model=model, system_prompt=system_prompt,
            history=history, user_message=user_message,
        ):
            parts.append(chunk.text)
            if chunk.input_tokens is not None:
                input_tokens = chunk.input_tokens
            if chunk.output_tokens is not None:
                output_tokens = chunk.output_tokens
        return ProviderReply(
            provider=self.name, model=model, raw_text="".join(parts),
            input_tokens=input_tokens, output_tokens=output_tokens,
        )


async def iter_pcm16_audio_chunks(
    chunks: AsyncIterator[bytes], *, provider: str,
) -> AsyncIterator[bytes]:
    pending = b""
    yielded = False
    async for chunk in chunks:
        if not chunk:
            continue
        data = pending + chunk
        even_length = len(data) - (len(data) % 2)
        if even_length:
            yielded = True
            yield data[:even_length]
        pending = data[even_length:]
    if pending or not yielded:
        raise ProviderProtocolError(
            provider=provider, public_detail="Provider returned an invalid audio response.",
        )
