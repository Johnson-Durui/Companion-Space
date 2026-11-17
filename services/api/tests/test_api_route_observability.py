from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

import pytest

from app.api.deps import get_container
from app.models.domain import ProviderCapability
from app.providers.errors import ProviderTimeoutError


def _auth_headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


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


def test_voice_preview_timeout_returns_gateway_timeout(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v2/courses",
        headers=headers,
        json={"name": "Observability Space", "goal": ""},
    )
    character = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Observability Companion", "description": "", "recipe": {}},
    )
    assert space.status_code == 201
    assert character.status_code == 201

    providers = get_container().providers
    connection = providers.save_connection(provider="elevenlabs", label="Timeout test", api_key="test-key")
    providers.save_assignment(
        space_id=space.json()["id"], capability=ProviderCapability.tts,
        provider_connection_id=connection["id"], model_name="test-voice",
    )
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
