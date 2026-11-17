from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.main import create_app
from fakes.e2e import BrowserHarnessGateway, seed_classroom

_ROOM = "/api/v2/lessons/browser-lesson"


def _receive_through(socket, kind):
    events = []
    for _ in range(20):
        event = socket.receive_json()
        events.append(event)
        if event["type"] == kind:
            return events
    pytest.fail(f"No {kind} in the received classroom events")


def test_live_room_rejects_reused_tickets_and_replays_after_interrupt(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container)
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        container.vault.bootstrap()
        owner = container.vault.issue_owner_token()
        headers = {"Authorization": f"Bearer {owner}"}
        assert client.post(f"{_ROOM}/ticket").status_code == 401
        initial = client.get(_ROOM, headers=headers).json()
        assert initial["status"] == "active"
        voice_settings = {"default": {"engine": "browser", "voice_id": ""}, "characters": {}}
        assert client.put("/api/v2/voice/settings", headers=headers, json=voice_settings).is_success
        ticket = client.post(f"{_ROOM}/ticket", headers=headers).json()["ticket"]
        protocols = ["companion-v1", f"ticket.{ticket}"]
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"{_ROOM}/live", subprotocols=protocols, headers={"Origin": "http://evil.test"}):
                pass
        origin = {"Origin": "http://127.0.0.1:8000"}
        with client.websocket_connect(f"{_ROOM}/live", subprotocols=protocols, headers=origin) as socket:
            socket.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": True}})
            rows = _receive_through(socket, "audio")
            assert any(row["type"] == "board" for row in rows)
            spoken = next(row for row in rows if row["type"] == "say")
            assert rows[-1]["data"]["format"] == "browser"
            assert rows[-1]["data"]["last"]
            socket.send_json({
                "type": "student.interrupt", "data": {"gen": spoken["gen"], "heard_seq": spoken["seq"] - 1},
            })
            cancelled = _receive_through(socket, "beat.cancelled")[-1]
            assert cancelled["data"]["heard_seq"] == spoken["seq"] - 1
            assert cancelled["seq"] > spoken["seq"]
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"{_ROOM}/live", subprotocols=protocols, headers=origin):
                pass
        rows = client.get(f"{_ROOM}/events", headers=headers, params={"after": spoken["seq"]}).json()
        assert [row["seq"] for row in rows] == list(range(spoken["seq"] + 1, rows[-1]["seq"] + 1))
        assert any(row["type"] == "beat.cancelled" for row in rows)
