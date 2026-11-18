from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode

import pytest

from app.core.config import Settings
from app.repositories.mixins.common import _to_db, utcnow
from app.services.generation import GenerationGuard
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService


def test_one_time_lesson_ticket_rejects_wrong_lesson_concurrency_and_expiration(tmp_path: Path) -> None:
    settings = Settings(object_storage_path=str(tmp_path))
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    vault.initialize("test-password-only")
    owner_token = vault.issue_owner_token()
    owner = repository.get_owner_session(owner_token)
    assert owner is not None

    ticket, expiry = vault.issue_realtime_ticket(owner_token, session_id="first-lesson")
    assert expiry > utcnow()
    assert vault.consume_realtime_ticket(ticket, session_id="other-lesson") is None
    with ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(
            lambda _: vault.consume_realtime_ticket(ticket, session_id="first-lesson"),
            range(20),
        ))
    assert results.count(owner.id) == 1
    expired, _ = vault.issue_realtime_ticket(owner_token, session_id="first-lesson")
    with repository.connection() as conn:
        conn.execute(
            "UPDATE realtime_tickets SET expires_at = ? WHERE token_hash = ?",
            (_to_db(utcnow() - timedelta(seconds=3)), repository.hash_token(expired)),
        )
    assert vault.consume_realtime_ticket(expired, session_id="first-lesson") is None

    revoked, _ = vault.issue_realtime_ticket(owner_token, session_id="first-lesson")
    vault.lock()
    assert vault.consume_realtime_ticket(revoked, session_id="first-lesson") is None


def test_websocket_auth_rejects_url_tokens_and_origin_before_consuming(tmp_path: Path) -> None:
    from starlette.websockets import WebSocket

    from app.api.realtime_auth import REALTIME_PROTOCOL, authorize_websocket, extract_ticket

    settings = Settings(object_storage_path=str(tmp_path))
    vault = VaultService(settings, SQLiteRepository(settings))
    vault.initialize("test-password-only")
    owner_token = vault.issue_owner_token()
    ticket, _ = vault.issue_realtime_ticket(owner_token, session_id="protected-lesson")
    protocols = f"{REALTIME_PROTOCOL}, ticket.{ticket}"
    assert extract_ticket(f"{protocols}, ticket.other") is None

    async def scenario() -> None:
        async def authorize(origin: str, query: dict | None = None) -> tuple[str | None, list]:
            sent = []

            async def receive():
                raise AssertionError("Authorization should not receive frames")

            async def send(message):
                sent.append(message)

            connection = WebSocket(
                {
                    "type": "websocket",
                    "scheme": "ws",
                    "path": "/api/v2/lessons/protected-lesson/live",
                    "query_string": urlencode(query or {}).encode(),
                    "headers": [
                        (b"host", b"127.0.0.1:8765"),
                        (b"origin", origin.encode()),
                        (b"sec-websocket-protocol", protocols.encode()),
                    ],
                },
                receive,
                send,
            )
            value = await authorize_websocket(connection, settings=settings, vault=vault, lesson_id="protected-lesson")
            return value, sent

        outcome, rejected = await authorize("https://unrelated.example")
        assert outcome is None and rejected[0]["code"] == 4403
        outcome, rejected = await authorize("http://127.0.0.1:8765", {"ticket": ticket})
        assert outcome is None and rejected[0]["code"] == 4401
        accepted, sent = await authorize("http://127.0.0.1:8765")
        assert accepted and sent == []
        outcome, rejected = await authorize("http://127.0.0.1:8765")
        assert outcome is None and rejected[0]["code"] == 4401

    asyncio.run(scenario())


def test_generation_interrupt_cancels_old_work_and_ignores_late_cleanup() -> None:
    async def scenario() -> None:
        guard = GenerationGuard()
        never = asyncio.Event()
        first = guard.reserve()
        task = asyncio.create_task(never.wait())
        guard.bind(first, task)
        assert guard.is_current(first)
        with pytest.raises(ValueError):
            guard.reserve()

        assert guard.interrupt() is task and not guard.is_current(first)
        with pytest.raises(asyncio.CancelledError):
            await task

        second = guard.reserve()
        next_task = asyncio.create_task(never.wait())
        guard.bind(second, next_task)
        guard.finish(first)
        assert guard.is_current(second)
        assert guard.interrupt() is next_task
        with pytest.raises(asyncio.CancelledError):
            await next_task

    asyncio.run(scenario())
