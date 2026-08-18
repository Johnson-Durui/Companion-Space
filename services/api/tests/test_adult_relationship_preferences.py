from __future__ import annotations

import io
import json
import zipfile

from app.models.domain import CharacterRecipe


def _auth_headers(owner_token: str, **extra: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {owner_token}"}
    headers.update(extra)
    return headers


def _lover_recipe(**updates: object) -> dict[str, object]:
    recipe = CharacterRecipe(relationship_role="lover").model_dump(mode="json")
    recipe.update(updates)
    return recipe


def _recipe_only_pack(*, relationship_role: str) -> bytes:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "character.json",
            json.dumps({"name": "Imported relationship", "description": "test"}),
        )
        archive.writestr(
            "recipe.json",
            json.dumps(
                CharacterRecipe(
                    relationship_role=relationship_role,
                ).model_dump(mode="json")
            ),
        )
        archive.writestr(
            "asset_manifest.json",
            json.dumps(
                {
                    "pack_kind": "recipe-only",
                    "render_mode": "vrm-or-2d-fallback",
                    "asset_paths": [],
                }
            ),
        )
    return payload.getvalue()


def test_adult_relationship_preferences_default_off_and_require_owner_confirmation(
    client,
    owner_token: str,
) -> None:
    unauthorized = client.get("/api/v1/vault/preferences")
    assert unauthorized.status_code == 401

    initial = client.get(
        "/api/v1/vault/preferences",
        headers=_auth_headers(owner_token),
    )
    assert initial.status_code == 200
    assert initial.json() == {
        "adult_relationships_enabled": False,
        "adult_age_confirmed_at": None,
    }

    missing_confirmation = client.put(
        "/api/v1/vault/preferences",
        headers=_auth_headers(owner_token),
        json={
            "adult_relationships_enabled": True,
            "confirm_age_18_or_older": False,
        },
    )
    assert missing_confirmation.status_code == 400
    assert "18" in missing_confirmation.json()["detail"]

    enabled = client.put(
        "/api/v1/vault/preferences",
        headers=_auth_headers(owner_token),
        json={
            "adult_relationships_enabled": True,
            "confirm_age_18_or_older": True,
        },
    )
    assert enabled.status_code == 200
    assert enabled.json()["adult_relationships_enabled"] is True
    assert enabled.json()["adult_age_confirmed_at"]

    disabled = client.put(
        "/api/v1/vault/preferences",
        headers=_auth_headers(owner_token),
        json={
            "adult_relationships_enabled": False,
            "confirm_age_18_or_older": False,
        },
    )
    assert disabled.status_code == 200
    assert disabled.json() == {
        "adult_relationships_enabled": False,
        "adult_age_confirmed_at": None,
    }


def test_love_relationships_are_rejected_until_adult_mode_is_enabled(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    blocked_create = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Blocked lover",
            "description": "",
            "recipe": _lover_recipe(),
        },
    )
    assert blocked_create.status_code == 400
    assert "adult relationship mode" in blocked_create.json()["detail"].lower()

    enabled = client.put(
        "/api/v1/vault/preferences",
        headers=headers,
        json={
            "adult_relationships_enabled": True,
            "confirm_age_18_or_older": True,
        },
    )
    assert enabled.status_code == 200

    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Confirmed adult companion",
            "description": "",
            "recipe": _lover_recipe(),
        },
    )
    assert created.status_code == 201

    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Adult gate session"},
    )
    assert space.status_code == 201
    active_session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={
            "space_id": space.json()["id"],
            "character_pack_id": created.json()["id"],
        },
    )
    assert active_session.status_code == 201

    disabled = client.put(
        "/api/v1/vault/preferences",
        headers=headers,
        json={
            "adult_relationships_enabled": False,
            "confirm_age_18_or_older": False,
        },
    )
    assert disabled.status_code == 200

    duplicate = client.post(
        f"/api/v1/characters/{created.json()['id']}/duplicate",
        headers=headers,
        json={},
    )
    assert duplicate.status_code == 400

    session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={
            "space_id": space.json()["id"],
            "character_pack_id": created.json()["id"],
        },
    )
    assert session.status_code == 400
    assert "adult relationship mode" in session.json()["detail"].lower()

    blocked_turn = client.post(
        f"/api/v1/sessions/{active_session.json()['id']}/turns",
        headers=headers,
        json={"text": "Keep studying"},
    )
    assert blocked_turn.status_code == 400
    assert "adult relationship mode" in blocked_turn.json()["detail"].lower()
    transcript = client.get(
        f"/api/v1/sessions/{active_session.json()['id']}",
        headers=headers,
    )
    assert transcript.json()["session"]["state"] == "idle"
    assert transcript.json()["turns"] == []

    blocked_demo = client.post(
        f"/api/v1/sessions/{active_session.json()['id']}/demos",
        headers=headers,
        json={"topic": "A safe topic"},
    )
    assert blocked_demo.status_code == 400
    blocked_ticket = client.post(
        f"/api/v1/sessions/{active_session.json()['id']}/realtime-ticket",
        headers=headers,
    )
    assert blocked_ticket.status_code == 400
    blocked_preview = client.post(
        f"/api/v1/characters/{created.json()['id']}/voice-preview",
        headers=headers,
        json={
            "space_id": space.json()["id"],
            "text": "Voice preview",
        },
    )
    assert blocked_preview.status_code == 400


def test_update_import_and_custom_relationship_cannot_bypass_adult_gate(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Safe friend",
            "description": "",
            "recipe": CharacterRecipe().model_dump(mode="json"),
        },
    )
    assert created.status_code == 201

    blocked_update = client.put(
        f"/api/v1/characters/{created.json()['id']}",
        headers=headers,
        json={
            "name": "Unsafe update",
            "description": "",
            "recipe": _lover_recipe(),
        },
    )
    assert blocked_update.status_code == 400

    for index, relationship_role in enumerate(
        ("lover", "romantic partner", "恋人")
    ):
        imported = client.post(
            "/api/v1/characters/import",
            headers=_auth_headers(
                owner_token,
                **{"x-filename": f"relationship-{index}.zip"},
            ),
            content=_recipe_only_pack(relationship_role=relationship_role),
        )
        assert imported.status_code == 400
        assert "adult relationship mode" in imported.json()["detail"].lower()


def test_vault_reset_clears_adult_confirmation_without_erasing_characters(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    assert client.put(
        "/api/v1/vault/preferences",
        headers=headers,
        json={
            "adult_relationships_enabled": True,
            "confirm_age_18_or_older": True,
        },
    ).status_code == 200
    character = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Persisted character",
            "description": "",
            "recipe": _lover_recipe(),
        },
    )
    assert character.status_code == 201

    reset = client.post(
        "/api/v1/vault/reset",
        headers=headers,
        json={"password": "super-secret-pass"},
    )
    assert reset.status_code == 200
    reinitialized = client.post(
        "/api/v1/vault/init",
        json={"password": "replacement-secret-pass"},
    )
    assert reinitialized.status_code == 200
    next_headers = _auth_headers(reinitialized.json()["owner_token"])

    preferences = client.get(
        "/api/v1/vault/preferences",
        headers=next_headers,
    )
    assert preferences.json() == {
        "adult_relationships_enabled": False,
        "adult_age_confirmed_at": None,
    }
    persisted = client.get(
        f"/api/v1/characters/{character.json()['id']}",
        headers=next_headers,
    )
    assert persisted.status_code == 200
