from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.core.config import Settings
from app.repositories.migrations import CURRENT_SCHEMA_VERSION, MIGRATIONS, migrate_v5_to_v6
from app.repositories.schema_base import BASE_SCHEMA_SQL
from app.repositories.schema_compat import ensure_legacy_schema
from app.services.repository import SQLiteRepository


def _settings(tmp_path: Path) -> Settings:
    return Settings(object_storage_path=str(tmp_path))


def _build_old_database(path: Path, *, version: int, old_tts_layout: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, autocommit=True)) as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript(BASE_SCHEMA_SQL)
        ensure_legacy_schema(conn)
        if old_tts_layout:
            for column in ("tts_connection_id", "tts_model_name", "tts_playback_policy"):
                conn.execute(f"ALTER TABLE sessions DROP COLUMN {column}")
        conn.execute("PRAGMA user_version = 1")
        conn.execute(
            """INSERT INTO owner_sessions(id, token_hash, expires_at, created_at)
               VALUES ('browser', ?, '2099-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')""",
            (SQLiteRepository.hash_token("existing-browser-token"),),
        )
    for migration in MIGRATIONS:
        if migration.target_version > version:
            break
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            migration.apply(conn)


def _schema(path: Path) -> list[tuple]:
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5, 6, 7, 10, 11, 12])
def test_can_upgrade_from_each_published_schema_and_reopen(tmp_path: Path, version: int) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=version)
    repository = SQLiteRepository(settings)
    assert repository.get_owner_session("existing-browser-token") is not None
    state = _schema(settings.metadata_db_path)
    with repository.connection() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []

    removed_tables = {
        "pairing_challenges", "trusted_devices", "local_metric_events",
        "classroom_states", "classroom_flashcards",
    }
    assert {name for _, name, _ in state}.isdisjoint(removed_tables)
    assert {"jobs", "llm_cache", "llm_usage", "app_settings"} <= {name for _, name, _ in state}
    backup = settings.metadata_db_path.with_name(f"companion.db.v{version}.bak")
    with closing(sqlite3.connect(backup)) as saved:
        assert saved.execute("PRAGMA user_version").fetchone()[0] == version
        assert saved.execute("SELECT id FROM owner_sessions").fetchone() == ("browser",)
    SQLiteRepository(settings)
    assert _schema(settings.metadata_db_path) == state


def test_v5_and_fresh_schema_match_and_migration_drops_old_mobile_auth(tmp_path: Path) -> None:
    settings = _settings(tmp_path / "upgraded")
    _build_old_database(settings.metadata_db_path, version=5)
    with closing(sqlite3.connect(settings.metadata_db_path)) as conn:
        with conn:
            conn.execute(
                """INSERT INTO owner_sessions(id, token_hash, expires_at, created_at, device_id)
                   VALUES ('retired', ?, '2099-01-01T00:00:00+00:00', '2026-01-01', 'retired-phone')""",
                (SQLiteRepository.hash_token("old-mobile-token"),),
            )
            conn.execute(
                """INSERT INTO realtime_tickets(id, token_hash, owner_session_id, session_id, expires_at, created_at)
                   VALUES ('retired-ticket', ?, 'retired', 'lesson', '2099-01-01T00:00:00+00:00', '2026-01-01')""",
                (SQLiteRepository.hash_token("old-ticket"),),
            )
    upgraded = SQLiteRepository(settings)
    assert upgraded.get_owner_session("old-mobile-token") is None
    assert upgraded.get_realtime_ticket("old-ticket") is None
    assert upgraded.get_owner_session("existing-browser-token") is not None
    fresh = SQLiteRepository(_settings(tmp_path / "fresh"))
    assert _schema(upgraded.settings.metadata_db_path) == _schema(fresh.settings.metadata_db_path)


def test_v7_keeps_in_progress_ingestion_and_original_material_metadata(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=6)
    now = "2026-11-17T00:00:00+00:00"
    with closing(sqlite3.connect(settings.metadata_db_path)) as conn, conn:
        conn.execute(
            "INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at) VALUES ('s', 'Course', '', '', ?, ?)",
            (now, now),
        )
        conn.execute(
            """INSERT INTO materials(id, space_id, title, kind, filename, storage_path, created_at, updated_at)
               VALUES ('m', 's', 'My note', 'note', 'note.md', 'spaces/s/materials/m.md', ?, ?)""",
            (now, now),
        )
        conn.execute(
            """INSERT INTO ingestion_jobs(id, space_id, material_id, status, created_at, updated_at)
               VALUES ('j', 's', 'm', 'processing', ?, ?)""",
            (now, now),
        )
    repository = SQLiteRepository(settings)
    with repository.connection() as conn:
        material = conn.execute("SELECT filename, storage_path, role, parse_status FROM materials").fetchone()
        assert tuple(material) == ("note.md", "spaces/s/materials/m.md", "notes", "pending")
        job = conn.execute("SELECT id, space_id, material_id, kind, status FROM jobs").fetchone()
        assert tuple(job) == ("j", "s", "m", "parse", "queued")
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'ingestion_jobs'").fetchone()


def test_backup_includes_committed_wal_and_is_never_replaced(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=5)
    wal_connection = sqlite3.connect(settings.metadata_db_path, autocommit=True)
    try:
        wal_connection.execute("PRAGMA journal_mode=WAL")
        wal_connection.execute("PRAGMA wal_autocheckpoint=0")
        wal_connection.execute("CREATE TABLE saved_before_upgrade (report TEXT)")
        wal_connection.execute("INSERT INTO saved_before_upgrade VALUES ('committed in WAL')")
        SQLiteRepository(settings)
        backup = settings.metadata_db_path.with_name("companion.db.v5.bak")
        with closing(sqlite3.connect(backup)) as saved:
            assert saved.execute("SELECT report FROM saved_before_upgrade").fetchone() == ("committed in WAL",)
        original_bytes = backup.read_bytes()
        settings2 = _settings(tmp_path / "retry")
        _build_old_database(settings2.metadata_db_path, version=5)
        retry_backup = settings2.metadata_db_path.with_name("companion.db.v5.bak")
        retry_backup.write_bytes(original_bytes)
        SQLiteRepository(settings2)
        assert retry_backup.read_bytes() == original_bytes
    finally:
        wal_connection.close()


def test_backup_failure_aborts_before_schema_mutation(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=5)
    original_schema = _schema(settings.metadata_db_path)
    settings.metadata_db_path.with_name("companion.db.v5.bak").mkdir()
    with pytest.raises(RuntimeError, match="Unable to back up SQLite schema v5"):
        SQLiteRepository(settings)
    assert _schema(settings.metadata_db_path) == original_schema
    with closing(sqlite3.connect(settings.metadata_db_path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 5


def test_old_v1_sessions_receive_nullable_tts_snapshot_columns(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=1, old_tts_layout=True)
    with closing(sqlite3.connect(settings.metadata_db_path)) as conn, conn:
        conn.execute(
            """INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at)
               VALUES ('course', 'Saved course', '', '', '2026-01-01', '2026-01-01')"""
        )
        conn.execute(
            """INSERT INTO sessions(id, space_id, state, summary, created_at, updated_at)
               VALUES ('lesson', 'course', 'idle', '', '2026-01-01', '2026-01-01')"""
        )
    repository = SQLiteRepository(settings)
    with repository.connection() as conn:
        row = conn.execute(
            "SELECT tts_connection_id, tts_model_name, tts_playback_policy FROM sessions WHERE id = 'lesson'"
        ).fetchone()
    assert tuple(row) == (None, None, None)


def test_v6_removes_only_retired_provider_assignments_without_requiring_cascade(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _build_old_database(settings.metadata_db_path, version=5)
    with closing(sqlite3.connect(settings.metadata_db_path)) as conn, conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute(
            """INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at)
               VALUES ('course', 'Existing course', '', '', '2026-01-01', '2026-01-01')"""
        )
        conn.executemany(
            """INSERT INTO provider_connections(id, provider, label, capabilities_json, created_at, updated_at)
               VALUES (?, ?, ?, '[]', '2026-01-01', '2026-01-01')""",
            [
                ("retired", "mock", "Retired connection"),
                ("existing", "openai-compatible", "Existing connection"),
            ],
        )
        conn.executemany(
            """INSERT INTO model_assignments(
                   id, space_id, capability, provider_connection_id, model_name, created_at, updated_at
               ) VALUES (?, 'course', ?, ?, 'configured-by-owner', '2026-01-01', '2026-01-01')""",
            [("obsolete", "chat_llm", "retired"), ("preserved", "analysis_llm", "existing")],
        )
        migrate_v5_to_v6(conn)
        assert conn.execute("SELECT id FROM provider_connections").fetchall() == [("existing",)]
        assert conn.execute("SELECT id FROM model_assignments").fetchall() == [("preserved",)]
