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
    names = []
    seen: set[str] = set()
    for node in _root_nodes(raw, "merge"):
        members = [child.text.strip() for child in node.many("member")]
        if not members or any(member not in candidate_keys or member in seen for member in members):
            raise ValueError("Merge groups must contain unique candidate keys.")
        seen.update(members)
        groups.append(members)
        names.append((members, _text(node, "name", required=False)))
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
    return {"groups": groups, "names": names, "edges": edges, "external": external}


def _merge_point(group: list[dict], canonical_name: str = "") -> dict:
    ordered = sorted(group, key=lambda point: (point.get("ord", 0), point["name"]))
    richest = max(ordered, key=lambda point: len(point.get("summary", "")))
    merged = deepcopy(richest)
    merged["name"] = canonical_name or ordered[0]["name"]
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
    group_names: dict[frozenset[str], str] | None = None,
) -> dict:
    by_key = {f"c{index}": deepcopy(point) for index, point in enumerate(candidates)}
    key_to_point: dict[str, dict] = {}
    points = []
    existing = {(point["unit_id"], point["norm_name"]): point for point in existing_points}
    unit_order = {unit["id"]: int(unit.get("ord", index)) for index, unit in enumerate(units)}
    groups = _merge_same_names(by_key, reduced["groups"])
    for members in groups:
        merged = _merge_point(
            [by_key[key] for key in members],
            (group_names or {}).get(frozenset(members), ""),
        )
        old = existing.get((merged["unit_id"], merged["norm_name"]))
        if old is None:
            old = next((
                existing[(by_key[key]["unit_id"], by_key[key]["norm_name"])]
                for key in members
                if (by_key[key]["unit_id"], by_key[key]["norm_name"]) in existing
            ), None)
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
    mentions = defaultdict(dict)
    for external in reduced["external"]:
        norm = normalize_name(external["name"])
        mentions[norm].update((key, external["name"]) for key in external["used_by"])
    for norm, references in mentions.items():
        dependents = list({key_to_point[key]["id"]: key_to_point[key] for key in references}.values())
        if len(dependents) < 2 or norm in by_norm:
            continue
        first = min(dependents, key=lambda point: (unit_order.get(point["unit_id"], 0), point["ord"]))
        assumed = {
            "id": _stable_id("kp", course_id, "assumed", norm),
            "unit_id": first["unit_id"],
            "name": next(iter(references.values())),
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


def _find(parent: dict[str, str], key: str) -> str:
    while parent[key] != key:
        parent[key] = parent[parent[key]]
        key = parent[key]
    return key


def _union(parent: dict[str, str], rank: dict[str, int], left: str, right: str) -> None:
    left_root, right_root = _find(parent, left), _find(parent, right)
    if left_root == right_root:
        return
    if rank[left_root] < rank[right_root]:
        left_root, right_root = right_root, left_root
    parent[right_root] = left_root
    if rank[left_root] == rank[right_root]:
        rank[left_root] += 1


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
    keyed = {
        f"c{index}": {
            "key": f"c{index}", "unit_id": point["unit_id"], "name": point["name"],
            "summary": point["summary"][:420], "prerequisite_names": point.get("prerequisite_names", [])[:6],
        }
        for index, point in enumerate(candidates)
    }
    keys = list(keyed)
    parent = {key: key for key in keys}
    rank = {key: 0 for key in keys}
    reduced = {"groups": [], "names": [], "edges": [], "external": []}

    async def reconcile(batch: list[str]) -> None:
        unit_ids = {keyed[key]["unit_id"] for key in batch}
        result = await gateway.complete_tagged(
            "analysis", "analysis/kp_reduce",
            {
                "course_context": _json_block("course", {"id": course_id, "units": [u for u in units if u["id"] in unit_ids]}),
                "knowledge_candidates": _json_block("candidates", [keyed[key] for key in batch]),
            },
            parse=lambda raw: _parse_reduce(raw, set(batch)), cache=True, max_tokens=6144,
        )
        for group in result["groups"]:
            for key in group[1:]:
                _union(parent, rank, group[0], key)
        reduced["names"].extend(result["names"])
        reduced["edges"].extend(result["edges"])
        reduced["external"].extend(result["external"])

    by_unit = defaultdict(list)
    for key in keys:
        by_unit[keyed[key]["unit_id"]].append(key)
    batches = [keys] if len(keys) <= 64 else [
        members[offset:offset + 64] for members in by_unit.values() for offset in range(0, len(members), 64)
    ]
    for batch in batches:
        await reconcile(batch)

    neighbors = defaultdict(list)
    for key, point in keyed.items():
        neighbors[normalize_name(point["name"])].append(key)
    pairs = {
        (members[0], key) for members in neighbors.values() for key in members[1:]
        if keyed[key]["unit_id"] != keyed[members[0]]["unit_id"]
    }
    if use_embeddings and len(keys) > 1:
        vectors = await gateway.embed([f"{point['name']}\n{point['summary']}" for point in candidates], cache=True)
        vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
        for index, vector in enumerate(vectors):
            scores = vectors[index + 1:] @ vector
            for offset in np.flatnonzero(scores >= 0.90):
                _union(parent, rank, keys[index], keys[index + 1 + int(offset)])
            plausible = np.flatnonzero((scores >= 0.80) & (scores < 0.90))
            top = sorted(plausible, key=lambda offset: (-float(scores[offset]), offset))[:3]
            pairs.update((keys[index], keys[index + 1 + int(offset)]) for offset in top)

    pending = sorted((left, right) for left, right in pairs if _find(parent, left) != _find(parent, right))
    for offset in range(0, len(pending), 12):
        await reconcile(list(dict.fromkeys(key for pair in pending[offset:offset + 12] for key in pair)))

    grouped: dict[str, list[str]] = defaultdict(list)
    for key in keys:
        grouped[_find(parent, key)].append(key)
    reduced["groups"] = list(grouped.values())
    group_names = {}
    for members in reduced["groups"]:
        member_set = set(members)
        proposals = [
            (len(proposal_members), name)
            for proposal_members, name in reduced["names"]
            if name and set(proposal_members).issubset(member_set)
        ]
        if proposals:
            group_names[frozenset(members)] = max(proposals, key=lambda proposal: proposal[0])[1]
    return _finalize_reduction(
        course_id=course_id,
        units=units,
        candidates=candidates,
        existing_points=existing_points or [],
        reduced=reduced,
        group_names=group_names,
    )


def _parse_exam(raw: str, *, course_id: str, material: dict, pages: list[dict], partial: bool = False) -> dict:
    paper_nodes = _root_nodes(raw, "paper")
    if len(paper_nodes) != 1:
        raise ValueError("Expected exactly one paper.")
    paper_node = paper_nodes[0]
    material_id = str(material["id"])
    paper_name = _text(paper_node, "name", required=not partial)
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
        if partial:
            item["_parent_no"] = parent_no
        items.append(item)
        by_no[number] = item_id
    if not items and not partial:
        raise ValueError("Expected at least one exam item.")
    return {"paper": paper, "items": items}


async def _segment_exam_part(
    gateway: LLMGateway, course_id: str, material: dict, pages: list[dict], part: int | None = None,
) -> dict:
    context = {"id": course_id, "material": material}
    if part is not None:
        context["part"] = part
    return await gateway.complete_tagged(
        "analysis",
        "analysis/exam_segment",
        {
            "course_context": _json_block("course", context),
            "page_content": _json_block("pages", pages),
        },
        parse=lambda raw: _parse_exam(
            raw, course_id=course_id, material=material, pages=pages, partial=part is not None,
        ),
        cache=True,
        max_tokens=8192,
    )


def _exam_parts(pages: list[dict], *, chars: int = 9_000, overlap: int = 3_000) -> list[list[dict]]:
    material = "".join(page["markdown"] + "\n\n" for page in pages)
    ranges = []
    offset = 0
    for page in pages:
        end = offset + len(page["markdown"]) + 2
        ranges.append((page["page_no"], offset, end))
        offset = end
    return [
        [{"page_no": no, "markdown": material[max(left, start - overlap):min(right, start + chars)]}
         for no, left, right in ranges if right > start - overlap and left < start + chars]
        for start in range(0, len(material), chars)
    ]


def _exam_number(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)).casefold()


def _exam_references(raw: str, pages: set[int], questions: set[str]) -> list[dict]:
    refs = []
    for node in _root_nodes(raw, "reference"):
        no = _exam_number(_text(node, "no"))
        if no not in questions:
            raise ValueError("Answer reference has an unknown question number.")
        cited = _parse_page_numbers(_text(node, "pages"), pages)
        answer = _text(node, "answer", required=False)
        solution = _text(node, "solution", required=False)
        if not cited or not (answer or solution):
            raise ValueError("Answer reference must cite an explicit answer or solution.")
        refs.append({"no": no, "answer": answer, "solution": solution, "pages": cited})
    return refs


async def segment_exam(
    gateway: LLMGateway, *, course_id: str, material: dict, pages: list[dict],
) -> dict:
    page_payload = [{"page_no": int(p["page_no"]), "markdown": str(p.get("markdown", ""))} for p in pages]
    if sum(len(page["markdown"]) + 2 for page in page_payload) <= 9_000:
        return await _segment_exam_part(gateway, course_id, material, page_payload)

    parts = _exam_parts(page_payload)
    packets = [await _segment_exam_part(gateway, course_id, material, part, index + 1) for index, part in enumerate(parts)]
    paper = next((packet["paper"] for packet in packets if packet["paper"]["name"]), packets[0]["paper"])
    paper = {**paper, "name": paper["name"] or material.get("exam_name") or material.get("title") or "Exam"}
    items: dict[str, dict] = {}
    for packet in packets:
        for item in packet["items"]:
            key = _exam_number(item["no"])
            previous = items.get(key)
            if previous is None:
                items[key] = item
                continue
            old_pages = {ref["page_no"] for ref in previous["page_refs"]}
            new_pages = {ref["page_no"] for ref in item["page_refs"]}
            old_stem, new_stem = normalize_name(previous["stem"]), normalize_name(item["stem"])
            shared_question = old_pages & new_pages and (old_stem in new_stem or new_stem in old_stem)
            if not shared_question:
                raise ValueError("Repeated exam numbers need distinct section qualifiers.")
            if len(item["stem"]) > len(previous["stem"]):
                items[key], item = item, previous
            selected = items[key]
            for field in ("answer", "solution"):
                if selected[field] is None:
                    selected[field] = item[field]
    if not items:
        raise ValueError("Expected at least one exam item.")

    needs_reference = {no for no, item in items.items() if not item["answer"] or not item["solution"]}
    references = defaultdict(list)
    for part in parts if needs_reference and material.get("has_answers") is not False else ():
        valid_pages = {p["page_no"] for p in part}
        result = await gateway.complete_tagged(
            "analysis", "analysis/exam_reference",
            {
                "exam_items": _json_block("question_numbers", [items[no]["no"] for no in items if no in needs_reference]),
                "page_content": _json_block("pages", part),
            },
            parse=lambda raw: _exam_references(raw, valid_pages, needs_reference), cache=True, max_tokens=8192,
        )
        for ref in result:
            references[ref["no"]].append(ref)

    for index, (no, item) in enumerate(items.items()):
        parent = items.get(_exam_number(item.pop("_parent_no")))
        item.update(paper_id=paper["id"], parent_item_id=parent["id"] if parent and parent is not item else None, ord=index)
        for field in ("answer", "solution"):
            originals = {ref[field] for ref in references[no] if ref[field]}
            if not item[field] and len(originals) == 1:
                item[field] = originals.pop()
                cited = {page for ref in references[no] if ref[field] == item[field] for page in ref["pages"]}
                known = {ref["page_no"] for ref in item["page_refs"]}
                item["page_refs"].extend({"material_id": item["material_id"], "page_no": page} for page in sorted(cited - known))
    return {"paper": paper, "items": list(items.values())}


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
        item["kp_ids"] = [kp_ids[key] for key in mapping[f"i{index}"]]
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


async def check_summary_support(gateway: LLMGateway, point: dict, pages: list[dict]) -> bool:
    if not pages:
        return False

    def parse(raw: str) -> bool:
        nodes = _root_nodes(raw, "support")
        if len(nodes) != 1 or nodes[0].text.strip() not in {"supported", "unsupported"}:
            raise ValueError("Expected a source support verdict.")
        return nodes[0].text.strip() == "supported"

    return await gateway.complete_tagged(
        "analysis", "analysis/kp_faithful",
        {
            "knowledge_candidates": _json_block("point", {key: point[key] for key in ("name", "summary")}),
            "page_content": _json_block("source_pages", pages),
        },
        parse=parse, cache=True, max_tokens=1024,
    )
