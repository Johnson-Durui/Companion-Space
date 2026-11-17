from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from app.providers.base import LLMProvider, LLMRequest, StreamChunk


@dataclass
class Script:
    chunks: tuple[StreamChunk | Exception, ...]
    contains: tuple[str, ...] = ()
    delay: float = 0


class ScriptedProvider(LLMProvider):
    name = "test-provider"

    def __init__(self, *scripts: Script) -> None:
        self.scripts = list(scripts)
        self.calls: list[LLMRequest] = []
        self.embeds: list[list[str]] = []
        self.transcriptions: list[bytes] = []
        self.utterances: list[tuple[str, str]] = []

    async def _stream_once(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        self.calls.append(request)
        if not self.scripts:
            raise AssertionError("The test must provide a script for each call.")
        scripted = self.scripts.pop(0)
        message = " ".join(
            item.content if isinstance(item.content, str)
            else " ".join(part.get("text", "") for part in item.content)
            for item in request.messages
        )
        for text in scripted.contains:
            assert text in message
        if scripted.delay:
            await asyncio.sleep(scripted.delay)
        for chunk in scripted.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk

    async def embed(self, *, model, texts):
        batch = list(texts)
        self.embeds.append(batch)
        return [[float(len(text)), 1.0] for text in batch]

    async def transcribe_pcm16(self, model: str, pcm16: bytes, sample_rate_hz: int = 16000) -> str:
        self.transcriptions.append(pcm16)
        return ""

    async def synthesize_speech_stream(self, model, text, voice_id, speed=1.0, sample_rate_hz=24000):
        self.utterances.append((text, voice_id))
        yield b"\x00\x00"
