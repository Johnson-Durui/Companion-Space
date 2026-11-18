from datetime import datetime, timezone

from pydantic import BaseModel

from app.llm.presets import Role
from app.services.repository import SQLiteRepository


class UsageRow(BaseModel):
    day: str
    role: Role
    model: str
    calls: int
    tokens_in: int
    tokens_out: int


def record_usage(
    repository: SQLiteRepository, role: Role, model: str, tokens_in: int = 0, tokens_out: int = 0,
) -> None:
    day = datetime.now(timezone.utc).date().isoformat()
    with repository.connection() as conn:
        conn.execute(
            """
            INSERT INTO llm_usage (day, role, model, calls, tokens_in, tokens_out)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(day, role, model) DO UPDATE SET
                calls = calls + 1,
                tokens_in = tokens_in + excluded.tokens_in,
                tokens_out = tokens_out + excluded.tokens_out
            """,
            (day, role, model, tokens_in, tokens_out),
        )


def list_usage(repository: SQLiteRepository) -> list[UsageRow]:
    with repository.connection() as conn:
        rows = conn.execute(
            """
            SELECT day, role, model, calls, tokens_in, tokens_out
            FROM llm_usage ORDER BY day DESC, role, model
            """
        ).fetchall()
    return [UsageRow.model_validate(dict(row)) for row in rows]
