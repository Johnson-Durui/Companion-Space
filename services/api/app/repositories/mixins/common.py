from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from app.models.domain import TtsPlaybackPolicy


class CharacterInUseError(ValueError):
    """Raised when a durable space or session still references a character."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_db(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _from_db(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _tts_playback_policy(connection_id: str | None) -> TtsPlaybackPolicy | None:
    if connection_id is None:
        return None
    if connection_id == "builtin-mock":
        return "browser-compat"
    if connection_id == "builtin-neural-tts":
        return "server-neural"
    return "server"


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
    device_id: str | None = None


@dataclass(frozen=True)
class OwnerPreferences:
    adult_relationships_enabled: bool
    adult_age_confirmed_at: datetime | None


@dataclass
class RealtimeTicket:
    id: str
    token_hash: str
    owner_session_id: str
    session_id: str
    expires_at: datetime
    created_at: datetime
