from __future__ import annotations

import asyncio
import base64
import json
import os
from contextlib import suppress
from dataclasses import dataclass
from time import monotonic
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from adapter_base import BaseAvatarRenderer
from adapters.anime_2d_reference import Anime2DReferenceRenderer
from adapters.gpu_bridge_template import LocalGpuBridgeTemplate
from protocol import (
    CapabilitiesResponse,
    CloseSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    decode_tsva_frame,
    encode_tsvf_frame,
)


def _parse_resolution(value: str) -> tuple[int, int]:
    parts = value.lower().split("x", 1)
    if len(parts) != 2:
        return 384, 682
    try:
        width = max(256, min(720, int(parts[0])))
        height = max(256, min(1280, int(parts[1])))
        return width, height
    except ValueError:
        return 384, 682


def _build_renderer(adapter_name: str) -> BaseAvatarRenderer:
    if adapter_name == "gpu_bridge":
        return LocalGpuBridgeTemplate()
    return Anime2DReferenceRenderer()


@dataclass
class SidecarSession:
    session_id: str
    renderer: BaseAvatarRenderer
    fps: int
    width: int
    height: int
    created_at: float
    current_gen: int = 0


def create_sidecar_app(adapter_name: str | None = None) -> FastAPI:
    selected = (adapter_name or os.environ.get("AVATAR_ADAPTER") or "anime_2d_reference").strip().lower()
    probe_instance = _build_renderer(selected)
    sessions: dict[str, SidecarSession] = {}

    app = FastAPI(title="Companion Space Local GPU Avatar Sidecar", version="0.1.0")

    @app.get("/v1/avatar/capabilities", response_model=CapabilitiesResponse)
    async def capabilities() -> CapabilitiesResponse:
        return CapabilitiesResponse(
            driver_name=probe_instance.driver_name,
            license=probe_instance.license_name,
            transports=["ws_frames"],
            max_fps=25,
            supported_resolutions=["384x682", "512x896"],
            supports_single_image=True,
            gpu_info=probe_instance.gpu_info,
            ready=True,
        )

    @app.post("/v1/avatar/sessions", response_model=CreateSessionResponse, status_code=201)
    async def create_session(payload: CreateSessionRequest) -> CreateSessionResponse:
        try:
            anchor_bytes = base64.b64decode(payload.anchor_image_b64, validate=True)
        except Exception as exc:
            raise HTTPException(400, "Invalid base64 anchor_image_b64") from exc
        width, height = _parse_resolution(payload.resolution)
        renderer = _build_renderer(selected)
        try:
            await asyncio.to_thread(renderer.load_anchor, anchor_bytes, width=width, height=height)
        except Exception as exc:
            renderer.close()
            raise HTTPException(400, f"Could not load anchor image: {exc}") from exc

        session_id = f"gpu-{uuid4().hex[:12]}"
        fps = max(10, min(25, payload.fps))
        sessions[session_id] = SidecarSession(
            session_id=session_id,
            renderer=renderer,
            fps=fps,
            width=width,
            height=height,
            created_at=monotonic(),
        )
        return CreateSessionResponse(
            session_id=session_id,
            transport="ws_frames",
            sdp_answer=None,
            stream_path=f"/v1/avatar/sessions/{session_id}/stream",
            fps=fps,
            width=width,
            height=height,
        )

    @app.delete("/v1/avatar/sessions/{session_id}", response_model=CloseSessionResponse)
    async def delete_session(session_id: str) -> CloseSessionResponse:
        session = sessions.pop(session_id, None)
        if session is None:
            return CloseSessionResponse(closed=False, active_sec=0.0)
        elapsed = round(max(0.0, monotonic() - session.created_at), 2)
        await asyncio.to_thread(session.renderer.close)
        return CloseSessionResponse(closed=True, active_sec=elapsed)

    @app.websocket("/v1/avatar/sessions/{session_id}/stream")
    async def stream_session(websocket: WebSocket, session_id: str) -> None:
        session = sessions.get(session_id)
        if session is None:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        await websocket.send_json({"type": "ready", "session_id": session_id, "fps": session.fps})
        stop_event = asyncio.Event()

        async def push_frames() -> None:
            interval = 1.0 / max(1, session.fps)
            started = monotonic()
            while not stop_event.is_set():
                elapsed = monotonic() - started
                payload, codec = await asyncio.to_thread(session.renderer.render_frame, elapsed)
                frame = encode_tsvf_frame(
                    gen=session.current_gen,
                    ts_ms=int(elapsed * 1000),
                    payload=payload,
                    codec=codec,
                )
                await websocket.send_bytes(frame)
                await asyncio.sleep(interval)

        producer = asyncio.create_task(push_frames())
        try:
            while True:
                packet = await websocket.receive()
                if packet["type"] == "websocket.disconnect":
                    break
                if packet.get("bytes") is not None:
                    audio = decode_tsva_frame(packet["bytes"])
                    if audio is not None:
                        session.current_gen = max(session.current_gen, audio.gen)
                        session.renderer.on_audio_pcm(
                            gen=audio.gen,
                            seg=audio.seg,
                            sample_rate=audio.sample_rate,
                            pcm16=audio.pcm16,
                        )
                elif packet.get("text") is not None:
                    try:
                        msg = json.loads(packet["text"])
                    except json.JSONDecodeError:
                        continue
                    kind = msg.get("type")
                    gen = int(msg.get("gen") or 0)
                    data = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                    if kind == "ping":
                        await websocket.send_json({"type": "pong", "t": data.get("t")})
                    elif kind == "pose":
                        session.current_gen = max(session.current_gen, gen)
                        session.renderer.on_pose(pose=str(data.get("pose") or "idle_companion"), gen=gen)
                    elif kind == "mood":
                        session.current_gen = max(session.current_gen, gen)
                        session.renderer.on_mood(
                            emotion=str(data.get("emotion") or "neutral"),
                            intensity=float(data.get("intensity") or 1.0),
                            gen=gen,
                        )
                    elif kind == "instant_action":
                        session.current_gen = max(session.current_gen, gen)
                        session.renderer.on_instant_action(action=str(data.get("action") or "empathy_nod"), gen=gen)
                    elif kind == "interrupt":
                        session.current_gen = max(session.current_gen, gen)
                        session.renderer.on_interrupt(gen=gen)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            stop_event.set()
            producer.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await producer

    return app


app = create_sidecar_app()
