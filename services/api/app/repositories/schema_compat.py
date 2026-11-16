from __future__ import annotations

import sqlite3

from app.repositories.mixins.common import _fts_sparse_terms_expression


def ensure_legacy_schema(conn: sqlite3.Connection) -> None:
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
