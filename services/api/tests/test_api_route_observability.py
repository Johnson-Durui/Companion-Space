from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

import pytest

from app.api.deps import get_container
from app.providers.errors import ProviderTimeoutError


def _auth_headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def test_api_metrics_use_composed_static_and_dynamic_route_templates(
    client,
    owner_token: str,
) -> None:
    assert client.get("/api/v1/vault/status").status_code == 200

    session_id = "session-observability-probe"
    response = client.get(
        f"/api/v1/sessions/{session_id}",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 404

    events = get_container().metrics.list_events(limit=50)["items"]
    requests = [item["payload"] for item in events if item["event"] == "api_request"]
    errors = [item["payload"] for item in events if item["event"] == "api_error"]

    assert any(item["route"] == "/api/v1/vault/status" for item in requests)
    assert any(
        item["route"] == "/api/v1/sessions/{session_id}" and item["status_code"] == 404
        for item in requests
    )
    assert any(
        item
        == {
            "route": "/api/v1/sessions/{session_id}",
            "status_code": 404,
        }
        for item in errors
    )
    assert session_id not in str(requests)
    assert session_id not in str(errors)


class _TimeoutTTSAdapter:
    async def synthesize_speech_stream(
        self,
        *,
        model: str,
        text: str,
        voice_id: str | None,
        speed: float,
        sample_rate_hz: int,
    ) -> AsyncIterator[bytes]:
        _ = model, text, voice_id, speed, sample_rate_hz
        raise ProviderTimeoutError(
            provider="mock",
            public_detail="Timed out while producing the voice preview.",
        )
        yield b""  # pragma: no cover


def test_unmatched_api_metrics_do_not_store_caller_controlled_paths(client) -> None:
    probe = "private-document-name"
    assert client.get(f"/api/v1/not-a-route/{probe}").status_code == 404
    events = get_container().metrics.list_events(limit=50)["items"]
    requests = [item["payload"] for item in events if item["event"] == "api_request"]
    assert any(item["route"] == "/api/v1/{unmatched}" for item in requests)
    assert probe not in str(events)


def test_voice_preview_timeout_uses_composed_route_for_tts_capability(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Observability Space", "topic": "", "goal": ""},
    )
    character = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Observability Companion", "description": "", "recipe": {}},
    )
    assert space.status_code == 201
    assert character.status_code == 201

    providers = get_container().providers
    original_resolve = providers.resolve

    def resolve_with_timeout(**kwargs):
        return replace(original_resolve(**kwargs), adapter=_TimeoutTTSAdapter())

    monkeypatch.setattr(providers, "resolve", resolve_with_timeout)

    response = client.post(
        f"/api/v1/characters/{character.json()['id']}/voice-preview",
        headers=headers,
        json={
            "space_id": space.json()["id"],
            "text": "Preview the timeout classification.",
        },
    )
    assert response.status_code == 504

    events = get_container().metrics.list_events(limit=50)["items"]
    timeout = next(item for item in events if item["event"] == "model_timeout")
    assert timeout["payload"] == {
        "capability": "tts",
        "provider_kind": "mock",
        "code": "provider_timeout",
    }
