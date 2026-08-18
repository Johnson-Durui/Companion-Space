from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

from app.api.deps import get_container


LEGACY_CONTENT = "# Legacy note\n\nA migration-only phrase."


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _seed_legacy_document(settings, *, document_id: str | None = None) -> tuple[str, tuple[Path, Path, Path]]:
    document_id = document_id or str(uuid4())
    settings.knowledge_base_documents_dir.mkdir(parents=True, exist_ok=True)
    settings.knowledge_base_manifests_dir.mkdir(parents=True, exist_ok=True)

    source_path = settings.knowledge_base_documents_dir / f"{document_id}.md"
    manifest_path = settings.knowledge_base_manifests_dir / f"{document_id}.chunks.json"
    registry_path = settings.knowledge_base_registry_path

    source_path.write_text(LEGACY_CONTENT, encoding="utf-8")
    manifest_path.write_text(
        json.dumps(
            [
                {
                    "id": str(uuid4()),
                    "document_id": document_id,
                    "content": LEGACY_CONTENT,
                    "metadata": {
                        "source_type": "notes",
                        "title": "Legacy note",
                        "subject": None,
                        "year": None,
                        "chapter": None,
                        "article_no": None,
                        "question_no": None,
                        "page_range": None,
                        "importance": "medium",
                    },
                    "sparse_terms": ["migration"],
                    "dense_vector": {"migration": 1.0},
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
                    "filename": "legacy-note.md",
                    "title": "Legacy note",
                    "source_type": "notes",
                    "subject": None,
                    "year": None,
                    "storage_path": "/outside/ignored.md",
                    "chunk_manifest_path": "/outside/ignored.chunks.json",
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


def test_legacy_import_routes_require_owner_session(client) -> None:
    list_response = client.get("/api/v1/legacy-knowledge-base")
    import_response = client.post(
        "/api/v1/spaces/space-id/legacy-knowledge-base/import",
        json={"document_id": "doc-id"},
    )

    assert list_response.status_code == 401
    assert list_response.json() == {"detail": "Owner session required"}
    assert import_response.status_code == 401
    assert import_response.json() == {"detail": "Owner session required"}


def test_legacy_import_api_lists_metadata_only_and_preserves_legacy_files(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    headers = _auth_headers(owner_token)
    document_id, legacy_paths = _seed_legacy_document(isolated_settings)
    before_hashes = {path: _sha256(path) for path in legacy_paths}

    listed = client.get("/api/v1/legacy-knowledge-base", headers=headers)
    assert listed.status_code == 200
    assert listed.json() == {
        "items": [
            {
                "document_id": document_id,
                "filename": "legacy-note.md",
                "title": "Legacy note",
                "source_type": "notes",
                "chunk_count": 1,
                "importable": True,
                "issue": None,
            }
        ]
    }
    assert LEGACY_CONTENT not in json.dumps(listed.json(), ensure_ascii=False)

    created = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": "Target", "topic": "migration", "goal": "import legacy data"},
    )
    assert created.status_code == 201
    space_id = created.json()["id"]

    imported = client.post(
        f"/api/v1/spaces/{space_id}/legacy-knowledge-base/import",
        headers=headers,
        json={"document_id": document_id},
    )
    assert imported.status_code == 201
    payload = imported.json()
    assert payload["space_id"] == space_id
    assert payload["document_id"] == document_id
    assert payload["filename"] == "legacy-note.md"
    assert payload["title"] == "Legacy note"
    assert payload["kind"] == "markdown"
    assert payload["chunk_count"] == 0
    assert payload["status"] == "queued"
    assert payload["already_imported"] is False
    assert LEGACY_CONTENT not in json.dumps(payload, ensure_ascii=False)

    container = get_container()
    job = next(
        job
        for job in container.repository.list_ingestion_jobs(space_id)
        if job.material_id == payload["material_id"]
    )
    completed = container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)
    material = container.repository.get_material(payload["material_id"])

    assert completed.status == "completed"
    assert material is not None
    assert container.spaces.resolve_material_path(material).is_relative_to(
        (isolated_settings.spaces_root / space_id / "materials").resolve()
    )
    assert {path: _sha256(path) for path in legacy_paths} == before_hashes
