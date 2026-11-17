from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.api.deps import get_container


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _iter_storage_files(storage_root: Path) -> list[Path]:
    return [path for path in storage_root.rglob("*") if path.is_file()]


def _assert_storage_omits_text(storage_root: Path, *forbidden_values: str) -> None:
    for forbidden_value in forbidden_values:
        needle = forbidden_value.encode("utf-8")
        for path in _iter_storage_files(storage_root):
            if needle in path.read_bytes():
                raise AssertionError("provider secret was persisted to storage")


def test_provider_connection_create_response_never_echoes_plaintext_api_key(
    client: TestClient,
    owner_token: str,
) -> None:
    api_key = "sk-runtime-visibility-check"

    response = client.post(
        "/api/v2/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "anthropic",
            "label": "No key echo",
            "api_key": api_key,
        },
    )

    assert response.status_code == 201
    assert api_key not in response.text

    listed = client.get(
        "/api/v2/providers/connections",
        headers=_auth_headers(owner_token),
    )
    assert listed.status_code == 200
    assert api_key not in listed.text


def test_provider_secret_rotation_and_deletion_never_write_plaintext_to_storage(
    client: TestClient,
    owner_token: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    storage_root = get_container().settings.storage_root
    probe = storage_root / "provider-secret-probe.txt"
    probe_secret = "probe-secret-that-response-assertions-would-miss"
    probe.write_text(probe_secret, encoding="utf-8")
    assert probe_secret not in client.get(
        "/api/v2/providers/connections",
        headers=_auth_headers(owner_token),
    ).text
    with pytest.raises(AssertionError, match="persisted to storage"):
        _assert_storage_omits_text(storage_root, probe_secret)
    probe.unlink()

    headers = _auth_headers(owner_token)
    first_secret = "sk-storage-first-canary-9ea9f5a7"
    rotated_secret = "sk-storage-rotated-canary-554287c1"
    created = client.post(
        "/api/v2/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "Storage scan",
            "api_key": first_secret,
        },
    )
    assert created.status_code == 201
    connection_id = created.json()["id"]
    _assert_storage_omits_text(storage_root, first_secret)

    updated = client.patch(
        f"/api/v2/providers/connections/{connection_id}",
        headers=headers,
        json={"label": "Storage scan rotated", "api_key": rotated_secret},
    )
    assert updated.status_code == 200
    _assert_storage_omits_text(storage_root, first_secret, rotated_secret)

    deleted = client.delete(
        f"/api/v2/providers/connections/{connection_id}",
        headers=headers,
    )
    assert deleted.status_code == 204
    _assert_storage_omits_text(storage_root, first_secret, rotated_secret)
    assert first_secret not in caplog.text
    assert rotated_secret not in caplog.text


def test_validation_error_never_echoes_rejected_api_key(
    client: TestClient,
    owner_token: str,
) -> None:
    rejected_key = "sensitive-" + ("x" * 5000)
    response = client.post(
        "/api/v2/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "anthropic",
            "label": "Rejected key",
            "api_key": rejected_key,
        },
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert rejected_key not in response.text
