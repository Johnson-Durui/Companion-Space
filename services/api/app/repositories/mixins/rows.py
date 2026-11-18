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


class RowMixin:
    def _row_to_space(self, row: sqlite3.Row) -> StudySpace:
        return StudySpace(
            id=row["id"],
            name=row["name"],
            topic=row["topic"],
            goal=row["goal"],
            default_character_pack_id=row["default_character_pack_id"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_material(self, row: sqlite3.Row) -> Material:
        return Material(
            id=row["id"],
            space_id=row["space_id"],
            title=row["title"],
            kind=MaterialKind(row["kind"]),
            filename=row["filename"],
            storage_path=row["storage_path"],
            chunk_count=row["chunk_count"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_chunk(self, row: sqlite3.Row) -> Chunk:
        return Chunk(
            id=row["id"],
            space_id=row["space_id"],
            material_id=row["material_id"],
            title=row["title"],
            locator=row["locator"],
            content=row["content"],
            sparse_terms=json.loads(row["sparse_terms"]),
            dense_vector=json.loads(row["dense_vector"]),
            metadata=json.loads(row["metadata_json"]),
            created_at=_from_db(row["created_at"]) or utcnow(),
        )

    def _row_to_character(self, row: sqlite3.Row) -> CharacterPack:
        return CharacterPack.model_validate(
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "recipe": json.loads(row["recipe_json"]),
                "asset_manifest": json.loads(row["asset_manifest_json"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    def _row_to_provider(self, row: sqlite3.Row) -> ProviderConnection:
        return ProviderConnection(
            id=row["id"],
            provider=row["provider"],
            label=row["label"],
            base_url=row["base_url"],
            capabilities=[ProviderCapability(item) for item in json.loads(row["capabilities_json"])],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )

    def _row_to_assignment(self, row: sqlite3.Row) -> ModelAssignment:
        return ModelAssignment(
            id=row["id"],
            space_id=row["space_id"],
            capability=ProviderCapability(row["capability"]),
            provider_connection_id=row["provider_connection_id"],
            model_name=row["model_name"],
            created_at=_from_db(row["created_at"]) or utcnow(),
            updated_at=_from_db(row["updated_at"]) or utcnow(),
        )
