from __future__ import annotations

import asyncio
import json
import struct
import time

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.deps import get_container
from app.main import create_app
from app.providers.errors import MissingRoleError
from app.repositories.mixins.common import utcnow
from app.teaching.planner import LessonPlanner
from fakes.e2e import BrowserHarnessGateway, seed_classroom, seed_unprepared_lesson
from test_teaching_storage import _seed_plan

def _origin() -> dict[str, str]:
    return {"Origin": "http://127.0.0.1:8000"}


def _auth_headers(container) -> dict[str, str]:
    container.vault.bootstrap()
    owner = container.vault.issue_owner_token()
    return {"Authorization": f"Bearer {owner}"}


def _receive_through(socket, kind: str, *, limit: int = 30) -> list[dict]:
    events = []
    for _ in range(limit):
        event = socket.receive_json()
        events.append(event)
        if event["type"] == kind:
            return events
    pytest.fail(f"No {kind} event received within {limit} frames")


def _seed_unprepared_item(container, course_id: str, item_id: str, kp_id: str) -> None:
    now = utcnow().isoformat()
    with container.repository.connection() as conn:
        _seed_plan(conn, course_id, item_id)
        conn.execute(
            "UPDATE plan_items SET title = '函数极限与连续', est_minutes = 20, kp_ids_json = ? WHERE id = ?",
            (json.dumps([kp_id]), item_id),
        )
        conn.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, source_refs_json, created_at, updated_at)
               VALUES (?, ?, '函数极限', 'limit', 'concept', '理解极限定义', 'core', 2, 1, '[]', ?, ?)""",
            (kp_id, course_id, now, now),
        )
        conn.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES (?, ?, ?, 'generated', 'check', 'choice', '{}', 'verified', ?)""",
            (f"{item_id}-q1", course_id, kp_id, now),
        )


def test_b1_lesson_view_and_state_events_include_outline_progress_style_and_active_ms(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")
    room_url = "/api/v2/lessons/browser-voice-lesson"

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)
        view = client.get(room_url, headers=headers).json()
        assert view["est_minutes"] == 25
        assert view["active_ms"] == 0
        assert view["style_id"] is None or isinstance(view["style_id"], str)
        assert len(view["outline"]) == 1
        assert view["outline"][0]["kp_name"] == "关系判断"
        assert view["outline"][0]["text"] == "先确认条件"
        assert view["progress"] == {"seg_idx": 0, "kp_cursor": 0, "current_index": 1, "total": 1}

        ticket = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]
        with client.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{ticket}"], headers=_origin(),
        ) as socket:
            socket.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": False}})
            frames = _receive_through(socket, "state")
            state_event = frames[-1]
            assert "kp_cursor" in state_event["data"]
            assert "style_id" in state_event["data"]


def test_b12_prepare_idempotent_status_and_point_plan_item(isolated_settings, monkeypatch):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    course_id = "course-b12"
    item_id = "plan-item-b12"
    kp_id = "kp-b12"
    _seed_unprepared_item(container, course_id, item_id, kp_id)

    gate = asyncio.Event()
    calls: list[tuple[str, str]] = []

    async def fake_prepare(self, space_id: str, plan_item_id: str):
        calls.append((space_id, plan_item_id))
        await gate.wait()
        plan = {
            "title": "函数极限与连续",
            "est_minutes": 20,
            "segments": [{
                "id": "s1",
                "kp_id": kp_id,
                "keypoints": ["定义极限", "左右极限等价"],
                "checks": ["q1"],
                "approaches": [{"kind": "visual", "keypoint": "all", "outline": "画数轴"}],
            }],
            "items": {
                "q1": {
                    "type": "choice",
                    "kp_id": kp_id,
                    "bank_id": f"{item_id}-q1",
                    "keypoints": [0],
                    "stem": "极限存在的充要条件是什么？",
                    "answer": "A",
                    "verify": {"status": "verified"},
                    "options": [{"key": "A", "text": "左右极限存在且相等"}, {"key": "B", "text": "函数在该点有定义"}],
                },
            },
        }
        return self.repository.save_lesson_plan(space_id, plan_item_id, plan=plan)

    monkeypatch.setattr(LessonPlanner, "prepare", fake_prepare)

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)

        # Missing plan item
        missing = client.get("/api/v2/plan-items/does-not-exist/prepare-status", headers=headers)
        assert missing.status_code == 200
        assert missing.json()["status"] == "missing"

        # Create point plan item without preparing or creating a lesson
        pt1 = client.post(
            f"/api/v2/courses/{course_id}/point-plan-items", headers=headers, json={"kp_id": kp_id},
        )
        assert pt1.status_code == 200
        pt_id = pt1.json()["plan_item_id"]
        assert pt1.json()["course_id"] == course_id
        pt2 = client.post(
            f"/api/v2/courses/{course_id}/point-plan-items", headers=headers, json={"kp_id": kp_id},
        )
        assert pt2.status_code == 200
        assert pt2.json()["plan_item_id"] == pt_id
        assert container.repository.get_lesson_plan(course_id, pt_id) is None

        # Start preparing active plan item — idempotent, no percent field
        first = client.post(f"/api/v2/plan-items/{item_id}/prepare", headers=headers)
        assert first.status_code == 200
        first_body = first.json()
        assert first_body["status"] == "preparing"
        assert "progress" not in first_body
        assert first_body["started_at"] is not None

        second = client.post(f"/api/v2/plan-items/{item_id}/prepare", headers=headers)
        assert second.status_code == 200
        assert second.json()["status"] == "preparing"

        # Wait briefly so background job enters fake_prepare
        for _ in range(100):
            if calls:
                break
            time.sleep(0.01)
        assert calls == [(course_id, item_id)]

        # Calling existing open endpoint while preparing yields structured 409 code
        conflict = client.post(f"/api/v2/plan-items/{item_id}/lesson", headers=headers)
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "lesson_preparing"

        # Unblock preparation -> status transitions to ready with outline & teacher
        gate.set()
        ready_body = None
        for _ in range(100):
            resp = client.get(f"/api/v2/plan-items/{item_id}/prepare-status", headers=headers).json()
            if resp["status"] == "ready":
                ready_body = resp
                break
            time.sleep(0.02)
        assert ready_body is not None
        assert [p["text"] for p in ready_body["outline"]] == ["定义极限", "左右极限等价"]
        assert ready_body["teacher"] is not None

        # Open lesson via existing endpoint -> status becomes has_lesson
        opened = client.post(f"/api/v2/plan-items/{item_id}/lesson", headers=headers)
        assert opened.status_code == 200
        lesson_id = opened.json()["id"]

        after = client.get(f"/api/v2/plan-items/{item_id}/prepare-status", headers=headers).json()
        assert after["status"] == "has_lesson"
        assert after["lesson_id"] == lesson_id

        # On-demand point item also works through prepare -> ready -> open
        pt_prep = client.post(f"/api/v2/plan-items/{pt_id}/prepare", headers=headers)
        assert pt_prep.status_code == 200
        for _ in range(100):
            st = client.get(f"/api/v2/plan-items/{pt_id}/prepare-status", headers=headers).json()
            if st["status"] == "ready":
                break
            time.sleep(0.02)
        assert st["status"] == "ready"
        pt_open = client.post(f"/api/v2/plan-items/{pt_id}/lesson", headers=headers)
        assert pt_open.status_code == 200
        assert pt_open.json()["course_id"] == course_id


def test_b12_prepare_failure_reports_structured_error_code(isolated_settings, monkeypatch):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    course_id = "course-b12-fail"
    item_id = "plan-item-b12-fail"
    kp_id = "kp-b12-fail"
    _seed_unprepared_item(container, course_id, item_id, kp_id)

    async def fail_prepare(self, space_id: str, plan_item_id: str):
        raise MissingRoleError(provider="fixture", public_detail="Connect analysis model first")

    monkeypatch.setattr(LessonPlanner, "prepare", fail_prepare)

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)
        resp = client.post(f"/api/v2/plan-items/{item_id}/prepare", headers=headers)
        assert resp.status_code == 200
        failed_body = None
        for _ in range(100):
            st = client.get(f"/api/v2/plan-items/{item_id}/prepare-status", headers=headers).json()
            if st["status"] == "failed":
                failed_body = st
                break
            time.sleep(0.02)
        assert failed_body is not None
        assert failed_body["error_code"] == "model_role_missing"


def test_b14_websocket_takeover_closes_old_socket_and_accepts_new(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")
    room_url = "/api/v2/lessons/browser-voice-lesson"

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)
        t1 = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]
        t2 = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]
        t3 = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]

        with client.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t1}"], headers=_origin(),
        ) as sock1:
            # Second connection without takeover is rejected with 4409
            with pytest.raises(WebSocketDisconnect) as exc_no_takeover:
                with client.websocket_connect(
                    f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t2}"], headers=_origin(),
                ) as sock2:
                    sock2.receive_json()
            assert exc_no_takeover.value.code == 4409

            # Third connection WITH takeover closes sock1 (4409 taken_over) and works cleanly
            with client.websocket_connect(
                f"{room_url}/live?takeover=1", subprotocols=["companion-v1", f"ticket.{t3}"], headers=_origin(),
            ) as sock3:
                with pytest.raises(WebSocketDisconnect) as exc_old:
                    sock1.receive_json()
                assert exc_old.value.code == 4409
                assert exc_old.value.reason == "taken_over"

                sock3.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": False}})
                frames = _receive_through(sock3, "state")
                assert any(f["type"] == "say" for f in frames)


def test_backend_restart_recovers_live_lesson_without_and_with_master_password(isolated_settings):
    room_url = "/api/v2/lessons/browser-voice-lesson"

    # Process 1: start lesson and persist Beat 1
    app1 = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    c1 = app1.dependency_overrides[get_container]()
    seed_classroom(c1, "voice")
    with TestClient(app1, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client1:
        h1 = _auth_headers(c1)
        t1 = client1.post(f"{room_url}/ticket", headers=h1).json()["ticket"]
        with client1.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t1}"], headers=_origin(),
        ) as sock:
            sock.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": False}})
            frames = _receive_through(sock, "state")
            seq_after_beat1 = frames[-1]["seq"]
            assert seq_after_beat1 > 0

    # Process 2 (no master password): fresh container on same SQLite resumes seamlessly
    app2 = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    c2 = app2.dependency_overrides[get_container]()
    with TestClient(app2, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client2:
        boot = client2.post("/api/v2/session/bootstrap", headers=_origin())
        assert boot.status_code == 200
        assert boot.json()["state"] == "ready"
        h2 = _auth_headers(c2)
        view2 = client2.get(room_url, headers=h2).json()
        assert view2["seq"] == seq_after_beat1
        events2 = client2.get(f"{room_url}/events", headers=h2, params={"after": 0}).json()
        assert events2[-1]["seq"] == seq_after_beat1
        t2 = client2.post(f"{room_url}/ticket", headers=h2).json()["ticket"]
        with client2.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t2}"], headers=_origin(),
        ) as sock2:
            sock2.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": False}})
            resumed = _receive_through(sock2, "state")
            assert resumed[-1]["seq"] >= seq_after_beat1

        # Enable master password before simulating a second restart
        enable_pw = client2.put(
            "/api/v2/settings/security/password",
            headers={**h2, **_origin()},
            json={"password": "correct-horse-battery"},
        )
        assert enable_pw.status_code == 200
        saved_token = c2.vault.issue_owner_token()

    # Process 3 (master password enabled): old token gets 401 vault_locked; bootstrap reports locked;
    # after unlock the classroom resumes seamlessly from persisted SQLite state.
    app3 = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    with TestClient(app3, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client3:
        locked = client3.get(room_url, headers={"Authorization": f"Bearer {saved_token}"})
        assert locked.status_code == 401
        assert locked.json()["code"] == "vault_locked"

        boot_locked = client3.post("/api/v2/session/bootstrap", headers=_origin())
        assert boot_locked.status_code == 200
        assert boot_locked.json()["state"] == "locked"

        unlocked = client3.post(
            "/api/v2/session/unlock",
            headers=_origin(),
            json={"password": "correct-horse-battery"},
        )
        assert unlocked.status_code == 200
        assert unlocked.json()["state"] == "ready"
        resumed_view = client3.get(room_url)
        assert resumed_view.status_code == 200
        assert resumed_view.json()["seq"] >= seq_after_beat1


def test_e2e_unprepared_lesson_fixture_prepares_cleanly(isolated_settings):
    app = create_app(gateway_factory=BrowserHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_unprepared_lesson(container)
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)
        start = client.post("/api/v2/plan-items/browser-unprepared-item/prepare", headers=headers)
        assert start.status_code == 200
        assert start.json()["status"] == "preparing"
        ready = None
        for _ in range(150):
            st = client.get("/api/v2/plan-items/browser-unprepared-item/prepare-status", headers=headers).json()
            if st["status"] == "ready":
                ready = st
                break
            assert st["status"] != "failed", f"Unexpected prepare failure: {st}"
            time.sleep(0.02)
        assert ready is not None
        assert len(ready["outline"]) == 2
        opened = client.post("/api/v2/plan-items/browser-unprepared-item/lesson", headers=headers)
        assert opened.status_code == 200
        assert len(opened.json()["outline"]) == 2


class _AudioHarnessGateway(BrowserHarnessGateway):
    async def preview_voice(self, text, voice, rate=1, pitch=0):
        return b"ID3-test-mp3-frame"


def test_mid_beat_voice_resume_streams_matching_generation_without_stale_preview(isolated_settings):
    app = create_app(gateway_factory=_AudioHarnessGateway, settings=isolated_settings)
    container = app.dependency_overrides[get_container]()
    seed_classroom(container, "voice")
    room_url = "/api/v2/lessons/browser-voice-lesson"

    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000)) as client:
        headers = _auth_headers(container)
        t1 = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]
        with client.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t1}"], headers=_origin(),
        ) as sock1:
            sock1.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": False}})
            initial = _receive_through(sock1, "state")
            say_initial = [f for f in initial if f["type"] == "say"]
            assert len(say_initial) == 1
            beat_gen = say_initial[0]["gen"]
            beat_seq = say_initial[0]["seq"]

        t2 = client.post(f"{room_url}/ticket", headers=headers).json()["ticket"]
        with client.websocket_connect(
            f"{room_url}/live", subprotocols=["companion-v1", f"ticket.{t2}"], headers=_origin(),
        ) as sock2:
            sock2.send_json({"type": "lesson.control", "data": {"action": "resume", "audio": True}})
            json_frames: list[dict] = []
            binary_headers: list[tuple[bytes, int, int]] = []
            for _ in range(40):
                packet = sock2.receive()
                if packet.get("text") is not None:
                    frame = json.loads(packet["text"])
                    json_frames.append(frame)
                    if frame["type"] == "error":
                        pytest.fail(f"Unexpected classroom error frame: {frame}")
                    if frame["type"] == "audio" and frame["data"].get("last") is True:
                        break
                elif packet.get("bytes") is not None:
                    magic, gen, seg, _, _ = struct.unpack(">4sIIHH", packet["bytes"][:16])
                    binary_headers.append((magic, gen, seg))

            assert [f for f in json_frames if f["type"] == "say.preview"] == []
            audio_frames = [f for f in json_frames if f["type"] == "audio"]
            assert len(audio_frames) >= 2
            assert audio_frames[-1]["data"]["last"] is True
            assert all(f["gen"] == beat_gen and f["seq"] == beat_seq for f in audio_frames)
            assert binary_headers == [(b"CSA1", beat_gen, say_initial[0]["data"]["seg"])]

