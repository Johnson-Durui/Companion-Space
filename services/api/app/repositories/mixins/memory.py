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


class MemoryMixin:
    def list_memory_items(self, space_id: str) -> list[MemoryItem]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM memory_items WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def upsert_memory_item(self, item: MemoryItem) -> MemoryItem:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO memory_items
                (id, space_id, content, status, sensitive, source_session_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    item.space_id,
                    item.content,
                    item.status.value,
                    int(item.sensitive),
                    item.source_session_id,
                    _to_db(item.created_at),
                    _to_db(item.updated_at),
                ),
            )
        return item

    def delete_memory_item(self, *, space_id: str, memory_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                "DELETE FROM memory_items WHERE id = ? AND space_id = ?",
                (memory_id, space_id),
            )
        return cursor.rowcount == 1

    def list_session_memory_items(self, session_id: str) -> list[MemoryItem]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM memory_items
                WHERE source_session_id = ?
                ORDER BY updated_at DESC
                """,
                (session_id,),
            ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def list_review_items(self, space_id: str) -> list[ReviewItem]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM review_items WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_review(row) for row in rows]

    def upsert_review_item(self, item: ReviewItem) -> ReviewItem:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO review_items
                (id, space_id, prompt, answer, due_at, status, source_session_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    item.space_id,
                    item.prompt,
                    item.answer,
                    _to_db(item.due_at),
                    item.status.value,
                    item.source_session_id,
                    _to_db(item.created_at),
                    _to_db(item.updated_at),
                ),
            )
        return item

    def delete_review_item(self, *, space_id: str, review_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                "DELETE FROM review_items WHERE id = ? AND space_id = ?",
                (review_id, space_id),
            )
        return cursor.rowcount == 1

    def list_session_review_items(self, session_id: str) -> list[ReviewItem]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM review_items
                WHERE source_session_id = ?
                ORDER BY updated_at DESC
                """,
                (session_id,),
            ).fetchall()
        return [self._row_to_review(row) for row in rows]

    def complete_session_generated_artifacts(
        self,
        *,
        session_id: str,
        generated_summary: str,
        memory_items: list[MemoryItem],
        review_items: list[ReviewItem],
        replace_generated_items: bool,
        updated_at: datetime,
    ) -> SessionRecord:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise ValueError("Session not found")

            session = self._row_to_session(row)
            for item in [*memory_items, *review_items]:
                if (
                    item.space_id != session.space_id
                    or item.source_session_id != session_id
                ):
                    raise ValueError(
                        "Generated artifacts must stay in their source session and space"
                    )

            if replace_generated_items:
                self._replace_session_generated_artifacts_with_conn(
                    conn,
                    session_id=session_id,
                    memory_items=memory_items,
                    review_items=review_items,
                )

            replace_summary = (
                not session.summary.strip()
                or session.summary.strip() == session.generated_summary.strip()
            )
            summary = generated_summary if replace_summary else session.summary
            conn.execute(
                """
                UPDATE sessions
                SET summary = ?,
                    generated_summary = ?,
                    artifacts_status = 'ready',
                    artifacts_error = NULL,
                    artifacts_updated_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    summary,
                    generated_summary,
                    _to_db(updated_at),
                    _to_db(updated_at),
                    session_id,
                ),
            )
            completed_row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(completed_row)

    def _replace_session_generated_artifacts_with_conn(
        self,
        conn: sqlite3.Connection,
        *,
        session_id: str,
        memory_items: list[MemoryItem],
        review_items: list[ReviewItem],
    ) -> None:
        conn.execute(
            """
            DELETE FROM memory_items
            WHERE source_session_id = ?
              AND status = 'candidate'
            """,
            (session_id,),
        )
        conn.execute(
            """
            DELETE FROM review_items
            WHERE source_session_id = ?
              AND status = 'pending'
            """,
            (session_id,),
        )
        if memory_items:
            conn.executemany(
                """
                INSERT INTO memory_items
                (id, space_id, content, status, sensitive, source_session_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.id,
                        item.space_id,
                        item.content,
                        item.status.value,
                        int(item.sensitive),
                        item.source_session_id,
                        _to_db(item.created_at),
                        _to_db(item.updated_at),
                    )
                    for item in memory_items
                ],
            )
        if review_items:
            conn.executemany(
                """
                INSERT INTO review_items
                (id, space_id, prompt, answer, due_at, status, source_session_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.id,
                        item.space_id,
                        item.prompt,
                        item.answer,
                        _to_db(item.due_at),
                        item.status.value,
                        item.source_session_id,
                        _to_db(item.created_at),
                        _to_db(item.updated_at),
                    )
                    for item in review_items
                ],
            )

    def _row_to_memory(self, row: sqlite3.Row) -> MemoryItem:
        return MemoryItem.model_validate(
            {
                "id": row["id"],
                "space_id": row["space_id"],
                "content": row["content"],
                "status": row["status"],
                "sensitive": bool(row["sensitive"]),
                "source_session_id": row["source_session_id"] if "source_session_id" in row.keys() else None,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    def _row_to_review(self, row: sqlite3.Row) -> ReviewItem:
        return ReviewItem.model_validate(
            {
                "id": row["id"],
                "space_id": row["space_id"],
                "prompt": row["prompt"],
                "answer": row["answer"],
                "due_at": row["due_at"],
                "status": row["status"],
                "source_session_id": row["source_session_id"] if "source_session_id" in row.keys() else None,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
