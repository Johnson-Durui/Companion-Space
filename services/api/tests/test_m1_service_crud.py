from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO
from zipfile import ZipFile

import pytest

from app.models.domain import (
    CharacterRecipe,
    CompanionTurn,
    MemoryItem,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    SessionRecord,
    TurnRole,
)
from app.services import provider_registry as provider_registry_module
from app.services.characters import CharacterService
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService
from app.services.vault import VaultService


def _local_settings(isolated_settings):
    return isolated_settings.model_copy(
        update={
            "embedding_provider": "local_hybrid",
            "reranker_provider": "local",
        }
    )


def _seed_space_dependents(repository: SQLiteRepository, *, space_id: str, provider_connection_id: str) -> None:
    now = datetime.now(timezone.utc)
    session = SessionRecord(
        id=f"session-{space_id}",
        space_id=space_id,
        created_at=now,
        updated_at=now,
    )
    repository.upsert_session(session)
    repository.add_turn(
        CompanionTurn(
            id=f"turn-{space_id}",
            session_id=session.id,
            space_id=space_id,
            role=TurnRole.user,
            display_text="keep this scoped",
            spoken_text="keep this scoped",
            created_at=now,
        )
    )
    repository.upsert_memory_item(
        MemoryItem(
            id=f"memory-{space_id}",
            space_id=space_id,
            content="scoped memory",
            created_at=now,
            updated_at=now,
        )
    )
    repository.upsert_review_item(
        ReviewItem(
            id=f"review-{space_id}",
            space_id=space_id,
            prompt="scoped review",
            created_at=now,
            updated_at=now,
        )
    )
    repository.upsert_model_assignment(
        ModelAssignment(
            id=f"assignment-{space_id}",
            space_id=space_id,
            capability=ProviderCapability.chat_llm,
            provider_connection_id=provider_connection_id,
            model_name="mock-companion-v1",
            created_at=now,
            updated_at=now,
        )
    )


def test_space_detail_and_delete_cascade_stay_scoped(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    target = service.create_space(name="Target", topic="scope", goal="delete")
    survivor = service.create_space(name="Survivor", topic="scope", goal="keep")
    target_material, target_job = service.ingest_note(space_id=target.id, title="Target note", content="target-only material")
    survivor_material, survivor_job = service.ingest_note(
        space_id=survivor.id,
        title="Survivor note",
        content="survivor-only material",
    )
    service.wait_for_ingestion(target_job.id, timeout_seconds=2.0)
    service.wait_for_ingestion(survivor_job.id, timeout_seconds=2.0)

    now = datetime.now(timezone.utc)
    connection = ProviderConnection(
        id="shared-provider",
        provider="mock",
        label="Shared",
        capabilities=[ProviderCapability.chat_llm],
        created_at=now,
        updated_at=now,
    )
    repository.upsert_provider_connection(connection)
    _seed_space_dependents(repository, space_id=target.id, provider_connection_id=connection.id)
    _seed_space_dependents(repository, space_id=survivor.id, provider_connection_id=connection.id)

    detail = service.get_space_detail(target.id)
    assert detail["space"].id == target.id
    assert [item.id for item in detail["materials"]] == [target_material.id]
    assert len(detail["assignments"]) == 4
    assert {item.space_id for item in detail["assignments"]} == {target.id}
    assert {item.capability for item in detail["assignments"]} == {
        ProviderCapability.analysis_llm,
        ProviderCapability.chat_llm,
        ProviderCapability.stt,
        ProviderCapability.tts,
    }

    assert service.delete_space(target.id) is True
    assert service.get_space(target.id) is None
    assert service.get_space(survivor.id) is not None
    assert not (settings.spaces_root / target.id).exists()
    assert (settings.spaces_root / survivor.id).exists()
    assert not service.resolve_material_path(target_material).exists()
    assert service.resolve_material_path(survivor_material).exists()

    with repository.connection() as conn:
        for table in (
            "materials",
            "chunks",
            "ingestion_jobs",
            "sessions",
            "turns",
            "memory_items",
            "review_items",
            "model_assignments",
        ):
            assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE space_id = ?", (target.id,)).fetchone()[0] == 0
            assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE space_id = ?", (survivor.id,)).fetchone()[0] >= 1


def test_material_delete_requires_matching_space_and_contained_path(isolated_settings, tmp_path) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    first = service.create_space(name="First")
    second = service.create_space(name="Second")
    first_material, first_job = service.ingest_note(space_id=first.id, title="First", content="first material")
    second_material, second_job = service.ingest_note(space_id=second.id, title="Second", content="second material")
    service.wait_for_ingestion(first_job.id, timeout_seconds=2.0)
    service.wait_for_ingestion(second_job.id, timeout_seconds=2.0)

    with pytest.raises(ValueError, match="Material not found"):
        service.delete_material(space_id=first.id, material_id=second_material.id)
    assert repository.get_material(second_material.id) is not None

    assert service.delete_material(space_id=first.id, material_id=first_material.id) is True
    assert repository.get_material(first_material.id) is None
    assert not service.resolve_material_path(first_material).exists()
    assert repository.list_chunks(first.id) == []

    outside = tmp_path / "must-survive.txt"
    outside.write_text("outside", encoding="utf-8")
    escaped = service.ingest_note(space_id=first.id, title="Escaped", content="temporary")
    service.wait_for_ingestion(escaped[1].id, timeout_seconds=2.0)
    escaped_material = escaped[0].model_copy(update={"storage_path": str(outside)})
    repository.upsert_material(escaped_material)
    with pytest.raises(ValueError, match="outside"):
        service.delete_material(space_id=first.id, material_id=escaped_material.id)
    assert outside.read_text(encoding="utf-8") == "outside"
    assert repository.get_material(escaped_material.id) is not None


def test_character_crud_and_export_enforce_license_and_containment(isolated_settings, tmp_path) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    original = service.create_character(name="Aster", description="Original")
    recipe = CharacterRecipe(personality="cool", warmth=55)
    updated = service.update_character(
        original.id,
        description="Updated",
        recipe=recipe,
        asset_manifest={
            "redistribution_allowed": "yes",
            "license": "CC0-1.0",
            "model_path": "model.vrm",
            "license_path": "LICENSE.txt",
        },
    )
    assert updated.name == "Aster"
    assert updated.description == "Updated"
    assert updated.recipe == recipe
    assert updated.created_at == original.created_at

    duplicate = service.duplicate_character(original.id)
    assert duplicate.id != original.id
    assert duplicate.name == "Aster Copy"
    assert duplicate.recipe == updated.recipe
    assert duplicate.asset_manifest == updated.asset_manifest

    asset_root = settings.characters_root / original.id
    asset_root.mkdir(parents=True)
    (asset_root / "model.vrm").write_bytes(b"safe-vrm")
    (asset_root / "LICENSE.txt").write_text("CC0", encoding="utf-8")
    archive = service.export_character_pack(original.id)
    with ZipFile(BytesIO(archive)) as bundle:
        assert set(bundle.namelist()) == {
            "asset_manifest.json",
            "character.json",
            "recipe.json",
            "assets/LICENSE.txt",
            "assets/model.vrm",
        }
        character_payload = json.loads(bundle.read("character.json"))
        assert character_payload["id"] == original.id
        assert "api_key" not in bundle.read("asset_manifest.json").decode("utf-8").lower()
        assert bundle.read("assets/model.vrm") == b"safe-vrm"

    escaped_file = tmp_path / "outside.vrm"
    escaped_file.write_bytes(b"do-not-export")
    service.update_character(
        original.id,
        asset_manifest={
            "redistribution_allowed": "yes",
            "license": "CC0-1.0",
            "model_path": str(escaped_file),
        },
    )
    with pytest.raises(ValueError, match="outside"):
        service.export_character_pack(original.id)

    service.update_character(
        original.id,
        asset_manifest={
            "redistribution_allowed": "no",
            "license": "restricted",
            "model_path": "model.vrm",
        },
    )
    with pytest.raises(ValueError, match="redistribution"):
        service.export_character_pack(original.id)

    assert service.delete_character(original.id) is True
    assert service.get_character(original.id) is None
    assert service.get_character(duplicate.id) is not None
    assert not asset_root.exists()


def test_character_export_rejects_credential_shaped_manifest_keys(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = CharacterService(repository)
    character = service.create_character(name="Unsafe")
    repository.upsert_character(
        character.model_copy(
            update={
                "asset_manifest": {
                    "redistribution_allowed": "yes",
                    "api_key": "must-never-export",
                }
            }
        )
    )

    with pytest.raises(ValueError, match="credential"):
        service.export_character_pack(character.id)


def test_provider_partial_update_rotates_key_without_returning_plaintext(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider_registry_module,
        "_default_host_resolver",
        lambda hostname: ("8.8.8.8",),
    )
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    vault.initialize("provider-service-secret")
    service = ProviderRegistryService(repository, vault)

    created = service.save_connection(
        provider="openai-compatible",
        label="Initial",
        api_key="old-plain-key",
        base_url="https://old.example/v1",
    )
    connection_id = created["id"]
    assert "old-plain-key" not in json.dumps(created, default=str)

    relabeled = service.update_connection(connection_id, label="Renamed")
    assert relabeled["label"] == "Renamed"
    assert relabeled["base_url"] == "https://old.example/v1"
    assert vault.get_provider_secret(connection_id) == "old-plain-key"

    rotated = service.update_connection(connection_id, api_key="new-plain-key", base_url=None)
    assert rotated["base_url"] is None
    assert vault.get_provider_secret(connection_id) == "new-plain-key"
    assert "new-plain-key" not in json.dumps(rotated, default=str)
    assert "api_key" not in rotated

    fetched = service.get_connection(connection_id)
    assert fetched == rotated
    assert service.delete_connection(connection_id) is True
    assert repository.get_provider_connection(connection_id) is None
