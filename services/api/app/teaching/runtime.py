from __future__ import annotations

import asyncio
from time import time_ns

from app.analysis.retrieval import retrieve_for_kp
from app.llm.gateway import LLMGateway
from app.services.repository import SQLiteRepository
from app.services.tutor_catalog import TutorCatalog
from app.teaching.director import Director
from app.teaching.evidence import OBJECTIVE_TYPES
from app.teaching.finish import finish_lesson
from app.teaching.realizer import Realizer
from app.teaching.speech_text import clean_speech
from app.teaching.understanding import InvalidAnswer, grade_objective, understand
from app.teaching.validators import validate_board

_INTRO = {"OPEN", "CHECK", "PRACTICE_ITEM", "VERIFY_SKIP", "BACKFILL"}
_QUICK_INTENTS = {
    "request_example": "example", "request_hint": "hint", "request_answer": "show_answer",
    "request_repeat": "repeat", "request_slower": "slower", "request_faster": "faster",
    "request_break": "break", "confusion": "confused", "skip_claim": "skip", "ack": "continue",
}


def _item_for_ask(ask: dict | None, plan: dict) -> dict | None:
    if not ask or ask.get("kind") != "item":
        return None
    item = plan["items"].get(ask.get("item_id"))
    if not item or item.get("verify", {}).get("status") != "verified":
        raise ValueError("This classroom question has not been verified")
    return item


def _public_ask(ask: dict, plan: dict) -> dict:
    payload = {key: ask[key] for key in ("kind", "purpose", "item_id") if key in ask}
    item = _item_for_ask(ask, plan)
    if item:
        payload["widget"] = {
            "type": item["type"],
            "stem": item["stem"],
            "options": [{key: option[key] for key in ("key", "text")} for option in item.get("options") or []],
        }
    return payload


class LessonRuntime:
    """Run one durable turn at a time. The text client consumes committed events."""

    def __init__(self, repository: SQLiteRepository, gateway: LLMGateway, space_id: str, lesson_id: str) -> None:
        self.repository = repository
        self.gateway = gateway
        self.space_id = space_id
        self.lesson_id = lesson_id
        self.realizer = Realizer(gateway)

    async def step(self, event: dict, *, elapsed_ms: int = 0) -> list[dict]:
        lesson = await asyncio.to_thread(self.repository.get_lesson, self.space_id, self.lesson_id)
        if lesson is None:
            raise ValueError("Lesson was not found in this course")
        if lesson["status"] in {"done", "abandoned"}:
            return []
        saved = await asyncio.to_thread(
            self.repository.get_lesson_plan, self.space_id, lesson["plan_item_id"], lesson_plan_id=lesson["lesson_plan_id"],
        )
        if saved is None:
            raise ValueError("The lesson's verified plan could not be loaded")
        plan = saved["plan"]
        state = lesson["state"]
        if elapsed_ms > 0 and lesson["status"] == "active" and (
            state.get("active_ask") or "playback_after_seq" in state
        ):
            state["active_ms"] = state.get("active_ms", 0) + elapsed_ms
            state["seg_active_ms"] = state.get("seg_active_ms", 0) + elapsed_ms
        if event["type"] == "time_up":
            state["time_up_sent"] = True
        board = lesson["board"] or {}
        ask = state.get("active_ask")
        item = _item_for_ask(ask, plan)
        if event["type"] == "control" and event.get("action") == "resume":
            event = {"type": "lesson_resume"}
        if lesson["status"] == "paused" and event["type"] != "lesson_resume":
            raise ValueError("Resume the lesson before taking another action")
        if event["type"] == "lesson_start" and lesson["gen"]:
            event = {"type": "lesson_resume"}
        if event["type"] == "lesson_resume" and not lesson["gen"]:
            event = {"type": "lesson_start"}
        if event["type"] == "lesson_resume" and not ask and "playback_after_seq" in state:
            replay = await asyncio.to_thread(
                self.repository.list_lesson_events, self.space_id, self.lesson_id, after=state["playback_after_seq"],
            )
            appended = await self._commit(lesson, lesson["gen"], [], state, board, status="active")
            return [row for row in replay if row["gen"] == lesson["gen"] and row["type"] != "state"] + appended
        event = await self._understand(event, state, ask, item, plan)
        if event["type"] == "control" and event.get("action") == "pause":
            return await self._commit(lesson, lesson["gen"], [], state, board, status="paused")
        learner = await asyncio.to_thread(self._learner)
        decision = Director.decide(state, event, learner, plan)
        next_state = {**state, **decision.state_patch}
        if event["type"] in {"beat_done", "interrupt"}:
            next_state.pop("playback_after_seq", None)
        if (event["type"] == "time_up" or (event["type"] == "control" and event.get("action") == "end")) and (
            state.get("stage") == "teaching"
        ):
            next_state["carry_over"] = {"seg_idx": state.get("seg_idx", 0), "kp_cursor": state.get("kp_cursor", 0)}
        status = next_state.pop("status", "active")
        gen = lesson["gen"] + int(bool(decision.move))
        events: list[dict] = []

        def add(event_type: str, data: dict) -> None:
            events.append({"type": event_type, "data": data, "t_ms": time_ns() // 1_000_000})

        stale = decision.args.get("judge")
        if stale:
            add("judge", stale)
        elif event["type"] == "student_answer" and "verdict" in event:
            add("judge", {"item_id": event["item_id"], "verdict": event["verdict"]})

        decision_item = plan["items"].get(decision.args.get("item_id"))
        outbound_item = _item_for_ask(decision.ask, plan)
        if decision.move:
            add("beat.start", {"move": decision.move, "ask_after": bool(decision.ask)})
            context = await asyncio.to_thread(self._context, lesson, plan, next_state, decision.args)
            spoken = 0
            async for generated in self.realizer.run(
                decision, context=context, board=board, item=decision_item or outbound_item or item,
            ):
                if generated.type == "say":
                    spoken += 1
                    add("say", {**generated.data, "seg": spoken})
                elif validate_board(generated, board):
                    add(generated.type, generated.data)
            if not spoken:
                raise ValueError("The live model returned no usable classroom explanation")
            if outbound_item and decision.move in _INTRO:
                stem = clean_speech(outbound_item.get("stem_spoken") or outbound_item["stem"])
                if stem:
                    add("say", {"text": stem, "emotion": "neutral", "seg": spoken + 1})
            if decision.move == "SHOW_SOLUTION" and decision_item:
                add("judge", {"item_id": decision.args["item_id"], "correct_answer": decision_item["answer"]})
            if decision.ask:
                next_state.pop("playback_after_seq", None)
            else:
                next_state["playback_after_seq"] = lesson["seq"]

        if decision.ask:
            add("ask", _public_ask(decision.ask, plan))
        if decision.move:
            add("beat.end", {"ask": bool(decision.ask)})
        if event["type"] == "interrupt":
            add("beat.cancelled", {"gen": gen, "reason": "student"})

        observation = None
        proof = decision.args.get("evidence")
        retry = event["type"] == "student_answer" and decision.move != "PROBE"
        if proof and (proof.get("record", True) or retry):
            observed_item = _item_for_ask({"kind": "item", "item_id": proof["item_id"]}, plan)
            observation = {**proof, "item": observed_item, "via": event.get("via", "text")}
        recap, cards = None, ()
        if next_state.get("stage") == "done":
            status = "done"
            recap, cards = await finish_lesson(
                self.repository, self.gateway, self.space_id, self.lesson_id, plan, next_state,
            )
        return await self._commit(
            lesson, gen, events, next_state, board, status=status, observation=observation, recap=recap, cards=cards,
        )

    async def _commit(
        self, lesson: dict, gen: int, events: list[dict], state: dict, board: dict,
        *, status: str, observation: dict | None = None, recap: dict | None = None, cards=(),
    ) -> list[dict]:
        events.append({
            "type": "state",
            "data": {"stage": state.get("stage"), "seg_idx": state.get("seg_idx", 0), "paused": status == "paused"},
            "t_ms": time_ns() // 1_000_000,
        })
        recorded = await asyncio.to_thread(
            self.repository.append_lesson_events,
            self.space_id, self.lesson_id, gen=gen, events=events, state=state, board=board, status=status,
            expected_seq=lesson["seq"], observation=observation, recap=recap,
            carry_over=state.get("carry_over"), cards=cards,
        )
        if recorded is None:
            raise ValueError("Lesson was removed while preparing this turn")
        return recorded

    async def _understand(self, event: dict, state: dict, ask: dict | None, item: dict | None, plan: dict) -> dict:
        if event["type"] == "ask_reply" and event.get("purpose") == "probe" and (ask or {}).get("purpose") == "probe":
            probed_item = _item_for_ask({"kind": "item", "item_id": (state.get("item") or {}).get("id")}, plan)
            result = await understand(self.gateway, str(event.get("value", "")), item=probed_item, active_ask=ask)
            if result.get("intent") == "unclear":
                raise InvalidAnswer("The reason could not be understood. Try rephrasing it.")
            return {**event, "reason_verdict": result.get("reason", "none")}
        if event["type"] == "student_utterance" and not event.get("intent"):
            result = await understand(self.gateway, event["text"], item=item, active_ask=ask)
            intent = result["intent"]
            if intent in _QUICK_INTENTS:
                return {"type": "quick_action", "kind": _QUICK_INTENTS[intent]}
            if intent == "request_style":
                return {"type": "quick_action", "kind": f"style:{result.get('style_id', '')}"}
            if intent == "stop":
                return {"type": "control", "action": "pause"}
            return {**event, "intent": "question" if intent == "answer" else intent}
        if event["type"] != "student_answer" or not item or event.get("item_id") != ask.get("item_id"):
            return event
        if item["type"] in OBJECTIVE_TYPES:
            result = grade_objective(item, event.get("value"), dont_know=bool(event.get("dont_know")))
        elif event.get("dont_know"):
            result = {"verdict": "dont_know"}
        else:
            result = await understand(self.gateway, str(event.get("value", "")), item=item, active_ask=ask)
            if result.get("verdict") not in {"correct", "partial", "incorrect", "dont_know"}:
                raise InvalidAnswer("The explanation could not be graded. Try rephrasing or choose Don't know.")
        return {**event, **result}

    def _learner(self) -> dict:
        learner = self.repository.get_learner_profile() or {}
        with self.repository.connection() as conn:
            rows = conn.execute("SELECT kp_id, p FROM kp_mastery WHERE space_id = ?", (self.space_id,)).fetchall()
        return {**learner, "mastery": {row["kp_id"]: row["p"] for row in rows}}

    def _context(self, lesson: dict, plan: dict, state: dict, args: dict) -> dict:
        context = {
            "title": plan["title"], "objectives": plan.get("objectives", []),
            "style_id": state.get("style_id", "guided"), "pace": state.get("pace", "normal"),
            "move_data": {key: value for key, value in args.items() if key not in {"evidence", "judge"}},
            "resolved_questions": state.get("items_done", {}),
            "recent_board": list((lesson["board"] or {}).values())[-15:],
        }
        if lesson.get("character_id"):
            character = TutorCatalog(self.repository).get_character(lesson["character_id"])
            if character:
                context["teacher"] = {"name": character.name, "persona": character.persona.model_dump()}
        segments = plan["segments"]
        idx = state.get("seg_idx", 0)
        if idx < len(segments):
            segment = segments[idx]
            context["segment"] = {
                key: segment[key] for key in ("goal", "keypoints", "misconceptions", "backfills") if key in segment
            }
            if segment.get("sources"):
                excerpts = retrieve_for_kp(self.repository, space_id=self.space_id, kp_id=segment["kp_id"], k=4)
                context["source_excerpts"] = [
                    {"material_id": part.material_id, "page": part.page_no, "text": part.content[:3000]}
                    for part in excerpts
                ]
        return context
