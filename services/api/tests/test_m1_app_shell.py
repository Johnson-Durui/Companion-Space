from __future__ import annotations

import base64
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import _serve_web, create_app
from fakes.e2e import BrowserHarnessGateway


def browser_client(isolated_settings, factory=None):
    return TestClient(
        create_app(gateway_factory=factory, settings=isolated_settings),
        base_url="http://127.0.0.1:8000",
        client=("127.0.0.1", 51000),
    )


def authenticate(client):
    state = client.post("/api/v2/session/bootstrap")
    assert state.status_code == 200
    assert state.json()["state"] == "ready"
    return {"Origin": str(client.base_url).rstrip("/"), "X-CSRF-Token": client.cookies["companion_csrf"]}


def stream_events(response):
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines()]


def test_catalog_and_default_character_persist_across_a_fresh_app(isolated_settings):
    with browser_client(isolated_settings) as browser:
        headers = authenticate(browser)
        tutors = browser.get("/api/v2/characters").json()
        assert len(tutors) == 6
        assert all(tutor["schema_version"] == 3 for tutor in tutors)
        assert all(tutor["appearance"]["kind"] in {"portrait", "video_pack"} for tutor in tutors)
        portrait = next(tutor for tutor in tutors if tutor["id"] == "tutor-chutang")
        assert browser.get(portrait["appearance"]["src"]).headers["content-type"] == "image/webp"
        legacy_path = f"/api/v1/characters/{portrait['id']}"
        assert browser.delete(legacy_path, headers=headers).status_code == 404
        changed = browser.put("/api/v2/settings/default-character", headers=headers, json={"character_id": portrait["id"]})
        assert changed.status_code == 200
        missing = browser.put("/api/v2/settings/default-character", headers=headers, json={"character_id": "retired"})
        assert missing.status_code == 404

    with browser_client(isolated_settings) as restarted:
        authenticate(restarted)
        assert restarted.get("/api/v2/settings").json()["default_character_id"] == portrait["id"]


def test_real_gateway_requests_configuration_when_no_model_is_connected(isolated_settings):
    with browser_client(isolated_settings) as browser:
        headers = authenticate(browser)
        response = browser.post("/api/v2/diagnostics/chat", headers=headers, json={"message": "你好"})
        events = stream_events(response)
        assert [event["type"] for event in events] == ["error"]
        assert events[0]["code"] == "model_role_missing"


def test_browser_fixture_exercises_role_settings_text_image_and_voice_fallback(isolated_settings):
    with browser_client(isolated_settings, BrowserHarnessGateway) as browser:
        headers = authenticate(browser)
        result = browser.post(
            "/api/v2/providers/connections", headers=headers,
            json={"provider": "openai-compatible", "base_url": "http://127.0.0.1:9183/v1", "label": "Isolated transport"},
        )
        assert result.status_code == 201
        connection_id = result.json()["id"]
        discovered = browser.get(f"/api/v2/providers/connections/{connection_id}/models")
        live, vision = discovered.json()["models"]
        roles = browser.put("/api/v2/settings/model-roles", headers=headers, json={
            "live": {"connection_id": connection_id, "model": live},
            "vision": {"connection_id": connection_id, "model": vision},
        })
        assert roles.status_code == 200
        tests = browser.post(f"/api/v2/providers/connections/{connection_id}/test", headers=headers)
        assert {result["role"] for result in tests.json() if result["ok"]} == {"live", "vision"}

        text = stream_events(browser.post("/api/v2/diagnostics/chat", headers=headers, json={"message": "ping"}))
        assert [event["type"] for event in text] == ["delta", "delta", "done"]
        data = base64.b64encode((isolated_settings.repo_root / "evals/fixtures/m1-vision.png").read_bytes()).decode("ascii")
        image_response = browser.post("/api/v2/diagnostics/chat", headers=headers, json={
            "message": "转写公式", "image": {"mime": "image/png", "data_b64": data},
        })
        assert "$x^2+1=0$" in "".join(event.get("text", "") for event in stream_events(image_response))
        bad = browser.post("/api/v2/diagnostics/chat", headers=headers, json={
            "message": "转写公式", "image": {"mime": "image/jpeg", "data_b64": data},
        })
        assert bad.status_code == 415

        preview = browser.post("/api/v2/tts/preview", headers=headers, json={"character_id": "tutor-xuechuan"})
        assert preview.json()["kind"] == "browser"
        assert preview.json()["warning"]
        assert preview.json()["audio_b64"] is None


def test_spa_fallback_revalidates_index_and_keeps_api_404(tmp_path):
    dist = tmp_path / "apps/web/dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "assets/bundle-q1w2e3r4.js").write_text("export {};", encoding="utf-8")
    (dist / "index.html").write_text("<title>Companion Space</title>", encoding="utf-8")
    application = FastAPI()
    _serve_web(application, tmp_path)

    with TestClient(application) as browser:
        page = browser.get("/settings/diagnostics")
        assert page.status_code == 200 and "<title>Companion Space</title>" in page.text
        assert page.headers["cache-control"] == "no-cache"
        asset = browser.get("/assets/bundle-q1w2e3r4.js")
        assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
        assert browser.get("/api/v2/missing").status_code == 404
        assert browser.get("/assets/nonexistent.js").status_code == 404
        assert browser.get("/static/unknown/info").status_code == 404


def test_windows_launcher_is_ascii_compatible(isolated_settings):
    root = isolated_settings.repo_root
    assert (root / "start.ps1").read_bytes().isascii()
    assert (root / "start.bat").read_bytes().isascii()
