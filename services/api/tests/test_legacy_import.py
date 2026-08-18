from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.services.legacy_import import LegacyKnowledgeImportError, LegacyKnowledgeImporter
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService


LEGACY_CONTENT = "# Synthetic legacy note\n\nA deliberately unique migration-test phrase."
IGNORED_OUTSIDE_CONTENT = "This registry path must never be read."


@pytest.fixture()
def isolated_settings(tmp_path: Path) -> Settings:
    return Settings(
        object_storage_path=str(tmp_path / "storage"),
        embedding_provider="local_hybrid",
        reranker_provider="local",
    )


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _build_services(isolated_settings):
    settings = isolated_settings
    repository = SQLiteRepository(settings)
    spaces = StudySpaceService(settings, repository)
    importer = LegacyKnowledgeImporter(settings, spaces)
    return settings, repository, spaces, importer


def _seed_legacy_document(
    settings,
    *,
    document_id: str | None = None,
    filename: str = "legacy-note.md",
    title: str = "Synthetic legacy note",
    source_type: str = "statutes",
    content: str = LEGACY_CONTENT,
    recorded_storage_path: str = "/untrusted/old/location.md",
    recorded_manifest_path: str = "/untrusted/old/location.chunks.json",
    source_document_id: str | None = None,
) -> tuple[str, tuple[Path, Path, Path]]:
    document_id = document_id or str(uuid4())
    source_document_id = source_document_id or document_id
    suffix = Path(filename).suffix.lower()
    settings.knowledge_base_documents_dir.mkdir(parents=True, exist_ok=True)
    settings.knowledge_base_manifests_dir.mkdir(parents=True, exist_ok=True)

    source_path = settings.knowledge_base_documents_dir / f"{source_document_id}{suffix}"
    manifest_path = settings.knowledge_base_manifests_dir / f"{source_document_id}.chunks.json"
    registry_path = settings.knowledge_base_registry_path
    source_path.write_text(content, encoding="utf-8")
    manifest_path.write_text(
        json.dumps(
            [
                {
                    "id": str(uuid4()),
                    "document_id": document_id,
                    "content": content,
                    "metadata": {
                        "source_type": source_type,
                        "title": title,
                        "subject": None,
                        "year": None,
                        "chapter": None,
                        "article_no": None,
                        "question_no": None,
                        "page_range": None,
                        "importance": "medium",
                    },
                    "sparse_terms": ["synthetic"],
                    "dense_vector": {"synthetic": 1.0},
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    registry_path.write_text(
        json.dumps(
            [
                {
                    "id": document_id,
                    "filename": filename,
                    "title": title,
                    "source_type": source_type,
                    "subject": None,
                    "year": None,
                    "storage_path": recorded_storage_path,
                    "chunk_manifest_path": recorded_manifest_path,
                    "chunk_count": 1,
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return document_id, (source_path, manifest_path, registry_path)


def test_constructor_and_empty_scan_do_not_create_legacy_layout(isolated_settings) -> None:
    settings, _, _, importer = _build_services(isolated_settings)
    legacy_root = settings.knowledge_base_root

    assert not legacy_root.exists()
    assert importer.list_candidates() == []
    assert not legacy_root.exists()


def test_candidates_are_metadata_only_and_allow_unknown_source_type(isolated_settings) -> None:
    settings, _, _, importer = _build_services(isolated_settings)
    outside_path = settings.storage_root.parent / "outside-source.md"
    outside_path.write_text(IGNORED_OUTSIDE_CONTENT, encoding="utf-8")
    document_id, _ = _seed_legacy_document(
        settings,
        source_type="statutes",
        recorded_storage_path=str(outside_path),
    )

    candidates = importer.list_candidates()

    assert len(candidates) == 1
    assert candidates[0].document_id == document_id
    assert candidates[0].source_type == "statutes"
    assert candidates[0].importable is True
    payload = json.dumps(asdict(candidates[0]), ensure_ascii=False)
    assert LEGACY_CONTENT not in payload
    assert str(outside_path) not in payload
    assert "storage_path" not in payload
    assert "chunk_manifest_path" not in payload
    assert "dense_vector" not in payload
    assert "sparse_terms" not in payload


def test_import_uses_canonical_source_and_preserves_legacy_files(isolated_settings) -> None:
    settings, repository, spaces, importer = _build_services(isolated_settings)
    outside_path = settings.storage_root.parent / "outside-source.md"
    outside_path.write_text(IGNORED_OUTSIDE_CONTENT, encoding="utf-8")
    document_id, legacy_paths = _seed_legacy_document(
        settings,
        recorded_storage_path=str(outside_path),
    )
    before_hashes = {path: _sha256(path) for path in legacy_paths}
    space_a = spaces.create_space(name="Space A")
    space_b = spaces.create_space(name="Space B")

    result = importer.import_document(space_id=space_b.id, document_id=document_id)
    completed_job = spaces.wait_for_ingestion(
        next(job.id for job in repository.list_ingestion_jobs(space_b.id) if job.material_id == result.material_id),
        timeout_seconds=2.0,
    )
    completed_material = repository.get_material(result.material_id)

    assert result.space_id == space_b.id
    assert result.document_id == document_id
    assert result.status == "queued"
    assert result.already_imported is False
    assert completed_job.status == "completed"
    assert completed_material is not None
    assert repository.list_materials(space_a.id) == []
    materials_b = repository.list_materials(space_b.id)
    assert len(materials_b) == 1
    assert materials_b[0].id == result.material_id
    assert spaces.resolve_material_path(completed_material).is_relative_to(
        (settings.spaces_root / space_b.id / "materials").resolve()
    )
    chunks_b = repository.list_chunks(space_b.id)
    assert chunks_b
    imported_content = "\n\n".join(chunk.content for chunk in chunks_b)
    assert "A deliberately unique migration-test phrase." in imported_content
    assert IGNORED_OUTSIDE_CONTENT not in imported_content
    assert {path: _sha256(path) for path in legacy_paths} == before_hashes
    result_payload = json.dumps(asdict(result), ensure_ascii=False)
    assert LEGACY_CONTENT not in result_payload
    assert str(settings.storage_root) not in result_payload
    assert "storage_path" not in result_payload
    assert "dense_vector" not in result_payload


def test_repeated_import_is_idempotent(isolated_settings) -> None:
    settings, repository, spaces, importer = _build_services(isolated_settings)
    document_id, _ = _seed_legacy_document(settings)
    space = spaces.create_space(name="Target")

    first = importer.import_document(space_id=space.id, document_id=document_id)
    completed_job = spaces.wait_for_ingestion(
        next(job.id for job in repository.list_ingestion_jobs(space.id) if job.material_id == first.material_id),
        timeout_seconds=2.0,
    )
    second = importer.import_document(space_id=space.id, document_id=document_id)

    assert first.material_id == second.material_id
    assert first.status == "queued"
    assert completed_job.status == "completed"
    assert second.already_imported is True
    assert second.status == "already_imported"
    assert len(repository.list_materials(space.id)) == 1


def test_import_rejects_unsafe_registry_identity_and_filename(isolated_settings) -> None:
    settings, _, spaces, importer = _build_services(isolated_settings)
    space = spaces.create_space(name="Target")
    unsafe_id = "../../outside"
    _seed_legacy_document(
        settings,
        document_id=unsafe_id,
        source_document_id=str(uuid4()),
    )

    with pytest.raises(LegacyKnowledgeImportError, match="valid UUID"):
        importer.list_candidates()
    with pytest.raises(LegacyKnowledgeImportError, match="valid UUID"):
        importer.import_document(space_id=space.id, document_id=unsafe_id)

    safe_id = str(uuid4())
    _seed_legacy_document(settings, document_id=safe_id, filename="../outside.md")
    with pytest.raises(LegacyKnowledgeImportError, match="base name"):
        importer.list_candidates()


def test_import_rejects_source_symlink_escaping_legacy_root(isolated_settings) -> None:
    settings, repository, spaces, importer = _build_services(isolated_settings)
    outside_path = settings.storage_root.parent / "outside-source.md"
    outside_path.write_text(IGNORED_OUTSIDE_CONTENT, encoding="utf-8")
    document_id, (source_path, _, _) = _seed_legacy_document(settings)
    source_path.unlink()
    try:
        source_path.symlink_to(outside_path)
    except OSError as exc:  # pragma: no cover - depends on host symlink policy
        if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
            pytest.skip(f"Symlinks require Windows Developer Mode: {exc}")
        raise
    space = spaces.create_space(name="Target")

    candidates = importer.list_candidates()
    assert candidates[0].importable is False
    assert candidates[0].issue == "source_outside_legacy_root"
    with pytest.raises(LegacyKnowledgeImportError, match="inside the legacy knowledge base"):
        importer.import_document(space_id=space.id, document_id=document_id)
    assert repository.list_materials(space.id) == []
    assert outside_path.read_text(encoding="utf-8") == IGNORED_OUTSIDE_CONTENT


def test_import_requires_an_existing_explicit_space(isolated_settings) -> None:
    settings, repository, _, importer = _build_services(isolated_settings)
    document_id, legacy_paths = _seed_legacy_document(settings)
    before_hashes = {path: _sha256(path) for path in legacy_paths}

    with pytest.raises(ValueError, match="Study space not found"):
        importer.import_document(space_id=str(uuid4()), document_id=document_id)

    assert repository.list_spaces() == []
    assert {path: _sha256(path) for path in legacy_paths} == before_hashes
