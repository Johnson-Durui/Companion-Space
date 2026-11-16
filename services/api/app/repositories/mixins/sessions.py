from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from app.models.domain import (
    CharacterPack,
    LearningArtifactsStatus,
    ProviderCapability,
    SessionRecord,
    SessionState,
)
from app.repositories.mixins.common import (
    _to_db,
    _tts_playback_policy,
    utcnow,
)


class SessionMixin:
    def list_sessions(self, space_id: str) -> list[SessionRecord]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def list_recoverable_artifact_sessions(self) -> list[SessionRecord]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM sessions
                WHERE artifacts_status IN (?, ?)
                ORDER BY COALESCE(artifacts_updated_at, updated_at) ASC, id ASC
                """,
                (
                    LearningArtifactsStatus.pending.value,
                    LearningArtifactsStatus.running.value,
                ),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row_to_session(row) if row else None

    def try_activate_session_turn(
        self,
        *,
        session_id: str,
        allowed_states: tuple[SessionState, ...],
    ) -> SessionRecord | None:
        now = utcnow()
        placeholders = ", ".join("?" for _ in allowed_states)
        with self.connection() as conn:
            cursor = conn.execute(
                f"""
                UPDATE sessions
                SET state = ?, updated_at = ?
                WHERE id = ?
                  AND ended_at IS NULL
                  AND state IN ({placeholders})
                """,
                (
                    SessionState.thinking.value,
                    _to_db(now),
                    session_id,
                    *(state.value for state in allowed_states),
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._row_to_session(row) if row else None

    def upsert_session(self, session: SessionRecord) -> SessionRecord:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO sessions
                (
                    id,
                    space_id,
                    character_pack_id,
                    state,
                    summary,
                    generated_summary,
                    notes,
                    artifacts_status,
                    artifacts_error,
                    artifacts_updated_at,
                    tts_connection_id,
                    tts_model_name,
                    tts_playback_policy,
                    created_at,
                    updated_at,
                    ended_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    state = excluded.state,
                    summary = excluded.summary,
                    generated_summary = excluded.generated_summary,
                    notes = excluded.notes,
                    artifacts_status = excluded.artifacts_status,
                    artifacts_error = excluded.artifacts_error,
                    artifacts_updated_at = excluded.artifacts_updated_at,
                    updated_at = excluded.updated_at,
                    ended_at = excluded.ended_at
                """,
                (
                    session.id,
                    session.space_id,
                    session.character_pack_id,
                    session.state.value,
                    session.summary,
                    session.generated_summary,
                    session.notes,
                    session.artifacts_status.value,
                    session.artifacts_error,
                    _to_db(session.artifacts_updated_at),
                    session.tts_connection_id,
                    session.tts_model_name,
                    session.tts_playback_policy,
                    _to_db(session.created_at),
                    _to_db(session.updated_at),
                    _to_db(session.ended_at),
                ),
            )
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session.id,)
            ).fetchone()
        if row is None:
            raise RuntimeError(f"Session disappeared after upsert: {session.id}")
        return self._row_to_session(row)

    def create_session(
        self,
        session: SessionRecord,
        *,
        requested_character_pack_id: str | None,
        fallback_character_pack_id: str,
        validate_character: Callable[[CharacterPack], None],
    ) -> SessionRecord:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            space_row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (session.space_id,)
            ).fetchone()
            if space_row is None:
                raise ValueError(f"Study space not found: {session.space_id}")
            character_pack_id = (
                requested_character_pack_id
                or space_row["default_character_pack_id"]
                or fallback_character_pack_id
            )
            character_row = conn.execute(
                "SELECT * FROM character_packs WHERE id = ?",
                (character_pack_id,),
            ).fetchone()
            if character_row is None:
                raise ValueError(f"Character not found: {character_pack_id}")
            validate_character(self._row_to_character(character_row))
            tts_assignment_row = conn.execute(
                """
                SELECT provider_connection_id, model_name
                FROM model_assignments
                WHERE space_id = ? AND capability = ?
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                """,
                (session.space_id, ProviderCapability.tts.value),
            ).fetchone()
            tts_connection_id = (
                tts_assignment_row["provider_connection_id"]
                if tts_assignment_row is not None
                else None
            )
            tts_model_name = (
                tts_assignment_row["model_name"]
                if tts_assignment_row is not None
                else None
            )
            created = session.model_copy(
                update={
                    "character_pack_id": character_pack_id,
                    "tts_connection_id": tts_connection_id,
                    "tts_model_name": tts_model_name,
                    "tts_playback_policy": _tts_playback_policy(tts_connection_id),
                }
            )
            conn.execute(
                """
                INSERT INTO sessions
                (
                    id, space_id, character_pack_id, state, summary,
                    generated_summary, notes, artifacts_status, artifacts_error,
                    artifacts_updated_at, tts_connection_id, tts_model_name,
                    tts_playback_policy, created_at, updated_at, ended_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    created.id,
                    created.space_id,
                    created.character_pack_id,
                    created.state.value,
                    created.summary,
                    created.generated_summary,
                    created.notes,
                    created.artifacts_status.value,
                    created.artifacts_error,
                    _to_db(created.artifacts_updated_at),
                    created.tts_connection_id,
                    created.tts_model_name,
                    created.tts_playback_policy,
                    _to_db(created.created_at),
                    _to_db(created.updated_at),
                    _to_db(created.ended_at),
                ),
            )
        return created

    def update_session_recap_fields(
        self,
        *,
        session_id: str,
        summary: str,
        notes: str,
        updated_at: datetime,
    ) -> SessionRecord:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET summary = ?,
                    notes = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    summary,
                    notes,
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("Session not found")
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row)

    def undo_session_recap_fields(
        self,
        *,
        session_id: str,
        updated_at: datetime,
    ) -> SessionRecord:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET summary = generated_summary,
                    notes = '',
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("Session not found")
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row)

    def update_session_artifacts_status(
        self,
        *,
        session_id: str,
        status: LearningArtifactsStatus,
        error: str | None,
        updated_at: datetime,
    ) -> SessionRecord | None:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions
                SET artifacts_status = ?,
                    artifacts_error = ?,
                    artifacts_updated_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    status.value,
                    error,
                    _to_db(updated_at),
                    _to_db(updated_at),
                    session_id,
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._row_to_session(row) if row else None
