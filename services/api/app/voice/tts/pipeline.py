from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, field, replace
from typing import Literal

AudioFormat = Literal["pcm_s16le", "mp3"]
_SENTENCE = re.compile(r".*?[.!?。！？；;\n]+|.+$", re.DOTALL)
_CLAUSE = re.compile(r".*?[,，]|.+$", re.DOTALL)
_END = object()


@dataclass(frozen=True)
class VoiceSpec:
    engine: str
    voice_id: str
    model: str = ""
    rate: float = 1.0
    pitch: int = 0
    options: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SpeechChunk:
    kind: Literal["audio", "fallback"]
    engine: str
    format: AudioFormat | None = None
    data: bytes | None = None
    sample_rate_hz: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class EngineAudioChunk:
    data: bytes
    sample_rate_hz: int


Synthesizer = Callable[[str, VoiceSpec], AsyncIterator[bytes | EngineAudioChunk]]


@dataclass(frozen=True)
class SpeechEngine:
    name: str
    format: AudioFormat
    synthesize: Synthesizer
    sample_rate_hz: int | None = None


@dataclass(frozen=True)
class SegmentChunk:
    seg: int
    chunk: SpeechChunk | None


class SpeechSynthesisError(RuntimeError):
    def __init__(self, engine: str, public_detail: str) -> None:
        self.engine = engine
        self.public_detail = public_detail
        super().__init__(f"{engine}: {public_detail}")


def split_speech(text: str, *, soft_limit: int = 80) -> list[str]:
    """Split spoken text at sentence boundaries and long comma clauses."""
    if soft_limit < 1:
        raise ValueError("soft_limit must be positive")
    result: list[str] = []
    for match in _SENTENCE.finditer(text.strip()):
        sentence = match.group().strip()
        if not sentence:
            continue
        if len(sentence) <= soft_limit:
            result.append(sentence)
            continue
        result.extend(part for clause in _CLAUSE.finditer(sentence) if (part := clause.group().strip()))
    return result


class TTSService:
    def __init__(
        self,
        engines: dict[str, SpeechEngine],
        *,
        default_engine: str = "edge",
        engine_defaults: dict[str, VoiceSpec] | None = None,
    ) -> None:
        self.engines = dict(engines)
        self.default_engine = default_engine
        self.engine_defaults = dict(engine_defaults or {})

    async def stream(self, text: str, voice: VoiceSpec) -> AsyncIterator[SpeechChunk]:
        if not text.strip():
            raise ValueError("Speech text is required")
        if voice.engine == "browser":
            yield SpeechChunk(
                kind="fallback", engine="browser", reason="Browser speech was selected.",
            )
            return
        candidates = list(dict.fromkeys((voice.engine, self.default_engine)))
        last_reason = "No server speech engine is configured."
        attempted = False
        for index, name in enumerate(candidates):
            engine = self.engines.get(name)
            next_name = next((item for item in candidates[index + 1:] if item in self.engines), None)
            if engine is None:
                last_reason = f"Speech engine {name!r} is unavailable."
                if next_name is not None:
                    yield SpeechChunk(kind="fallback", engine=next_name, reason=last_reason)
                continue
            attempted = True
            fallback_voice = self.engine_defaults.get(name)
            if name == voice.engine:
                selected = replace(
                    voice,
                    model=voice.model or (fallback_voice.model if fallback_voice else ""),
                )
            else:
                selected = fallback_voice or replace(voice, engine=name)
            yielded = False
            try:
                async with aclosing(engine.synthesize(text, selected)) as chunks:
                    async for data in chunks:
                        payload = data.data if isinstance(data, EngineAudioChunk) else data
                        sample_rate = data.sample_rate_hz if isinstance(data, EngineAudioChunk) else engine.sample_rate_hz
                        if not payload:
                            continue
                        yielded = True
                        yield SpeechChunk(
                            kind="audio", engine=name, format=engine.format, data=payload,
                            sample_rate_hz=sample_rate,
                        )
                if not yielded:
                    raise SpeechSynthesisError(name, "The speech engine returned no audio.")
                return
            except asyncio.CancelledError:
                raise
            except SpeechSynthesisError as error:
                if yielded:
                    raise
                last_reason = error.public_detail
            if next_name is not None:
                yield SpeechChunk(kind="fallback", engine=next_name, reason=last_reason)
        if not attempted:
            last_reason = f"Speech engine {voice.engine!r} is unavailable."
        yield SpeechChunk(kind="fallback", engine="browser", reason=last_reason)


class SpeechQueue:
    """Dynamically enqueue segments while streaming them in increasing order."""

    def __init__(self, service: TTSService, *, max_in_flight: int = 3, queue_size: int = 8) -> None:
        if max_in_flight < 1 or queue_size < 1:
            raise ValueError("Speech queue limits must be positive")
        self.service = service
        self._slots = asyncio.Semaphore(max_in_flight)
        self._queue_size = queue_size
        self._segments: list[int] = []
        self._queues: dict[int, asyncio.Queue[SpeechChunk | BaseException | object]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._changed = asyncio.Condition()
        self._closed = False
        self._cancelled = False

    async def enqueue(self, seg: int, text: str, voice: VoiceSpec) -> None:
        async with self._changed:
            if self._closed or self._cancelled:
                raise RuntimeError("Speech queue is closed")
            if self._segments and seg <= self._segments[-1]:
                raise ValueError("Speech segment numbers must be strictly increasing")
            output: asyncio.Queue[SpeechChunk | BaseException | object] = asyncio.Queue(self._queue_size)
            self._segments.append(seg)
            self._queues[seg] = output
            task = asyncio.create_task(self._produce(text, voice, output))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            self._changed.notify_all()

    async def close(self) -> None:
        async with self._changed:
            self._closed = True
            self._changed.notify_all()

    async def cancel(self) -> None:
        async with self._changed:
            self._cancelled = True
            self._closed = True
            tasks = tuple(self._tasks)
            for task in tasks:
                task.cancel()
            self._changed.notify_all()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def stream(self) -> AsyncIterator[SegmentChunk]:
        index = 0
        while True:
            async with self._changed:
                await self._changed.wait_for(
                    lambda: self._cancelled or index < len(self._segments) or self._closed,
                )
                if self._cancelled:
                    return
                if index >= len(self._segments):
                    return
                seg = self._segments[index]
                output = self._queues[seg]
            while True:
                item = await output.get()
                if item is _END:
                    yield SegmentChunk(seg=seg, chunk=None)
                    break
                if isinstance(item, BaseException):
                    raise item
                yield SegmentChunk(seg=seg, chunk=item)
            index += 1

    async def _produce(
        self,
        text: str,
        voice: VoiceSpec,
        output: asyncio.Queue[SpeechChunk | BaseException | object],
    ) -> None:
        cancelled = False
        failed = False
        try:
            async with self._slots:
                async with aclosing(self.service.stream(text, voice)) as chunks:
                    async for chunk in chunks:
                        await output.put(chunk)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except BaseException as error:
            failed = True
            await output.put(error)
        finally:
            if not cancelled and not failed:
                await output.put(_END)
