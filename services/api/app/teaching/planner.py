from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from app.analysis.item_verifier import ItemVerifier, numeric_value
from app.analysis.retrieval import RetrievedChunk, retrieve_for_kp
from app.llm.errors import LLMOutputError
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository
from app.teaching.understanding import canonical_item_type
from app.teaching.validators import answer_leaks, build_forbidden

_OBJECTIVE_TYPES = {"choice", "multi", "numeric", "short"}
_APPROACH_KINDS = {"intuition", "example", "visual", "formal", "analogy", "contrast"}


class LessonPlanError(ValueError):
    """A safe, source-grounded lesson plan could not be prepared."""


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _parse_plan(raw: str) -> dict[str, Any]:
    roots = [node for node in parse_blocks(raw) if node.tag == "lesson_plan"]
    if len(roots) != 1 or roots[0].children:
        raise ValueError("Expected one plain lesson_plan JSON block.")
    value = json.loads(roots[0].text)
    if not isinstance(value, dict):
        raise ValueError("Lesson plan must be an object.")
    return value


def _parse_items(raw: str) -> list[dict[str, Any]]:
    roots = [node for node in parse_blocks(raw) if node.tag == "items"]
    if len(roots) != 1 or roots[0].children:
        raise ValueError("Expected one plain items JSON block.")
    value = json.loads(roots[0].text)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError("Generated items must be a list of objects.")
    return value


def _parse_check_scope(raw: str) -> dict[str, Any]:
    roots = [node for node in parse_blocks(raw) if node.tag == "check_scope"]
    if len(roots) != 1 or roots[0].children:
        raise ValueError("Expected one plain check_scope JSON block.")
    value = json.loads(roots[0].text)
    if not isinstance(value, dict):
        raise ValueError("Check scope must be an object.")
    return value


@dataclass(frozen=True, slots=True)
class _Inputs:
    row: dict[str, Any]
    points: dict[str, dict[str, Any]]
    chunks: dict[str, tuple[RetrievedChunk, ...]]
    bank: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class LessonPlanner:
    repository: SQLiteRepository
    gateway: Any

    async def prepare(self, space_id: str, plan_item_id: str) -> dict[str, Any]:
        inputs = await asyncio.to_thread(self._load_inputs, space_id, plan_item_id)
        learning_history = await asyncio.to_thread(self._learning_history, space_id, tuple(inputs.points))
        failure: Exception | None = None
        for _ in range(2):
            try:
                candidate = await self.gateway.complete_tagged(
                    "analysis",
                    "analysis/lesson_plan",
                    {
                        "course_context": _json_block("course", {
                            "title": inputs.row["title"],
                            "minutes": inputs.row["est_minutes"],
                            "knowledge_points": list(inputs.points.values()),
                            "learning_history": learning_history,
                        }),
                        "page_content": _json_block("sources", {
                            kp_id: [
                                {"material_id": chunk.material_id, "page": chunk.page_no, "content": chunk.content}
                                for chunk in inputs.chunks[kp_id]
                            ]
                            for kp_id in inputs.points
                        }),
                        "existing_items": _json_block("verified_items", list(inputs.bank.values())),
                        "lesson_feedback": _json_block("validation", str(failure)) if failure else "",
                    },
                    parse=_parse_plan,
                    cache=False,
                    max_tokens=8192,
                )
                plan, new_items = await self._validate_and_hydrate(candidate, inputs)
                generated_entries = [self._generated_entry(item) for item in new_items]
                for item in new_items:
                    item.pop("_variant_bank_id", None)
                saved = await asyncio.to_thread(
                    self.repository.save_lesson_plan,
                    space_id,
                    plan_item_id,
                    plan=plan,
                    verify_stats={
                        "bank_items": len(plan["items"]) - len(new_items),
                        "generated_items": len(new_items),
                        "verified_examples": sum(len(segment["examples"]) for segment in plan["segments"]),
                    },
                    generated_items=generated_entries,
                )
                if saved is None:
                    raise LessonPlanError("The lesson plan item no longer exists.")
                return saved
            except (KeyError, TypeError, ValueError, LLMOutputError) as error:
                failure = error
        raise LessonPlanError(f"Lesson preparation failed after one supplement attempt: {failure}")

    def _learning_history(self, space_id: str, point_ids: tuple[str, ...]) -> dict[str, Any]:
        with self.repository.connection() as conn:
            recaps = conn.execute(
                """SELECT recap_json FROM lessons WHERE space_id = ? AND status = 'done' AND recap_json IS NOT NULL
                   ORDER BY ended_at DESC, id DESC LIMIT 3""",
                (space_id,),
            ).fetchall()
            placeholders = ",".join("?" for _ in point_ids)
            gaps = conn.execute(
                f"""SELECT kp_id, text, count FROM misconceptions WHERE space_id = ?
                    AND kp_id IN ({placeholders}) AND resolved_at IS NULL
                    ORDER BY count DESC, last_seen_at DESC LIMIT 12""",
                (space_id, *point_ids),
            ).fetchall()
            approaches = conn.execute("SELECT kind, n, success FROM approach_stats ORDER BY kind").fetchall()
        return {
            "recent_recaps": [json.loads(row["recap_json"]).get("summary", "")[:360] for row in recaps],
            "unresolved_misconceptions": [dict(row) for row in gaps],
            "approach_success": [{"kind": row["kind"], "checks": row["n"], "correct": row["success"]} for row in approaches],
        }

    async def more_items(self, space_id: str, kp_id: str, n: int) -> list[dict[str, Any]]:
        if n < 1:
            return []
        point, chunks, bank = await asyncio.to_thread(self._load_kp_inputs, space_id, kp_id)
        failure: Exception | None = None
        for attempt in range(2):
            candidates = await self.gateway.complete_tagged(
                "analysis",
                "analysis/more_items",
                {
                    "course_context": _json_block("knowledge_point", point),
                    "page_content": _json_block("sources", [
                        {"material_id": chunk.material_id, "page": chunk.page_no, "content": chunk.content}
                        for chunk in chunks
                    ]),
                    "existing_items": _json_block("verified_items", bank),
                    "generation_count": str(n),
                },
                parse=_parse_items,
                cache=False,
                max_tokens=4096,
            )
            try:
                generated = await self._verify_more_items(kp_id, candidates, bank, n)
                await asyncio.to_thread(self._persist_more_items, space_id, generated)
                return generated
            except (KeyError, TypeError, ValueError) as error:
                failure = error
        raise LessonPlanError(f"Additional item generation failed after one supplement attempt: {failure}")

    def _load_kp_inputs(
        self, space_id: str, kp_id: str,
    ) -> tuple[dict[str, Any], tuple[RetrievedChunk, ...], list[dict[str, Any]]]:
        with self.repository.connection() as conn:
            point = conn.execute(
                """SELECT id, name, summary, pitfalls_json, question_types_json
                   FROM knowledge_points WHERE space_id = ? AND id = ? AND status = 'active'""",
                (space_id, kp_id),
            ).fetchone()
        if point is None:
            raise LessonPlanError("Knowledge point is unavailable.")
        chunks = retrieve_for_kp(self.repository, space_id=space_id, kp_id=kp_id, k=6)
        if not chunks or not any(chunk.source_ref for chunk in chunks):
            raise LessonPlanError("Knowledge point has no source excerpt.")
        return (
            {
                "id": point["id"],
                "name": point["name"],
                "summary": point["summary"],
                "pitfalls": json.loads(point["pitfalls_json"] or "[]"),
                "question_types": json.loads(point["question_types_json"] or "[]"),
            },
            chunks,
            self._load_bank_for_kp(space_id, kp_id, 100),
        )

    def _load_inputs(self, space_id: str, plan_item_id: str) -> _Inputs:
        row = self.repository.get_plan_item(space_id, plan_item_id)
        if row is None or row["kind"] != "lesson":
            raise LessonPlanError("Lesson plan item not found.")
        kp_ids = row.get("kp_ids") or []
        if not kp_ids:
            raise LessonPlanError("Lesson plan item has no knowledge points.")
        points: dict[str, dict[str, Any]] = {}
        chunks: dict[str, tuple[RetrievedChunk, ...]] = {}
        with self.repository.connection() as conn:
            for kp_id in kp_ids:
                point = conn.execute(
                    """SELECT id, name, summary, pitfalls_json, question_types_json
                       FROM knowledge_points
                       WHERE space_id = ? AND id = ? AND status = 'active'""",
                    (space_id, kp_id),
                ).fetchone()
                if point is None:
                    raise LessonPlanError(f"Knowledge point is unavailable: {kp_id}")
                points[kp_id] = {
                    "id": point["id"],
                    "name": point["name"],
                    "summary": point["summary"],
                    "pitfalls": json.loads(point["pitfalls_json"] or "[]"),
                    "question_types": json.loads(point["question_types_json"] or "[]"),
                }
            placeholders = ",".join("?" for _ in kp_ids)
            rows = conn.execute(
                f"""SELECT id, kp_id, origin, exam_item_id, purpose, type, difficulty,
                           variant_of, item_json
                    FROM item_bank
                    WHERE space_id = ? AND kp_id IN ({placeholders})
                      AND verify_status = 'verified' AND reserved = 0
                    ORDER BY created_at, id""",
                (space_id, *kp_ids),
            ).fetchall()
        for kp_id in kp_ids:
            chunks[kp_id] = retrieve_for_kp(
                self.repository, space_id=space_id, kp_id=kp_id, k=6,
            )
            if not chunks[kp_id] or not any(chunk.source_ref for chunk in chunks[kp_id]):
                raise LessonPlanError(f"Knowledge point has no source excerpt: {kp_id}")
        bank = {entry["bank_id"]: entry for row in rows if (entry := self._bank_item(row))}
        return _Inputs(row=row, points=points, chunks=chunks, bank=bank)

    def _load_bank_for_kp(self, space_id: str, kp_id: str, n: int) -> list[dict[str, Any]]:
        with self.repository.connection() as conn:
            rows = conn.execute(
                """SELECT id, kp_id, origin, exam_item_id, purpose, type, difficulty,
                          variant_of, item_json
                   FROM item_bank
                   WHERE space_id = ? AND kp_id = ? AND verify_status = 'verified' AND reserved = 0
                   ORDER BY created_at, id LIMIT ?""",
                (space_id, kp_id, n),
            ).fetchall()
        return [entry for row in rows if (entry := self._bank_item(row))]

    async def _verify_more_items(
        self, kp_id: str, candidates: list[dict[str, Any]],
        existing: list[dict[str, Any]], count: int,
    ) -> list[dict[str, Any]]:
        verifier = ItemVerifier(self.gateway)
        existing_ids = {item["bank_id"] for item in existing}
        accepted: list[dict[str, Any]] = []
        for candidate in candidates:
            item = dict(candidate)
            if (
                item.get("kp_id") != kp_id
                or not item.get("type")
                or not item.get("stem")
                or not item.get("answer")
                or not item.get("solution")
                or item.get("variant_of") not in {None, *existing_ids}
            ):
                continue
            if not self._canonicalize_objective(item):
                continue
            hints = item.get("fallback_hints") or {}
            if not all(isinstance(hints.get(level), str) and hints[level].strip() for level in ("1", "2")):
                continue
            result = await verifier.verify(self._verification_item(item))
            if result.get("status") != "verified":
                continue
            item["bank_id"] = str(uuid4())
            item["origin"] = {"kind": "generated"}
            item["purpose"] = "check"
            item["verify"] = result
            item["forbidden"] = build_forbidden(item)
            if any(answer_leaks(hints[level], item["forbidden"]) for level in ("1", "2")):
                continue
            accepted.append(item)
            if len(accepted) == count:
                return accepted
        raise LessonPlanError(f"Only {len(accepted)} of {count} additional items passed verification.")

    @staticmethod
    def _bank_item(row) -> dict[str, Any] | None:
        item = json.loads(row["item_json"])
        if not isinstance(item, dict):
            return None
        item["type"] = row["type"]
        options = item.get("options")
        if isinstance(options, dict):
            item["options"] = [{"key": key, "text": value} for key, value in options.items()]
        if not LessonPlanner._canonicalize_objective(item):
            return None
        return {
            **item,
            "bank_id": row["id"],
            "kp_id": row["kp_id"],
            "origin": {"kind": row["origin"], "exam_item_id": row["exam_item_id"]},
            "purpose": row["purpose"],
            "type": row["type"],
            "difficulty": row["difficulty"],
            "variant_of": row["variant_of"],
            "verify": {"status": "verified"},
        }

    async def _validate_and_hydrate(
        self, candidate: dict[str, Any], inputs: _Inputs,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        plan = json.loads(json.dumps(candidate))
        if not isinstance(plan.get("segments"), list) or not isinstance(plan.get("items"), dict):
            raise LessonPlanError("The generated lesson plan is missing segments or items.")
        if not plan.get("title") or not isinstance(plan.get("est_minutes"), int):
            raise LessonPlanError("The generated lesson plan has invalid metadata.")
        requested = set(inputs.points)
        if {objective.get("kp_id") for objective in plan.get("objectives", [])} != requested:
            raise LessonPlanError("The lesson objectives do not cover exactly the requested knowledge points.")
        if {segment.get("kp_id") for segment in plan["segments"]} != requested:
            raise LessonPlanError("Lesson segments do not cover exactly the requested knowledge points.")
        for segment in plan["segments"]:
            self._validate_approaches(segment)

        verifier = ItemVerifier(self.gateway)
        new_items: list[dict[str, Any]] = []
        hydrated: dict[str, dict[str, Any]] = {}
        rejected_ids: set[str] = set()
        for local_id, definition in plan["items"].items():
            if not isinstance(local_id, str) or not isinstance(definition, dict):
                raise LessonPlanError("Every lesson item must have an identifier and object definition.")
            bank_id = definition.get("bank_id")
            if bank_id:
                source = inputs.bank.get(bank_id)
                if source is None:
                    raise LessonPlanError(f"Lesson references an unavailable item: {bank_id}")
                item = {
                    **source,
                    **{
                        key: definition[key]
                        for key in ("keypoints", "stem_spoken", "fallback_hints", "distractors")
                        if key in definition
                    },
                }
            else:
                item = dict(definition)
                kp_id = item.get("kp_id")
                if kp_id not in requested:
                    raise LessonPlanError(f"Generated item {local_id} has an invalid knowledge point.")
                if not item.get("type") or not item.get("stem") or not item.get("answer") or not item.get("solution"):
                    raise LessonPlanError(f"Generated item {local_id} is incomplete.")
                if not self._canonicalize_objective(item):
                    raise LessonPlanError(f"Generated item {local_id} cannot be graded deterministically.")
                try:
                    result = await verifier.verify(self._verification_item(item))
                except LLMOutputError:
                    rejected_ids.add(local_id)
                    continue
                if result.get("status") != "verified":
                    rejected_ids.add(local_id)
                    continue
                item["bank_id"] = str(uuid4())
                item["origin"] = {"kind": "generated"}
                item["_local_id"] = local_id
                item["verify"] = result
                new_items.append(item)
            item["forbidden"] = build_forbidden(item)
            hints = item.get("fallback_hints") or {}
            if not all(isinstance(hints.get(level), str) and hints[level].strip() for level in ("1", "2")):
                raise LessonPlanError(f"Item {local_id} needs two fallback hints.")
            if any(answer_leaks(str(hints.get(level, "")), item["forbidden"]) for level in ("1", "2")):
                raise LessonPlanError(f"An answer leaks through fallback hints for {local_id}.")
            hydrated[local_id] = item
        if rejected_ids:
            while True:
                dependent_ids = {local_id for local_id, item in hydrated.items() if item.get("variant_of") in rejected_ids}
                if dependent_ids <= rejected_ids:
                    break
                rejected_ids.update(dependent_ids)
            for local_id in rejected_ids:
                discarded = hydrated.pop(local_id, None)
                if discarded in new_items:
                    new_items.remove(discarded)
            for segment in plan["segments"]:
                if isinstance(segment.get("checks"), list):
                    segment["checks"] = [ref for ref in segment["checks"] if ref not in rejected_ids]
                if isinstance(segment.get("backfills"), list):
                    segment["backfills"] = [entry for entry in segment["backfills"] if not isinstance(entry, dict) or entry.get("check") not in rejected_ids]
            if isinstance(plan.get("practice"), list):
                plan["practice"] = [ref for ref in plan["practice"] if ref not in rejected_ids]
        local_by_bank = {item["bank_id"]: local_id for local_id, item in hydrated.items()}
        for item in hydrated.values():
            if "_local_id" not in item:
                item["variant_of"] = local_by_bank.get(item.get("variant_of"))
        for item in new_items:
            variant = item.get("variant_of")
            if variant is None:
                continue
            local_id = variant if variant in hydrated else local_by_bank.get(variant)
            base = hydrated.get(local_id)
            if base is None or base is item or base["kp_id"] != item["kp_id"]:
                raise LessonPlanError("A generated variant must reference another lesson item for the same knowledge point.")
            item["variant_of"] = local_id
            item["_variant_bank_id"] = base["bank_id"]
        plan["items"] = hydrated

        try:
            await self._supplement_missing_checks(plan, hydrated, new_items, inputs, verifier)
        except LessonPlanError as error:
            if rejected_ids:
                raise LessonPlanError(f"{error} Rejected unverified items: {', '.join(sorted(rejected_ids))}.") from error
            raise

        check_refs: set[str] = set()
        for segment in plan["segments"]:
            try:
                self._validate_segment(segment, hydrated, inputs)
            except LessonPlanError as error:
                if rejected_ids:
                    raise LessonPlanError(f"{error} Rejected unverified items: {', '.join(sorted(rejected_ids))}.") from error
                raise
            check_refs.update(segment["checks"])
            verified_examples = []
            for example in segment["examples"]:
                if not isinstance(example, dict):
                    raise LessonPlanError("Every example must be a structured, solved item.")
                bank_id = example.get("bank_id")
                if bank_id:
                    source = inputs.bank.get(bank_id)
                    if source is None:
                        raise LessonPlanError(f"Example references an unavailable item: {bank_id}")
                    example = source
                else:
                    if not example.get("type") or not example.get("stem") or not example.get("answer") or not example.get("solution"):
                        raise LessonPlanError("A generated worked example is incomplete.")
                    result = await verifier.verify(self._verification_item(example))
                    if result.get("status") != "verified":
                        raise LessonPlanError("A generated worked example failed independent verification.")
                    example = {**example, "verify": result, "origin": {"kind": "generated"}}
                if not example.get("solution"):
                    raise LessonPlanError("Every worked example needs a verified solution.")
                verified_examples.append(example)
            segment["examples"] = verified_examples
            segment["sources"] = [
                {"material_id": chunk.material_id, "page_start": chunk.page_no, "page_end": chunk.page_no}
                for chunk in inputs.chunks[segment["kp_id"]]
                if chunk.source_ref
            ]
        practice = plan.get("practice", [])
        if not isinstance(practice, list) or any(ref not in hydrated for ref in practice):
            raise LessonPlanError("Practice references an unavailable item.")
        if check_refs.intersection(practice):
            raise LessonPlanError("Checks and practice must not reuse the same item.")
        backfill_refs = {
            backfill.get("check")
            for segment in plan["segments"]
            for backfill in segment.get("backfills", [])
            if isinstance(backfill, dict)
        }
        for item in new_items:
            local_id = item.pop("_local_id")
            item["purpose"] = (
                "practice" if local_id in practice
                else "backfill" if local_id in backfill_refs
                else "check"
            )
        plan.setdefault("wrap", {"summary_points": [], "cards": []})
        return plan, new_items

    async def _supplement_missing_checks(
        self,
        plan: dict[str, Any],
        items: dict[str, dict[str, Any]],
        new_items: list[dict[str, Any]],
        inputs: _Inputs,
        verifier: ItemVerifier,
    ) -> None:
        slots: list[dict[str, Any]] = []
        segments: dict[str, dict[str, Any]] = {}
        rejected_items: set[str] = set()
        scopes: dict[str, list[dict[str, Any]]] = {}
        for segment in plan["segments"]:
            checks = segment.get("checks")
            if not isinstance(checks, list) or len(checks) != len(set(checks)) or any(ref not in items for ref in checks):
                raise LessonPlanError("A segment has too few or invalid check items.")
            segments[segment["id"]] = segment
            scopes[segment["id"]] = []
            for index, keypoint in enumerate(segment["keypoints"]):
                slot = {
                    "slot": f'{segment["id"]}:{index}',
                    "segment_id": segment["id"],
                    "kp_id": segment["kp_id"],
                    "target_index": index,
                    "target": keypoint,
                    "taught": segment["keypoints"][:index + 1],
                    "later": segment["keypoints"][index + 1:],
                }
                scopes[segment["id"]].append(slot)
                covered = False
                rejected: set[str] = set()
                for local_id in checks:
                    item = items[local_id]
                    if not self._covers_keypoint(item, index):
                        continue
                    if await self._scope_accepts(slot, item):
                        covered = True
                    else:
                        rejected.add(local_id)
                if rejected:
                    rejected_items.update(rejected)
                    checks[:] = [local_id for local_id in checks if local_id not in rejected]
                if covered:
                    continue
                reusable = None
                for local_id, item in items.items():
                    if (
                        local_id not in checks
                        and local_id not in rejected_items
                        and item.get("kp_id") == segment["kp_id"]
                        and self._covers_keypoint(item, index)
                        and await self._scope_accepts(slot, item)
                    ):
                        reusable = local_id
                        break
                if reusable is not None:
                    checks.append(reusable)
                    continue
                slots.append(slot)
        if rejected_items:
            while True:
                dependents = {
                    local_id for local_id, item in items.items()
                    if item.get("variant_of") in rejected_items
                }
                if dependents <= rejected_items:
                    break
                rejected_items.update(dependents)
            for segment in plan["segments"]:
                segment["checks"] = [ref for ref in segment["checks"] if ref not in rejected_items]
            plan["practice"] = [ref for ref in plan.get("practice", []) if ref not in rejected_items]
            for segment in plan["segments"]:
                segment["backfills"] = [
                    entry for entry in segment.get("backfills", [])
                    if not isinstance(entry, dict) or entry.get("check") not in rejected_items
                ]
            for local_id in rejected_items:
                rejected = items.pop(local_id, None)
                if rejected in new_items:
                    new_items.remove(rejected)
        for identifier, segment in segments.items():
            selectable = [items[ref] for ref in segment["checks"]]
            if not any(item.get("type") in _OBJECTIVE_TYPES for item in selectable) and not any(
                slot["segment_id"] == identifier for slot in slots
            ):
                slots.append(scopes[identifier][0])
        if not slots:
            return

        candidates = await self.gateway.complete_tagged(
            "analysis",
            "analysis/lesson_checks",
            {
                "check_slots": _json_block("check_slots", slots),
                "page_content": _json_block("sources", {
                    kp_id: [
                        {"material_id": chunk.material_id, "page": chunk.page_no, "content": chunk.content}
                        for chunk in inputs.chunks[kp_id]
                    ]
                    for kp_id in {slot["kp_id"] for slot in slots}
                }),
                "existing_items": _json_block("lesson_items", [
                    {
                        "local_id": local_id,
                        "kp_id": item.get("kp_id"),
                        "type": item.get("type"),
                        "stem": item.get("stem"),
                        "keypoints": item.get("keypoints"),
                    }
                    for local_id, item in items.items()
                ]),
            },
            parse=_parse_items,
            cache=False,
            max_tokens=4096,
        )
        by_slot = {
            candidate.get("slot"): candidate
            for candidate in candidates
            if isinstance(candidate.get("slot"), str)
        }
        for slot in slots:
            candidate = by_slot.get(slot["slot"])
            if candidate is None:
                raise LessonPlanError(f'Missing generated check for {slot["slot"]}.')
            item = dict(candidate)
            index = slot["target_index"]
            if item.get("kp_id") != slot["kp_id"] or not self._covers_keypoint(item, index):
                raise LessonPlanError(f'Generated check for {slot["slot"]} exceeds taught content.')
            if item.get("type") not in _OBJECTIVE_TYPES or not item.get("stem") or not item.get("answer") or not item.get("solution"):
                raise LessonPlanError(f'Generated check for {slot["slot"]} is incomplete.')
            if not self._canonicalize_objective(item):
                raise LessonPlanError(f'Generated check for {slot["slot"]} cannot be graded deterministically.')
            hints = item.get("fallback_hints") or {}
            if not all(isinstance(hints.get(level), str) and hints[level].strip() for level in ("1", "2")):
                raise LessonPlanError(f'Generated check for {slot["slot"]} needs two fallback hints.')
            if not await self._scope_accepts(slot, item):
                raise LessonPlanError(f'Generated check for {slot["slot"]} failed the dependency check.')
            result = await verifier.verify(self._verification_item(item))
            if result.get("status") != "verified":
                raise LessonPlanError(f'Generated check for {slot["slot"]} failed independent verification.')
            item["bank_id"] = str(uuid4())
            item["origin"] = {"kind": "generated"}
            item["verify"] = result
            item["forbidden"] = build_forbidden(item)
            if any(answer_leaks(hints[level], item["forbidden"]) for level in ("1", "2")):
                raise LessonPlanError(f'An answer leaks through fallback hints for {slot["slot"]}.')
            local_id = f'check-{slot["segment_id"]}-{index}'
            suffix = 2
            while local_id in items:
                local_id = f'check-{slot["segment_id"]}-{index}-{suffix}'
                suffix += 1
            item["_local_id"] = local_id
            item.pop("slot", None)
            items[local_id] = item
            new_items.append(item)
            segments[slot["segment_id"]]["checks"].append(local_id)

    async def _scope_accepts(self, slot: dict[str, Any], item: dict[str, Any]) -> bool:
        scope = await self.gateway.complete_tagged(
            "checker",
            "analysis/lesson_check_scope",
            {
                "check_slot": _json_block("check_slot", slot),
                "item_context": _json_block("question", {
                    key: item.get(key)
                    for key in ("type", "stem", "options", "rubric")
                    if item.get(key) is not None
                }),
            },
            parse=_parse_check_scope,
            cache=False,
            max_tokens=256,
        )
        return scope == {"requires_target": True, "uses_later": False}

    @classmethod
    def _has_progressive_check(cls, items: list[dict[str, Any]], index: int) -> bool:
        return any(cls._covers_keypoint(item, index) for item in items)

    @staticmethod
    def _covers_keypoint(item: dict[str, Any], index: int) -> bool:
        dependencies = item.get("keypoints")
        return (
            isinstance(dependencies, list)
            and bool(dependencies)
            and all(isinstance(value, int) and not isinstance(value, bool) for value in dependencies)
            and index in dependencies
            and min(dependencies) >= 0
            and max(dependencies) <= index
        )

    @staticmethod
    def _validate_approaches(segment: dict[str, Any]) -> None:
        keypoints = segment.get("keypoints")
        if not isinstance(keypoints, list) or not 2 <= len(keypoints) <= 3 or not all(keypoints):
            raise LessonPlanError("Each segment needs two or three non-empty keypoints.")
        approaches = segment.get("approaches")
        if not isinstance(approaches, list):
            raise LessonPlanError("Each segment needs teaching approaches.")
        for index in range(len(keypoints)):
            kinds = {
                approach.get("kind")
                for approach in approaches
                if isinstance(approach, dict)
                and approach.get("keypoint") in ("all", index)
                and isinstance(approach.get("outline"), str) and approach["outline"].strip()
            }
            if len(kinds.intersection(_APPROACH_KINDS)) < 4:
                raise LessonPlanError("Each keypoint needs at least four distinct teaching approaches.")

    @staticmethod
    def _validate_segment(
        segment: dict[str, Any], items: dict[str, dict[str, Any]], inputs: _Inputs,
    ) -> None:
        keypoints = segment["keypoints"]
        checks = segment.get("checks")
        if (
            not isinstance(checks, list)
            or len(checks) < len(keypoints) + 1
            or len(checks) != len(set(checks))
            or any(ref not in items for ref in checks)
        ):
            raise LessonPlanError("A segment has too few or invalid check items.")
        selected = [items[ref] for ref in checks]
        for index in range(len(keypoints)):
            if not LessonPlanner._has_progressive_check(selected, index):
                raise LessonPlanError("Every keypoint needs a check that depends on content taught so far.")
        if sum(item.get("variant_of") in items for item in selected) < 2:
            raise LessonPlanError("Each segment needs at least two isomorphic variants.")
        if not any(item.get("type") in _OBJECTIVE_TYPES for item in selected):
            raise LessonPlanError("Each segment needs at least one objective check.")
        question_types = inputs.points[segment["kp_id"]]["question_types"]
        if any(kind in {"short", "explain", "steps", "essay"} for kind in question_types):
            if not any(item.get("type") in {"explain", "steps"} and item.get("rubric") for item in selected):
                raise LessonPlanError("This knowledge point needs at least one rubric-scored check.")
        if not isinstance(segment.get("examples"), list) or len(segment["examples"]) < 2:
            raise LessonPlanError("Each segment needs at least two worked examples.")

    @staticmethod
    def _generated_entry(item: dict[str, Any]) -> dict[str, Any]:
        stored = {
            key: value
            for key, value in item.items()
            if key not in {
                "bank_id", "kp_id", "origin", "purpose", "forbidden", "_local_id", "_variant_bank_id",
            }
        }
        return {
            "id": item["bank_id"],
            "kp_id": item["kp_id"],
            "purpose": item["purpose"],
            "type": item["type"],
            "difficulty": item.get("difficulty"),
            "variant_of": item.get("_variant_bank_id", item.get("variant_of")),
            "item": stored,
        }

    def _persist_more_items(self, space_id: str, items: list[dict[str, Any]]) -> None:
        now = utcnow().isoformat()
        with self.repository.connection() as conn:
            conn.executemany(
                """INSERT INTO item_bank(
                       id, space_id, kp_id, origin, purpose, type, difficulty, variant_of,
                       item_json, verify_status, reserved, created_at
                   ) VALUES (?, ?, ?, 'generated', 'check', ?, ?, ?, ?, 'verified', 0, ?)""",
                [
                    (
                        item["bank_id"],
                        space_id,
                        item["kp_id"],
                        item["type"],
                        item.get("difficulty"),
                        item.get("variant_of"),
                        json.dumps(
                            self._generated_entry(item)["item"],
                            ensure_ascii=False,
                            allow_nan=False,
                        ),
                        now,
                    )
                    for item in items
                ],
            )

    @staticmethod
    def _verification_item(item: dict[str, Any]) -> dict[str, Any]:
        candidate = dict(item)
        if isinstance(candidate.get("options"), list):
            candidate["options"] = {
                option["key"]: option["text"]
                for option in candidate["options"]
                if isinstance(option, dict) and "key" in option and "text" in option
            }
        rubric = candidate.get("rubric")
        if isinstance(rubric, dict):
            candidate["rubric"] = [
                {
                    "id": point.get("id") or point.get("key"),
                    "text": point.get("text", ""),
                    "required": point.get("required", True),
                }
                for point in rubric.get("points", [])
                if isinstance(point, dict) and (point.get("id") or point.get("key"))
            ]
        return candidate

    @staticmethod
    def _canonicalize_objective(item: dict[str, Any]) -> bool:
        kind = canonical_item_type(str(item.get("type", "")))
        item["type"] = kind
        if kind not in _OBJECTIVE_TYPES:
            return kind in {"explain", "steps"}
        answer = item.get("answer")
        if kind == "numeric":
            return numeric_value(str(answer)) is not None
        if kind == "short":
            accepted = item.get("accepted") or [answer]
            return isinstance(accepted, list) and bool(accepted) and all(
                isinstance(value, str) and value.strip() for value in accepted
            )
        options = item.get("options")
        if not isinstance(options, list) or len(options) < 2:
            return False
        by_key = {
            str(option.get("key", "")).strip().casefold(): str(option.get("key", "")).strip()
            for option in options
            if isinstance(option, dict)
        }
        if len(by_key) != len(options) or "" in by_key:
            return False
        if kind == "choice" and isinstance(answer, str):
            normalized = answer.strip().casefold()
            if normalized in by_key:
                item["answer"] = by_key[normalized]
                return True
            matches = [
                option["key"]
                for option in options
                if isinstance(option.get("text"), str)
                and option["text"].strip().casefold() == normalized
            ]
            if len(matches) == 1:
                item["answer"] = matches[0]
                return True
            return False
        values = answer if isinstance(answer, list) else str(answer).translate(
            str.maketrans({"，": ",", "、": ","})
        ).split(",")
        selected = [by_key.get(str(value).strip().casefold()) for value in values]
        if not selected or any(value is None for value in selected) or len(set(selected)) != len(selected):
            return False
        item["answer"] = ",".join(sorted(selected))
        return True
