from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from app.api.deps import get_container


_REPO_ROOT = Path(__file__).resolve().parents[3]
_BUNDLED_VRMA_PATH = _REPO_ROOT / "assets-archive" / "motions" / "companion-idle.vrma"


def _auth_headers(owner_token: str, **extra: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {owner_token}"}
    headers.update(extra)
    return headers


def _make_glb(document: dict) -> bytes:
    json_chunk = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    chunk = struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
    total_length = 12 + len(chunk)
    return struct.pack("<4sII", b"glTF", 2, total_length) + chunk


def _make_vrm0(*, title: str = "Api Mika", license_name: str = "CC0") -> bytes:
    return _make_glb(
        {
            "asset": {"version": "2.0"},
            "extensionsUsed": ["VRM"],
            "extensions": {
                "VRM": {
                    "meta": {
                        "title": title,
                        "author": "API Author",
                        "allowedUserName": "Everyone",
                        "violentUssageName": "Disallow",
                        "sexualUssageName": "Disallow",
                        "commercialUssageName": "Allow",
                        "licenseName": license_name,
                    }
                }
            },
        }
    )


def _make_vrma() -> bytes:
    return _BUNDLED_VRMA_PATH.read_bytes()


def test_character_import_route_serves_single_vrm(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token, **{"x-filename": "api-mika.vrm"})
    imported = client.post("/api/v1/characters/import", headers=headers, content=_make_vrm0())

    assert imported.status_code == 201
    payload = imported.json()
    assert payload["name"] == "Api Mika"
    assert payload["asset_manifest"]["source_filename"] == "api-mika.vrm"
    assert payload["asset_manifest"]["model_path"] == "model.vrm"
    assert payload["asset_manifest"]["vrm_meta"]["license_name"] == "CC0"
    assert payload["asset_manifest"]["redistribution_allowed"] == "yes"
    assert payload["asset_manifest"]["modification_allowed"] == "yes"
    assert payload["asset_manifest"]["attribution_required"] == "no"

    asset = client.get(
        f"/api/v1/characters/{payload['id']}/assets/model.vrm",
        headers=_auth_headers(owner_token),
    )
    assert asset.status_code == 200
    assert asset.headers["cache-control"] == "private, no-store"
    assert asset.headers["content-type"] == "model/gltf-binary"
    assert asset.content == _make_vrm0()

    escaped_asset = client.get(
        f"/api/v1/characters/{payload['id']}/assets/../vault.json",
        headers=_auth_headers(owner_token),
    )
    assert escaped_asset.status_code == 404


def test_character_avatar_routes_replace_and_remove_the_attached_vrm(
    client,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Persistent Persona",
            "description": "Keep this identity",
            "recipe": {"personality": "steady", "voice_id": "voice-kept"},
        },
    )
    assert created.status_code == 201
    character = created.json()
    avatar_url = f"/api/v1/characters/{character['id']}/avatar"

    unauthenticated = client.put(
        avatar_url,
        headers={"x-filename": "replacement.vrm"},
        content=_make_vrm0(title="Replacement"),
    )
    assert unauthenticated.status_code == 401

    replaced = client.put(
        avatar_url,
        headers={**headers, "x-filename": "replacement.vrm"},
        content=_make_vrm0(title="Replacement"),
    )

    assert replaced.status_code == 200
    payload = replaced.json()
    assert payload["id"] == character["id"]
    assert payload["name"] == "Persistent Persona"
    assert payload["description"] == "Keep this identity"
    assert payload["recipe"]["personality"] == "steady"
    assert payload["recipe"]["voice_id"] == "voice-kept"
    assert payload["asset_manifest"]["source_filename"] == "replacement.vrm"
    asset = client.get(
        f"/api/v1/characters/{character['id']}/assets/model.vrm",
        headers=headers,
    )
    assert asset.status_code == 200
    assert asset.content == _make_vrm0(title="Replacement")

    invalid = client.put(
        avatar_url,
        headers={**headers, "x-filename": "broken.vrm"},
        content=b"not-a-vrm",
    )
    assert invalid.status_code == 400
    asset_after_invalid = client.get(
        f"/api/v1/characters/{character['id']}/assets/model.vrm",
        headers=headers,
    )
    assert asset_after_invalid.status_code == 200
    assert asset_after_invalid.content == _make_vrm0(title="Replacement")
    persisted_after_invalid = client.get(
        f"/api/v1/characters/{character['id']}",
        headers=headers,
    )
    assert persisted_after_invalid.status_code == 200
    assert persisted_after_invalid.json() == payload

    unauthenticated_delete = client.delete(avatar_url)
    assert unauthenticated_delete.status_code == 401

    removed = client.delete(avatar_url, headers=headers)

    assert removed.status_code == 200
    assert removed.json()["id"] == character["id"]
    assert removed.json()["asset_manifest"]["pack_kind"] == "recipe-only"
    missing_asset = client.get(
        f"/api/v1/characters/{character['id']}/assets/model.vrm",
        headers=headers,
    )
    assert missing_asset.status_code == 404


def test_character_avatar_route_requires_vrm_filename_and_enforces_size_limit(
    client,
    owner_token: str,
    monkeypatch,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Filename Guard"},
    ).json()

    missing_header = client.put(
        f"/api/v1/characters/{created['id']}/avatar",
        headers=headers,
        content=_make_vrm0(),
    )
    response = client.put(
        f"/api/v1/characters/{created['id']}/avatar",
        headers={**headers, "x-filename": "avatar.zip"},
        content=_make_vrm0(),
    )
    monkeypatch.setattr(get_container().settings, "max_character_pack_size_bytes", 16)
    oversized = client.put(
        f"/api/v1/characters/{created['id']}/avatar",
        headers={**headers, "x-filename": "avatar.vrm"},
        content=_make_vrm0(),
    )

    assert missing_header.status_code == 400
    assert "x-filename" in missing_header.json()["detail"].lower()
    assert response.status_code == 400
    assert ".vrm" in response.json()["detail"]
    assert oversized.status_code == 400
    assert "limit" in oversized.json()["detail"].lower()


@pytest.mark.parametrize(
    ("filename", "content", "error"),
    [
        ("archive.zip", b"zip", ".vrm"),
        ("card.json", b"{}", ".vrm"),
        (None, b"missing", "X-Filename"),
        ("oversized.vrm", b"x" * 17, "limit"),
    ],
)
def test_character_import_validates_format_and_size_before_dispatch(
    client, owner_token: str, monkeypatch, filename, content, error,
) -> None:
    def unexpected_dispatch(*, filename: str, data: bytes):
        raise AssertionError(f"service received {filename} with {len(data)} bytes")

    container = get_container()
    monkeypatch.setattr(container.settings, "max_character_pack_size_bytes", 16)
    monkeypatch.setattr(container.characters, "import_character_upload", unexpected_dispatch)
    headers = _auth_headers(owner_token)
    if filename is not None:
        headers["X-Filename"] = filename
    response = client.post("/api/v1/characters/import", headers=headers, content=content)

    assert response.status_code == 400
    assert error.lower() in response.json()["detail"].lower()


@pytest.mark.parametrize("state", ["idle", "listening", "thinking", "speaking"])
def test_managed_motion_routes_upload_serve_and_delete(
    client,
    owner_token: str,
    state: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": f"API {state}"},
    ).json()
    route = f"/api/v1/characters/{created['id']}/motions/{state}"

    unauthorized = client.put(
        route,
        headers={"X-Filename": f"{state}.vrma"},
        content=_make_vrma(),
    )
    assert unauthorized.status_code == 401
    uploaded = client.put(
        route,
        headers=_auth_headers(owner_token, **{"X-Filename": f"{state}.vrma"}),
        content=_make_vrma(),
    )
    assert uploaded.status_code == 200
    motion = uploaded.json()["asset_manifest"]["managed_motions"][state]

    assert client.delete(route).status_code == 401
    assert client.get(
        f"/api/v1/characters/{created['id']}/assets/{motion['path']}"
    ).status_code == 401
    unchanged = client.get(
        f"/api/v1/characters/{created['id']}",
        headers=headers,
    ).json()
    assert unchanged["asset_manifest"]["managed_motions"][state] == motion

    asset = client.get(
        f"/api/v1/characters/{created['id']}/assets/{motion['path']}",
        headers=headers,
    )
    assert asset.status_code == 200
    assert asset.content == _make_vrma()
    assert asset.headers["content-type"] == "model/gltf-binary"
    assert asset.headers["cache-control"] == "private, no-store"

    deleted = client.delete(route, headers=headers)
    assert deleted.status_code == 200
    deleted_at = deleted.json()["updated_at"]
    assert "managed_motions" not in deleted.json()["asset_manifest"]
    assert client.delete(route, headers=headers).json()["updated_at"] == deleted_at


@pytest.mark.parametrize(
    ("state", "filename", "content", "error"),
    [
        ("walking", "walk.vrma", None, "state"),
        ("idle", "idle.glb", None, ".vrma"),
        ("idle", None, None, "X-Filename"),
        ("idle", "idle.vrma", b"not vrma", "VRMA"),
    ],
)
def test_managed_motion_route_rejects_invalid_input_without_mutation(
    client,
    owner_token: str,
    state: str,
    filename: str | None,
    content: bytes | None,
    error: str,
) -> None:
    headers = _auth_headers(owner_token)
    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Invalid motion"},
    ).json()
    before = client.get(f"/api/v1/characters/{created['id']}", headers=headers).json()
    if filename is not None:
        headers = _auth_headers(owner_token, **{"X-Filename": filename})
    response = client.put(
        f"/api/v1/characters/{created['id']}/motions/{state}",
        headers=headers,
        content=_make_vrma() if content is None else content,
    )

    assert response.status_code == 400
    assert error.lower() in response.json()["detail"].lower()
    after = client.get(f"/api/v1/characters/{created['id']}", headers=_auth_headers(owner_token)).json()
    assert after == before


def test_character_voice_preview_streams_ephemeral_mock_pcm(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    space = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Voice Preview Space", "topic": "", "goal": ""},
    )
    character = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Preview Companion",
            "description": "",
            "recipe": {
                "voice_provider": "mock",
                "voice_model": "mock-voice",
                "voice_id": "preview",
                "speaking_rate": 1.0,
            },
        },
    )

    assert space.status_code == 201
    assert character.status_code == 201

    preview = client.post(
        f"/api/v1/characters/{character.json()['id']}/voice-preview",
        headers=headers,
        json={
            "space_id": space.json()["id"],
            "text": "这段声音只用于即时试听。",
            "voice_id": "unsaved-preview-voice",
            "speaking_rate": 1.15,
        },
    )

    assert preview.status_code == 200
    assert preview.headers["content-type"] == "audio/pcm;rate=24000"
    assert preview.headers["cache-control"] == "no-store"
    assert preview.headers["x-audio-channels"] == "1"
    assert preview.headers["x-audio-sample-rate"] == "24000"
    assert len(preview.content) == 2 * 24_000 * 2


def test_character_create_rejects_invalid_recipe_bounds(client, owner_token: str) -> None:
    created = client.post(
        "/api/v1/characters",
        headers=_auth_headers(owner_token),
        json={
            "name": "Broken Recipe",
            "description": "",
            "recipe": {
                "warmth": 101,
                "initiative": -1,
                "speaking_rate": 0.4,
                "voice_id": "",
                "accessories": ["", "headphones"],
            },
        },
    )

    assert created.status_code == 422
    payload = json.dumps(created.json(), ensure_ascii=False)
    assert "warmth" in payload
    assert "initiative" in payload
    assert "speaking_rate" in payload
    assert "voice_id" in payload
    assert "accessories" in payload


def test_character_avatar_framing_defaults_and_round_trips(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    defaulted = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Default Framing", "description": "", "recipe": {}},
    )
    assert defaulted.status_code == 201
    assert defaulted.json()["recipe"]["avatar_framing"] == "full_body"

    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Portrait Companion",
            "description": "A close camera composition.",
            "recipe": {"avatar_framing": "portrait"},
        },
    )
    assert created.status_code == 201
    character_id = created.json()["id"]
    assert created.json()["recipe"]["avatar_framing"] == "portrait"

    fetched = client.get(f"/api/v1/characters/{character_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["recipe"]["avatar_framing"] == "portrait"

    updated_payload = fetched.json()
    updated_payload["recipe"]["avatar_framing"] = "full_body"
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
    assert updated.json()["recipe"]["avatar_framing"] == "full_body"

    refetched = client.get(f"/api/v1/characters/{character_id}", headers=headers)
    assert refetched.status_code == 200
    assert refetched.json()["recipe"]["avatar_framing"] == "full_body"


def test_character_create_rejects_invalid_avatar_framing(client, owner_token: str) -> None:
    created = client.post(
        "/api/v1/characters",
        headers=_auth_headers(owner_token),
        json={
            "name": "Broken Framing",
            "description": "",
            "recipe": {"avatar_framing": "extreme_closeup"},
        },
    )

    assert created.status_code == 422
    assert "avatar_framing" in json.dumps(created.json(), ensure_ascii=False)


def test_character_stage_background_defaults_and_round_trips(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    defaulted = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Default Stage", "description": "", "recipe": {}},
    )
    assert defaulted.status_code == 201
    assert defaulted.json()["recipe"]["stage_background"] == "neutral"

    created = client.post(
        "/api/v1/characters",
        headers=headers,
        json={
            "name": "Midnight Companion",
            "description": "A darker local stage.",
            "recipe": {"stage_background": "midnight"},
        },
    )
    assert created.status_code == 201
    character_id = created.json()["id"]
    assert created.json()["recipe"]["stage_background"] == "midnight"

    fetched = client.get(f"/api/v1/characters/{character_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["recipe"]["stage_background"] == "midnight"

    updated_payload = fetched.json()
    updated_payload["recipe"]["stage_background"] = "study"
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
    assert updated.json()["recipe"]["stage_background"] == "study"

    refetched = client.get(f"/api/v1/characters/{character_id}", headers=headers)
    assert refetched.status_code == 200
    assert refetched.json()["recipe"]["stage_background"] == "study"


def test_character_create_rejects_invalid_stage_background(client, owner_token: str) -> None:
    created = client.post(
        "/api/v1/characters",
        headers=_auth_headers(owner_token),
        json={
            "name": "Broken Stage",
            "description": "",
            "recipe": {"stage_background": "sunset_beach"},
        },
    )

    assert created.status_code == 422
    assert "stage_background" in json.dumps(created.json(), ensure_ascii=False)
