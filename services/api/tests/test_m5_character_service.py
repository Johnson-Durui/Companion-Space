from __future__ import annotations

import hashlib
import json
import shutil
import stat
import struct
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from threading import Event
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import pytest

from app.models.domain import CharacterRecipe, StudySpace
from app.services.characters import CharacterService
from app.services.repository import SQLiteRepository


_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_CHARACTER_RECIPE_PATH = _REPO_ROOT / "libs" / "schemas" / "default_character_recipe.json"
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


def _local_settings(isolated_settings):
    return isolated_settings.model_copy(
        update={
            "embedding_provider": "local_hybrid",
            "reranker_provider": "local",
        }
    )


def _make_glb(document: dict) -> bytes:
    json_chunk = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    chunk = struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
    total_length = 12 + len(chunk)
    return struct.pack("<4sII", b"glTF", 2, total_length) + chunk


def _append_glb_chunk(data: bytes, chunk_type: bytes, payload: bytes) -> bytes:
    payload += b"\0" * ((4 - len(payload) % 4) % 4)
    chunk = struct.pack("<I4s", len(payload), chunk_type) + payload
    return data[:8] + struct.pack("<I", len(data) + len(chunk)) + data[12:] + chunk


def _make_vrm0(*, title: str = "Aki", license_name: str = "CC0") -> bytes:
    return _make_glb(
        {
            "asset": {"version": "2.0"},
            "extensionsUsed": ["VRM"],
            "extensions": {
                "VRM": {
                    "meta": {
                        "title": title,
                        "author": "VRM Author",
                        "allowedUserName": "Everyone",
                        "violentUssageName": "Disallow",
                        "sexualUssageName": "Disallow",
                        "commercialUssageName": "Allow",
                        "licenseName": license_name,
                        "otherPermissionUrl": "https://example.com/terms",
                    }
                }
            },
        }
    )


def _make_vrm1(*, name: str = "Hikari", allow_redistribution: bool = True) -> bytes:
    return _make_glb(
        {
            "asset": {"version": "2.0"},
            "extensionsUsed": ["VRMC_vrm"],
            "extensions": {
                "VRMC_vrm": {
                    "specVersion": "1.0",
                    "meta": {
                        "name": name,
                        "authors": ["VRM1 Author"],
                        "avatarPermission": "everyone",
                        "allowExcessivelyViolentUsage": False,
                        "allowExcessivelySexualUsage": False,
                        "commercialUsage": "allow",
                        "creditNotation": "required",
                        "allowRedistribution": allow_redistribution,
                        "modification": "allowModificationRedistribution",
                        "licenseUrl": "https://vrm.dev/licenses/1.0/",
                    },
                }
            },
        }
    )


def _rewrite_vrma(mutator: Callable[[dict], None]) -> bytes:
    data = _BUNDLED_VRMA_PATH.read_bytes()
    json_length, chunk_type = struct.unpack("<I4s", data[12:20])
    assert chunk_type == b"JSON"
    document = json.loads(data[20 : 20 + json_length].decode("utf-8").rstrip())
    mutator(document)
    json_chunk = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    tail = data[20 + json_length :]
    total_length = 12 + 8 + len(json_chunk) + len(tail)
    return (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_chunk), b"JSON")
        + json_chunk
        + tail
    )


def _rewrite_vrma_binary(*, byte_offset: int, values: tuple[float, ...]) -> bytes:
    data = bytearray(_BUNDLED_VRMA_PATH.read_bytes())
    json_length = struct.unpack("<I", data[12:16])[0]
    binary_header = 20 + json_length
    assert data[binary_header + 4 : binary_header + 8] == b"BIN\0"
    for index, value in enumerate(values):
        struct.pack_into("<f", data, binary_header + 8 + byte_offset + index * 4, value)
    return bytes(data)


def _rewrite_vrma_chunks(*, order: tuple[str, ...]) -> bytes:
    data = _BUNDLED_VRMA_PATH.read_bytes()
    json_length = struct.unpack("<I", data[12:16])[0]
    json_chunk = data[12 : 20 + json_length]
    binary_chunk = data[20 + json_length :]
    chunks = {
        "json": json_chunk,
        "bin": binary_chunk,
        "unknown": struct.pack("<I4s", 4, b"TEST") + b"nope",
    }
    body = b"".join(chunks[name] for name in order)
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def _make_vrma(*, target_path: str = "rotation") -> bytes:
    if target_path == "rotation":
        return _BUNDLED_VRMA_PATH.read_bytes()
    return _rewrite_vrma(
        lambda document: document["animations"][0]["channels"][0]["target"].update(
            {"path": target_path}
        )
    )


def _asset_tree_bytes(service: CharacterService, character_id: str) -> dict[str, bytes]:
    root = service._asset_root(character_id)
    if not root.exists():
        return {}
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def _build_pack(
    *,
    vrm_bytes: bytes,
    manifest: dict,
    recipe: dict | None = None,
    character: dict | None = None,
    extra_files: dict[str, bytes] | None = None,
) -> bytes:
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "character.json",
            json.dumps(character or {"name": "Imported Pack", "description": "Pack import"}, sort_keys=True),
        )
        archive.writestr(
            "recipe.json",
            json.dumps(recipe or CharacterRecipe(personality="gentle").model_dump(mode="json"), sort_keys=True),
        )
        archive.writestr("asset_manifest.json", json.dumps(manifest, sort_keys=True))
        archive.writestr("assets/model.vrm", vrm_bytes)
        for path, content in (extra_files or {}).items():
            archive.writestr(path, content)
    return payload.getvalue()


def _airi_display_path(display_format: str) -> str:
    return "models/body-model.vrm" if display_format == "vrm" else "models/body-model.zip"


def _make_live2d_zip(*, model: dict | None = None, extra_files: dict[str, bytes] | None = None) -> bytes:
    payload = BytesIO()
    document = model or {
        "Version": 3,
        "FileReferences": {
            "Moc": "avatar.moc3",
            "Textures": ["textures/avatar.png"],
        },
    }
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("avatar.model3.json", json.dumps(document))
        archive.writestr("avatar.moc3", b"MOC3-local-model")
        archive.writestr("textures/avatar.png", _PNG_1X1)
        for path, content in (extra_files or {}).items():
            archive.writestr(path, content)
    return payload.getvalue()


def _make_spine_zip(*, atlas: str = "avatar.png\nsize: 1,1\nformat: RGBA8888\n", extra_files: dict[str, bytes] | None = None) -> bytes:
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
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
        archive.writestr("avatar.atlas", atlas)
        archive.writestr("avatar.png", _PNG_1X1)
        for path, content in (extra_files or {}).items():
            archive.writestr(path, content)
    return payload.getvalue()


def _build_airi_pack(
    *,
    display_format: str = "vrm",
    manifest: dict | None = None,
    card: dict | None = None,
    extra_files: dict[str, bytes] | None = None,
    include_display_model: bool = True,
    display_model_bytes: bytes | None = None,
) -> bytes:
    payload = BytesIO()
    display_path = _airi_display_path(display_format)
    default_manifest = {
        "format": "airi-character-card",
        "version": 1,
        "card": {"path": "card.json", "spec": "chara_card_v3"},
        "extensions": {"remote": "https://untrusted.example/extension.json"},
    }
    if include_display_model:
        default_manifest["resources"] = {
            "displayModel": {
                "format": display_format,
                "path": display_path,
                "name": f"AIRI source model.{display_path.rsplit('.', 1)[-1]}",
                "url": "https://untrusted.example/avatar.bin",
            }
        }
    airi_manifest = manifest or default_manifest
    airi_card = card or {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": "AIRI Mika",
            "description": "A calm local companion.",
            "first_mes": "Hello, {{user}}.",
            "mes_example": "AIRI_SCHEMA_OUTSIDE_FIELD_MUST_NOT_LEAK",
            "system_prompt": "AIRI_SYSTEM_OVERRIDE_MUST_NOT_LEAK",
            "post_history_instructions": "AIRI_POST_HISTORY_MUST_NOT_LEAK",
            "extensions": {"remote": "https://untrusted.example/card-extension.json"},
        },
    }
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(airi_manifest))
        archive.writestr("card.json", json.dumps(airi_card))
        if include_display_model:
            default_display_model = (
                _make_vrm1()
                if display_format == "vrm"
                else _make_live2d_zip()
                if display_format == "live2d-zip"
                else _make_spine_zip()
            )
            archive.writestr(
                display_path,
                display_model_bytes or default_display_model,
            )
        for path, content in (extra_files or {}).items():
            archive.writestr(path, content)
    return payload.getvalue()


def test_import_vrm_persists_meta_and_export_round_trips(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)

    imported = service.import_character_upload(filename="hikari.vrm", data=_make_vrm1())

    assert imported.name == "Hikari"
    assert imported.asset_manifest["model_path"] == "model.vrm"
    assert imported.asset_manifest["license_path"] == "licenses/vrm-meta.json"
    assert imported.asset_manifest["redistribution_allowed"] == "yes"
    assert imported.asset_manifest["attribution_required"] == "yes"
    assert imported.asset_manifest["vrm_meta"]["name"] == "Hikari"
    assert imported.asset_manifest["vrm_meta"]["spec_version"] == "1.0"

    first_export = service.export_character_pack(imported.id)
    imported_again = service.import_character_upload(filename="character-pack.zip", data=first_export)
    second_export = service.export_character_pack(imported_again.id)

    with ZipFile(BytesIO(first_export)) as first_bundle, ZipFile(BytesIO(second_export)) as second_bundle:
        assert json.loads(first_bundle.read("recipe.json")) == json.loads(second_bundle.read("recipe.json"))
        assert json.loads(first_bundle.read("asset_manifest.json")) == json.loads(second_bundle.read("asset_manifest.json"))
        assert first_bundle.read("assets/model.vrm") == second_bundle.read("assets/model.vrm")
        assert first_bundle.read("assets/licenses/vrm-meta.json") == second_bundle.read("assets/licenses/vrm-meta.json")

    duplicate = service.duplicate_character(imported.id)
    duplicate_export = service.export_character_pack(duplicate.id)
    with ZipFile(BytesIO(duplicate_export)) as duplicate_bundle:
        assert duplicate_bundle.read("assets/model.vrm") == _make_vrm1()


def test_import_vrm_ignores_valid_trailing_unknown_glb_chunk(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    vrm_bytes = _append_glb_chunk(_make_vrm1(), b"TEST", b"future extension")

    imported = service.import_character_upload(filename="future.vrm", data=vrm_bytes)

    assert imported.name == "Hikari"


def test_replace_and_remove_avatar_preserve_character_identity_and_clear_imported_motions(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt", "motions/wave.vrma"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }
    recipe = CharacterRecipe(
        personality="steady",
        voice_id="voice-kept",
        relationship_role="friend",
        motions={
            "idle": "breathe",
            "greeting": "motions/wave.vrma",
        },
    )
    imported = service.import_character_upload(
        filename="animated.zip",
        data=_build_pack(
            vrm_bytes=_make_vrm0(title="Original"),
            manifest=manifest,
            recipe=recipe.model_dump(mode="json"),
            extra_files={
                "assets/LICENSE.txt": b"CC0",
                "assets/motions/wave.vrma": _make_vrma(),
            },
        ),
    )
    recipe_with_builtin = imported.recipe.model_copy(
        update={
            "motions": {
                **imported.recipe.motions,
                "focus": "/assets/characters/motions/companion-idle.vrma",
                "remote": "https://untrusted.example/wave.vrma",
                "lookalike": "/assets/characters/motions/evil.vrma",
                "query": "motions/wave.vrma?rev=2",
                "fragment": "https://untrusted.example/wave.vrma#take-2",
            }
        }
    )
    imported = service.update_character(imported.id, recipe=recipe_with_builtin)
    original_created_at = imported.created_at
    now = datetime.now(timezone.utc)
    space = repository.upsert_space(
        StudySpace(
            id="avatar-lifecycle-space",
            name="Avatar lifecycle",
            default_character_pack_id=imported.id,
            created_at=now,
            updated_at=now,
        )
    )

    replaced = service.replace_character_avatar(
        imported.id,
        filename="replacement.vrm",
        data=_make_vrm1(name="Replacement"),
    )

    assert replaced.id == imported.id
    assert replaced.name == imported.name
    assert replaced.description == imported.description
    assert replaced.created_at == original_created_at
    assert replaced.recipe.personality == "steady"
    assert replaced.recipe.voice_id == "voice-kept"
    assert replaced.recipe.relationship_role == "friend"
    assert replaced.recipe.motions == {
        "idle": "breathe",
        "focus": "/assets/characters/motions/companion-idle.vrma",
    }
    assert replaced.asset_manifest["source_filename"] == "replacement.vrm"
    assert service.resolve_character_asset(replaced.id, "model.vrm")[0].read_bytes() == _make_vrm1(
        name="Replacement"
    )
    with pytest.raises(ValueError, match="not found"):
        service.resolve_character_asset(replaced.id, "motions/wave.vrma")
    with ZipFile(BytesIO(service.export_character_pack(replaced.id))) as archive:
        assert set(archive.namelist()) == {
            "character.json",
            "recipe.json",
            "asset_manifest.json",
            "assets/model.vrm",
            "assets/licenses/vrm-meta.json",
        }
        assert archive.read("assets/model.vrm") == _make_vrm1(name="Replacement")
    assert repository.get_space(space.id).default_character_pack_id == imported.id

    removed = service.remove_character_avatar(replaced.id)

    assert removed.id == replaced.id
    assert removed.name == replaced.name
    assert removed.recipe == replaced.recipe
    assert removed.asset_manifest == {
        "pack_kind": "recipe-only",
        "render_mode": "vrm-or-2d-fallback",
    }
    with pytest.raises(ValueError, match="not found"):
        service.resolve_character_asset(removed.id, "model.vrm")
    assert repository.get_space(space.id).default_character_pack_id == imported.id
    with ZipFile(BytesIO(service.export_character_pack(removed.id))) as archive:
        assert archive.namelist() == [
            "character.json",
            "recipe.json",
            "asset_manifest.json",
        ]


@pytest.mark.parametrize("operation", ["replace", "remove"])
def test_avatar_lifecycle_rolls_back_assets_when_repository_update_fails(
    isolated_settings,
    monkeypatch,
    operation: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    imported = service.import_character_upload(
        filename="original.vrm",
        data=_make_vrm0(title="Original"),
    )
    original_manifest = imported.asset_manifest
    original_recipe = imported.recipe
    original_identity = (
        imported.name,
        imported.description,
        imported.created_at,
        imported.updated_at,
    )
    asset_root = settings.characters_root / imported.id
    original_files = {
        path.relative_to(asset_root).as_posix(): path.read_bytes()
        for path in asset_root.rglob("*")
        if path.is_file()
    }

    def fail_upsert(_character):
        raise RuntimeError("simulated repository failure")

    monkeypatch.setattr(repository, "upsert_character", fail_upsert)

    with pytest.raises(RuntimeError, match="repository failure"):
        if operation == "replace":
            service.replace_character_avatar(
                imported.id,
                filename="replacement.vrm",
                data=_make_vrm1(name="Replacement"),
            )
        else:
            service.remove_character_avatar(imported.id)

    persisted = repository.get_character(imported.id)
    assert persisted is not None
    assert persisted.asset_manifest == original_manifest
    assert persisted.recipe == original_recipe
    assert (
        persisted.name,
        persisted.description,
        persisted.created_at,
        persisted.updated_at,
    ) == original_identity
    restored_files = {
        path.relative_to(asset_root).as_posix(): path.read_bytes()
        for path in asset_root.rglob("*")
        if path.is_file()
    }
    assert restored_files == original_files
    assert not list(settings.characters_root.glob(f".*-{imported.id}-*"))
    assert not list(settings.characters_root.glob(".n-*"))


def test_replace_avatar_does_not_delete_original_assets_when_staging_old_root_fails(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    imported = service.import_character_upload(
        filename="original.vrm",
        data=_make_vrm0(title="Original"),
    )
    asset_root = settings.characters_root / imported.id
    original_bytes = (asset_root / "model.vrm").read_bytes()
    original_rename = Path.rename

    def fail_old_root_rename(source: Path, target: Path):
        if source == asset_root:
            raise PermissionError("simulated locked model")
        return original_rename(source, target)

    monkeypatch.setattr(Path, "rename", fail_old_root_rename)

    with pytest.raises(PermissionError, match="locked model"):
        service.replace_character_avatar(
            imported.id,
            filename="replacement.vrm",
            data=_make_vrm1(name="Replacement"),
        )

    assert (asset_root / "model.vrm").read_bytes() == original_bytes
    assert repository.get_character(imported.id) == imported
    assert not list(settings.characters_root.glob(f".*-{imported.id}-*"))
    assert not list(settings.characters_root.glob(".n-*"))


def test_replace_avatar_reports_success_after_committed_old_asset_cleanup_failure(
    isolated_settings,
    monkeypatch,
    caplog,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    imported = service.import_character_upload(
        filename="original.vrm",
        data=_make_vrm0(title="Original"),
    )
    original_rmtree = shutil.rmtree

    def leave_recoverable_old_assets(path: Path, *args, **kwargs):
        if Path(path).name.startswith(f".replaced-{imported.id}-"):
            raise PermissionError("simulated cleanup lock")
        return original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", leave_recoverable_old_assets)

    replaced = service.replace_character_avatar(
        imported.id,
        filename="replacement.vrm",
        data=_make_vrm1(name="Replacement"),
    )

    assert replaced.asset_manifest["source_filename"] == "replacement.vrm"
    assert repository.get_character(imported.id) == replaced
    assert service.resolve_character_asset(imported.id, "model.vrm")[0].read_bytes() == _make_vrm1(
        name="Replacement"
    )
    assert len(list(settings.characters_root.glob(f".replaced-{imported.id}-*"))) == 1
    assert "left recoverable old assets" in caplog.text


def test_avatar_lifecycle_operations_are_serialized_and_leave_consistent_storage(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    imported = service.import_character_upload(
        filename="original.vrm",
        data=_make_vrm0(title="Original"),
    )
    first_entered = Event()
    release_first = Event()
    second_started = Event()
    second_entered = Event()
    original_replace_layer = service._replace_asset_layer
    entries = 0

    def observe_replace_layer(*args, **kwargs):
        nonlocal entries
        entries += 1
        if entries == 1:
            first_entered.set()
            assert release_first.wait(timeout=2)
        else:
            second_entered.set()
        return original_replace_layer(*args, **kwargs)

    def remove_after_first_starts():
        second_started.set()
        return service.remove_character_avatar(imported.id)

    monkeypatch.setattr(service, "_replace_asset_layer", observe_replace_layer)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            service.replace_character_avatar,
            imported.id,
            filename="replacement.vrm",
            data=_make_vrm1(name="Replacement"),
        )
        assert first_entered.wait(timeout=2)
        second = executor.submit(remove_after_first_starts)
        assert second_started.wait(timeout=2)
        assert not second_entered.wait(timeout=0.1)
        release_first.set()
        first.result(timeout=2)
        removed = second.result(timeout=2)

    assert entries == 2
    assert removed.asset_manifest == {
        "pack_kind": "recipe-only",
        "render_mode": "vrm-or-2d-fallback",
    }
    assert repository.get_character(imported.id) == removed
    assert not (settings.characters_root / imported.id).exists()
    assert not list(settings.characters_root.glob(f".*-{imported.id}-*"))


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_replace_avatar_serializes_with_character_metadata_and_delete_operations(
    isolated_settings,
    monkeypatch,
    operation: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    imported = service.import_character_upload(
        filename="original.vrm",
        data=_make_vrm0(title="Original"),
    )
    replace_entered = Event()
    release_replace = Event()
    competing_started = Event()
    competing_done = Event()
    original_replace_layer = service._replace_asset_layer

    def block_replace_layer(*args, **kwargs):
        replace_entered.set()
        assert release_replace.wait(timeout=2)
        return original_replace_layer(*args, **kwargs)

    def run_competing_operation():
        competing_started.set()
        try:
            if operation == "update":
                return service.update_character(imported.id, name="Concurrent update")
            return service.delete_character(imported.id)
        finally:
            competing_done.set()

    monkeypatch.setattr(service, "_replace_asset_layer", block_replace_layer)

    with ThreadPoolExecutor(max_workers=2) as executor:
        replacement = executor.submit(
            service.replace_character_avatar,
            imported.id,
            filename="replacement.vrm",
            data=_make_vrm1(name="Replacement"),
        )
        assert replace_entered.wait(timeout=2)
        competing = executor.submit(run_competing_operation)
        assert competing_started.wait(timeout=2)
        assert not competing_done.wait(timeout=0.1)
        release_replace.set()
        replaced = replacement.result(timeout=2)
        competing_result = competing.result(timeout=2)

    if operation == "update":
        assert competing_result.name == "Concurrent update"
        persisted = repository.get_character(imported.id)
        assert persisted == competing_result
        assert persisted.asset_manifest == replaced.asset_manifest
        assert service.read_character_asset(imported.id, "model.vrm")[0] == _make_vrm1(
            name="Replacement"
        )
    else:
        assert competing_result is True
        assert repository.get_character(imported.id) is None
        assert not (settings.characters_root / imported.id).exists()
    assert not list(settings.characters_root.glob(f".*-{imported.id}-*"))


def test_vrma_motion_asset_round_trips(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt", "motions/wave.vrma"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }
    recipe = CharacterRecipe().model_dump(mode="json")
    recipe["motions"] = {
        "idle": "breathe",
        "focus": "lean-in",
        "greeting": "motions/wave.vrma",
    }
    pack = _build_pack(
        vrm_bytes=_make_vrm1(),
        manifest=manifest,
        recipe=recipe,
        extra_files={
            "assets/LICENSE.txt": b"CC0",
            "assets/motions/wave.vrma": _make_vrma(),
        },
    )

    imported = service.import_character_upload(filename="animated.zip", data=pack)
    exported = service.export_character_pack(imported.id)
    imported_again = service.import_character_upload(filename="animated-again.zip", data=exported)

    assert imported_again.recipe.motions == recipe["motions"]
    with ZipFile(BytesIO(exported)) as archive:
        assert archive.read("assets/motions/wave.vrma") == _make_vrma()


@pytest.mark.parametrize("state", ["idle", "listening", "thinking", "speaking"])
def test_managed_motion_upload_is_trusted_local_only_and_deletes_idempotently(
    isolated_settings,
    state: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.create_character(
        name="Managed motion",
        recipe=CharacterRecipe(motions={state: f"procedural-{state}"}),
    )
    original_recipe = character.recipe

    uploaded = service.put_managed_motion(
        character.id,
        state,
        filename=f"Owner {state}.VRMA",
        data=_make_vrma(),
    )

    motion = uploaded.asset_manifest["managed_motions"][state]
    assert uploaded.recipe == original_recipe
    assert motion == {
        "path": motion["path"],
        "source_filename": f"Owner {state}.VRMA",
        "sha256": motion["sha256"],
        "provenance": "owner_upload",
        "redistribution_allowed": "no",
    }
    assert motion["path"] in uploaded.asset_manifest["asset_paths"]
    assert service.read_character_asset(character.id, motion["path"]) == (
        _make_vrma(),
        "model/gltf-binary",
    )
    restarted = CharacterService(SQLiteRepository(settings))
    assert restarted.read_character_asset(character.id, motion["path"])[0] == _make_vrma()
    with pytest.raises(ValueError, match=state):
        restarted.export_character_pack(character.id)

    deleted = restarted.delete_managed_motion(character.id, state)
    deleted_at = deleted.updated_at
    assert deleted.recipe == original_recipe
    assert "managed_motions" not in deleted.asset_manifest
    assert restarted.export_character_pack(character.id).startswith(b"PK")
    assert restarted.delete_managed_motion(character.id, state).updated_at == deleted_at


def test_managed_motions_survive_avatar_lifecycle_and_duplicate(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    character = service.import_character_upload(filename="base.vrm", data=_make_vrm1())
    uploaded = service.put_managed_motion(
        character.id,
        "speaking",
        filename="talk.vrma",
        data=_make_vrma(),
    )
    path = uploaded.asset_manifest["managed_motions"]["speaking"]["path"]

    replaced = service.replace_character_avatar(
        character.id,
        filename="replacement.vrm",
        data=_make_vrm0(title="Replacement"),
    )
    assert service.read_character_asset(replaced.id, path)[0] == _make_vrma()
    duplicate = service.duplicate_character(replaced.id)
    assert service.read_character_asset(duplicate.id, path)[0] == _make_vrma()

    removed = service.remove_character_avatar(replaced.id)
    assert removed.asset_manifest["pack_kind"] == "managed-motion-only"
    assert service.read_character_asset(removed.id, path)[0] == _make_vrma()
    with pytest.raises(ValueError, match="speaking"):
        service.export_character_pack(removed.id)


def test_native_pack_cannot_forge_managed_motion_provenance(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = _build_pack(
        vrm_bytes=_make_vrm0(),
        manifest={
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
            "asset_paths": ["model.vrm", "LICENSE.txt"],
            "redistribution_allowed": "yes",
            "license": "CC0",
            "managed_motions": {},
        },
        extra_files={"assets/LICENSE.txt": b"CC0"},
    )

    with pytest.raises(ValueError, match="reserved key managed_motions"):
        service.import_character_upload(filename="forged.zip", data=payload)

    reserved_asset_payload = _build_pack(
        vrm_bytes=_make_vrm0(),
        manifest={
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
            "asset_paths": ["model.vrm", "LICENSE.txt"],
            "redistribution_allowed": "yes",
            "license": "CC0",
        },
        extra_files={
            "assets/LICENSE.txt": b"CC0",
            "assets/managed-motions/idle-forged.vrma": _make_vrma(),
        },
    )
    with pytest.raises(ValueError, match="reserved managed-motions"):
        service.import_character_upload(filename="forged-assets.zip", data=reserved_asset_payload)


def test_managed_motion_upload_rolls_back_repository_failure_without_staging_residue(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.import_character_upload(filename="rollback.vrm", data=_make_vrm1())
    original_files = _asset_tree_bytes(service, character.id)
    original_upsert = repository.upsert_character

    def fail_update(candidate):
        if candidate.id == character.id and candidate.updated_at != character.updated_at:
            raise RuntimeError("repository unavailable")
        return original_upsert(candidate)

    monkeypatch.setattr(repository, "upsert_character", fail_update)
    with pytest.raises(RuntimeError, match="repository unavailable"):
        service.put_managed_motion(
            character.id,
            "idle",
            filename="idle.vrma",
            data=_make_vrma(),
        )

    persisted = repository.get_character(character.id)
    assert persisted == character
    assert _asset_tree_bytes(service, character.id) == original_files
    assert not list(settings.characters_root.glob(f".*-{character.id}-*"))


def test_managed_motion_delete_rolls_back_repository_failure_without_staging_residue(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.import_character_upload(filename="rollback.vrm", data=_make_vrm1())
    uploaded = service.put_managed_motion(
        character.id,
        "idle",
        filename="idle.vrma",
        data=_make_vrma(),
    )
    original_files = _asset_tree_bytes(service, character.id)
    original_upsert = repository.upsert_character

    def fail_update(candidate):
        if candidate.id == uploaded.id and candidate.updated_at != uploaded.updated_at:
            raise RuntimeError("repository unavailable")
        return original_upsert(candidate)

    monkeypatch.setattr(repository, "upsert_character", fail_update)
    with pytest.raises(RuntimeError, match="repository unavailable"):
        service.delete_managed_motion(uploaded.id, "idle")

    monkeypatch.setattr(repository, "upsert_character", original_upsert)
    assert repository.get_character(uploaded.id) == uploaded
    assert _asset_tree_bytes(service, uploaded.id) == original_files
    assert not list(settings.characters_root.glob(f".*-{uploaded.id}-*"))


def test_managed_motion_projected_size_and_same_slot_replacement_are_atomic(
    isolated_settings,
) -> None:
    motion = _make_vrma()
    settings = _local_settings(isolated_settings).model_copy(
        update={"max_character_pack_size_bytes": len(motion) * 2 - 1}
    )
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.create_character(name="Motion capacity")

    first = service.put_managed_motion(
        character.id,
        "idle",
        filename="first.vrma",
        data=motion,
    )
    first_files = _asset_tree_bytes(service, character.id)
    with pytest.raises(ValueError, match="configured size limit"):
        service.put_managed_motion(
            character.id,
            "listening",
            filename="listening.vrma",
            data=motion,
        )
    assert repository.get_character(character.id) == first
    assert _asset_tree_bytes(service, character.id) == first_files
    assert not list(settings.characters_root.glob(f".*-{character.id}-*"))

    service.repository.settings.max_character_pack_size_bytes = 200 * 1024 * 1024
    first_path = first.asset_manifest["managed_motions"]["idle"]["path"]
    second_motion = _rewrite_vrma(lambda document: document.update({"extras": {"take": 2}}))
    second = service.put_managed_motion(
        character.id,
        "idle",
        filename="second.vrma",
        data=second_motion,
    )
    second_path = second.asset_manifest["managed_motions"]["idle"]["path"]
    assert second_path != first_path
    assert first_path not in second.asset_manifest["asset_paths"]
    assert not service._contained_child(service._asset_root(character.id), first_path).exists()
    assert service.read_character_asset(character.id, second_path)[0] == second_motion


@pytest.mark.parametrize("path_variant", ["exact", "casefold"])
def test_managed_motion_upload_rejects_legacy_portable_path_collision(
    isolated_settings,
    path_variant: str,
) -> None:
    repository = SQLiteRepository(_local_settings(isolated_settings))
    service = CharacterService(repository)
    character = service.create_character(name="Legacy collision")
    motion = _make_vrma()
    digest = hashlib.sha256(motion).hexdigest()
    target = f"managed-motions/idle-{digest}.vrma"
    legacy_path = target if path_variant == "exact" else target.upper()
    seeded = character.model_copy(
        update={
            "asset_manifest": {
                "render_mode": "vrm-or-2d-fallback",
                "asset_paths": [legacy_path],
            }
        },
        deep=True,
    )
    service._write_asset_files(character.id, {legacy_path: motion})
    repository.upsert_character(seeded)
    original_files = _asset_tree_bytes(service, character.id)

    with pytest.raises(ValueError, match="collides"):
        service.put_managed_motion(
            character.id,
            "idle",
            filename="idle.vrma",
            data=motion,
        )

    assert repository.get_character(character.id) == seeded
    assert _asset_tree_bytes(service, character.id) == original_files
    assert not list(repository.settings.characters_root.glob(f".*-{character.id}-*"))


def test_managed_motion_puts_for_two_states_serialize_deterministically(
    isolated_settings,
    monkeypatch,
) -> None:
    long_storage_root = (
        isolated_settings.storage_root.parent
        / ("long-storage-" + "x" * 8)
        / "storage"
    )
    settings = _local_settings(isolated_settings).model_copy(
        update={"object_storage_path": str(long_storage_root)}
    )
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.create_character(name="Concurrent motions")
    first_entered = Event()
    release_first = Event()
    second_started = Event()
    second_entered = Event()
    original_replace = service._replace_asset_layer
    call_count = 0

    def block_first_replace(existing, updated, asset_files):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            first_entered.set()
            assert release_first.wait(timeout=5)
        else:
            second_entered.set()
        return original_replace(existing, updated, asset_files)

    monkeypatch.setattr(service, "_replace_asset_layer", block_first_replace)

    def put_listening():
        second_started.set()
        return service.put_managed_motion(
            character.id,
            "listening",
            filename="listening.vrma",
            data=_make_vrma(),
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        idle_future = executor.submit(
            service.put_managed_motion,
            character.id,
            "idle",
            filename="idle.vrma",
            data=_make_vrma(),
        )
        assert first_entered.wait(timeout=5)
        listening_future = executor.submit(put_listening)
        assert second_started.wait(timeout=5)
        assert not second_entered.wait(timeout=0.2)
        release_first.set()
        idle_future.result(timeout=5)
        listening_future.result(timeout=5)

    persisted = repository.get_character(character.id)
    assert persisted is not None
    managed = persisted.asset_manifest["managed_motions"]
    assert set(managed) == {"idle", "listening"}
    expected_paths = {
        managed["idle"]["path"],
        managed["listening"]["path"],
    }
    assert set(persisted.asset_manifest["asset_paths"]) == expected_paths
    for path in expected_paths:
        assert service.read_character_asset(character.id, path)[0] == _make_vrma()
    assert not list(repository.settings.characters_root.glob(f".*-{character.id}-*"))


def test_replace_avatar_projected_size_includes_existing_managed_overlay(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.import_character_upload(filename="original.vrm", data=_make_vrm1())
    overlay = _make_vrma()
    uploaded = service.put_managed_motion(
        character.id,
        "idle",
        filename="idle.vrma",
        data=overlay,
    )
    replacement = _make_vrm0(title="Replacement")
    replacement_files, _manifest = service._build_vrm_asset_bundle(
        filename="replacement.vrm",
        data=replacement,
    )
    settings.max_character_pack_size_bytes = sum(map(len, replacement_files.values())) + len(overlay) - 1
    original_files = _asset_tree_bytes(service, character.id)

    with pytest.raises(ValueError, match="configured size limit"):
        service.replace_character_avatar(
            character.id,
            filename="replacement.vrm",
            data=replacement,
        )

    assert repository.get_character(character.id) == uploaded
    assert _asset_tree_bytes(service, character.id) == original_files
    assert not list(settings.characters_root.glob(f".*-{character.id}-*"))


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("  idle.vrma  ", "idle.vrma"),
        ("idle\x01.vrma", "idle.vrma"),
    ],
)
def test_managed_motion_source_filename_is_cleaned(
    isolated_settings,
    filename: str,
    expected: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    character = service.create_character(name="Clean filename")

    uploaded = service.put_managed_motion(
        character.id,
        "idle",
        filename=filename,
        data=_make_vrma(),
    )

    assert uploaded.asset_manifest["managed_motions"]["idle"]["source_filename"] == expected


@pytest.mark.parametrize(
    "filename",
    ["../idle.vrma", "..\\idle.vrma", "secret=owner-value.vrma", f"{'x' * 251}.vrma"],
)
def test_managed_motion_source_filename_rejection_is_non_mutating(
    isolated_settings,
    filename: str,
) -> None:
    repository = SQLiteRepository(_local_settings(isolated_settings))
    service = CharacterService(repository)
    character = service.create_character(name="Reject filename")

    with pytest.raises(ValueError):
        service.put_managed_motion(
            character.id,
            "idle",
            filename=filename,
            data=_make_vrma(),
        )
    assert repository.get_character(character.id) == character
    assert _asset_tree_bytes(service, character.id) == {}


def test_managed_motion_sha_and_asset_paths_are_verified_before_read_or_lifecycle(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    character = service.create_character(name="Integrity")
    uploaded = service.put_managed_motion(
        character.id,
        "idle",
        filename="idle.vrma",
        data=_make_vrma(),
    )
    path = uploaded.asset_manifest["managed_motions"]["idle"]["path"]
    unlisted_manifest = json.loads(json.dumps(uploaded.asset_manifest))
    unlisted_manifest["asset_paths"].remove(path)
    with pytest.raises(ValueError, match="managed_motions.idle"):
        service._trusted_managed_motions(unlisted_manifest)

    service._contained_child(service._asset_root(character.id), path).write_bytes(b"tampered")

    with pytest.raises(ValueError, match="SHA256"):
        service.read_character_asset(character.id, path)
    with pytest.raises(ValueError, match="SHA256"):
        service.remove_character_avatar(character.id)


@pytest.mark.parametrize(
    ("motion_bytes", "error"),
    [
        (b"not-a-glb", "VRMA"),
        (_make_glb({"asset": {"version": "2.0"}}), "VRMC_vrm_animation"),
        (_make_vrma(target_path="translation"), "rotation"),
        (
            _rewrite_vrma(lambda document: document.pop("extensionsUsed")),
            "extensionsUsed",
        ),
        (
            _rewrite_vrma(
                lambda document: document["extensions"]["VRMC_vrm_animation"]["humanoid"][
                    "humanBones"
                ].pop("leftHand")
            ),
            "required bones",
        ),
        (
            _rewrite_vrma(
                lambda document: document["buffers"][0].update({"uri": "external.bin"})
            ),
            "embedded",
        ),
        (
            _rewrite_vrma(
                lambda document: document["animations"][0]["channels"][0].pop("sampler")
            ),
            "rotation",
        ),
        (
            _rewrite_vrma(
                lambda document: document["extensions"]["VRMC_vrm_animation"]["humanoid"][
                    "humanBones"
                ]["head"].update({"node": 0})
            ),
            "unique nodes",
        ),
        (
            _rewrite_vrma(
                lambda document: document["extensions"]["VRMC_vrm_animation"]["humanoid"][
                    "humanBones"
                ]["chest"].update(
                    {
                        "node": document["extensions"]["VRMC_vrm_animation"]["humanoid"][
                            "humanBones"
                        ]["head"]["node"]
                    }
                )
            ),
            "unique nodes",
        ),
        (_rewrite_vrma(lambda document: document.update({"meshes": []})), "rendering payload"),
        (
            _rewrite_vrma(
                lambda document: document["extensions"]["VRMC_vrm_animation"].update(
                    {"expressions": {}}
                )
            ),
            "body-only",
        ),
        (
            _rewrite_vrma(lambda document: document["buffers"][0].update({"byteLength": 416})),
            "padding",
        ),
        (
            _rewrite_vrma(lambda document: document["buffers"][0].update({"byteLength": 421})),
            "padding",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][0].update({"byteOffset": -1})),
            "accessor bounds",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][0].update({"count": 0})),
            "accessor bounds",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][1].update({"type": "VEC3"})),
            "animation accessor",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][0].update({"sparse": {}})),
            "animation accessor",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][1].update({"sparse": {}})),
            "animation accessor",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][0].update({"count": 100_001})),
            "keyframe limit",
        ),
        (
            _rewrite_vrma(lambda document: document["bufferViews"][0].update({"byteStride": 2})),
            "accessor stride",
        ),
        (
            _rewrite_vrma(lambda document: document["accessors"][0].update({"byteOffset": 4})),
            "accessor span",
        ),
        (
            _rewrite_vrma(
                lambda document: document["animations"][0]["channels"][1].update(
                    {"target": dict(document["animations"][0]["channels"][0]["target"])}
                )
            ),
            "duplicate channel target",
        ),
        (
            _rewrite_vrma(
                lambda document: document["animations"][0]["samplers"][0].update(
                    {"interpolation": "CUBICSPLINE"}
                )
            ),
            "CUBICSPLINE",
        ),
        (_rewrite_vrma_binary(byte_offset=0, values=(float("nan"),)), "input times must be finite"),
        (_rewrite_vrma_binary(byte_offset=4, values=(0.0,)), "strictly increasing"),
        (_rewrite_vrma_binary(byte_offset=20, values=(float("nan"),)), "finite quaternion"),
        (_rewrite_vrma_binary(byte_offset=20, values=(0.0, 0.0, 0.0, 0.0)), "non-zero quaternion"),
        (_rewrite_vrma_binary(byte_offset=20, values=(0.0, 0.0, 0.0, 2.0)), "unit quaternion"),
        (_rewrite_vrma_chunks(order=("bin", "json")), "VRMA signature"),
        (_rewrite_vrma_chunks(order=("json", "json", "bin")), "VRMA signature"),
        (_rewrite_vrma_chunks(order=("json", "unknown", "bin")), "VRMA signature"),
        (_rewrite_vrma_chunks(order=("json", "bin", "bin")), "VRMA signature"),
        (_rewrite_vrma_chunks(order=("json",)), "exactly one BIN"),
    ],
)
def test_import_rejects_invalid_vrma_assets(isolated_settings, motion_bytes: bytes, error: str) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt", "motions/wave.vrma"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }
    pack = _build_pack(
        vrm_bytes=_make_vrm1(),
        manifest=manifest,
        extra_files={"assets/LICENSE.txt": b"CC0", "assets/motions/wave.vrma": motion_bytes},
    )

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(filename="animated.zip", data=pack)


@pytest.mark.parametrize(
    ("motion_path", "asset_paths", "include_motion", "error"),
    [
        ("motions/wave.vrma", ["model.vrm", "LICENSE.txt"], True, "asset_paths"),
        ("motions/wave.vrma", ["model.vrm", "LICENSE.txt", "motions/wave.vrma"], False, "missing"),
        ("../wave.vrma", ["model.vrm", "LICENSE.txt"], False, "unsafe"),
    ],
)
def test_import_rejects_invalid_vrma_motion_references(
    isolated_settings,
    motion_path: str,
    asset_paths: list[str],
    include_motion: bool,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    recipe = CharacterRecipe().model_dump(mode="json")
    recipe["motions"] = {"idle": "breathe", "greeting": motion_path, "focus": "lean-in"}
    extra_files = {"assets/LICENSE.txt": b"CC0"}
    if include_motion:
        extra_files["assets/motions/wave.vrma"] = _make_vrma()
    pack = _build_pack(
        vrm_bytes=_make_vrm1(),
        manifest={
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
            "asset_paths": asset_paths,
            "redistribution_allowed": "yes",
            "license": "CC0",
        },
        recipe=recipe,
        extra_files=extra_files,
    )

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(filename="animated.zip", data=pack)


def test_recipe_only_character_pack_round_trips_without_asset_license(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    original = service.create_character(
        name="Recipe Companion",
        description="Uses a bundled browser model.",
        recipe=CharacterRecipe(
            avatar_model="seed_san",
            avatar_framing="portrait",
            stage_background="midnight",
            base_model="tall",
            hairstyle="wolf_cut",
        ),
    )

    exported = service.export_character_pack(original.id)
    imported = service.import_character_upload(
        filename="recipe-companion.zip",
        data=exported,
    )

    assert imported.name == original.name
    assert imported.description == original.description
    assert imported.recipe == original.recipe
    assert imported.recipe.avatar_framing == "portrait"
    assert imported.recipe.stage_background == "midnight"
    assert imported.asset_manifest["pack_kind"] == "recipe-only"
    assert imported.asset_manifest["asset_paths"] == []


def test_import_legacy_pack_without_stage_background_uses_neutral(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    legacy_recipe = CharacterRecipe().model_dump(mode="json")
    legacy_recipe.pop("stage_background")
    pack = _build_pack(
        vrm_bytes=_make_vrm1(),
        manifest={
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
            "asset_paths": ["model.vrm", "LICENSE.txt"],
            "redistribution_allowed": "yes",
            "license": "CC0",
        },
        recipe=legacy_recipe,
        extra_files={"assets/LICENSE.txt": b"CC0"},
    )

    imported = service.import_character_upload(filename="legacy-stage.zip", data=pack)

    assert imported.recipe.stage_background == "neutral"


def test_import_character_card_v2_maps_only_bounded_persona_text_and_round_trips(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    service = CharacterService(SQLiteRepository(settings))
    card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "  星野\u0000光  ",
            "description": "A kind\r\ncompanion for {{user}}.",
            "personality": "Curious and calm.",
            "scenario": "<char> meets <user> in a library.",
            "first_mes": "Hello from <bot>.",
            "mes_example": "{{char}}: Welcome!",
            "alternate_greetings": ["Hi, {{user}}!", "Welcome back, <user>."],
            "system_prompt": "SYSTEM_OVERRIDE_MUST_NOT_LEAK",
            "post_history_instructions": "POST_HISTORY_MUST_NOT_LEAK",
            "extensions": {
                "assets": ["https://untrusted.example/model.vrm"],
            },
        },
    }

    imported = service.import_character_upload(
        filename="persona.json",
        data=json.dumps(card, ensure_ascii=False).encode("utf-8"),
    )

    assert imported.name == "星野光"
    assert imported.recipe == CharacterRecipe()
    assert imported.description.startswith("Imported untrusted persona text")
    assert "A kind\ncompanion for the user." in imported.description
    assert "星野光 meets the user" in imported.description
    assert "Hello from 星野光." in imported.description
    assert "SYSTEM_OVERRIDE" not in imported.description
    assert "POST_HISTORY" not in imported.description
    assert "untrusted.example" not in imported.description
    assert imported.asset_manifest == {
        "pack_kind": "recipe-only",
        "render_mode": "vrm-or-2d-fallback",
        "source_format": "character-card",
        "source_spec": "chara_card_v2",
        "source_spec_version": "2.0",
        "prompt_overrides_ignored": True,
    }

    exported = service.export_character_pack(imported.id)
    with ZipFile(BytesIO(exported)) as archive:
        metadata = b"".join(
            archive.read(name)
            for name in ("character.json", "recipe.json", "asset_manifest.json")
        )
        assert b"SYSTEM_OVERRIDE_MUST_NOT_LEAK" not in metadata
        assert b"POST_HISTORY_MUST_NOT_LEAK" not in metadata
        assert b"untrusted.example" not in metadata
    round_tripped = service.import_character_upload(filename="persona.zip", data=exported)
    assert round_tripped.description == imported.description
    assert round_tripped.recipe == CharacterRecipe()
    assert round_tripped.asset_manifest["asset_paths"] == []


def test_import_character_card_v3_accepts_compatible_future_versions(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))

    imported = service.import_character_upload(
        filename="future-persona.json",
        data=json.dumps(
            {
                "spec": "chara_card_v3",
                "spec_version": "3.1",
                "data": {"name": "Future Mika", "description": "Compatible persona."},
            }
        ).encode(),
    )

    assert imported.name == "Future Mika"
    assert imported.asset_manifest["source_spec_version"] == "3.1"


@pytest.mark.parametrize(
    ("display_format", "entrypoint"),
    [("live2d-zip", "avatar.model3.json"), ("spine-zip", "avatar.json")],
)
def test_import_airi_character_card_zip_imports_archive_display_model_without_activation(
    isolated_settings,
    monkeypatch,
    display_format: str,
    entrypoint: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    active_character = service.create_character(name="Existing active companion")
    now = datetime.now(timezone.utc)
    space = repository.upsert_space(
        StudySpace(
            id=f"airi-import-space-{display_format}",
            name="AIRI import activation boundary",
            default_character_pack_id=active_character.id,
            created_at=now,
            updated_at=now,
        )
    )
    model_bytes = _make_live2d_zip() if display_format == "live2d-zip" else _make_spine_zip()
    package = _build_airi_pack(display_format=display_format, display_model_bytes=model_bytes)
    original_read = ZipFile.read
    read_members: list[str] = []

    def read_declared_archives_only(archive, member, *args, **kwargs):
        name = member.filename if isinstance(member, ZipInfo) else str(member)
        read_members.append(name)
        assert name in {
            "manifest.json",
            "card.json",
            "models/body-model.zip",
            "avatar.model3.json",
            "avatar.moc3",
            "textures/avatar.png",
            "avatar.json",
            "avatar.atlas",
            "avatar.png",
        }
        return original_read(archive, member, *args, **kwargs)

    monkeypatch.setattr(ZipFile, "read", read_declared_archives_only)

    imported = service.import_character_upload(
        filename="airi-character.zip",
        data=package,
    )

    assert imported.name == "AIRI Mika"
    assert "Hello, the user." in imported.description
    assert imported.recipe == CharacterRecipe()
    assert imported.asset_manifest["format"] == display_format
    assert imported.asset_manifest["render_mode"] == display_format.removesuffix("-zip")
    assert imported.asset_manifest["validation_level"] == "structure-only"
    assert imported.asset_manifest["model_path"] == "display-model/model.zip"
    assert imported.asset_manifest["license_path"] == "licenses/airi-display-model.json"
    assert imported.asset_manifest["entrypoint"] == entrypoint
    assert imported.asset_manifest["redistribution_allowed"] == "no"
    assert imported.asset_manifest["usage_restrictions"] == {
        "local_only": True,
        "rights_verified": False,
    }
    assert imported.asset_manifest["source_display_model_format"] == display_format
    assert imported.asset_manifest["source_display_model_imported"] is True
    assert len(imported.asset_manifest["sha256"]) == 64
    assert read_members[:3] == ["manifest.json", "card.json", "models/body-model.zip"]
    serialized = json.dumps(imported.model_dump(mode="json"))
    assert "AIRI_SYSTEM_OVERRIDE_MUST_NOT_LEAK" not in serialized
    assert "AIRI_POST_HISTORY_MUST_NOT_LEAK" not in serialized
    assert "AIRI_SCHEMA_OUTSIDE_FIELD_MUST_NOT_LEAK" not in serialized
    assert "untrusted.example" not in serialized
    assert service.read_character_asset(imported.id, "display-model/model.zip")[0] == model_bytes
    with pytest.raises(ValueError, match="redistribution"):
        service.export_character_pack(imported.id)
    assert repository.get_space(space.id).default_character_pack_id == active_character.id
    assert imported.id != active_character.id


@pytest.mark.parametrize(
    ("display_format", "model_bytes", "error"),
    [
        (
            "live2d-zip",
            _make_live2d_zip(
                model={
                    "FileReferences": {
                        "Moc": "https://example.test/avatar.moc3",
                        "Textures": ["textures/avatar.png"],
                    }
                }
            ),
            "remote",
        ),
        (
            "live2d-zip",
            _make_live2d_zip(
                model={
                    "FileReferences": {
                        "Moc": "../avatar.moc3",
                        "Textures": ["textures/avatar.png"],
                    }
                }
            ),
            "unsafe",
        ),
        (
            "live2d-zip",
            _make_live2d_zip(
                model={
                    "FileReferences": {
                        "Moc": "missing.moc3",
                        "Textures": ["textures/avatar.png"],
                    }
                }
            ),
            "missing",
        ),
        *[
            (
                "live2d-zip",
                _make_live2d_zip(
                    model={
                        "FileReferences": {
                            "Moc": encoded,
                            "Textures": ["textures/avatar.png"],
                        }
                    }
                ),
                error,
            )
            for encoded, error in (
                ("%2f%2fexample.test/avatar.moc3", "remote"),
                ("https%3a%2f%2fexample.test/avatar.moc3", "remote"),
                ("%2e%2e%2favatar.moc3", "unsafe"),
            )
        ],
        (
            "spine-zip",
            _make_spine_zip(atlas="https://example.test/avatar.png\nsize: 1,1\n"),
            "local texture",
        ),
        (
            "spine-zip",
            _make_spine_zip(atlas="../avatar.png\nsize: 1,1\n"),
            "unsafe",
        ),
        (
            "spine-zip",
            _make_spine_zip(atlas="missing.png\nsize: 1,1\n"),
            "missing",
        ),
    ],
)
def test_import_airi_archive_display_model_rejects_unsafe_or_missing_references(
    isolated_settings,
    display_format: str,
    model_bytes: bytes,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(
            filename="unsafe-airi.zip",
            data=_build_airi_pack(display_format=display_format, display_model_bytes=model_bytes),
        )


def test_import_airi_live2d_structure_only_resolves_one_decoded_safe_parent_reference(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "models/avatar.model3.json",
            json.dumps(
                {
                    "FileReferences": {
                        "Moc": "%2e%2e%2fshared/avatar.moc3",
                        "Textures": ["%2e%2e%2fshared/avatar.png"],
                    }
                }
            ),
        )
        archive.writestr("shared/avatar.moc3", b"MOC3-structure-only")
        archive.writestr("shared/avatar.png", _PNG_1X1)

    imported = service.import_character_upload(
        filename="safe-parent-airi.zip",
        data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=payload.getvalue()),
    )

    assert imported.asset_manifest["entrypoint"] == "models/avatar.model3.json"
    assert imported.asset_manifest["validation_level"] == "structure-only"


def test_import_airi_live2d_structure_only_validates_file_references_and_ignores_macos_metadata(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    model = {
        "Version": 3,
        "FileReferences": {
            "Moc": "avatar.moc3",
            "Textures": ["textures/avatar.png"],
            "Physics": None,
            "Pose": None,
            "DisplayInfo": None,
            "Expressions": [
                "expressions/happy.exp3.json",
                {"Name": "calm", "File": "expressions/calm.exp3.json"},
            ],
        },
    }
    model_bytes = _make_live2d_zip(
        model=model,
        extra_files={
            "expressions/happy.exp3.json": b"{}",
            "expressions/calm.exp3.json": b"{}",
            "__MACOSX/junk.model3.json": b"not-json",
            "._junk.model.json": b"not-json",
        },
    )

    imported = service.import_character_upload(
        filename="exact-live2d-airi.zip",
        data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=model_bytes),
    )

    assert imported.asset_manifest["entrypoint"] == "avatar.model3.json"


@pytest.mark.parametrize(
    ("model", "error"),
    [
        ({"FileReferences": {"Textures": ["textures/avatar.png"]}}, "core MOC"),
        ({"FileReferences": {"Moc": "avatar.moc3"}}, "textures"),
        (
            {
                "FileReferences": {
                    "Moc": "avatar.moc3",
                    "Textures": ["textures/avatar.png"],
                    "Expressions": [{"Name": "missing-file"}],
                }
            },
            "expression",
        ),
    ],
)
def test_import_airi_live2d_rejects_missing_core_or_invalid_expression(
    isolated_settings,
    model: dict,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(
            filename="invalid-live2d-airi.zip",
            data=_build_airi_pack(
                display_format="live2d-zip",
                display_model_bytes=_make_live2d_zip(model=model),
            ),
        )


def test_import_airi_live2d_structure_only_accepts_legacy_model_json(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "avatar.model.json",
            json.dumps({"model": "avatar.moc3", "textures": ["avatar.png"]}),
        )
        archive.writestr("avatar.moc3", b"MOC3-structure-only")
        archive.writestr("avatar.png", _PNG_1X1)

    imported = service.import_character_upload(
        filename="legacy-live2d-airi.zip",
        data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=payload.getvalue()),
    )

    assert imported.asset_manifest["entrypoint"] == "avatar.model.json"


def test_import_airi_spine_rejects_cross_directory_skeleton_atlas_fallback(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "skeleton/avatar.json",
            json.dumps({"bones": [{"name": "root"}], "slots": [], "skins": [], "animations": {}}),
        )
        archive.writestr("atlas/avatar.atlas", "avatar.png\nsize: 1,1\n")
        archive.writestr("atlas/avatar.png", _PNG_1X1)

    with pytest.raises(ValueError, match="same-directory"):
        service.import_character_upload(
            filename="cross-directory-spine-airi.zip",
            data=_build_airi_pack(display_format="spine-zip", display_model_bytes=payload.getvalue()),
        )


@pytest.mark.parametrize("display_format", ["live2d-zip", "spine-zip"])
def test_native_pack_revalidates_airi_archive_display_model_integrity(
    isolated_settings,
    display_format: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    model_bytes = _make_live2d_zip() if display_format == "live2d-zip" else _make_spine_zip()
    _files, manifest = service._build_airi_archive_display_model_bundle(
        display_format=display_format,
        filename="model.zip",
        data=model_bytes,
    )
    manifest["entrypoint"] = "forged-entrypoint"
    pack = _build_pack(
        vrm_bytes=b"unused",
        manifest=manifest,
        extra_files={
            "assets/display-model/model.zip": model_bytes,
            "assets/licenses/airi-display-model.json": b"{}",
        },
    )

    with pytest.raises(ValueError, match="entrypoint"):
        service.import_character_upload(filename="forged-native.zip", data=pack)


def test_native_pack_cannot_upgrade_airi_archive_display_model_rights(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    model_bytes = _make_live2d_zip()
    files, manifest = service._build_airi_archive_display_model_bundle(
        display_format="live2d-zip",
        filename="model.zip",
        data=model_bytes,
    )
    manifest["redistribution_allowed"] = "yes"
    manifest["usage_restrictions"] = {"local_only": False, "rights_verified": True}
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("character.json", json.dumps({"name": "Forged rights"}))
        archive.writestr("recipe.json", json.dumps(CharacterRecipe().model_dump(mode="json")))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        for path, content in files.items():
            archive.writestr(f"assets/{path}", content)

    with pytest.raises(ValueError, match="redistribution_allowed"):
        service.import_character_upload(filename="forged-rights.zip", data=payload.getvalue())


def test_native_pack_cannot_spoof_airi_archive_source_filename(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    files, manifest = service._build_airi_archive_display_model_bundle(
        display_format="live2d-zip",
        filename="model.zip",
        data=_make_live2d_zip(),
    )
    manifest["source_filename"] = "spoofed-original.zip"
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("character.json", json.dumps({"name": "Forged filename"}))
        archive.writestr("recipe.json", json.dumps(CharacterRecipe().model_dump(mode="json")))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        for path, content in files.items():
            archive.writestr(f"assets/{path}", content)

    with pytest.raises(ValueError, match="source_filename"):
        service.import_character_upload(filename="forged-filename.zip", data=payload.getvalue())


@pytest.mark.parametrize(
    ("declared_format", "model_path", "error"),
    [
        ("live2d-zip", "model.vrm", "canonical ZIP path"),
        ("vrm", "display-model/model.zip", "VRM model_path"),
    ],
)
def test_native_pack_rejects_display_format_and_model_path_mismatches(
    isolated_settings,
    declared_format: str,
    model_path: str,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    model_bytes = _make_vrm1() if model_path.endswith(".vrm") else _make_live2d_zip()
    manifest = {
        "format": declared_format,
        "model_path": model_path,
        "license_path": "LICENSE.txt",
        "asset_paths": [model_path, "LICENSE.txt"],
        "license": "CC0",
        "redistribution_allowed": "yes",
    }
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("character.json", json.dumps({"name": "Mismatched format"}))
        archive.writestr("recipe.json", json.dumps(CharacterRecipe().model_dump(mode="json")))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        archive.writestr(f"assets/{model_path}", model_bytes)
        archive.writestr("assets/LICENSE.txt", b"CC0")

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(filename="mismatched-format.zip", data=payload.getvalue())


@pytest.mark.parametrize("display_format", ["live2d-zip", "spine-zip"])
def test_import_airi_archive_display_model_bounds_nested_metadata(
    isolated_settings,
    display_format: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        if display_format == "live2d-zip":
            archive.writestr(
                "avatar.model3.json",
                json.dumps(
                    {
                        "FileReferences": {"Moc": "avatar.moc3", "Textures": ["avatar.png"]},
                        "padding": "x" * 1_000_001,
                    }
                ),
            )
            archive.writestr("avatar.moc3", b"MOC3-local")
        else:
            archive.writestr(
                "avatar.json",
                json.dumps({"skeleton": {}, "padding": "x" * 1_000_001}),
            )
            archive.writestr("avatar.atlas", "avatar.png\nsize: 1,1\n")
        archive.writestr("avatar.png", _PNG_1X1)

    with pytest.raises(ValueError, match="metadata exceeds"):
        service.import_character_upload(
            filename="oversized-inner-metadata.zip",
            data=_build_airi_pack(display_format=display_format, display_model_bytes=payload.getvalue()),
        )


def test_import_airi_archive_display_model_applies_inner_zip_security_limits(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings).model_copy(
        update={"max_character_pack_size_bytes": 1_100_000}
    )
    service = CharacterService(SQLiteRepository(settings))

    symlink_payload = BytesIO()
    with ZipFile(symlink_payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("avatar.moc3", b"MOC3-local")
        archive.writestr("avatar.png", _PNG_1X1)
        symlink = ZipInfo("linked.png")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(symlink, "avatar.png")
    with pytest.raises(ValueError, match="symlink"):
        service.import_character_upload(
            filename="inner-symlink.zip",
            data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=symlink_payload.getvalue()),
        )

    executable_payload = BytesIO()
    with ZipFile(executable_payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("avatar.moc3", b"MOC3-local")
        archive.writestr("avatar.png", b"png")
        archive.writestr("payload.js", b"alert(1)")
    with pytest.raises(ValueError, match="executable"):
        service.import_character_upload(
            filename="inner-executable.zip",
            data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=executable_payload.getvalue()),
        )

    oversized_payload = BytesIO()
    with ZipFile(oversized_payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("avatar.moc3", b"MOC3-local")
        archive.writestr("avatar.png", b"0" * 1_100_001)
    with pytest.raises(ValueError, match="size limit"):
        service.import_character_upload(
            filename="inner-bomb.zip",
            data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=oversized_payload.getvalue()),
        )

    encrypted = bytearray(_make_live2d_zip())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        cursor = 0
        while (cursor := encrypted.find(signature, cursor)) >= 0:
            flags = int.from_bytes(encrypted[cursor + flag_offset : cursor + flag_offset + 2], "little")
            encrypted[cursor + flag_offset : cursor + flag_offset + 2] = (flags | 0x1).to_bytes(2, "little")
            cursor += 4
    with pytest.raises(ValueError, match="encrypted"):
        service.import_character_upload(
            filename="inner-encrypted.zip",
            data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=bytes(encrypted)),
        )

    too_many_entries = bytearray(_make_live2d_zip())
    eocd_offset = too_many_entries.rfind(b"PK\x05\x06")
    assert eocd_offset >= 0
    too_many_entries[eocd_offset + 8 : eocd_offset + 12] = struct.pack("<HH", 4097, 4097)
    with pytest.raises(ValueError, match="too many files"):
        service.import_character_upload(
            filename="inner-too-many.zip",
            data=_build_airi_pack(
                display_format="live2d-zip",
                display_model_bytes=bytes(too_many_entries),
            ),
        )


def test_import_airi_live2d_structure_only_accepts_single_moc3_with_local_texture(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("avatar.moc3", b"MOC3-local")
        archive.writestr("avatar.png", _PNG_1X1)

    imported = service.import_character_upload(
        filename="moc3-airi.zip",
        data=_build_airi_pack(display_format="live2d-zip", display_model_bytes=payload.getvalue()),
    )

    assert imported.asset_manifest["entrypoint"] == "avatar.moc3"
    assert imported.asset_manifest["validation_level"] == "structure-only"


@pytest.mark.parametrize("display_format", ["live2d-zip", "spine-zip"])
def test_import_airi_archive_display_model_repository_failure_rolls_back_assets(
    isolated_settings,
    monkeypatch,
    display_format: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    before_ids = {character.id for character in repository.list_characters()}
    before_asset_dirs = (
        {path.name for path in settings.characters_root.iterdir() if path.is_dir()}
        if settings.characters_root.exists()
        else set()
    )
    monkeypatch.setattr(
        repository,
        "upsert_character",
        lambda _character: (_ for _ in ()).throw(RuntimeError("repository failure")),
    )

    with pytest.raises(RuntimeError, match="repository failure"):
        service.import_character_upload(
            filename="airi-repository-failure.zip",
            data=_build_airi_pack(display_format=display_format),
        )

    assert {character.id for character in repository.list_characters()} == before_ids
    after_asset_dirs = (
        {path.name for path in settings.characters_root.iterdir() if path.is_dir()}
        if settings.characters_root.exists()
        else set()
    )
    assert after_asset_dirs == before_asset_dirs


def test_import_airi_character_card_zip_imports_declared_vrm_and_preserves_space_default(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    active_character = service.create_character(name="Existing active companion")
    now = datetime.now(timezone.utc)
    space = repository.upsert_space(
        StudySpace(
            id="airi-vrm-import-space",
            name="AIRI VRM import activation boundary",
            default_character_pack_id=active_character.id,
            created_at=now,
            updated_at=now,
        )
    )
    vrm = _make_vrm1(name="Trusted VRM name", allow_redistribution=True)
    package = _build_airi_pack(
        display_model_bytes=vrm,
        extra_files={"models/unrelated.txt": b"must not be read"},
    )
    original_read = ZipFile.read
    read_members: list[str] = []

    def read_declared_files_only(archive, member, *args, **kwargs):
        name = member.filename if isinstance(member, ZipInfo) else str(member)
        read_members.append(name)
        assert name in {"manifest.json", "card.json", "models/body-model.vrm"}
        return original_read(archive, member, *args, **kwargs)

    monkeypatch.setattr(ZipFile, "read", read_declared_files_only)

    imported = service.import_character_upload(filename="airi-vrm.zip", data=package)

    assert imported.name == "AIRI Mika"
    assert imported.asset_manifest["format"] == "vrm"
    assert imported.asset_manifest["model_path"] == "model.vrm"
    assert imported.asset_manifest["license_path"] == "licenses/vrm-meta.json"
    assert imported.asset_manifest["source_filename"] == "body-model.vrm"
    assert imported.asset_manifest["redistribution_allowed"] == "yes"
    assert imported.asset_manifest["source_display_model_imported"] is True
    assert imported.asset_manifest["source_display_model_format"] == "vrm"
    assert imported.asset_manifest["source_display_model_name"] == "AIRI source model.vrm"
    assert imported.asset_manifest["asset_paths"] == ["licenses/vrm-meta.json", "model.vrm"]
    assert set(imported.asset_manifest) == {
        "asset_paths",
        "attribution_required",
        "author",
        "format",
        "license",
        "license_path",
        "model_path",
        "modification_allowed",
        "prompt_overrides_ignored",
        "redistribution_allowed",
        "render_mode",
        "source_card_spec",
        "source_card_spec_version",
        "source_container_version",
        "source_display_model_format",
        "source_display_model_imported",
        "source_display_model_name",
        "source_filename",
        "source_format",
        "source_url",
        "usage_restrictions",
        "vrm_meta",
    }
    assert service.read_character_asset(imported.id, "model.vrm")[0] == vrm
    license_meta = json.loads(service.read_character_asset(imported.id, "licenses/vrm-meta.json")[0])
    assert license_meta["name"] == "Trusted VRM name"
    asset_root = settings.characters_root / imported.id
    assert sorted(
        path.relative_to(asset_root).as_posix()
        for path in asset_root.rglob("*")
        if path.is_file()
    ) == ["licenses/vrm-meta.json", "model.vrm"]
    assert read_members == [
        "manifest.json",
        "card.json",
        "models/body-model.vrm",
    ]
    assert repository.get_space(space.id).default_character_pack_id == active_character.id


def test_import_airi_character_card_zip_without_resources_uses_builtin_model(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    service = CharacterService(SQLiteRepository(settings))

    imported = service.import_character_upload(
        filename="airi-card-only.zip",
        data=_build_airi_pack(include_display_model=False),
    )

    assert imported.name == "AIRI Mika"
    assert imported.recipe == CharacterRecipe()
    assert imported.asset_manifest == {
        "pack_kind": "recipe-only",
        "render_mode": "vrm-or-2d-fallback",
        "source_format": "airi-character-card",
        "source_container_version": 1,
        "source_card_spec": "chara_card_v3",
        "source_card_spec_version": "3.0",
        "prompt_overrides_ignored": True,
    }
    assert not any(key.startswith("source_display_model_") for key in imported.asset_manifest)
    assert not (settings.characters_root / imported.id).exists()


def test_import_airi_character_card_zip_accepts_schema_valid_opaque_model_path(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    opaque_path = "models/display-resource"
    manifest = {
        "format": "airi-character-card",
        "version": 1,
        "card": {"path": "card.json", "spec": "chara_card_v3"},
        "resources": {
            "displayModel": {
                "format": "vrm",
                "path": opaque_path,
                "name": "Schema-valid opaque display resource",
            }
        },
    }

    imported = service.import_character_upload(
        filename="airi-opaque-model-path.zip",
        data=_build_airi_pack(
            manifest=manifest,
            extra_files={opaque_path: _make_vrm1(name="Opaque path VRM")},
        ),
    )

    assert imported.asset_manifest["source_display_model_format"] == "vrm"
    assert imported.asset_manifest["source_display_model_imported"] is True
    assert service.read_character_asset(imported.id, "model.vrm")[0] == _make_vrm1(
        name="Opaque path VRM"
    )


def test_import_airi_vrm_ignores_outer_license_claims(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "format": "airi-character-card",
        "version": 1,
        "card": {"path": "card.json", "spec": "chara_card_v3"},
        "license": "Outer manifest must not win",
        "redistribution_allowed": "no",
        "resources": {
            "displayModel": {
                "format": "vrm",
                "path": "models/body-model.vrm",
                "name": "Outer model name",
            }
        },
    }

    imported = service.import_character_upload(
        filename="airi-license.zip",
        data=_build_airi_pack(
            manifest=manifest,
            display_model_bytes=_make_vrm1(allow_redistribution=True),
        ),
    )

    assert imported.asset_manifest["license"] == "https://vrm.dev/licenses/1.0/"
    assert imported.asset_manifest["redistribution_allowed"] == "yes"

    restricted_manifest = {
        **manifest,
        "license": "CC0",
        "redistribution_allowed": "yes",
        "author": "Mallory",
        "source_url": "https://untrusted.example/license",
    }
    restricted = service.import_character_upload(
        filename="airi-restricted-license.zip",
        data=_build_airi_pack(
            manifest=restricted_manifest,
            display_model_bytes=_make_vrm1(allow_redistribution=False),
        ),
    )

    assert restricted.asset_manifest["redistribution_allowed"] == "no"
    serialized = json.dumps(restricted.model_dump(mode="json"))
    assert "Mallory" not in serialized
    assert "untrusted.example" not in serialized
    with pytest.raises(ValueError, match="redistribution"):
        service.export_character_pack(restricted.id)


@pytest.mark.parametrize("failure", ["invalid-vrm", "repository"])
def test_import_airi_vrm_failure_leaves_no_character_or_assets(
    isolated_settings,
    monkeypatch,
    failure: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    before_ids = {character.id for character in repository.list_characters()}
    before_asset_dirs = (
        {path.name for path in settings.characters_root.iterdir() if path.is_dir()}
        if settings.characters_root.exists()
        else set()
    )
    vrm = b"not-a-vrm" if failure == "invalid-vrm" else _make_vrm1()
    if failure == "repository":
        monkeypatch.setattr(
            repository,
            "upsert_character",
            lambda _character: (_ for _ in ()).throw(RuntimeError("repository failure")),
        )

    expected_error = ValueError if failure == "invalid-vrm" else RuntimeError
    with pytest.raises(expected_error):
        service.import_character_upload(
            filename="airi-failure.zip",
            data=_build_airi_pack(display_model_bytes=vrm),
        )

    assert {character.id for character in repository.list_characters()} == before_ids
    after_asset_dirs = (
        {path.name for path in settings.characters_root.iterdir() if path.is_dir()}
        if settings.characters_root.exists()
        else set()
    )
    assert after_asset_dirs == before_asset_dirs


def test_import_airi_vrm_reports_incomplete_asset_rollback(
    isolated_settings,
    monkeypatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    original_rmtree = shutil.rmtree
    before_ids = {character.id for character in repository.list_characters()}
    before_asset_dirs = (
        {path.name for path in settings.characters_root.iterdir() if path.is_dir()}
        if settings.characters_root.exists()
        else set()
    )

    monkeypatch.setattr(
        repository,
        "upsert_character",
        lambda _character: (_ for _ in ()).throw(RuntimeError("repository failure")),
    )

    def fail_asset_cleanup(path, *args, **kwargs):
        if Path(path).parent == settings.characters_root:
            raise OSError("simulated cleanup failure")
        return original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", fail_asset_cleanup)

    with pytest.raises(RuntimeError, match="rollback was incomplete"):
        service.import_character_upload(
            filename="airi-cleanup-failure.zip",
            data=_build_airi_pack(display_model_bytes=_make_vrm1()),
        )

    assert {character.id for character in repository.list_characters()} == before_ids
    residuals = [
        path
        for path in settings.characters_root.iterdir()
        if path.is_dir() and path.name not in before_asset_dirs
    ]
    assert len(residuals) == 1
    original_rmtree(residuals[0])


def test_import_airi_character_card_zip_discards_large_or_non_utf8_safe_extensions(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    extension_marker = "AIRI_EXTENSION_MUST_NOT_BE_REENCODED_OR_PERSISTED"
    card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": "Extension-safe AIRI card",
            "description": "Only bounded persona text is imported.",
            "extensions": {
                "values": ["x"] * 130_000,
                "surrogate": "\ud800",
                "marker": extension_marker,
            },
        },
    }

    imported = service.import_character_upload(
        filename="airi-large-extensions.zip",
        data=_build_airi_pack(card=card, include_display_model=False),
    )

    assert imported.name == "Extension-safe AIRI card"
    assert extension_marker not in json.dumps(imported.model_dump(mode="json"))


def test_native_character_pack_cannot_assert_trusted_airi_provenance(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
        "source_format": "airi-character-card",
        "source_container_version": 1,
        "source_card_spec": "chara_card_v3",
        "source_card_spec_version": "3.0",
        "source_display_model_format": "vrm",
        "source_display_model_name": "Spoofed source",
        "source_display_model_imported": False,
    }

    imported = service.import_character_upload(
        filename="native-spoof.zip",
        data=_build_pack(
            vrm_bytes=_make_vrm0(title="Native provenance boundary"),
            manifest=manifest,
            extra_files={"assets/LICENSE.txt": b"CC0"},
        ),
    )

    trusted_airi_keys = {
        "source_format",
        "source_container_version",
        "source_card_spec",
        "source_card_spec_version",
        "source_display_model_format",
        "source_display_model_name",
        "source_display_model_imported",
    }
    assert not (trusted_airi_keys & imported.asset_manifest.keys())


def test_native_character_pack_rejects_portable_asset_name_collisions(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
    }
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("character.json", json.dumps({"name": "Collision"}))
        archive.writestr("recipe.json", json.dumps(CharacterRecipe().model_dump(mode="json")))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        archive.writestr("model.vrm", _make_vrm0(title="Validated model"))
        archive.writestr("assets/MODEL.VRM", b"unvalidated overwrite")
        archive.writestr("assets/LICENSE.txt", b"CC0")

    with pytest.raises(ValueError, match="portable asset filename collision"):
        service.import_character_upload(filename="portable-collision.zip", data=payload.getvalue())


def test_native_character_pack_accepts_standard_unix_directory_entries(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
    }
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        directory = ZipInfo("assets/")
        directory.create_system = 3
        directory.external_attr = (stat.S_IFDIR | 0o755) << 16
        archive.writestr(directory, b"")
        archive.writestr("character.json", json.dumps({"name": "Unix directory pack"}))
        archive.writestr("recipe.json", json.dumps(CharacterRecipe().model_dump(mode="json")))
        archive.writestr("asset_manifest.json", json.dumps(manifest))
        archive.writestr("assets/model.vrm", _make_vrm0(title="Unix directory model"))
        archive.writestr("assets/LICENSE.txt", b"CC0")

    imported = service.import_character_upload(filename="unix-directory.zip", data=payload.getvalue())

    assert imported.name == "Unix directory pack"
    assert service.read_character_asset(imported.id, "model.vrm")[1] == "model/gltf-binary"


@pytest.mark.parametrize(
    "unsafe_name",
    ["assets/CON.txt", "assets/trailing-dot.", "assets/model.vrm:alternate"],
)
def test_character_pack_rejects_nonportable_windows_asset_names(
    isolated_settings,
    unsafe_name: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
    }

    with pytest.raises(ValueError, match="unsafe path"):
        service.import_character_upload(
            filename="nonportable.zip",
            data=_build_pack(
                vrm_bytes=_make_vrm0(title="Portable model"),
                manifest=manifest,
                extra_files={"assets/LICENSE.txt": b"CC0", unsafe_name: b"blocked"},
            ),
        )


def test_character_pack_preserves_nfd_asset_paths_but_rejects_nfc_collisions(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    service = CharacterService(SQLiteRepository(settings))
    nfd_model_path = "cafe\u0301.vrm"
    manifest = {
        "model_path": nfd_model_path,
        "license_path": "LICENSE.txt",
        "asset_paths": [nfd_model_path, "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
    }
    vrm_bytes = _make_vrm0(title="NFD model")
    imported = service.import_character_upload(
        filename="nfd-model.zip",
        data=_build_pack(
            vrm_bytes=_make_vrm0(title="Unlisted default model"),
            manifest=manifest,
            extra_files={f"assets/{nfd_model_path}": vrm_bytes, "assets/LICENSE.txt": b"CC0"},
        ),
    )

    assert imported.asset_manifest["model_path"] == nfd_model_path
    assert service.read_character_asset(imported.id, nfd_model_path)[0] == vrm_bytes

    with pytest.raises(ValueError, match="portable filename collision"):
        service.import_character_upload(
            filename="unicode-collision.zip",
            data=_build_pack(
                vrm_bytes=_make_vrm0(title="Portable model"),
                manifest={
                    "model_path": "model.vrm",
                    "license_path": "LICENSE.txt",
                    "asset_paths": ["model.vrm", "LICENSE.txt"],
                    "license": "CC0-1.0",
                    "redistribution_allowed": "yes",
                },
                extra_files={
                    "assets/LICENSE.txt": b"CC0",
                    "assets/caf\u00e9.txt": b"NFC",
                    "assets/cafe\u0301.txt": b"NFD",
                },
            ),
        )


@pytest.mark.parametrize(
    ("manifest_update", "card_update", "error"),
    [
        ({"format": "other"}, {}, "format"),
        ({"version": 2}, {}, "version"),
        ({"version": True}, {}, "version"),
        ({"card": {"path": "nested/card.json", "spec": "chara_card_v3"}}, {}, "card.path"),
        ({"card": {"path": "card.json", "spec": "chara_card_v2"}}, {}, "card.spec"),
        ({}, {"spec": "chara_card_v2", "spec_version": "2.0"}, "card.spec"),
        ({}, {"spec_version": "2.0"}, "must be 3.0"),
        ({}, {"spec_version": "3.1"}, "must be 3.0"),
        ({}, {"data": {"name": "\ud800"}}, "invalid Unicode"),
        ({"resources": {}}, {}, "displayModel"),
        ({"resources": {"displayModel": []}}, {}, "displayModel"),
        (
            {
                "resources": {
                    "displayModel": {
                        "format": "vrm",
                        "path": "models/body-model.vrm",
                    }
                }
            },
            {},
            "name",
        ),
        (
            {
                "resources": {
                    "displayModel": {
                        "format": [],
                        "path": "models/body-model.vrm",
                        "name": "model.vrm",
                    }
                }
            },
            {},
            "format",
        ),
        (
            {
                "resources": {
                    "displayModel": {
                        "format": "vrm",
                        "path": "models/missing.vrm",
                        "name": "model.vrm",
                    }
                }
            },
            {},
            "missing its display model",
        ),
        (
            {
                "resources": {
                    "displayModel": {
                        "format": "vrm",
                        "path": "models/body-model.vrm",
                        "name": "x" * 256,
                    }
                }
            },
            {},
            "field limit",
        ),
        (
            {
                "resources": {
                    "displayModel": {
                        "format": "vrm",
                        "path": "models/body-model.vrm",
                        "name": "sk-abcdefghijklmnop",
                    }
                }
            },
            {},
            "credential",
        ),
    ],
)
def test_import_airi_character_card_zip_rejects_wrong_manifest_or_card_contract(
    isolated_settings,
    manifest_update: dict,
    card_update: dict,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {
        "format": "airi-character-card",
        "version": 1,
        "card": {"path": "card.json", "spec": "chara_card_v3"},
    }
    manifest.update(manifest_update)
    card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {"name": "AIRI Mika"},
    }
    card.update(card_update)

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(
            filename="airi-character.zip",
            data=_build_airi_pack(manifest=manifest, card=card),
        )


def test_airi_json_and_manifest_depth_fail_with_controlled_validation_errors(
    isolated_settings,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    deeply_nested_json = ("{\"x\":" * 10_000 + "0" + "}" * 10_000).encode()
    payload = BytesIO()
    with ZipFile(payload, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", deeply_nested_json)
        archive.writestr("card.json", b"{}")

    with pytest.raises(ValueError, match="valid UTF-8 JSON"):
        service.import_character_upload(filename="deep-airi.zip", data=payload.getvalue())

    deeply_nested_manifest: dict = {}
    cursor = deeply_nested_manifest
    for _ in range(1_500):
        child: dict = {}
        cursor["x"] = child
        cursor = child
    with pytest.raises(ValueError, match="nesting exceeds"):
        service._validate_manifest_keys(deeply_nested_manifest)


def test_import_airi_character_card_zip_rejects_unsafe_or_ambiguous_archives(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings).model_copy(
        update={"max_character_pack_size_bytes": 1_100_000}
    )
    service = CharacterService(SQLiteRepository(settings))

    with pytest.raises(ValueError, match="ambiguous"):
        service.import_character_upload(
            filename="ambiguous.zip",
            data=_build_airi_pack(extra_files={"character.json": b"{}"}),
        )

    with pytest.raises(ValueError, match="duplicate"):
        payload = BytesIO()
        with ZipFile(payload, "w") as archive:
            archive.writestr("manifest.json", "{}")
            archive.writestr("manifest.json", "{}")
        service.import_character_upload(filename="duplicate.zip", data=payload.getvalue())

    with pytest.raises(ValueError, match="travers"):
        service.import_character_upload(
            filename="traversal.zip",
            data=_build_airi_pack(extra_files={"../escape.txt": b"nope"}),
        )

    symlink_payload = BytesIO()
    with ZipFile(symlink_payload, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "format": "airi-character-card",
                    "version": 1,
                    "card": {"path": "card.json", "spec": "chara_card_v3"},
                }
            ),
        )
        archive.writestr(
            "card.json",
            json.dumps(
                {
                    "spec": "chara_card_v3",
                    "spec_version": "3.0",
                    "data": {"name": "AIRI Mika"},
                }
            ),
        )
        symlink = ZipInfo("models/link.vrm")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(symlink, "target.vrm")
    with pytest.raises(ValueError, match="symlink"):
        service.import_character_upload(
            filename="symlink.zip",
            data=symlink_payload.getvalue(),
        )

    encrypted = bytearray(_build_airi_pack())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        cursor = 0
        while (cursor := encrypted.find(signature, cursor)) >= 0:
            flags = int.from_bytes(encrypted[cursor + flag_offset : cursor + flag_offset + 2], "little")
            encrypted[cursor + flag_offset : cursor + flag_offset + 2] = (flags | 0x1).to_bytes(2, "little")
            cursor += 4
    with pytest.raises(ValueError, match="encrypted"):
        service.import_character_upload(filename="encrypted.zip", data=bytes(encrypted))

    too_many_entries = bytearray(_build_airi_pack())
    eocd_offset = too_many_entries.rfind(b"PK\x05\x06")
    assert eocd_offset >= 0
    too_many_entries[eocd_offset + 8 : eocd_offset + 12] = struct.pack("<HH", 4097, 4097)
    with pytest.raises(ValueError, match="too many files"):
        service.import_character_upload(
            filename="too-many-files.zip",
            data=bytes(too_many_entries),
        )

    with pytest.raises(ValueError, match="size limit"):
        service.import_character_upload(
            filename="bomb.zip",
            data=_build_airi_pack(extra_files={"models/huge.txt": b"0" * 1_100_001}),
        )

    oversized_manifest = {
        "format": "airi-character-card",
        "version": 1,
        "card": {"path": "card.json", "spec": "chara_card_v3"},
        "padding": "x" * 1_000_001,
    }
    with pytest.raises(ValueError, match="metadata"):
        service.import_character_upload(
            filename="oversized-metadata.zip",
            data=_build_airi_pack(manifest=oversized_manifest),
        )

    native_manifest = {
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "license": "CC0-1.0",
        "redistribution_allowed": "yes",
    }
    native = service.import_character_upload(
        filename="native-with-large-root-manifest.zip",
        data=_build_pack(
            vrm_bytes=_make_vrm0(title="Native with manifest asset"),
            manifest=native_manifest,
            extra_files={
                "assets/LICENSE.txt": b"CC0",
                "manifest.json": b"x" * 1_000_001,
            },
        ),
    )
    assert native.name == "Imported Pack"


@pytest.mark.parametrize(
    ("card", "error"),
    [
        (b"not json", "valid UTF-8 JSON"),
        (json.dumps([]).encode(), "JSON object"),
        (
            json.dumps({"spec": "chara_card_v1", "spec_version": "1.0", "data": {}}).encode(),
            "Unsupported",
        ),
        (
            json.dumps({"spec": "chara_card_v2", "spec_version": "2.0", "data": []}).encode(),
            "data must be a JSON object",
        ),
        (
            json.dumps(
                {"spec": "chara_card_v2", "spec_version": "2.0", "data": {"name": ""}}
            ).encode(),
            "name cannot be empty",
        ),
        (
            json.dumps(
                {
                    "spec": "chara_card_v2",
                    "spec_version": "2.0",
                    "data": {"name": "Mika", "description": 3},
                }
            ).encode(),
            "description must be a string",
        ),
        (
            json.dumps(
                {
                    "spec": "chara_card_v2",
                    "spec_version": "2.0",
                    "data": {"name": "Mika", "alternate_greetings": ["hello", 3]},
                }
            ).encode(),
            "contain only strings",
        ),
        (
            json.dumps(
                {
                    "spec": "chara_card_v3",
                    "spec_version": "3.0",
                    "data": {"name": "Mika", "system_prompt": {}},
                }
            ).encode(),
            "system_prompt must be a string",
        ),
    ],
)
def test_import_character_card_rejects_malformed_unsupported_and_wrong_types(
    isolated_settings,
    card: bytes,
    error: str,
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))

    with pytest.raises(ValueError, match=error):
        service.import_character_upload(filename="persona.json", data=card)


def test_import_character_card_enforces_input_field_and_array_limits(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    base = {"spec": "chara_card_v3", "spec_version": "3.0"}

    for data, error in (
        ({"name": "Mika", "description": "x" * 20_001}, "field limit"),
        ({"name": "Mika", "alternate_greetings": [""] * 33}, "item limit"),
        ({"name": "x" * 121}, "field limit"),
        ({"name": "Mika", "nickname": "x" * 121}, "field limit"),
        (
            {
                "name": "Mika",
                **{
                    field: "x" * 20_000
                    for field in (
                        "description",
                        "personality",
                        "scenario",
                        "first_mes",
                        "mes_example",
                    )
                },
            },
            "total limit",
        ),
    ):
        with pytest.raises(ValueError, match=error):
            service.import_character_upload(
                filename="persona.json",
                data=json.dumps({**base, "data": data}).encode(),
            )

    with pytest.raises(ValueError, match="size limit"):
        service.import_character_upload(filename="persona.json", data=b"x" * 1_000_001)


@pytest.mark.parametrize(
    "data",
    [
        {"name": "\ud800"},
        {"name": "Mika", "description": "unsafe \udfff"},
        {"name": "Mika", "alternate_greetings": ["unsafe \ud800"]},
    ],
)
def test_import_character_card_rejects_lone_unicode_surrogates(
    isolated_settings,
    data: dict[str, object],
) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    card = {"spec": "chara_card_v3", "spec_version": "3.0", "data": data}

    with pytest.raises(ValueError, match="invalid Unicode"):
        service.import_character_upload(
            filename="persona.json",
            data=json.dumps(card).encode(),
        )


def test_seeded_character_uses_canonical_recipe_tokens(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)

    seeded = service.list_characters()[0]

    assert seeded.name == "澄羽"
    assert seeded.recipe.avatar_model == "mira"
    assert seeded.recipe.base_model == "mini"
    assert seeded.recipe.hairstyle == "short_bob"


def test_character_recipe_defaults_match_shared_json() -> None:
    expected = json.loads(_DEFAULT_CHARACTER_RECIPE_PATH.read_text(encoding="utf-8"))

    assert CharacterRecipe().model_dump(mode="json") == expected
    assert CharacterRecipe.model_validate({"avatar_model": "seed_san"}).avatar_framing == "full_body"
    assert CharacterRecipe.model_validate({"avatar_model": "seed_san"}).stage_background == "neutral"


def test_persisted_character_without_stage_background_uses_default(isolated_settings) -> None:
    repository = SQLiteRepository(_local_settings(isolated_settings))
    service = CharacterService(repository)
    created = service.create_character(name="Legacy Stage")
    legacy_recipe = created.recipe.model_dump(mode="json")
    legacy_recipe.pop("stage_background")

    with repository.connection() as connection:
        connection.execute(
            "UPDATE character_packs SET recipe_json = ? WHERE id = ?",
            (json.dumps(legacy_recipe), created.id),
        )

    loaded = service.get_character(created.id)
    assert loaded is not None
    assert loaded.recipe.stage_background == "neutral"


def test_seeded_character_matches_shared_default_json(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)

    expected = json.loads(_DEFAULT_CHARACTER_RECIPE_PATH.read_text(encoding="utf-8"))
    seeded = service.list_characters()[0]

    assert seeded.recipe.model_dump(mode="json") == expected


def test_import_character_pack_rejects_missing_license_and_unsafe_entries(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    manifest = {
        "render_mode": "vrm-or-2d-fallback",
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }
    vrm_bytes = _make_vrm0()

    missing_license_pack = _build_pack(vrm_bytes=vrm_bytes, manifest=manifest)
    with pytest.raises(ValueError, match="license"):
        service.import_character_upload(filename="character-pack.zip", data=missing_license_pack)

    traversal_pack = _build_pack(
        vrm_bytes=vrm_bytes,
        manifest=manifest,
        extra_files={
            "assets/LICENSE.txt": b"CC0",
            "../escape.txt": b"nope",
        },
    )
    with pytest.raises(ValueError, match="travers"):
        service.import_character_upload(filename="character-pack.zip", data=traversal_pack)

    executable_pack = _build_pack(
        vrm_bytes=vrm_bytes,
        manifest=manifest,
        extra_files={
            "assets/LICENSE.txt": b"CC0",
            "assets/run.sh": b"#!/bin/sh\nexit 0\n",
        },
    )
    with pytest.raises(ValueError, match="execut"):
        service.import_character_upload(filename="character-pack.zip", data=executable_pack)


def test_import_rejects_invalid_signatures_and_non_redistributable_vrm_exports(isolated_settings) -> None:
    settings = _local_settings(isolated_settings).model_copy(update={"max_character_pack_size_bytes": 4096})
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)

    with pytest.raises(ValueError, match="VRM"):
        service.import_character_upload(filename="broken.vrm", data=b"not-a-vrm")

    with pytest.raises(ValueError, match="zip"):
        service.import_character_upload(filename="broken.zip", data=b"not-a-zip")

    imported = service.import_character_upload(
        filename="restricted.vrm",
        data=_make_vrm0(title="Restricted", license_name="Redistribution_Prohibited"),
    )
    assert imported.asset_manifest["redistribution_allowed"] == "no"
    with pytest.raises(ValueError, match="redistribution"):
        service.export_character_pack(imported.id)

    large_character = service.create_character(
        name="Large Pack",
        recipe=CharacterRecipe(personality="cool"),
    )
    service.update_character(
        large_character.id,
        asset_manifest={
            "render_mode": "vrm-or-2d-fallback",
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
            "asset_paths": ["model.vrm", "LICENSE.txt"],
            "redistribution_allowed": "yes",
            "license": "CC0",
        },
    )
    asset_root = settings.characters_root / large_character.id
    asset_root.mkdir(parents=True, exist_ok=True)
    (asset_root / "model.vrm").write_bytes(b"x" * 4097)
    (asset_root / "LICENSE.txt").write_text("CC0", encoding="utf-8")
    with pytest.raises(ValueError, match="size limit"):
        service.export_character_pack(large_character.id)


@pytest.mark.parametrize(
    ("filename", "content"),
    [
        ("assets/LICENSE.txt", b"#!/bin/sh\nexit 0\n"),
        ("assets/LICENSE.txt", b"MZfake-pe"),
        ("assets/LICENSE.txt", b"\x7fELFfake"),
        ("assets/LICENSE.txt", b"\xcf\xfa\xed\xfe\x07\x00\x00\x01"),
    ],
)
def test_import_character_pack_rejects_executable_content_signatures(
    isolated_settings,
    filename: str,
    content: bytes,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    manifest = {
        "render_mode": "vrm-or-2d-fallback",
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "redistribution_allowed": "yes",
        "license": "CC0",
        "source_url": "https://licenses.example.com/token-policy",
    }

    pack = _build_pack(
        vrm_bytes=_make_vrm0(),
        manifest=manifest,
        extra_files={filename: content},
    )

    with pytest.raises(ValueError, match="executable file content"):
        service.import_character_upload(filename="character-pack.zip", data=pack)


def test_import_character_pack_rejects_credential_like_manifest_values(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    base_manifest = {
        "render_mode": "vrm-or-2d-fallback",
        "model_path": "model.vrm",
        "license_path": "LICENSE.txt",
        "asset_paths": ["model.vrm", "LICENSE.txt"],
        "redistribution_allowed": "yes",
        "license": "CC0",
    }

    unsafe_pack = _build_pack(
        vrm_bytes=_make_vrm0(),
        manifest={
            **base_manifest,
            "source_url": "https://licenses.example.com/vrm?api_key=topsecret",
        },
        extra_files={"assets/LICENSE.txt": b"CC0"},
    )
    with pytest.raises(ValueError, match="credential-shaped string value"):
        service.import_character_upload(filename="character-pack.zip", data=unsafe_pack)

    safe_pack = _build_pack(
        vrm_bytes=_make_vrm0(),
        manifest={
            **base_manifest,
            "source_url": "https://licenses.example.com/token-policy",
        },
        extra_files={"assets/LICENSE.txt": b"CC0"},
    )

    imported = service.import_character_upload(filename="character-pack.zip", data=safe_pack)
    assert imported.asset_manifest["source_url"] == "https://licenses.example.com/token-policy"
