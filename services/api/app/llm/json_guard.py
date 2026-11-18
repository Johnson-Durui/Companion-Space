from __future__ import annotations

import json
import re
from typing import Any

from json_repair import loads as repair_loads

from app.llm.errors import LLMOutputError

_UNICODE_ESCAPE = re.compile(r"u[0-9a-fA-F]{4}")
_WORD = re.compile(r"[A-Za-z]{2,}")
_VALID_ESCAPES = frozenset('"\\/bfnrtu')


def _protect_backslashes(source: str) -> str:
    parts: list[str] = []
    inside = False
    cursor = 0
    while cursor < len(source):
        character = source[cursor]
        cursor += 1
        if character == '"':
            inside = not inside
        elif inside and character == "\\" and cursor < len(source):
            following = source[cursor]
            unicode_escape = _UNICODE_ESCAPE.match(source, cursor)
            if not unicode_escape and (following not in _VALID_ESCAPES or _WORD.match(source, cursor)):
                parts.append("\\")
            parts.extend((character, following))
            cursor += 1
            continue
        elif inside and ord(character) < 32:
            raise LLMOutputError(public_detail="The JSON response contains a control character.")
        parts.append(character)
    return "".join(parts)


def _check_text(value: Any) -> None:
    if isinstance(value, str) and any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise LLMOutputError(public_detail="The JSON response contains a control character.")
    if isinstance(value, dict):
        for key, item in value.items():
            _check_text(key)
            _check_text(item)
    if isinstance(value, list):
        for item in value:
            _check_text(item)


def loads_lenient(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end < start:
        raise LLMOutputError(public_detail="Return a JSON object with its opening and closing braces.")
    candidate = _protect_backslashes(text[start:end+1])
    try:
        value = json.loads(candidate)
    except (ValueError, RecursionError):
        try:
            value = repair_loads(candidate)
        except (ValueError, RecursionError):
            raise LLMOutputError(public_detail="The response could not be parsed as a JSON object.") from None
    if not isinstance(value, dict):
        raise LLMOutputError(public_detail="The response must contain a JSON object.")
    _check_text(value)
    return value
