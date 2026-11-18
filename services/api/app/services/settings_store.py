from __future__ import annotations

import json
from datetime import datetime, timezone

from app.services.repository import SQLiteRepository


def get_setting[T](repository: SQLiteRepository, key: str, default: T) -> T:
    with repository.connection() as conn:
        row = conn.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value_json"]) if row else default


def put_setting(repository: SQLiteRepository, key: str, value: object) -> None:
    with repository.connection() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            """,
            (key, json.dumps(value, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
        )
