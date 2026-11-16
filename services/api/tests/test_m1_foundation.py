from __future__ import annotations

import sqlite3
from pathlib import Path

from app.core.config import Settings
from app.repositories.migrations import CURRENT_SCHEMA_VERSION
from app.services.repository import SQLiteRepository


def _settings(tmp_path: Path) -> Settings:
    return Settings(object_storage_path=str(tmp_path / "storage"))


def test_schema_v4_adds_classroom_tables_without_losing_existing_data(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    repository = SQLiteRepository(settings)
    repository.put_owner_session(session_id="preserved", token="owner-token")

    with sqlite3.connect(settings.metadata_db_path) as connection:
        connection.executescript(
            """
            DROP INDEX idx_classroom_flashcards_space_due;
            DROP TABLE classroom_flashcards;
            DROP TABLE classroom_states;
            PRAGMA user_version = 4;
            """
        )

    migrated = SQLiteRepository(settings)

    with sqlite3.connect(settings.metadata_db_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == (
            CURRENT_SCHEMA_VERSION
        )
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert {"classroom_states", "classroom_flashcards"} <= tables
    assert migrated.get_owner_session("owner-token") is not None
