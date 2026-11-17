from __future__ import annotations

import json

import pytest

def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_course_resources_require_an_owner_session(client) -> None:
    response = client.get("/api/v2/courses")

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


def test_space_detail_and_delete_are_scoped(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v2/courses",
        headers=headers,
        json={"name": "Disposable", "goal": "exercise CRUD"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]

    detail = client.get(f"/api/v2/courses/{space_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["id"] == space_id

    deleted = client.delete(f"/api/v2/courses/{space_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/v2/courses/{space_id}", headers=headers).status_code == 404


def test_material_delete_requires_the_parent_space(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space_a = client.post(
        "/api/v2/courses",
        headers=headers,
        json={"name": "A", "goal": ""},
    ).json()
    space_b = client.post(
        "/api/v2/courses",
        headers=headers,
        json={"name": "B", "goal": ""},
    ).json()
    created = client.post(
        f"/api/v2/courses/{space_a['id']}/materials/note",
        headers=headers,
        json={"title": "Scoped note", "content": "This belongs only to space A."},
    )
    assert created.status_code == 201
    material = created.json()

    wrong_space = client.delete(
        f"/api/v2/courses/{space_b['id']}/materials/{material['id']}",
        headers=headers,
    )
    assert wrong_space.status_code == 404
    assert client.get(
        f"/api/v2/courses/{space_a['id']}/materials",
        headers=headers,
    ).json()

    deleted = client.delete(
        f"/api/v2/courses/{space_a['id']}/materials/{material['id']}",
        headers=headers,
    )
    assert deleted.status_code == 204
    assert client.get(
        f"/api/v2/courses/{space_a['id']}/materials",
        headers=headers,
    ).json() == []


def test_provider_update_rotates_secret_without_returning_it(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v2/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "First label",
            "api_key": "secret-first-value",
            "base_url": None,
        },
    )
    assert created.status_code == 201
    connection_id = created.json()["id"]

    updated = client.patch(
        f"/api/v2/providers/connections/{connection_id}",
        headers=headers,
        json={"label": "Updated label", "api_key": "secret-rotated-value"},
    )
    assert updated.status_code == 200
    assert updated.json()["label"] == "Updated label"

    serialized = json.dumps(updated.json())
    assert "secret-first-value" not in serialized
    assert "secret-rotated-value" not in serialized


def test_character_crud_and_duplicate(client, owner_token: str) -> None:
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

    deleted = client.delete(f"/api/v1/characters/{character_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/characters/{character_id}", headers=headers).status_code == 404
