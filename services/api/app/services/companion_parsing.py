from __future__ import annotations

import json

from pydantic import ValidationError

from app.models.domain import BoardAction
from app.services.prompt_loader import PromptLoader


ALLOWED_EMOTIONS = {
    "neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned",
}


def sanitize_board_actions(raw_board_actions: object) -> list[BoardAction]:
    if not isinstance(raw_board_actions, list):
        return []
    sanitized: list[BoardAction] = []
    for item in raw_board_actions[:1]:
        if not isinstance(item, dict):
            continue
        try:
            sanitized.append(BoardAction.model_validate(item))
        except ValidationError:
            continue
    return sanitized[:1]


def parse_provider_payload(raw_text: str) -> dict:
    cleaned = PromptLoader.strip_code_fences(raw_text)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        payload = {
            "display_text": cleaned,
            "spoken_text": cleaned,
            "emotion": "warm",
            "suggested_actions": [],
        }
    if not isinstance(payload, dict):
        payload = {}
    display_text = payload.get("display_text")
    if not isinstance(display_text, str) or not display_text.strip():
        display_text = cleaned or "这轮未能生成有效回复。"
    spoken_text = payload.get("spoken_text")
    if not isinstance(spoken_text, str) or not spoken_text.strip():
        spoken_text = display_text
    emotion = payload.get("emotion")
    if emotion not in ALLOWED_EMOTIONS:
        emotion = "warm"
    suggested_actions = payload.get("suggested_actions")
    if not isinstance(suggested_actions, list):
        suggested_actions = []
    return {
        "display_text": display_text.strip(),
        "spoken_text": spoken_text.strip(),
        "emotion": emotion,
        "board_actions": sanitize_board_actions(payload.get("board_actions")),
        "suggested_actions": [
            action.strip()
            for action in suggested_actions
            if isinstance(action, str) and action.strip()
        ][:3],
    }
