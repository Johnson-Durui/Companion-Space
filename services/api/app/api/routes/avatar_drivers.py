from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.realtime_auth import REALTIME_PROTOCOL, authorize_websocket
from app.avatar.protocol import (
    SidecarSessionCloseResponse,
    SidecarSessionRequest,
    SidecarSessionResponse,
    SidecarTestResult,
)
from app.avatar.settings import (
    AvatarDriverSettings,
    load_avatar_driver_settings,
    save_avatar_driver_settings,
)
from app.avatar.sidecar_client import bridge_sidecar_stream, probe_sidecar
from app.core.errors import ResourceNotFoundError
from app.providers.errors import ProviderConfigurationError

router = APIRouter(prefix="/avatar-drivers")
Container = Annotated[ServiceContainer, Depends(get_container)]
Owner = Annotated[str, Depends(require_owner)]


class SidecarProbeRequest(BaseModel):
    base_url: str = Field(min_length=1, max_length=512)
    allow_lan: bool = False


@router.get("/settings", response_model=AvatarDriverSettings)
async def get_avatar_driver_settings(container: Container, _: Owner) -> AvatarDriverSettings:
    return await asyncio.to_thread(load_avatar_driver_settings, container.repository)


@router.put("/settings", response_model=AvatarDriverSettings)
async def put_avatar_driver_settings(
    payload: AvatarDriverSettings, container: Container, _: Owner
) -> AvatarDriverSettings:
    return await asyncio.to_thread(save_avatar_driver_settings, container.repository, payload)


@router.post("/sidecars/test", response_model=SidecarTestResult)
async def test_local_sidecar(payload: SidecarProbeRequest, _: Owner) -> SidecarTestResult:
    return await probe_sidecar(payload.base_url, allow_lan=payload.allow_lan)


@router.post("/sidecar/sessions", response_model=SidecarSessionResponse, status_code=201)
async def create_sidecar_session(
    payload: SidecarSessionRequest, container: Container, owner: Owner
) -> SidecarSessionResponse:
    settings = await asyncio.to_thread(load_avatar_driver_settings, container.repository)
    enabled = [entry for entry in settings.local_sidecars if entry.enabled]
    target_id = payload.driver_id or settings.default_sidecar_id
    chosen = next((entry for entry in enabled if entry.id == target_id), None) if target_id else None
    if chosen is None and enabled:
        chosen = enabled[0]
    if chosen is None:
        raise HTTPException(
            400,
            detail={"code": "sidecar_not_configured", "message": "Configure and enable a local GPU sidecar first."},
        )

    anchor = await asyncio.to_thread(container.tutors.read_anchor_image, payload.character_id)
    if anchor is None:
        raise ResourceNotFoundError("Character anchor image is unavailable.")
    anchor_bytes, anchor_mime = anchor

    try:
        session, sdp_answer, width, height = await container.sidecars.create_session(
            base_url=chosen.base_url,
            allow_lan=chosen.allow_lan,
            character_id=payload.character_id,
            anchor_bytes=anchor_bytes,
            anchor_mime=anchor_mime,
            aspect_ratio=payload.aspect_ratio,
            fps=payload.fps,
            resolution=payload.resolution,
            transport_preference=chosen.transport_preference,
            sdp_offer=payload.sdp_offer,
        )
    except (ProviderConfigurationError, ValueError, Exception) as exc:
        raise HTTPException(
            502,
            detail={"code": "sidecar_unavailable", "message": str(exc)},
        ) from exc

    ticket, _expires_at = await asyncio.to_thread(
        container.vault.issue_realtime_ticket,
        owner,
        session_id=f"avatar:{session.proxy_id}",
    )
    return SidecarSessionResponse(
        session_id=session.proxy_id,
        transport=session.transport,
        sdp_answer=sdp_answer,
        stream_path=f"/api/v2/avatar-drivers/sidecar/sessions/{session.proxy_id}/stream",
        ticket=ticket,
        fps=payload.fps,
        width=width,
        height=height,
    )


@router.delete("/sidecar/sessions/{session_id}", response_model=SidecarSessionCloseResponse)
async def delete_sidecar_session(
    session_id: str, container: Container, _: Owner
) -> SidecarSessionCloseResponse:
    return await container.sidecars.close_session(session_id)


@router.websocket("/sidecar/sessions/{session_id}/stream")
async def sidecar_stream(websocket: WebSocket, session_id: str, container: Container) -> None:
    owner = await authorize_websocket(
        websocket,
        settings=container.settings,
        vault=container.vault,
        lesson_id=f"avatar:{session_id}",
    )
    if owner is None:
        return
    session = container.sidecars.get(session_id)
    if session is None:
        await websocket.close(code=4404)
        return
    await websocket.accept(subprotocol=REALTIME_PROTOCOL)
    try:
        await bridge_sidecar_stream(websocket, session)
    except Exception:
        with suppress(Exception):
            await websocket.close(code=1011)
    finally:
        await container.sidecars.close_session(session_id)
