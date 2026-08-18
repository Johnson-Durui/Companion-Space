from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path

import pytest
from app.core.config import Settings
from app.services.repository import CURRENT_SCHEMA_VERSION, SQLiteRepository
from app.sqlite_maintenance import (
    CheckpointBusyError,
    SQLiteMaintenanceError,
    backup_database,
    checkpoint_database,
)


def _database(tmp_path: Path) -> tuple[Settings, Path]:
    settings = Settings(object_storage_path=str(tmp_path / "storage"))
    SQLiteRepository(settings)
    with sqlite3.connect(settings.metadata_db_path) as conn:
        conn.execute("CREATE TABLE backup_probe(value TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO backup_probe(value) VALUES ('committed-before')")
    return settings, settings.metadata_db_path


def test_online_backup_captures_committed_wal_snapshot(tmp_path: Path) -> None:
    settings, db_path = _database(tmp_path)
    reader = sqlite3.connect(db_path)
    reader.execute("BEGIN")
    assert reader.execute("SELECT COUNT(*) FROM backup_probe").fetchone()[0] == 1
    with sqlite3.connect(db_path) as writer:
        writer.execute("INSERT INTO backup_probe(value) VALUES ('committed-in-wal')")

    destination = tmp_path / "backups" / "companion.db"
    destination.parent.mkdir()
    result = backup_database(
        db_path,
        destination,
        busy_timeout_ms=settings.sqlite_busy_timeout_ms,
    )
    reader.close()

    assert result.destination == destination.resolve()
    assert result.user_version == CURRENT_SCHEMA_VERSION
    assert result.integrity_check == "ok"
    assert result.foreign_key_violation_count == 0
    with sqlite3.connect(destination) as restored:
        assert restored.execute(
            "SELECT value FROM backup_probe ORDER BY value"
        ).fetchall() == [("committed-before",), ("committed-in-wal",)]


def test_online_backup_excludes_uncommitted_transaction(tmp_path: Path) -> None:
    settings, db_path = _database(tmp_path)
    writer = sqlite3.connect(db_path)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("INSERT INTO backup_probe(value) VALUES ('not-committed-yet')")
    destination = tmp_path / "backups" / "companion.db"
    destination.parent.mkdir()

    backup_database(
        db_path,
        destination,
        busy_timeout_ms=settings.sqlite_busy_timeout_ms,
    )

    with sqlite3.connect(destination) as restored:
        assert restored.execute(
            "SELECT value FROM backup_probe ORDER BY value"
        ).fetchall() == [("committed-before",)]
    writer.commit()
    writer.close()
    with sqlite3.connect(db_path) as source:
        assert source.execute("SELECT COUNT(*) FROM backup_probe").fetchone()[0] == 2


def test_truncate_checkpoint_reports_busy_reader(tmp_path: Path) -> None:
    _, db_path = _database(tmp_path)
    checkpoint_database(db_path, mode="TRUNCATE", busy_timeout_ms=500)
    reader = sqlite3.connect(db_path)
    reader.execute("BEGIN")
    assert reader.execute("SELECT COUNT(*) FROM backup_probe").fetchone()[0] == 1
    with sqlite3.connect(db_path) as writer:
        writer.execute("INSERT INTO backup_probe(value) VALUES ('new-wal-page')")

    with pytest.raises(CheckpointBusyError) as caught:
        checkpoint_database(db_path, mode="TRUNCATE", busy_timeout_ms=50)
    assert caught.value.result.busy != 0

    reader.close()
    result = checkpoint_database(db_path, mode="TRUNCATE", busy_timeout_ms=500)
    assert result.busy == 0
    assert result.mode == "TRUNCATE"
    wal_path = db_path.with_name(f"{db_path.name}-wal")
    assert not wal_path.exists() or wal_path.stat().st_size == 0


def test_backup_never_overwrites_existing_destination(tmp_path: Path) -> None:
    settings, db_path = _database(tmp_path)
    destination = tmp_path / "backups" / "companion.db"
    destination.parent.mkdir()
    destination.write_bytes(b"keep-existing-backup")

    with pytest.raises(FileExistsError):
        backup_database(
            db_path,
            destination,
            busy_timeout_ms=settings.sqlite_busy_timeout_ms,
        )

    assert destination.read_bytes() == b"keep-existing-backup"


def test_backup_preserves_future_schema_without_initializing_it(tmp_path: Path) -> None:
    storage = tmp_path / "storage"
    storage.mkdir()
    db_path = storage / "companion.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE future_only(value TEXT NOT NULL)")
        conn.execute("INSERT INTO future_only(value) VALUES ('future-data')")
        conn.execute("PRAGMA user_version = 2")
    destination = tmp_path / "backups" / "companion.db"
    destination.parent.mkdir()

    result = backup_database(db_path, destination, busy_timeout_ms=100)

    assert result.user_version == 2
    with sqlite3.connect(destination) as restored:
        assert restored.execute("PRAGMA user_version").fetchone()[0] == 2
        assert restored.execute("SELECT value FROM future_only").fetchone()[0] == "future-data"
        assert restored.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'study_spaces'"
        ).fetchone()[0] == 0


def test_backup_rejects_linked_destination_parent(tmp_path: Path) -> None:
    settings, db_path = _database(tmp_path)
    real_destination = tmp_path / "real-backups"
    real_destination.mkdir()
    linked_destination = tmp_path / "linked-backups"
    if os.name == "nt":
        subprocess.run(
            [
                "cmd.exe",
                "/d",
                "/c",
                "mklink",
                "/j",
                str(linked_destination),
                str(real_destination),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert linked_destination.is_junction()
    else:
        linked_destination.symlink_to(real_destination, target_is_directory=True)

    with pytest.raises(SQLiteMaintenanceError, match="symlink or junction"):
        backup_database(
            db_path,
            linked_destination / "companion.db",
            busy_timeout_ms=settings.sqlite_busy_timeout_ms,
        )

    assert not (real_destination / "companion.db").exists()


def test_backup_validation_failure_does_not_publish_destination(
    tmp_path: Path,
) -> None:
    storage = tmp_path / "storage"
    storage.mkdir()
    db_path = storage / "companion.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            PRAGMA foreign_keys = OFF;
            CREATE TABLE parent(id INTEGER PRIMARY KEY);
            CREATE TABLE child(
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES parent(id)
            );
            INSERT INTO child(id, parent_id) VALUES (1, 999);
            PRAGMA user_version = 2;
            """
        )
    destination = tmp_path / "backups" / "companion.db"
    destination.parent.mkdir()

    with pytest.raises(SQLiteMaintenanceError, match="foreign key"):
        backup_database(db_path, destination, busy_timeout_ms=100)

    assert not destination.exists()
    assert list(destination.parent.glob("*.partial-*"))
    with sqlite3.connect(db_path) as source:
        assert source.execute("PRAGMA user_version").fetchone()[0] == 2
        assert source.execute("SELECT parent_id FROM child").fetchone()[0] == 999
