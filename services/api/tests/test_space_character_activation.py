from __future__ import annotations

from pathlib import Path

from app.api.deps import get_container
from app.models.domain import CharacterRecipe


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def _create_character(client, headers: dict[str, str], name: str) -> dict:
    recipe = CharacterRecipe(relationship_role="study companion").model_dump(mode="json")
    response = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": name, "recipe": recipe},
    )
    assert response.status_code == 201
    return response.json()


def _create_space(client, headers: dict[str, str], name: str) -> dict:
    response = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": name, "topic": f"{name} topic", "goal": f"{name} goal"},
    )
    assert response.status_code == 201
    return response.json()


def test_default_character_route_is_owner_only_strict_and_idempotent(
    client,
    owner_token: str,
) -> None:
    headers = _headers(owner_token)
    first = _create_character(client, headers, "First")
    second = _create_character(client, headers, "Second")
    target = _create_space(client, headers, "Target")
    untouched = _create_space(client, headers, "Untouched")

    unauthorized = client.put(
        f"/api/v1/spaces/{target['id']}/default-character",
        json={"character_pack_id": first["id"]},
    )
    assert unauthorized.status_code == 401

    invalid = client.put(
        f"/api/v1/spaces/{target['id']}/default-character",
        headers=headers,
        json={"character_pack_id": "missing"},
    )
    assert invalid.status_code == 404
    assert client.get(f"/api/v1/spaces/{target['id']}", headers=headers).json()[
        "space"
    ]["default_character_pack_id"] is None
    missing_space = client.put(
        "/api/v1/spaces/missing/default-character",
        headers=headers,
        json={"character_pack_id": first["id"]},
    )
    assert missing_space.status_code == 404

    for body in (
        {},
        {"character_pack_id": ""},
        {"character_pack_id": "   "},
        {"character_pack_id": "x" * 129},
        {"character_pack_id": None, "extra": True},
    ):
        rejected = client.put(
            f"/api/v1/spaces/{target['id']}/default-character",
            headers=headers,
            json=body,
        )
        assert rejected.status_code == 422

    activated = client.put(
        f"/api/v1/spaces/{target['id']}/default-character",
        headers=headers,
        json={"character_pack_id": first["id"]},
    )
    assert activated.status_code == 200
    assert activated.json()["default_character_pack_id"] == first["id"]
    assert activated.json()["name"] == target["name"]
    assert activated.json()["topic"] == target["topic"]
    assert activated.json()["goal"] == target["goal"]
    activated_at = activated.json()["updated_at"]

    repeated = client.put(
        f"/api/v1/spaces/{target['id']}/default-character",
        headers=headers,
        json={"character_pack_id": first["id"]},
    )
    assert repeated.status_code == 200
    assert repeated.json()["updated_at"] == activated_at

    renamed = client.put(
        f"/api/v1/spaces/{target['id']}",
        headers=headers,
        json={"name": "Renamed", "topic": "new topic", "goal": "new goal"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["default_character_pack_id"] == first["id"]
    old_contract = client.put(
        f"/api/v1/spaces/{target['id']}",
        headers=headers,
        json={
            "name": "Ignored default",
            "topic": "topic",
            "goal": "goal",
            "default_character_pack_id": second["id"],
        },
    )
    assert old_contract.status_code == 422

    untouched_after = client.get(
        f"/api/v1/spaces/{untouched['id']}", headers=headers
    ).json()["space"]
    assert untouched_after == untouched

    cleared = client.put(
        f"/api/v1/spaces/{target['id']}/default-character",
        headers=headers,
        json={"character_pack_id": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["default_character_pack_id"] is None
    assert cleared.json()["name"] == "Renamed"
    assert cleared.json()["topic"] == "new topic"
    assert cleared.json()["goal"] == "new goal"


def test_activation_enforces_adult_policy_without_mutating_space(client, owner_token: str) -> None:
    headers = _headers(owner_token)
    allowed = _create_character(client, headers, "Allowed")
    space = _create_space(client, headers, "Policy")
    assert client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": allowed["id"]},
    ).status_code == 200

    repository = get_container().repository
    legacy = repository.get_character(_create_character(client, headers, "Legacy")["id"])
    assert legacy is not None
    legacy.recipe = legacy.recipe.model_copy(update={"relationship_role": "lover"})
    repository.upsert_character(legacy)
    rejected_create = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Adult", "recipe": {"relationship_role": "lover"}},
    )
    assert rejected_create.status_code == 400

    before = client.get(f"/api/v1/spaces/{space['id']}", headers=headers).json()["space"]
    rejected = client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": legacy.id},
    )
    assert rejected.status_code == 400
    assert client.get(f"/api/v1/spaces/{space['id']}", headers=headers).json()["space"] == before


def test_character_delete_rejects_space_or_session_references_and_restores_assets(
    client,
    owner_token: str,
) -> None:
    headers = _headers(owner_token)
    default_character = _create_character(client, headers, "Space ref")
    session_character = _create_character(client, headers, "Session ref")
    unused = _create_character(client, headers, "Unused")
    space = _create_space(client, headers, "Delete guards")

    assert client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": default_character["id"]},
    ).status_code == 200
    container = get_container()
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with container.repository.connection() as conn:
        conn.execute(
            "INSERT INTO sessions (id, space_id, character_pack_id, state, summary, created_at, updated_at) "
            "VALUES (?, ?, ?, 'idle', '', ?, ?)",
            ("legacy-session", space["id"], session_character["id"], now, now),
        )
    asset_file = Path(container.repository.settings.characters_root) / session_character["id"] / "keep.txt"
    asset_file.parent.mkdir(parents=True)
    asset_file.write_text("keep", encoding="utf-8")

    for character_id in (default_character["id"], session_character["id"]):
        rejected = client.delete(f"/api/v1/characters/{character_id}", headers=headers)
        assert rejected.status_code == 409
        assert rejected.json()["code"] == "character_in_use"
        assert container.repository.get_character(character_id) is not None
    assert asset_file.read_text(encoding="utf-8") == "keep"

    deleted = client.delete(f"/api/v1/characters/{unused['id']}", headers=headers)
    assert deleted.status_code == 204
    assert container.repository.get_character(unused["id"]) is None
