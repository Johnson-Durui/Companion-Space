from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.services.companion import SessionNotFoundError


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _realtime_origin(client) -> str:
    return str(client.base_url).rstrip("/")


def _create_space_and_session(client, owner_token: str) -> tuple[str, str]:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Realtime capability space"},
    )
    assert space.status_code == 201
    session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space.json()["id"]},
    )
    assert session.status_code == 201
    return space.json()["id"], session.json()["id"]


@pytest.mark.parametrize("capability", ["stt", "tts"])
def test_realtime_ticket_requires_explicit_audio_assignments(
    client,
    owner_token: str,
    capability: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": f"Missing {capability}"},
    ).json()
    removed = client.delete(
        f"/api/v1/spaces/{space['id']}/assignments/{capability}",
        headers=headers,
    )
    assert removed.status_code == 204
    session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space["id"]},
    ).json()

    response = client.post(
        f"/api/v1/sessions/{session['id']}/realtime-ticket",
        headers=headers,
    )

    assert response.status_code == 424
    assert response.json()["code"] == "provider_configuration_error"
    assert capability in response.json()["detail"]
    assert "ticket" not in response.json()


def test_realtime_ticket_returns_404_for_missing_session(
    client,
    owner_token: str,
) -> None:
    response = client.post(
        "/api/v1/sessions/session-does-not-exist/realtime-ticket",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Session not found"}


def test_realtime_ticket_reports_missing_character_as_conflict(
    client,
    owner_token: str,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    container = get_container()
    session = container.companion.get_session(session_id)
    assert session.character_pack_id is not None
    with container.repository.connection() as connection:
        connection.execute(
            "DELETE FROM character_packs WHERE id = ?",
            (session.character_pack_id,),
        )

    response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Session character is unavailable"}


def test_realtime_websocket_rejects_stale_session_with_404_close_code(
    client,
    owner_token: str,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    ticket_response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert ticket_response.status_code == 200
    ticket = ticket_response.json()["ticket"]

    container = get_container()
    with container.repository.connection() as connection:
        connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        with pytest.raises(WebSocketDisconnect) as rejected:
            websocket.receive_json()

    assert rejected.value.code == 4404


def test_realtime_websocket_rejects_stale_character_with_conflict_close_code(
    client,
    owner_token: str,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    ticket_response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert ticket_response.status_code == 200
    ticket = ticket_response.json()["ticket"]

    container = get_container()
    session = container.companion.get_session(session_id)
    assert session.character_pack_id is not None
    with container.repository.connection() as connection:
        connection.execute(
            "DELETE FROM character_packs WHERE id = ?",
            (session.character_pack_id,),
        )

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        with pytest.raises(WebSocketDisconnect) as rejected:
            websocket.receive_json()

    assert rejected.value.code == 4409


def test_realtime_interrupt_can_explicitly_clear_buffered_audio_before_commit(
    client,
    owner_token: str,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    ticket_response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    assert ticket_response.status_code == 200
    ticket = ticket_response.json()["ticket"]

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x01\x00" * 320)
        partial = websocket.receive_json()
        assert partial["type"] == "asr.partial"
        assert partial["state"] == "listening"

        websocket.send_json(
            {
                "type": "turn.interrupt",
                "payload": {"clear_audio_buffer": True},
            }
        )
        interrupted = websocket.receive_json()
        assert interrupted["type"] == "turn.interrupted"
        assert interrupted["state"] == "idle"
        assert interrupted["payload"] == {"active": False}

        websocket.send_json({"type": "user.commit", "payload": {}})
        final = websocket.receive_json()
        assert final["type"] == "asr.final"
        assert final["payload"]["text"] == "继续陪我学习。"
        assert final["payload"]["audio_bytes"] == 0


def test_realtime_interrupt_preserves_barge_in_audio_by_default(
    client,
    owner_token: str,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    ticket_response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    ticket = ticket_response.json()["ticket"]

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_bytes(b"\x01\x00" * 320)
        assert websocket.receive_json()["type"] == "asr.partial"

        websocket.send_json({"type": "turn.interrupt", "payload": {}})
        interrupted = websocket.receive_json()
        assert interrupted["type"] == "turn.interrupted"
        assert interrupted["payload"] == {"active": False}

        websocket.send_json({"type": "user.commit", "payload": {}})
        final = websocket.receive_json()
        assert final["type"] == "asr.final"
        assert final["payload"]["audio_bytes"] == 640


def test_realtime_background_turn_closes_when_session_disappears(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, session_id = _create_space_and_session(client, owner_token)
    ticket_response = client.post(
        f"/api/v1/sessions/{session_id}/realtime-ticket",
        headers=_auth_headers(owner_token),
    )
    ticket = ticket_response.json()["ticket"]
    container = get_container()

    async def missing_session_stream(**_kwargs):
        if False:
            yield None
        raise SessionNotFoundError("Session not found")

    monkeypatch.setattr(
        container.companion,
        "stream_text_turn",
        missing_session_stream,
    )

    with client.websocket_connect(
        f"/api/v1/sessions/{session_id}/realtime",
        subprotocols=["companion-v1", f"ticket.{ticket}"],
        headers={"origin": _realtime_origin(client)},
    ) as websocket:
        assert websocket.receive_json()["type"] == "session.open"
        websocket.send_json(
            {
                "type": "user.commit",
                "payload": {"text": "keep this task deterministic"},
            }
        )
        assert websocket.receive_json()["type"] == "asr.final"
        with pytest.raises(WebSocketDisconnect) as closed:
            websocket.receive_json()

    assert closed.value.code == 4404
