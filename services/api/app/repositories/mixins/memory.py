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


class MemoryMixin:
    def list_memory_items(self, space_id: str) -> list[MemoryItem]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM memory_items WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_memory(row) for row in rows]

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
                """SELECT * FROM review_cards
                   WHERE space_id = ? AND kind = 'flashcard' AND source_lesson_id IS NULL
                   ORDER BY updated_at DESC""",
                (space_id,),
            ).fetchall()
        return [self._row_to_review(row) for row in rows]

    def list_session_review_items(self, session_id: str) -> list[ReviewItem]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM review_cards
                WHERE legacy_source_session_id = ? AND kind = 'flashcard'
                ORDER BY updated_at DESC
                """,
                (session_id,),
            ).fetchall()
        return [self._row_to_review(row) for row in rows]

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
                "prompt": row["front"],
                "answer": row["back"],
                "due_at": row["due_at"],
                "status": row["state"],
                "source_session_id": row["legacy_source_session_id"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
