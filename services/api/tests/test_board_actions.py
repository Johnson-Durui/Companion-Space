from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
import sqlite3
from typing import Any

import pytest

from app.api.deps import get_container
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.services.repository import SQLiteRepository


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _realtime_origin(client) -> str:
    return str(client.base_url).rstrip("/")


def _issue_realtime_ticket(client, owner_token: str, session_id: str) -> dict[str, str]:
    response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 200
    return response.json()


class ScriptAwareProvider(LLMProvider):
    name = "script-aware"

    def __init__(
        self,
        *,
        chat_raw: str | None = None,
    ) -> None:
        self.chat_raw = chat_raw or json.dumps(
            {
                "display_text": "先看板书里的关键点。",
                "spoken_text": "先看板书里的关键点。",
                "emotion": "focused",
                "suggested_actions": [],
            },
            ensure_ascii=False,
        )
    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[Any],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = system_prompt
        _ = history
        _ = user_message
        yield ProviderStreamChunk(
            text=self.chat_raw,
            input_tokens=8,
            output_tokens=16,
        )

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        *,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        _ = model
        _ = text
        _ = voice_id
        _ = speed
        _ = sample_rate_hz
        yield b"\x11\x00" * 120


def _patch_provider_factory(
    monkeypatch: pytest.MonkeyPatch,
    provider: LLMProvider,
) -> None:
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: provider,
    )


def _create_space_and_session(client, owner_token: str, *, name: str) -> tuple[dict, dict]:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": name, "topic": "math", "goal": "understand quadratics"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()
    return space, session


def test_repository_migrates_legacy_turns_table_with_board_actions_column(isolated_settings) -> None:
    isolated_settings.storage_root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE study_spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                topic TEXT NOT NULL,
                goal TEXT NOT NULL,
                default_character_pack_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                character_pack_id TEXT,
                state TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                ended_at TEXT
            );
            CREATE TABLE turns (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                space_id TEXT NOT NULL,
                role TEXT NOT NULL,
                display_text TEXT NOT NULL,
                spoken_text TEXT NOT NULL,
                emotion TEXT NOT NULL,
                citations_json TEXT NOT NULL,
                suggested_actions_json TEXT NOT NULL,
                usage_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO study_spaces VALUES ('space', 'Space', '', '', NULL, '2026-01-01', '2026-01-01');
            INSERT INTO sessions VALUES ('session', 'space', NULL, 'idle', '', '2026-01-01', '2026-01-01', NULL);
            INSERT INTO turns VALUES (
                'turn',
                'session',
                'space',
                'assistant',
                '旧回复',
                '旧回复',
                'warm',
                '[]',
                '[]',
                '{"input_tokens":1,"output_tokens":1,"audio_input_bytes":0,"audio_output_bytes":0}',
                '2026-01-01'
            );
            """
        )

    repository = SQLiteRepository(isolated_settings)
    turns = repository.list_turns("session")

    assert len(turns) == 1
    assert turns[0].board_actions == []
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(turns)").fetchall()
        }
        row = connection.execute(
            "SELECT board_actions_json, created_at FROM turns WHERE id = ?",
            ("turn",),
        ).fetchone()
    assert "board_actions_json" in columns
    assert row == ("[]", "2026-01-01")


def test_companion_turn_persists_valid_board_action_and_rejects_forged_citations(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    provider = ScriptAwareProvider(
        chat_raw=json.dumps(
            {
                "display_text": "看这里。",
                "spoken_text": "看这里。",
                "emotion": "focused",
                "board_actions": [
                    {
                        "kind": "markdown",
                        "content": "- 判别式\\n- 根的数量",
                    }
                ],
                "suggested_actions": [],
                "citations": [
                    {
                        "chunk_id": "forged",
                        "material_id": "forged",
                        "title": "fake",
                        "locator": "nope",
                    }
                ],
            },
            ensure_ascii=False,
        )
    )
    _patch_provider_factory(monkeypatch, provider)
    container = get_container()
    space = container.spaces.create_space(name="Board persist", topic="math", goal="board")
    material, _ = container.spaces.ingest_note(
        space_id=space.id,
        title="真实资料",
        content="判别式决定一元二次方程的实根数量。",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(space.id)[0].id,
        timeout_seconds=2.0,
    )
    session = container.companion.create_session(space_id=space.id)

    turn = asyncio.run(
        container.companion.submit_text_turn(
            session_id=session.id,
            text="请在白板上画一下判别式重点。",
        )
    )

    assert len(turn.board_actions) == 1
    assert turn.board_actions[0].kind.value == "markdown"
    assert {citation.material_id for citation in turn.citations} == {material.id}
    assert all(citation.material_id != "forged" for citation in turn.citations)
    stored = container.repository.list_turns(session.id)[1]
    assert stored.board_actions == turn.board_actions


def test_companion_turn_drops_invalid_board_actions_without_failing(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    provider = ScriptAwareProvider(
        chat_raw=json.dumps(
            {
                "display_text": "先用文字解释。",
                "spoken_text": "先用文字解释。",
                "emotion": "warm",
                "board_actions": [
                    {
                        "kind": "highlight",
                        "content": "这里是重点"
                    }
                ],
                "suggested_actions": [],
            },
            ensure_ascii=False,
        )
    )
    _patch_provider_factory(monkeypatch, provider)
    container = get_container()
    space = container.spaces.create_space(name="Invalid board")
    session = container.companion.create_session(space_id=space.id)

    turn = asyncio.run(
        container.companion.submit_text_turn(
            session_id=session.id,
            text="照常回答就行。",
        )
    )

    assert turn.display_text.startswith("先用文字解释")
    assert turn.board_actions == []


def test_realtime_board_update_emits_before_llm_final(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = ScriptAwareProvider(
        chat_raw=json.dumps(
            {
                "display_text": "看白板。",
                "spoken_text": "看白板。",
                "emotion": "focused",
                "board_actions": [
                    {"kind": "markdown", "content": "- 判别式\\n- 根的数量"}
                ],
                "suggested_actions": [],
            },
            ensure_ascii=False,
        )
    )
    _patch_provider_factory(monkeypatch, provider)
    space, session = _create_space_and_session(client, owner_token, name="Realtime board")
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "请在白板上画一下重点。"}})
        assert websocket.receive_json()["type"] == "asr.final"
        event_types: list[str] = []
        while True:
            event = websocket.receive_json()
            event_types.append(event["type"])
            if event["type"] == "llm.final":
                break

        assert "board.update" in event_types
        assert event_types.index("board.update") < event_types.index("llm.final")


def test_realtime_interrupt_without_remote_turn_is_an_idle_noop(
    client,
    owner_token: str,
) -> None:
    _, session = _create_space_and_session(
        client,
        owner_token,
        name="Realtime idle interrupt",
    )
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "turn.interrupt", "payload": {}})
        interrupted = websocket.receive_json()

    assert interrupted["type"] == "turn.interrupted"
    assert interrupted["state"] == "idle"
    assert interrupted["payload"] == {"active": False}
