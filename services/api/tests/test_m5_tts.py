from __future__ import annotations

import asyncio
import json
import struct
from collections.abc import AsyncIterator

import httpx
import pytest

from app.voice.tts.engines import gpt_sovits_engine
from app.voice.tts.pipeline import (
    SpeechChunk,
    SpeechEngine,
    SpeechQueue,
    SpeechSynthesisError,
    TTSService,
    VoiceSpec,
    split_speech,
)


def test_split_speech_keeps_end_punctuation_and_splits_long_comma_clauses() -> None:
    text = "你好！How are you? 这是一段很长的话，它需要在逗号处拆开，否则单句合成会太慢。"

    assert split_speech(text, soft_limit=16) == [
        "你好！",
        "How are you?",
        "这是一段很长的话，",
        "它需要在逗号处拆开，",
        "否则单句合成会太慢。",
    ]


def test_service_reports_fallback_before_audio() -> None:
    async def unavailable(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        raise SpeechSynthesisError("edge", "forbidden")
        yield b""

    async def working(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        yield b"\x01\x00"

    async def scenario() -> list[SpeechChunk]:
        service = TTSService(
            {
                "edge": SpeechEngine("edge", "mp3", unavailable),
                "openai_compat": SpeechEngine("openai_compat", "pcm_s16le", working),
            },
            default_engine="openai_compat",
        )
        async def collect() -> list[SpeechChunk]:
            return [chunk async for chunk in service.stream("hello", VoiceSpec(engine="edge", voice_id="v"))]

        return await asyncio.wait_for(collect(), 1)

    chunks = asyncio.run(scenario())

    assert [(chunk.kind, chunk.engine, chunk.format) for chunk in chunks] == [
        ("fallback", "openai_compat", None),
        ("audio", "openai_compat", "pcm_s16le"),
    ]
    assert chunks[0].reason == "forbidden"
    assert chunks[1].data == b"\x01\x00"


def test_service_ends_with_visible_browser_fallback() -> None:
    async def unavailable(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        raise SpeechSynthesisError("edge", "offline")
        yield b""

    async def scenario() -> list[SpeechChunk]:
        service = TTSService({"edge": SpeechEngine("edge", "mp3", unavailable)})
        return [chunk async for chunk in service.stream("hello", VoiceSpec(engine="edge", voice_id="v"))]

    chunks = asyncio.run(scenario())

    assert len(chunks) == 1
    assert chunks[0].kind == "fallback"
    assert chunks[0].engine == "browser"
    assert chunks[0].reason == "offline"


def test_service_does_not_fallback_back_to_an_engine_that_already_failed() -> None:
    async def unavailable(_: str, voice: VoiceSpec) -> AsyncIterator[bytes]:
        raise SpeechSynthesisError(voice.engine, f"{voice.engine} unavailable")
        yield b""

    async def scenario() -> list[SpeechChunk]:
        service = TTSService(
            {
                "edge": SpeechEngine("edge", "mp3", unavailable),
                "openai_compat": SpeechEngine("openai_compat", "pcm_s16le", unavailable),
            },
            default_engine="openai_compat",
            engine_defaults={
                "openai_compat": VoiceSpec(
                    engine="openai_compat", voice_id="alloy", model="speech-model",
                ),
            },
        )
        voice = VoiceSpec(engine="edge", voice_id="edge-voice")
        return [chunk async for chunk in service.stream("hello", voice)]

    chunks = asyncio.run(scenario())

    assert [chunk.engine for chunk in chunks] == ["openai_compat", "browser"]


def test_selected_provider_keeps_character_voice_and_inherits_role_model() -> None:
    received: list[VoiceSpec] = []

    async def synthesize(_: str, voice: VoiceSpec) -> AsyncIterator[bytes]:
        received.append(voice)
        yield b"\x00\x00"

    async def scenario() -> None:
        service = TTSService(
            {"openai_compat": SpeechEngine("openai_compat", "pcm_s16le", synthesize)},
            default_engine="openai_compat",
            engine_defaults={
                "openai_compat": VoiceSpec(
                    engine="openai_compat", voice_id="default", model="speech-model",
                ),
            },
        )
        voice = VoiceSpec(engine="openai_compat", voice_id="character-voice", rate=1.2)
        _ = [chunk async for chunk in service.stream("hello", voice)]

    asyncio.run(scenario())

    assert received == [
        VoiceSpec(
            engine="openai_compat", voice_id="character-voice", model="speech-model", rate=1.2,
        ),
    ]


def test_dynamic_queue_streams_in_segment_order_with_three_in_flight() -> None:
    async def scenario() -> tuple[list[tuple[int, bytes]], int]:
        gates = {1: asyncio.Event(), 2: asyncio.Event(), 3: asyncio.Event(), 4: asyncio.Event()}
        active = 0
        peak = 0

        async def synthesize(text: str, _: VoiceSpec) -> AsyncIterator[bytes]:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await gates[int(text)].wait()
                yield text.encode()
            finally:
                active -= 1

        service = TTSService({"edge": SpeechEngine("edge", "mp3", synthesize)})
        queue = SpeechQueue(service, max_in_flight=3)
        voice = VoiceSpec(engine="edge", voice_id="v")
        for seg in (1, 2, 3, 4):
            await queue.enqueue(seg, str(seg), voice)
        await asyncio.sleep(0)
        assert peak == 3
        gates[3].set()
        gates[2].set()
        await asyncio.sleep(0)
        gates[1].set()
        await queue.close()
        output: list[tuple[int, bytes]] = []

        async def consume() -> None:
            async for item in queue.stream():
                if item.chunk is not None and item.chunk.kind == "audio":
                    output.append((item.seg, item.chunk.data or b""))

        consumer = asyncio.create_task(consume())
        await asyncio.sleep(0)
        gates[4].set()
        await consumer
        return output, peak

    output, peak = asyncio.run(scenario())

    assert output == [(1, b"1"), (2, b"2"), (3, b"3"), (4, b"4")]
    assert peak == 3


def test_dynamic_queue_cancellation_stops_all_synthesis() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        stopped = 0

        async def synthesize(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
            nonlocal stopped
            started.set()
            try:
                await asyncio.Future()
                yield b""
            finally:
                stopped += 1

        queue = SpeechQueue(TTSService({"edge": SpeechEngine("edge", "mp3", synthesize)}))
        voice = VoiceSpec(engine="edge", voice_id="v")
        await queue.enqueue(1, "a", voice)
        await queue.enqueue(2, "b", voice)
        await started.wait()
        await queue.cancel()
        assert stopped == 2

    asyncio.run(scenario())


def test_dynamic_queue_rejects_non_increasing_segments() -> None:
    async def silent(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        yield b"\x00\x00"

    async def scenario() -> None:
        queue = SpeechQueue(TTSService({"edge": SpeechEngine("edge", "mp3", silent)}))
        voice = VoiceSpec(engine="edge", voice_id="v")
        await queue.enqueue(2, "a", voice)
        with pytest.raises(ValueError, match="increasing"):
            await queue.enqueue(2, "b", voice)
        await queue.cancel()

    asyncio.run(scenario())


def test_dynamic_queue_producer_error_does_not_block_on_end_marker() -> None:
    async def synthesize(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        yield b"audio"
        raise SpeechSynthesisError("edge", "stream failed")

    async def scenario() -> None:
        queue = SpeechQueue(
            TTSService({"edge": SpeechEngine("edge", "mp3", synthesize)}),
            queue_size=1,
        )
        await queue.enqueue(1, "one", VoiceSpec(engine="edge", voice_id="v"))
        await queue.close()
        stream = queue.stream()
        first = await anext(stream)
        assert first.chunk is not None and first.chunk.data == b"audio"
        with pytest.raises(SpeechSynthesisError, match="stream failed"):
            await anext(stream)
        await asyncio.sleep(0)
        assert not queue._tasks

    asyncio.run(scenario())


def test_gpt_sovits_streams_raw_pcm_from_official_api_v2_contract() -> None:
    request_body: dict[str, object] = {}

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            header = (
                b"RIFF" + (0xFFFFFFFF).to_bytes(4, "little") + b"WAVE"
                + b"fmt " + (16).to_bytes(4, "little")
                + struct.pack("<HHIIHH", 1, 1, 32000, 64000, 2, 16)
                + b"data" + (0xFFFFFFFF).to_bytes(4, "little")
            )
            yield header + b"\x01"
            yield b"\x00\x02\x00"

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_body
        request_body = json.loads(request.content)
        assert request.url.path == "/tts"
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "audio/wav"},
            stream=Stream(),
        )

    async def scenario():
        engine = gpt_sovits_engine(
            "http://127.0.0.1:9880",
            transport=httpx.MockTransport(handler),
        )
        voice = VoiceSpec(
            engine="gpt_sovits",
            voice_id="reference.wav",
            rate=1.1,
            options={"prompt_text": "reference", "prompt_lang": "zh", "text_lang": "zh"},
        )
        return [chunk async for chunk in engine.synthesize("hello", voice)]

    chunks = asyncio.run(scenario())

    assert b"".join(chunk.data for chunk in chunks) == b"\x01\x00\x02\x00"
    assert {chunk.sample_rate_hz for chunk in chunks} == {32000}
    assert request_body == {
        "text": "hello",
        "text_lang": "zh",
        "ref_audio_path": "reference.wav",
        "prompt_text": "reference",
        "prompt_lang": "zh",
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": 1.1,
        "media_type": "wav",
        "streaming_mode": True,
    }


def test_gpt_sovits_rejects_non_local_endpoint() -> None:
    with pytest.raises(ValueError, match="local endpoint"):
        gpt_sovits_engine("https://speech.example.com")


def test_direct_browser_selection_skips_server_synthesis() -> None:
    called = False

    async def synthesize(_: str, __: VoiceSpec) -> AsyncIterator[bytes]:
        nonlocal called
        called = True
        yield b"audio"

    async def scenario() -> list[SpeechChunk]:
        service = TTSService({"edge": SpeechEngine("edge", "mp3", synthesize)})
        voice = VoiceSpec(engine="browser", voice_id="")
        return [chunk async for chunk in service.stream("hello", voice)]

    chunks = asyncio.run(scenario())

    assert called is False
    assert [(chunk.kind, chunk.engine) for chunk in chunks] == [("fallback", "browser")]


def test_dynamic_queue_emits_segment_end_before_the_next_segment() -> None:
    async def synthesize(text: str, _: VoiceSpec) -> AsyncIterator[bytes]:
        yield text.encode()

    async def scenario() -> list[tuple[int, str]]:
        queue = SpeechQueue(TTSService({"edge": SpeechEngine("edge", "mp3", synthesize)}))
        voice = VoiceSpec(engine="edge", voice_id="v")
        await queue.enqueue(1, "one", voice)
        await queue.enqueue(2, "two", voice)
        await queue.close()
        return [
            (item.seg, "end" if item.chunk is None else item.chunk.kind)
            async for item in queue.stream()
        ]

    assert asyncio.run(scenario()) == [
        (1, "audio"), (1, "end"), (2, "audio"), (2, "end"),
    ]
