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
        } >= {"jobs", "llm_cache", "llm_usage", "app_settings"}
        assert "device_id" not in {
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
