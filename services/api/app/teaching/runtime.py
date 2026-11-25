from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from time import time_ns

from app.analysis.retrieval import retrieve_for_kp, retrieve_with_structure
from app.learning.memory import build_compact_memory_summary
from app.llm.gateway import LLMGateway
from app.learning.replanning import rebuild_course_plan
from app.services.repository import SQLiteRepository
from app.services.jobs import JobRunner
from app.services.tutor_catalog import TutorCatalog
from app.teaching.director import Director
from app.teaching.evidence import OBJECTIVE_TYPES
from app.teaching.finish import finish_lesson
from app.teaching.preparation import prepare_upcoming_lessons, queue_upcoming_lessons
from app.teaching.lsp_parser import LspEvent
from app.teaching.realizer import Realizer
from app.teaching.speech_text import clean_speech
from app.teaching.understanding import InvalidAnswer, canonical_item_type, grade_objective, understand
from app.teaching.validators import build_forbidden, validate_board

_INTRO = {"OPEN", "CHECK", "PRACTICE_ITEM", "VERIFY_SKIP", "BACKFILL"}
_QUICK_INTENTS = {
    "request_example": "example", "request_hint": "hint", "request_answer": "show_answer",
    "request_repeat": "repeat", "request_slower": "slower", "request_faster": "faster",
    "request_break": "break", "confusion": "confused", "skip_claim": "skip", "ack": "continue",
}


@dataclass(frozen=True)
class PreparedBeat:
    expected_seq: int
    move: str
    args: dict
    ask: dict | None
    events: tuple[LspEvent, ...]


def _item_for_ask(ask: dict | None, plan: dict) -> dict | None:
    if not ask or ask.get("kind") != "item":
        return None
    item = plan["items"].get(ask.get("item_id"))
    if not item or item.get("verify", {}).get("status") != "verified":
        raise ValueError("This classroom question has not been verified")
    kind = canonical_item_type(str(item.get("type", "")))
    if kind != item["type"]:
        item = {**item, "type": kind}
        item["forbidden"] = build_forbidden(item)
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

    def __init__(
        self, repository: SQLiteRepository, gateway: LLMGateway, space_id: str, lesson_id: str,
        *, jobs: JobRunner | None = None,
    ) -> None:
        self.repository = repository
        self.gateway = gateway
        self.space_id = space_id
        self.lesson_id = lesson_id
        self.jobs = jobs
        self.realizer = Realizer(gateway)

    async def step(
        self, event: dict, *, elapsed_ms: int = 0, split_speech: Callable[[str], list[str]] | None = None,
        on_say: Callable[[int, str], Awaitable[None]] | None = None,
        on_visual: Callable[[LspEvent], Awaitable[None]] | None = None,
        on_judge: Callable[[str], Awaitable[None]] | None = None,
        prepared: PreparedBeat | None = None,
    ) -> list[dict]:
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
        if event["type"] == "interrupt" and type(event.get("heard_seq")) is int:
            history = await asyncio.to_thread(self.repository.list_lesson_events, self.space_id, self.lesson_id)
            heard = {
                row["gen"]: row["data"]["heard_seq"] for row in history
                if row["type"] == "beat.cancelled" and type(row["data"].get("heard_seq")) is int
            }
            heard[lesson["gen"]] = event["heard_seq"]
            board = {}
            for row in history:
                if row["type"] in {"board", "board_param"} and row["seq"] <= heard.get(row["gen"], lesson["seq"]):
                    validate_board(LspEvent(row["type"], row["data"]), board)
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
            return [
                {**row, "data": {**row["data"], "paused": False}} if row["type"] == "state" else row
                for row in replay if row["gen"] == lesson["gen"]
            ] + appended
        event = await self._understand(event, state, ask, item, plan)
        if event["type"] == "prefill":
            return [event]
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

        spoken = 0

        async def say(data: dict) -> None:
            nonlocal spoken
            for text in split_speech(data["text"]) if split_speech else (data["text"],):
                spoken += 1
                add("say", {**data, "text": text, "seg": spoken})
                if on_say is not None:
                    await on_say(spoken, text)

        stale = decision.args.get("judge")
        preview_verdict: str | None = None
        if stale:
            add("judge", stale)
            if isinstance(stale.get("verdict"), str):
                preview_verdict = stale["verdict"]
        elif event["type"] == "student_answer" and "verdict" in event:
            add("judge", {"item_id": event["item_id"], "verdict": event["verdict"]})
            preview_verdict = str(event["verdict"])
        if on_judge is not None and preview_verdict is not None:
            await on_judge(preview_verdict)

        decision_item = plan["items"].get(decision.args.get("item_id"))
        outbound_item = _item_for_ask(decision.ask, plan)
        if decision.move:
            approach = decision.args.get("approach")
            add("beat.start", {
                "move": decision.move, "ask_after": bool(decision.ask),
                "approach": approach.get("kind") if isinstance(approach, dict) else None,
                "item_id": decision.args.get("item_id"),
            })
            recent_action = event.get("recent_avatar_action")
            if not isinstance(recent_action, str) and preview_verdict is not None:
                recent_action = "praise_thumbs_up" if preview_verdict == "correct" else "gentle_encourage"
            context = await asyncio.to_thread(
                self._context, lesson, plan, next_state, decision.args, recent_avatar_action=recent_action,
            )
            if decision.move == "ANSWER_QUESTION":
                question_text = str(decision.args.get("question") or "").strip()
                if question_text:
                    segments = plan.get("segments") or []
                    seg_idx = next_state.get("seg_idx", 0)
                    active_kp_id = segments[seg_idx]["kp_id"] if seg_idx < len(segments) else None
                    pages = await retrieve_with_structure(
                        self.repository,
                        self.gateway,
                        space_id=self.space_id,
                        query=question_text,
                        active_kp_id=active_kp_id,
                        max_pages=3,
                    )
                    if pages:
                        structured_entries = [
                            {
                                "material_id": page.material_id,
                                "page": page.page_no,
                                "section": page.section_title,
                                "has_image": page.has_image,
                                "source": page.source,
                                "text": page.markdown[:3500],
                            }
                            for page in pages
                        ]
                        context["question_sources"] = structured_entries
                        existing_excerpts = list(context.get("source_excerpts") or [])
                        seen_pages = {(item["material_id"], item["page"]) for item in structured_entries}
                        merged_excerpts = list(structured_entries)
                        for entry in existing_excerpts:
                            if (entry.get("material_id"), entry.get("page")) not in seen_pages:
                                merged_excerpts.append(entry)
                        context["source_excerpts"] = merged_excerpts[:6]
            cached = prepared is not None and (
                prepared.expected_seq == lesson["seq"]
                and prepared.move == decision.move
                and prepared.args == decision.args
                and prepared.ask == decision.ask
            )
            generated_events = prepared.events if cached else self.realizer.run(
                decision, context=context, board=board, item=decision_item or outbound_item or item,
            )
            async for generated in _as_async(generated_events):
                if generated.type == "say":
                    await say(generated.data)
                elif validate_board(generated, board):
                    add(generated.type, generated.data)
                    if on_visual is not None and generated.type in {"board", "mark", "board_param"}:
                        await on_visual(generated)
            if not spoken:
                raise ValueError("The live model returned no usable classroom explanation")
            if outbound_item and decision.move in _INTRO:
                stem = clean_speech(outbound_item.get("stem_spoken") or outbound_item["stem"])
                if stem:
                    await say({"text": stem, "emotion": "neutral"})
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
            add("beat.cancelled", {"gen": gen, "reason": "student", "heard_seq": event.get("heard_seq", 0)})

        observation = None
        proof = decision.args.get("evidence")
        retry = event["type"] == "student_answer" and decision.move != "PROBE"
        if proof and (proof.get("record", True) or retry):
            observed_item = _item_for_ask({"kind": "item", "item_id": proof["item_id"]}, plan)
            observation = {
                **proof, "item": observed_item, "via": event.get("via", "text"),
                "detail": {key: event[key] for key in ("value", "gap", "misconception") if key in event},
            }
            approaches = state.get("approaches_used", [])
            if (
                proof.get("purpose") == "check" and proof.get("record", True)
                and proof.get("hint_level", 0) == 0 and not state.get("approach_stat_recorded")
                and approaches
            ):
                observation["approach_kind"] = approaches[-1]
                next_state["approach_stat_recorded"] = True
        recap, cards = None, ()
        if next_state.get("stage") == "done":
            status = "done"
            recap, cards = await finish_lesson(
                self.repository, self.gateway, self.space_id, self.lesson_id, plan, next_state,
            )
        recorded = await self._commit(
            lesson, gen, events, next_state, board, status=status, observation=observation, recap=recap, cards=cards,
        )
        if status == "done":
            replanned = await rebuild_course_plan(
                self.repository, self.gateway, self.space_id, today=date.today(), reason="lesson_finished",
            )
            if replanned is not None:
                if self.jobs is None:
                    await prepare_upcoming_lessons(self.repository, self.gateway, self.space_id)
                else:
                    await queue_upcoming_lessons(self.jobs, self.repository, self.space_id)
        return recorded

    async def prepare_next(self) -> PreparedBeat | None:
        """Generate the deterministic post-playback beat without advancing durable state."""
        lesson = await asyncio.to_thread(self.repository.get_lesson, self.space_id, self.lesson_id)
        if lesson is None or lesson["status"] != "active" or "playback_after_seq" not in lesson["state"]:
            return None
        saved = await asyncio.to_thread(
            self.repository.get_lesson_plan, self.space_id, lesson["plan_item_id"],
            lesson_plan_id=lesson["lesson_plan_id"],
        )
        if saved is None:
            return None
        plan = saved["plan"]
        state = lesson["state"]
        decision = Director.decide(state, {"type": "beat_done"}, await asyncio.to_thread(self._learner), plan)
        if not decision.move:
            return None
        decision_item = plan["items"].get(decision.args.get("item_id"))
        outbound_item = _item_for_ask(decision.ask, plan)
        context = await asyncio.to_thread(self._context, lesson, plan, {**state, **decision.state_patch}, decision.args)
        board = {key: dict(value) for key, value in (lesson["board"] or {}).items()}
        events = tuple([
            event async for event in self.realizer.run(
                decision, context=context, board=board, item=decision_item or outbound_item,
            )
        ])
        return PreparedBeat(
            expected_seq=lesson["seq"], move=decision.move, args=decision.args, ask=decision.ask, events=events,
        )

    async def _commit(
        self, lesson: dict, gen: int, events: list[dict], state: dict, board: dict,
        *, status: str, observation: dict | None = None, recap: dict | None = None, cards=(),
    ) -> list[dict]:
        events.append({
            "type": "state",
            "data": {
                "stage": state.get("stage"),
                "seg_idx": state.get("seg_idx", 0),
                "kp_cursor": state.get("kp_cursor", 0),
                "style_id": state.get("style_id"),
                "paused": status == "paused",
            },
            "t_ms": time_ns() // 1_000_000,
        })
        writing = asyncio.create_task(asyncio.to_thread(
            self.repository.append_lesson_events,
            self.space_id, self.lesson_id, gen=gen, events=events, state=state, board=board, status=status,
            expected_seq=lesson["seq"], observation=observation, recap=recap,
            carry_over=state.get("carry_over"), cards=cards,
        ))
        try:
            recorded = await asyncio.shield(writing)
        except asyncio.CancelledError:
            await writing
            raise
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
            if event.get("prefill") and intent == "answer" and item and item["type"] in OBJECTIVE_TYPES:
                return {"type": "prefill", "data": {"item_id": ask["item_id"], "value": result["value"],
                                                     "via": event.get("via", "text")}}
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
            approaches = conn.execute("SELECT kind, n, success FROM approach_stats").fetchall()
        return {
            **learner, "mastery": {row["kp_id"]: row["p"] for row in rows},
            "approach_stats": {row["kind"]: {"n": row["n"], "success": row["success"]} for row in approaches},
        }

    def _context(
        self, lesson: dict, plan: dict, state: dict, args: dict, *, recent_avatar_action: str | None = None,
    ) -> dict:
        context = {
            "title": plan["title"], "objectives": plan.get("objectives", []),
            "style_id": state.get("style_id", "guided"), "pace": state.get("pace", "normal"),
            "move_data": {key: value for key, value in args.items() if key not in {"evidence", "judge"}},
            "resolved_questions": state.get("items_done", {}),
            "recent_board": list((lesson["board"] or {}).values())[-15:],
        }
        if recent_avatar_action:
            context["recent_avatar_action"] = recent_avatar_action
        if lesson.get("character_id"):
            character = TutorCatalog(self.repository).resolve_active_character(lesson["character_id"])
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
        active_kp_id = segments[idx]["kp_id"] if idx < len(segments) else None
        memories = build_compact_memory_summary(
            self.repository, space_id=self.space_id, kp_id=active_kp_id, max_chars=150,
        )
        if memories:
            context["learner_memories"] = memories
        return context


async def _as_async(events):
    if hasattr(events, "__aiter__"):
        async for event in events:
            yield event
        return
    for event in events:
        yield event
