import sqlite3

from app.services.repository import SQLiteRepository


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_new_space_has_no_automatic_model_assignments(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    response = client.post("/api/v1/spaces", headers=headers, json={"name": "Unconfigured course"})
    assert response.status_code == 201
    space_id = response.json()["id"]
    assignments = client.get(f"/api/v1/spaces/{space_id}/assignments", headers=headers)
    assert assignments.status_code == 200
    assert assignments.json() == []


def test_assignment_requires_a_connection_with_the_requested_capability(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Capability guard"},
    ).json()
    tts_connection = client.post(
        "/api/v2/providers/connections",
        headers=headers,
        json={
            "provider": "elevenlabs",
            "label": "Voice only",
            "api_key": "not-a-real-key",
        },
    ).json()

    rejected = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": tts_connection["id"],
            "model_name": "voice-model",
        },
    )

    assert rejected.status_code == 400
    assert rejected.json()["code"] == "provider_configuration_error"


def test_saving_an_assignment_replaces_the_previous_capability_binding(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Replace binding"},
    ).json()
    connection = client.post(
        "/api/v2/providers/connections",
        headers=headers,
        json={
            "provider": "ollama",
            "label": "Second mock",
            "api_key": "",
        },
    ).json()

    saved = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": connection["id"],
            "model_name": "mock-companion-v1",
        },
    )

    assert saved.status_code == 201
    assignments = client.get(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
    ).json()
    chat_assignments = [
        item for item in assignments if item["capability"] == "chat_llm"
    ]
    assert len(chat_assignments) == 1
    assert chat_assignments[0]["provider_connection_id"] == connection["id"]


def test_updating_provider_connection_keeps_existing_assignment(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v2/providers/connections",
        headers=headers,
        json={
            "provider": "openai-compatible",
            "label": "Before",
            "api_key": "test-key-never-log",
        },
    )
    assert created.status_code == 201
    connection_id = created.json()["id"]
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Persistent assignment"},
    ).json()
    assigned = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": connection_id,
            "model_name": "test-model",
        },
    )
    assert assigned.status_code == 201

    updated = client.patch(
        f"/api/v2/providers/connections/{connection_id}",
        headers=headers,
        json={"label": "After"},
    )
    assert updated.status_code == 200

    assignments = client.get(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
    )
    assert assignments.status_code == 200
    assert any(
        item["provider_connection_id"] == connection_id
        and item["model_name"] == "test-model"
        for item in assignments.json()
    )


def test_provider_base_url_rejects_embedded_credentials(
    client,
    owner_token: str,
) -> None:
    secret = "test-key-must-not-leak"
    response = client.post(
        "/api/v2/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Unsafe URL",
            "api_key": secret,
            "base_url": "https://user:password@example.com/v1",
        },
    )

    assert response.status_code == 400
    assert response.json()["code"] == "provider_configuration_error"
    assert secret not in response.text


def test_repository_migrates_duplicate_capability_assignments(
    isolated_settings,
) -> None:
    isolated_settings.storage_root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE study_spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                topic TEXT NOT NULL,
                goal TEXT NOT NULL,
                default_character_pack_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE provider_connections (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                label TEXT NOT NULL,
                base_url TEXT,
                capabilities_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE model_assignments (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                capability TEXT NOT NULL,
                provider_connection_id TEXT NOT NULL,
                model_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO study_spaces VALUES
                ('space', 'Space', '', '', NULL, '2026-01-01', '2026-01-01'),
                (
                    'space-default',
                    'Default Space',
                    '',
                    '',
                    NULL,
                    '2026-01-01',
                    '2026-01-01'
                );
            INSERT INTO provider_connections VALUES
                ('provider', 'openai-compatible', 'Legacy connection', NULL, '["chat_llm"]', '2026-01-01', '2026-01-01');
            INSERT INTO model_assignments VALUES
                ('old', 'space', 'chat_llm', 'provider', 'old-model', '2026-01-01', '2026-01-01'),
                ('new', 'space', 'chat_llm', 'provider', 'new-model', '2026-01-02', '2026-01-02');
            """
        )

    repository = SQLiteRepository(isolated_settings)

    assignments = repository.list_model_assignments("space")
    assert [item.id for item in assignments] == ["new"]
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        indexes = connection.execute(
            "PRAGMA index_list(model_assignments)"
        ).fetchall()
    assert any(
        row[1] == "idx_model_assignments_space_capability"
        and row[2] == 1
        for row in indexes
    )
