from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing

from app.core.config import APP_ROOT
from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block, render_prompt
from app.providers.base import Message
from app.teaching.director import Decision
from app.teaching.lsp_parser import LspEvent, LspParser
from app.teaching.speech_text import clean_speech
from app.teaching.validators import answer_leaks, build_forbidden, validate_board

_BUDGET = {"slow": 90, "normal": 140, "fast": 200}
_PRIVATE = {"HINT", "FEEDBACK_CORRECT", "FEEDBACK_PARTIAL", "SHOW_SOLUTION", "PROBE"}
_PROTECTED = {"HINT", "FEEDBACK_PARTIAL", "PROBE", "NUDGE", "RESUME", "CLARIFY"}
_ITEM_INTRO = {"CHECK", "PRACTICE_ITEM", "VERIFY_SKIP"}
_STYLE = {
    "guided": "Guide the learner with one focused step at a time.",
    "direct": "Give the key idea first. Keep the explanation concise.",
    "analogy": "Use comparisons from the prepared outline and state where they stop applying.",
    "exam": "Connect to an assessed skill or marking requirement when supplied.",
    "rigorous": "State conditions explicitly. Separate definitions from conclusions.",
}
_INSTRUCTIONS = {
    "OPEN": "Welcome the learner. State the supplied objectives and the reason for this lesson.",
    "PREDICT": "Ask for a prediction without giving away its result.",
    "EXPLAIN": "Explain the current keypoint using the selected approach.",
    "EXAMPLE": "Walk through the supplied verified example, without adding another example.",
    "REEXPLAIN": "Use the selected new approach and break the keypoint into smaller steps.",
    "REPEAT": "Repeat the current explanation more slowly.",
    "HINT": "Help the learner find a next step. Never reveal the answer, solution, or confirming option.",
    "FEEDBACK_CORRECT": "Explain which step of the learner's reasoning was right using the verified item.",
    "FEEDBACK_PARTIAL": "Acknowledge the part that was right, then invite the learner to fill one gap.",
    "SHOW_SOLUTION": "Walk through the supplied verified solution in order. Do not change it.",
    "PROBE": "Ask for the learner's reasoning without revealing the expected reasoning.",
    "BACKFILL": "Review the supplied prerequisite outline. Do not create questions or solutions.",
    "ANSWER_QUESTION": "Answer the learner's question using the supplied excerpts.",
    "RESUME": "Reconnect to the current activity in one sentence without giving away the answer.",
    "ADJUST": "Confirm the requested adjustment briefly.",
    "STUDENT_SUMMARY": "Invite the learner to summarize the segment in their own words.",
    "TRANSITION": "Recap the previous segment and introduce the next activity.",
    "CLARIFY": "Ask the learner to clarify what they meant.",
    "NUDGE": "Offer time or a hint in one sentence without giving away the answer.",
    "BREAK": "Acknowledge the request for a break.",
    "WRAP": "Sum up only what happened and identify what still needs practice from the lesson record.",
    **dict.fromkeys(_ITEM_INTRO, "Say one transition sentence only. Do not say the question or options."),
}
_EMOTIONS = {"neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned"}
_LOG = logging.getLogger(__name__)


class Realizer:
    def __init__(self, gateway: LLMGateway) -> None:
        self.gateway = gateway
        self.prompt_dir = APP_ROOT / "libs" / "prompts" / "v3"

    async def run(
        self,
        decision: Decision,
        *,
        context: dict,
        board: dict,
        item: dict | None = None,
        cancel: asyncio.Event | None = None,
    ) -> AsyncIterator[LspEvent]:
        move = decision.move
        if move is None:
            return
        if item and item.get("verify", {}).get("status") != "verified":
            raise ValueError("An unverified item cannot be presented")
        budget = _BUDGET.get(context.get("pace"), _BUDGET["normal"])
        style = _STYLE.get(context.get("style_id"), _STYLE["guided"])
        data = data_block("lesson", json.dumps(context, ensure_ascii=False))
        if item and move in _PRIVATE:
            data += "\n" + data_block("item_private", json.dumps(item, ensure_ascii=False))
        instruction = f"{_INSTRUCTIONS[move]} {style} Total spoken text: at most {budget} characters."
        system = render_prompt(self.prompt_dir, "live/system", {})
        protected = item is not None and move in _PROTECTED
        for attempt in range(2 if protected else 1):
            retry = "\nDo not state any answer term, result, or option identifier." if attempt else ""
            prompt = render_prompt(self.prompt_dir, "live/context", {
                "classroom_context": data,
                "classroom_instruction": instruction + retry,
            })
            events = self._generate(system, prompt, board, budget, cancel)
            if not protected:
                async with aclosing(events):
                    async for event in events:
                        yield event
                return
            buffered = [event async for event in events]
            forbidden = build_forbidden(item)
            visible = "\n".join(block.get("content", "") for block in board.values())
            text = " ".join(
                str(event.data.get(key, ""))
                for event in buffered
                for key in ("text", "title", "content")
            )
            if text.strip() and not answer_leaks(text, forbidden, visible_text=visible):
                for event in buffered:
                    yield event
                return

        if move == "HINT":
            fallback = (item.get("fallback_hints") or {}).get(str(decision.args.get("level")), "")
        else:
            messages = json.loads((APP_ROOT / "services/api/app/i18n/zh-CN.json").read_text(encoding="utf-8"))
            fallback = messages["lesson_protected_reply"]
        fallback = clean_speech(fallback)
        if not fallback or answer_leaks(fallback, forbidden, visible_text=visible):
            raise ValueError("The teacher could not produce a safe hint")
        yield LspEvent("say", {"text": fallback, "emotion": "neutral"})

    async def _generate(
        self, system: str, prompt: str, board: dict, budget: int, cancel: asyncio.Event | None,
    ) -> AsyncIterator[LspEvent]:
        parser = LspParser(board)
        blocks = {block_id: dict(block) for block_id, block in board.items()}
        spoken = 0
        invalid_ops = 0

        def validate(events: list[LspEvent]):
            nonlocal spoken, invalid_ops
            for event in events:
                if event.type == "say":
                    text = clean_speech(event.data["text"])[:45].rstrip()
                    if not text:
                        continue
                    if spoken + len(text) > budget:
                        spoken = budget
                        continue
                    spoken += len(text)
                    emotion = event.data["emotion"]
                    yield LspEvent("say", {"text": text, "emotion": emotion if emotion in _EMOTIONS else "neutral"})
                elif validate_board(event, blocks):
                    yield event
                else:
                    invalid_ops += 1

        chunks = self.gateway.stream_text("live", system, [Message(role="user", content=prompt)], cancel=cancel)
        async with aclosing(chunks):
            async for chunk in chunks:
                for event in validate(parser.feed(chunk)):
                    yield event
        for event in validate(parser.finish()):
            yield event
        if parser.stray_text or parser.stray_ask or invalid_ops:
            _LOG.info(
                "lsp_stray_text=%d lsp_stray_ask=%d lsp_invalid_ops=%d", parser.stray_text, parser.stray_ask, invalid_ops,
            )
