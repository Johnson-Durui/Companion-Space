from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from pydantic import BaseModel

from app.providers.base import LLMRequest
from app.services.repository import SQLiteRepository


class LLMResult(BaseModel):
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    finish_reason: str | None = None


def make_key(request: LLMRequest, connection_id: str) -> str:
    fields = request.model_dump(exclude={"timeout_s"})
    fields["connection_id"] = connection_id
    wire = json.dumps(fields, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(wire.encode()).hexdigest()


def get_cached(repository: SQLiteRepository, key: str) -> LLMResult | None:
    with repository.connection() as conn:
        row = conn.execute(
            "SELECT model, response, tokens_in, tokens_out FROM llm_cache WHERE key = ?",
            (key,),
        ).fetchone()
    if row is None:
        return None
    return LLMResult(
        text=row["response"], model=row["model"],
        input_tokens=row["tokens_in"] or 0, output_tokens=row["tokens_out"] or 0,
    )


def put_cached(repository: SQLiteRepository, key: str, result: LLMResult) -> None:
    with repository.connection() as conn:
        conn.execute(
            """
            INSERT INTO llm_cache (key, model, response, tokens_in, tokens_out, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                response = excluded.response,
                tokens_in = excluded.tokens_in,
                tokens_out = excluded.tokens_out,
                created_at = excluded.created_at
            """,
            (key, result.model, result.text, result.input_tokens, result.output_tokens,
             datetime.now(timezone.utc).isoformat()),
        )



def delete_cached(repository: SQLiteRepository, key: str) -> None:
    with repository.connection() as conn:
        conn.execute("DELETE FROM llm_cache WHERE key = ?", (key,))
