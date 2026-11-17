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


class OwnerSessionMixin:
    def put_owner_session(
        self,
        *,
        session_id: str,
        token: str,
        ttl_seconds: int | None = None,
    ) -> OwnerSession:
        created_at = utcnow()
        expires_at = (
            created_at + timedelta(seconds=ttl_seconds)
            if ttl_seconds is not None
            else created_at + timedelta(hours=self.settings.owner_session_ttl_hours)
        )
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO owner_sessions
                    (id, token_hash, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    session_id,
                    token_hash,
                    _to_db(expires_at),
                    _to_db(created_at),
                ),
            )
        return OwnerSession(
            id=session_id,
            token_hash=token_hash,
            expires_at=expires_at,
            created_at=created_at,
        )

    def get_owner_session(self, token: str) -> OwnerSession | None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id, token_hash, expires_at, created_at FROM owner_sessions WHERE token_hash = ? AND device_id IS NULL",
                (token_hash,),
            ).fetchone()
        return self._owner_session_from_row(row)

    def get_owner_session_by_id(self, session_id: str) -> OwnerSession | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id, token_hash, expires_at, created_at FROM owner_sessions WHERE id = ? AND device_id IS NULL",
                (session_id,),
            ).fetchone()
        return self._owner_session_from_row(row)

    def _owner_session_from_row(self, row: sqlite3.Row | None) -> OwnerSession | None:
        if not row:
            return None
        session = OwnerSession(
            id=row["id"],
            token_hash=row["token_hash"],
            expires_at=_from_db(row["expires_at"]) or utcnow(),
            created_at=_from_db(row["created_at"]) or utcnow(),
        )
        if session.expires_at <= utcnow():
            self.delete_owner_session_by_id(session.id)
            return None
        return session

    def delete_owner_session(self, token: str) -> None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute("DELETE FROM owner_sessions WHERE token_hash = ?", (token_hash,))

    def delete_owner_session_by_id(self, session_id: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM owner_sessions WHERE id = ?", (session_id,))

    def delete_all_owner_sessions(self) -> int:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM owner_sessions")
        return cursor.rowcount

    def list_owner_session_hashes(self) -> set[str]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT token_hash FROM owner_sessions WHERE device_id IS NULL"
            ).fetchall()
        return {row["token_hash"] for row in rows}
