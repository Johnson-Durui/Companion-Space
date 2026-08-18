from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
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
from app.services.material_storage import canonicalize_legacy_material_storage_key

CURRENT_SCHEMA_VERSION = 3


class CharacterInUseError(ValueError):
    """Raised when a durable space or session still references a character."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_db(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _from_db(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _tts_playback_policy(connection_id: str | None) -> TtsPlaybackPolicy | None:
    if connection_id is None:
        return None
    if connection_id == "builtin-mock":
        return "browser-compat"
    if connection_id == "builtin-neural-tts":
        return "server-neural"
    return "server"


def _fts_sparse_terms_expression(column_name: str) -> str:
    return (
        f"trim(replace(replace(replace(replace({column_name}, '[', ' '), ']', ' '), '\"', ' '), ',', ' '))"
    )


@dataclass
class OwnerSession:
    id: str
    token_hash: str
    expires_at: datetime
    created_at: datetime
    device_id: str | None = None


@dataclass(frozen=True)
class OwnerPreferences:
    adult_relationships_enabled: bool
    adult_age_confirmed_at: datetime | None


@dataclass
class RealtimeTicket:
    id: str
    token_hash: str
    owner_session_id: str
    session_id: str
    expires_at: datetime
    created_at: datetime


class SQLiteRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.settings.storage_root.mkdir(parents=True, exist_ok=True)
        self.settings.spaces_root.mkdir(parents=True, exist_ok=True)
        self.settings.characters_root.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._ensure_session_tts_snapshot_columns()
        self.migrate_material_storage_paths()

    def _ensure_session_tts_snapshot_columns(self) -> None:
        """Add v1-compatible session snapshot columns to already initialized databases."""
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            column_statements = {
                "tts_connection_id": (
                    "ALTER TABLE sessions ADD COLUMN tts_connection_id TEXT"
                ),
                "tts_model_name": (
                    "ALTER TABLE sessions ADD COLUMN tts_model_name TEXT"
                ),
                "tts_playback_policy": (
                    "ALTER TABLE sessions ADD COLUMN tts_playback_policy TEXT"
                ),
            }
            for column_name, statement in column_statements.items():
                if column_name not in columns:
                    conn.execute(statement)

    @contextmanager
    def connection(self):
        conn = self._open_connection()
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _open_connection(self, *, autocommit=sqlite3.LEGACY_TRANSACTION_CONTROL):
        busy_timeout_ms = self.settings.sqlite_busy_timeout_ms
        conn = sqlite3.connect(
            self.settings.metadata_db_path,
            timeout=busy_timeout_ms / 1_000,
            autocommit=autocommit,
        )
        conn.row_factory = sqlite3.Row
        try:
            conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
            conn.execute("PRAGMA foreign_keys = ON")
        except BaseException:
            conn.close()
            raise
        return conn

    @staticmethod
    def _schema_version(conn: sqlite3.Connection) -> int:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])

    @staticmethod
    def _reject_future_schema(version: int) -> None:
        if version > CURRENT_SCHEMA_VERSION:
            raise RuntimeError(
                f"SQLite schema version {version} is newer than supported version "
                f"{CURRENT_SCHEMA_VERSION}"
            )

    @contextmanager
    def _schema_initialization_connection(self):
        conn = self._open_connection(autocommit=True)
        transaction_started = False
        try:
            version = self._schema_version(conn)
            self._reject_future_schema(version)

            journal_mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                raise RuntimeError(
                    f"Unable to enable SQLite WAL mode; SQLite returned {journal_mode!r}"
                )

            conn.execute("BEGIN IMMEDIATE")
            transaction_started = True
            version = self._schema_version(conn)
            self._reject_future_schema(version)

            yield conn

            if transaction_started:
                final_version = self._schema_version(conn)
                if final_version == 0:
                    conn.execute(f"PRAGMA user_version = {CURRENT_SCHEMA_VERSION}")
                elif final_version != CURRENT_SCHEMA_VERSION:
                    raise RuntimeError(
                        "SQLite schema migration ended at unexpected version "
                        f"{final_version}"
                    )
                conn.execute("COMMIT")
                transaction_started = False
        except BaseException:
            if transaction_started and conn.in_transaction:
                conn.execute("ROLLBACK")
                transaction_started = False
            raise
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._schema_initialization_connection() as conn:
            if self._schema_version(conn) == CURRENT_SCHEMA_VERSION:
                return
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS study_spaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    goal TEXT NOT NULL,
                    default_character_pack_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS materials (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    storage_path TEXT NOT NULL,
                    chunk_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    material_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    locator TEXT NOT NULL,
                    content TEXT NOT NULL,
                    sparse_terms TEXT NOT NULL,
                    dense_vector TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
                    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS ingestion_jobs (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    material_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
                    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS character_packs (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    recipe_json TEXT NOT NULL,
                    asset_manifest_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_connections (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    label TEXT NOT NULL,
                    base_url TEXT,
                    capabilities_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_assignments (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    provider_connection_id TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    is_bootstrap_default INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
                    FOREIGN KEY(provider_connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    character_pack_id TEXT,
                    state TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    generated_summary TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    artifacts_status TEXT NOT NULL DEFAULT 'idle',
                    artifacts_error TEXT,
                    artifacts_updated_at TEXT,
                    tts_connection_id TEXT,
                    tts_model_name TEXT,
                    tts_playback_policy TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    ended_at TEXT,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS turns (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    space_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    display_text TEXT NOT NULL,
                    spoken_text TEXT NOT NULL,
                    emotion TEXT NOT NULL,
                    board_actions_json TEXT NOT NULL DEFAULT '[]',
                    citations_json TEXT NOT NULL,
                    suggested_actions_json TEXT NOT NULL,
                    usage_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS memory_items (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL,
                    sensitive INTEGER NOT NULL,
                    source_session_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS review_items (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    due_at TEXT,
                    status TEXT NOT NULL,
                    source_session_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS owner_sessions (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS owner_preferences (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    adult_relationships_enabled INTEGER NOT NULL DEFAULT 0,
                    adult_age_confirmed_at TEXT
                );
                INSERT OR IGNORE INTO owner_preferences(
                    id,
                    adult_relationships_enabled,
                    adult_age_confirmed_at
                ) VALUES (1, 0, NULL);
                CREATE TABLE IF NOT EXISTS local_metric_events (
                    id TEXT PRIMARY KEY,
                    event_name TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_local_metric_events_name_time
                    ON local_metric_events(event_name, occurred_at);
                CREATE TABLE IF NOT EXISTS realtime_tickets (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    owner_session_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_realtime_tickets_owner_session_id
                    ON realtime_tickets(owner_session_id);
                """
            )

            assignment_columns = {
                row["name"]
                for row in conn.execute(
                    "PRAGMA table_info(model_assignments)"
                ).fetchall()
            }
            session_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            memory_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(memory_items)").fetchall()
            }
            review_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(review_items)").fetchall()
            }
            turn_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(turns)").fetchall()
            }
            if "board_actions_json" not in turn_columns:
                conn.execute(
                    """
                    ALTER TABLE turns
                    ADD COLUMN board_actions_json TEXT NOT NULL DEFAULT '[]'
                    """
                )
            if "is_bootstrap_default" not in assignment_columns:
                conn.execute(
                    """
                    ALTER TABLE model_assignments
                    ADD COLUMN is_bootstrap_default INTEGER NOT NULL DEFAULT 0
                    """
                )
                conn.execute(
                    """
                    UPDATE model_assignments
                    SET is_bootstrap_default = 1
                    WHERE provider_connection_id = 'builtin-mock'
                      AND (
                        (capability = 'stt' AND model_name = 'mock-stt-v1')
                        OR (capability = 'tts' AND model_name = 'mock-voice-v1')
                      )
                      AND created_at = updated_at
                      AND EXISTS (
                        SELECT 1
                        FROM model_assignments AS chat_assignment
                        WHERE chat_assignment.space_id = model_assignments.space_id
                          AND chat_assignment.capability = 'chat_llm'
                          AND chat_assignment.provider_connection_id = 'builtin-mock'
                          AND chat_assignment.model_name = 'mock-companion-v1'
                          AND chat_assignment.created_at = model_assignments.created_at
                          AND chat_assignment.updated_at = model_assignments.updated_at
                      )
                    """
                )
            if "generated_summary" not in session_columns:
                conn.execute(
                    """
                    ALTER TABLE sessions
                    ADD COLUMN generated_summary TEXT NOT NULL DEFAULT ''
                    """
                )
            if "notes" not in session_columns:
                conn.execute(
                    """
                    ALTER TABLE sessions
                    ADD COLUMN notes TEXT NOT NULL DEFAULT ''
                    """
                )
            if "artifacts_status" not in session_columns:
                conn.execute(
                    """
                    ALTER TABLE sessions
                    ADD COLUMN artifacts_status TEXT NOT NULL DEFAULT 'idle'
                    """
                )
            if "artifacts_error" not in session_columns:
                conn.execute(
                    """
                    ALTER TABLE sessions
                    ADD COLUMN artifacts_error TEXT
                    """
                )
            if "artifacts_updated_at" not in session_columns:
                conn.execute(
                    """
                    ALTER TABLE sessions
                    ADD COLUMN artifacts_updated_at TEXT
                    """
                )
            if "source_session_id" not in memory_columns:
                conn.execute(
                    """
                    ALTER TABLE memory_items
                    ADD COLUMN source_session_id TEXT
                    """
                )
            if "source_session_id" not in review_columns:
                conn.execute(
                    """
                    ALTER TABLE review_items
                    ADD COLUMN source_session_id TEXT
                    """
                )
            sparse_terms_expr = _fts_sparse_terms_expression("new.sparse_terms")
            sparse_terms_backfill_expr = _fts_sparse_terms_expression("chunks.sparse_terms")
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    space_id UNINDEXED,
                    material_id UNINDEXED,
                    title,
                    locator,
                    search_terms,
                    content,
                    tokenize = 'unicode61'
                )
                """
            )
            conn.executescript(
                f"""
                CREATE TRIGGER IF NOT EXISTS chunks_fts_after_insert
                AFTER INSERT ON chunks
                BEGIN
                    INSERT INTO chunks_fts
                    (chunk_id, space_id, material_id, title, locator, search_terms, content)
                    VALUES (
                        new.id,
                        new.space_id,
                        new.material_id,
                        new.title,
                        new.locator,
                        {sparse_terms_expr},
                        new.content
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS chunks_fts_after_update
                AFTER UPDATE ON chunks
                BEGIN
                    DELETE FROM chunks_fts WHERE chunk_id = old.id;
                    INSERT INTO chunks_fts
                    (chunk_id, space_id, material_id, title, locator, search_terms, content)
                    VALUES (
                        new.id,
                        new.space_id,
                        new.material_id,
                        new.title,
                        new.locator,
                        {sparse_terms_expr},
                        new.content
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS chunks_fts_after_delete
                AFTER DELETE ON chunks
                BEGIN
                    DELETE FROM chunks_fts WHERE chunk_id = old.id;
                END;
                """
            )
            conn.execute(
                f"""
                INSERT INTO chunks_fts
                (chunk_id, space_id, material_id, title, locator, search_terms, content)
                SELECT
                    chunks.id,
                    chunks.space_id,
                    chunks.material_id,
                    chunks.title,
                    chunks.locator,
                    {sparse_terms_backfill_expr},
                    chunks.content
                FROM chunks
                LEFT JOIN chunks_fts ON chunks_fts.chunk_id = chunks.id
                WHERE chunks_fts.chunk_id IS NULL
                """
            )
            conn.execute(
                """
                DELETE FROM model_assignments
                WHERE rowid NOT IN (
                    SELECT MAX(rowid)
                    FROM model_assignments
                    GROUP BY space_id, capability
                )
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS
                    idx_model_assignments_space_capability
                ON model_assignments(space_id, capability)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_space_updated_at
                ON ingestion_jobs(space_id, updated_at DESC)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status_updated_at
                ON ingestion_jobs(status, updated_at ASC)
                """
            )
            if self._schema_version(conn) == 0:
                conn.execute("PRAGMA user_version = 1")
            if self._schema_version(conn) == 1:
                self._migrate_schema_v1_to_v2(conn)
            if self._schema_version(conn) == 2:
                self._migrate_schema_v2_to_v3(conn)

    @staticmethod
    def _migrate_schema_v1_to_v2(conn: sqlite3.Connection) -> None:
        statements = (
            """CREATE TABLE pairing_challenges (
                id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                attempts_remaining INTEGER NOT NULL CHECK(attempts_remaining >= 0),
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""",
            """CREATE INDEX idx_pairing_challenges_expires_at
                ON pairing_challenges(expires_at)""",
            """CREATE TABLE trusted_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                refresh_token_hash TEXT NOT NULL UNIQUE,
                refresh_expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            )""",
            """CREATE INDEX idx_trusted_devices_refresh_expires_at
                ON trusted_devices(refresh_expires_at)""",
            "ALTER TABLE owner_sessions ADD COLUMN device_id TEXT",
            "CREATE INDEX idx_owner_sessions_device_id ON owner_sessions(device_id)",
        )
        for statement in statements:
            conn.execute(statement)
        conn.execute("PRAGMA user_version = 2")

    @staticmethod
    def _migrate_schema_v2_to_v3(conn: sqlite3.Connection) -> None:
        statements = (
            "ALTER TABLE trusted_devices ADD COLUMN previous_refresh_token_hash TEXT",
            "ALTER TABLE trusted_devices ADD COLUMN previous_refresh_expires_at TEXT",
            (
                "ALTER TABLE trusted_devices ADD COLUMN "
                "previous_refresh_uses_remaining INTEGER NOT NULL DEFAULT 0 "
                "CHECK(previous_refresh_uses_remaining >= 0)"
            ),
            (
                "CREATE UNIQUE INDEX idx_trusted_devices_previous_refresh_token_hash "
                "ON trusted_devices(previous_refresh_token_hash) "
                "WHERE previous_refresh_token_hash IS NOT NULL"
            ),
        )
        for statement in statements:
            conn.execute(statement)
        conn.execute("PRAGMA user_version = 3")

    def migrate_material_storage_paths(self) -> int:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._reject_future_schema(self._schema_version(conn))
            rows = conn.execute(
                "SELECT * FROM materials ORDER BY id ASC"
            ).fetchall()
            updates: list[tuple[str, str, str]] = []
            for row in rows:
                material = self._row_to_material(row)
                try:
                    canonical = canonicalize_legacy_material_storage_key(material)
                except ValueError:
                    continue
                if material.storage_path != canonical:
                    updates.append(
                        (canonical, material.id, material.storage_path)
                    )

            for canonical, material_id, previous in updates:
                cursor = conn.execute(
                    """
                    UPDATE materials
                    SET storage_path = ?
                    WHERE id = ? AND storage_path = ?
                    """,
                    (canonical, material_id, previous),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError(
                        "Material storage path migration changed concurrently"
                    )
        return len(updates)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def put_owner_session(
        self,
        *,
        session_id: str,
        token: str,
        ttl_seconds: int | None = None,
        device_id: str | None = None,
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
                    (id, token_hash, expires_at, created_at, device_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    token_hash,
                    _to_db(expires_at),
                    _to_db(created_at),
                    device_id,
                ),
            )
        return OwnerSession(
            id=session_id,
            token_hash=token_hash,
            expires_at=expires_at,
            created_at=created_at,
            device_id=device_id,
        )

    def get_owner_session(self, token: str) -> OwnerSession | None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id, token_hash, expires_at, created_at, device_id FROM owner_sessions WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
        return self._owner_session_from_row(row)

    def get_owner_session_by_id(self, session_id: str) -> OwnerSession | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id, token_hash, expires_at, created_at, device_id FROM owner_sessions WHERE id = ?",
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
            device_id=row["device_id"],
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
            rows = conn.execute("SELECT token_hash FROM owner_sessions").fetchall()
        return {row["token_hash"] for row in rows}

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

    def get_owner_preferences(self) -> OwnerPreferences:
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT adult_relationships_enabled, adult_age_confirmed_at
                FROM owner_preferences
                WHERE id = 1
                """
            ).fetchone()
        if row is None:
            raise RuntimeError("Owner preferences row is missing")
        return OwnerPreferences(
            adult_relationships_enabled=bool(
                row["adult_relationships_enabled"]
            ),
            adult_age_confirmed_at=_from_db(row["adult_age_confirmed_at"]),
        )

    def set_owner_preferences(
        self,
        *,
        adult_relationships_enabled: bool,
        adult_age_confirmed_at: datetime | None,
    ) -> OwnerPreferences:
        if adult_relationships_enabled and adult_age_confirmed_at is None:
            raise ValueError(
                "Adult relationship mode requires an 18+ owner confirmation"
            )
        confirmed_at = (
            adult_age_confirmed_at if adult_relationships_enabled else None
        )
        with self.connection() as conn:
            conn.execute(
                """
                UPDATE owner_preferences
                SET adult_relationships_enabled = ?,
                    adult_age_confirmed_at = ?
                WHERE id = 1
                """,
                (
                    int(adult_relationships_enabled),
                    _to_db(confirmed_at),
                ),
            )
        return OwnerPreferences(
            adult_relationships_enabled=adult_relationships_enabled,
            adult_age_confirmed_at=confirmed_at,
        )

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

    def list_spaces(self) -> list[StudySpace]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM study_spaces ORDER BY updated_at DESC").fetchall()
        return [self._row_to_space(row) for row in rows]

    def get_space(self, space_id: str) -> StudySpace | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM study_spaces WHERE id = ?", (space_id,)).fetchone()
        return self._row_to_space(row) if row else None

    def upsert_space(self, space: StudySpace) -> StudySpace:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO study_spaces
                (id, name, topic, goal, default_character_pack_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    topic = excluded.topic,
                    goal = excluded.goal,
                    default_character_pack_id = excluded.default_character_pack_id,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (
                    space.id,
                    space.name,
                    space.topic,
                    space.goal,
                    space.default_character_pack_id,
                    _to_db(space.created_at),
                    _to_db(space.updated_at),
                ),
            )
        return space

    def update_space_metadata(
        self,
        *,
        space_id: str,
        name: str,
        topic: str,
        goal: str,
        updated_at: datetime,
    ) -> StudySpace:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE study_spaces
                SET name = ?, topic = ?, goal = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, topic, goal, _to_db(updated_at), space_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Study space not found: {space_id}")
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
        return self._row_to_space(row)

    def set_space_default_character(
        self,
        *,
        space_id: str,
        character_pack_id: str | None,
        validate_character: Callable[[CharacterPack], None],
    ) -> StudySpace:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"Study space not found: {space_id}")
            if character_pack_id is not None:
                character = conn.execute(
                    "SELECT * FROM character_packs WHERE id = ?",
                    (character_pack_id,),
                ).fetchone()
                if character is None:
                    raise ValueError(f"Character not found: {character_pack_id}")
                validate_character(self._row_to_character(character))
            if row["default_character_pack_id"] == character_pack_id:
                return self._row_to_space(row)
            conn.execute(
                """
                UPDATE study_spaces
                SET default_character_pack_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (character_pack_id, _to_db(utcnow()), space_id),
            )
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
        return self._row_to_space(row)

    def delete_space(self, space_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM study_spaces WHERE id = ?", (space_id,))
        return cursor.rowcount == 1

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

    def upsert_ingestion_job(self, job: IngestionJob) -> IngestionJob:
        with self.connection() as conn:
            self._upsert_ingestion_job_with_conn(conn, job)
        return job

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

    def list_characters(self) -> list[CharacterPack]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM character_packs ORDER BY updated_at DESC").fetchall()
        return [self._row_to_character(row) for row in rows]

    def get_character(self, character_id: str) -> CharacterPack | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM character_packs WHERE id = ?", (character_id,)).fetchone()
        return self._row_to_character(row) if row else None

    def upsert_character(self, character: CharacterPack) -> CharacterPack:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO character_packs
                (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    character.id,
                    character.name,
                    character.description,
                    character.recipe.model_dump_json(),
                    json.dumps(character.asset_manifest, ensure_ascii=False),
                    _to_db(character.created_at),
                    _to_db(character.updated_at),
                ),
            )
        return character

    def delete_character(self, character_id: str) -> bool:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            referenced = conn.execute(
                """
                SELECT 1 FROM study_spaces WHERE default_character_pack_id = ?
                UNION ALL
                SELECT 1 FROM sessions WHERE character_pack_id = ?
                LIMIT 1
                """,
                (character_id, character_id),
            ).fetchone()
            if referenced is not None:
                raise CharacterInUseError(
                    f"Character is in use and cannot be deleted: {character_id}"
                )
            cursor = conn.execute("DELETE FROM character_packs WHERE id = ?", (character_id,))
        return cursor.rowcount == 1

    def list_provider_connections(self) -> list[ProviderConnection]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM provider_connections ORDER BY updated_at DESC").fetchall()
        return [self._row_to_provider(row) for row in rows]

    def get_provider_connection(self, connection_id: str) -> ProviderConnection | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM provider_connections WHERE id = ?", (connection_id,)).fetchone()
        return self._row_to_provider(row) if row else None

    def upsert_provider_connection(self, connection: ProviderConnection) -> ProviderConnection:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO provider_connections
                (id, provider, label, base_url, capabilities_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    provider = excluded.provider,
                    label = excluded.label,
                    base_url = excluded.base_url,
                    capabilities_json = excluded.capabilities_json,
                    updated_at = excluded.updated_at
                """,
                (
                    connection.id,
                    connection.provider,
                    connection.label,
                    connection.base_url,
                    json.dumps([item.value for item in connection.capabilities]),
                    _to_db(connection.created_at),
                    _to_db(connection.updated_at),
                ),
            )
        return connection

    def delete_provider_connection(self, connection_id: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM provider_connections WHERE id = ?", (connection_id,))

    def list_model_assignments(self, space_id: str) -> list[ModelAssignment]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM model_assignments WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_assignment(row) for row in rows]

    def upsert_model_assignment(self, assignment: ModelAssignment) -> ModelAssignment:
        with self.connection() as conn:
            conn.execute(
                """
                DELETE FROM model_assignments
                WHERE space_id = ? AND capability = ? AND id <> ?
                """,
                (
                    assignment.space_id,
                    assignment.capability.value,
                    assignment.id,
                ),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO model_assignments
                (
                    id,
                    space_id,
                    capability,
                    provider_connection_id,
                    model_name,
                    is_bootstrap_default,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    assignment.id,
                    assignment.space_id,
                    assignment.capability.value,
                    assignment.provider_connection_id,
                    assignment.model_name,
                    int(assignment.is_bootstrap_default),
                    _to_db(assignment.created_at),
                    _to_db(assignment.updated_at),
                ),
            )
        return assignment

    def delete_model_assignment(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
    ) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                DELETE FROM model_assignments
                WHERE space_id = ? AND capability = ?
                """,
                (space_id, capability.value),
            )
        return cursor.rowcount > 0

    def list_sessions(self, space_id: str) -> list[SessionRecord]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def list_recoverable_artifact_sessions(self) -> list[SessionRecord]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM sessions
                WHERE artifacts_status IN (?, ?)
                ORDER BY COALESCE(artifacts_updated_at, updated_at) ASC, id ASC
                """,
                (
                    LearningArtifactsStatus.pending.value,
                    LearningArtifactsStatus.running.value,
                ),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row_to_session(row) if row else None

    def try_activate_session_turn(
        self,
        *,
        session_id: str,
        allowed_states: tuple[SessionState, ...],
    ) -> SessionRecord | None:
        now = utcnow()
        placeholders = ", ".join("?" for _ in allowed_states)
        with self.connection() as conn:
            cursor = conn.execute(
                f"""
                UPDATE sessions
                SET state = ?, updated_at = ?
                WHERE id = ?
                  AND ended_at IS NULL
                  AND state IN ({placeholders})
                """,
                (
                    SessionState.thinking.value,
                    _to_db(now),
                    session_id,
                    *(state.value for state in allowed_states),
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row_to_session(row) if row else None

    def upsert_session(self, session: SessionRecord) -> SessionRecord:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO sessions
                (
                    id,
                    space_id,
                    character_pack_id,
                    state,
                    summary,
                    generated_summary,
                    notes,
                    artifacts_status,
                    artifacts_error,
                    artifacts_updated_at,
                    tts_connection_id,
                    tts_model_name,
                    tts_playback_policy,
                    created_at,
                    updated_at,
                    ended_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    state = excluded.state,
                    summary = excluded.summary,
                    generated_summary = excluded.generated_summary,
                    notes = excluded.notes,
                    artifacts_status = excluded.artifacts_status,
                    artifacts_error = excluded.artifacts_error,
                    artifacts_updated_at = excluded.artifacts_updated_at,
                    updated_at = excluded.updated_at,
                    ended_at = excluded.ended_at
                """,
                (
                    session.id,
                    session.space_id,
                    session.character_pack_id,
                    session.state.value,
                    session.summary,
                    session.generated_summary,
                    session.notes,
                    session.artifacts_status.value,
                    session.artifacts_error,
                    _to_db(session.artifacts_updated_at),
                    session.tts_connection_id,
                    session.tts_model_name,
                    session.tts_playback_policy,
                    _to_db(session.created_at),
                    _to_db(session.updated_at),
                    _to_db(session.ended_at),
                ),
            )
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session.id,)
            ).fetchone()
        if row is None:
            raise RuntimeError(f"Session disappeared after upsert: {session.id}")
        return self._row_to_session(row)

    def create_session(
        self,
        session: SessionRecord,
        *,
        requested_character_pack_id: str | None,
        fallback_character_pack_id: str,
        validate_character: Callable[[CharacterPack], None],
    ) -> SessionRecord:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            space_row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (session.space_id,)
            ).fetchone()
            if space_row is None:
                raise ValueError(f"Study space not found: {session.space_id}")
            character_pack_id = (
                requested_character_pack_id
                or space_row["default_character_pack_id"]
                or fallback_character_pack_id
            )
            character_row = conn.execute(
                "SELECT * FROM character_packs WHERE id = ?",
                (character_pack_id,),
            ).fetchone()
            if character_row is None:
                raise ValueError(f"Character not found: {character_pack_id}")
            validate_character(self._row_to_character(character_row))
            tts_assignment_row = conn.execute(
                """
                SELECT provider_connection_id, model_name
                FROM model_assignments
                WHERE space_id = ? AND capability = ?
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                """,
                (session.space_id, ProviderCapability.tts.value),
            ).fetchone()
            tts_connection_id = (
                tts_assignment_row["provider_connection_id"]
                if tts_assignment_row is not None
                else None
            )
            tts_model_name = (
                tts_assignment_row["model_name"]
                if tts_assignment_row is not None
                else None
            )
            created = session.model_copy(
                update={
                    "character_pack_id": character_pack_id,
                    "tts_connection_id": tts_connection_id,
                    "tts_model_name": tts_model_name,
                    "tts_playback_policy": _tts_playback_policy(tts_connection_id),
                }
            )
            conn.execute(
                """
                INSERT INTO sessions
                (
                    id, space_id, character_pack_id, state, summary,
                    generated_summary, notes, artifacts_status, artifacts_error,
                    artifacts_updated_at, tts_connection_id, tts_model_name,
                    tts_playback_policy, created_at, updated_at, ended_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    created.id,
                    created.space_id,
                    created.character_pack_id,
                    created.state.value,
                    created.summary,
                    created.generated_summary,
                    created.notes,
                    created.artifacts_status.value,
                    created.artifacts_error,
                    _to_db(created.artifacts_updated_at),
                    created.tts_connection_id,
                    created.tts_model_name,
                    created.tts_playback_policy,
                    _to_db(created.created_at),
                    _to_db(created.updated_at),
                    _to_db(created.ended_at),
                ),
            )
        return created

    def update_session_recap_fields(
        self,
        *,
        session_id: str,
        summary: str,
        notes: str,
        updated_at: datetime,
    ) -> SessionRecord:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET summary = ?,
                    notes = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    summary,
                    notes,
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("Session not found")
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row)

    def undo_session_recap_fields(
        self,
        *,
        session_id: str,
        updated_at: datetime,
    ) -> SessionRecord:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET summary = generated_summary,
                    notes = '',
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("Session not found")
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row)

    def update_session_artifacts_status(
        self,
        *,
        session_id: str,
        status: LearningArtifactsStatus,
        error: str | None,
        updated_at: datetime,
    ) -> SessionRecord | None:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET artifacts_status = ?,
                    artifacts_error = ?,
                    artifacts_updated_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    status.value,
                    error,
                    _to_db(updated_at),
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row) if row else None

    def list_turns(self, session_id: str) -> list[CompanionTurn]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC",
                (session_id,),
            ).fetchall()
        return [self._row_to_turn(row) for row in rows]

    def add_turn(self, turn: CompanionTurn) -> CompanionTurn:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO turns
                (id, session_id, space_id, role, display_text, spoken_text, emotion, board_actions_json, citations_json, suggested_actions_json, usage_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    turn.id,
                    turn.session_id,
                    turn.space_id,
                    turn.role.value,
                    turn.display_text,
                    turn.spoken_text,
                    turn.emotion,
                    json.dumps(
                        [item.model_dump(mode="json") for item in turn.board_actions],
                        ensure_ascii=False,
                    ),
                    json.dumps([item.model_dump(mode="json") for item in turn.citations], ensure_ascii=False),
                    json.dumps(turn.suggested_actions, ensure_ascii=False),
                    turn.usage.model_dump_json(),
                    _to_db(turn.created_at),
                ),
            )
        return turn

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

    def _row_to_space(self, row: sqlite3.Row) -> StudySpace:
        return StudySpace(
            id=row["id"],
            name=row["name"],
            topic=row["topic"],
            goal=row["goal"],
            default_character_pack_id=row["default_character_pack_id"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_material(self, row: sqlite3.Row) -> Material:
        return Material(
            id=row["id"],
            space_id=row["space_id"],
            title=row["title"],
            kind=MaterialKind(row["kind"]),
            filename=row["filename"],
            storage_path=row["storage_path"],
            chunk_count=row["chunk_count"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_ingestion_job(self, row: sqlite3.Row) -> IngestionJob:
        return IngestionJob(
            id=row["id"],
            space_id=row["space_id"],
            material_id=row["material_id"],
            status=row["status"],
            error_message=row["error_message"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_chunk(self, row: sqlite3.Row) -> Chunk:
        return Chunk(
            id=row["id"],
            space_id=row["space_id"],
            material_id=row["material_id"],
            title=row["title"],
            locator=row["locator"],
            content=row["content"],
            sparse_terms=json.loads(row["sparse_terms"]),
            dense_vector=json.loads(row["dense_vector"]),
            metadata=json.loads(row["metadata_json"]),
            created_at=_from_db(row["created_at"]) or utcnow(),
        )

    def _row_to_character(self, row: sqlite3.Row) -> CharacterPack:
        return CharacterPack.model_validate(
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "recipe": json.loads(row["recipe_json"]),
                "asset_manifest": json.loads(row["asset_manifest_json"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    def _row_to_provider(self, row: sqlite3.Row) -> ProviderConnection:
        return ProviderConnection(
            id=row["id"],
            provider=row["provider"],
            label=row["label"],
            base_url=row["base_url"],
            capabilities=[ProviderCapability(item) for item in json.loads(row["capabilities_json"])],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_assignment(self, row: sqlite3.Row) -> ModelAssignment:
        return ModelAssignment(
            id=row["id"],
            space_id=row["space_id"],
            capability=ProviderCapability(row["capability"]),
            provider_connection_id=row["provider_connection_id"],
            model_name=row["model_name"],
            is_bootstrap_default=bool(row["is_bootstrap_default"]),
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_session(self, row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            id=row["id"],
            space_id=row["space_id"],
            character_pack_id=row["character_pack_id"],
            state=SessionState(row["state"]),
            summary=row["summary"],
            generated_summary=row["generated_summary"] if "generated_summary" in row.keys() else "",
            notes=row["notes"] if "notes" in row.keys() else "",
            artifacts_status=row["artifacts_status"] if "artifacts_status" in row.keys() else "idle",
            artifacts_error=row["artifacts_error"] if "artifacts_error" in row.keys() else None,
            artifacts_updated_at=_from_db(row["artifacts_updated_at"]) if "artifacts_updated_at" in row.keys() else None,
            tts_connection_id=(
                row["tts_connection_id"]
                if "tts_connection_id" in row.keys()
                else None
            ),
            tts_model_name=(
                row["tts_model_name"] if "tts_model_name" in row.keys() else None
            ),
            tts_playback_policy=(
                row["tts_playback_policy"]
                if "tts_playback_policy" in row.keys()
                else None
            ),
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
            ended_at=_from_db(row["ended_at"]),
        )

    def _row_to_turn(self, row: sqlite3.Row) -> CompanionTurn:
        return CompanionTurn.model_validate(
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "space_id": row["space_id"],
                "role": TurnRole(row["role"]),
                "display_text": row["display_text"],
                "spoken_text": row["spoken_text"],
                "emotion": row["emotion"],
                "board_actions": json.loads(row["board_actions_json"]),
                "citations": json.loads(row["citations_json"]),
                "suggested_actions": json.loads(row["suggested_actions_json"]),
                "usage": json.loads(row["usage_json"]),
                "created_at": row["created_at"],
            }
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
