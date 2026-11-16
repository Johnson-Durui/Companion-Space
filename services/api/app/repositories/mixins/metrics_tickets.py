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
    PairingChallenge,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    SessionRecord,
    SessionState,
    StudySpace,
    TrustedDevice,
    TtsPlaybackPolicy,
    TurnRole,
)
from app.rag.embeddings import extract_terms, normalize_text
from app.repositories.mixins.common import (
    CharacterInUseError,
    OwnerPreferences,
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


class MetricsTicketMixin:
    def insert_local_metric_event(
        self,
        *,
        event_id: str,
        event_name: str,
        payload_json: str,
        occurred_at: datetime,
    ) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO local_metric_events(
                    id,
                    event_name,
                    payload_json,
                    occurred_at
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    event_id,
                    event_name,
                    payload_json,
                    _to_db(occurred_at),
                ),
            )

    def local_metric_event_exists(
        self,
        *,
        event_name: str,
        payload_json: str,
    ) -> bool:
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM local_metric_events
                WHERE event_name = ? AND payload_json = ?
                LIMIT 1
                """,
                (event_name, payload_json),
            ).fetchone()
        return row is not None

    def list_local_metric_event_rows(
        self,
        *,
        event_names: tuple[str, ...] | None = None,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        with self.connection() as conn:
            filters: list[str] = []
            params: list[object] = []
            if event_names:
                placeholders = ", ".join("?" for _ in event_names)
                filters.append(f"event_name IN ({placeholders})")
                params.extend(event_names)
            where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
            if limit is None:
                rows = conn.execute(
                    f"""
                    SELECT id, event_name, payload_json, occurred_at
                    FROM local_metric_events
                    {where_clause}
                    ORDER BY occurred_at ASC, rowid ASC
                    """,
                    params,
                ).fetchall()
            else:
                rows = conn.execute(
                    f"""
                    SELECT id, event_name, payload_json, occurred_at
                    FROM (
                        SELECT rowid, id, event_name, payload_json, occurred_at
                        FROM local_metric_events
                        {where_clause}
                        ORDER BY occurred_at DESC, rowid DESC
                        LIMIT ?
                    )
                    ORDER BY occurred_at ASC, rowid ASC
                    """,
                    [*params, limit],
                ).fetchall()
        return [dict(row) for row in rows]

    def count_local_metric_events(
        self,
        *,
        event_names: tuple[str, ...] | None = None,
    ) -> dict[str, int]:
        with self.connection() as conn:
            if event_names:
                placeholders = ", ".join("?" for _ in event_names)
                rows = conn.execute(
                    f"""
                    SELECT event_name, COUNT(*) AS count
                    FROM local_metric_events
                    WHERE event_name IN ({placeholders})
                    GROUP BY event_name
                    """,
                    list(event_names),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT event_name, COUNT(*) AS count
                    FROM local_metric_events
                    GROUP BY event_name
                    """
                ).fetchall()
        return {
            str(row["event_name"]): int(row["count"])
            for row in rows
        }

    def put_realtime_ticket(
        self,
        *,
        ticket_id: str,
        token: str,
        owner_session_id: str,
        session_id: str,
        ttl_seconds: int,
    ) -> RealtimeTicket:
        created_at = utcnow()
        expires_at = created_at + timedelta(seconds=ttl_seconds)
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute(
                (
                    "INSERT OR REPLACE INTO realtime_tickets"
                    "(id, token_hash, owner_session_id, session_id, expires_at, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)"
                ),
                (
                    ticket_id,
                    token_hash,
                    owner_session_id,
                    session_id,
                    _to_db(expires_at),
                    _to_db(created_at),
                ),
            )
        return RealtimeTicket(
            id=ticket_id,
            token_hash=token_hash,
            owner_session_id=owner_session_id,
            session_id=session_id,
            expires_at=expires_at,
            created_at=created_at,
        )

    def get_realtime_ticket(self, token: str) -> RealtimeTicket | None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            row = conn.execute(
                (
                    "SELECT id, token_hash, owner_session_id, session_id, expires_at, created_at "
                    "FROM realtime_tickets WHERE token_hash = ?"
                ),
                (token_hash,),
            ).fetchone()
        if not row:
            return None
        ticket = RealtimeTicket(
            id=row["id"],
            token_hash=row["token_hash"],
            owner_session_id=row["owner_session_id"],
            session_id=row["session_id"],
            expires_at=_from_db(row["expires_at"]) or utcnow(),
            created_at=_from_db(row["created_at"]) or utcnow(),
        )
        if ticket.expires_at <= utcnow():
            self.delete_realtime_ticket_by_id(ticket.id)
            return None
        return ticket

    def delete_realtime_ticket(self, token: str) -> None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute("DELETE FROM realtime_tickets WHERE token_hash = ?", (token_hash,))

    def delete_realtime_ticket_by_id(self, ticket_id: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM realtime_tickets WHERE id = ?", (ticket_id,))

    def delete_all_realtime_tickets(self) -> int:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM realtime_tickets")
        return cursor.rowcount
