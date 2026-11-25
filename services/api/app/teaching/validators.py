from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Mapping
from fractions import Fraction
from typing import Any

from app.analysis.item_verifier import numeric_value
from app.teaching.lsp_parser import LspEvent
from app.teaching.speech_text import clean_speech as clean_speech
from app.teaching.speech_text import speech_terms

_NUMBER = re.compile(r"(?<![\d.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:/[+-]?\d+|%)?(?!\d|\.\d)")
_WORD_EDGES = r"(?<![a-z0-9_]){}(?![a-z0-9_])"
_BLOCK_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
_PARAM_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,15}")
_BLOCK_TYPES = {
    "title", "text", "math", "list", "table", "code", "callout", "steps", "diagram", "plot", "image",
}


def _normalize(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", "" if value is None else str(value)).casefold().split())


def _number(value: str) -> Fraction | None:
    number = numeric_value(value.rstrip("%"))
    return number / 100 if number is not None and value.endswith("%") else number


def _terms_outside_stem(values: list, stem: str, min_length: int) -> list[str]:
    terms = (_normalize(value) for value in values)
    return list(dict.fromkeys(term for term in terms if len(term) >= min_length and term not in stem))


def build_forbidden(item: dict) -> dict:
    kind = item.get("type")
    stem = _normalize(item.get("stem"))
    answer = _normalize(item.get("answer"))
    terms: list[str] = []
    patterns: list[str] = []
    number = None
    if kind in {"choice", "multi"}:
        keys = list(dict.fromkeys(part for part in re.split(r"[,，、\s]+", answer) if part))
        if keys:
            keys_pattern = "|".join(map(re.escape, sorted(keys, key=len, reverse=True)))
            cues = "|".join(map(re.escape, speech_terms()["choice_cues"]))
            cue = rf"(?:{cues}|\b(?:choose|answer\s+is)\s+)"
            patterns.append(rf"{cue}\s*[:：]?\s*(?:[\"'({{【]\s*)?(?:{keys_pattern})(?![a-z0-9_])")
        options = item.get("options") or []
        terms = _terms_outside_stem(
            [option.get("text") for option in options if _normalize(option.get("key")) in keys],
            stem,
            3,
        )
    elif kind == "numeric":
        parsed = _number(answer)
        if parsed is not None and not any(_number(match[0]) == parsed for match in _NUMBER.finditer(stem)):
            number = str(parsed)
    elif kind == "short":
        accepted = item.get("accepted") or [item.get("answer")]
        patterns = [_WORD_EDGES.format(re.escape(term)) for term in _terms_outside_stem(accepted, "", 2)]
    elif kind in {"explain", "steps"}:
        rubric = item.get("rubric")
        points = rubric.get("points", []) if isinstance(rubric, Mapping) else rubric if isinstance(rubric, list) else []
        terms = _terms_outside_stem([
            point.get("key") or point.get("text") if isinstance(point, Mapping) else point for point in points
        ], stem, 1)
    return {"terms": terms, "patterns": patterns, "number": number}


def answer_leaks(text: str, forbidden: dict, *, visible_text: str = "") -> bool:
    text = _normalize(text)
    if any(term in text for term in forbidden["terms"]):
        return True
    if any(re.search(pattern, text) for pattern in forbidden["patterns"]):
        return True
    if not forbidden.get("number"):
        return False
    number = _number(forbidden["number"])
    if number is None:
        return False
    if any(_number(match[0]) == number for match in _NUMBER.finditer(_normalize(visible_text))):
        return False
    single_digit = number.denominator == 1 and abs(number) <= 9
    cues = (*speech_terms()["numeric_cues"], "=", "equals", "equal")
    return any(
        _number(match[0]) == number
        and (not single_digit or text[:match.start()].rstrip().endswith(cues))
        for match in _NUMBER.finditer(text)
    )


def validate_board(event: LspEvent, blocks: dict[str, dict[str, Any]]) -> bool:
    """Validate against and advance a copy of the visible board for this generation."""
    data = event.data
    if event.type not in {"board", "mark", "point", "board_param"}:
        return True
    if event.type == "board_param":
        target = data.get("target")
        name = data.get("name")
        raw_value = data.get("value")
        if not isinstance(target, str) or not isinstance(name, str) or not _PARAM_NAME.fullmatch(name):
            return False
        block = blocks.get(target)
        if block is None or block.get("type") != "plot":
            return False
        try:
            numeric = float(raw_value)
        except (TypeError, ValueError):
            return False
        if not math.isfinite(numeric):
            return False
        try:
            spec = json.loads(block.get("content", ""))
        except (TypeError, ValueError):
            return False
        params = spec.get("params") if isinstance(spec, dict) else None
        if not isinstance(params, list):
            return False
        matched = next(
            (entry for entry in params if isinstance(entry, dict) and entry.get("name") == name),
            None,
        )
        if matched is None:
            return False
        low, high = matched.get("min"), matched.get("max")
        if (
            type(low) not in (int, float)
            or type(high) not in (int, float)
            or not (math.isfinite(low) and math.isfinite(high) and low < high)
            or not (low <= numeric <= high)
        ):
            return False
        data["value"] = numeric
        param_values = block.setdefault("param_values", {})
        if isinstance(param_values, dict):
            param_values[name] = numeric
        return True
    if event.type == "board":
        op = data["op"]
        if op == "clear":
            blocks.clear()
            return True
        if op == "add":
            block_id, kind = data["id"], data["type"]
            if not _BLOCK_ID.fullmatch(block_id) or block_id in blocks or kind not in _BLOCK_TYPES:
                return False
            if kind in {"plot", "image"}:
                try:
                    spec = json.loads(data["content"])
                except ValueError:
                    return False
                if not isinstance(spec, dict):
                    return False
            blocks[block_id] = dict(data)
            return True
        target = data.get("target")
        if op not in {"append", "update"} or target not in blocks:
            return False
        block = blocks[target]
        if op == "append":
            block["content"] += "\n" + data["content"]
        else:
            block["content"] = data["content"]
        return True
    block_id, _, line = data.get("target", "").partition(".")
    block = blocks.get(block_id)
    if block is None:
        return False
    if not line:
        return "." not in data.get("target", "")
    return line.isascii() and line.isdecimal() and len(line) < 8 and 1 <= int(line) <= len(block["content"].splitlines())
