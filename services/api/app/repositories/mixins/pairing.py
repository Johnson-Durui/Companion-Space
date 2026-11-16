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


class PairingChallengeMixin:
    def create_pairing_challenge(
        self,
        *,
        challenge_id: str,
        code_verifier: str,
        ttl_seconds: int,
        max_attempts: int,
    ) -> PairingChallenge:
        created_at = utcnow()
        expires_at = created_at + timedelta(seconds=ttl_seconds)
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM pairing_challenges")
            conn.execute(
                """
                INSERT INTO pairing_challenges
                    (id, code_hash, attempts_remaining, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    challenge_id,
                    code_verifier,
                    max_attempts,
                    _to_db(expires_at),
                    _to_db(created_at),
                ),
            )
        return PairingChallenge(
            id=challenge_id,
            code_hash=code_verifier,
            attempts_remaining=max_attempts,
            expires_at=expires_at,
            created_at=created_at,
        )

    def consume_pairing_challenge(
        self,
        *,
        challenge_id: str,
        code_verifier: str,
    ) -> str:
        now = utcnow()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT code_hash, attempts_remaining, expires_at
                FROM pairing_challenges
                WHERE id = ?
                """,
                (challenge_id,),
            ).fetchone()
            if row is None:
                return "invalid"
            if (_from_db(row["expires_at"]) or now) <= now:
                conn.execute("DELETE FROM pairing_challenges WHERE id = ?", (challenge_id,))
                return "expired"
            if not hmac.compare_digest(row["code_hash"], code_verifier):
                attempts_remaining = int(row["attempts_remaining"]) - 1
                if attempts_remaining <= 0:
                    conn.execute("DELETE FROM pairing_challenges WHERE id = ?", (challenge_id,))
                    return "attempts_exhausted"
                conn.execute(
                    """
                    UPDATE pairing_challenges
                    SET attempts_remaining = ?
                    WHERE id = ?
                    """,
                    (attempts_remaining, challenge_id),
                )
                return "invalid"
            conn.execute("DELETE FROM pairing_challenges WHERE id = ?", (challenge_id,))
        return "consumed"

    def pair_trusted_device(
        self,
        *,
        challenge_id: str | None,
        code_verifier_for_challenge: Callable[[str], str],
        device_id: str,
        name: str,
        refresh_token: str,
        refresh_ttl_seconds: int,
        owner_session_id: str,
        access_token: str,
        access_ttl_seconds: int,
    ) -> tuple[str, TrustedDevice | None, OwnerSession | None]:
        now = utcnow()
        refresh_expires_at = now + timedelta(seconds=refresh_ttl_seconds)
        access_expires_at = now + timedelta(seconds=access_ttl_seconds)
        refresh_token_hash = self.hash_token(refresh_token)
        access_token_hash = self.hash_token(access_token)
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if challenge_id is None:
                row = conn.execute(
                    """
                    SELECT id, code_hash, attempts_remaining, expires_at
                    FROM pairing_challenges
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT id, code_hash, attempts_remaining, expires_at
                    FROM pairing_challenges
                    WHERE id = ?
                    """,
                    (challenge_id,),
                ).fetchone()
            if row is None:
                return "invalid", None, None
            active_challenge_id = str(row["id"])
            if (_from_db(row["expires_at"]) or now) <= now:
                conn.execute(
                    "DELETE FROM pairing_challenges WHERE id = ?",
                    (active_challenge_id,),
                )
                return "expired", None, None
            if not hmac.compare_digest(
                row["code_hash"],
                code_verifier_for_challenge(active_challenge_id),
            ):
                attempts_remaining = int(row["attempts_remaining"]) - 1
                if attempts_remaining <= 0:
                    conn.execute(
                        "DELETE FROM pairing_challenges WHERE id = ?",
                        (active_challenge_id,),
                    )
                    return "attempts_exhausted", None, None
                conn.execute(
                    """
                    UPDATE pairing_challenges
                    SET attempts_remaining = ?
                    WHERE id = ?
                    """,
                    (attempts_remaining, active_challenge_id),
                )
                return "invalid", None, None

            conn.execute(
                "DELETE FROM pairing_challenges WHERE id = ?",
                (active_challenge_id,),
            )
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
                    _to_db(now),
                    _to_db(now),
                ),
            )
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
                    device_id,
                ),
            )
        return (
            "consumed",
            TrustedDevice(
                id=device_id,
                name=name,
                refresh_token_hash=refresh_token_hash,
                refresh_expires_at=refresh_expires_at,
                created_at=now,
                last_seen_at=now,
            ),
            OwnerSession(
                id=owner_session_id,
                token_hash=access_token_hash,
                expires_at=access_expires_at,
                created_at=now,
                device_id=device_id,
            ),
        )
