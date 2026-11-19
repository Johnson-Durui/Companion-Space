from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

from app.api.deps import get_container
from app.avatar.protocol import validate_sidecar_base_url
from app.avatar.sidecar_client import SidecarSessionRegistry, probe_sidecar
from app.core.config import APP_ROOT
from app.providers.errors import ProviderConfigurationError


def test_validate_sidecar_base_url_policy() -> None:
    assert validate_sidecar_base_url("http://127.0.0.1:8090") == "http://127.0.0.1:8090"
    assert validate_sidecar_base_url("http://localhost:8090/") == "http://localhost:8090"
    assert validate_sidecar_base_url("http://192.168.1.40:8090", allow_lan=True) == "http://192.168.1.40:8090"

    with pytest.raises(ProviderConfigurationError):
        validate_sidecar_base_url("http://192.168.1.40:8090", allow_lan=False)
    with pytest.raises(ProviderConfigurationError):
        validate_sidecar_base_url("https://example.com:8090", allow_lan=True)
    with pytest.raises(ProviderConfigurationError):
        validate_sidecar_base_url("http://user:pass@127.0.0.1:8090", allow_lan=False)


def test_avatar_driver_settings_roundtrip_and_security(client, owner_token) -> None:
    headers = {"Authorization": f"Bearer {owner_token}"}
    initial = client.get("/api/v2/avatar-drivers/settings", headers=headers)
    assert initial.status_code == 200
    body = initial.json()
    assert body["local_sidecars"] == []
    assert body["cloud_live"]["enabled"] is False

    payload = {
        "default_sidecar_id": "local-gpu-1",
        "local_sidecars": [
            {
                "id": "local-gpu-1",
                "label": "RTX Local",
                "base_url": "http://127.0.0.1:8090",
                "allow_lan": False,
                "transport_preference": "auto",
                "enabled": True,
            },
            {
                "id": "lan-gpu-2",
                "label": "Studio LAN",
                "base_url": "http://192.168.1.50:8090",
                "allow_lan": True,
                "transport_preference": "ws_frames",
                "enabled": False,
            },
        ],
        "cloud_live": {
            "enabled": False,
            "connection_id": None,
            "model": None,
            "idle_suspend_sec": 45,
            "max_session_minutes": 12,
            "max_session_cost_cny": 15.0,
        },
    }
    saved = client.put("/api/v2/avatar-drivers/settings", headers=headers, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["default_sidecar_id"] == "local-gpu-1"
    assert len(saved.json()["local_sidecars"]) == 2
    assert saved.json()["cloud_live"]["idle_suspend_sec"] == 45

    reloaded = client.get("/api/v2/avatar-drivers/settings", headers=headers)
    assert reloaded.status_code == 200
    assert reloaded.json() == saved.json()

    public_rejected = client.put(
        "/api/v2/avatar-drivers/settings",
        headers=headers,
        json={
            "default_sidecar_id": "bad",
            "local_sidecars": [
                {
                    "id": "bad",
                    "label": "Public",
                    "base_url": "https://example.com:8090",
                    "allow_lan": True,
                    "transport_preference": "auto",
                    "enabled": True,
                }
            ],
        },
    )
    assert public_rejected.status_code in (400, 422, 424)
    assert public_rejected.json()["code"] == "provider_configuration_error"

    lan_without_flag = client.put(
        "/api/v2/avatar-drivers/settings",
        headers=headers,
        json={
            "default_sidecar_id": "lan",
            "local_sidecars": [
                {
                    "id": "lan",
                    "label": "LAN",
                    "base_url": "http://10.0.0.12:8090",
                    "allow_lan": False,
                    "transport_preference": "auto",
                    "enabled": True,
                }
            ],
        },
    )
    assert lan_without_flag.status_code in (400, 422, 424)
    assert lan_without_flag.json()["code"] == "provider_configuration_error"


def test_sidecar_probe_and_session_errors(client, owner_token) -> None:
    headers = {"Authorization": f"Bearer {owner_token}"}
    probed = client.post(
        "/api/v2/avatar-drivers/sidecars/test",
        headers=headers,
        json={"base_url": "https://example.com:8090", "allow_lan": True},
    )
    assert probed.status_code == 200
    assert probed.json()["ok"] is False
    assert probed.json()["error"]

    no_driver = client.post(
        "/api/v2/avatar-drivers/sidecar/sessions",
        headers=headers,
        json={
            "character_id": "tutor-echo",
            "aspect_ratio": "9:16",
            "fps": 25,
            "resolution": "384x682",
        },
    )
    assert no_driver.status_code == 400
    assert no_driver.json()["code"] == "sidecar_not_configured"


def test_sidecar_client_roundtrip_against_reference_sidecar(isolated_settings) -> None:
    sidecar_dir = str(Path(APP_ROOT) / "sidecars" / "local-gpu-avatar")
    added = sidecar_dir not in sys.path
    if added:
        sys.path.insert(0, sidecar_dir)
    try:
        from server import create_sidecar_app

        sidecar_app = create_sidecar_app("anime_2d_reference")
        transport = httpx.ASGITransport(app=sidecar_app)
        container = get_container()
        anchor = container.tutors.read_anchor_image("tutor-echo")
        assert anchor is not None
        anchor_bytes, anchor_mime = anchor

        async def _run() -> None:
            result = await probe_sidecar("http://127.0.0.1:8090", transport=transport)
            assert result.ok is True
            assert result.capabilities is not None
            assert result.capabilities.protocol_version == 1
            assert result.capabilities.driver_name == "anime-2d-protocol-reference"
            assert "ws_frames" in result.capabilities.transports

            registry = SidecarSessionRegistry()
            session, sdp_answer, width, height = await registry.create_session(
                base_url="http://127.0.0.1:8090",
                allow_lan=False,
                character_id="tutor-echo",
                anchor_bytes=anchor_bytes,
                anchor_mime=anchor_mime,
                aspect_ratio="9:16",
                fps=20,
                resolution="384x682",
                transport_preference="ws_frames",
                http_transport=transport,
            )
            assert sdp_answer is None
            assert (width, height) == (384, 682)
            assert registry.get(session.proxy_id) is session

            closed = await registry.close_session(session.proxy_id, http_transport=transport)
            assert closed.closed is True
            assert registry.get(session.proxy_id) is None

        asyncio.run(_run())
    finally:
        if added and sidecar_dir in sys.path:
            sys.path.remove(sidecar_dir)
