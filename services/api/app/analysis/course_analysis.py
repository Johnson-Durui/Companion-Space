from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from app.analysis.exam_stats import exam_statistics
from app.analysis.item_verifier import ItemVerifier
from app.analysis.model_analysis import (
    extract_knowledge_points,
    generate_course_brief,
    generate_diagnostic_items,
    map_exam_items,
    normalize_name,
    reduce_knowledge_points,
    segment_exam,
)
from app.analysis.results import CourseResults
from app.services.jobs import Job, JobFailure, JobProgress, ReportProgress

if TYPE_CHECKING:
    from app.analysis.pipeline import AnalysisPipeline

_SOURCE_ROLES = {"textbook", "slides", "notes"}
_EXAM_ROLES = {"exam", "exercise"}
_OBJECTIVE = {"choice", "multi", "numeric"}
_BANK_TYPES = {"blank": "short", "proof": "steps", "essay": "explain"}


def _windows(pages: list[dict], capacity: int = 6000):
    current = []
    length = 0
    for page in pages:
        text = page["markdown"]
        offset = 0
        while offset < len(text):
            budget = capacity - length
            stop = min(len(text), offset + budget)
            if stop < len(text):
                split = text.rfind("\n\n", offset + budget // 2, stop)
                if split != -1:
                    stop = split + 2
            piece = text[offset:stop]
            current.append({"page_no": page["page_no"], "markdown": piece})
            length += len(piece)
            offset = stop
            if length >= capacity or offset < len(text):
                yield current
                current, length = [], 0
    if current:
        yield current


def _material_context(material: dict) -> dict:
    return {key: material.get(key) for key in ("id", "title", "role", "year", "exam_name", "has_answers")}


def reserve_latest_paper(papers: list[dict]) -> set[str]:
    eligible = [p for p in papers if p["year"] is not None and p.get("complete", True)]
    latest = max(eligible, key=lambda p: (p["year"], p["id"])) if len(eligible) >= 3 else None
    for paper in papers:
        paper["reserved_for_mock"] = paper is latest
    return {latest["id"]} if latest else set()


def _bank_entry(item: dict, verification: dict, *, purpose: str, reserved: bool) -> dict:
    source = "exam" if item.get("paper_id") else "textbook" if item.get("material_id") else "generated"
    return {
        "id": item["id"],
        "kp_id": item["kp_ids"][0],
        "origin": source,
        "exam_item_id": item["id"] if item.get("material_id") else None,
        "purpose": purpose,
        "type": _BANK_TYPES.get(item["type"], item["type"]),
        "difficulty": item.get("difficulty"),
        "item": {
            "stem": item["stem"], "options": item["options"],
            "answer": item.get("answer") or verification["solved_answer"],
            "solution": item.get("solution"),
            "rubric": verification.get("rewritten_rubric") or verification.get("rubric") or item.get("rubric"),
        },
        "verify_status": verification["status"],
        "reserved": reserved,
    }


async def analyze_course(
    pipeline: AnalysisPipeline, job: Job, report: ReportProgress, materials: list[dict],
) -> None:
    space_id = job.space_id
    assert space_id is not None
    data, gateway = pipeline.data, pipeline.gateway
    results = CourseResults(data)
    course = await asyncio.to_thread(data.course, space_id)
    contents = {}
    structures = {}
    for material in materials:
        key = material["id"]
        pages, sections = await asyncio.gather(
            asyncio.to_thread(data.pages, space_id, key),
            asyncio.to_thread(data.sections, space_id, key),
        )
        contents[key] = [p for p in pages if p["quality"] > 0 and p["markdown"].strip()]
        structures[key] = sections
    units, candidates, papers, exam_items, bank = [], [], [], [], []

    async def checkpoint(key: str, value) -> None:
        job.payload[key] = value
        await asyncio.to_thread(pipeline.jobs.checkpoint, job)

    await report(JobProgress(stage="kp_extract", progress=0.28))
    if not any(contents.values()):
        raise JobFailure("No readable pages are available. Connect a vision model for scanned documents.")
    section_count = sum(map(len, structures.values()))
    extracts = job.payload.get("extracts", {})
    for material in materials:
        if material["role"] not in _SOURCE_ROLES:
            continue
        key = material["id"]
        sources = structures[key]
        by_id = {s["id"]: s for s in sources}
        parent_ids = {s["parent_id"] for s in sources if s["parent_id"]}
        roots = [s for s in sources if s["parent_id"] is None]
        units.extend({"id": s["id"], "title": s["title"], "ord": i} for i, s in enumerate(roots, start=len(units)))
        for section in sources:
            if section["id"] in parent_ids:
                continue
            root = section
            while root["parent_id"] in by_id:
                root = by_id[root["parent_id"]]
            pages = [p for p in contents[key] if section["page_start"] <= p["page_no"] <= section["page_end"]]
            for offset, window in enumerate(_windows(pages)):
                cache_key = f"{section['id']}:{offset}"
                if cache_key not in extracts:
                    response = await extract_knowledge_points(
                        gateway, course_id=space_id, material=_material_context(material),
                        section={**section, "unit_id": root["id"]}, pages=window,
                    )
                    extracts[cache_key] = response["knowledge_points"]
                    await checkpoint("extracts", extracts)
                candidates.extend(extracts[cache_key])
                await report(JobProgress(
                    stage="kp_extract", progress=0.32, detail=str(len(candidates)),
                ))

    await report(JobProgress(stage="kp_reduce", progress=0.40, detail=str(len(candidates))))
    reduced = job.payload.get("reduced")
    if reduced is None:
        existing = await asyncio.to_thread(results.points, space_id)
        reduced = await reduce_knowledge_points(
            gateway, course_id=space_id, units=units, candidates=candidates, existing_points=existing,
            use_embeddings="embedding" in await asyncio.to_thread(gateway.registry.get_roles),
        )
        await checkpoint("reduced", reduced)
    points = await asyncio.to_thread(results.prepare_points, space_id, reduced["knowledge_points"])
    active = [point for point in points if point["status"] == "active"]
    if not active:
        raise JobFailure("No knowledge points were found. Import a readable textbook, slides, or notes.")

    await report(JobProgress(stage="exam_extract", progress=0.49))
    segmented = job.payload.get("segmented", {})
    mapped = job.payload.get("mapped")
    for material in materials:
        if material["role"] not in _EXAM_ROLES or not contents[material["id"]]:
            continue
        key = material["id"]
        if key not in segmented:
            segmented[key] = await segment_exam(
                gateway, course_id=space_id, material=_material_context(material), pages=contents[key],
            )
            await checkpoint("segmented", segmented)
        packet = segmented[key]
        if material["role"] == "exam":
            paper = {
                **packet["paper"], "complete": not material["scanned_pages"],
                "name": material.get("exam_name") or packet["paper"]["name"],
                "year": material.get("year") or packet["paper"]["year"],
            }
            papers.append(paper)
            exam_items.extend(packet["items"])
        else:
            exam_items.extend({**item, "paper_id": None} for item in packet["items"])
    reserved = reserve_latest_paper(papers)
    if mapped is None:
        mapped = (await map_exam_items(
            gateway, course_id=space_id, items=exam_items, knowledge_points=active,
        ))["items"]
        await checkpoint("mapped", mapped)

    await report(JobProgress(stage="item_verify", progress=0.60, detail=str(len(mapped))))
    verifier = ItemVerifier(gateway)
    decisions = job.payload.get("verified", {})
    parent_ids = {item["parent_item_id"] for item in mapped if item.get("parent_item_id")}
    verified = []
    for offset, item in enumerate(mapped):
        item_id = item["id"]
        if item_id in parent_ids:
            continue
        if item_id not in decisions:
            decisions[item_id] = await verifier.verify(item)
            await checkpoint("verified", decisions)
        decision = decisions[item_id]
        status = decision["status"]
        if status == "verified":
            verified.append((item, decision))
            item["answer_status"] = "official_verified" if item.get("answer") else "solved_verified"
        elif status == "disputed" and item.get("answer"):
            item["answer_status"] = "official_disputed"
        await report(JobProgress(
            stage="item_verify", progress=0.60 + 0.19 * (offset + 1) / max(1, len(mapped)),
            detail=f"{offset + 1}/{len(mapped)}",
        ))

    await report(JobProgress(stage="exam_stats", progress=0.80))
    stats = exam_statistics(active, papers, mapped)
    priority = sorted(active, key=lambda p: (-stats[p["id"]]["weight"], p["id"]))
    priority = [{**point, "stats": stats[point["id"]]} for point in priority]
    await report(JobProgress(stage="diag_pool", progress=0.85))
    diagnostic = {point["id"]: [] for point in priority[:30] if not point.get("assumed")}
    assign = {}
    for item, decision in sorted(
        verified, key=lambda entry: (entry[0].get("difficulty") != 2, str(entry[0]["id"])),
    ):
        if item.get("paper_id") not in reserved and item["type"] in _OBJECTIVE:
            for kp in item["kp_ids"]:
                if kp in diagnostic and len(diagnostic[kp]) < 2:
                    diagnostic[kp].append(item)
                    assign[item["id"]] = kp
                    break
        if item["kp_ids"]:
            selected = assign.get(item["id"])
            bank.append(_bank_entry(
                {**item, "kp_ids": [selected] if selected else item["kp_ids"]}, decision,
                purpose="diagnostic" if selected else "practice", reserved=item.get("paper_id") in reserved,
            ))
    needed = [point for point in priority if point["id"] in diagnostic and not diagnostic[point["id"]]]
    generated = job.payload.get("diagnostic_generated")
    if generated is None:
        generated = []
        for index in range(0, len(needed), 5):
            pack = await generate_diagnostic_items(
                gateway, course_id=space_id, knowledge_points=needed[index:index + 5],
                existing_items=[item for item, _ in verified if item.get("paper_id") not in reserved],
            )
            generated.extend(pack["items"])
        await checkpoint("diagnostic_generated", generated)
    gaps = {point["id"] for point in needed}
    for item in generated:
        if not item["kp_ids"] or item["type"] not in _OBJECTIVE or item["kp_ids"][0] not in gaps:
            continue
        item_id = item["id"]
        if item_id not in decisions:
            decisions[item_id] = await verifier.verify(item)
            await checkpoint("verified", decisions)
        if decisions[item_id]["status"] == "verified":
            bank.append(_bank_entry(item, decisions[item_id], purpose="diagnostic", reserved=False))
            gaps.discard(item["kp_ids"][0])

    await report(JobProgress(stage="brief", progress=0.95))
    brief = job.payload.get("brief")
    if brief is None:
        minutes = {"concept": 10, "theorem": 12, "formula": 8, "method": 15, "skill": 15, "fact": 5}
        brief = await generate_course_brief(
            gateway, course_id=space_id, course_name=course.name,
            page_count=sum(material.get("page_count", 0) for material in materials), section_count=section_count,
            knowledge_points=priority, exam_items=mapped,
            estimated_hours=round(sum(minutes.get(p["kind"], 10) for p in active) / 60, 1),
        )
        await checkpoint("brief", brief)
    warnings = list(reduced["warnings"])
    if gaps:
        warnings.append("diagnostic_questions_missing")
    if any(material.get("scanned_pages") for material in materials):
        warnings.append("vision_model_required")
    if not papers:
        warnings.append("exam_weight_estimated")
    elif not reserved:
        warnings.append("exam_papers_needed")
    pages = sum(material.get("page_count", 0) for material in materials if material["role"] in _SOURCE_ROLES)
    if pages >= 20 and len(active) < 0.1 * pages:
        warnings.append("too_few_knowledge_points")
    if pages >= 20 and len(active) > 2 * pages:
        warnings.append("too_many_knowledge_points")
    hints = normalize_name(" ".join(
        page["markdown"] for material in materials if material["role"] == "syllabus"
        for page in contents[material["id"]]
    ))
    syllabus_kp_ids = [point["id"] for point in active if point["norm_name"] and point["norm_name"] in hints]
    await asyncio.to_thread(
        results.save_analysis, space_id, reduced["units"], points, papers, mapped, bank,
        {**brief, "warnings": warnings, "syllabus_kp_ids": syllabus_kp_ids},
    )
    # Model cache and published results are the durable records once the run finishes.
    job.payload.clear()
    await asyncio.to_thread(pipeline.jobs.checkpoint, job)
