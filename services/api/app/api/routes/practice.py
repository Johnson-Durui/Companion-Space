from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError
from app.learning.practice import get_debrief_item, get_run, save_answer, start_run, submit_run
from app.services.settings_store import get_setting
from app.teaching.director import Decision
from app.teaching.realizer import Realizer

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]
_LOG = logging.getLogger(__name__)


class PracticeAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str
    answer: str | list[str] | float | None = None


class DebriefRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    move: Literal["SHOW_SOLUTION", "REEXPLAIN", "CHECK"]


@router.post("/plan-items/{item_id}/practice")
def start_practice(item_id: str, container: Container) -> dict:
    result = start_run(container.repository, item_id)
    if result is None:
        raise ResourceNotFoundError("Practice is unavailable", code="practice_unavailable")
    return result


@router.get("/practice/{run_id}")
def read_practice(run_id: str, container: Container) -> dict:
    result = get_run(container.repository, run_id, reveal=False)
    if result is None:
        raise ResourceNotFoundError("Practice not found", code="practice_not_found")
    return result


@router.put("/practice/{run_id}/answer")
def put_practice_answer(run_id: str, payload: PracticeAnswer, container: Container) -> dict:
    if not save_answer(container.repository, run_id, payload.item_id, payload.answer):
        raise HTTPException(
            status_code=409,
            detail={"code": "practice_answer_closed", "message": "Practice has ended or the item is unavailable"},
        )
    return {"saved": True}


@router.post("/practice/{run_id}/submit")
def finish_practice(run_id: str, container: Container) -> dict:
    result = submit_run(container.repository, run_id)
    if result is None:
        raise ResourceNotFoundError("Practice not found", code="practice_not_found")
    return result


@router.post("/practice/{run_id}/debrief/{item_id}")
async def explain_practice_item(run_id: str, item_id: str, payload: DebriefRequest, container: Container) -> dict:
    source = await asyncio.to_thread(get_debrief_item, container.repository, run_id, item_id)
    if source is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "practice_not_submitted", "message": "Submit this practice before requesting commentary"},
        )
    item = source["item"]
    allowed = ["CHECK"] if source["verdict"] == "correct" else ["SHOW_SOLUTION", "REEXPLAIN", "CHECK"]
    if payload.move not in allowed:
        raise HTTPException(
            status_code=409,
            detail={"code": "practice_move_unavailable", "message": "That commentary is unavailable for this result"},
        )
    context = {
        "mode": "practice_debrief", "pace": "normal", "style_id": "direct",
        "verdict": source["verdict"], "learner_answer": source["learner_answer"],
        "verified_answer": item.get("answer"),
        "verified_solution": item.get("solution") or str(item.get("answer", "")),
    }
    decision = Decision(payload.move, {"item_id": item_id}, None, {})
    try:
        texts = [
            event.data["text"] async for event in Realizer(container.gateway).run(
                decision, context=context, board={}, item=item,
            ) if event.type == "say"
        ]
        commentary = " ".join(texts).strip()
        if not commentary:
            raise ValueError("The live teacher returned no usable commentary")
    except Exception:
        _LOG.exception("Practice debrief commentary failed", extra={"run_id": run_id, "item_id": item_id})
        return {
            "available": False, "commentary": None,
            "code": "practice_debrief_unavailable",
            "reason": "Live teacher commentary is temporarily unavailable. The verified solution remains available.",
        }
    voice = None
    character_id = get_setting(container.repository, "default_character_id", None)
    character = container.tutors.get_character(character_id) if character_id else None
    if character:
        voice = {"lang": "zh-CN", "voice_id": character.voice.voice_id,
                 "rate": character.voice.rate, "pitch": character.voice.pitch}
    return {"available": True, "commentary": commentary, "code": None, "reason": None, "browser_voice": voice}
