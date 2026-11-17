import sqlite3

from app.services.repository import SQLiteRepository


def test_repository_migrates_legacy_turns_table_with_board_actions_column(isolated_settings) -> None:
    isolated_settings.storage_root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE study_spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                topic TEXT NOT NULL,
                goal TEXT NOT NULL,
                default_character_pack_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                character_pack_id TEXT,
                state TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                ended_at TEXT
            );
            CREATE TABLE turns (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                space_id TEXT NOT NULL,
                role TEXT NOT NULL,
                display_text TEXT NOT NULL,
                spoken_text TEXT NOT NULL,
                emotion TEXT NOT NULL,
                citations_json TEXT NOT NULL,
                suggested_actions_json TEXT NOT NULL,
                usage_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO study_spaces VALUES ('space', 'Space', '', '', NULL, '2026-01-01', '2026-01-01');
            INSERT INTO sessions VALUES ('session', 'space', NULL, 'idle', '', '2026-01-01', '2026-01-01', NULL);
            INSERT INTO turns VALUES (
                'turn',
                'session',
                'space',
                'assistant',
                '旧回复',
                '旧回复',
                'warm',
                '[]',
                '[]',
                '{"input_tokens":1,"output_tokens":1,"audio_input_bytes":0,"audio_output_bytes":0}',
                '2026-01-01'
            );
            """
        )

    repository = SQLiteRepository(isolated_settings)
    turns = repository.list_turns("session")

    assert len(turns) == 1
    assert turns[0].board_actions == []
    with sqlite3.connect(isolated_settings.metadata_db_path) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(turns)").fetchall()
        }
        row = connection.execute(
            "SELECT board_actions_json, created_at FROM turns WHERE id = ?",
            ("turn",),
        ).fetchone()
    assert "board_actions_json" in columns
    assert row == ("[]", "2026-01-01")
