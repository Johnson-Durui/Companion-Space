from __future__ import annotations

import json
import re
from copy import deepcopy
from fractions import Fraction

from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block
from app.llm.tagged import Node, parse_blocks


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _one(raw: str, tag: str) -> Node:
    nodes = [node for node in parse_blocks(raw) if node.tag == tag]
    if len(nodes) != 1:
        raise ValueError(f"Expected exactly one <{tag}>.")
    return nodes[0]


def _text(node: Node, tag: str, *, required: bool = True) -> str:
    children = node.many(tag)
    if not children:
        if required:
            raise ValueError(f"Expected <{tag}> in <{node.tag}>.")
        return ""
    if len(children) != 1:
        raise ValueError(f"Expected one <{tag}> in <{node.tag}>.")
    return children[0].text.strip()


def _boolean(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized not in {"true", "false"}:
        raise ValueError("Expected true or false.")
    return normalized == "true"


def _parse_solve(raw: str) -> dict:
    node = _one(raw, "solve")
    confidence = _text(node, "confidence").casefold()
    if confidence not in {"high", "medium", "low"}:
        raise ValueError("Solve confidence is invalid.")
    return {
        "answer": _text(node, "answer"),
        "confidence": confidence,
        "valid": _boolean(_text(node, "valid")),
        "reason": _text(node, "reason", required=False),
    }


def _parse_equivalence(raw: str) -> bool:
    return _boolean(_text(_one(raw, "comparison"), "equivalent"))


def _parse_choice(raw: str, valid_keys: set[str], *, multiple: bool) -> str | None:
    value = _text(_one(raw, "mapping"), "choice")
    if value == "INVALID":
        return None
    choices = [part.strip() for part in value.split(",") if part.strip()]
    if not choices or (not multiple and len(choices) != 1) or any(choice not in valid_keys for choice in choices):
        return None
    return ",".join(sorted(set(choices)))


def _parse_rubric(raw: str, required: set[str]) -> bool:
    node = _one(raw, "coverage")
    covered = {child.text.strip() for child in node.many("covered") if child.text.strip()}
    return required.issubset(covered)


def _parse_rewritten_rubric(raw: str) -> list[dict]:
    node = _one(raw, "rubric")
    result = []
    ids = set()
    for point in node.many("point"):
        point_id = _text(point, "id")
        if point_id in ids:
            raise ValueError("Rubric point identifiers must be unique.")
        ids.add(point_id)
        result.append({
            "id": point_id,
            "text": _text(point, "text"),
            "required": _boolean(_text(point, "required")),
        })
    if not result:
        raise ValueError("A rewritten rubric cannot be empty.")
    return result


def numeric_value(value: str) -> Fraction | None:
    compact = value.strip().replace(" ", "")
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:/[+-]?(?:\d+(?:\.\d*)?|\.\d+))?", compact):
        return None
    try:
        return Fraction(compact)
    except (ValueError, ZeroDivisionError):
        return None


class ItemVerifier:
    """Independently solve and compare items without mutating their source record."""

    def __init__(self, gateway: LLMGateway) -> None:
        self.gateway = gateway

    async def _solve(self, item: dict, attempt: int) -> dict:
        public_item = {
            "type": item.get("type"),
            "stem": item.get("stem", ""),
        }
        return await self.gateway.complete_tagged(
            "checker",
            "analysis/item_solve",
            {
                "item_stem": _json_block("item", public_item),
                "solve_attempt": str(attempt),
            },
            parse=_parse_solve,
            cache=True,
            max_tokens=2048,
        )

    async def _choice_key(self, answer: str, options: dict[str, str], *, multiple: bool) -> str | None:
        direct = [
            key for key, value in options.items()
            if value.strip().casefold() == answer.strip().casefold()
        ]
        if len(direct) == 1 and not multiple:
            return direct[0]
        return await self.gateway.complete_tagged(
            "checker",
            "analysis/item_choice_map",
            {
                "candidate_answer": data_block("answer", answer),
                "item_options": _json_block("options", options),
            },
            parse=lambda raw: _parse_choice(raw, set(options), multiple=multiple),
            cache=True,
            max_tokens=512,
        )

    async def _equivalent(self, left: str, right: str) -> bool:
        if left.strip().casefold() == right.strip().casefold():
            return True
        left_number, right_number = numeric_value(left), numeric_value(right)
        if left_number is not None and right_number is not None:
            return left_number == right_number
        return await self.gateway.complete_tagged(
            "checker",
            "analysis/item_equiv",
            {
                "candidate_answer": data_block("candidate", left),
                "reference_answer": data_block("reference", right),
            },
            parse=_parse_equivalence,
            cache=True,
            max_tokens=512,
        )

    async def _normalized_solve(self, item: dict, attempt: int) -> dict:
        solved = await self._solve(item, attempt)
        if not solved["valid"] or solved["confidence"] != "high" or solved["answer"] == "INVALID":
            return {**solved, "valid": False}
        if item.get("type") in {"choice", "multi"}:
            key = await self._choice_key(
                solved["answer"], item.get("options") or {}, multiple=item.get("type") == "multi",
            )
            if key is None:
                return {**solved, "valid": False, "reason": "The solution did not map to one choice."}
            return {**solved, "answer": key}
        return solved

    async def _verify_rubric(self, item: dict, solved: dict) -> dict:
        rubric = item.get("rubric") or []
        source_solution = item.get("solution")
        if not rubric and source_solution:
            # Derive the scoring criteria from the published solution, independently of the checker.
            rubric = await self._rewrite_rubric(item, source_solution, [])
        required = {
            str(point.get("id") if isinstance(point, dict) else point)
            for point in rubric
            if not isinstance(point, dict) or point.get("required", True)
        }
        if not required:
            return {"status": "unverified", "solved_answer": solved.get("answer"), "reason": "Missing rubric."}
        covered = await self._rubric_covered(solved["answer"], rubric, required)
        rewritten = None
        if not covered:
            rewritten = await self._rewrite_rubric(item, solved["answer"], rubric)
            rewritten_required = {
                str(point["id"]) for point in rewritten if point.get("required", True)
            }
            covered = await self._rubric_covered(
                solved["answer"], rewritten, rewritten_required,
            )
        result = {
            "status": "verified" if covered else "unverified",
            "solved_answer": solved["answer"],
            "reason": "All required rubric points are covered." if covered else "A required rubric point is missing.",
        }
        if covered:
            result["rubric"] = rewritten or rubric
        if rewritten is not None:
            result["rewritten_rubric"] = rewritten
        return result

    async def _rewrite_rubric(self, item: dict, candidate: str, rubric: list) -> list:
        return await self.gateway.complete_tagged(
            "analysis",
            "analysis/rubric_rewrite",
            {
                "item_context": _json_block(
                    "item", {"stem": item.get("stem", ""), "solution": item.get("solution")},
                ),
                "candidate_answer": data_block("answer", candidate),
                "item_rubric": _json_block("rubric", rubric),
            },
            parse=_parse_rewritten_rubric,
            cache=True,
            max_tokens=1024,
        )

    async def _rubric_covered(self, answer: str, rubric: list, required: set[str]) -> bool:
        return await self.gateway.complete_tagged(
            "checker",
            "analysis/rubric_cover",
            {
                "candidate_answer": data_block("answer", answer),
                "item_rubric": _json_block("rubric", rubric),
            },
            parse=lambda raw: _parse_rubric(raw, required),
            cache=True,
            max_tokens=1024,
        )

    async def verify(self, item: dict) -> dict:
        candidate = deepcopy(item)
        first = await self._normalized_solve(candidate, 1)
        if not first["valid"]:
            return {"status": "unverified", "solved_answer": None, "reason": first.get("reason", "Invalid solve.")}
        if candidate.get("type") in {"steps", "explain", "proof", "essay"}:
            return await self._verify_rubric(candidate, first)

        reference = candidate.get("answer")
        if reference:
            agrees = await self._equivalent(first["answer"], str(reference))
            if agrees:
                solution = candidate.get("solution")
                if solution and not await self._equivalent(str(reference), str(solution)):
                    return {
                        "status": "unverified",
                        "solved_answer": first["answer"],
                        "reason": "The supplied solution does not support the reference answer.",
                    }
                return {
                    "status": "verified",
                    "solved_answer": first["answer"],
                    "reason": "Independent solution agrees with the reference answer.",
                }
            second = await self._normalized_solve(candidate, 2)
            if not second["valid"]:
                return {
                    "status": "unverified",
                    "solved_answer": first["answer"],
                    "reason": "The second independent solution was invalid.",
                }
            if await self._equivalent(second["answer"], str(reference)):
                return {
                    "status": "verified",
                    "solved_answer": second["answer"],
                    "reason": "The second independent solution supports the reference answer.",
                }
            if await self._equivalent(second["answer"], first["answer"]):
                return {
                    "status": "disputed",
                    "solved_answer": first["answer"],
                    "reason": "Two independent solutions agree with each other and dispute the reference answer.",
                }
            return {
                "status": "unverified",
                "solved_answer": first["answer"],
                "reason": "The reference and two independent solutions disagree.",
            }

        second = await self._normalized_solve(candidate, 2)
        if second["valid"] and await self._equivalent(first["answer"], second["answer"]):
            return {
                "status": "verified",
                "solved_answer": first["answer"],
                "reason": "Two independent solutions agree.",
            }
        return {
            "status": "unverified",
            "solved_answer": first["answer"],
            "reason": "Two independent solutions do not agree.",
        }
