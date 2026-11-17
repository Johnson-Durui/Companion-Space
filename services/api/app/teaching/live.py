from __future__ import annotations

import asyncio
import json
import logging
import struct
from contextlib import suppress
from dataclasses import replace
from time import monotonic
from typing import TYPE_CHECKING

from starlette.websockets import WebSocket, WebSocketDisconnect

from app.providers.errors import ProviderError, provider_error_code
from app.teaching.director import VALID_STYLES
from app.teaching.runtime import LessonRuntime
from app.teaching.timers import lesson_time_limit_ms, silence_delay_ms
from app.voice.stt import MAX_PCM_BYTES, VoiceTranscriber
from app.voice.tts.engines import resolve_tts
from app.voice.tts.pipeline import SpeechQueue, SpeechSynthesisError, VoiceSpec, split_speech

if TYPE_CHECKING:
    from app.api.deps import ServiceContainer

logger = logging.getLogger(__name__)
_QUICK = {"confused", "example", "hint", "show_answer", "repeat", "skip", "slower", "faster", "break", "continue"}


def _student_event(command: str, data: dict) -> dict:
    match command:
        case "student.text":
            value = data.get("text")
            if isinstance(value, str) and 0 < len(value.strip()) <= 3000:
                return {"type": "student_utterance", "text": value.strip(), "via": "text", "prefill": True}
        case "student.answer":
            value, item_id, via = data.get("value"), data.get("item_id"), data.get("via", "control")
            if isinstance(item_id, str) and 0 < len(item_id) <= 128 and via in ("control", "text", "voice"):
                unknown = data.get("dont_know") is True
                scalar = isinstance(value, str) and 0 < len(value.strip()) <= 3000
                choices = isinstance(value, list) and 0 < len(value) <= 32 and all(
                    isinstance(key, str) and 0 < len(key) <= 128 for key in value
                )
                if unknown or scalar or choices:
                    return {"type": "student_answer", "item_id": item_id, "via": via,
                            "value": None if unknown else value, "dont_know": unknown}
        case "student.reply":
            purpose, value = data.get("purpose"), data.get("value")
            if isinstance(purpose, str) and 0 < len(purpose) <= 64 and isinstance(value, str) and 0 < len(value) <= 3000:
                return {"type": "ask_reply", "purpose": purpose, "value": value}
        case "student.quick":
            action = data.get("kind")
            if isinstance(action, str) and (
                action in _QUICK or action.removeprefix("style:") in VALID_STYLES and action.startswith("style:")
                or action.startswith("locate:") and 0 < len(action.removeprefix("locate:")) <= 128
            ):
                return {"type": "quick_action", "kind": action}
        case "lesson.control":
            if data.get("action") in ("pause", "resume", "end"):
                return {"type": "control", "action": data["action"]}
    raise ValueError("Invalid classroom action")


class LiveLesson:
    def __init__(self, socket: WebSocket, container: ServiceContainer, space_id: str, lesson_id: str) -> None:
        self.socket = socket
        self.container = container
        self.repository = container.repository
        self.runtime = LessonRuntime(self.repository, container.gateway, space_id, lesson_id)
        self.space_id = space_id
        self.id = lesson_id
        self.lesson: dict = {}
        self.waiting = 0.0
        self.deadline: float | None = None
        self.next_event: str | None = None
        self.beat: list[dict] = []
        self.audio = False
        self.pcm: bytearray | None = None
        self.interruptions = 0
        self.recording_interrupted = False
        self.time_limit_ms = 0

    async def _reload(self) -> None:
        lesson = await asyncio.to_thread(self.repository.get_lesson, self.space_id, self.id)
        if lesson is None:
            raise ValueError("Classroom no longer exists")
        self.lesson = lesson

    async def _send(self, kind: str, data: dict, *, gen: int | None = None, seq: int = 0) -> None:
        await self.socket.send_json({
            "v": 1, "lesson_id": self.id, "gen": self.lesson["gen"] if gen is None else gen,
            "seq": seq, "type": kind, "data": data,
        })

    def _arm(self, kind: str, delay: float) -> None:
        self.next_event, self.deadline = kind, monotonic() + delay

    async def _waiting_for_student(self) -> None:
        ask = self.lesson["state"].get("active_ask")
        if ask is None:
            return
        widget = next((row["data"].get("widget") for row in reversed(self.beat) if row["type"] == "ask"), None)
        item_type = (widget or {}).get("type")
        limit = silence_delay_ms(ask, item_type or ("explain" if ask.get("kind") == "item" else None))
        if limit:
            self.waiting = self.waiting or monotonic()
            state = self.lesson["state"]
            until_limit = (self.time_limit_ms - state.get("active_ms", 0)) / 1000 - (monotonic() - self.waiting)
            if not state.get("time_up_sent") and until_limit <= limit / 1000:
                self._arm("time_up", max(0, until_limit))
            else:
                self._arm("silence", limit / 1000)

    async def _step(self, event: dict) -> None:
        elapsed = round((monotonic() - self.waiting) * 1000) if self.waiting else 0
        self.waiting = 0.0
        self.deadline = None
        queue: SpeechQueue | None = None
        voice: VoiceSpec | None = None

        async def prefetch(seg: int, text: str) -> None:
            nonlocal queue, voice
            if queue is None:
                service, voice = await resolve_tts(self.container, self.lesson["character_id"])
                pace = self.lesson["state"].get("pace")
                multiplier = {"slow": 0.85, "fast": 1.15}.get(pace, 1)
                voice = replace(voice, rate=max(0.5, min(2.0, voice.rate * multiplier)))
                queue = SpeechQueue(service)
            await queue.enqueue(seg, text, voice)

        try:
            rows = await self.runtime.step(
                event, elapsed_ms=elapsed, split_speech=split_speech, on_say=prefetch if self.audio else None,
            )
            if rows and rows[0]["type"] == "prefill":
                await self._send("prefill", rows[0]["data"])
                await self._waiting_for_student()
                return
            await self._reload()
            if any(row["type"] in {"beat.start", "ask"} for row in rows):
                self.beat = rows
                self.waiting = monotonic()
            for row in rows:
                await self.socket.send_json({"v": 1, **row})
            if self.audio and self.lesson["status"] != "paused":
                if queue is None:
                    for row in rows:
                        if row["type"] == "say":
                            await prefetch(row["data"]["seg"], row["data"]["text"])
                if queue is not None and voice is not None:
                    await self._speak(rows, queue, voice)
            if any(row["type"] == "ask" for row in rows) and not any(row["type"] == "say" for row in rows):
                await self._waiting_for_student()
            if self.lesson["status"] == "done":
                await self._send("recap", self.lesson["recap"] or {})
        except ProviderError as exc:
            await self._send("error", {"code": provider_error_code(exc), "recoverable": True})
        except ValueError as exc:
            await self._send("error", {"code": "lesson_action_failed", "message": str(exc), "recoverable": True})
        finally:
            if queue is not None:
                await queue.cancel()

    async def _speak(self, rows: list[dict], queue: SpeechQueue, voice: VoiceSpec) -> None:
        sayings = {row["data"]["seg"]: row for row in rows if row["type"] == "say"}
        if not sayings:
            return
        formats: dict[int, str] = {}
        sample_rates: dict[int, int] = {}

        async def audio_event(seg: int, *, last: bool, payload: bytes | None = None) -> None:
            row = sayings[seg]
            gen, seq = row["gen"], row["seq"]
            format_ = formats.get(seg, "text")
            data = {"seg": seg, "format": format_, "sample_rate": sample_rates.get(seg, 24000), "last": last}
            if format_ == "browser":
                data["browser_voice"] = {
                    "lang": "zh-CN", "rate": voice.rate, "pitch": max(0.1, 1 + voice.pitch / 100),
                    "voiceId": voice.voice_id if voice.engine == "browser" else "",
                }
            await self._send("audio", data, gen=gen, seq=seq)
            if payload:
                await self.socket.send_bytes(struct.pack(">4sIIHH", b"CSA1", gen, seg, 0, 0) + payload)

        last_seg = None
        try:
            await queue.close()
            async for result in queue.stream():
                seg, chunk = result.seg, result.chunk
                row = sayings[seg]
                gen, seq = row["gen"], row["seq"]
                last_seg = seg
                if chunk is None:
                    await audio_event(seg, last=True)
                elif chunk.kind == "fallback":
                    if chunk.engine == "browser":
                        formats[seg] = "browser"
                    if voice.engine != "browser":
                        await self._send("voice.fallback", {"seg": seg, "engine": chunk.engine, "reason": chunk.reason},
                                         gen=gen, seq=seq)
                elif chunk.kind == "audio":
                    formats[seg] = chunk.format
                    if chunk.sample_rate_hz:
                        sample_rates[seg] = chunk.sample_rate_hz
                    if chunk.data:
                        await audio_event(seg, last=False, payload=chunk.data)
        except SpeechSynthesisError as exc:
            await self._send("voice.fallback", {"engine": "text", "reason": exc.public_detail})
            for seg in sayings:
                if last_seg is None or seg >= last_seg:
                    await audio_event(seg, last=True)

    async def _interrupt(self, data: dict) -> None:
        await self._reload()
        gen, heard = data.get("gen"), data.get("heard_seq")
        if type(heard) is not int or not 0 <= heard <= self.lesson["seq"] or gen != self.lesson["gen"]:
            return
        say = [row for row in self.beat if row["type"] == "say" and row["gen"] == gen]
        total = sum(len(row["data"]["text"]) for row in say)
        spoken = sum(len(row["data"]["text"]) for row in say if row["seq"] <= heard)
        await self._step({"type": "interrupt", "gen": gen, "heard_seq": heard,
                          "heard_fraction": spoken / total if total else 0})
        if self.pcm is None:
            self._arm("lesson_resume", 8)

    async def _transcribe(self, pcm: bytes) -> None:
        recent = " ".join(row["data"]["text"] for row in self.beat if row["type"] == "say") if self.recording_interrupted else None
        try:
            result = await VoiceTranscriber(self.container.gateway).transcribe_pcm16(pcm, echo_reference=recent)
        except ProviderError as exc:
            await self._send("error", {"code": provider_error_code(exc), "recoverable": True})
            self._arm("lesson_resume", 0)
            return
        if not result.text:
            if self.recording_interrupted:
                self.interruptions += 1
            await self._send("voice.discarded", {"reason": result.discard_reason, "protect": self.interruptions >= 2})
            self._arm("lesson_resume", 0)
            return
        self.interruptions = 0
        await self._send("voice.transcript", {"text": result.text})
        ask = self.lesson["state"].get("active_ask") or {}
        if ask.get("kind") in {"open", "summary"}:
            await self._step({"type": "ask_reply", "purpose": ask["purpose"], "value": result.text})
        else:
            await self._step({"type": "student_utterance", "text": result.text, "via": "voice", "prefill": True})

    async def run(self) -> None:
        await self._reload()
        enrollment = await asyncio.to_thread(self.repository.get_course_enrollment, self.space_id) or {}
        item = await asyncio.to_thread(self.repository.get_plan_item, self.space_id, self.lesson["plan_item_id"])
        self.time_limit_ms = lesson_time_limit_ms(enrollment.get("session_minutes", 30), (item or {}).get("est_minutes", 25))
        receiver = asyncio.create_task(self.socket.receive())
        work: asyncio.Task | None = None
        try:
            while True:
                now = monotonic()
                timeout = max(0, self.deadline - now) if work is None and self.deadline is not None else None
                pending = {receiver, work} if work else {receiver}
                ready, _ = await asyncio.wait(pending, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                if work in ready:
                    work.result()
                    work = None
                if not ready:
                    kind, self.deadline = self.next_event, None
                    work = asyncio.create_task(self._step({"type": kind}))
                    continue
                if receiver not in ready:
                    continue
                packet = receiver.result()
                if packet["type"] == "websocket.disconnect":
                    break
                receiver = asyncio.create_task(self.socket.receive())
                if packet.get("bytes") is not None:
                    chunk = packet["bytes"]
                    if self.pcm is not None and len(chunk) <= 3200 and len(chunk) % 2 == 0:
                        if len(self.pcm) + len(chunk) <= MAX_PCM_BYTES:
                            self.pcm.extend(chunk)
                    continue
                try:
                    raw = packet.get("text") or ""
                    value = json.loads(raw) if len(raw) <= 16384 else None
                    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
                        raise ValueError("Invalid classroom message")
                    kind, data = value["type"], value.get("data", {})
                    if not isinstance(data, dict):
                        raise ValueError("Invalid classroom message")
                    if kind == "student.activity":
                        if self.next_event == "silence" and self.deadline is not None:
                            await self._waiting_for_student()
                        continue
                    if kind == "microphone.start":
                        self.pcm = bytearray()
                        self.deadline = None
                        self.recording_interrupted = data.get("interrupted") is True
                        continue
                    if kind == "microphone.interrupted":
                        self.recording_interrupted = True
                        continue
                    if kind == "microphone.cancel":
                        if self.pcm is not None:
                            self.pcm = None
                            if self.recording_interrupted:
                                self._arm("lesson_resume", 0)
                            elif work is None:
                                await self._waiting_for_student()
                        continue
                    if kind == "microphone.end":
                        pcm, self.pcm = self.pcm, None
                        if pcm is not None and work is None:
                            work = asyncio.create_task(self._transcribe(bytes(pcm)))
                        continue
                    if kind == "playback.done":
                        if work is not None or data.get("gen") != self.lesson["gen"]:
                            continue
                        if self.lesson["state"].get("active_ask"):
                            await self._waiting_for_student()
                        elif "playback_after_seq" in self.lesson["state"] and self.lesson["status"] == "active":
                            self._arm("beat_done", 0.35)
                        continue
                    interrupt = kind == "student.interrupt"
                    event = None if interrupt else _student_event(kind, data)
                    if work is not None:
                        if not interrupt and event != {"type": "control", "action": "pause"}:
                            await self._send("error", {"code": "lesson_busy", "recoverable": True})
                            continue
                        work.cancel()
                        with suppress(asyncio.CancelledError):
                            await work
                    if interrupt:
                        work = None
                        await self._interrupt(data)
                    else:
                        if event == {"type": "control", "action": "resume"}:
                            self.audio = data.get("audio") is True
                        elif event == {"type": "control", "action": "pause"}:
                            self.pcm = None
                        work = asyncio.create_task(self._step(event))
                except ValueError:
                    await self._send("error", {"code": "lesson_action_failed", "recoverable": True})
        except (WebSocketDisconnect, OSError):
            return
        except Exception:
            logger.exception("Classroom connection failed")
            await self.socket.close(code=1011)
        finally:
            tasks = [task for task in (receiver, work) if task is not None]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
