from __future__ import annotations

# ruff: noqa: F401
import hashlib
import hmac
import json
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.models.domain import (
    CharacterPack,
    Chunk,
    CompanionTurn,
    IngestionJob,
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
    _tts_playback_policy,
    utcnow,
)
from app.repositories.migrations import (
    CURRENT_SCHEMA_VERSION,
    apply_pending_migrations,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
)
from app.services.material_storage import canonicalize_legacy_material_storage_key


class RagReadMixin:
    def list_materials(self, space_id: str) -> list[Material]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM materials WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_material(row) for row in rows]

    def get_material(self, material_id: str) -> Material | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM materials WHERE id = ?", (material_id,)).fetchone()
        return self._row_to_material(row) if row else None

    def list_chunks(self, space_id: str) -> list[Chunk]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks WHERE space_id = ? ORDER BY created_at ASC",
                (space_id,),
            ).fetchall()
        return [self._row_to_chunk(row) for row in rows]

    def search_chunks_fts(self, *, space_id: str, query: str, limit: int) -> list[Chunk]:
        fts_query = self._build_fts_query(query)
        if not fts_query or limit <= 0:
            return []
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT c.*
                FROM chunks_fts
                JOIN chunks AS c ON c.id = chunks_fts.chunk_id
                WHERE chunks_fts.space_id = ?
                  AND chunks_fts MATCH ?
                  AND c.space_id = ?
                ORDER BY bm25(chunks_fts), c.created_at ASC
                LIMIT ?
                """,
                (space_id, fts_query, space_id, limit),
            ).fetchall()
        return [self._row_to_chunk(row) for row in rows]

    def get_ingestion_job(self, job_id: str) -> IngestionJob | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM ingestion_jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_ingestion_job(row) if row else None

    def list_ingestion_jobs(self, space_id: str) -> list[IngestionJob]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM ingestion_jobs WHERE space_id = ? ORDER BY updated_at DESC, created_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_ingestion_job(row) for row in rows]

    def list_pending_ingestion_jobs(
        self,
        *,
        limit: int | None = None,
    ) -> list[IngestionJob]:
        with self.connection() as conn:
            if limit is None:
                rows = conn.execute(
                    """
                    SELECT * FROM ingestion_jobs
                    WHERE status = 'queued'
                    ORDER BY updated_at ASC, created_at ASC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM ingestion_jobs
                    WHERE status = 'queued'
                    ORDER BY updated_at ASC, created_at ASC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
        return [self._row_to_ingestion_job(row) for row in rows]
