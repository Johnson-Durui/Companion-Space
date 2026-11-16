from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.browser_session import CSRF_COOKIE_NAME, OWNER_COOKIE_NAME


def _browser_headers(client: TestClient) -> dict[str, str]:
    csrf = client.cookies.get(CSRF_COOKIE_NAME)
    assert csrf
    return {
        "Origin": "http://localhost:3000",
        "X-CSRF-Token": csrf,
    }


def test_browser_cookie_survives_navigation_and_does_not_expose_owner_token(
    client: TestClient,
) -> None:
    initialized = client.post(
        "/api/v1/vault/init",
        headers={"X-Companion-Browser": "1"},
        json={"password": "super-secret-pass"},
    )
    assert initialized.status_code == 200
    assert initialized.json()["owner_token"] is None
    assert client.cookies.get(OWNER_COOKIE_NAME)

    status_response = client.get("/api/v1/vault/status")
    assert status_response.status_code == 200
    assert status_response.json()["owner_session_authenticated"] is True

    created = client.post(
        "/api/v1/spaces",
        headers=_browser_headers(client),
        json={"name": "Cookie space", "topic": "auth", "goal": "survive F5"},
    )
    assert created.status_code == 201


def test_cookie_mutation_requires_csrf_token_and_allowed_origin(
    client: TestClient,
) -> None:
    initialized = client.post(
        "/api/v1/vault/init",
        headers={"X-Companion-Browser": "1"},
        json={"password": "super-secret-pass"},
    )
    assert initialized.status_code == 200

    missing_csrf = client.post("/api/v1/vault/logout")
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["detail"] == "Invalid CSRF token"

    bad_origin_headers = _browser_headers(client)
    bad_origin_headers["Origin"] = "https://attacker.example"
    bad_origin = client.post("/api/v1/vault/logout", headers=bad_origin_headers)
    assert bad_origin.status_code == 403
    assert bad_origin.json()["detail"] == "Invalid request origin"

    logged_out = client.post(
        "/api/v1/vault/logout",
        headers=_browser_headers(client),
    )
    assert logged_out.status_code == 204
    assert client.get("/api/v1/vault/status").json()[
        "owner_session_authenticated"
    ] is False


def test_bearer_auth_remains_compatible_without_csrf(
    client: TestClient,
) -> None:
    initialized = client.post(
        "/api/v1/vault/init",
        json={"password": "super-secret-pass"},
    )
    token = initialized.json()["owner_token"]
    client.cookies.clear()

    created = client.post(
        "/api/v1/spaces",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "Bearer space", "topic": "compat", "goal": "keep API clients"},
    )
    assert created.status_code == 201
