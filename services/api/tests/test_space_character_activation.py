from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

from app.api.deps import get_container
from app.models.domain import CharacterRecipe, SessionRecord, SessionState
from app.services.repository import CharacterInUseError


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def _create_character(client, headers: dict[str, str], name: str, *, lover: bool = False) -> dict:
    recipe = CharacterRecipe(
        relationship_role="lover" if lover else "study companion"
    ).model_dump(mode="json")
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


def test_session_character_is_an_immutable_snapshot_and_new_sessions_use_current_default(
    client,
    owner_token: str,
) -> None:
    headers = _headers(owner_token)
    first = _create_character(client, headers, "First snapshot")
    second = _create_character(client, headers, "Second snapshot")
    space = _create_space(client, headers, "Snapshots")

    assert client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": first["id"]},
    ).status_code == 200
    old_session = client.post(
        "/api/v1/sessions", headers=headers, json={"space_id": space["id"]}
    ).json()

    assert client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": second["id"]},
    ).status_code == 200
    new_session = client.post(
        "/api/v1/sessions", headers=headers, json={"space_id": space["id"]}
    ).json()
    explicit = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space["id"], "character_pack_id": first["id"]},
    ).json()

    assert old_session["character_pack_id"] == first["id"]
    assert new_session["character_pack_id"] == second["id"]
    assert explicit["character_pack_id"] == first["id"]
    assert get_container().repository.get_session(old_session["id"]).character_pack_id == first["id"]


def test_activation_enforces_adult_policy_without_mutating_space(client, owner_token: str) -> None:
    headers = _headers(owner_token)
    allowed = _create_character(client, headers, "Allowed")
    space = _create_space(client, headers, "Policy")
    assert client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": allowed["id"]},
    ).status_code == 200

    assert client.put(
        "/api/v1/vault/preferences",
        headers=headers,
        json={"adult_relationships_enabled": True, "confirm_age_18_or_older": True},
    ).status_code == 200
    lover = _create_character(client, headers, "Adult", lover=True)
    assert client.put(
        "/api/v1/vault/preferences",
        headers=headers,
        json={"adult_relationships_enabled": False, "confirm_age_18_or_older": False},
    ).status_code == 200

    before = client.get(f"/api/v1/spaces/{space['id']}", headers=headers).json()["space"]
    rejected = client.put(
        f"/api/v1/spaces/{space['id']}/default-character",
        headers=headers,
        json={"character_pack_id": lover["id"]},
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
    session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space["id"], "character_pack_id": session_character["id"]},
    )
    assert session.status_code == 201

    container = get_container()
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


def test_session_upsert_cannot_rebind_snapshot(isolated_settings) -> None:
    container = get_container()
    first_space = container.spaces.create_space(name="First")
    second_space = container.spaces.create_space(name="Second")
    first = container.characters.create_character(name="First")
    second = container.characters.create_character(name="Second")
    session = container.companion.create_session(
        space_id=first_space.id,
        character_pack_id=first.id,
    )

    rebound = session.model_copy(
        update={
            "space_id": second_space.id,
            "character_pack_id": second.id,
            "created_at": session.created_at.replace(year=session.created_at.year - 1),
            "state": SessionState.listening,
        }
    )
    upserted = container.repository.upsert_session(rebound)

    stored = container.repository.get_session(session.id)
    assert stored is not None
    assert upserted == stored
    assert upserted.space_id == first_space.id
    assert upserted.character_pack_id == first.id
    assert upserted.created_at == session.created_at
    assert stored.space_id == first_space.id
    assert stored.character_pack_id == first.id
    assert stored.created_at == session.created_at
    assert stored.state is SessionState.listening


def test_session_create_and_character_delete_are_linearized(isolated_settings) -> None:
    container = get_container()
    space = container.spaces.create_space(name="Concurrent")
    character = container.characters.create_character(name="Contended")
    now = space.created_at
    session = SessionRecord(
        id=str(uuid4()),
        space_id=space.id,
        character_pack_id=character.id,
        state=SessionState.idle,
        created_at=now,
        updated_at=now,
    )
    barrier = Barrier(2)

    def create() -> str:
        barrier.wait()
        try:
            container.repository.create_session(
                session,
                requested_character_pack_id=character.id,
                fallback_character_pack_id=character.id,
                validate_character=lambda _: None,
            )
        except ValueError:
            return "missing"
        return "created"

    def delete() -> str:
        barrier.wait()
        try:
            container.repository.delete_character(character.id)
        except CharacterInUseError:
            return "in-use"
        return "deleted"

    with ThreadPoolExecutor(max_workers=2) as executor:
        create_future = executor.submit(create)
        delete_future = executor.submit(delete)
        outcomes = {create_future.result(), delete_future.result()}

    assert outcomes in ({"created", "in-use"}, {"missing", "deleted"})
    stored_session = container.repository.get_session(session.id)
    stored_character = container.repository.get_character(character.id)
    assert (stored_session is None) is (stored_character is None)
