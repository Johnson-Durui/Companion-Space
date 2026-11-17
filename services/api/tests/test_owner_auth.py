from __future__ import annotations

import hashlib
import sqlite3


from app.api.deps import get_container


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


def test_missing_owner_token_has_a_stable_401_detail(client) -> None:
    response = client.get("/api/v1/spaces")

    assert response.status_code == 401
    assert response.json()["code"] == "owner_session_required"


def test_invalid_owner_token_has_a_stable_401_detail(client) -> None:
    get_container().vault.bootstrap()
    response = client.get("/api/v1/spaces", headers=_auth_headers("not-a-real-owner-token"))

    assert response.status_code == 401
    assert response.json()["code"] == "owner_session_invalid"


def test_invalid_owner_token_is_not_reflected_in_response_or_logs(client, caplog) -> None:
    raw_token = "owner-token-that-must-never-be-logged"

    response = client.get("/api/v1/spaces", headers=_auth_headers(raw_token))

    assert raw_token not in response.text
    assert raw_token not in caplog.text
