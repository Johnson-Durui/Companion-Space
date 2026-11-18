"""Small adapter for the default online voice, using ephemeral MP3 audio."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import aclosing

import aiohttp
import edge_tts
from edge_tts import exceptions

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


class EdgeUnavailableError(RuntimeError):
    pass


class EdgeVoiceUnavailableError(EdgeUnavailableError):
    pass


async def synthesize(
    text: str, voice: str, rate: float = 1, pitch: int = 0,
) -> AsyncIterator[bytes]:
    try:
        communication = edge_tts.Communicate(
            text, voice, rate=f"{round((rate - 1) * 100):+d}%",
            pitch=f"{pitch:+d}Hz", connect_timeout=5, receive_timeout=6,
        )
        async with asyncio.timeout(10), aclosing(communication.stream()) as stream:
            async for event in stream:
                if event["type"] == "audio":
                    yield event["data"]
    except exceptions.NoAudioReceived as exc:
        raise EdgeVoiceUnavailableError("No speech audio returned") from exc
    except (aiohttp.ClientError, exceptions.EdgeTTSException, TimeoutError, ValueError) as exc:
        raise EdgeUnavailableError("Online speech audio unavailable") from exc


async def preview_audio(text: str, voice: str, rate: float = 1, pitch: int = 0) -> bytes:
    data = bytearray()
    async with aclosing(synthesize(text, voice, rate, pitch)) as chunks:
        async for chunk in chunks:
            if len(data) + len(chunk) > 1024 * 1024:
                raise EdgeUnavailableError("Speech preview is too large")
            data.extend(chunk)
    if not data:
        raise EdgeVoiceUnavailableError("No speech audio returned")
    return bytes(data)
