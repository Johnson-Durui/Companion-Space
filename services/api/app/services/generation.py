from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class ActiveGeneration:
    number: int
    task: asyncio.Task[Any]


class GenerationGuard:
    def __init__(self) -> None:
        self._number = 0
        self._active: ActiveGeneration | None = None

    def reserve(self) -> int:
        if self._active is not None and not self._active.task.done():
            raise ValueError("There is already an active generation")
        self._number += 1
        return self._number

    def bind(self, number: int, task: asyncio.Task[Any]) -> None:
        if number != self._number or self._active is not None and not self._active.task.done():
            raise ValueError("Invalid generation")
        self._active = ActiveGeneration(number, task)

    def is_current(self, number: int) -> bool:
        return self._active is not None and self._active.number == number and not self._active.task.done()

    def finish(self, number: int) -> None:
        if self._active is not None and self._active.number == number:
            self._active = None

    def interrupt(self) -> asyncio.Task[Any] | None:
        active = self._active
        if active is None or active.task.done():
            return None
        self._number += 1
        self._active = None
        active.task.cancel()
        return active.task
