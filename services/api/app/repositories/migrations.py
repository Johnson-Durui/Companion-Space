from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass

CURRENT_SCHEMA_VERSION = 5


@dataclass(frozen=True)
class Migration:
    source_version: int
    target_version: int
    apply: Callable[[sqlite3.Connection], None]


def _execute(conn: sqlite3.Connection, statements: tuple[str, ...]) -> None:
    for statement in statements:
        conn.execute(statement)


def migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        """CREATE TABLE pairing_challenges (
            id TEXT PRIMARY KEY, code_hash TEXT NOT NULL,
            attempts_remaining INTEGER NOT NULL CHECK(attempts_remaining >= 0),
            expires_at TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
        "CREATE INDEX idx_pairing_challenges_expires_at ON pairing_challenges(expires_at)",
        """CREATE TABLE trusted_devices (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            refresh_token_hash TEXT NOT NULL UNIQUE,
            refresh_expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )""",
        "CREATE INDEX idx_trusted_devices_refresh_expires_at ON trusted_devices(refresh_expires_at)",
        "ALTER TABLE owner_sessions ADD COLUMN device_id TEXT",
        "CREATE INDEX idx_owner_sessions_device_id ON owner_sessions(device_id)",
    ))
    conn.execute("PRAGMA user_version = 2")


def migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        "ALTER TABLE trusted_devices ADD COLUMN previous_refresh_token_hash TEXT",
        "ALTER TABLE trusted_devices ADD COLUMN previous_refresh_expires_at TEXT",
        """ALTER TABLE trusted_devices ADD COLUMN
            previous_refresh_uses_remaining INTEGER NOT NULL DEFAULT 0
            CHECK(previous_refresh_uses_remaining >= 0)""",
        """CREATE UNIQUE INDEX idx_trusted_devices_previous_refresh_token_hash
            ON trusted_devices(previous_refresh_token_hash)
            WHERE previous_refresh_token_hash IS NOT NULL""",
    ))
    conn.execute("PRAGMA user_version = 3")


def migrate_v3_to_v4(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
    additions = {
        "tts_connection_id": "ALTER TABLE sessions ADD COLUMN tts_connection_id TEXT",
        "tts_model_name": "ALTER TABLE sessions ADD COLUMN tts_model_name TEXT",
        "tts_playback_policy": "ALTER TABLE sessions ADD COLUMN tts_playback_policy TEXT",
    }
    for name, statement in additions.items():
        if name not in columns:
            conn.execute(statement)
    conn.execute("PRAGMA user_version = 4")


def migrate_v4_to_v5(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        """CREATE TABLE IF NOT EXISTS classroom_states (
            session_id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE IF NOT EXISTS classroom_flashcards (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            answer TEXT NOT NULL,
            status TEXT NOT NULL,
            due_at TEXT,
            fsrs_card_json TEXT,
            citations_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
            FOREIGN KEY(source_session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )""",
        """CREATE INDEX IF NOT EXISTS idx_classroom_flashcards_space_due
            ON classroom_flashcards(space_id, status, due_at)""",
    ))
    conn.execute("PRAGMA user_version = 5")


MIGRATIONS = (
    Migration(1, 2, migrate_v1_to_v2),
    Migration(2, 3, migrate_v2_to_v3),
    Migration(3, 4, migrate_v3_to_v4),
    Migration(4, 5, migrate_v4_to_v5),
)


def apply_pending_migrations(conn: sqlite3.Connection) -> None:
    by_source = {migration.source_version: migration for migration in MIGRATIONS}
    while True:
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        migration = by_source.get(version)
        if migration is None:
            return
        migration.apply(conn)
        resulting_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if resulting_version != migration.target_version:
            raise RuntimeError(
                f"Migration {migration.source_version}->{migration.target_version} "
                f"ended at schema version {resulting_version}"
            )
