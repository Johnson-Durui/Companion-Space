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

    def create_material_with_job(
        self,
        *,
        material: Material,
        job: IngestionJob,
    ) -> tuple[Material, IngestionJob]:
        with self.connection() as conn:
            self._upsert_material_with_conn(conn, material)
            self._upsert_ingestion_job_with_conn(conn, job)
        return material, job

    def replace_chunks_for_material(self, material_id: str, chunks: list[Chunk]) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM chunks WHERE material_id = ?", (material_id,))
            self._insert_chunks_with_conn(conn, chunks)

    def upsert_ingestion_job(self, job: IngestionJob) -> IngestionJob:
        with self.connection() as conn:
            self._upsert_ingestion_job_with_conn(conn, job)
        return job

    def requeue_processing_ingestion_jobs(self) -> int:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE ingestion_jobs
                SET status = 'queued',
                    updated_at = ?
                WHERE status = 'processing'
                """,
                (_to_db(utcnow()),),
            )
        return cursor.rowcount

    def claim_ingestion_job(self, job_id: str) -> IngestionJob | None:
        now = utcnow()
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE ingestion_jobs
                SET status = 'processing',
                    error_message = NULL,
                    updated_at = ?
                WHERE id = ?
                  AND status = 'queued'
                """,
                (_to_db(now), job_id),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute("SELECT * FROM ingestion_jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_ingestion_job(row) if row else None

    def complete_ingestion(
        self,
        *,
        material: Material,
        job: IngestionJob,
        chunks: list[Chunk],
    ) -> tuple[Material, IngestionJob]:
        completed_job = job.model_copy(
            update={
                "status": "completed",
                "error_message": None,
                "updated_at": utcnow(),
            }
        )
        with self.connection() as conn:
            conn.execute("DELETE FROM chunks WHERE material_id = ?", (material.id,))
            self._insert_chunks_with_conn(conn, chunks)
            self._upsert_material_with_conn(conn, material)
            self._upsert_ingestion_job_with_conn(conn, completed_job)
        return material, completed_job

    def fail_ingestion_job(self, *, job_id: str, error_message: str) -> IngestionJob | None:
        now = utcnow()
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE ingestion_jobs
                SET status = 'failed',
                    error_message = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (error_message, _to_db(now), job_id),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute("SELECT * FROM ingestion_jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_ingestion_job(row) if row else None

    def create_retry_ingestion_job(
        self,
        *,
        failed_job_id: str,
        retry_job: IngestionJob,
    ) -> IngestionJob:
        queued_retry = retry_job.model_copy(
            update={
                "status": "queued",
                "error_message": None,
            }
        )
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM ingestion_jobs WHERE id = ?",
                (failed_job_id,),
            ).fetchone()
            if row is None:
                raise ValueError("Ingestion job not found")
            failed_job = self._row_to_ingestion_job(row)
            if failed_job.status != "failed":
                raise ValueError("Only failed ingestion jobs can be retried")
            if (
                failed_job.space_id != retry_job.space_id
                or failed_job.material_id != retry_job.material_id
            ):
                raise ValueError(
                    "Retry job must stay in the original space and material"
                )
            active = conn.execute(
                """
                SELECT 1
                FROM ingestion_jobs
                WHERE material_id = ?
                  AND status IN ('queued', 'processing')
                LIMIT 1
                """,
                (failed_job.material_id,),
            ).fetchone()
            if active is not None:
                raise ValueError("Material already has an active ingestion job")
            self._upsert_ingestion_job_with_conn(conn, queued_retry)
        return queued_retry

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

    def _upsert_ingestion_job_with_conn(self, conn: sqlite3.Connection, job: IngestionJob) -> None:
        conn.execute(
            """
            INSERT INTO ingestion_jobs
            (id, space_id, material_id, status, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                space_id = excluded.space_id,
                material_id = excluded.material_id,
                status = excluded.status,
                error_message = excluded.error_message,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            """,
            (
                job.id,
                job.space_id,
                job.material_id,
                job.status,
                job.error_message,
                _to_db(job.created_at),
                _to_db(job.updated_at),
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
