from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

from fastapi import WebSocket

from app.core.config import Settings
from app.services.browser_session import is_allowed_browser_origin
from app.services.vault import VaultService

REALTIME_PROTOCOL = "companion-v1"
_TICKET_PREFIX = "ticket."


def extract_ticket(header: str | None) -> str | None:
    protocols = [item.strip() for item in (header or "").split(",")]
    tickets = [item.removeprefix(_TICKET_PREFIX) for item in protocols if item.startswith(_TICKET_PREFIX)]
    if REALTIME_PROTOCOL not in protocols or len(tickets) != 1:
        return None
    return tickets[0] or None


def origin_allowed(websocket: WebSocket, settings: Settings) -> bool:
    origin = websocket.headers.get("origin")
    scheme = "https" if websocket.url.scheme == "wss" else "http"
    try:
        host = urlsplit(f"{scheme}://{websocket.headers.get('host', '')}")
        return origin is not None and is_allowed_browser_origin(origin, scheme, host.hostname, host.port, settings)
    except ValueError:
        return False


async def authorize_websocket(
    websocket: WebSocket, *, settings: Settings, vault: VaultService, lesson_id: str,
) -> str | None:
    if any(name in websocket.query_params for name in ("token", "owner_token", "ticket")):
        await websocket.close(code=4401, reason="Owner session required")
        return None
    if not origin_allowed(websocket, settings):
        await websocket.close(code=4403, reason="Origin not allowed")
        return None
    ticket = extract_ticket(websocket.headers.get("sec-websocket-protocol"))
    owner = await asyncio.to_thread(vault.consume_realtime_ticket, ticket, session_id=lesson_id) if ticket else None
    if owner is None:
        await websocket.close(code=4401, reason="Owner session required")
    return owner
