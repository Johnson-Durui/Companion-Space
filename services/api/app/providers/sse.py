from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterable, AsyncIterator

from app.providers.errors import ProviderProtocolError


@dataclass(frozen=True)
class SSEJSONEvent:
    event: str
    data: Any


async def iter_sse_json(lines: AsyncIterable[str], *, provider: str) -> AsyncIterator[SSEJSONEvent]:
    event_name = "message"
    data_lines: list[str] = []

    async def flush_event() -> SSEJSONEvent | None:
        nonlocal event_name, data_lines

        if not data_lines:
            event_name = "message"
            return None

        payload = "\n".join(data_lines)
        data_lines = []
        current_event = event_name or "message"
        event_name = "message"

        if payload == "[DONE]":
            return SSEJSONEvent(event=current_event, data=payload)

        try:
            return SSEJSONEvent(event=current_event, data=json.loads(payload))
        except json.JSONDecodeError as exc:
            raise ProviderProtocolError(
                provider=provider,
                public_detail="Provider returned an invalid streaming response.",
            ) from exc

    async for raw_line in lines:
        line = raw_line.rstrip("\r")

        if not line:
            event = await flush_event()
            if event is None:
                continue
            if event.data == "[DONE]":
                return
            yield event
            continue

        if line.startswith(":"):
            continue

        field, separator, value = line.partition(":")
        if separator == "":
            continue

        if value.startswith(" "):
            value = value[1:]

        if field == "event":
            event_name = value or "message"
            continue

        if field == "data":
            data_lines.append(value)

    event = await flush_event()
    if event is not None and event.data != "[DONE]":
        yield event
