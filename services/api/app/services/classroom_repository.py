from __future__ import annotations

import json
from datetime import datetime

from app.models.classroom import ClassroomSnapshot, FlashcardRecord
from app.models.domain import Citation
from app.services.repository import SQLiteRepository, _from_db, _to_db


class ClassroomRepository:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository

    def get_snapshot(self, session_id: str) -> ClassroomSnapshot | None:
        with self.repository.connection() as connection:
            row = connection.execute(
                "SELECT snapshot_json FROM classroom_states WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return ClassroomSnapshot.model_validate_json(row["snapshot_json"]) if row else None

    def save_snapshot(self, snapshot: ClassroomSnapshot) -> ClassroomSnapshot:
        with self.repository.connection() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO classroom_states(session_id, space_id, snapshot_json, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    snapshot.session_id,
                    snapshot.space_id,
                    snapshot.model_dump_json(),
                    _to_db(snapshot.updated_at),
                ),
            )
        return snapshot

    def upsert_flashcard(self, card: FlashcardRecord, *, fsrs_card_json: str | None) -> FlashcardRecord:
        with self.repository.connection() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO classroom_flashcards
                (id, space_id, source_session_id, prompt, answer, status, due_at,
                 fsrs_card_json, citations_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card.id,
                    card.space_id,
                    card.source_session_id,
                    card.prompt,
                    card.answer,
                    card.status,
                    _to_db(card.due_at),
                    fsrs_card_json,
                    json.dumps([item.model_dump(mode="json") for item in card.citations]),
                    _to_db(card.created_at),
                    _to_db(card.updated_at),
                ),
            )
        return card

    def get_flashcard(self, *, space_id: str, card_id: str) -> tuple[FlashcardRecord, str | None] | None:
        with self.repository.connection() as connection:
            row = connection.execute(
                "SELECT * FROM classroom_flashcards WHERE id = ? AND space_id = ?",
                (card_id, space_id),
            ).fetchone()
        return self._row_to_flashcard(row) if row else None

    def list_flashcards(self, *, space_id: str, status: str | None, due_before: datetime | None = None) -> list[FlashcardRecord]:
        clauses = ["space_id = ?"]
        values: list[str] = [space_id]
        if status:
            clauses.append("status = ?")
            values.append(status)
        if due_before:
            clauses.append("due_at IS NOT NULL AND due_at <= ?")
            values.append(_to_db(due_before) or "")
        with self.repository.connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM classroom_flashcards WHERE {' AND '.join(clauses)} ORDER BY COALESCE(due_at, created_at), id",
                values,
            ).fetchall()
        return [self._row_to_flashcard(row)[0] for row in rows]

    @staticmethod
    def _row_to_flashcard(row) -> tuple[FlashcardRecord, str | None]:
        citations = [Citation.model_validate(item) for item in json.loads(row["citations_json"])]
        fsrs_json = row["fsrs_card_json"]
        stability = difficulty = None
        reps = lapses = 0
        if fsrs_json:
            state = json.loads(fsrs_json)
            card_state = state.get("card", state)
            stability = card_state.get("stability")
            difficulty = card_state.get("difficulty")
            reps = int(state.get("reps", 0))
            lapses = int(state.get("lapses", 0))
        return (
            FlashcardRecord(
                id=row["id"],
                space_id=row["space_id"],
                source_session_id=row["source_session_id"],
                prompt=row["prompt"],
                answer=row["answer"],
                status=row["status"],
                due_at=_from_db(row["due_at"]),
                stability=stability,
                difficulty=difficulty,
                reps=reps,
                lapses=lapses,
                citations=citations,
                created_at=_from_db(row["created_at"]),
                updated_at=_from_db(row["updated_at"]),
            ),
            fsrs_json,
        )
