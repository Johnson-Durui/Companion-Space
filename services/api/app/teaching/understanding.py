from __future__ import annotations

import json
import re
import unicodedata
import warnings
from collections.abc import Mapping, Sequence
from decimal import Decimal
from fractions import Fraction
from typing import Any

from app.analysis.item_verifier import numeric_value
from app.llm.errors import LLMOutputError
from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks

_OBJECTIVE = {"choice", "multi", "numeric", "short"}
_RUBRIC = {"explain", "steps", "proof", "essay"}


def canonical_item_type(kind: str) -> str:
    return {"short_answer": "short", "blank": "short", "proof": "steps", "essay": "explain"}.get(kind, kind)
_INTENTS = {
    "answer", "question", "confusion", "request_example", "request_hint", "request_answer",
    "request_repeat", "request_slower", "request_faster", "request_style", "request_break",
    "skip_claim", "ack", "chitchat", "off_topic", "stop", "unclear",
}
_STYLES = {"guided", "direct", "analogy", "exam", "rigorous"}
_FIELDS = {"intent", "value", "style_id", "verdict", "hits", "reason", "right", "gap", "misconception", "evidence"}
_NUMBER_GLYPHS = str.maketrans("０１２３４５６７８９＋－．／−⁄", "0123456789+-./-/")


class InvalidAnswer(ValueError):
    """The student did not submit a valid value for this item."""


def _require_verified(item: Mapping[str, Any]) -> None:
    verify = item.get("verify")
    if not isinstance(verify, Mapping) or verify.get("status") != "verified":
        raise ValueError("Only a verified item may be graded.")


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip()


def _key(value: str) -> str:
    return _normalized(value).casefold()


def _number(value: object) -> Fraction | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = format(Decimal(str(value)), "f") if isinstance(value, float) else str(value)
    text = re.sub(r"\s*/\s*", "/", text.translate(_NUMBER_GLYPHS).strip())
    return numeric_value(text) if not any(char.isspace() for char in text) else None


def _choice_value(item: Mapping[str, Any], value: object) -> str | list[str]:
    options = item.get("options") or []
    keys = options.keys() if isinstance(options, Mapping) else [option["key"] for option in options]
    by_key = {_key(key): key for key in keys}
    if len(by_key) < 2 or len(by_key) != len(keys) or "" in by_key:
        raise ValueError("A choice item must have distinct nonempty options.")

    multiple = item["type"] == "multi"
    if isinstance(value, str):
        normalized = _normalized(value)
        values = re.split(r"[,、\s]+", normalized) if multiple else [normalized]
        if multiple and len(values) == 1 and _key(normalized) not in by_key and all(len(key) == 1 for key in by_key):
            values = list(normalized)
    elif multiple and isinstance(value, (list, tuple)):
        values = list(value)
    else:
        raise InvalidAnswer("Select an available option.")
    if not values or any(not isinstance(entry, str) or _key(entry) not in by_key for entry in values):
        raise InvalidAnswer("Select available options.")
    selected = [by_key[_key(entry)] for entry in values]
    if len(set(selected)) != len(selected):
        raise InvalidAnswer("Select each option once.")
    return sorted(selected) if multiple else selected[0]


def _choice_reference(item: Mapping[str, Any]) -> str | list[str]:
    answer = item.get("answer")
    try:
        return _choice_value(item, answer)
    except InvalidAnswer as exc:
        if item["type"] == "choice" and isinstance(answer, str):
            options = item["options"]
            entries = options.items() if isinstance(options, Mapping) else (
                (option["key"], option["text"]) for option in options
            )
            keys = [key for key, text in entries if isinstance(text, str) and _key(text) == _key(answer)]
            if len(keys) == 1:
                return keys[0]
        raise ValueError("The verified choice answer is invalid.") from exc


def _objective_value(item: Mapping[str, Any], value: object) -> str | list[str]:
    if item["type"] in {"choice", "multi"}:
        return _choice_value(item, value)
    if item["type"] == "numeric":
        number = _number(value)
        if number is None:
            raise InvalidAnswer("Enter a valid numeric answer.")
        return str(number)
    if not isinstance(value, str) or not value.strip():
        raise InvalidAnswer("Enter an answer.")
    return value.strip()


def grade_objective(item: Mapping[str, Any], value: object, *, dont_know: bool = False) -> dict:
    """Grade a verified item submitted through an answer control using its reference."""
    _require_verified(item)
    item_type = item.get("type")
    if item_type not in _OBJECTIVE:
        raise ValueError("Expected an objective item.")
    result: dict[str, Any] = {"judged_by": "exact", "value": None, "verdict": "dont_know"}
    if dont_know:
        return result

    if item_type == "numeric":
        reference, tolerance = _number(item.get("answer")), _number(item.get("tolerance", 0))
        if reference is None or tolerance is None or tolerance < 0:
            raise ValueError("The verified numeric answer or tolerance is invalid.")
        value = _objective_value(item, value)
        correct = abs(Fraction(value) - reference) <= tolerance
    elif item_type == "short":
        accepted = item.get("accepted") or [item.get("answer")]
        if not isinstance(accepted, (list, tuple)) or not all(isinstance(answer, str) and answer.strip() for answer in accepted):
            raise ValueError("The verified short answer is missing or invalid.")
        value = _objective_value(item, value)
        correct = value in {answer.strip() for answer in accepted}
    else:
        reference = _choice_reference(item)
        value = _objective_value(item, value)
        correct = value == reference
    result.update(value=value, verdict="correct" if correct else "incorrect")
    if item_type == "choice" and not correct:
        distractor = (item.get("distractors") or {}).get(value) or {}
        result.update(gap=distractor.get("text", ""), prereq_kp=distractor.get("prereq_kp"))
    return result


def _rubric_points(item: Mapping[str, Any]) -> list[dict]:
    rubric = item.get("rubric")
    raw_points = rubric.get("points") if isinstance(rubric, Mapping) else rubric
    if not isinstance(raw_points, list):
        raise ValueError("A verified rubric item must have scoring points.")
    points = []
    for index, point in enumerate(raw_points, start=1):
        if isinstance(point, str):
            point = {"text": point, "required": True}
        if not isinstance(point, Mapping) or not isinstance(point.get("text"), str) or not point["text"].strip():
            raise ValueError("A rubric point must have text.")
        required = point.get("required", True)
        if not isinstance(required, bool):
            raise ValueError("A rubric scoring requirement must be a boolean.")
        points.append({"number": index, "text": point["text"], "required": required})
    if not any(point["required"] for point in points):
        raise ValueError("A verified rubric item requires at least one scoring point.")
    return points


def _unclear(issue: str) -> dict:
    return {"intent": "unclear", "verdict": "na", "reason": "na", "value": None, "issue": issue}


def _parse(
    raw: str, student_text: str, item: Mapping[str, Any] | None, points: list[dict], *, probe: bool,
) -> dict:
    fields: dict[str, str] = {}
    with warnings.catch_warnings(record=True) as malformed:
        nodes = parse_blocks(raw)
    if malformed:
        raise ValueError("Unclosed understanding tag.")
    for node in nodes:
        if node.tag not in _FIELDS or node.tag in fields or node.children or node.attrs:
            raise ValueError("Unexpected understanding field.")
        fields[node.tag] = node.text.strip()
    intent = fields.get("intent")
    if intent not in _INTENTS:
        raise ValueError("Expected a valid student intent.")
    result: dict[str, Any] = {"intent": intent, "verdict": "na", "reason": "na", "value": None}
    if intent == "request_style":
        style_id = fields.get("style_id")
        if style_id not in _STYLES:
            raise ValueError("Expected a supported teaching style.")
        result["style_id"] = style_id
    if intent != "answer":
        return result

    evidence = fields.get("evidence", "")
    if probe:
        reason = fields.get("reason", "none")
        if reason not in {"sound", "unsound", "none"} or (reason != "none" and (not evidence or evidence not in student_text)):
            raise ValueError("A reason judgment must cite the student.")
        return {**result, "reason": reason, "evidence": evidence, "judged_by": "model"}
    if item is not None and item.get("type") in _OBJECTIVE:
        try:
            return {**result, "value": _objective_value(item, fields.get("value"))}
        except InvalidAnswer:
            return _unclear("answer_value_invalid")
    if not points:
        return result

    if not evidence or evidence not in student_text:
        raise ValueError("A rubric judgment must cite the student.")
    hits_text = fields.get("hits", "")
    if hits_text and not re.fullmatch(r"[0-9]{1,4}(?:\s*[,，]\s*[0-9]{1,4})*", hits_text):
        raise ValueError("Expected comma-separated rubric point numbers.")
    hits = {int(hit) for hit in re.split(r"[,，]", hits_text) if hit}
    if not hits.issubset({point["number"] for point in points}):
        raise ValueError("Rubric points must come from the verified item.")
    required = {point["number"] for point in points if point["required"]}
    verdict = fields.get("verdict")
    if verdict not in {"correct", "partial", "incorrect", "dont_know"} or (verdict == "dont_know" and hits):
        raise ValueError("Expected a rubric verdict consistent with its hits.")
    if (verdict == "correct" and not required.issubset(hits)) or (verdict == "incorrect" and hits):
        verdict = "partial"
    if verdict == "partial" and (not fields.get("right") or not fields.get("gap")):
        raise ValueError("Partial credit requires feedback on both strengths and gaps.")
    return {
        **result, "verdict": verdict, "hits": sorted(hits), "judged_by": "model",
        **{key: fields.get(key, "") for key in ("right", "gap", "misconception", "evidence")},
    }


async def understand(
    gateway: LLMGateway, student_text: str, *, item: Mapping[str, Any] | None = None,
    active_ask: Mapping[str, Any] | None = None, recent_dialogue: Sequence[Any] = (),
    known_misconceptions: Sequence[str] = (),
) -> dict:
    """Classify input and extract a prefill or grade a verified rubric response."""
    if not student_text.strip():
        return _unclear("student_text_empty")
    probe = (active_ask or {}).get("purpose") == "probe"
    points: list[dict] = []
    grading: dict[str, Any] = {}
    if probe and (item is None or not item.get("solution")):
        raise ValueError("A reason judgment requires a verified solution.")
    if item is not None:
        _require_verified(item)
        if probe:
            grading = {"reason_basis": item.get("solution", "")}
        elif item.get("type") in _RUBRIC:
            points = _rubric_points(item)
            grading = {"points": points}
    context = {
        "active_ask": {key: active_ask.get(key) for key in ("kind", "purpose")} if active_ask else None,
        "recent_dialogue": list(recent_dialogue[-6:]),
        "known_misconceptions": list(known_misconceptions),
    }
    public_item = {key: item.get(key) for key in ("type", "stem", "options")} if item else None
    try:
        return await gateway.complete_tagged(
            "live", "live/understand",
            {
                "item_context": data_block("context", json.dumps(context, ensure_ascii=False)),
                "item_stem": data_block("item", json.dumps(public_item, ensure_ascii=False)),
                "item_rubric": data_block("grading", json.dumps(grading, ensure_ascii=False)),
                "candidate_answer": data_block("student", student_text),
            },
            parse=lambda raw: _parse(raw, student_text, item, points, probe=probe),
            cache=False, max_tokens=768,
        )
    except LLMOutputError as exc:
        return _unclear(exc.public_code)
