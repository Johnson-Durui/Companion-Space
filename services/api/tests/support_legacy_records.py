"""Create historical rows for compatibility and scoping tests."""

from app.models.domain import CompanionTurn, MemoryItem, ReviewItem, SessionRecord
from app.services.repository import SQLiteRepository


def seed_session(repository: SQLiteRepository, session: SessionRecord) -> SessionRecord:
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO sessions (id, space_id, character_pack_id, state, summary, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                session.id, session.space_id, session.character_pack_id, session.state.value, session.summary,
                session.created_at.isoformat(), session.updated_at.isoformat(),
            ),
        )
    return session


def seed_turn(repository: SQLiteRepository, turn: CompanionTurn) -> None:
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO turns (id, session_id, space_id, role, display_text, spoken_text, emotion,"
            " citations_json, suggested_actions_json, usage_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{}', ?)",
            (
                turn.id, turn.session_id, turn.space_id, turn.role.value, turn.display_text, turn.spoken_text,
                turn.emotion, turn.created_at.isoformat(),
            ),
        )


def seed_memory(repository: SQLiteRepository, item: MemoryItem) -> None:
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO memory_items (id, space_id, content, status, sensitive, source_session_id,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item.id, item.space_id, item.content, item.status.value, int(item.sensitive), item.source_session_id,
                item.created_at.isoformat(), item.updated_at.isoformat(),
            ),
        )


def seed_review(repository: SQLiteRepository, item: ReviewItem) -> None:
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO review_items (id, space_id, prompt, answer, status, source_session_id,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item.id, item.space_id, item.prompt, item.answer, item.status.value, item.source_session_id,
                item.created_at.isoformat(), item.updated_at.isoformat(),
            ),
        )
