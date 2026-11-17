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
    IngestionJob,
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
    _tts_playback_policy,
    utcnow,
)
from app.repositories.migrations import (
    CURRENT_SCHEMA_VERSION,
    apply_pending_migrations,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
)
from app.services.material_storage import canonicalize_legacy_material_storage_key


class CourseMixin:
    def list_spaces(self) -> list[StudySpace]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM study_spaces ORDER BY updated_at DESC").fetchall()
        return [self._row_to_space(row) for row in rows]

    def get_space(self, space_id: str) -> StudySpace | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM study_spaces WHERE id = ?", (space_id,)).fetchone()
        return self._row_to_space(row) if row else None

    def upsert_space(self, space: StudySpace) -> StudySpace:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO study_spaces
                (id, name, topic, goal, default_character_pack_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    topic = excluded.topic,
                    goal = excluded.goal,
                    default_character_pack_id = excluded.default_character_pack_id,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (
                    space.id,
                    space.name,
                    space.topic,
                    space.goal,
                    space.default_character_pack_id,
                    _to_db(space.created_at),
                    _to_db(space.updated_at),
                ),
            )
        return space

    def update_space_metadata(
        self,
        *,
        space_id: str,
        name: str,
        topic: str,
        goal: str,
        updated_at: datetime,
    ) -> StudySpace:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE study_spaces
                SET name = ?, topic = ?, goal = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, topic, goal, _to_db(updated_at), space_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Study space not found: {space_id}")
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
        return self._row_to_space(row)

    def set_space_default_character(
        self,
        *,
        space_id: str,
        character_pack_id: str | None,
        validate_character: Callable[[CharacterPack], None],
    ) -> StudySpace:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"Study space not found: {space_id}")
            if character_pack_id is not None:
                character = conn.execute(
                    "SELECT * FROM character_packs WHERE id = ?",
                    (character_pack_id,),
                ).fetchone()
                if character is None:
                    raise ValueError(f"Character not found: {character_pack_id}")
                validate_character(self._row_to_character(character))
            if row["default_character_pack_id"] == character_pack_id:
                return self._row_to_space(row)
            conn.execute(
                """
                UPDATE study_spaces
                SET default_character_pack_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (character_pack_id, _to_db(utcnow()), space_id),
            )
            row = conn.execute(
                "SELECT * FROM study_spaces WHERE id = ?", (space_id,)
            ).fetchone()
        return self._row_to_space(row)

    def delete_space(self, space_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM study_spaces WHERE id = ?", (space_id,))
        return cursor.rowcount == 1

    def list_characters(self) -> list[CharacterPack]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM character_packs ORDER BY updated_at DESC").fetchall()
        return [self._row_to_character(row) for row in rows]

    def get_character(self, character_id: str) -> CharacterPack | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM character_packs WHERE id = ?", (character_id,)).fetchone()
        return self._row_to_character(row) if row else None

    def upsert_character(self, character: CharacterPack) -> CharacterPack:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO character_packs
                (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    character.id,
                    character.name,
                    character.description,
                    character.recipe.model_dump_json(),
                    json.dumps(character.asset_manifest, ensure_ascii=False),
                    _to_db(character.created_at),
                    _to_db(character.updated_at),
                ),
            )
        return character

    def delete_character(self, character_id: str) -> bool:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            referenced = conn.execute(
                """
                SELECT 1 FROM study_spaces WHERE default_character_pack_id = ?
                UNION ALL
                SELECT 1 FROM sessions WHERE character_pack_id = ?
                LIMIT 1
                """,
                (character_id, character_id),
            ).fetchone()
            if referenced is not None:
                raise CharacterInUseError(
                    f"Character is in use and cannot be deleted: {character_id}"
                )
            cursor = conn.execute("DELETE FROM character_packs WHERE id = ?", (character_id,))
        return cursor.rowcount == 1
