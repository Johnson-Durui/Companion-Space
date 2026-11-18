from __future__ import annotations

# ruff: noqa: F401
import hashlib
import hmac
import json
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from app.core.errors import ResourceNotFoundError
from app.core.config import Settings
from app.models.domain import (
    CharacterPack,
    Chunk,
    CompanionTurn,
    LearningArtifactsStatus,
    Material,
    MaterialKind,
    MemoryItem,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    SessionRecord,
    SessionState,
    StudySpace,
    TtsPlaybackPolicy,
    TurnRole,
)
from app.rag.embeddings import extract_terms, normalize_text
from app.repositories.mixins.common import (
    CharacterInUseError,
    OwnerSession,
    RealtimeTicket,
    _from_db,
    _fts_sparse_terms_expression,
    _to_db,
    utcnow,
)
from app.repositories.migrations import (
    CURRENT_SCHEMA_VERSION,
    apply_pending_migrations,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
)
from app.services.material_storage import canonicalize_legacy_material_storage_key


class RagWriteMixin:
    def upsert_material(self, material: Material) -> Material:
        with self.connection() as conn:
            self._upsert_material_with_conn(conn, material)
        return material

    def delete_material(self, *, space_id: str, material_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                "DELETE FROM materials WHERE id = ? AND space_id = ?",
                (material_id, space_id),
            )
        return cursor.rowcount == 1

    def replace_chunks_for_material(self, material_id: str, chunks: list[Chunk]) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM chunks WHERE material_id = ?", (material_id,))
            self._insert_chunks_with_conn(conn, chunks)

    def _insert_chunks_with_conn(self, conn: sqlite3.Connection, chunks: list[Chunk]) -> None:
        for chunk in chunks:
            conn.execute(
                """
                INSERT INTO chunks
                (id, space_id, material_id, title, locator, content, sparse_terms, dense_vector, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk.id,
                    chunk.space_id,
                    chunk.material_id,
                    chunk.title,
                    chunk.locator,
                    chunk.content,
                    json.dumps(chunk.sparse_terms, ensure_ascii=False),
                    json.dumps(chunk.dense_vector, ensure_ascii=False),
                    json.dumps(chunk.metadata, ensure_ascii=False),
                    _to_db(chunk.created_at),
                ),
            )

    def _upsert_material_with_conn(self, conn: sqlite3.Connection, material: Material) -> None:
        conn.execute(
            """
            INSERT INTO materials
            (id, space_id, title, kind, filename, storage_path, chunk_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                space_id = excluded.space_id,
                title = excluded.title,
                kind = excluded.kind,
                filename = excluded.filename,
                storage_path = excluded.storage_path,
                chunk_count = excluded.chunk_count,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            """,
            (
                material.id,
                material.space_id,
                material.title,
                material.kind.value,
                material.filename,
                material.storage_path,
                material.chunk_count,
                _to_db(material.created_at),
                _to_db(material.updated_at),
            ),
        )

    @staticmethod
    def _escape_fts_phrase(text: str) -> str:
        return text.replace('"', '""')

    def _build_fts_query(self, query: str) -> str:
        normalized = normalize_text(query)
        phrases: list[str] = []
        if normalized:
            phrases.append(f'"{self._escape_fts_phrase(normalized)}"')
        for term in dict.fromkeys(extract_terms(query)):
            if not term:
                continue
            if term.isascii() and len(term) < 3:
                continue
            phrases.append(f'"{self._escape_fts_phrase(term)}"')
            if len(phrases) >= 16:
                break
        return " OR ".join(phrases)
