from __future__ import annotations

BASE_SCHEMA_SQL = r'''
CREATE TABLE IF NOT EXISTS study_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    topic TEXT NOT NULL,
    goal TEXT NOT NULL,
    default_character_pack_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    title TEXT NOT NULL,
    locator TEXT NOT NULL,
    content TEXT NOT NULL,
    sparse_terms TEXT NOT NULL,
    dense_vector TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS character_packs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    recipe_json TEXT NOT NULL,
    asset_manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    base_url TEXT,
    capabilities_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_assignments (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    provider_connection_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    is_bootstrap_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY(provider_connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    character_pack_id TEXT,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    generated_summary TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    artifacts_status TEXT NOT NULL DEFAULT 'idle',
    artifacts_error TEXT,
    artifacts_updated_at TEXT,
    tts_connection_id TEXT,
    tts_model_name TEXT,
    tts_playback_policy TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    role TEXT NOT NULL,
    display_text TEXT NOT NULL,
    spoken_text TEXT NOT NULL,
    emotion TEXT NOT NULL,
    board_actions_json TEXT NOT NULL DEFAULT '[]',
    citations_json TEXT NOT NULL,
    suggested_actions_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    sensitive INTEGER NOT NULL,
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS review_items (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    due_at TEXT,
    status TEXT NOT NULL,
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(space_id) REFERENCES study_spaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_preferences (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    adult_relationships_enabled INTEGER NOT NULL DEFAULT 0,
    adult_age_confirmed_at TEXT
);
INSERT OR IGNORE INTO owner_preferences(
    id,
    adult_relationships_enabled,
    adult_age_confirmed_at
) VALUES (1, 0, NULL);
CREATE TABLE IF NOT EXISTS local_metric_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_metric_events_name_time
    ON local_metric_events(event_name, occurred_at);
CREATE TABLE IF NOT EXISTS realtime_tickets (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    owner_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_realtime_tickets_owner_session_id
    ON realtime_tickets(owner_session_id);
'''
