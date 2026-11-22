from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError
from app.learning.review import answer_item, rate_flashcard

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class RatingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rating: Literal["again", "hard", "good", "easy"]


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str | list[str] | float | None = None
    dont_know: bool = False
    hint_level: int = Field(default=0, ge=0, le=3)


def _public_card(container: ServiceContainer, card: dict) -> dict:
    public = {key: card[key] for key in ("id", "kp_id", "kind", "front", "back", "due_at", "state")}
    with container.repository.connection() as conn:
        kp_row = (
            conn.execute(
                "SELECT name FROM knowledge_points WHERE id = ? AND space_id = ?",
                (card["kp_id"], card["space_id"]),
            ).fetchone()
            if card.get("kp_id")
            else None
        )
        public["kp_name"] = kp_row["name"] if kp_row else None
        if card["kind"] == "item":
            public.pop("back")
            row = conn.execute(
                "SELECT type, item_json FROM item_bank WHERE id = ? AND space_id = ?",
                (card["item_ref"], card["space_id"]),
            ).fetchone()
            item = json.loads(row["item_json"]) if row else {}
            if row:
                item["type"] = row["type"]
            public["item"] = {key: item.get(key) for key in ("type", "stem", "options")}
    return public


@router.get("/courses/{course_id}/review")
def get_review_queue(
    course_id: str, container: Container, limit: int = Query(default=20, ge=1, le=100),
    plan_item_id: str | None = None,
) -> dict:
    if container.repository.get_course_enrollment(course_id) is None:
        raise ResourceNotFoundError("Course not found")
    if plan_item_id:
        limit = min(limit, 5)
    cards = container.repository.due_review_cards(
        course_id, due_at=datetime.now(timezone.utc).isoformat(), limit=limit,
        plan_item_id=plan_item_id,
    )
    return {"cards": [_public_card(container, card) for card in cards], "warmup": plan_item_id is not None}


@router.post("/review/cards/{card_id}/rate")
def rate_card(card_id: str, payload: RatingRequest, container: Container) -> dict:
    result = rate_flashcard(container.repository, card_id, payload.rating)
    if result is None:
        raise ResourceNotFoundError("Flashcard not found")
    return result


@router.post("/review/cards/{card_id}/answer")
def answer_review_item(card_id: str, payload: AnswerRequest, container: Container) -> dict:
    result = answer_item(
        container.repository, card_id, payload.answer, dont_know=payload.dont_know,
        hint_level=payload.hint_level,
    )
    if result is None:
        raise ResourceNotFoundError("Review item not found")
    return result


@router.get("/courses/{course_id}/mistakes")
def get_mistakes(
    course_id: str, container: Container, kp_id: str | None = None, since: date | None = None,
    archived: bool = False,
) -> dict:
    if container.repository.get_course_enrollment(course_id) is None:
        raise ResourceNotFoundError("Course not found")
    return {"cards": container.repository.mistake_cards(
        course_id, kp_id=kp_id, since=since.isoformat() if since else None, archived=archived,
    )}
