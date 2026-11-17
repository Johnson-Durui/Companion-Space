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


class ProviderMixin:
    def list_provider_connections(self) -> list[ProviderConnection]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM provider_connections ORDER BY updated_at DESC").fetchall()
        return [self._row_to_provider(row) for row in rows]

    def get_provider_connection(self, connection_id: str) -> ProviderConnection | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM provider_connections WHERE id = ?", (connection_id,)).fetchone()
        return self._row_to_provider(row) if row else None

    def upsert_provider_connection(self, connection: ProviderConnection) -> ProviderConnection:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO provider_connections
                (id, provider, label, base_url, capabilities_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    provider = excluded.provider,
                    label = excluded.label,
                    base_url = excluded.base_url,
                    capabilities_json = excluded.capabilities_json,
                    updated_at = excluded.updated_at
                """,
                (
                    connection.id,
                    connection.provider,
                    connection.label,
                    connection.base_url,
                    json.dumps([item.value for item in connection.capabilities]),
                    _to_db(connection.created_at),
                    _to_db(connection.updated_at),
                ),
            )
        return connection

    def delete_provider_connection(self, connection_id: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM provider_connections WHERE id = ?", (connection_id,))

    def list_model_assignments(self, space_id: str) -> list[ModelAssignment]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM model_assignments WHERE space_id = ? ORDER BY updated_at DESC",
                (space_id,),
            ).fetchall()
        return [self._row_to_assignment(row) for row in rows]

    def upsert_model_assignment(self, assignment: ModelAssignment) -> ModelAssignment:
        with self.connection() as conn:
            conn.execute(
                """
                DELETE FROM model_assignments
                WHERE space_id = ? AND capability = ? AND id <> ?
                """,
                (
                    assignment.space_id,
                    assignment.capability.value,
                    assignment.id,
                ),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO model_assignments
                (
                    id,
                    space_id,
                    capability,
                    provider_connection_id,
                    model_name,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    assignment.id,
                    assignment.space_id,
                    assignment.capability.value,
                    assignment.provider_connection_id,
                    assignment.model_name,
                    _to_db(assignment.created_at),
                    _to_db(assignment.updated_at),
                ),
            )
        return assignment

    def delete_model_assignment(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
    ) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                """
                DELETE FROM model_assignments
                WHERE space_id = ? AND capability = ?
                """,
                (space_id, capability.value),
            )
        return cursor.rowcount > 0
