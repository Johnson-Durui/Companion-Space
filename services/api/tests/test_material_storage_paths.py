from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from uuid import uuid4

import pytest

from app.models.domain import IngestionJob
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService


def _local_settings(isolated_settings):
    return isolated_settings.model_copy(
        update={
            "embedding_provider": "local_hybrid",
            "reranker_provider": "local",
        }
    )


def _expected_storage_path(*, space_id: str, material_id: str) -> str:
    return f"spaces/{space_id}/materials/{material_id}.md"


def _stored_file(settings, storage_path: str) -> Path:
    return settings.storage_root.joinpath(*PurePosixPath(storage_path).parts)


def test_new_material_storage_path_is_portable_and_resolves_inside_storage_root(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Portable paths")

    material, job = service.ingest_note(
        space_id=space.id,
        title="Portable note",
        content="This file must survive a storage-root move.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)

    expected = _expected_storage_path(space_id=space.id, material_id=material.id)
    stored = repository.get_material(material.id)
    assert stored is not None
    assert stored.storage_path == expected
    assert not Path(stored.storage_path).is_absolute()
    assert "\\" not in stored.storage_path
    assert service.resolve_material_path(stored) == _stored_file(
        settings,
        expected,
    ).resolve()
    assert service.resolve_material_path(stored).read_text(encoding="utf-8").startswith(
        "This file must survive"
    )
    service.close()


def test_relative_material_path_survives_a_storage_root_move(
    isolated_settings,
    tmp_path: Path,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Move the root")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Moveable note",
        content="The database key must not contain the original root.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    stored = repository.get_material(material.id)
    assert stored is not None
    original_file = _stored_file(settings, stored.storage_path)
    assert original_file.is_file()
    service.close()
    with repository.connection() as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()

    moved_root = tmp_path / "moved-storage"
    shutil.copytree(settings.storage_root, moved_root)
    moved_settings = settings.model_copy(
        update={"object_storage_path": str(moved_root)}
    )
    moved_repository = SQLiteRepository(moved_settings)
    moved_service = StudySpaceService(moved_settings, moved_repository)
    moved_material = moved_repository.get_material(material.id)

    assert moved_material is not None
    assert moved_material.storage_path == stored.storage_path
    moved_file = _stored_file(moved_settings, moved_material.storage_path)
    assert moved_service.resolve_material_path(moved_material) == moved_file.resolve()
    assert moved_file.read_text(encoding="utf-8").startswith("The database key")
    assert moved_service.delete_material(
        space_id=space.id,
        material_id=material.id,
    )
    assert not moved_file.exists()
    assert original_file.exists()
    moved_service.close()


@pytest.mark.parametrize(
    "legacy_path_template",
    [
        "/Users/previous/Desktop/companion/storage/{posix}",
        "C:\\Companion-Space\\storage\\{windows}",
        "/app/storage/{posix}",
    ],
    ids=["macos", "windows", "docker"],
)
def test_startup_rebases_recognized_legacy_absolute_paths_before_retry(
    isolated_settings,
    legacy_path_template: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Moved storage")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Moved note",
        content="The migrated material remains indexable.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    service.close()

    expected = _expected_storage_path(space_id=space.id, material_id=material.id)
    legacy_path = legacy_path_template.format(
        posix=expected,
        windows=expected.replace("/", "\\"),
    )
    repository.upsert_material(material.model_copy(update={"storage_path": legacy_path}))

    migrated_repository = SQLiteRepository(settings)
    migrated_service = StudySpaceService(settings, migrated_repository)
    migrated = migrated_repository.get_material(material.id)
    assert migrated is not None
    assert migrated.storage_path == expected
    assert migrated_service.resolve_material_path(migrated) == (
        settings.storage_root / expected
    ).resolve()

    now = datetime.now(timezone.utc)
    failed_job = IngestionJob(
        id=str(uuid4()),
        space_id=space.id,
        material_id=material.id,
        status="failed",
        error_message="synthetic pre-migration failure",
        created_at=now,
        updated_at=now,
    )
    migrated_repository.upsert_ingestion_job(failed_job)
    _, retry_job = migrated_service.retry_material(
        space_id=space.id,
        material_id=material.id,
    )
    completed = migrated_service.wait_for_ingestion(retry_job.id, timeout_seconds=2.0)
    assert completed.status == "completed"
    migrated_service.close()


def test_legacy_path_migration_is_idempotent(isolated_settings) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Idempotent migration")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Idempotent note",
        content="Migrate this path exactly once.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    service.close()

    expected = _expected_storage_path(space_id=space.id, material_id=material.id)
    repository.upsert_material(
        material.model_copy(
            update={"storage_path": f"/app/storage/{expected}"}
        )
    )
    migrated_repository = SQLiteRepository(settings)

    migrated = migrated_repository.get_material(material.id)
    assert migrated is not None
    assert migrated.storage_path == expected
    assert migrated_repository.migrate_material_storage_paths() == 0


def test_legacy_path_migration_rolls_back_all_updates_on_failure(
    isolated_settings,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Atomic migration")
    created = [
        service.ingest_note(
            space_id=space.id,
            title=f"Atomic note {index}",
            content=f"Atomic migration content {index}.",
        )
        for index in range(2)
    ]
    for _, job in created:
        service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    service.close()

    materials = sorted((item[0] for item in created), key=lambda item: item.id)
    legacy_paths = {
        material.id: (
            f"/app/storage/{_expected_storage_path(space_id=space.id, material_id=material.id)}"
        )
        for material in materials
    }
    for material in materials:
        repository.upsert_material(
            material.model_copy(
                update={"storage_path": legacy_paths[material.id]}
            )
        )
    blocked_id = materials[1].id
    with repository.connection() as conn:
        conn.execute(
            f"""
            CREATE TRIGGER abort_material_path_migration
            BEFORE UPDATE OF storage_path ON materials
            WHEN OLD.id = '{blocked_id}'
            BEGIN
                SELECT RAISE(ABORT, 'synthetic migration failure');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="synthetic migration failure"):
        SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        stored_paths = dict(
            conn.execute(
                "SELECT id, storage_path FROM materials ORDER BY id ASC"
            ).fetchall()
        )
        conn.execute("DROP TRIGGER abort_material_path_migration")
    assert stored_paths == legacy_paths


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "../outside/material.md",
        "/tmp/not-the-configured-space/material.md",
        "C:\\outside\\not-the-configured-space\\material.md",
    ],
    ids=["relative-traversal", "foreign-posix", "foreign-windows"],
)
def test_startup_does_not_rebase_or_delete_unrecognized_paths(
    isolated_settings,
    tmp_path: Path,
    unsafe_path: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Unsafe path")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Unsafe note",
        content="Canonical material content.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    service.close()

    outside = tmp_path / "must-survive.md"
    outside.write_text("external content", encoding="utf-8")
    recorded_path = str(outside) if unsafe_path.startswith("/tmp/") else unsafe_path
    repository.upsert_material(material.model_copy(update={"storage_path": recorded_path}))

    migrated_repository = SQLiteRepository(settings)
    migrated_service = StudySpaceService(settings, migrated_repository)
    stored = migrated_repository.get_material(material.id)
    assert stored is not None
    assert stored.storage_path == recorded_path
    with pytest.raises(ValueError, match="outside"):
        migrated_service.delete_material(space_id=space.id, material_id=material.id)
    assert outside.read_text(encoding="utf-8") == "external content"
    assert migrated_repository.get_material(material.id) is not None
    migrated_service.close()


@pytest.mark.parametrize(
    "variant",
    ["wrong-space", "wrong-material", "parent-segment"],
)
def test_material_identity_mismatch_never_reads_or_deletes_another_path(
    isolated_settings,
    variant: str,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Identity boundary")
    other_space = service.create_space(name="Other identity boundary")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Identity note",
        content="This canonical file must survive.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    expected = _expected_storage_path(space_id=space.id, material_id=material.id)
    canonical = _stored_file(settings, expected)
    wrong_relative_paths = {
        "wrong-space": _expected_storage_path(
            space_id=other_space.id,
            material_id=material.id,
        ),
        "wrong-material": _expected_storage_path(
            space_id=space.id,
            material_id=str(uuid4()),
        ),
        "parent-segment": (
            f"spaces/{space.id}/materials/../materials/{material.id}.md"
        ),
    }
    recorded_path = f"/app/storage/{wrong_relative_paths[variant]}"
    repository.upsert_material(
        material.model_copy(update={"storage_path": recorded_path})
    )
    service.close()

    migrated_repository = SQLiteRepository(settings)
    migrated_service = StudySpaceService(settings, migrated_repository)
    corrupted = migrated_repository.get_material(material.id)
    assert corrupted is not None
    assert corrupted.storage_path == recorded_path
    with pytest.raises(ValueError, match="outside"):
        migrated_service.resolve_material_path(corrupted)
    with pytest.raises(ValueError, match="outside"):
        migrated_service.delete_material(
            space_id=space.id,
            material_id=material.id,
        )
    assert canonical.read_text(encoding="utf-8") == "This canonical file must survive."
    assert migrated_repository.get_material(material.id) is not None
    migrated_service.close()


def test_material_resolver_rejects_symlinked_file(isolated_settings, tmp_path: Path) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Symlink path")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Symlink note",
        content="Canonical material content.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)

    outside = tmp_path / "outside.md"
    outside.write_text("external content", encoding="utf-8")
    canonical = settings.storage_root / _expected_storage_path(
        space_id=space.id,
        material_id=material.id,
    )
    canonical.unlink()
    try:
        canonical.symlink_to(outside)
    except OSError as exc:  # pragma: no cover - depends on host symlink policy
        service.close()
        pytest.skip(f"Symlinks are unavailable: {exc}")

    stored = repository.get_material(material.id)
    assert stored is not None
    with pytest.raises(ValueError, match="outside"):
        service.resolve_material_path(stored)
    with pytest.raises(ValueError, match="outside"):
        service.delete_material(space_id=space.id, material_id=material.id)
    assert outside.read_text(encoding="utf-8") == "external content"
    service.close()


def test_material_resolver_rejects_symlinked_parent_directory(
    isolated_settings,
    tmp_path: Path,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Symlinked material directory")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Directory symlink note",
        content="External directory content must survive.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    stored = repository.get_material(material.id)
    assert stored is not None
    material_dir = _stored_file(settings, stored.storage_path).parent
    outside_dir = tmp_path / "outside-materials"
    material_dir.rename(outside_dir)
    try:
        material_dir.symlink_to(outside_dir, target_is_directory=True)
    except OSError as exc:  # pragma: no cover - depends on host symlink policy
        outside_dir.rename(material_dir)
        service.close()
        pytest.skip(f"Symlinks are unavailable: {exc}")

    with pytest.raises(ValueError, match="outside"):
        service.resolve_material_path(stored)
    with pytest.raises(ValueError, match="outside"):
        service.delete_material(space_id=space.id, material_id=material.id)
    outside_file = outside_dir / Path(stored.storage_path).name
    assert outside_file.read_text(encoding="utf-8") == (
        "External directory content must survive."
    )
    service.close()


def test_material_delete_restores_staged_file_when_repository_delete_fails(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _local_settings(isolated_settings)
    repository = SQLiteRepository(settings)
    service = StudySpaceService(settings, repository)
    space = service.create_space(name="Delete rollback")
    material, job = service.ingest_note(
        space_id=space.id,
        title="Rollback note",
        content="Restore this file after a failed database delete.",
    )
    service.wait_for_ingestion(job.id, timeout_seconds=2.0)
    stored = repository.get_material(material.id)
    assert stored is not None
    stored_file = _stored_file(settings, stored.storage_path)
    original_delete = repository.delete_material

    def fail_delete(*, space_id: str, material_id: str) -> bool:
        _ = (space_id, material_id)
        raise RuntimeError("synthetic repository failure")

    monkeypatch.setattr(repository, "delete_material", fail_delete)
    with pytest.raises(RuntimeError, match="synthetic repository failure"):
        service.delete_material(space_id=space.id, material_id=material.id)

    assert stored_file.read_text(encoding="utf-8").startswith("Restore this file")
    assert repository.get_material(material.id) is not None
    assert list(stored_file.parent.glob(".deleting-*")) == []

    monkeypatch.setattr(repository, "delete_material", original_delete)
    assert service.delete_material(space_id=space.id, material_id=material.id)
    assert not stored_file.exists()
    assert repository.get_material(material.id) is None
    assert list(stored_file.parent.glob(".deleting-*")) == []
    service.close()
