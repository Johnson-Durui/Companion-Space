from __future__ import annotations

# ruff: noqa: F401
import sqlite3

from app.repositories.migrations import CURRENT_SCHEMA_VERSION
from app.repositories.mixins.common import (
    CharacterInUseError,
    OwnerSession,
    RealtimeTicket,
    _from_db,
    _to_db,
    utcnow,
)
from app.repositories.mixins.infrastructure import InfrastructureMixin
from app.repositories.mixins.owner_sessions import OwnerSessionMixin
from app.repositories.mixins.tickets import TicketMixin
from app.repositories.mixins.course import CourseMixin
from app.repositories.mixins.rag_read import RagReadMixin
from app.repositories.mixins.rag_write import RagWriteMixin
from app.repositories.mixins.providers import ProviderMixin
from app.repositories.mixins.sessions import SessionMixin
from app.repositories.mixins.turns import TurnMixin
from app.repositories.mixins.memory import MemoryMixin
from app.repositories.mixins.learning import LearningMixin
from app.repositories.mixins.teaching import TeachingMixin
from app.repositories.mixins.rows import RowMixin


class SQLiteRepository(
    InfrastructureMixin,
    OwnerSessionMixin,
    TicketMixin,
    CourseMixin,
    RagReadMixin,
    RagWriteMixin,
    ProviderMixin,
    SessionMixin,
    TurnMixin,
    MemoryMixin,
    LearningMixin,
    TeachingMixin,
    RowMixin,
):
    """Compatibility façade composed from bounded domain repository mixins."""

    pass
