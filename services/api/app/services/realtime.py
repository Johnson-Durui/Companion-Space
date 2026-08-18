from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


PCM16_FRAME_BYTES = 640
PCM16_SAMPLE_RATE_HZ = 16000
TTS_SAMPLE_RATE_HZ = 24000
TTS_CONTENT_TYPE = "audio/pcm;rate=24000"
MAX_REALTIME_BUFFER_BYTES = 3_840_000


@dataclass(slots=True)
class ActiveRealtimeTurn:
    generation: int
    task: asyncio.Task[Any]


@dataclass(slots=True)
class RealtimeConnectionState:
    audio_buffer: bytearray = field(default_factory=bytearray)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _generation: int = 0
    _active_turn: ActiveRealtimeTurn | None = None

    def has_active_turn(self) -> bool:
        return self._active_turn is not None and not self._active_turn.task.done()

    def reserve_generation(self) -> int:
        if self.has_active_turn():
            raise ValueError("Session already has an active turn")
        self._generation += 1
        return self._generation

    def bind_turn(self, *, generation: int, task: asyncio.Task[Any]) -> None:
        self._active_turn = ActiveRealtimeTurn(generation=generation, task=task)

    def is_generation_current(self, generation: int) -> bool:
        return self.has_active_turn() and self._active_turn is not None and self._active_turn.generation == generation

    def finish_turn(self, generation: int) -> None:
        if self._active_turn is not None and self._active_turn.generation == generation:
            self._active_turn = None

    def interrupt_active_turn(self) -> asyncio.Task[Any] | None:
        if not self.has_active_turn() or self._active_turn is None:
            return None
        task = self._active_turn.task
        self._generation += 1
        self._active_turn = None
        task.cancel()
        return task

    def append_audio_frame(self, frame: bytes) -> int:
        if len(frame) != PCM16_FRAME_BYTES:
            raise ValueError(
                "Realtime audio frames must be exactly 640 bytes "
                "(PCM16 mono 16k 20ms)."
            )
        if len(self.audio_buffer) + len(frame) > MAX_REALTIME_BUFFER_BYTES:
            self.audio_buffer.clear()
            raise ValueError("Realtime audio buffer exceeded 120 seconds.")
        self.audio_buffer.extend(frame)
        return len(self.audio_buffer)

    def consume_audio_buffer(self) -> bytes:
        data = bytes(self.audio_buffer)
        self.audio_buffer.clear()
        return data

    def clear_audio_buffer(self) -> None:
        self.audio_buffer.clear()
