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


class TrustedDeviceMixin:
    def create_trusted_device(
        self,
        *,
        device_id: str,
        name: str,
        refresh_token: str,
        ttl_seconds: int,
    ) -> TrustedDevice:
        created_at = utcnow()
        refresh_expires_at = created_at + timedelta(seconds=ttl_seconds)
        refresh_token_hash = self.hash_token(refresh_token)
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO trusted_devices
                    (id, name, refresh_token_hash, refresh_expires_at, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    name,
                    refresh_token_hash,
                    _to_db(refresh_expires_at),
                    _to_db(created_at),
                    _to_db(created_at),
                ),
            )
        return TrustedDevice(
            id=device_id,
            name=name,
            refresh_token_hash=refresh_token_hash,
            refresh_expires_at=refresh_expires_at,
            created_at=created_at,
            last_seen_at=created_at,
        )

    def rotate_trusted_device_token(
        self,
        *,
        refresh_token: str,
        next_refresh_token: str,
        owner_session_id: str,
        access_token: str,
        access_ttl_seconds: int,
        refresh_ttl_seconds: int,
        recovery_ttl_seconds: int,
    ) -> tuple[TrustedDevice, OwnerSession] | None:
        now = utcnow()
        refresh_token_hash = self.hash_token(refresh_token)
        next_refresh_token_hash = self.hash_token(next_refresh_token)
        refresh_expires_at = now + timedelta(seconds=refresh_ttl_seconds)
        recovery_expires_at = now + timedelta(seconds=recovery_ttl_seconds)
        access_expires_at = now + timedelta(seconds=access_ttl_seconds)
        access_token_hash = self.hash_token(access_token)
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT id, name, refresh_token_hash, refresh_expires_at,
                       previous_refresh_token_hash, previous_refresh_expires_at,
                       previous_refresh_uses_remaining, created_at, last_seen_at
                FROM trusted_devices
                WHERE refresh_token_hash = ? OR previous_refresh_token_hash = ?
                """,
                (refresh_token_hash, refresh_token_hash),
            ).fetchone()
            if row is None:
                return None
            if (_from_db(row["refresh_expires_at"]) or now) <= now:
                conn.execute("DELETE FROM trusted_devices WHERE id = ?", (row["id"],))
                return None
            is_current = hmac.compare_digest(
                row["refresh_token_hash"], refresh_token_hash
            )
            if not is_current:
                recovery_deadline = _from_db(row["previous_refresh_expires_at"])
                recovery_uses = int(row["previous_refresh_uses_remaining"])
                if (
                    recovery_deadline is None
                    or recovery_deadline <= now
                    or recovery_uses != 1
                    or not hmac.compare_digest(
                        row["refresh_token_hash"], next_refresh_token_hash
                    )
                ):
                    conn.execute(
                        """
                        UPDATE trusted_devices
                        SET previous_refresh_token_hash = NULL,
                            previous_refresh_expires_at = NULL,
                            previous_refresh_uses_remaining = 0
                        WHERE id = ? AND previous_refresh_token_hash = ?
                        """,
                        (row["id"], refresh_token_hash),
                    )
                    return None
                cursor = conn.execute(
                    """
                    UPDATE trusted_devices
                    SET previous_refresh_token_hash = NULL,
                        previous_refresh_expires_at = NULL,
                        previous_refresh_uses_remaining = 0
                    WHERE id = ? AND previous_refresh_token_hash = ?
                      AND previous_refresh_uses_remaining = 1
                    """,
                    (row["id"], refresh_token_hash),
                )
                if cursor.rowcount != 1:
                    return None
                session_row = conn.execute(
                    """
                    SELECT id, token_hash, expires_at, created_at, device_id
                    FROM owner_sessions
                    WHERE id = ? AND token_hash = ? AND device_id = ?
                    """,
                    (owner_session_id, access_token_hash, row["id"]),
                ).fetchone()
                if session_row is None:
                    return None
                return (
                    TrustedDevice(
                        id=row["id"],
                        name=row["name"],
                        refresh_token_hash=row["refresh_token_hash"],
                        refresh_expires_at=_from_db(row["refresh_expires_at"]) or now,
                        created_at=_from_db(row["created_at"]) or now,
                        last_seen_at=_from_db(row["last_seen_at"]) or now,
                    ),
                    OwnerSession(
                        id=session_row["id"],
                        token_hash=session_row["token_hash"],
                        expires_at=_from_db(session_row["expires_at"]) or now,
                        created_at=_from_db(session_row["created_at"]) or now,
                        device_id=session_row["device_id"],
                    ),
                )
            cursor = conn.execute(
                """
                UPDATE trusted_devices
                SET refresh_token_hash = ?, refresh_expires_at = ?, last_seen_at = ?,
                    previous_refresh_token_hash = ?,
                    previous_refresh_expires_at = ?,
                    previous_refresh_uses_remaining = 1
                WHERE id = ? AND refresh_token_hash = ?
                """,
                (
                    next_refresh_token_hash,
                    _to_db(refresh_expires_at),
                    _to_db(now),
                    refresh_token_hash,
                    _to_db(recovery_expires_at),
                    row["id"],
                    refresh_token_hash,
                ),
            )
            if cursor.rowcount != 1:
                return None
            conn.execute(
                """
                INSERT INTO owner_sessions(id, token_hash, expires_at, created_at, device_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    owner_session_id,
                    access_token_hash,
                    _to_db(access_expires_at),
                    _to_db(now),
                    row["id"],
                ),
            )
        return (
            TrustedDevice(
                id=row["id"],
                name=row["name"],
                refresh_token_hash=next_refresh_token_hash,
                refresh_expires_at=refresh_expires_at,
                created_at=_from_db(row["created_at"]) or now,
                last_seen_at=now,
            ),
            OwnerSession(
                id=owner_session_id,
                token_hash=access_token_hash,
                expires_at=access_expires_at,
                created_at=now,
                device_id=row["id"],
            ),
        )

    def list_trusted_devices(self) -> list[TrustedDevice]:
        now = utcnow()
        with self.connection() as conn:
            conn.execute(
                "DELETE FROM trusted_devices WHERE refresh_expires_at <= ?",
                (_to_db(now),),
            )
            rows = conn.execute(
                """
                SELECT id, name, refresh_token_hash, refresh_expires_at, created_at, last_seen_at
                FROM trusted_devices
                ORDER BY last_seen_at DESC, created_at DESC
                """
            ).fetchall()
        return [
            TrustedDevice(
                id=row["id"],
                name=row["name"],
                refresh_token_hash=row["refresh_token_hash"],
                refresh_expires_at=_from_db(row["refresh_expires_at"]) or now,
                created_at=_from_db(row["created_at"]) or now,
                last_seen_at=_from_db(row["last_seen_at"]) or now,
            )
            for row in rows
        ]

    def delete_trusted_device(self, device_id: str) -> bool:
        with self.connection() as conn:
            conn.execute("DELETE FROM owner_sessions WHERE device_id = ?", (device_id,))
            cursor = conn.execute("DELETE FROM trusted_devices WHERE id = ?", (device_id,))
        return cursor.rowcount == 1

    def delete_all_trusted_devices(self) -> int:
        with self.connection() as conn:
            conn.execute("DELETE FROM owner_sessions WHERE device_id IS NOT NULL")
            cursor = conn.execute("DELETE FROM trusted_devices")
        return cursor.rowcount

    def delete_all_pairing_challenges(self) -> int:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM pairing_challenges")
        return cursor.rowcount
