from __future__ import annotations

import io
import json
import struct
import zipfile
from pathlib import Path

import pytest

from app.api.deps import get_container


_REPO_ROOT = Path(__file__).resolve().parents[3]
_BUNDLED_VRMA_PATH = (
    _REPO_ROOT
    / "apps"
    / "web"
    / "public"
    / "assets"
    / "characters"
    / "motions"
    / "companion-idle.vrma"
)
_PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
    "0000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082"
)


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


def _make_airi_character_zip() -> bytes:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "format": "airi-character-card",
                    "version": 1,
                    "card": {"path": "card.json", "spec": "chara_card_v3"},
                    "resources": {
                        "displayModel": {
                            "format": "vrm",
                            "path": "models/body-model.vrm",
                            "name": "AIRI API source.vrm",
                            "url": "https://untrusted.example/model.vrm",
                        }
                    },
                }
            ),
        )
        archive.writestr(
            "card.json",
            json.dumps(
                {
                    "spec": "chara_card_v3",
                    "spec_version": "3.0",
                    "data": {
                        "name": "AIRI API Mika",
                        "description": "Persona only.",
                        "system_prompt": "AIRI_API_PROMPT_MUST_NOT_LEAK",
                        "extensions": {"remote": "https://untrusted.example/extension"},
                    },
                }
            ),
        )
        archive.writestr("models/body-model.vrm", _make_vrm0(title="AIRI API VRM"))
    return payload.getvalue()


def _make_airi_archive_display_zip(display_format: str) -> bytes:
    model = io.BytesIO()
    with zipfile.ZipFile(model, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if display_format == "live2d-zip":
            archive.writestr(
                "avatar.model3.json",
                json.dumps(
                    {
                        "Version": 3,
                        "FileReferences": {
                            "Moc": "avatar.moc3",
                            "Textures": ["avatar.png"],
                        },
                    }
                ),
            )
            archive.writestr("avatar.moc3", b"MOC3-api-model")
        else:
            archive.writestr(
                "avatar.json",
                json.dumps(
                    {
                        "skeleton": {"spine": "4.2"},
                        "bones": [{"name": "root"}],
                        "slots": [],
                        "skins": [],
                        "animations": {},
                    }
                ),
            )
            archive.writestr("avatar.atlas.txt", "avatar.png\nsize: 1,1\nformat: RGBA8888\n")
        archive.writestr("avatar.png", _PNG_1X1)

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "format": "airi-character-card",
                    "version": 1,
                    "card": {"path": "card.json", "spec": "chara_card_v3"},
                    "resources": {
                        "displayModel": {
                            "format": display_format,
                            "path": "models/body-model.zip",
                            "name": f"AIRI API {display_format}",
                        }
                    },
                }
            ),
        )
        archive.writestr(
            "card.json",
            json.dumps(
                {
                    "spec": "chara_card_v3",
                    "spec_version": "3.0",
                    "data": {"name": f"AIRI API {display_format}"},
                }
            ),
        )
        archive.writestr("models/body-model.zip", model.getvalue())
    return payload.getvalue()


def test_character_import_route_supports_vrm_and_export_contract(client, owner_token: str) -> None:
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

    exported = client.get(f"/api/v1/characters/{payload['id']}/export", headers=_auth_headers(owner_token))
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert set(archive.namelist()) >= {
            "asset_manifest.json",
            "character.json",
            "recipe.json",
            "assets/model.vrm",
            "assets/licenses/vrm-meta.json",
        }
        manifest = json.loads(archive.read("asset_manifest.json"))
        assert manifest["redistribution_allowed"] == "yes"
        assert "api_key" not in archive.read("character.json").decode("utf-8").lower()

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


def test_character_import_route_supports_v3_character_card_without_prompt_overrides(
    client,
    owner_token: str,
) -> None:
    card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": "Mika",
            "nickname": "Miki",
            "description": "A multilingual companion. 你好!",
            "first_mes": "<char> greets {{user}}.",
            "alternate_greetings": ["<bot> welcomes <user>."],
            "system_prompt": "API_SYSTEM_OVERRIDE_MUST_NOT_LEAK",
            "post_history_instructions": "API_POST_HISTORY_MUST_NOT_LEAK",
            "extensions": {"avatar": "https://untrusted.example/avatar.png"},
        },
    }
    headers = _auth_headers(owner_token, **{"x-filename": "mika.json"})

    imported = client.post(
        "/api/v1/characters/import",
        headers=headers,
        content=json.dumps(card, ensure_ascii=False).encode("utf-8"),
    )

    assert imported.status_code == 201
    payload = imported.json()
    assert payload["name"] == "Mika"
    assert "Nickname:\nMiki" in payload["description"]
    assert "Miki greets the user." in payload["description"]
    assert "Miki welcomes the user." in payload["description"]
    assert "你好" in payload["description"]
    serialized_payload = json.dumps(payload, ensure_ascii=False)
    assert "API_SYSTEM_OVERRIDE_MUST_NOT_LEAK" not in serialized_payload
    assert "API_POST_HISTORY_MUST_NOT_LEAK" not in serialized_payload
    assert "untrusted.example" not in serialized_payload
    assert "extensions" not in payload["asset_manifest"]
    assert payload["asset_manifest"] == {
        "pack_kind": "recipe-only",
        "render_mode": "vrm-or-2d-fallback",
        "source_format": "character-card",
        "source_spec": "chara_card_v3",
        "source_spec_version": "3.0",
        "prompt_overrides_ignored": True,
    }

    remote_asset = client.get(
        f"/api/v1/characters/{payload['id']}/assets/avatar.png",
        headers=_auth_headers(owner_token),
    )
    assert remote_asset.status_code == 404

    exported = client.get(
        f"/api/v1/characters/{payload['id']}/export",
        headers=_auth_headers(owner_token),
    )
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        metadata = b"".join(
            archive.read(name)
            for name in ("character.json", "recipe.json", "asset_manifest.json")
        )
        assert b"API_SYSTEM_OVERRIDE_MUST_NOT_LEAK" not in metadata
        assert b"API_POST_HISTORY_MUST_NOT_LEAK" not in metadata
        assert b"untrusted.example" not in metadata
        assert archive.namelist() == ["character.json", "recipe.json", "asset_manifest.json"]


def test_character_import_route_supports_airi_zip_with_vrm(
    client,
    owner_token: str,
) -> None:
    imported = client.post(
        "/api/v1/characters/import",
        headers=_auth_headers(owner_token, **{"x-filename": "airi.zip"}),
        content=_make_airi_character_zip(),
    )

    assert imported.status_code == 201
    payload = imported.json()
    assert payload["name"] == "AIRI API Mika"
    assert payload["asset_manifest"]["format"] == "vrm"
    assert payload["asset_manifest"]["model_path"] == "model.vrm"
    assert payload["asset_manifest"]["license_path"] == "licenses/vrm-meta.json"
    assert payload["asset_manifest"]["source_filename"] == "body-model.vrm"
    assert payload["asset_manifest"]["source_format"] == "airi-character-card"
    assert payload["asset_manifest"]["source_display_model_format"] == "vrm"
    assert payload["asset_manifest"]["source_display_model_name"] == "AIRI API source.vrm"
    assert payload["asset_manifest"]["source_display_model_imported"] is True
    assert payload["asset_manifest"]["prompt_overrides_ignored"] is True
    assert "AIRI_API_PROMPT_MUST_NOT_LEAK" not in json.dumps(payload)
    assert "untrusted.example" not in json.dumps(payload)

    model = client.get(
        f"/api/v1/characters/{payload['id']}/assets/model.vrm",
        headers=_auth_headers(owner_token),
    )
    assert model.status_code == 200
    assert model.headers["cache-control"] == "private, no-store"
    assert model.headers["content-type"] == "model/gltf-binary"
    assert model.content == _make_vrm0(title="AIRI API VRM")
    original_path = client.get(
        f"/api/v1/characters/{payload['id']}/assets/models/body-model.vrm",
        headers=_auth_headers(owner_token),
    )
    assert original_path.status_code == 404

    exported = client.get(
        f"/api/v1/characters/{payload['id']}/export",
        headers=_auth_headers(owner_token),
    )
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert "assets/model.vrm" in archive.namelist()
        assert "assets/licenses/vrm-meta.json" in archive.namelist()


@pytest.mark.parametrize(
    ("display_format", "entrypoint"),
    [("live2d-zip", "avatar.model3.json"), ("spine-zip", "avatar.json")],
)
def test_character_import_route_supports_protected_airi_archive_display_models(
    client,
    owner_token: str,
    display_format: str,
    entrypoint: str,
) -> None:
    imported = client.post(
        "/api/v1/characters/import",
        headers=_auth_headers(owner_token, **{"x-filename": "airi.zip"}),
        content=_make_airi_archive_display_zip(display_format),
    )

    assert imported.status_code == 201
    payload = imported.json()
    manifest = payload["asset_manifest"]
    assert manifest["format"] == display_format
    assert manifest["validation_level"] == "structure-only"
    assert manifest["entrypoint"] == entrypoint
    assert manifest["model_path"] == "display-model/model.zip"
    assert manifest["redistribution_allowed"] == "no"
    assert manifest["source_display_model_imported"] is True

    unauthenticated = client.get(
        f"/api/v1/characters/{payload['id']}/assets/display-model/model.zip"
    )
    assert unauthenticated.status_code == 401
    model = client.get(
        f"/api/v1/characters/{payload['id']}/assets/display-model/model.zip",
        headers=_auth_headers(owner_token),
    )
    assert model.status_code == 200
    assert model.headers["cache-control"] == "private, no-store"
    assert model.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(model.content)) as archive:
        assert entrypoint in archive.namelist()

    exported = client.get(
        f"/api/v1/characters/{payload['id']}/export",
        headers=_auth_headers(owner_token),
    )
    assert exported.status_code == 400
    assert "redistribution" in exported.json()["detail"].lower()


def test_character_card_size_limit_is_enforced_before_service_dispatch(
    client,
    owner_token: str,
    monkeypatch,
) -> None:
    def unexpected_dispatch(*, filename: str, data: bytes):
        raise AssertionError(f"service received {filename} with {len(data)} bytes")

    monkeypatch.setattr(
        get_container().characters,
        "import_character_upload",
        unexpected_dispatch,
    )

    response = client.post(
        "/api/v1/characters/import",
        headers=_auth_headers(owner_token, **{"x-filename": "oversized.json"}),
        content=b"x" * 1_000_001,
    )

    assert response.status_code == 400
    assert "limit" in response.json()["detail"].lower()


def test_character_vrma_asset_uses_glb_media_type(client, owner_token: str) -> None:
    headers = _auth_headers(owner_token)
    payload = io.BytesIO()
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt", "motions/wave.vrma"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }
    recipe = {"motions": {"idle": "breathe", "greeting": "motions/wave.vrma"}}
    with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("character.json", json.dumps({"name": "Animated API"}))
        archive.writestr("recipe.json", json.dumps(recipe))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        archive.writestr("assets/model.vrm", _make_vrm0())
        archive.writestr("assets/LICENSE.txt", b"CC0")
        archive.writestr("assets/motions/wave.vrma", _make_vrma())

    imported = client.post(
        "/api/v1/characters/import",
        headers={**headers, "x-filename": "animated.zip"},
        content=payload.getvalue(),
    )
    assert imported.status_code == 201

    asset = client.get(
        f"/api/v1/characters/{imported.json()['id']}/assets/motions/wave.vrma",
        headers=headers,
    )
    assert asset.status_code == 200
    assert asset.headers["content-type"] == "model/gltf-binary"
    assert asset.content == _make_vrma()


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


def test_character_import_route_rejects_restricted_vrm_export(client, owner_token: str) -> None:
    imported = client.post(
        "/api/v1/characters/import",
        headers=_auth_headers(owner_token, **{"x-filename": "restricted.vrm"}),
        content=_make_vrm0(title="Restricted API", license_name="Redistribution_Prohibited"),
    )
    assert imported.status_code == 201
    imported_payload = imported.json()

    metadata_override = client.put(
        f"/api/v1/characters/{imported_payload['id']}",
        headers=_auth_headers(owner_token),
        json={
            "name": imported_payload["name"],
            "description": imported_payload["description"],
            "recipe": imported_payload["recipe"],
            "asset_manifest": {
                **imported_payload["asset_manifest"],
                "redistribution_allowed": "yes",
            },
        },
    )
    assert metadata_override.status_code == 422

    exported = client.get(
        f"/api/v1/characters/{imported_payload['id']}/export",
        headers=_auth_headers(owner_token),
    )
    assert exported.status_code == 400
    assert "redistribution" in exported.json()["detail"].lower()


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
