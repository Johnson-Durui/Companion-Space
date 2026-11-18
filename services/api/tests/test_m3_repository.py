from __future__ import annotations

from support_legacy_records import seed_session, seed_memory, seed_review

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import Settings
from app.models.domain import (
    Chunk,
    MemoryItem,
    MemoryStatus,
    Material,
    MaterialKind,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    ReviewStatus,
    SessionRecord,
    SessionState,
    StudySpace,
)
from app.rag.embeddings import extract_terms
from app.services.repository import CURRENT_SCHEMA_VERSION, SQLiteRepository


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _space(*, space_id: str | None = None) -> StudySpace:
    now = _now()
    return StudySpace(
        id=space_id or str(uuid4()),
        name="Repo Space",
        topic="repo",
        goal="test",
        created_at=now,
        updated_at=now,
    )


def _material(space_id: str, *, material_id: str | None = None) -> Material:
    now = _now()
    return Material(
        id=material_id or str(uuid4()),
        space_id=space_id,
        title="Repo Material",
        kind=MaterialKind.note,
        filename="repo.md",
        storage_path=f"/tmp/{material_id or 'repo'}.md",
        chunk_count=0,
        created_at=now,
        updated_at=now,
    )


def _chunk(space_id: str, material_id: str, content: str, *, title: str = "Repo Material") -> Chunk:
    return Chunk(
        id=str(uuid4()),
        space_id=space_id,
        material_id=material_id,
        title=title,
        locator="section #1",
        content=content,
        sparse_terms=list(dict.fromkeys(extract_terms(content)))[:120],
        dense_vector={},
        metadata={"section": "section #1", "kind": "note"},
        created_at=_now(),
    )


def test_repository_backfills_existing_chunks_into_fts(tmp_path: Path) -> None:
    settings = Settings(object_storage_path=str(tmp_path / "storage"))
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    db_path = settings.metadata_db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    now = _now().isoformat()
    space_id = str(uuid4())
    material_id = str(uuid4())
    chunk_id = str(uuid4())

    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE study_spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                topic TEXT NOT NULL,
                goal TEXT NOT NULL,
                default_character_pack_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE materials (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                title TEXT NOT NULL,
                kind TEXT NOT NULL,
                filename TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE chunks (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                material_id TEXT NOT NULL,
                title TEXT NOT NULL,
                locator TEXT NOT NULL,
                content TEXT NOT NULL,
                sparse_terms TEXT NOT NULL,
                dense_vector TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO study_spaces(id, name, topic, goal, default_character_pack_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (space_id, "Backfill", "math", "roots", None, now, now),
        )
        conn.execute(
            "INSERT INTO materials(id, space_id, title, kind, filename, storage_path, chunk_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (material_id, space_id, "Quadratics", "note", "quadratics.md", "/tmp/quadratics.md", 1, now, now),
        )
        conn.execute(
            "INSERT INTO chunks(id, space_id, material_id, title, locator, content, sparse_terms, dense_vector, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                chunk_id,
                space_id,
                material_id,
                "Quadratics",
                "section #1",
                "Quadratic equations use the discriminant to classify roots.",
                '["discriminant","roots"]',
                "{}",
                "{}",
                now,
            ),
        )

    repository = SQLiteRepository(settings)
    hits = repository.search_chunks_fts(space_id=space_id, query="discriminant roots", limit=5)

    assert [hit.id for hit in hits] == [chunk_id]
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION


def test_repository_fts_is_space_scoped_and_cleans_up_on_delete(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    first_space = _space()
    second_space = _space()
    repository.upsert_space(first_space)
    repository.upsert_space(second_space)

    first_material = _material(first_space.id)
    second_material = _material(second_space.id)
    repository.upsert_material(first_material)
    repository.upsert_material(second_material)
    repository.replace_chunks_for_material(
        first_material.id,
        [_chunk(first_space.id, first_material.id, "Discriminant roots explain quadratic behavior.")],
    )
    repository.replace_chunks_for_material(
        second_material.id,
        [_chunk(second_space.id, second_material.id, "Trade routes moved silk across Eurasia.")],
    )

    first_hits = repository.search_chunks_fts(space_id=first_space.id, query="discriminant roots", limit=5)
    second_hits = repository.search_chunks_fts(space_id=second_space.id, query="discriminant roots", limit=5)

    assert len(first_hits) == 1
    assert first_hits[0].space_id == first_space.id
    assert second_hits == []

    assert repository.delete_material(space_id=first_space.id, material_id=first_material.id) is True
    assert repository.search_chunks_fts(space_id=first_space.id, query="discriminant roots", limit=5) == []


def test_upsert_space_does_not_delete_space_scoped_data_on_update(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    now = _now()
    space = StudySpace(
        id=str(uuid4()),
        name="Original Space",
        topic="algorithms",
        goal="understand binary search",
        created_at=now,
        updated_at=now,
    )
    repository.upsert_space(space)

    material = _material(space.id)
    repository.upsert_material(material)

    connection = repository.upsert_provider_connection(
        ProviderConnection(
            id=str(uuid4()),
            provider="mock",
            label="Mock",
            capabilities=[ProviderCapability.chat_llm],
            created_at=now,
            updated_at=now,
        )
    )
    repository.upsert_model_assignment(
        ModelAssignment(
            id=str(uuid4()),
            space_id=space.id,
            capability=ProviderCapability.chat_llm,
            provider_connection_id=connection.id,
            model_name="mock-companion-v1",
            created_at=now,
            updated_at=now,
        )
    )
    session = seed_session(
        repository,
        SessionRecord(
            id=str(uuid4()),
            space_id=space.id,
            character_pack_id=None,
            state=SessionState.idle,
            created_at=now,
            updated_at=now,
        )
    )
    seed_memory(
        repository,
        MemoryItem(
            id=str(uuid4()),
            space_id=space.id,
            content="用户总是先担心边界条件。",
            status=MemoryStatus.candidate,
            source_session_id=session.id,
            created_at=now,
            updated_at=now,
        )
    )
    seed_review(
        repository,
        ReviewItem(
            id=str(uuid4()),
            space_id=space.id,
            prompt="为什么二分查找要求单调？",
            answer="因为判断结果必须能稳定缩小边界。",
            status=ReviewStatus.pending,
            source_session_id=session.id,
            created_at=now,
            updated_at=now,
        )
    )

    updated_space = repository.upsert_space(
        space.model_copy(
            update={
                "name": "Updated Space",
                "default_character_pack_id": "character-1",
                "updated_at": _now(),
            }
        )
    )

    assert updated_space.name == "Updated Space"
    assert repository.get_space(space.id).default_character_pack_id == "character-1"
    assert len(repository.list_materials(space.id)) == 1
    assert len(repository.list_model_assignments(space.id)) == 1
    assert len(repository.list_sessions(space.id)) == 1
    assert len(repository.list_memory_items(space.id)) == 1
    assert len(repository.list_review_items(space.id)) == 1
