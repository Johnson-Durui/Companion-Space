from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services import provider_registry as provider_registry_module
from app.providers.factory import build_provider_adapter as original_build_provider_adapter
from app.providers.openai_compatible import OpenAICompatibleProvider


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_openai_compatible_connection(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_key: str = "sk-test-remote-provider-secret",
    base_url: str = "https://api.example.com/custom-root",
) -> dict:
    monkeypatch.setattr(
        provider_registry_module,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Remote adapter",
            "api_key": api_key,
            "base_url": base_url,
        },
    )
    assert response.status_code == 201
    return response.json()


def _patch_remote_adapter(
    monkeypatch: pytest.MonkeyPatch,
    handler,
) -> None:
    def build_adapter_with_mock_transport(connection, *, api_key):
        if connection.provider != "openai-compatible":
            return original_build_provider_adapter(connection, api_key=api_key)
        return OpenAICompatibleProvider(
            api_key=api_key or "",
            base_url=connection.base_url or "https://api.openai.com/v1",
            provider_name=connection.provider,
            timeout=45.0,
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(
        provider_registry_module,
        "build_provider_adapter",
        build_adapter_with_mock_transport,
    )


def test_test_connection_returns_remote_models_for_openai_compatible_connection(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _create_openai_compatible_connection(
        client,
        owner_token,
        monkeypatch,
    )
    seen_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers["authorization"])
        assert request.method == "GET"
        assert request.url.path == "/custom-root/v1/models"
        return httpx.Response(
            200,
            json={"data": [{"id": "gpt-4.1-mini"}, {"id": "gpt-4.1"}]},
        )

    _patch_remote_adapter(monkeypatch, handler)

    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 200
    assert seen_headers == ["Bearer sk-test-remote-provider-secret"]
    assert response.json()["connection_id"] == connection["id"]
    assert response.json()["provider"] == "openai-compatible"
    assert response.json()["ok"] is True
    assert response.json()["mode"] == "remote"
    assert response.json()["models"] == ["gpt-4.1-mini", "gpt-4.1"]
    assert response.json()["message"] == "连接验证成功"


def test_test_connection_returns_424_without_leaking_api_key_when_remote_auth_fails(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    leaked_key = "sk-test-auth-failure-secret"
    connection = _create_openai_compatible_connection(
        client,
        owner_token,
        monkeypatch,
        api_key=leaked_key,
    )
    _patch_remote_adapter(
        monkeypatch,
        lambda request: httpx.Response(
            401,
            json={"error": {"message": "bad key"}},
            request=request,
        ),
    )

    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 424
    assert leaked_key not in response.text
    assert response.json() == {
        "detail": "openai-compatible: Authentication failed. Check the provider API key.",
        "code": "provider_authentication_failed",
        "provider": "openai-compatible",
        "upstream_status": 401,
    }


def test_test_connection_returns_429_and_retry_after_when_remote_provider_rate_limits(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    leaked_key = "sk-test-rate-limit-secret"
    connection = _create_openai_compatible_connection(
        client,
        owner_token,
        monkeypatch,
        api_key=leaked_key,
    )
    _patch_remote_adapter(
        monkeypatch,
        lambda request: httpx.Response(
            429,
            json={"error": {"message": "slow down"}},
            headers={"retry-after": "7"},
            request=request,
        ),
    )

    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 429
    assert leaked_key not in response.text
    assert response.json() == {
        "detail": "openai-compatible: Provider rate limit reached. Please retry later.",
        "code": "provider_rate_limited",
        "provider": "openai-compatible",
        "upstream_status": 429,
        "retry_after": 7.0,
    }


def test_test_connection_returns_504_when_remote_provider_times_out(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _create_openai_compatible_connection(
        client,
        owner_token,
        monkeypatch,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    _patch_remote_adapter(monkeypatch, handler)

    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 504
    assert response.json() == {
        "detail": "openai-compatible: The provider timed out. Please retry.",
        "code": "provider_timeout",
        "provider": "openai-compatible",
    }


def test_test_connection_returns_503_without_leaking_api_key_when_network_request_fails(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    leaked_key = "sk-test-network-failure-secret"
    connection = _create_openai_compatible_connection(
        client,
        owner_token,
        monkeypatch,
        api_key=leaked_key,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    _patch_remote_adapter(monkeypatch, handler)

    response = client.post(
        f"/api/v1/providers/connections/{connection['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 503
    assert leaked_key not in response.text
    assert response.json() == {
        "detail": "openai-compatible: The provider is unavailable. Please retry.",
        "code": "provider_unavailable",
        "provider": "openai-compatible",
    }
