from __future__ import annotations

import hashlib
import json
import shutil
import struct
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Event

import pytest

from app.models.domain import CharacterRecipe, StudySpace
from app.services.characters import CharacterService
from app.services.repository import SQLiteRepository


_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_CHARACTER_RECIPE_PATH = _REPO_ROOT / "libs" / "schemas" / "default_character_recipe.json"
_BUNDLED_VRMA_PATH = _REPO_ROOT / "assets-archive" / "motions" / "companion-idle.vrma"


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


def test_import_vrm_persists_meta_and_copies_assets(isolated_settings) -> None:
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

    duplicate = service.duplicate_character(imported.id)
    assert duplicate.id != imported.id
    assert duplicate.asset_manifest == imported.asset_manifest
    assert service.read_character_asset(duplicate.id, "model.vrm") == (_make_vrm1(), "model/gltf-binary")


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
    # Seed a character persisted by the old importer to exercise compatibility.
    imported = service.create_character(name="Original", recipe=recipe)
    imported = service.update_character(imported.id, asset_manifest=manifest)
    service._write_asset_files(imported.id, {
        "model.vrm": _make_vrm0(title="Original"),
        "LICENSE.txt": b"CC0",
        "motions/wave.vrma": _make_vrma(),
    })
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

    deleted = restarted.delete_managed_motion(character.id, state)
    deleted_at = deleted.updated_at
    assert deleted.recipe == original_recipe
    assert "managed_motions" not in deleted.asset_manifest
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
def test_managed_motion_rejects_invalid_vrma(isolated_settings, motion_bytes: bytes, error: str) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    character = service.create_character(name="Invalid animation")

    with pytest.raises(ValueError, match=error):
        service.put_managed_motion(character.id, "idle", filename="idle.vrma", data=motion_bytes)
    assert service.require_character(character.id) == character
    assert _asset_tree_bytes(service, character.id) == {}


def test_character_manifest_rejects_excessive_nesting(isolated_settings) -> None:
    service = CharacterService(SQLiteRepository(_local_settings(isolated_settings)))
    manifest = {}
    for _ in range(1200):
        manifest = {"nested": manifest}
    with pytest.raises(ValueError, match="nesting exceeds the limit"):
        service._validate_manifest_keys(manifest)


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


def test_import_vrm_validates_signature_and_retains_license(isolated_settings) -> None:
    settings = _local_settings(isolated_settings).model_copy(update={"max_character_pack_size_bytes": 4096})
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)

    with pytest.raises(ValueError, match="VRM"):
        service.import_character_upload(filename="broken.vrm", data=b"not-a-vrm")

    imported = service.import_character_upload(
        filename="restricted.vrm",
        data=_make_vrm0(title="Restricted", license_name="Redistribution_Prohibited"),
    )
    assert imported.asset_manifest["redistribution_allowed"] == "no"
