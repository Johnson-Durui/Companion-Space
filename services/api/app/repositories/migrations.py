from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass

CURRENT_SCHEMA_VERSION = 10


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


def migrate_v5_to_v6(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        """DELETE FROM realtime_tickets WHERE owner_session_id IN (
                SELECT id FROM owner_sessions WHERE device_id IS NOT NULL)""",
        "DELETE FROM owner_sessions WHERE device_id IS NOT NULL",
        """DELETE FROM model_assignments
           WHERE is_bootstrap_default = 1 OR provider_connection_id IN (
               SELECT id FROM provider_connections WHERE provider = 'mock'
           )""",
        "DELETE FROM provider_connections WHERE provider = 'mock'",
        "DROP TABLE IF EXISTS pairing_challenges",
        "DROP TABLE IF EXISTS trusted_devices",
        "DROP TABLE IF EXISTS local_metric_events",
        "DROP TABLE IF EXISTS classroom_states",
        "DROP TABLE IF EXISTS classroom_flashcards",
        "DROP INDEX IF EXISTS idx_owner_sessions_device_id",
        "ALTER TABLE owner_sessions DROP COLUMN device_id",
        "ALTER TABLE owner_preferences DROP COLUMN adult_relationships_enabled",
        "ALTER TABLE owner_preferences DROP COLUMN adult_age_confirmed_at",
        "ALTER TABLE model_assignments DROP COLUMN is_bootstrap_default",
        """CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            space_id TEXT REFERENCES study_spaces(id) ON DELETE CASCADE,
            material_id TEXT REFERENCES materials(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            stage TEXT,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            detail TEXT,
            payload_json TEXT,
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX idx_jobs_space_id ON jobs(space_id)",
        "CREATE INDEX idx_jobs_material_id ON jobs(material_id)",
        "CREATE INDEX idx_jobs_status ON jobs(status, created_at)",
        """CREATE TABLE llm_cache (
            key TEXT PRIMARY KEY, model TEXT NOT NULL, response TEXT NOT NULL,
            tokens_in INTEGER, tokens_out INTEGER, created_at TEXT NOT NULL
        )""",
        """CREATE TABLE llm_usage (
            day TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
            calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
            PRIMARY KEY(day, role, model)
        )""",
        """CREATE TABLE app_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
    ))
    conn.execute("PRAGMA user_version = 6")


def migrate_v6_to_v7(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        "ALTER TABLE study_spaces ADD COLUMN brief_json TEXT",
        "ALTER TABLE materials ADD COLUMN role TEXT NOT NULL DEFAULT 'textbook'",
        "UPDATE materials SET role = 'notes' WHERE kind = 'note'",
        "ALTER TABLE materials ADD COLUMN meta_json TEXT",
        "ALTER TABLE materials ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'pending'",
        "ALTER TABLE chunks ADD COLUMN section_id TEXT",
        "ALTER TABLE chunks ADD COLUMN page_no INTEGER",
        "ALTER TABLE chunks ADD COLUMN embedding BLOB",
        "ALTER TABLE chunks ADD COLUMN embedding_model TEXT",
        """CREATE TABLE material_pages (
            material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
            page_no INTEGER NOT NULL, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            markdown TEXT NOT NULL, source TEXT NOT NULL, quality REAL NOT NULL DEFAULT 1,
            image_path TEXT, PRIMARY KEY (material_id, page_no)
        )""",
        """CREATE TABLE material_sections (
            id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
            space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES material_sections(id) ON DELETE CASCADE,
            level INTEGER NOT NULL, title TEXT NOT NULL, page_start INTEGER NOT NULL,
            page_end INTEGER NOT NULL, ord INTEGER NOT NULL
        )""",
        """CREATE TABLE units (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL, ord INTEGER NOT NULL
        )""",
        """CREATE TABLE knowledge_points (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            unit_id TEXT REFERENCES units(id) ON DELETE SET NULL, name TEXT NOT NULL, norm_name TEXT NOT NULL,
            kind TEXT NOT NULL, summary TEXT NOT NULL, must_know_json TEXT, formula TEXT,
            pitfalls_json TEXT, question_types_json TEXT, importance TEXT NOT NULL, difficulty INTEGER NOT NULL,
            assumed INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL, source_refs_json TEXT,
            locked_fields_json TEXT, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE kp_edges (
            space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            from_kp TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
            to_kp TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
            source TEXT NOT NULL, PRIMARY KEY (from_kp, to_kp)
        )""",
        """CREATE TABLE exam_papers (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            material_id TEXT NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
            name TEXT, year INTEGER, term TEXT, full_score REAL, reserved_for_mock INTEGER NOT NULL DEFAULT 0
        )""",
        """CREATE TABLE exam_items (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            paper_id TEXT REFERENCES exam_papers(id) ON DELETE CASCADE,
            material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
            parent_item_id TEXT REFERENCES exam_items(id) ON DELETE CASCADE, no TEXT,
            type TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT, answer TEXT, solution TEXT,
            score REAL, difficulty INTEGER, answer_status TEXT NOT NULL, page_refs_json TEXT,
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE item_kp (
            item_id TEXT NOT NULL REFERENCES exam_items(id) ON DELETE CASCADE,
            kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
            confidence TEXT NOT NULL, PRIMARY KEY (item_id, kp_id)
        )""",
        """CREATE TABLE kp_exam_stats (
            kp_id TEXT PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
            space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            n_items INTEGER NOT NULL, score_share REAL NOT NULL, recency_weight REAL NOT NULL,
            trend TEXT NOT NULL, types_json TEXT, novel_json TEXT, weight REAL NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE item_bank (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
            kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
            origin TEXT NOT NULL, exam_item_id TEXT REFERENCES exam_items(id) ON DELETE CASCADE,
            purpose TEXT NOT NULL, type TEXT NOT NULL, difficulty INTEGER, variant_of TEXT,
            item_json TEXT NOT NULL, verify_status TEXT NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )""",
        "CREATE INDEX idx_kps_space ON knowledge_points(space_id, status, ord)",
        "CREATE INDEX idx_units_space ON units(space_id, ord)",
        "CREATE INDEX idx_exam_items_space ON exam_items(space_id, paper_id)",
        "CREATE INDEX idx_item_kp_kp ON item_kp(kp_id)",
        "CREATE INDEX idx_item_bank_space ON item_bank(space_id, kp_id, purpose, reserved)",
        "CREATE INDEX idx_sections_material ON material_sections(material_id, ord)",
        "CREATE INDEX idx_chunk_page ON chunks(space_id, material_id, page_no)",
        """INSERT INTO jobs(id, space_id, material_id, kind, status, created_at, updated_at)
           SELECT id, space_id, material_id, 'parse', 'queued', created_at, updated_at
           FROM ingestion_jobs WHERE status IN ('queued', 'processing')""",
        "DROP TABLE ingestion_jobs",
        "DROP TRIGGER IF EXISTS chunks_fts_after_insert",
        "DROP TRIGGER IF EXISTS chunks_fts_after_update",
        "DROP TRIGGER IF EXISTS chunks_fts_after_delete",
        "DROP TABLE IF EXISTS chunks_fts",
        """CREATE VIRTUAL TABLE chunks_fts USING fts5(
            chunk_id UNINDEXED, space_id UNINDEXED, material_id UNINDEXED,
            title, locator, search_terms, content, tokenize='trigram'
        )""",
        """CREATE TRIGGER chunks_fts_after_insert AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts VALUES (new.id, new.space_id, new.material_id, new.title,
                new.locator, new.sparse_terms, new.content);
        END""",
        """CREATE TRIGGER chunks_fts_after_update AFTER UPDATE ON chunks BEGIN
            DELETE FROM chunks_fts WHERE chunk_id = old.id;
            INSERT INTO chunks_fts VALUES (new.id, new.space_id, new.material_id, new.title,
                new.locator, new.sparse_terms, new.content);
        END""",
        """CREATE TRIGGER chunks_fts_after_delete AFTER DELETE ON chunks BEGIN
            DELETE FROM chunks_fts WHERE chunk_id = old.id;
        END""",
        """INSERT INTO chunks_fts SELECT id, space_id, material_id, title, locator,
            sparse_terms, content FROM chunks""",
    ))
    conn.execute("PRAGMA user_version = 7")


def migrate_v7_to_v8(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        """CREATE TABLE learner_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            profile_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE course_enrollment (
            space_id TEXT PRIMARY KEY,
            enrollment_json TEXT NOT NULL,
            interview_status TEXT NOT NULL DEFAULT 'todo',
            placement_status TEXT NOT NULL DEFAULT 'todo',
            updated_at TEXT NOT NULL,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE kp_mastery (
            space_id TEXT NOT NULL, kp_id TEXT NOT NULL, p REAL NOT NULL,
            status TEXT NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0,
            clean_correct_count INTEGER NOT NULL DEFAULT 0, clean_days INTEGER NOT NULL DEFAULT 0,
            last_clean_day TEXT, objective_clean INTEGER NOT NULL DEFAULT 0,
            inferred INTEGER NOT NULL DEFAULT 0, taught_at TEXT, last_evidence_at TEXT,
            PRIMARY KEY (space_id, kp_id),
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE evidence (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT NOT NULL,
            lesson_id TEXT, item_ref TEXT, source TEXT NOT NULL, verdict TEXT NOT NULL,
            hint_level INTEGER NOT NULL DEFAULT 0, item_type TEXT, n_options INTEGER,
            judged_by TEXT, via TEXT, retry INTEGER NOT NULL DEFAULT 0,
            p_before REAL NOT NULL, p_after REAL NOT NULL, detail_json TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE misconceptions (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT NOT NULL,
            text TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
            first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE approach_stats (
            kind TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0,
            success INTEGER NOT NULL DEFAULT 0
        )""",
        """CREATE TABLE study_plans (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, version INTEGER NOT NULL,
            status TEXT NOT NULL, reason TEXT, params_json TEXT, deferred_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (space_id, id),
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE plan_items (
            id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, space_id TEXT NOT NULL,
            ord INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            kp_ids_json TEXT NOT NULL, est_minutes INTEGER NOT NULL,
            scheduled_date TEXT, why_text TEXT, pinned INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'todo', lesson_id TEXT,
            FOREIGN KEY(space_id, plan_id) REFERENCES study_plans(space_id, id) ON DELETE CASCADE
        )""",
    ))
    conn.execute("PRAGMA user_version = 8")


def migrate_v8_to_v9(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        "CREATE UNIQUE INDEX plan_items_space_id ON plan_items(space_id, id)",
        """CREATE TABLE lesson_plans (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, plan_item_id TEXT NOT NULL,
            status TEXT NOT NULL, plan_json TEXT, model TEXT, verify_stats_json TEXT,
            error TEXT, created_at TEXT NOT NULL,
            UNIQUE (space_id, plan_item_id, id),
            FOREIGN KEY(space_id, plan_item_id) REFERENCES plan_items(space_id, id) ON DELETE CASCADE
        )""",
        """CREATE TABLE lessons (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, plan_item_id TEXT,
            lesson_plan_id TEXT, character_id TEXT, status TEXT NOT NULL
                CHECK (status IN ('active', 'paused', 'done', 'abandoned')),
            state_json TEXT NOT NULL, board_json TEXT, recap_json TEXT, carry_over_json TEXT,
            started_at TEXT NOT NULL, ended_at TEXT,
            UNIQUE (space_id, id), UNIQUE (space_id, plan_item_id),
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
            FOREIGN KEY(space_id, plan_item_id, lesson_plan_id)
                REFERENCES lesson_plans(space_id, plan_item_id, id) ON DELETE CASCADE
        )""",
        """CREATE TABLE lesson_events (
            lesson_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK (seq > 0),
            gen INTEGER NOT NULL CHECK (gen >= 0), type TEXT NOT NULL,
            data_json TEXT NOT NULL, t_ms INTEGER NOT NULL CHECK (t_ms >= 0),
            PRIMARY KEY (lesson_id, seq),
            FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        )""",
        """CREATE TABLE review_cards (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT, kind TEXT NOT NULL,
            front TEXT, back TEXT, item_ref TEXT, fsrs_json TEXT, due_at TEXT,
            state TEXT NOT NULL, source_lesson_id TEXT, legacy_source_session_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
            FOREIGN KEY(space_id, source_lesson_id) REFERENCES lessons(space_id, id) ON DELETE CASCADE
        )""",
        """INSERT INTO review_cards(
               id, space_id, kind, front, back, due_at, state, legacy_source_session_id, created_at, updated_at
           )
           SELECT id, space_id, 'flashcard', prompt, answer, due_at, status, source_session_id, created_at, updated_at
           FROM review_items""",
        "DROP TABLE review_items",
    ))
    conn.execute("PRAGMA user_version = 9")


def migrate_v9_to_v10(conn: sqlite3.Connection) -> None:
    _execute(conn, (
        """CREATE TABLE practice_runs (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL, plan_item_id TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('practice', 'mock')),
            item_refs_json TEXT NOT NULL, duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
            status TEXT NOT NULL CHECK (status IN ('active', 'submitted')),
            started_at TEXT NOT NULL, deadline_at TEXT NOT NULL, submitted_at TEXT,
            score REAL, max_score REAL,
            FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
            FOREIGN KEY(plan_item_id) REFERENCES plan_items(id) ON DELETE SET NULL
        )""",
        """CREATE TABLE practice_answers (
            run_id TEXT NOT NULL REFERENCES practice_runs(id) ON DELETE CASCADE,
            item_ref TEXT NOT NULL REFERENCES item_bank(id) ON DELETE CASCADE,
            answer_json TEXT, verdict TEXT, score REAL, max_score REAL, submitted_at TEXT NOT NULL,
            PRIMARY KEY (run_id, item_ref)
        )""",
        "CREATE INDEX idx_practice_runs_space ON practice_runs(space_id, started_at)",
    ))
    conn.execute("PRAGMA user_version = 10")


MIGRATIONS = (
    Migration(1, 2, migrate_v1_to_v2),
    Migration(2, 3, migrate_v2_to_v3),
    Migration(3, 4, migrate_v3_to_v4),
    Migration(4, 5, migrate_v4_to_v5),
    Migration(5, 6, migrate_v5_to_v6),
    Migration(6, 7, migrate_v6_to_v7),
    Migration(7, 8, migrate_v7_to_v8),
    Migration(8, 9, migrate_v8_to_v9),
    Migration(9, 10, migrate_v9_to_v10),
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
