from __future__ import annotations

# ruff: noqa: F401
import hashlib
import hmac
import json
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from app.core.config import Settings
from app.models.domain import (
    CharacterPack,
    Chunk,
    CompanionTurn,
    LearningArtifactsStatus,
    Material,
    MaterialKind,
    MemoryItem,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    SessionRecord,
    SessionState,
    StudySpace,
    TtsPlaybackPolicy,
    TurnRole,
)
from app.rag.embeddings import extract_terms, normalize_text
from app.repositories.mixins.common import (
    CharacterInUseError,
    OwnerSession,
    RealtimeTicket,
    _from_db,
    _fts_sparse_terms_expression,
    _to_db,
    utcnow,
)
from app.repositories.migrations import (
    CURRENT_SCHEMA_VERSION,
    apply_pending_migrations,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
)
from app.services.material_storage import canonicalize_legacy_material_storage_key


class TurnMixin:
    def list_turns(self, session_id: str) -> list[CompanionTurn]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC",
                (session_id,),
            ).fetchall()
        return [self._row_to_turn(row) for row in rows]

    def _row_to_session(self, row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            id=row["id"],
            space_id=row["space_id"],
            character_pack_id=row["character_pack_id"],
            state=SessionState(row["state"]),
            summary=row["summary"],
            generated_summary=row["generated_summary"] if "generated_summary" in row.keys() else "",
            notes=row["notes"] if "notes" in row.keys() else "",
            artifacts_status=row["artifacts_status"] if "artifacts_status" in row.keys() else "idle",
            artifacts_error=row["artifacts_error"] if "artifacts_error" in row.keys() else None,
            artifacts_updated_at=_from_db(row["artifacts_updated_at"]) if "artifacts_updated_at" in row.keys() else None,
            tts_connection_id=(
                row["tts_connection_id"]
                if "tts_connection_id" in row.keys()
                else None
            ),
            tts_model_name=(
                row["tts_model_name"] if "tts_model_name" in row.keys() else None
            ),
            tts_playback_policy=(
                row["tts_playback_policy"]
                if "tts_playback_policy" in row.keys()
                else None
            ),
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
            ended_at=_from_db(row["ended_at"]),
        )

    def _row_to_turn(self, row: sqlite3.Row) -> CompanionTurn:
        return CompanionTurn.model_validate(
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "space_id": row["space_id"],
                "role": TurnRole(row["role"]),
                "display_text": row["display_text"],
                "spoken_text": row["spoken_text"],
                "emotion": row["emotion"],
                "board_actions": json.loads(row["board_actions_json"]),
                "citations": json.loads(row["citations_json"]),
                "suggested_actions": json.loads(row["suggested_actions_json"]),
                "usage": json.loads(row["usage_json"]),
                "created_at": row["created_at"],
            }
        )
