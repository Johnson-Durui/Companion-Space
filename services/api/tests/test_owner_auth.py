from __future__ import annotations

import hashlib
import sqlite3

import pytest

from app.api.deps import get_container
from app.services.vault import (
    InvalidVaultPasswordError,
    OwnerTokenState,
    VaultLockedError,
)


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_owner_token_is_stored_only_as_a_hash(client, owner_token: str) -> None:
    repository = get_container().repository

    with sqlite3.connect(repository.settings.metadata_db_path) as connection:
        row = connection.execute("SELECT token_hash FROM owner_sessions").fetchone()

    assert row == (hashlib.sha256(owner_token.encode("utf-8")).hexdigest(),)
    database_files = [
        repository.settings.metadata_db_path,
        repository.settings.metadata_db_path.with_name(f"{repository.settings.metadata_db_path.name}-wal"),
        repository.settings.metadata_db_path.with_name(f"{repository.settings.metadata_db_path.name}-shm"),
    ]
    assert all(owner_token.encode("utf-8") not in path.read_bytes() for path in database_files if path.exists())


def test_owner_token_is_not_valid_while_vault_is_locked(client, owner_token: str) -> None:
    vault = get_container().vault

    vault.lock()

    assert vault.owner_token_state(owner_token) is OwnerTokenState.vault_locked
    assert vault.validate_owner_token(owner_token) is False


def test_owner_token_is_invalid_after_unlocking_a_locked_vault(client, owner_token: str) -> None:
    vault = get_container().vault

    vault.lock()
    vault.unlock("super-secret-pass")

    assert vault.owner_token_state(owner_token) is OwnerTokenState.invalid
    assert vault.validate_owner_token(owner_token) is False


def test_issue_owner_token_requires_an_unlocked_vault(client, owner_token: str) -> None:
    vault = get_container().vault
    vault.lock()

    with pytest.raises(VaultLockedError, match="locked"):
        vault.issue_owner_token()


def test_missing_owner_token_has_a_stable_401_detail(client) -> None:
    response = client.get("/api/v1/spaces")

    assert response.status_code == 401
    assert response.json() == {"detail": "Owner session required"}


def test_invalid_owner_token_has_a_stable_401_detail(client) -> None:
    response = client.get("/api/v1/spaces", headers=_auth_headers("not-a-real-owner-token"))

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid owner session"}


def test_locked_vault_has_a_stable_401_detail(client, owner_token: str) -> None:
    get_container().vault.lock()

    response = client.get("/api/v1/spaces", headers=_auth_headers(owner_token))

    assert response.status_code == 401
    assert response.json() == {"detail": "Vault is locked"}


def test_invalid_owner_token_is_not_reflected_in_response_or_logs(client, caplog) -> None:
    raw_token = "owner-token-that-must-never-be-logged"

    response = client.get("/api/v1/spaces", headers=_auth_headers(raw_token))

    assert raw_token not in response.text
    assert raw_token not in caplog.text


def test_wrong_password_has_a_specific_error(client, owner_token: str) -> None:
    vault = get_container().vault
    vault.lock()

    with pytest.raises(InvalidVaultPasswordError, match="Invalid vault password"):
        vault.unlock("definitely-the-wrong-password")


def test_reset_rejects_a_wrong_password_without_erasing_data(client, owner_token: str) -> None:
    container = get_container()
    space = container.spaces.create_space(name="Keep", topic="auth", goal="survive failed reset")

    with pytest.raises(InvalidVaultPasswordError, match="Invalid vault password"):
        container.vault.reset("definitely-the-wrong-password")

    assert container.vault.status().initialized is True
    assert container.vault.validate_owner_token(owner_token) is True
    assert container.repository.get_space(space.id) is not None


def test_reset_erases_credentials_and_sessions_but_keeps_learning_data(client, owner_token: str) -> None:
    container = get_container()
    space = container.spaces.create_space(name="Keep", topic="auth", goal="survive reset")
    second_owner_token = container.vault.issue_owner_token()

    container.vault.reset("super-secret-pass")

    assert container.vault.status().initialized is False
    assert container.vault.status().unlocked is False
    assert container.repository.get_owner_session(owner_token) is None
    assert container.repository.get_owner_session(second_owner_token) is None
    assert container.repository.get_space(space.id) is not None
