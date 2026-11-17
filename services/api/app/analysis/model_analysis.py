from __future__ import annotations

import json
import math
import re
import unicodedata
import uuid
from collections import defaultdict
from copy import deepcopy

import numpy as np
from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block
from app.llm.tagged import Node, parse_blocks
from app.rag.embeddings import extract_terms

_KP_KINDS = {"concept", "theorem", "formula", "method", "skill", "fact"}
_IMPORTANCE = {"core": 3, "important": 2, "peripheral": 1}
_ITEM_TYPES = {"choice", "multi", "numeric", "blank", "short", "proof", "essay", "steps", "explain"}
_NAMESPACE = uuid.NAMESPACE_URL


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _text(node: Node, tag: str, *, required: bool = True) -> str:
    values = node.many(tag)
    if not values:
        if required:
            raise ValueError(f"Expected <{tag}> in <{node.tag}>.")
        return ""
    if len(values) != 1:
        raise ValueError(f"Expected one <{tag}> in <{node.tag}>.")
    return values[0].text.strip()


def _root_nodes(raw: str, tag: str) -> list[Node]:
    opening = len(re.findall(rf"<{re.escape(tag)}(?:\s[^<>]*)?>", raw))
    closing = raw.count(f"</{tag}>")
    if opening != closing:
        raise ValueError(f"Unfinished <{tag}> block.")
    return [node for node in parse_blocks(raw) if node.tag == tag]


def _stable_id(*parts: object) -> str:
    return uuid.uuid5(_NAMESPACE, "/".join(str(part) for part in parts)).hex


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _parse_page_numbers(value: str, valid_pages: set[int]) -> list[int]:
    pages = {int(match) for match in re.findall(r"\d+", value)}
    if not pages.issubset(valid_pages):
        raise ValueError("A cited page is outside the supplied page range.")
    return sorted(pages)


def _optional_positive_number(value: str, field: str) -> float | None:
    if not value:
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{field} must be finite and positive.")
    return number


def _parse_kps(raw: str, *, material_id: str, unit_id: str, pages: list[dict]) -> dict:
    valid_pages = {int(page["page_no"]) for page in pages}
    points = []
    for order, node in enumerate(_root_nodes(raw, "kp")):
        name = _text(node, "name")
        kind = _text(node, "kind")
        importance = _text(node, "importance")
        difficulty = int(_text(node, "difficulty"))
        if kind not in _KP_KINDS or importance not in _IMPORTANCE or difficulty not in {1, 2, 3}:
            raise ValueError("Knowledge point enum value is invalid.")
        page_numbers = _parse_page_numbers(_text(node, "pages"), valid_pages)
        if not page_numbers:
            raise ValueError("A knowledge point must cite an input page.")
        must_know = [child.text.strip() for child in node.many("must_know") if child.text.strip()]
        pitfalls = [child.text.strip() for child in node.many("pitfall") if child.text.strip()]
        question_types = [child.text.strip() for child in node.many("question_type") if child.text.strip()]
        prerequisites = [child.text.strip() for child in node.many("prerequisite") if child.text.strip()]
        points.append({
            "id": f"candidate-{order}",
            "unit_id": unit_id,
            "name": name,
            "norm_name": normalize_name(name),
            "kind": kind,
            "summary": _text(node, "summary"),
            "must_know": must_know,
            "formula": _text(node, "formula", required=False) or None,
            "pitfalls": pitfalls,
            "question_types": question_types,
            "importance": importance,
            "difficulty": difficulty,
            "assumed": False,
            "ord": order,
            "source_refs": [
                {"material_id": material_id, "page_no": page_no} for page_no in page_numbers
            ],
            "prerequisite_names": prerequisites,
            "prerequisite_ids": [],
        })
    if not 1 <= len(points) <= 20:
        raise ValueError("Expected between 1 and 20 knowledge points.")
    return {"knowledge_points": points}


async def extract_knowledge_points(
    gateway: LLMGateway,
    *,
    course_id: str,
    material: dict,
    section: dict,
    pages: list[dict],
) -> dict:
    """Extract model-facing KP candidates without repository side effects."""
    material_id = str(material["id"])
    unit_id = str(section.get("unit_id") or section["id"])
    page_payload = [
        {"page_no": int(page["page_no"]), "markdown": str(page.get("markdown", ""))}
        for page in pages
    ]
    variables = {
        "course_context": _json_block("course", {"id": course_id, "material": material, "section": section}),
        "page_content": _json_block("pages", page_payload),
    }
    return await gateway.complete_tagged(
        "analysis",
        "analysis/kp_extract",
        variables,
        parse=lambda raw: _parse_kps(
            raw, material_id=material_id, unit_id=unit_id, pages=page_payload,
        ),
        cache=True,
        max_tokens=6144,
    )


def _parse_reduce(raw: str, candidate_keys: set[str]) -> dict:
    groups = []
    seen: set[str] = set()
    for node in _root_nodes(raw, "merge"):
        members = [child.text.strip() for child in node.many("member")]
        if not members or any(member not in candidate_keys or member in seen for member in members):
            raise ValueError("Merge groups must contain unique candidate keys.")
        seen.update(members)
        groups.append(members)
    groups.extend([[key] for key in sorted(candidate_keys - seen)])
    edges = []
    for node in _root_nodes(raw, "edge"):
        before, after = _text(node, "before"), _text(node, "after")
        if before not in candidate_keys or after not in candidate_keys or before == after:
            raise ValueError("Edge refers to an unknown candidate.")
        edges.append((before, after))
    external = []
    for node in _root_nodes(raw, "external"):
        used_by = [child.text.strip() for child in node.many("used_by")]
        if any(key not in candidate_keys for key in used_by):
            raise ValueError("External prerequisite refers to an unknown candidate.")
        if len(set(used_by)) >= 2:
            external.append({"name": _text(node, "name"), "used_by": sorted(set(used_by))})
    return {"groups": groups, "edges": edges, "external": external}


def _merge_point(group: list[dict]) -> dict:
    ordered = sorted(group, key=lambda point: (point.get("ord", 0), point["name"]))
    richest = max(ordered, key=lambda point: len(point.get("summary", "")))
    merged = deepcopy(richest)
    merged["name"] = ordered[0]["name"]
    merged["norm_name"] = normalize_name(merged["name"])
    merged["unit_id"] = ordered[0]["unit_id"]
    merged["ord"] = min(point.get("ord", 0) for point in ordered)
    merged["importance"] = max(ordered, key=lambda point: _IMPORTANCE[point["importance"]])["importance"]
    merged["difficulty"] = max(int(point.get("difficulty", 1)) for point in ordered)
    for field in ("must_know", "pitfalls", "question_types", "prerequisite_names"):
        merged[field] = list(dict.fromkeys(value for point in ordered for value in point.get(field, [])))
    merged["source_refs"] = [
        dict(ref) for ref in {
            (ref["material_id"], int(ref["page_no"])): ref
            for point in ordered for ref in point.get("source_refs", [])
        }.values()
    ]
    merged["prerequisite_ids"] = []
    return merged


def _would_cycle(edges: dict[str, set[str]], before: str, after: str) -> bool:
    pending = [after]
    visited = set()
    while pending:
        current = pending.pop()
        if current == before:
            return True
        if current not in visited:
            visited.add(current)
            pending.extend(edges.get(current, ()))
    return False


def _finalize_reduction(
    *,
    course_id: str,
    units: list[dict],
    candidates: list[dict],
    existing_points: list[dict],
    reduced: dict,
) -> dict:
    by_key = {f"c{index}": deepcopy(point) for index, point in enumerate(candidates)}
    key_to_point: dict[str, dict] = {}
    points = []
    existing = {(point["unit_id"], point["norm_name"]): point for point in existing_points}
    unit_order = {unit["id"]: int(unit.get("ord", index)) for index, unit in enumerate(units)}
    groups = _merge_same_names(by_key, reduced["groups"])
    for members in groups:
        merged = _merge_point([by_key[key] for key in members])
        old = existing.get((merged["unit_id"], merged["norm_name"]))
        merged["id"] = old["id"] if old else _stable_id(
            "kp", course_id, merged["unit_id"], merged["norm_name"],
        )
        if old and old.get("locked"):
            for field in old.get("locked", []):
                if field in old:
                    merged[field] = deepcopy(old[field])
            merged["locked"] = list(old["locked"])
        points.append(merged)
        for key in members:
            key_to_point[key] = merged

    by_norm = defaultdict(list)
    for point in points:
        by_norm[point["norm_name"]].append(point)
    proposed = []
    for before_key, after_key in reduced["edges"]:
        before, after = key_to_point[before_key], key_to_point[after_key]
        proposed.append((before, after))
    for point in points:
        for name in point.pop("prerequisite_names", []):
            matches = by_norm.get(normalize_name(name), [])
            if len(matches) == 1:
                proposed.append((matches[0], point))
    for external in reduced["external"]:
        dependents = [key_to_point[key] for key in external["used_by"]]
        first = min(dependents, key=lambda point: (unit_order.get(point["unit_id"], 0), point["ord"]))
        norm = normalize_name(external["name"])
        assumed = {
            "id": _stable_id("kp", course_id, "assumed", norm),
            "unit_id": first["unit_id"],
            "name": external["name"],
            "norm_name": norm,
            "kind": "concept",
            "summary": "",
            "must_know": [],
            "formula": None,
            "pitfalls": [],
            "question_types": [],
            "importance": "important",
            "difficulty": 2,
            "assumed": True,
            "ord": -1,
            "source_refs": [],
            "prerequisite_ids": [],
        }
        points.append(assumed)
        proposed.extend((assumed, dependent) for dependent in dependents)

    graph: dict[str, set[str]] = defaultdict(set)
    for before, after in sorted(
        proposed,
        key=lambda pair: (
            unit_order.get(pair[1]["unit_id"], 0), pair[1]["ord"],
            unit_order.get(pair[0]["unit_id"], 0), pair[0]["ord"],
        ),
    ):
        if before["id"] == after["id"]:
            continue
        before_pos = (unit_order.get(before["unit_id"], 0), before["ord"])
        after_pos = (unit_order.get(after["unit_id"], 0), after["ord"])
        if not before.get("assumed") and before_pos > after_pos:
            continue
        if not _would_cycle(graph, before["id"], after["id"]):
            graph[before["id"]].add(after["id"])
            after["prerequisite_ids"].append(before["id"])
    for point in points:
        point["prerequisite_ids"] = sorted(set(point["prerequisite_ids"]))
    return {"units": deepcopy(units), "knowledge_points": points, "warnings": []}


def _merge_same_names(by_key: dict[str, dict], groups: list[list[str]]) -> list[list[str]]:
    merged: dict[int, list[str]] = {}
    known: dict[tuple[str, str], int] = {}
    for index, group in enumerate(groups):
        identities = [
            (by_key[key]["unit_id"], by_key[key]["norm_name"]) for key in group
        ]
        previous = {known[identity] for identity in identities if identity in known}
        combined = list(group)
        for matched in sorted(previous):
            combined.extend(merged.pop(matched))
        merged[index] = combined
        for key in combined:
            point = by_key[key]
            known[(point["unit_id"], point["norm_name"])] = index
    return list(merged.values())


async def reduce_knowledge_points(
    gateway: LLMGateway,
    *,
    course_id: str,
    units: list[dict],
    candidates: list[dict],
    existing_points: list[dict] | None = None,
    use_embeddings: bool = False,
) -> dict:
    if not candidates:
        return {"units": deepcopy(units), "knowledge_points": [], "warnings": []}
    keyed = [{"key": f"c{index}", **point} for index, point in enumerate(candidates)]
    variables = {
        "course_context": _json_block("course", {"id": course_id, "units": units}),
        "knowledge_candidates": _json_block("candidates", keyed),
    }
    reduced = await gateway.complete_tagged(
        "analysis",
        "analysis/kp_reduce",
        variables,
        parse=lambda raw: _parse_reduce(raw, {point["key"] for point in keyed}),
        cache=True,
        max_tokens=6144,
    )
    if use_embeddings and len(candidates) > 1:
        vectors = await gateway.embed([
            f"{point['name']}\n{point['summary']}" for point in candidates
        ], cache=True)
        vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
        component = {key: group for group in reduced["groups"] for key in group}
        for index, vector in enumerate(vectors):
            left = f"c{index}"
            nearby = np.flatnonzero(vectors[index + 1:] @ vector >= 0.90)
            for offset in nearby:
                right = f"c{index + 1 + offset}"
                if component[left] is component[right]:
                    continue
                merged = component[left] + component[right]
                for key in merged:
                    component[key] = merged
        reduced["groups"] = list({tuple(group): group for group in component.values()}.values())
    return _finalize_reduction(
        course_id=course_id,
        units=units,
        candidates=candidates,
        existing_points=existing_points or [],
        reduced=reduced,
    )


def _parse_exam(raw: str, *, course_id: str, material: dict, pages: list[dict]) -> dict:
    paper_nodes = _root_nodes(raw, "paper")
    if len(paper_nodes) != 1:
        raise ValueError("Expected exactly one paper.")
    paper_node = paper_nodes[0]
    material_id = str(material["id"])
    paper_name = _text(paper_node, "name")
    year_text = _text(paper_node, "year", required=False)
    score_text = _text(paper_node, "full_score", required=False)
    year = int(year_text) if year_text else material.get("year")
    if year is not None and not 1 <= int(year) <= 9999:
        raise ValueError("Exam year is outside the supported range.")
    paper = {
        "id": _stable_id("paper", course_id, material_id, paper_name, year_text),
        "material_id": material_id,
        "name": paper_name,
        "year": int(year) if year is not None else None,
        "full_score": _optional_positive_number(score_text, "full_score"),
        "reserved_for_mock": False,
    }
    valid_pages = {int(page["page_no"]) for page in pages}
    items = []
    by_no: dict[str, str] = {}
    for order, node in enumerate(_root_nodes(raw, "item")):
        number = _text(node, "no")
        if number in by_no:
            raise ValueError("Exam item numbers must be unique.")
        item_type = _text(node, "type")
        if item_type not in _ITEM_TYPES:
            raise ValueError("Exam item type is invalid.")
        stem = _text(node, "stem")
        options = {}
        for option in node.many("option"):
            key, value = _text(option, "key"), _text(option, "text")
            if key in options:
                raise ValueError("Exam option keys must be unique.")
            options[key] = value
        if item_type in {"choice", "multi"} and len(options) < 2:
            raise ValueError("Choice items require at least two options.")
        page_numbers = _parse_page_numbers(_text(node, "pages"), valid_pages)
        if not page_numbers:
            raise ValueError("An exam item must cite an input page.")
        item_id = _stable_id("item", course_id, material_id, number, normalize_name(stem))
        parent_no = _text(node, "parent_no", required=False)
        item = {
            "id": item_id,
            "material_id": material_id,
            "paper_id": paper["id"],
            "parent_item_id": by_no.get(parent_no) if parent_no else None,
            "no": number,
            "type": item_type,
            "stem": stem,
            "options": options,
            "answer": _text(node, "answer", required=False) or None,
            "solution": _text(node, "solution", required=False) or None,
            "score": _optional_positive_number(_text(node, "score", required=False), "score"),
            "difficulty": int(_text(node, "difficulty", required=False) or "2"),
            "answer_status": "unverified",
            "page_refs": [
                {"material_id": material_id, "page_no": page_no} for page_no in page_numbers
            ],
            "kp_ids": [],
            "ord": order,
        }
        if item["difficulty"] not in {1, 2, 3}:
            raise ValueError("Exam item difficulty is invalid.")
        items.append(item)
        by_no[number] = item_id
    if not items:
        raise ValueError("Expected at least one exam item.")
    return {"paper": paper, "items": items}


async def segment_exam(
    gateway: LLMGateway,
    *,
    course_id: str,
    material: dict,
    pages: list[dict],
) -> dict:
    page_payload = [
        {"page_no": int(page["page_no"]), "markdown": str(page.get("markdown", ""))}
        for page in pages
    ]
    return await gateway.complete_tagged(
        "analysis",
        "analysis/exam_segment",
        {
            "course_context": _json_block("course", {"id": course_id, "material": material}),
            "page_content": _json_block("pages", page_payload),
        },
        parse=lambda raw: _parse_exam(
            raw, course_id=course_id, material=material, pages=page_payload,
        ),
        cache=True,
        max_tokens=8192,
    )


def _parse_item_maps(raw: str, item_keys: set[str], kp_keys: set[str]) -> dict[str, list[str]]:
    result = {key: [] for key in item_keys}
    for node in _root_nodes(raw, "map"):
        item_key = _text(node, "item")
        kp_values = [child.text.strip() for child in node.many("kp")]
        if item_key not in item_keys or any(key not in kp_keys for key in kp_values):
            raise ValueError("Item mapping refers to an unknown key.")
        if len(kp_values) > 3:
            raise ValueError("An item can map to at most three knowledge points.")
        result[item_key] = list(dict.fromkeys(kp_values))
    return result


async def map_exam_items(
    gateway: LLMGateway,
    *,
    course_id: str,
    items: list[dict],
    knowledge_points: list[dict],
) -> dict:
    if not items:
        return {"items": []}
    if not knowledge_points:
        return {"items": [{**item, "kp_ids": []} for item in items]}
    kp_payload = [
        {"key": f"k{index}", "name": point["name"], "summary": point.get("summary", "")}
        for index, point in enumerate(knowledge_points)
    ]
    point_terms = {
        point["key"]: (set(extract_terms(point["name"])), set(extract_terms(point["summary"])))
        for point in kp_payload
    }
    item_payload = []
    for index, item in enumerate(items):
        terms = set(extract_terms(item["stem"]))
        ranked = sorted(
            point_terms,
            key=lambda key: 2 * len(terms & point_terms[key][0]) + len(terms & point_terms[key][1]),
            reverse=True,
        )
        item_payload.append({
            "key": f"i{index}", "stem": item["stem"], "type": item["type"],
            "candidate_keys": ranked[:8],
        })
    mapping = await gateway.complete_tagged(
        "analysis",
        "analysis/item_map",
        {
            "course_context": _json_block("course", {"id": course_id}),
            "exam_items": _json_block("items", item_payload),
            "knowledge_candidates": _json_block("knowledge_points", kp_payload),
        },
        parse=lambda raw: _parse_item_maps(
            raw, {item["key"] for item in item_payload}, {point["key"] for point in kp_payload},
        ),
        cache=True,
        max_tokens=4096,
    )
    kp_ids = {point["key"]: knowledge_points[index]["id"] for index, point in enumerate(kp_payload)}
    mapped = deepcopy(items)
    for index, item in enumerate(mapped):
        candidates = set(item_payload[index]["candidate_keys"])
        item["kp_ids"] = [kp_ids[key] for key in mapping[f"i{index}"] if key in candidates]
    return {"items": mapped}


def _parse_generated_items(raw: str, *, course_id: str, kp_ids: set[str]) -> dict:
    items = []
    for order, node in enumerate(_root_nodes(raw, "item")):
        kp_id = _text(node, "kp")
        item_type = _text(node, "type")
        if kp_id not in kp_ids or item_type not in {"choice", "multi", "numeric"}:
            raise ValueError("Diagnostic item has an invalid target or type.")
        options = {
            _text(option, "key"): _text(option, "text") for option in node.many("option")
        }
        if item_type in {"choice", "multi"} and len(options) < 2:
            raise ValueError("Diagnostic choice item needs options.")
        stem = _text(node, "stem")
        items.append({
            "id": _stable_id("diagnostic-candidate", course_id, kp_id, normalize_name(stem)),
            "no": str(order + 1),
            "type": item_type,
            "stem": stem,
            "options": options,
            "answer": _text(node, "answer"),
            "solution": _text(node, "solution"),
            "score": None,
            "difficulty": int(_text(node, "difficulty") or "2"),
            "answer_status": "unverified",
            "page_refs": [],
            "kp_ids": [kp_id],
            "purpose": "diagnostic",
            "origin": "generated",
        })
    return {"items": items}


async def generate_diagnostic_items(
    gateway: LLMGateway,
    *,
    course_id: str,
    knowledge_points: list[dict],
    existing_items: list[dict],
    count_per_kp: int = 1,
) -> dict:
    if count_per_kp not in {1, 2}:
        raise ValueError("count_per_kp must be one or two.")
    targets = knowledge_points[:30]
    if not targets:
        return {"items": []}
    return await gateway.complete_tagged(
        "analysis",
        "analysis/diagnostic_generate",
        {
            "course_context": _json_block("course", {"id": course_id}),
            "knowledge_candidates": _json_block("knowledge_points", targets),
            "existing_items": _json_block("existing_items", existing_items),
            "generation_count": str(count_per_kp),
        },
        parse=lambda raw: _parse_generated_items(
            raw, course_id=course_id, kp_ids={point["id"] for point in targets},
        ),
        cache=True,
        max_tokens=8192,
    )


def _parse_brief(raw: str) -> dict:
    nodes = _root_nodes(raw, "brief")
    if len(nodes) != 1:
        raise ValueError("Expected one course brief.")
    node = nodes[0]
    summary = _text(node, "summary")
    if len(summary) > 150:
        raise ValueError("Course summary must be at most 150 characters.")
    return {
        "summary": summary,
        "top_points": [child.text.strip() for child in node.many("top_point") if child.text.strip()][:10],
        "defer_points": [child.text.strip() for child in node.many("defer_point") if child.text.strip()],
    }


async def generate_course_brief(
    gateway: LLMGateway,
    *,
    course_id: str,
    course_name: str,
    page_count: int,
    section_count: int,
    knowledge_points: list[dict],
    exam_items: list[dict],
    estimated_hours: float,
) -> dict:
    generated = await gateway.complete_tagged(
        "analysis",
        "analysis/course_brief",
        {
            "course_context": _json_block("course", {"id": course_id, "name": course_name}),
            "knowledge_candidates": _json_block("knowledge_points", knowledge_points),
            "exam_items": _json_block("exam_items", exam_items),
        },
        parse=_parse_brief,
        cache=True,
        max_tokens=2048,
    )
    return {
        "page_count": page_count,
        "section_count": section_count,
        "knowledge_point_count": len(knowledge_points),
        "item_count": len(exam_items),
        "estimated_hours": estimated_hours,
        **generated,
    }
