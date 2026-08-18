from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
import sqlite3
from typing import Any

import pytest

from app.api.deps import get_container
from app.api.v1 import _derive_demo_topic
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.providers.errors import ProviderProtocolError
from app.services.demos import GeneratedLessonScript
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
        demo_raw: str | None = None,
        demo_delay_seconds: float = 0.0,
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
        self.demo_raw = demo_raw or json.dumps(
            {
                "title": "判别式演示",
                "steps": [
                    {
                        "board": {"kind": "markdown", "content": "定义：Δ = b^2 - 4ac"},
                        "caption": "先写定义。",
                        "narration": "第一步先把判别式的定义写出来。",
                    },
                    {
                        "board": {
                            "kind": "mermaid",
                            "content": "flowchart LR\\nA[Δ > 0] --> B[两个实根]\\nC[Δ = 0] --> D[重根]\\nE[Δ < 0] --> F[无实根]",
                        },
                        "caption": "再画出三种情况。",
                        "narration": "第二步把判别式和根的情况连起来。",
                    },
                    {
                        "board": {
                            "kind": "highlight",
                            "content": "符号决定根的类型",
                            "target": "Δ > 0",
                        },
                        "caption": "最后标出真正起作用的判断点。",
                        "narration": "第三步只记住判别式的符号会决定根的类型。",
                    },
                ],
            },
            ensure_ascii=False,
        )
        self.demo_delay_seconds = demo_delay_seconds
        self.cancelled = False

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
        raw_text = self.demo_raw if model == "mock-analysis-v1" else self.chat_raw
        try:
            if model == "mock-analysis-v1" and self.demo_delay_seconds:
                await asyncio.sleep(self.demo_delay_seconds)
            yield ProviderStreamChunk(
                text=raw_text,
                input_tokens=8,
                output_tokens=16,
            )
        except asyncio.CancelledError:
            self.cancelled = True
            raise

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


def test_bare_demo_topic_uses_user_history_or_space_fallback_only() -> None:
    assert (
        _derive_demo_topic(
            text="演示一下",
            user_history=["用户选择的二分查找主题"],
            fallback_topic="空间主题",
        )
        == "用户选择的二分查找主题"
    )
    assert (
        _derive_demo_topic(
            text="demo",
            user_history=[],
            fallback_topic="空间主题",
        )
        == "空间主题"
    )


def test_demo_request_topic_empty_and_overlong_boundaries_are_rejected_safely(
    client,
    owner_token: str,
) -> None:
    _, session = _create_space_and_session(client, owner_token, name="Demo topic edge")

    whitespace_topic = client.post(
        f"/api/v1/sessions/{session['id']}/demos",
        headers=_auth_headers(owner_token),
        json={"topic": "   "},
    )
    assert whitespace_topic.status_code == 400
    whitespace_payload = whitespace_topic.json()
    assert whitespace_payload["code"] == "invalid_request"
    assert whitespace_payload["detail"] == "Demo topic cannot be empty"

    too_long_topic = "x" * 241
    overlong = client.post(
        f"/api/v1/sessions/{session['id']}/demos",
        headers=_auth_headers(owner_token),
        json={"topic": too_long_topic},
    )
    assert overlong.status_code == 422
    assert overlong.json()["code"] == "validation_error"
    assert overlong.json()["detail"] == "Request validation failed"


def test_demo_service_rejects_overlong_topic_without_provider_call():
    container = get_container()
    space = container.spaces.create_space(name="Demo service bound", topic="math", goal="validate")
    session = container.companion.create_session(space_id=space.id)
    with pytest.raises(ValueError, match="Demo topic exceeds 240 characters"):
        asyncio.run(container.demos.create_demo(session_id=session.id, topic="x" * 241))


def test_m6_schema_contracts_cover_board_and_lesson_script(isolated_settings) -> None:
    conversation_schema = json.loads(
        (isolated_settings.schema_dir / "conversation_response.schema.json").read_text(encoding="utf-8")
    )
    lesson_schema = json.loads(
        (isolated_settings.schema_dir / "lesson_script.schema.json").read_text(encoding="utf-8")
    )

    assert "board_actions" in conversation_schema["properties"]
    assert conversation_schema["properties"]["board_actions"]["maxItems"] == 1
    assert lesson_schema["properties"]["steps"]["minItems"] == 3
    assert lesson_schema["properties"]["steps"]["maxItems"] == 8
    assert lesson_schema["properties"]["steps"]["items"]["required"] == [
        "board",
        "caption",
        "narration",
    ]

    generated_schema = GeneratedLessonScript.model_json_schema()
    assert generated_schema["properties"]["steps"]["minItems"] == 3
    assert generated_schema["properties"]["steps"]["maxItems"] == 8


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


@pytest.mark.parametrize(
    "demo_raw",
    [
        "not-json",
        json.dumps(
            {
                "title": "坏脚本",
                "steps": [
                    {
                        "board": {"kind": "markdown", "content": "one"},
                        "caption": "只有一步",
                        "narration": "不够。",
                    },
                    {
                        "board": {"kind": "markdown", "content": "two"},
                        "caption": "两步",
                        "narration": "还是不够。",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        json.dumps(
            {
                "title": "伪造引用",
                "steps": [
                    {
                        "board": {"kind": "markdown", "content": "one"},
                        "caption": "一步",
                        "narration": "一。",
                        "citations": [{"chunk_id": "fake"}],
                    },
                    {
                        "board": {"kind": "markdown", "content": "two"},
                        "caption": "二步",
                        "narration": "二。",
                    },
                    {
                        "board": {"kind": "markdown", "content": "three"},
                        "caption": "三步",
                        "narration": "三。",
                    },
                ],
            },
            ensure_ascii=False,
        ),
    ],
)
def test_demo_service_rejects_invalid_json_shape_and_forged_citations(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
    demo_raw: str,
) -> None:
    _ = isolated_settings
    _patch_provider_factory(monkeypatch, ScriptAwareProvider(demo_raw=demo_raw))
    container = get_container()
    space = container.spaces.create_space(name="Demo reject", topic="math", goal="demo")
    session = container.companion.create_session(space_id=space.id)

    with pytest.raises(ProviderProtocolError):
        asyncio.run(
            container.demos.create_demo(
                session_id=session.id,
                topic="判别式",
            )
        )


def test_demo_service_uses_same_space_citations_only_and_no_fake_empty_kb(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    _patch_provider_factory(monkeypatch, ScriptAwareProvider())
    container = get_container()

    first_space = container.spaces.create_space(name="First", topic="math", goal="demo")
    second_space = container.spaces.create_space(name="Second", topic="math", goal="demo")
    first_material, _ = container.spaces.ingest_note(
        space_id=first_space.id,
        title="First note",
        content="判别式 delta 决定一元二次方程实根数量。",
    )
    container.spaces.ingest_note(
        space_id=second_space.id,
        title="Second note",
        content="这份资料属于另一个空间。",
    )
    for space in (first_space, second_space):
        container.spaces.wait_for_ingestion(
            container.spaces.list_ingestion_jobs(space.id)[0].id,
            timeout_seconds=2.0,
        )

    first_session = container.companion.create_session(space_id=first_space.id)
    demo = asyncio.run(
        container.demos.create_demo(
            session_id=first_session.id,
            topic="判别式",
        )
    )
    assert demo["used_space_materials"] is True
    assert {item["material_id"] for item in demo["citations"]} == {first_material.id}
    assert GeneratedLessonScript.model_validate(demo["script"])

    empty_space = container.spaces.create_space(name="Empty", topic="math", goal="demo")
    empty_session = container.companion.create_session(space_id=empty_space.id)
    empty_demo = asyncio.run(
        container.demos.create_demo(
            session_id=empty_session.id,
            topic="还没有资料的主题",
        )
    )
    assert empty_demo["used_space_materials"] is False
    assert empty_demo["citations"] == []


def test_builtin_mock_demo_keeps_requested_topic_and_real_board_line_breaks(
    isolated_settings,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Mock lesson",
        topic="algorithms",
        goal="understand binary search",
    )
    session = container.companion.create_session(space_id=space.id)

    demo = asyncio.run(
        container.demos.create_demo(
            session_id=session.id,
            topic="二分查找为什么需要单调区间",
        )
    )

    script = GeneratedLessonScript.model_validate(demo["script"])
    assert "二分查找为什么需要单调区间" in script.title
    assert "\n" in script.steps[0].board.content
    assert "\\n" not in script.steps[0].board.content
    assert "\n" in script.steps[1].board.content
    assert "\\n" not in script.steps[1].board.content


def test_demo_endpoint_requires_owner_and_returns_canonical_envelope(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_provider_factory(monkeypatch, ScriptAwareProvider())
    unauthorized = client.post(
        "/api/v1/sessions/missing/demos",
        json={"topic": "判别式"},
    )
    assert unauthorized.status_code == 401

    space, session = _create_space_and_session(client, owner_token, name="Demo API")
    material = client.post(
        f"/api/v1/spaces/{space['id']}/materials/note",
        headers=_auth_headers(owner_token),
        json={"title": "资料", "content": "判别式决定实根数量。"},
    )
    assert material.status_code == 201
    get_container().spaces.wait_for_ingestion(
        get_container().spaces.list_ingestion_jobs(space["id"])[0].id,
        timeout_seconds=2.0,
    )

    response = client.post(
        f"/api/v1/sessions/{session['id']}/demos",
        headers=_auth_headers(owner_token),
        json={"topic": "判别式"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session["id"]
    assert payload["topic"] == "判别式"
    assert payload["used_space_materials"] is True
    assert payload["script"]["title"]
    assert len(payload["script"]["steps"]) >= 3
    assert payload["citations"]


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


def test_realtime_demo_ready_uses_canonical_payload(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_provider_factory(monkeypatch, ScriptAwareProvider())
    space, session = _create_space_and_session(client, owner_token, name="Realtime demo")
    client.post(
        f"/api/v1/spaces/{space['id']}/materials/note",
        headers=_auth_headers(owner_token),
        json={"title": "资料", "content": "判别式决定实根数量。"},
    )
    get_container().spaces.wait_for_ingestion(
        get_container().spaces.list_ingestion_jobs(space["id"])[0].id,
        timeout_seconds=2.0,
    )
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "演示一下 判别式"}})
        assert websocket.receive_json()["type"] == "asr.final"
        demo_ready = websocket.receive_json()

        assert demo_ready["type"] == "demo.ready"
        assert demo_ready["payload"]["session_id"] == session["id"]
        assert demo_ready["payload"]["topic"] == "判别式"
        assert demo_ready["payload"]["used_space_materials"] is True
        assert len(demo_ready["payload"]["script"]["steps"]) >= 3
        assert demo_ready["payload"]["citations"]


def test_realtime_demo_interrupt_leaves_no_partial_payload(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = ScriptAwareProvider(demo_delay_seconds=0.5)
    _patch_provider_factory(monkeypatch, provider)
    _, session = _create_space_and_session(client, owner_token, name="Realtime demo interrupt")
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json({"type": "user.commit", "payload": {"text": "演示一下 判别式"}})
        assert websocket.receive_json()["type"] == "asr.final"
        websocket.send_json({"type": "turn.interrupt", "payload": {}})
        interrupted = websocket.receive_json()
        assert interrupted["type"] == "turn.interrupted"
        assert interrupted["payload"] == {"active": True}
        websocket.send_json({"type": "heartbeat", "payload": {}})
        heartbeat = websocket.receive_json()
        assert heartbeat["type"] == "heartbeat"
        assert provider.cancelled is True


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


def test_realtime_demo_stops_before_ready_when_owner_session_is_revoked(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_provider_factory(
        monkeypatch,
        ScriptAwareProvider(demo_delay_seconds=0.1),
    )
    _, session = _create_space_and_session(
        client,
        owner_token,
        name="Realtime demo owner revocation",
    )
    ticket = _issue_realtime_ticket(client, owner_token, session["id"])

    with client.websocket_connect(
        f"/api/v1/sessions/{session['id']}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket['ticket']}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json(
            {"type": "user.commit", "payload": {"text": "演示一下 判别式"}}
        )
        assert websocket.receive_json()["type"] == "asr.final"
        locked = client.post(
            "/api/v1/vault/lock",
            headers=_auth_headers(owner_token),
        )
        assert locked.status_code == 200
        closed = websocket.receive()

    assert closed["type"] == "websocket.close"
    assert closed["code"] == 4401
