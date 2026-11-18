from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

class CharacterInUseError(ValueError):
    """Raised when a durable space or session still references a character."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_db(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _from_db(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _fts_sparse_terms_expression(column_name: str) -> str:
    return (
        f"trim(replace(replace(replace(replace({column_name}, '[', ' '), ']', ' '), '\"', ' '), ',', ' '))"
    )


@dataclass
class OwnerSession:
    id: str
    token_hash: str
    expires_at: datetime
    created_at: datetime


@dataclass
class RealtimeTicket:
    id: str
    token_hash: str
    owner_session_id: str
    session_id: str
    expires_at: datetime
    created_at: datetime
