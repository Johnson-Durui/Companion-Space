import asyncio
import time

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.main import create_app
from fakes.e2e import BrowserHarnessGateway, seed_classroom

_COURSE_ID = "browser-voice-course"
_LESSON_ID = "browser-voice-lesson"
_ROOM = f"/api/v2/lessons/{_LESSON_ID}"


class SlowStreamingGateway(BrowserHarnessGateway):
    async def stream_text(self, role, system, messages, **options):
        yield "<say>The first complete sentence is ready.</say>"
        await asyncio.sleep(10)


class CountingStreamingGateway(BrowserHarnessGateway):
    def __init__(self, registry):
        super().__init__(registry)
        self.stream_calls = 0

    async def stream_text(self, role, system, messages, **options):
        self.stream_calls += 1
        async for chunk in super().stream_text(role, system, messages, **options):
            yield chunk


def _receive_through(socket, kind):
    events = []
    for _ in range(20):
        event = socket.receive_json()
        events.append(event)
        if event["type"] == kind:
            return events
    pytest.fail(f"No {kind} in the received classroom events")


def test_live_room_rejects_reused_tickets_and_replays_after_interrupt(isolated_settings):
    app = create_app(gateway_factory=CountingStreamingGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")
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
            visual = next(row for row in rows if row["type"] == "board.preview")
            preview = next(row for row in rows if row["type"] == "say.preview")
            assert rows.index(visual) < rows.index(preview)
            assert visual["data"]["type"] == "board"
            assert preview["seq"] == 0
            assert not any(row["type"] == "beat.end" for row in rows)
            assert rows[-1]["data"]["format"] == "browser"
            assert rows[-1]["data"]["last"]
            rows.extend(_receive_through(socket, "say"))
            assert any(row["type"] == "board" for row in rows)
            spoken = next(row for row in rows if row["type"] == "say")
            for _ in range(50):
                if container.gateway.stream_calls >= 2:
                    break
                time.sleep(0.01)
            assert container.gateway.stream_calls >= 2
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


def test_live_room_can_interrupt_a_streamed_sentence_before_the_beat_commits(isolated_settings):
    app = create_app(gateway_factory=SlowStreamingGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        container.vault.bootstrap()
        owner = container.vault.issue_owner_token()
        headers = {"Authorization": f"Bearer {owner}"}
        voice_settings = {"default": {"engine": "browser", "voice_id": ""}, "characters": {}}
        assert client.put("/api/v2/voice/settings", headers=headers, json=voice_settings).is_success
        ticket = client.post(f"{_ROOM}/ticket", headers=headers).json()["ticket"]
        protocols = ["companion-v1", f"ticket.{ticket}"]
        origin = {"Origin": "http://127.0.0.1:8000"}
        with client.websocket_connect(f"{_ROOM}/live", subprotocols=protocols, headers=origin) as socket:
            socket.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": True}})
            rows = _receive_through(socket, "audio")
            preview = next(row for row in rows if row["type"] == "say.preview")
            assert preview["gen"] == 1 and preview["seq"] == 0
            socket.send_json({
                "type": "student.interrupt", "data": {"gen": preview["gen"], "heard_seq": 0},
            })
            cancelled = _receive_through(socket, "beat.cancelled")[-1]
            assert cancelled["gen"] == preview["gen"] and cancelled["seq"] == 0
        lesson = container.repository.get_lesson(_COURSE_ID, _LESSON_ID)
        assert lesson["gen"] == 0 and lesson["seq"] == 0
