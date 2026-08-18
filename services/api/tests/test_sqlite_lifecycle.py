from __future__ import annotations

import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from app.core.config import Settings
from app.services import repository as repository_module
from app.services.repository import CURRENT_SCHEMA_VERSION, SQLiteRepository


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    return Settings(
        object_storage_path=str(tmp_path / "storage"),
        **overrides,
    )


def test_fresh_database_sets_schema_version_and_wal_mode(tmp_path: Path) -> None:
    settings = _settings(tmp_path)

    SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        } >= {"pairing_challenges", "trusted_devices"}
        assert "device_id" in {
            row[1] for row in conn.execute("PRAGMA table_info(owner_sessions)")
        }


def test_future_schema_fails_before_any_database_mutation(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    settings.storage_root.mkdir(parents=True)
    with sqlite3.connect(settings.metadata_db_path) as conn:
        conn.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
        conn.execute("INSERT INTO sentinel(value) VALUES ('preserve-me')")
        conn.execute(f"PRAGMA user_version = {CURRENT_SCHEMA_VERSION + 1}")
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"

    with pytest.raises(
        RuntimeError,
        match=rf"schema version {CURRENT_SCHEMA_VERSION + 1}.*supported version {CURRENT_SCHEMA_VERSION}",
    ):
        SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION + 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert conn.execute("SELECT value FROM sentinel").fetchone()[0] == "preserve-me"
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert tables == {"sentinel"}
    assert not settings.metadata_db_path.with_name(
        f"{settings.metadata_db_path.name}-wal"
    ).exists()
    assert not settings.metadata_db_path.with_name(
        f"{settings.metadata_db_path.name}-shm"
    ).exists()


def test_schema_version_is_rechecked_under_the_migration_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    SQLiteRepository(settings)
    original_schema_version = SQLiteRepository._schema_version
    first_read = True

    def upgrade_after_first_read(conn: sqlite3.Connection) -> int:
        nonlocal first_read
        version = original_schema_version(conn)
        if first_read:
            first_read = False
            with sqlite3.connect(settings.metadata_db_path) as newer:
                newer.execute(f"PRAGMA user_version = {CURRENT_SCHEMA_VERSION + 1}")
        return version

    monkeypatch.setattr(
        SQLiteRepository,
        "_schema_version",
        staticmethod(upgrade_after_first_read),
    )

    with pytest.raises(
        RuntimeError,
        match=rf"schema version {CURRENT_SCHEMA_VERSION + 1}.*supported version {CURRENT_SCHEMA_VERSION}",
    ):
        SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION + 1


def test_schema_v1_migrates_explicitly_to_current_without_losing_owner_sessions(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    repository = SQLiteRepository(settings)
    repository.put_owner_session(session_id="preserved", token="owner-token")
    with sqlite3.connect(settings.metadata_db_path) as conn:
        conn.executescript(
            """
            DROP INDEX idx_owner_sessions_device_id;
            DROP TABLE pairing_challenges;
            DROP TABLE trusted_devices;
            ALTER TABLE owner_sessions RENAME TO owner_sessions_v2;
            CREATE TABLE owner_sessions (
                id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO owner_sessions(id, token_hash, expires_at, created_at)
            SELECT id, token_hash, expires_at, created_at FROM owner_sessions_v2;
            DROP TABLE owner_sessions_v2;
            PRAGMA user_version = 1;
            """
        )

    migrated = SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION
        assert conn.execute(
            "SELECT id FROM owner_sessions WHERE id = 'preserved'"
        ).fetchone() == ("preserved",)
        assert {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        } >= {"pairing_challenges", "trusted_devices"}
    assert migrated.get_owner_session("owner-token") is not None


def test_schema_v2_migrates_refresh_recovery_columns_without_losing_devices(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    repository = SQLiteRepository(settings)
    device = repository.create_trusted_device(
        device_id="preserved-device",
        name="Preserved phone",
        refresh_token="preserved-refresh-token",
        ttl_seconds=600,
    )
    with sqlite3.connect(settings.metadata_db_path) as conn:
        conn.executescript(
            """
            DROP INDEX idx_trusted_devices_previous_refresh_token_hash;
            DROP INDEX idx_trusted_devices_refresh_expires_at;
            ALTER TABLE trusted_devices RENAME TO trusted_devices_v3;
            CREATE TABLE trusted_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                refresh_token_hash TEXT NOT NULL UNIQUE,
                refresh_expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );
            INSERT INTO trusted_devices(
                id, name, refresh_token_hash, refresh_expires_at,
                created_at, last_seen_at
            )
            SELECT id, name, refresh_token_hash, refresh_expires_at,
                   created_at, last_seen_at
            FROM trusted_devices_v3;
            DROP TABLE trusted_devices_v3;
            CREATE INDEX idx_trusted_devices_refresh_expires_at
                ON trusted_devices(refresh_expires_at);
            PRAGMA user_version = 2;
            """
        )

    migrated = SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(trusted_devices)")
        }
        stored_hash = conn.execute(
            "SELECT refresh_token_hash FROM trusted_devices WHERE id = ?",
            (device.id,),
        ).fetchone()
    assert {
        "previous_refresh_token_hash",
        "previous_refresh_expires_at",
        "previous_refresh_uses_remaining",
    } <= columns
    assert stored_hash == (device.refresh_token_hash,)
    assert migrated.list_trusted_devices()[0].id == device.id


def test_failed_schema_migration_rolls_back_every_schema_change(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    settings.storage_root.mkdir(parents=True)
    with sqlite3.connect(settings.metadata_db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE model_assignments (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                capability TEXT NOT NULL,
                provider_connection_id TEXT NOT NULL,
                model_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO model_assignments VALUES
                ('first', 'space', 'chat_llm', 'provider', 'model', 'now', 'now'),
                ('second', 'space', 'chat_llm', 'provider', 'model', 'now', 'now');
            CREATE TRIGGER reject_assignment_delete
            BEFORE DELETE ON model_assignments
            BEGIN
                SELECT RAISE(ABORT, 'synthetic schema migration failure');
            END;
            """
        )
        original_schema = conn.execute(
            """
            SELECT type, name, sql
            FROM sqlite_master
            ORDER BY type, name
            """
        ).fetchall()

    with pytest.raises(sqlite3.IntegrityError, match="synthetic schema migration failure"):
        SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert conn.execute(
            """
            SELECT type, name, sql
            FROM sqlite_master
            ORDER BY type, name
            """
        ).fetchall() == original_schema
        assert {
            row[1] for row in conn.execute("PRAGMA table_info(model_assignments)")
        } == {
            "id",
            "space_id",
            "capability",
            "provider_connection_id",
            "model_name",
            "created_at",
            "updated_at",
        }
        assert conn.execute(
            "SELECT id FROM model_assignments ORDER BY id"
        ).fetchall() == [("first",), ("second",)]


def test_connection_uses_configured_busy_timeout(tmp_path: Path) -> None:
    settings = _settings(tmp_path, sqlite_busy_timeout_ms=750)
    repository = SQLiteRepository(settings)

    with repository.connection() as conn:
        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]

    assert busy_timeout == 750


def test_busy_timeout_is_applied_before_the_migration_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path, sqlite_busy_timeout_ms=500)
    settings.storage_root.mkdir(parents=True)
    real_connect = sqlite3.connect
    with real_connect(settings.metadata_db_path) as conn:
        assert conn.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal"
    locker = real_connect(settings.metadata_db_path, autocommit=True)
    locker.execute("BEGIN IMMEDIATE")
    connection_opened = Event()

    def connect_without_native_wait(*args, **kwargs):
        kwargs["timeout"] = 0
        conn = real_connect(*args, **kwargs)
        connection_opened.set()
        return conn

    monkeypatch.setattr(repository_module.sqlite3, "connect", connect_without_native_wait)
    with ThreadPoolExecutor(max_workers=1) as executor:
        repository_future = executor.submit(SQLiteRepository, settings)
        assert connection_opened.wait(timeout=1)
        time.sleep(0.1)
        locker.execute("COMMIT")
        repository = repository_future.result(timeout=1)
    locker.close()

    with repository.connection() as conn:
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 500
