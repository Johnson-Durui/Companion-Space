from __future__ import annotations

import sqlite3
import socket

import pytest

from app.api.deps import get_container
from app.providers import pinned_http
from app.services import provider_registry
from app.services.provider_registry import (
    BUILTIN_MOCK_ANALYSIS_MODEL,
    BUILTIN_MOCK_CONNECTION_ID,
)
from app.services.repository import SQLiteRepository


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_new_space_gets_explicit_builtin_mock_realtime_assignments(
    client,
    owner_token: str,
) -> None:
    created = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Explicit mock", "topic": "", "goal": ""},
    )

    assert created.status_code == 201
    detail = client.get(
        f"/api/v1/spaces/{created.json()['id']}",
        headers=_auth_headers(owner_token),
    )
    assert detail.status_code == 200
    assignments = detail.json()["assignments"]
    assert {
        (
            assignment["capability"],
            assignment["provider_connection_id"],
            assignment["model_name"],
        )
        for assignment in assignments
    } == {
        ("chat_llm", BUILTIN_MOCK_CONNECTION_ID, "mock-companion-v1"),
        ("analysis_llm", BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_ANALYSIS_MODEL),
        ("stt", BUILTIN_MOCK_CONNECTION_ID, "mock-stt-v1"),
        ("tts", BUILTIN_MOCK_CONNECTION_ID, "mock-voice-v1"),
    }


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
        "/api/v1/providers/connections",
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
    assert "does not provide chat_llm" in rejected.json()["detail"]


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
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "mock",
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


def test_binding_real_chat_removes_unconfirmed_builtin_mock_capabilities(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "No silent mixed providers"},
    ).json()
    connection = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "Real chat",
            "api_key": "test-only-key",
        },
    ).json()

    saved = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": connection["id"],
            "model_name": "claude-test",
        },
    )

    assert saved.status_code == 201
    assignments = client.get(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
    ).json()
    assert {
        (
            item["capability"],
            item["provider_connection_id"],
            item["model_name"],
        )
        for item in assignments
    } == {
        ("chat_llm", connection["id"], "claude-test"),
    }


def test_binding_real_chat_preserves_explicit_builtin_mock_capabilities(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Explicit mixed providers"},
    ).json()
    for capability, model_name in (
        ("analysis_llm", BUILTIN_MOCK_ANALYSIS_MODEL),
        ("stt", "mock-stt-v1"),
        ("tts", "mock-voice-v1"),
    ):
        rebound = client.post(
            f"/api/v1/spaces/{space['id']}/assignments",
            headers=headers,
            json={
                "capability": capability,
                "provider_connection_id": BUILTIN_MOCK_CONNECTION_ID,
                "model_name": model_name,
            },
        )
        assert rebound.status_code == 201
        assert rebound.json()["is_bootstrap_default"] is False

    connection = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "Real chat with explicit Mock capabilities",
            "api_key": "test-only-key",
        },
    ).json()
    saved = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": connection["id"],
            "model_name": "claude-test",
        },
    )

    assert saved.status_code == 201
    assignments = client.get(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
    ).json()
    assert {
        (
            item["capability"],
            item["provider_connection_id"],
            item["model_name"],
        )
        for item in assignments
    } == {
        ("analysis_llm", BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_ANALYSIS_MODEL),
        ("chat_llm", connection["id"], "claude-test"),
        ("stt", BUILTIN_MOCK_CONNECTION_ID, "mock-stt-v1"),
        ("tts", BUILTIN_MOCK_CONNECTION_ID, "mock-voice-v1"),
    }


def test_assignment_can_be_unbound_without_crossing_space_boundaries(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space_a = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Space A"},
    ).json()
    space_b = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Space B"},
    ).json()

    removed = client.delete(
        f"/api/v1/spaces/{space_a['id']}/assignments/chat_llm",
        headers=headers,
    )

    assert removed.status_code == 204
    space_a_assignments = client.get(
        f"/api/v1/spaces/{space_a['id']}/assignments",
        headers=headers,
    ).json()
    assert {item["capability"] for item in space_a_assignments} == {"analysis_llm", "stt", "tts"}
    remaining = client.get(
        f"/api/v1/spaces/{space_b['id']}/assignments",
        headers=headers,
    ).json()
    assert {item["capability"] for item in remaining} == {
        "analysis_llm",
        "chat_llm",
        "stt",
        "tts",
    }


def test_builtin_mock_connection_cannot_be_deleted(
    client,
    owner_token: str,
) -> None:
    response = client.delete(
        f"/api/v1/providers/connections/{BUILTIN_MOCK_CONNECTION_ID}",
        headers=_auth_headers(owner_token),
    )

    assert response.status_code == 400
    assert "built-in Mock" in response.json()["detail"]


def test_updating_provider_connection_keeps_existing_assignment(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/providers/connections",
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
        f"/api/v1/providers/connections/{connection_id}",
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
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Unsafe URL",
            "api_key": secret,
            "base_url": "https://user:password@example.com/v1",
        },
    )

    assert response.status_code == 400
    assert "must not contain credentials" in response.json()["detail"]
    assert secret not in response.text


def test_provider_base_url_blocks_metadata_network_targets(
    client,
    owner_token: str,
) -> None:
    for blocked_url in (
        "http://127.0.0.1:8000/v1",
        "http://10.0.0.7:8080/v1",
        "http://169.254.169.254/v1",
        "http://[fe80::1]/v1",
        "http://metadata.google.internal/v1",
    ):
        response = client.post(
            "/api/v1/providers/connections",
            headers=_auth_headers(owner_token),
            json={
                "provider": "openai-compatible",
                "label": "Blocked metadata",
                "api_key": "test-key",
                "base_url": blocked_url,
            },
        )

        assert response.status_code == 400
        assert "metadata" in response.text.lower() or "blocked" in response.text.lower()


def test_openai_compatible_base_url_rejects_dns_that_resolves_to_loopback(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        lambda hostname: ("127.0.0.1",),
    )

    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Loopback target",
            "api_key": "test-key",
            "base_url": "http://proxy.test/v1",
        },
    )

    assert response.status_code == 400
    assert "blocked network address" in response.json()["detail"].lower()


def test_openai_compatible_base_url_rejects_unresolved_hostname(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-unresolved-host-secret"

    def fail_resolution(hostname: str) -> tuple[str, ...]:
        raise OSError(f"resolution failed for {hostname}")

    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        fail_resolution,
    )

    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Unresolved target",
            "api_key": secret,
            "base_url": "https://unresolved-provider.test/v1",
        },
    )

    assert response.status_code == 400
    assert "could not be resolved" in response.json()["detail"].lower()
    assert secret not in response.text


def test_openai_compatible_base_url_is_revalidated_before_use(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    created = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Rebinding target",
            "api_key": "test-key",
            "base_url": "https://provider.test/v1",
        },
    )
    assert created.status_code == 201

    monkeypatch.setattr(
        pinned_http,
        "default_host_resolver",
        lambda hostname: ("127.0.0.1",),
    )
    tested = client.post(
        f"/api/v1/providers/connections/{created.json()['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert tested.status_code == 424
    assert "blocked network address" in tested.json()["detail"].lower()


def test_openai_compatible_runtime_dns_failure_is_temporarily_unavailable(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    created = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "openai-compatible",
            "label": "Temporarily unresolved target",
            "api_key": "test-key",
            "base_url": "https://provider.test/v1",
        },
    )
    assert created.status_code == 201

    def fail_resolution(hostname: str) -> tuple[str, ...]:
        raise socket.gaierror(f"temporary resolution failure for {hostname}")

    monkeypatch.setattr(
        pinned_http,
        "default_host_resolver",
        fail_resolution,
    )
    tested = client.post(
        f"/api/v1/providers/connections/{created.json()['id']}/test",
        headers=_auth_headers(owner_token),
    )

    assert tested.status_code == 503
    assert tested.json()["code"] == "provider_unavailable"
    assert "could not be resolved" in tested.json()["detail"].lower()


def test_ollama_base_url_allows_dns_that_resolves_to_private_or_loopback(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        lambda hostname: ("127.0.0.1", "192.168.1.20"),
    )

    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "ollama",
            "label": "Local Ollama",
            "base_url": "http://ollama.test:11434/v1",
        },
    )

    assert response.status_code == 201
    assert response.json()["base_url"] == "http://ollama.test:11434/v1"


def test_ollama_base_url_still_rejects_metadata_or_link_local_targets(
    client,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry,
        "_default_host_resolver",
        lambda hostname: ("169.254.169.254",),
    )

    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "ollama",
            "label": "Unsafe Ollama",
            "base_url": "http://ollama.test:11434/v1",
        },
    )

    assert response.status_code == 400
    assert "blocked network address" in response.json()["detail"].lower()


def test_mock_connection_discards_irrelevant_api_key(
    client,
    owner_token: str,
) -> None:
    created = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "mock",
            "label": "Keyless Mock",
            "api_key": "this-should-not-be-stored",
        },
    )

    assert created.status_code == 201
    assert (
        get_container().vault.get_provider_secret(created.json()["id"])
        is None
    )


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
                ('provider', 'mock', 'Mock', NULL, '["chat_llm"]', '2026-01-01', '2026-01-01');
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


def test_repository_migration_preserves_legacy_explicit_mock_audio(
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
                ('space', 'Space', '', '', NULL, '2026-01-01', '2026-01-01');
            INSERT INTO provider_connections VALUES
                (
                    'builtin-mock',
                    'mock',
                    'Mock',
                    NULL,
                    '["chat_llm", "stt", "tts"]',
                    '2026-01-01',
                    '2026-01-01'
                );
            INSERT INTO model_assignments VALUES
                (
                    'chat',
                    'space',
                    'chat_llm',
                    'builtin-mock',
                    'mock-companion-v1',
                    '2026-01-01T00:00:00+00:00',
                    '2026-01-01T00:00:00+00:00'
                ),
                (
                    'stt',
                    'space',
                    'stt',
                    'builtin-mock',
                    'mock-stt-v1',
                    '2026-01-01T00:00:00+00:00',
                    '2026-01-02T00:00:00+00:00'
                ),
                (
                    'tts',
                    'space',
                    'tts',
                    'builtin-mock',
                    'mock-voice-v1',
                    '2026-01-01T00:00:00+00:00',
                    '2026-01-02T00:00:00+00:00'
                ),
                (
                    'chat-default',
                    'space-default',
                    'chat_llm',
                    'builtin-mock',
                    'mock-companion-v1',
                    '2026-01-03T00:00:00+00:00',
                    '2026-01-03T00:00:00+00:00'
                ),
                (
                    'stt-default',
                    'space-default',
                    'stt',
                    'builtin-mock',
                    'mock-stt-v1',
                    '2026-01-03T00:00:00+00:00',
                    '2026-01-03T00:00:00+00:00'
                ),
                (
                    'tts-default',
                    'space-default',
                    'tts',
                    'builtin-mock',
                    'mock-voice-v1',
                    '2026-01-03T00:00:00+00:00',
                    '2026-01-03T00:00:00+00:00'
                );
            """
        )

    repository = SQLiteRepository(isolated_settings)

    assignments = repository.list_model_assignments("space")
    audio_assignments = [
        item
        for item in assignments
        if item.capability.value in {"stt", "tts"}
    ]
    assert len(audio_assignments) == 2
    assert all(not item.is_bootstrap_default for item in audio_assignments)
    seeded_audio_assignments = [
        item
        for item in repository.list_model_assignments("space-default")
        if item.capability.value in {"stt", "tts"}
    ]
    assert len(seeded_audio_assignments) == 2
    assert all(item.is_bootstrap_default for item in seeded_audio_assignments)
