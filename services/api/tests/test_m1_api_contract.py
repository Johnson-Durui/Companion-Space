from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.api.deps import get_container
from app.models.domain import MemoryItem, ReviewItem


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_v1_resources_require_an_owner_session(client) -> None:
    response = client.get("/api/v1/spaces")

    assert response.status_code == 401
    assert "owner session" in response.json()["detail"].lower()


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/chat/text"),
        ("GET", "/api/kb/documents"),
        ("GET", "/api/settings"),
        ("POST", "/api/voice/speak"),
    ],
)
def test_legacy_routes_are_removed(client, method: str, path: str) -> None:
    response = client.request(method, path, json={})

    assert response.status_code == 404


def test_lock_invalidates_the_in_memory_owner_session(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    locked = client.post("/api/v1/vault/lock", headers=headers)

    assert locked.status_code == 200
    rejected = client.get("/api/v1/spaces", headers=headers)
    assert rejected.status_code == 401
    assert "locked" in rejected.json()["detail"].lower()


def test_reset_only_erases_credentials_and_owner_sessions(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Keep me", "topic": "local data", "goal": "survive a credential reset"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]

    reset = client.post(
        "/api/v1/vault/reset",
        headers=headers,
        json={"password": "super-secret-pass"},
    )
    assert reset.status_code == 200
    assert reset.json() == {"initialized": False, "unlocked": False}
    assert client.get("/api/v1/spaces", headers=headers).status_code == 401

    initialized = client.post("/api/v1/vault/init", json={"password": "replacement-secret"})
    assert initialized.status_code == 200
    replacement_headers = _auth_headers(initialized.json()["owner_token"])
    spaces = client.get("/api/v1/spaces", headers=replacement_headers)
    assert spaces.status_code == 200
    assert any(item["id"] == space_id for item in spaces.json())


def test_space_detail_and_delete_are_scoped(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Disposable", "topic": "scope", "goal": "exercise CRUD"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]

    detail = client.get(f"/api/v1/spaces/{space_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["space"]["id"] == space_id
    assert detail.json()["materials"] == []
    assert {
        (
            item["capability"],
            item["provider_connection_id"],
            item["model_name"],
        )
        for item in detail.json()["assignments"]
    } == {
        ("analysis_llm", "builtin-mock", "mock-analysis-v1"),
        ("chat_llm", "builtin-mock", "mock-companion-v1"),
        ("stt", "builtin-mock", "mock-stt-v1"),
        ("tts", "builtin-mock", "mock-voice-v1"),
    }

    deleted = client.delete(f"/api/v1/spaces/{space_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/spaces/{space_id}", headers=headers).status_code == 404


def test_material_delete_requires_the_parent_space(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space_a = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "A", "topic": "", "goal": ""},
    ).json()
    space_b = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "B", "topic": "", "goal": ""},
    ).json()
    created = client.post(
        f"/api/v1/spaces/{space_a['id']}/materials/note",
        headers=headers,
        json={"title": "Scoped note", "content": "This belongs only to space A."},
    )
    assert created.status_code == 201
    material = created.json()["material"]
    get_container().spaces.wait_for_ingestion(created.json()["job"]["id"], timeout_seconds=2.0)

    wrong_space = client.delete(
        f"/api/v1/spaces/{space_b['id']}/materials/{material['id']}",
        headers=headers,
    )
    assert wrong_space.status_code == 404
    assert client.get(
        f"/api/v1/spaces/{space_a['id']}/materials",
        headers=headers,
    ).json()

    deleted = client.delete(
        f"/api/v1/spaces/{space_a['id']}/materials/{material['id']}",
        headers=headers,
    )
    assert deleted.status_code == 204
    assert client.get(
        f"/api/v1/spaces/{space_a['id']}/materials",
        headers=headers,
    ).json() == []


def test_provider_update_rotates_secret_without_returning_it(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "mock",
            "label": "First label",
            "api_key": "secret-first-value",
            "base_url": None,
        },
    )
    assert created.status_code == 201
    connection_id = created.json()["id"]

    updated = client.patch(
        f"/api/v1/providers/connections/{connection_id}",
        headers=headers,
        json={"label": "Updated label", "api_key": "secret-rotated-value"},
    )
    assert updated.status_code == 200
    assert updated.json()["label"] == "Updated label"

    serialized = json.dumps(updated.json())
    assert "secret-first-value" not in serialized
    assert "secret-rotated-value" not in serialized


def test_character_crud_duplicate_and_export_exclude_credentials(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Mika",
            "description": "A cool study companion",
            "recipe": {"personality": "cool", "relationship_role": "friend"},
        },
    )
    assert created.status_code == 201
    character_id = created.json()["id"]

    fetched = client.get(f"/api/v1/characters/{character_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["recipe"]["personality"] == "cool"

    updated_payload = fetched.json()
    updated_payload["name"] = "Mika 2"
    updated = client.put(
        f"/api/v1/characters/{character_id}",
        headers=headers,
        json={
            "name": updated_payload["name"],
            "description": updated_payload["description"],
            "recipe": updated_payload["recipe"],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Mika 2"

    duplicated = client.post(
        f"/api/v1/characters/{character_id}/duplicate",
        headers=headers,
    )
    assert duplicated.status_code == 201
    assert duplicated.json()["id"] != character_id

    exported = client.get(
        f"/api/v1/characters/{character_id}/export",
        headers=headers,
    )
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = set(archive.namelist())
        assert "character.json" in names
        payload = archive.read("character.json").decode("utf-8")
        assert "api_key" not in payload
        assert "owner_token" not in payload

    deleted = client.delete(f"/api/v1/characters/{character_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/characters/{character_id}", headers=headers).status_code == 404


def test_memory_confirm_and_delete_remain_space_scoped(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space_a = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Memory A", "topic": "", "goal": ""},
    ).json()
    space_b = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Memory B", "topic": "", "goal": ""},
    ).json()
    now = datetime.now(timezone.utc)
    item = get_container().repository.upsert_memory_item(
        MemoryItem(
            id=str(uuid4()),
            space_id=space_a["id"],
            content="I learn better with diagrams.",
            sensitive=False,
            created_at=now,
            updated_at=now,
        )
    )

    wrong_space = client.post(
        f"/api/v1/memory/{space_b['id']}/{item.id}/confirm",
        headers=headers,
    )
    assert wrong_space.status_code == 404
    confirmed = client.post(
        f"/api/v1/memory/{space_a['id']}/{item.id}/confirm",
        headers=headers,
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "confirmed"
    deleted = client.delete(
        f"/api/v1/memory/{space_a['id']}/{item.id}",
        headers=headers,
    )
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/memory/{space_a['id']}", headers=headers).json()["items"] == []


def test_review_update_and_delete_remain_space_scoped(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Reviews", "topic": "", "goal": ""},
    ).json()
    now = datetime.now(timezone.utc)
    item = get_container().repository.upsert_review_item(
        ReviewItem(
            id=str(uuid4()),
            space_id=space["id"],
            prompt="What is a closure?",
            answer="A function with captured lexical bindings.",
            created_at=now,
            updated_at=now,
        )
    )

    due_at = now + timedelta(days=3)
    updated = client.put(
        f"/api/v1/review-items/{space['id']}/{item.id}",
        headers=headers,
        json={
            "prompt": item.prompt,
            "answer": item.answer,
            "due_at": due_at.isoformat(),
            "status": "completed",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"
    assert datetime.fromisoformat(updated.json()["due_at"]) == due_at

    partial_answer = client.put(
        f"/api/v1/review-items/{space['id']}/{item.id}",
        headers=headers,
        json={"answer": "A closure keeps the lexical bindings it captured."},
    )
    assert partial_answer.status_code == 200
    assert partial_answer.json()["prompt"] == item.prompt
    assert partial_answer.json()["status"] == "completed"
    assert datetime.fromisoformat(partial_answer.json()["due_at"]) == due_at

    rescheduled_at = due_at + timedelta(days=2)
    rescheduled = client.put(
        f"/api/v1/review-items/{space['id']}/{item.id}",
        headers=headers,
        json={"due_at": rescheduled_at.isoformat()},
    )
    assert rescheduled.status_code == 200
    assert rescheduled.json()["status"] == "completed"
    assert datetime.fromisoformat(rescheduled.json()["due_at"]) == rescheduled_at

    invalid_status = client.put(
        f"/api/v1/review-items/{space['id']}/{item.id}",
        headers=headers,
        json={"status": "later-maybe"},
    )
    assert invalid_status.status_code == 422
    deleted = client.delete(
        f"/api/v1/review-items/{space['id']}/{item.id}",
        headers=headers,
    )
    assert deleted.status_code == 204
    assert client.get(
        f"/api/v1/review-items/{space['id']}",
        headers=headers,
    ).json()["items"] == []


def test_turn_citations_only_reference_server_retrieval_hits(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Grounded", "topic": "astronomy", "goal": "cite local notes"},
    ).json()
    note = client.post(
        f"/api/v1/spaces/{space['id']}/materials/note",
        headers=headers,
        json={
            "title": "Cobalt Orbit",
            "content": "The cobalt moon completes one orbit every nineteen local days.",
        },
    )
    assert note.status_code == 201
    get_container().spaces.wait_for_ingestion(note.json()["job"]["id"], timeout_seconds=2.0)
    session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space["id"]},
    ).json()

    turn = client.post(
        f"/api/v1/sessions/{session['id']}/turns",
        headers=headers,
        json={"text": "How long is the cobalt moon orbit?"},
    )
    assert turn.status_code == 200
    citations = turn.json()["citations"]
    assert citations

    chunks = {chunk.id: chunk for chunk in get_container().repository.list_chunks(space["id"])}
    assert all(item["chunk_id"] in chunks for item in citations)
    assert all(item["material_id"] == chunks[item["chunk_id"]].material_id for item in citations)
    assert all("source_id" not in item for item in citations)
