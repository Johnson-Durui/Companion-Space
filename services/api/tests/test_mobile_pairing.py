from __future__ import annotations

import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from app.api.deps import get_container
from app.core.config import MOBILE_APP_ORIGINS, Settings
from app.services.repository import _to_db, utcnow
from app.services.vault import InvalidDeviceRefreshTokenError


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_challenge(client, owner_token: str) -> dict:
    response = client.post(
        "/api/v1/mobile/pairing-challenges",
        headers=_auth_headers(owner_token),
    )
    assert response.status_code == 201
    return response.json()


def _pair(client, challenge: dict, *, name: str = "iPhone") -> dict:
    response = client.post(
        "/api/v1/mobile/pairing/exchange",
        json={
            "challenge_id": challenge["challenge_id"],
            "code": challenge["code"],
            "device_name": name,
        },
    )
    assert response.status_code == 200
    return response.json()


def _challenge_verifier(challenge: dict, *, code: str | None = None) -> str:
    return get_container().vault._pairing_code_verifier(
        challenge["challenge_id"],
        code if code is not None else challenge["code"],
    )


def test_pairing_issues_hashed_refresh_and_owner_compatible_access(client, owner_token: str) -> None:
    unauthorized = client.post("/api/v1/mobile/pairing-challenges")
    assert unauthorized.status_code == 401

    challenge = _create_challenge(client, owner_token)
    paired = _pair(client, challenge)
    repository = get_container().repository

    assert client.get(
        "/api/v1/spaces",
        headers=_auth_headers(paired["access_token"]),
    ).status_code == 200
    devices = client.get(
        "/api/v1/mobile/devices",
        headers=_auth_headers(owner_token),
    ).json()
    assert devices == [paired["device"]]
    assert "refresh_token" not in devices[0]

    with sqlite3.connect(repository.settings.metadata_db_path) as connection:
        device_row = connection.execute(
            "SELECT refresh_token_hash FROM trusted_devices"
        ).fetchone()
        challenge_count = connection.execute(
            "SELECT COUNT(*) FROM pairing_challenges"
        ).fetchone()[0]
    assert device_row == (
        hashlib.sha256(paired["refresh_token"].encode("utf-8")).hexdigest(),
    )
    assert challenge_count == 0
    database_files = [
        repository.settings.metadata_db_path,
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-wal"
        ),
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-shm"
        ),
    ]
    secrets = (challenge["code"], paired["refresh_token"], paired["access_token"])
    assert all(
        secret.encode("utf-8") not in path.read_bytes()
        for path in database_files
        if path.exists()
        for secret in secrets
    )


def test_pairing_code_uses_vault_keyed_verifier_not_offline_bruteforce_hash(
    client,
    owner_token: str,
) -> None:
    challenge = _create_challenge(client, owner_token)
    repository = get_container().repository
    with sqlite3.connect(repository.settings.metadata_db_path) as connection:
        stored_verifier = connection.execute(
            "SELECT code_hash FROM pairing_challenges WHERE id = ?",
            (challenge["challenge_id"],),
        ).fetchone()[0]

    assert stored_verifier == _challenge_verifier(challenge)
    assert stored_verifier != hashlib.sha256(
        challenge["code"].encode("utf-8")
    ).hexdigest()


def test_challenge_is_atomic_one_time_limited_and_expiring(client, owner_token: str) -> None:
    repository = get_container().repository
    challenge = _create_challenge(client, owner_token)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda _: repository.consume_pairing_challenge(
                    challenge_id=challenge["challenge_id"],
                    code_verifier=_challenge_verifier(challenge),
                ),
                range(2),
            )
        )
    assert sorted(results) == ["consumed", "invalid"]

    limited = _create_challenge(client, owner_token)
    wrong_code = "00000000" if limited["code"] != "00000000" else "11111111"
    for _ in range(get_container().vault.PAIRING_MAX_ATTEMPTS):
        assert repository.consume_pairing_challenge(
            challenge_id=limited["challenge_id"],
            code_verifier=_challenge_verifier(limited, code=wrong_code),
        ) in {"invalid", "attempts_exhausted"}
    assert repository.consume_pairing_challenge(
        challenge_id=limited["challenge_id"],
        code_verifier=_challenge_verifier(limited),
    ) == "invalid"

    expired = _create_challenge(client, owner_token)
    with repository.connection() as connection:
        connection.execute(
            "UPDATE pairing_challenges SET expires_at = ? WHERE id = ?",
            (_to_db(utcnow() - timedelta(seconds=1)), expired["challenge_id"]),
        )
    response = client.post(
        "/api/v1/mobile/pairing/exchange",
        json={
            "challenge_id": expired["challenge_id"],
            "code": expired["code"],
            "device_name": "Expired device",
        },
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired pairing challenge"}


@pytest.mark.parametrize(
    ("trigger_name", "trigger_target", "trigger_event"),
    (
        ("fail_challenge_consume", "pairing_challenges", "DELETE"),
        ("fail_device_insert", "trusted_devices", "INSERT"),
        ("fail_owner_session_insert", "owner_sessions", "INSERT"),
    ),
)
def test_pairing_transaction_rolls_back_every_stage(
    client,
    owner_token: str,
    trigger_name: str,
    trigger_target: str,
    trigger_event: str,
) -> None:
    challenge = _create_challenge(client, owner_token)
    repository = get_container().repository
    device_id = f"device-{trigger_name}"
    owner_session_id = f"session-{trigger_name}"
    refresh_token = f"refresh-{trigger_name}-must-not-persist"
    access_token = f"access-{trigger_name}-must-not-persist"
    with repository.connection() as connection:
        connection.execute(
            f"""
            CREATE TRIGGER {trigger_name}
            BEFORE {trigger_event} ON {trigger_target}
            BEGIN
                SELECT RAISE(ABORT, 'injected pairing failure');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="injected pairing failure"):
        repository.pair_trusted_device(
            challenge_id=challenge["challenge_id"],
            code_verifier_for_challenge=lambda _: _challenge_verifier(challenge),
            device_id=device_id,
            name="Rollback phone",
            refresh_token=refresh_token,
            refresh_ttl_seconds=600,
            owner_session_id=owner_session_id,
            access_token=access_token,
            access_ttl_seconds=60,
        )

    with sqlite3.connect(repository.settings.metadata_db_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM pairing_challenges WHERE id = ?",
            (challenge["challenge_id"],),
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM trusted_devices WHERE id = ?", (device_id,)
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM owner_sessions WHERE id = ?", (owner_session_id,)
        ).fetchone()[0] == 0

    database_files = (
        repository.settings.metadata_db_path,
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-wal"
        ),
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-shm"
        ),
    )
    assert all(
        secret.encode("utf-8") not in path.read_bytes()
        for path in database_files
        if path.exists()
        for secret in (refresh_token, access_token)
    )


def test_pairing_exchange_is_one_time(client, owner_token: str) -> None:
    challenge = _create_challenge(client, owner_token)
    _pair(client, challenge)
    replay = client.post(
        "/api/v1/mobile/pairing/exchange",
        json={
            "challenge_id": challenge["challenge_id"],
            "code": challenge["code"],
            "device_name": "Replay",
        },
    )
    assert replay.status_code == 401
    assert replay.json() == {"detail": "Invalid or expired pairing challenge"}
    assert len(get_container().repository.list_trusted_devices()) == 1


def test_latest_eight_digit_code_pairs_without_cross_device_challenge_id(
    client,
    owner_token: str,
) -> None:
    superseded = _create_challenge(client, owner_token)
    active = _create_challenge(client, owner_token)

    old_response = client.post(
        "/api/v1/mobile/pairing/exchange",
        json={"code": superseded["code"], "device_name": "Old code"},
    )
    assert old_response.status_code == 401

    response = client.post(
        "/api/v1/mobile/pairing/exchange",
        json={"code": active["code"], "device_name": "Code-only phone"},
    )
    assert response.status_code == 200
    assert response.json()["device"]["name"] == "Code-only phone"
    assert len(get_container().repository.list_trusted_devices()) == 1


@pytest.mark.parametrize("origin", MOBILE_APP_ORIGINS)
def test_mobile_launcher_origins_are_allowed_by_http_cors(client, origin: str) -> None:
    response = client.options(
        "/api/v1/mobile/pairing/exchange",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_mobile_origins_extend_explicit_browser_allowlist() -> None:
    settings = Settings(
        app_env="production",
        allowed_origins="https://browser.example,https://browser.example",
    )
    assert settings.cors_origins == ["https://browser.example", *MOBILE_APP_ORIGINS]
    assert settings.websocket_allowed_origins >= {
        "https://browser.example",
        *MOBILE_APP_ORIGINS,
    }
    assert "*" not in settings.cors_origins
    assert "https://attacker.invalid" not in settings.websocket_allowed_origins


def test_development_keeps_local_browser_origins() -> None:
    settings = Settings(
        app_env="development",
        allowed_origins="https://companion.localhost",
    )
    assert settings.cors_origins == [
        "https://companion.localhost",
        *MOBILE_APP_ORIGINS,
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
    assert "*" not in settings.cors_origins
    assert "http://localhost:3000" in settings.websocket_allowed_origins
    assert "http://127.0.0.1:3000" in settings.websocket_allowed_origins


def test_refresh_recovers_one_lost_response_then_rejects_replay(client, owner_token: str) -> None:
    paired = _pair(client, _create_challenge(client, owner_token))
    original_refresh = paired["refresh_token"]
    refreshed = client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": original_refresh},
    )
    assert refreshed.status_code == 200
    refreshed_payload = refreshed.json()
    assert refreshed_payload["refresh_token"] != original_refresh
    assert refreshed_payload["access_token"] != paired["access_token"]
    repository = get_container().repository
    database_files = (
        repository.settings.metadata_db_path,
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-wal"
        ),
        repository.settings.metadata_db_path.with_name(
            f"{repository.settings.metadata_db_path.name}-shm"
        ),
    )
    assert all(
        secret.encode("utf-8") not in path.read_bytes()
        for path in database_files
        if path.exists()
        for secret in (
            original_refresh,
            refreshed_payload["refresh_token"],
            refreshed_payload["access_token"],
        )
    )
    assert client.get(
        "/api/v1/spaces",
        headers=_auth_headers(refreshed_payload["access_token"]),
    ).status_code == 200

    recovered = client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": original_refresh},
    )
    assert recovered.status_code == 200
    assert recovered.json() == refreshed_payload

    replay = client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": original_refresh},
    )
    assert replay.status_code == 401
    assert replay.json() == {"detail": "Invalid device refresh token"}


def test_concurrent_refresh_returns_one_idempotent_rotation(client, owner_token: str) -> None:
    paired = _pair(client, _create_challenge(client, owner_token))
    vault = get_container().vault
    original_refresh = paired["refresh_token"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(lambda _: vault.refresh_device_access(original_refresh), range(2))
        )

    assert results[0] == results[1]
    with pytest.raises(InvalidDeviceRefreshTokenError):
        vault.refresh_device_access(original_refresh)
    assert vault.refresh_device_access(results[0][1])[1] != results[0][1]


def test_mobile_access_cannot_administer_pairing_devices_or_password(
    client, owner_token: str
) -> None:
    paired = _pair(client, _create_challenge(client, owner_token))
    mobile_headers = _auth_headers(paired["access_token"])
    device_id = paired["device"]["id"]

    assert client.get("/api/v1/spaces", headers=mobile_headers).status_code == 200
    responses = (
        client.post("/api/v1/mobile/pairing-challenges", headers=mobile_headers),
        client.get("/api/v1/mobile/devices", headers=mobile_headers),
        client.delete(f"/api/v1/mobile/devices/{device_id}", headers=mobile_headers),
        client.post(
            "/api/v1/vault/password",
            headers=mobile_headers,
            json={
                "current_password": "super-secret-pass",
                "new_password": "mobile-must-not-rotate-this",
            },
        ),
    )
    assert all(response.status_code == 403 for response in responses)
    assert all(
        response.json() == {"detail": "Local owner session required"}
        for response in responses
    )
    assert client.get(
        "/api/v1/mobile/devices", headers=_auth_headers(owner_token)
    ).status_code == 200


def test_lock_revoke_reset_and_password_rotation_clear_mobile_access(client, owner_token: str) -> None:
    first = _pair(client, _create_challenge(client, owner_token), name="Android")
    get_container().vault.lock()
    assert client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": first["refresh_token"]},
    ).status_code == 423
    assert client.get(
        "/api/v1/spaces", headers=_auth_headers(first["access_token"])
    ).json() == {"detail": "Vault is locked"}

    unlock = client.post(
        "/api/v1/vault/unlock", json={"password": "super-secret-pass"}
    ).json()
    unlocked_owner = unlock["owner_token"]
    second = _pair(client, _create_challenge(client, unlocked_owner), name="iPad")
    revoked = client.delete(
        f"/api/v1/mobile/devices/{second['device']['id']}",
        headers=_auth_headers(unlocked_owner),
    )
    assert revoked.status_code == 204
    assert client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": second["refresh_token"]},
    ).status_code == 401
    assert client.get(
        "/api/v1/spaces", headers=_auth_headers(second["access_token"])
    ).status_code == 401

    third_challenge = _create_challenge(client, unlocked_owner)
    third = _pair(client, third_challenge, name="Pixel")
    rotated = client.post(
        "/api/v1/vault/password",
        headers=_auth_headers(unlocked_owner),
        json={
            "current_password": "super-secret-pass",
            "new_password": "replacement-secret-pass",
        },
    )
    assert rotated.status_code == 200
    assert get_container().repository.list_trusted_devices() == []
    assert client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": third["refresh_token"]},
    ).status_code == 401

    rotated_owner = rotated.json()["owner_token"]
    fourth = _pair(client, _create_challenge(client, rotated_owner), name="Reset me")
    reset = client.post(
        "/api/v1/vault/reset",
        headers=_auth_headers(rotated_owner),
        json={"password": "replacement-secret-pass"},
    )
    assert reset.status_code == 200
    assert get_container().repository.list_trusted_devices() == []
    assert client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": fourth["refresh_token"]},
    ).status_code == 423


def test_invalid_mobile_secrets_are_not_reflected_or_logged(client, owner_token: str, caplog) -> None:
    _ = owner_token
    refresh_token = "refresh-token-that-must-never-appear-anywhere-123456"
    response = client.post(
        "/api/v1/mobile/auth/refresh",
        json={"refresh_token": refresh_token},
    )
    assert response.status_code == 401
    assert refresh_token not in response.text
    assert refresh_token not in caplog.text
