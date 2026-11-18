from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import timedelta

from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository


def _parse_recap(raw: str) -> str:
    records = parse_blocks(raw)
    if len(records) != 1 or records[0].tag != "recap" or not records[0].text.strip() or records[0].children:
        raise ValueError("Expected one nonempty classroom recap")
    return records[0].text.strip()


def _read_record(repository: SQLiteRepository, space_id: str, lesson_id: str) -> tuple[list, list[dict]]:
    events = repository.list_lesson_events(space_id, lesson_id)
    with repository.connection() as conn:
        answers = conn.execute(
            """SELECT item_ref, kp_id, verdict, hint_level, retry, p_before, p_after
               FROM evidence WHERE space_id = ? AND lesson_id = ? ORDER BY rowid""",
            (space_id, lesson_id),
        ).fetchall()
    return events, [dict(answer) for answer in answers]


async def finish_lesson(
    repository: SQLiteRepository, gateway: LLMGateway, space_id: str, lesson_id: str,
    plan: dict, state: dict,
) -> tuple[dict, list[dict]]:
    events, answers = await asyncio.to_thread(_read_record, repository, space_id, lesson_id)
    recap = {"items_done": state.get("items_done", {}), "backfilled": state.get("backfilled", [])}
    speech = [event["data"]["text"] for event in events if event["type"] == "say"]
    facts = {"title": plan["title"], "spoken_lines": speech, "grading": answers, **recap}
    recap["summary"] = await gateway.complete_tagged(
        "analysis", "analysis/lesson_recap",
        {"course_context": data_block("class_record", json.dumps(facts, ensure_ascii=False))},
        parse=_parse_recap, cache=True, max_tokens=800,
    )
    reached = {segment["kp_id"] for segment in plan["segments"][:state.get("seg_idx", 0)]}
    cards = [
        {**card, "kind": "flashcard"}
        for card in (plan.get("wrap") or {}).get("cards", [])
        if isinstance(card, dict) and card.get("kp_id") in reached
        and all(isinstance(card.get(key), str) and card[key].strip() for key in ("front", "back"))
    ]
    bad_cards = {answer["item_ref"] for answer in answers if answer["verdict"] in {"incorrect", "dont_know", "revealed"}}
    used = {answer["item_ref"] for answer in answers}
    unseen = {
        item_id for item_id in plan["items"]
        if item_id not in recap["items_done"]
    }
    clean: dict[str, set[str]] = defaultdict(set)
    for answer in answers:
        if answer["verdict"] == "correct" and answer["hint_level"] == 0 and not answer["retry"]:
            clean[answer["kp_id"]].add(answer["item_ref"])

    due = (utcnow() + timedelta(days=2)).isoformat()
    for item_id, item in plan["items"].items():
        point, item_ref = item["kp_id"], item["bank_id"]
        needs_confirmation = len(clean[point]) >= 2 and item_id in unseen and item_ref not in used
        if item_ref not in bad_cards and not needs_confirmation:
            continue
        cards.append({
            "kind": "item", "kp_id": point, "item_ref": item_ref, "due_at": due,
            "front": item["stem"], "back": item.get("solution") or item["answer"],
        })
        bad_cards.discard(item_ref)
        if needs_confirmation:
            clean[point].clear()
    return recap, cards
