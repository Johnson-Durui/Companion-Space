from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Persona = Literal["strong", "weak", "confused", "guesser", "answer_seeker"]
PERSONAS: tuple[Persona, ...] = ("strong", "weak", "confused", "guesser", "answer_seeker")


def _wrong_answer(item: dict) -> str | list[str]:
    if item.get("type") in {"choice", "multi"}:
        options = item.get("options") or []
        entries = list(options) if isinstance(options, dict) else [entry.get("key") for entry in options]
        correct = item.get("answer")
        return next((str(entry) for entry in entries if str(entry) != str(correct)), "")
    return "0" if str(item.get("answer")) != "0" else "1"


@dataclass
class SimulatedStudent:
    """Deterministic classroom driver; model-backed prose is handled by the eval runner."""

    persona: Persona
    confused_counts: dict[tuple[int, int], int] = field(default_factory=dict)
    turns: int = 0

    def next_event(self, state: dict, plan: dict) -> dict:
        self.turns += 1
        ask = state.get("active_ask") or {}
        if ask.get("kind") == "item":
            item = plan["items"][ask["item_id"]]
            if self.persona == "answer_seeker" and int((state.get("item") or {}).get("hint_level", 0)) < 2:
                return {"type": "quick_action", "kind": "show_answer"}
            if self.persona == "weak" and int((state.get("item") or {}).get("attempts", 0)) == 0:
                return {"type": "student_answer", "item_id": ask["item_id"], "dont_know": True, "via": "control"}
            value = item.get("answer") if self.persona in {"strong", "confused"} else _wrong_answer(item)
            return {"type": "student_answer", "item_id": ask["item_id"], "value": value, "via": "control"}
        if ask:
            return {"type": "ask_reply", "purpose": ask.get("purpose"), "value": "I guessed."}
        if "playback_after_seq" in state:
            if self.persona == "confused" and state.get("stage") == "teaching":
                key = (int(state.get("seg_idx", 0)), int(state.get("kp_cursor", 0)))
                count = self.confused_counts.get(key, 0)
                if count < 3:
                    self.confused_counts[key] = count + 1
                    return {"type": "quick_action", "kind": "confused"}
            return {"type": "beat_done"}
        return {"type": "lesson_resume"}
