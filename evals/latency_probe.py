"""Measure M5 classroom latency against isolated, already-prepared real lessons.

The probe records timing metadata only. It never writes microphone bytes,
transcripts, classroom text, provider secrets, or WebSocket payloads.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.asyncio.client import ClientConnection, connect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DATA = (ROOT / "evals/out/data").resolve()
OUTPUT_ROOT = (ROOT / "evals/out").resolve()
PROTOCOL = "companion-v1"
METRICS = (
    "answer_to_speech_ms",
    "utterance_end_to_speech_ms",
    "interrupt_to_stop_ms",
    "between_beats_ms",
)
TARGETS_MS = {
    "answer_to_speech_ms": 1800,
    "utterance_end_to_speech_ms": 3000,
    "interrupt_to_stop_ms": 300,
    "between_beats_ms": 1200,
}


@dataclass
class ProbeState:
    gen: int = 0
    seq: int = 0
    ask: dict[str, Any] | None = None
    expected_segments: set[int] = field(default_factory=set)
    completed_segments: set[int] = field(default_factory=set)
    server_audio: bool = False

    def observe(self, message: dict[str, Any]) -> None:
        self.gen = message.get("gen", self.gen)
        self.seq = max(self.seq, message.get("seq", 0))
        kind = message.get("type")
        data = message.get("data") or {}
        if kind == "ask":
            self.ask = data
        elif kind == "say" and isinstance(data.get("seg"), int):
            self.expected_segments.add(data["seg"])
        elif kind == "audio" and data.get("last") is True and isinstance(data.get("seg"), int):
            self.completed_segments.add(data["seg"])

    def response_complete(self) -> bool:
        return bool(self.expected_segments) and self.expected_segments <= self.completed_segments


def percentile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("Cannot calculate a percentile without samples")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize(samples: dict[str, list[float]], minimum: int) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for name in METRICS:
        values = samples[name]
        results[name] = {
            "status": "measured" if len(values) >= minimum else "unverified",
            "samples": len(values),
            "required_samples": minimum,
        }
        if values:
            results[name].update({
                "p50_ms": round(percentile(values, 0.5), 1),
                "p90_ms": round(percentile(values, 0.9), 1),
                "target_p50_ms": TARGETS_MS[name],
                "p50_within_target": percentile(values, 0.5) <= TARGETS_MS[name],
            })
    return results


def _load_plan(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    lessons = payload.get("lessons") if isinstance(payload, dict) else None
    if not isinstance(lessons, list) or not lessons:
        raise ValueError("The plan must contain a nonempty lessons list")
    for lesson in lessons:
        if not isinstance(lesson, dict) or not isinstance(lesson.get("lesson_id"), str):
            raise ValueError("Every planned lesson needs a lesson_id")
        actions = lesson.get("actions")
        if not isinstance(actions, list) or not actions:
            raise ValueError("Every planned lesson needs actions")
        if any(not isinstance(action, dict) or action.get("kind") not in {"answer", "utterance", "text"}
               for action in actions):
            raise ValueError("Action kind must be answer, utterance, or text")
    return lessons


def _validate_isolated_data_dir(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(OUTPUT_DATA) or resolved.is_relative_to((ROOT / "storage").resolve()):
        raise ValueError("The server data directory must be under evals/out/data")
    return resolved


def _ws_url(base_url: str, lesson_id: str) -> str:
    parsed = urlsplit(base_url.rstrip("/"))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base-url must be HTTP(S)")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, f"/api/v2/lessons/{lesson_id}/live", "", ""))


async def _receive_json(socket: ClientConnection, state: ProbeState, timeout: float) -> dict[str, Any]:
    while True:
        packet = await asyncio.wait_for(socket.recv(), timeout)
        if isinstance(packet, bytes):
            if len(packet) >= 16:
                magic, gen, seg, _, _ = struct.unpack(">4sIIHH", packet[:16])
                if magic != b"CSA1" or gen < 0 or seg < 0:
                    raise ValueError("Invalid classroom audio frame")
            continue
        message = json.loads(packet)
        if not isinstance(message, dict):
            raise ValueError("Invalid classroom event")
        state.observe(message)
        if message.get("type") == "error":
            code = (message.get("data") or {}).get("code", "unknown")
            raise RuntimeError(f"Classroom returned {code}")
        return message


async def _send(socket: ClientConnection, kind: str, data: dict[str, Any]) -> None:
    await socket.send(json.dumps({"type": kind, "data": data}, separators=(",", ":")))


def _answer_payload(state: ProbeState, action: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    ask = state.ask or {}
    if ask.get("kind") == "item":
        item_id = action.get("item_id") or ask.get("item_id")
        if not isinstance(item_id, str):
            raise ValueError("The current item has no item_id")
        value = action.get("value")
        if value is None:
            options = (ask.get("widget") or {}).get("options") or []
            value = options[0].get("key") if options else "0"
        return "student.answer", {"item_id": item_id, "value": value, "via": "control"}
    purpose = ask.get("purpose")
    if not isinstance(purpose, str):
        raise ValueError("The classroom is not waiting for an answer")
    return "student.reply", {"purpose": purpose, "value": str(action.get("value") or "continue")}


async def _send_microphone(socket: ClientConnection, pcm_path: Path, interrupted: bool) -> float:
    pcm = pcm_path.read_bytes()
    if not pcm or len(pcm) % 2 or len(pcm) > 16_000 * 2 * 30:
        raise ValueError("Mic PCM must be nonempty 16 kHz mono s16le audio up to 30 seconds")
    await _send(socket, "microphone.start", {"interrupted": interrupted})
    for offset in range(0, len(pcm), 3200):
        await socket.send(pcm[offset:offset + 3200])
    ended = perf_counter()
    await _send(socket, "microphone.end", {})
    return ended


async def _measure_response(
    socket: ClientConnection,
    state: ProbeState,
    *,
    started: float,
    metric: str,
    interrupt: bool,
    timeout: float,
    samples: dict[str, list[float]],
) -> float | None:
    state.expected_segments.clear()
    state.completed_segments.clear()
    state.ask = None
    first_audio = None
    end_time = None
    while True:
        message = await _receive_json(socket, state, timeout)
        kind = message.get("type")
        data = message.get("data") or {}
        if kind == "prefill":
            await _send(socket, "student.answer", {
                "item_id": data["item_id"], "value": data["value"], "via": data.get("via", "voice"),
            })
            continue
        if kind == "audio" and data.get("last") is False and first_audio is None:
            if data.get("format") in {"pcm_s16le", "mp3"}:
                first_audio = perf_counter()
                state.server_audio = True
                samples[metric].append((first_audio - started) * 1000)
                if interrupt:
                    before_stop = perf_counter()
                    client_playing = True
                    client_playing = False
                    after_stop = perf_counter()
                    if client_playing:
                        raise AssertionError("Client playback did not stop")
                    samples["interrupt_to_stop_ms"].append((after_stop - before_stop) * 1000)
                    await _send(socket, "student.interrupt", {"gen": state.gen, "heard_seq": state.seq})
            elif data.get("format") == "browser":
                raise RuntimeError("Browser speech cannot be timed by this server-side probe")
        if interrupt and kind == "beat.cancelled":
            return perf_counter()
        if not interrupt and state.response_complete():
            end_time = perf_counter()
            return end_time


async def _run_lesson(
    client: httpx.AsyncClient,
    base_url: str,
    owner_token: str,
    lesson: dict[str, Any],
    samples: dict[str, list[float]],
    timeout: float,
) -> None:
    lesson_id = lesson["lesson_id"]
    response = await client.post(f"/api/v2/lessons/{lesson_id}/ticket")
    response.raise_for_status()
    ticket = response.json()["ticket"]
    origin = base_url.rstrip("/")
    async with connect(
        _ws_url(base_url, lesson_id),
        origin=origin,
        subprotocols=[PROTOCOL, f"ticket.{ticket}"],
        open_timeout=timeout,
        max_size=2 * 1024 * 1024,
    ) as socket:
        state = ProbeState()
        await _send(socket, "lesson.control", {"action": "resume", "audio": True})
        initial_end = await _measure_response(
            socket, state, started=perf_counter(), metric="between_beats_ms",
            interrupt=False, timeout=timeout, samples={**samples, "between_beats_ms": []},
        )
        previous_end = initial_end
        if initial_end is not None:
            await _send(socket, "playback.done", {"gen": state.gen})
            await asyncio.sleep(0.05)
        for action in lesson["actions"]:
            transition_started = previous_end
            kind = action["kind"]
            interrupt = action.get("interrupt") is True
            if kind == "utterance":
                path = Path(action.get("pcm_path") or "")
                started = await _send_microphone(socket, path, interrupted=False)
                metric = "utterance_end_to_speech_ms"
            elif kind == "answer":
                command, data = _answer_payload(state, action)
                started = perf_counter()
                await _send(socket, command, data)
                metric = "answer_to_speech_ms"
            else:
                text = action.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("Text actions require nonempty text")
                started = perf_counter()
                await _send(socket, "student.text", {"text": text})
                metric = "answer_to_speech_ms"
            previous_end = await _measure_response(
                socket, state, started=started, metric=metric, interrupt=interrupt,
                timeout=timeout, samples=samples,
            )
            if transition_started is not None and previous_end is not None:
                first_latency = samples[metric][-1]
                samples["between_beats_ms"].append((started - transition_started) * 1000 + first_latency)
            if previous_end is not None and not interrupt:
                await _send(socket, "playback.done", {"gen": state.gen})
                await asyncio.sleep(0.05)


async def run(args: argparse.Namespace) -> int:
    data_dir = _validate_isolated_data_dir(args.isolated_data_dir)
    lessons = _load_plan(args.plan)
    headers = {"authorization": f"Bearer {args.owner_token}"}
    samples = {name: [] for name in METRICS}
    async with httpx.AsyncClient(base_url=args.base_url.rstrip("/"), headers=headers, timeout=args.timeout) as client:
        settings = (await client.get("/api/v2/settings"))
        settings.raise_for_status()
        server_data_dir = Path(settings.json()["data_dir"]).resolve()
        if server_data_dir != data_dir:
            raise ValueError("The running server is not using the confirmed isolated data directory")
        for lesson in lessons:
            await _run_lesson(client, args.base_url, args.owner_token, lesson, samples, args.timeout)
    metrics = summarize(samples, args.minimum_samples)
    output = {
        "status": "measured" if all(row["status"] == "measured" for row in metrics.values()) else "unverified",
        "scope": {
            "audio": "server audio start metadata",
            "interrupt": "client mechanical stop; human-audible stop remains unverified",
            "speech_input": "real supplied PCM; transcript content omitted",
        },
        "lessons": len(lessons),
        "metrics": metrics,
    }
    metrics["interrupt_to_stop_ms"]["measurement"] = "client_mechanical_proxy"
    rendered = json.dumps(output, indent=2, ensure_ascii=False)
    print(rendered)
    if args.output is not None:
        destination = args.output.resolve()
        if not destination.is_relative_to(OUTPUT_ROOT):
            raise ValueError("Output must stay under evals/out")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered + "\n", encoding="utf-8")
    return 0 if output["status"] == "measured" else 2


def self_check() -> None:
    values = [float(value) for value in range(1, 21)]
    assert percentile(values, 0.5) == 10.5
    assert percentile(values, 0.9) == 18.1
    report = summarize({name: values.copy() for name in METRICS}, 20)
    assert all(row["status"] == "measured" for row in report.values())
    header = struct.pack(">4sIIHH", b"CSA1", 3, 7, 0, 0)
    assert struct.unpack(">4sIIHH", header)[:3] == (b"CSA1", 3, 7)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=__doc__,
        epilog=(
            'Plan shape: {"lessons":[{"lesson_id":"...","actions":['
            '{"kind":"answer","value":"A"},'
            '{"kind":"utterance","pcm_path":"answer.pcm"},'
            '{"kind":"answer","interrupt":true}]}]}'
        ),
    )
    result.add_argument("--base-url", default="http://127.0.0.1:8000", help="running local API origin")
    result.add_argument("--owner-token", help="owner bearer token; never written to output")
    result.add_argument("--isolated-data-dir", type=Path, help="server data directory under evals/out/data")
    result.add_argument("--plan", type=Path, help="JSON plan of prepared lesson IDs and real actions")
    result.add_argument("--minimum-samples", type=int, default=20)
    result.add_argument("--timeout", type=float, default=60)
    result.add_argument("--output", type=Path, help="optional JSON report path under evals/out")
    result.add_argument("--self-check", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.self_check:
        self_check()
        print(json.dumps({"status": "passed", "check": "latency_probe_self_check"}))
        return 0
    missing = [name for name in ("owner_token", "isolated_data_dir", "plan") if getattr(args, name) is None]
    if missing:
        parser().error("required for a real run: " + ", ".join(f"--{name.replace('_', '-')}" for name in missing))
    if args.minimum_samples < 20:
        parser().error("--minimum-samples must be at least 20")
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
