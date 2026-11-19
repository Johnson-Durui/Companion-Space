from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
from dataclasses import dataclass
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

import aiohttp
import httpx
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.avatar.protocol import (
    SidecarCapabilities,
    SidecarSessionCloseResponse,
    SidecarTestResult,
    TransportMode,
    validate_sidecar_base_url,
)
from app.providers.errors import ProviderConfigurationError


@dataclass
class ActiveSidecarSession:
    proxy_id: str
    remote_id: str
    base_url: str
    allow_lan: bool
    stream_path: str
    transport: TransportMode
    created_at: float


def _http_to_ws_url(base_url: str, stream_path: str) -> str:
    parsed = urlsplit(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = stream_path if stream_path.startswith("/") else f"/{stream_path}"
    if ".." in path or "\\" in path:
        raise ValueError("Invalid sidecar stream path.")
    return f"{scheme}://{parsed.netloc}{path}"


async def probe_sidecar(
    base_url: str,
    *,
    allow_lan: bool = False,
    timeout: float = 5.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> SidecarTestResult:
    try:
        clean_url = validate_sidecar_base_url(base_url, allow_lan=allow_lan)
    except ProviderConfigurationError as exc:
        return SidecarTestResult(ok=False, latency_ms=0, error=exc.public_detail)

    started = monotonic()
    try:
        async with httpx.AsyncClient(
            base_url=f"{clean_url}/",
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        ) as client:
            response = await client.get("v1/avatar/capabilities")
        latency_ms = round((monotonic() - started) * 1000)
        if not 200 <= response.status_code < 300:
            return SidecarTestResult(
                ok=False,
                latency_ms=latency_ms,
                error=f"Sidecar returned HTTP {response.status_code}.",
            )
        capabilities = SidecarCapabilities.model_validate(response.json())
        return SidecarTestResult(ok=capabilities.ready, latency_ms=latency_ms, capabilities=capabilities)
    except httpx.TimeoutException:
        return SidecarTestResult(ok=False, latency_ms=round((monotonic() - started) * 1000), error="Sidecar timed out.")
    except (httpx.RequestError, ValueError) as exc:
        return SidecarTestResult(
            ok=False,
            latency_ms=round((monotonic() - started) * 1000),
            error=f"Sidecar unavailable: {type(exc).__name__}",
        )


class SidecarSessionRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, ActiveSidecarSession] = {}

    def get(self, proxy_id: str) -> ActiveSidecarSession | None:
        return self._sessions.get(proxy_id)

    async def create_session(
        self,
        *,
        base_url: str,
        allow_lan: bool,
        character_id: str,
        anchor_bytes: bytes,
        anchor_mime: str,
        aspect_ratio: str,
        fps: int,
        resolution: str,
        transport_preference: str,
        sdp_offer: str | None = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> tuple[ActiveSidecarSession, str | None, int, int]:
        clean_url = validate_sidecar_base_url(base_url, allow_lan=allow_lan)
        chosen_transport: TransportMode = (
            "webrtc" if transport_preference == "webrtc" and sdp_offer else "ws_frames"
        )
        payload = {
            "character_id": character_id,
            "anchor_image_b64": base64.b64encode(anchor_bytes).decode("ascii"),
            "anchor_mime": anchor_mime,
            "aspect_ratio": aspect_ratio,
            "fps": fps,
            "resolution": resolution,
            "transport": chosen_transport,
            "sdp_offer": sdp_offer,
        }
        async with httpx.AsyncClient(
            base_url=f"{clean_url}/",
            timeout=10.0,
            transport=http_transport,
            follow_redirects=False,
        ) as client:
            response = await client.post("v1/avatar/sessions", json=payload)
        if not 200 <= response.status_code < 300:
            raise ValueError(f"Sidecar rejected session creation (HTTP {response.status_code}).")
        data = response.json()
        remote_id = str(data.get("session_id") or "").strip()
        stream_path = str(data.get("stream_path") or f"/v1/avatar/sessions/{remote_id}/stream")
        if not remote_id:
            raise ValueError("Sidecar response is missing session_id.")
        remote_transport: TransportMode = "webrtc" if data.get("transport") == "webrtc" else "ws_frames"
        proxy_id = f"sv-{uuid4().hex}"
        session = ActiveSidecarSession(
            proxy_id=proxy_id,
            remote_id=remote_id,
            base_url=clean_url,
            allow_lan=allow_lan,
            stream_path=stream_path,
            transport=remote_transport,
            created_at=monotonic(),
        )
        self._sessions[proxy_id] = session
        width = int(data.get("width") or 512)
        height = int(data.get("height") or 896)
        return session, data.get("sdp_answer"), width, height

    async def close_session(
        self,
        proxy_id: str,
        *,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> SidecarSessionCloseResponse:
        session = self._sessions.pop(proxy_id, None)
        if session is None:
            return SidecarSessionCloseResponse(closed=False, active_sec=0.0)
        elapsed = round(max(0.0, monotonic() - session.created_at), 2)
        with suppress(httpx.HTTPError, ValueError):
            async with httpx.AsyncClient(
                base_url=f"{session.base_url}/",
                timeout=5.0,
                transport=http_transport,
                follow_redirects=False,
            ) as client:
                response = await client.delete(f"v1/avatar/sessions/{session.remote_id}")
                if 200 <= response.status_code < 300:
                    payload = response.json()
                    if isinstance(payload, dict) and isinstance(payload.get("active_sec"), (int, float)):
                        elapsed = float(payload["active_sec"])
        return SidecarSessionCloseResponse(closed=True, active_sec=elapsed)

    async def close_all(self) -> None:
        for proxy_id in list(self._sessions.keys()):
            await self.close_session(proxy_id)


async def bridge_sidecar_stream(browser_ws: WebSocket, session: ActiveSidecarSession) -> None:
    remote_url = _http_to_ws_url(session.base_url, session.stream_path)
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=5.0)
    async with aiohttp.ClientSession(timeout=timeout) as http_session:
        async with http_session.ws_connect(remote_url, max_msg_size=4 * 1024 * 1024) as remote_ws:
            async def browser_to_remote() -> None:
                while True:
                    packet = await browser_ws.receive()
                    if packet["type"] == "websocket.disconnect":
                        break
                    if packet.get("bytes") is not None:
                        await remote_ws.send_bytes(packet["bytes"])
                    elif packet.get("text") is not None:
                        await remote_ws.send_str(packet["text"])

            async def remote_to_browser() -> None:
                async for message in remote_ws:
                    if message.type == aiohttp.WSMsgType.BINARY:
                        await browser_ws.send_bytes(message.data)
                    elif message.type == aiohttp.WSMsgType.TEXT:
                        await browser_ws.send_text(message.data)
                    elif message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                        break

            upstream = asyncio.create_task(browser_to_remote())
            downstream = asyncio.create_task(remote_to_browser())
            try:
                done, pending = await asyncio.wait(
                    {upstream, downstream},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for task in done:
                    with suppress(WebSocketDisconnect, asyncio.CancelledError):
                        task.result()
            finally:
                with suppress(Exception):
                    await remote_ws.close()
