from __future__ import annotations

from app.models.domain import (
    SessionRecord,
)


class SessionMixin:
    def list_sessions(self, space_id: str) -> list[SessionRecord]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row_to_session(row) if row else None
