from __future__ import annotations

# ruff: noqa: F401
import hashlib
import hmac
import json
import os
import sqlite3
from pathlib import Path
from tempfile import NamedTemporaryFile
from collections.abc import Callable
from contextlib import closing, contextmanager
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


class InfrastructureMixin:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.settings.storage_root.mkdir(parents=True, exist_ok=True)
        self.settings.spaces_root.mkdir(parents=True, exist_ok=True)
        self.settings.characters_root.mkdir(parents=True, exist_ok=True)
        self._initialize()
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

            if 0 < version < CURRENT_SCHEMA_VERSION:
                result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if result[0] != 0:
                    raise RuntimeError("SQLite could not checkpoint before migration")

            conn.execute("BEGIN IMMEDIATE")
            transaction_started = True
            version = self._schema_version(conn)
            self._reject_future_schema(version)
            if 0 < version < CURRENT_SCHEMA_VERSION:
                self._backup_database(version)

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

    def _backup_database(self, version: int) -> None:
        path = self.settings.metadata_db_path
        backup = path.with_name(f"{path.name}.v{version}.bak")
        if backup.exists():
            if not backup.is_file():
                raise RuntimeError(f"Unable to back up SQLite schema v{version}: backup path is not a file")
            return

        temporary = None
        try:
            with NamedTemporaryFile(dir=path.parent, prefix=f".{backup.name}.", delete=False) as file:
                temporary = Path(file.name)
            # Read through SQLite while the initialization connection holds the
            # writer lock so any transactions between checkpoint and lock are included.
            with closing(self._open_connection()) as source, closing(sqlite3.connect(temporary)) as target:
                source.backup(target)
            with temporary.open("r+b") as saved:
                os.fsync(saved.fileno())
            try:
                if os.name == "nt":
                    os.rename(temporary, backup)
                else:
                    os.link(temporary, backup)
            except FileExistsError:
                return
        except (OSError, sqlite3.Error) as exc:
            raise RuntimeError(f"Unable to back up SQLite schema v{version} before migration") from exc
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _initialize(self) -> None:
        from app.repositories.schema_base import BASE_SCHEMA_SQL
        from app.repositories.schema_compat import ensure_legacy_schema

        with self._schema_initialization_connection() as conn:
            version = self._schema_version(conn)
            if version == CURRENT_SCHEMA_VERSION:
                return
            if version < 5:
                conn.executescript(BASE_SCHEMA_SQL)
                ensure_legacy_schema(conn)
            if version == 0:
                conn.execute("PRAGMA user_version = 1")
            apply_pending_migrations(conn)

    @staticmethod
    def _migrate_schema_v1_to_v2(conn: sqlite3.Connection) -> None:
        migrate_v1_to_v2(conn)

    @staticmethod
    def _migrate_schema_v2_to_v3(conn: sqlite3.Connection) -> None:
        migrate_v2_to_v3(conn)

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
