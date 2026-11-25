from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

from app.analysis.item_verifier import ItemVerifier, numeric_value
from app.analysis.retrieval import retrieve_structured_pages
from app.core.errors import CodedValueError, ResourceNotFoundError
from app.learning.mastery import (
    Evidence,
    classify_mastery,
    initial_mastery_probability,
    update_mastery_probability,
)
from app.learning.memory import record_trace
from app.learning.practice import _add_wrong_card
from app.llm.errors import LLMOutputError
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.providers.errors import ProviderConfigurationError, ProviderError
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository
from app.teaching.understanding import InvalidAnswer, grade_objective
from app.teaching.validators import answer_leaks, build_forbidden

_LOG = logging.getLogger(__name__)
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_SIDE = 1600
_ALLOWED_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _now() -> datetime:
    return utcnow().astimezone(timezone.utc)


def _require_course(conn, space_id: str) -> None:
    row = conn.execute("SELECT id FROM study_spaces WHERE id = ?", (space_id,)).fetchone()
    if row is None:
        raise ResourceNotFoundError("Course not found", code="course_not_found")


def _save_solve_image(repository: SQLiteRepository, space_id: str, session_id: str, data: bytes) -> tuple[str, bytes]:
    if not data or len(data) > _MAX_IMAGE_BYTES:
        raise CodedValueError("solve_image_invalid", "Image must be non-empty and at most 8 MB.")
    try:
        with Image.open(BytesIO(data)) as check:
            check.verify()
        with Image.open(BytesIO(data)) as img:
            normalized = ImageOps.exif_transpose(img).convert("RGB")
            if max(normalized.size) > _MAX_IMAGE_SIDE:
                normalized.thumbnail((_MAX_IMAGE_SIDE, _MAX_IMAGE_SIDE))
            buf = BytesIO()
            normalized.save(buf, format="JPEG", quality=88)
            jpeg_bytes = buf.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        raise CodedValueError("solve_image_invalid", "Uploaded file is not a valid image.") from None

    rel_path = f"courses/{space_id}/solve/{session_id}.jpg"
    full_path = repository.settings.storage_root / rel_path
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_bytes(jpeg_bytes)
    return rel_path, jpeg_bytes


def resolve_solve_image_path(repository: SQLiteRepository, space_id: str, session_id: str) -> Path:
    with repository.connection() as conn:
        row = conn.execute(
            "SELECT image_path FROM solve_sessions WHERE id = ? AND space_id = ?",
            (session_id, space_id),
        ).fetchone()
    if row is None or not row["image_path"]:
        raise ResourceNotFoundError("Solve image not found", code="solve_image_not_found")
    root = repository.settings.storage_root.resolve()
    candidate = (root / str(row["image_path"])).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ResourceNotFoundError("Solve image not found", code="solve_image_not_found")
    return candidate


def _parse_blueprint(raw: str) -> dict[str, Any]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "blueprint"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain blueprint JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, dict):
        raise ValueError("Blueprint must be a JSON object.")
    steps = [str(step).strip() for step in (parsed.get("steps") or []) if str(step).strip()]
    if not steps:
        raise ValueError("Blueprint must contain at least one step.")
    raw_hints = parsed.get("hints") if isinstance(parsed.get("hints"), dict) else {}
    hints = {
        key: str(raw_hints.get(key) or "").strip()
        for key in ("1", "2")
        if str(raw_hints.get(key) or "").strip()
    }
    pitfalls = [str(item).strip() for item in (parsed.get("pitfalls") or []) if str(item).strip()][:4]
    return {
        "approach_prompt": str(parsed.get("approach_prompt") or "").strip(),
        "key_formula": str(parsed.get("key_formula") or "").strip(),
        "hints": hints,
        "steps": steps[:8],
        "pitfalls": pitfalls,
    }


def _parse_feedback(raw: str) -> dict[str, str]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "feedback"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain feedback JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, dict):
        raise ValueError("Feedback must be a JSON object.")
    verdict = str(parsed.get("verdict") or "partial").strip().casefold()
    if verdict not in {"correct", "partial", "incorrect", "discuss"}:
        verdict = "partial"
    reply = str(parsed.get("reply") or "").strip()
    if not reply:
        raise ValueError("Feedback reply must be non-empty.")
    return {"verdict": verdict, "reply": reply}


def _parse_step_detail(raw: str) -> dict[str, Any]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "detail"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain detail JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, dict):
        raise ValueError("Step detail must be a JSON object.")
    substeps = [str(item).strip() for item in (parsed.get("substeps") or []) if str(item).strip()]
    summary = str(parsed.get("summary") or "").strip()
    if not substeps and not summary:
        raise ValueError("Step detail must contain summary or substeps.")
    return {"summary": summary, "substeps": substeps[:5]}


def _parse_mimic_items(raw: str) -> list[dict[str, Any]]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "items"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain items JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, list):
        raise ValueError("Mimic items must be a JSON array.")
    normalized: list[dict[str, Any]] = []
    for entry in parsed[:3]:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("type") or "").strip().casefold()
        stem = str(entry.get("stem") or "").strip()
        answer = str(entry.get("answer") or "").strip()
        solution = str(entry.get("solution") or "").strip()
        if kind not in {"choice", "numeric"} or not stem or not answer:
            continue
        difficulty = entry.get("difficulty")
        difficulty_val = int(difficulty) if isinstance(difficulty, int) and 1 <= difficulty <= 3 else 2
        if kind == "choice":
            raw_opts = entry.get("options")
            if not isinstance(raw_opts, list) or len(raw_opts) < 2:
                continue
            options: list[dict[str, str]] = []
            seen_keys: set[str] = set()
            for opt in raw_opts[:6]:
                if not isinstance(opt, dict):
                    continue
                key = str(opt.get("key") or "").strip().upper()
                text = str(opt.get("text") or "").strip()
                if not key or not text or key in seen_keys:
                    continue
                seen_keys.add(key)
                options.append({"key": key, "text": text})
            if len(options) < 2 or answer.upper() not in seen_keys:
                continue
            normalized.append({
                "type": "choice",
                "stem": stem,
                "options": options,
                "answer": answer.upper(),
                "solution": solution or answer.upper(),
                "difficulty": difficulty_val,
            })
        else:
            if numeric_value(answer) is None:
                continue
            normalized.append({
                "type": "numeric",
                "stem": stem,
                "answer": answer,
                "solution": solution or answer,
                "difficulty": difficulty_val,
            })
    if not normalized:
        raise ValueError("No valid objective mimic items were produced.")
    return normalized


def _forbidden_for_verified(stem: str, verified_answer: str | None) -> dict[str, Any] | None:
    if not verified_answer:
        return None
    kind = "numeric" if numeric_value(verified_answer) is not None else "short"
    return build_forbidden({"type": kind, "stem": stem, "answer": verified_answer})


def _scrub_leaking_hints(blueprint: dict[str, Any], stem: str, verified_answer: str | None) -> dict[str, Any]:
    forbidden = _forbidden_for_verified(stem, verified_answer)
    if forbidden is None:
        return blueprint
    cleaned = {**blueprint, "hints": {}}
    if cleaned.get("approach_prompt") and answer_leaks(cleaned["approach_prompt"], forbidden):
        cleaned["approach_prompt"] = ""
    for level in ("1", "2"):
        hint = (blueprint.get("hints") or {}).get(level, "")
        if hint and not answer_leaks(hint, forbidden):
            cleaned["hints"][level] = hint
    return cleaned


def _map_kps_for_stem(
    repository: SQLiteRepository,
    space_id: str,
    stem: str,
    *,
    preferred_kp_id: str | None = None,
) -> tuple[list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    pages = retrieve_structured_pages(
        repository,
        space_id=space_id,
        query=stem,
        active_kp_id=preferred_kp_id,
        max_pages=3,
    )
    mapped: list[str] = []
    with repository.connection() as conn:
        _require_course(conn, space_id)
        if preferred_kp_id:
            valid = conn.execute(
                "SELECT id FROM knowledge_points WHERE id = ? AND space_id = ? AND status = 'active'",
                (preferred_kp_id, space_id),
            ).fetchone()
            if valid is not None:
                mapped.append(preferred_kp_id)

        for page in pages:
            for kp_id in page.kp_ids:
                if kp_id not in mapped:
                    mapped.append(kp_id)

        if len(mapped) < 3:
            lowered = stem.lower()
            rows = conn.execute(
                """SELECT id, name, summary FROM knowledge_points
                   WHERE space_id = ? AND status = 'active' ORDER BY ord""",
                (space_id,),
            ).fetchall()
            for row in rows:
                kp_id = str(row["id"])
                if kp_id in mapped:
                    continue
                name = str(row["name"] or "").strip()
                if len(name) >= 2 and name.lower() in lowered:
                    mapped.append(kp_id)
                    if len(mapped) >= 3:
                        break

        mapped = mapped[:3]
        kp_context: list[dict[str, Any]] = []
        if mapped:
            placeholders = ",".join("?" for _ in mapped)
            kp_rows = conn.execute(
                f"""SELECT kp.id, kp.name, kp.summary, kp.formula,
                           m.p AS mastery_p, m.status AS mastery_status
                    FROM knowledge_points kp
                    LEFT JOIN kp_mastery m ON m.kp_id = kp.id AND m.space_id = kp.space_id
                    WHERE kp.space_id = ? AND kp.id IN ({placeholders})""",
                (space_id, *mapped),
            ).fetchall()
            gap_rows = conn.execute(
                f"""SELECT kp_id, text, count FROM misconceptions
                    WHERE space_id = ? AND kp_id IN ({placeholders}) AND resolved_at IS NULL
                    ORDER BY count DESC, last_seen_at DESC LIMIT 8""",
                (space_id, *mapped),
            ).fetchall()
            gaps_by_kp: dict[str, list[str]] = {}
            for gap in gap_rows:
                gaps_by_kp.setdefault(str(gap["kp_id"]), []).append(str(gap["text"]))
            for row in kp_rows:
                kp_context.append({
                    "id": str(row["id"]),
                    "name": str(row["name"]),
                    "summary": str(row["summary"] or "")[:240],
                    "formula": str(row["formula"] or ""),
                    "mastery_p": row["mastery_p"],
                    "mastery_status": row["mastery_status"] or "unseen",
                    "misconceptions": gaps_by_kp.get(str(row["id"]), []),
                })

    excerpts = [
        {
            "material_id": page.material_id,
            "page": page.page_no,
            "section": page.section_title,
            "text": page.markdown[:2000],
        }
        for page in pages
    ]
    return mapped, kp_context, excerpts


def _public_session(conn, row) -> dict[str, Any]:
    space_id = str(row["space_id"])
    session_id = str(row["id"])
    mapped_kp_ids: list[str] = json.loads(row["mapped_kp_ids_json"] or "[]")
    blueprint: dict[str, Any] = json.loads(row["blueprint_json"] or "{}")
    state: dict[str, Any] = json.loads(row["state_json"] or "{}")
    mimic_refs: list[str] = json.loads(row["mimic_item_refs_json"] or "[]")
    verify_status = str(row["verify_status"])
    revealed = bool(state.get("revealed"))
    solved = bool(state.get("solved"))
    show_steps = revealed or solved or verify_status != "verified"
    hint_level = int(state.get("hint_level") or 0)

    hints_map = blueprint.get("hints") if isinstance(blueprint.get("hints"), dict) else {}
    available_hint_levels = [lvl for lvl in (1, 2) if hints_map.get(str(lvl))]
    unlocked_hints = [
        {"level": lvl, "text": str(hints_map[str(lvl)])}
        for lvl in available_hint_levels
        if lvl <= hint_level
    ]

    mapped_kps: list[dict[str, Any]] = []
    if mapped_kp_ids:
        placeholders = ",".join("?" for _ in mapped_kp_ids)
        kp_rows = conn.execute(
            f"""SELECT kp.id, kp.name, m.p AS mastery_p, m.status AS mastery_status,
                       s.weight AS exam_weight, s.n_items AS exam_count
                FROM knowledge_points kp
                LEFT JOIN kp_mastery m ON m.kp_id = kp.id AND m.space_id = kp.space_id
                LEFT JOIN kp_exam_stats s ON s.kp_id = kp.id AND s.space_id = kp.space_id
                WHERE kp.space_id = ? AND kp.id IN ({placeholders})""",
            (space_id, *mapped_kp_ids),
        ).fetchall()
        by_id = {str(item["id"]): item for item in kp_rows}
        for kp_id in mapped_kp_ids:
            kp_row = by_id.get(kp_id)
            if kp_row is None:
                continue
            mapped_kps.append({
                "id": kp_id,
                "name": str(kp_row["name"]),
                "mastery_p": kp_row["mastery_p"],
                "mastery_status": str(kp_row["mastery_status"] or "unseen"),
                "exam_weight": kp_row["exam_weight"],
                "exam_count": int(kp_row["exam_count"] or 0),
            })

    mimic_results: dict[str, dict[str, Any]] = state.get("mimic_results") or {}
    mimic_items: list[dict[str, Any]] = []
    if mimic_refs:
        placeholders = ",".join("?" for _ in mimic_refs)
        bank_rows = conn.execute(
            f"""SELECT id, kp_id, type, difficulty, item_json FROM item_bank
                WHERE space_id = ? AND verify_status = 'verified' AND id IN ({placeholders})""",
            (space_id, *mimic_refs),
        ).fetchall()
        bank_by_id = {str(item["id"]): item for item in bank_rows}
        for ref in mimic_refs:
            bank_row = bank_by_id.get(ref)
            if bank_row is None:
                continue
            parsed_item = json.loads(bank_row["item_json"])
            result = mimic_results.get(ref)
            public_item: dict[str, Any] = {
                "id": ref,
                "kp_id": str(bank_row["kp_id"]),
                "type": str(bank_row["type"]),
                "difficulty": int(bank_row["difficulty"] or 2),
                "stem": str(parsed_item.get("stem") or ""),
                "options": parsed_item.get("options") if bank_row["type"] == "choice" else None,
                "result": result,
            }
            if result is not None:
                public_item["answer"] = parsed_item.get("answer")
                public_item["solution"] = parsed_item.get("solution") or str(parsed_item.get("answer") or "")
            mimic_items.append(public_item)

    return {
        "id": session_id,
        "course_id": space_id,
        "source_kind": str(row["source_kind"]),
        "stem": str(row["stem"]),
        "has_image": bool(row["image_path"]),
        "image_url": f"/api/v2/courses/{space_id}/solve/{session_id}/image" if row["image_path"] else None,
        "verify_status": verify_status,
        "verify_reason": str(blueprint.get("verify_reason") or ""),
        "status": str(row["status"]),
        "mapped_kps": mapped_kps,
        "approach_prompt": str(blueprint.get("approach_prompt") or ""),
        "key_formula": str(blueprint.get("key_formula") or "") if show_steps or hint_level >= 2 else "",
        "hint_level": hint_level,
        "max_hint_level": len(available_hint_levels),
        "hints": unlocked_hints,
        "revealed": revealed,
        "solved": solved,
        "steps": blueprint.get("steps") if show_steps else [],
        "pitfalls": blueprint.get("pitfalls") if show_steps else [],
        "verified_answer": blueprint.get("verified_answer") if (revealed or solved) and verify_status == "verified" else None,
        "step_explanations": state.get("step_explanations") or {},
        "turns": state.get("turns") or [],
        "mimic_items": mimic_items,
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def list_solve_sessions(repository: SQLiteRepository, space_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        rows = conn.execute(
            """SELECT id, space_id, source_kind, stem, image_path, verify_status, status,
                      mapped_kp_ids_json, state_json, mimic_item_refs_json, created_at, updated_at
               FROM solve_sessions WHERE space_id = ?
               ORDER BY updated_at DESC, id DESC LIMIT ?""",
            (space_id, max(1, min(limit, 50))),
        ).fetchall()
    summaries: list[dict[str, Any]] = []
    for row in rows:
        state = json.loads(row["state_json"] or "{}")
        summaries.append({
            "id": str(row["id"]),
            "course_id": str(row["space_id"]),
            "source_kind": str(row["source_kind"]),
            "stem_preview": str(row["stem"])[:160],
            "has_image": bool(row["image_path"]),
            "verify_status": str(row["verify_status"]),
            "status": str(row["status"]),
            "solved": bool(state.get("solved")),
            "revealed": bool(state.get("revealed")),
            "mimic_count": len(json.loads(row["mimic_item_refs_json"] or "[]")),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        })
    return summaries


def get_solve_session(repository: SQLiteRepository, space_id: str, session_id: str) -> dict[str, Any]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        row = conn.execute(
            "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
            (session_id, space_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Solve session not found", code="solve_session_not_found")
        return _public_session(conn, row)


async def create_solve_session(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
    *,
    stem: str = "",
    kp_id: str | None = None,
    image_bytes: bytes | None = None,
    image_mime: str | None = None,
) -> dict[str, Any]:
    """Loop 1: transcribe (optional image), map course KPs, independently verify, and build guarded blueprint."""
    session_id = str(uuid4())
    cleaned_stem = stem.strip()
    source_kind = "text"
    image_path: str | None = None

    def _check_course() -> None:
        with repository.connection() as conn:
            _require_course(conn, space_id)

    await asyncio.to_thread(_check_course)

    if image_bytes is not None:
        source_kind = "image"
        mime = (image_mime or "image/jpeg").lower()
        if mime not in _ALLOWED_MIME:
            raise CodedValueError("solve_image_invalid", "Only JPEG, PNG, and WebP images are supported.")
        image_path, jpeg_bytes = await asyncio.to_thread(_save_solve_image, repository, space_id, session_id, image_bytes)
        try:
            transcribed = (await gateway.transcribe_page(jpeg_bytes, mime="image/jpeg")).strip()
        except ProviderConfigurationError as exc:
            raise CodedValueError("vision_model_missing", exc.public_detail) from None
        except ProviderError as exc:
            raise CodedValueError("solve_vision_failed", exc.public_detail) from None
        if not transcribed:
            raise CodedValueError("solve_image_unreadable", "Could not read a problem from the uploaded image.")
        cleaned_stem = f"{transcribed}\n\n{cleaned_stem}".strip() if cleaned_stem else transcribed

    if not cleaned_stem:
        raise CodedValueError("solve_stem_required", "Provide a problem statement or upload a problem image.")
    if len(cleaned_stem) > 6000:
        raise CodedValueError("solve_stem_too_long", "Problem text exceeds the 6000-character limit.")

    mapped_kp_ids, kp_context, excerpts = await asyncio.to_thread(
        _map_kps_for_stem, repository, space_id, cleaned_stem, preferred_kp_id=kp_id,
    )

    verification = await ItemVerifier(gateway).verify({"type": "short", "stem": cleaned_stem})
    verify_status = str(verification.get("status") or "unverified")
    if verify_status not in {"verified", "disputed", "unverified"}:
        verify_status = "unverified"
    verified_answer = verification.get("solved_answer") if verify_status == "verified" else None
    verify_reason = str(verification.get("reason") or "")

    try:
        blueprint = await gateway.complete_tagged(
            "analysis",
            "analysis/solve_blueprint",
            {
                "item_stem": _json_block("problem", {"stem": cleaned_stem}),
                "reference_answer": _json_block("verification", {
                    "status": verify_status,
                    "answer": verified_answer,
                    "candidate_note": verification.get("solved_answer") if verify_status != "verified" else None,
                }),
                "course_context": _json_block("course", {
                    "mapped_kps": kp_context,
                    "source_excerpts": excerpts,
                }),
            },
            parse=_parse_blueprint,
            cache=False,
            max_tokens=2048,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("solve_blueprint_failed", str(exc)) from None

    blueprint = _scrub_leaking_hints(blueprint, cleaned_stem, verified_answer)
    blueprint["verified_answer"] = verified_answer
    blueprint["verify_reason"] = verify_reason

    now = _now().isoformat()
    initial_state = {
        "hint_level": 0,
        "revealed": False,
        "solved": False,
        "step_explanations": {},
        "turns": [],
        "mimic_results": {},
    }

    def _insert() -> dict[str, Any]:
        with repository.connection() as conn:
            conn.execute(
                """INSERT INTO solve_sessions(
                       id, space_id, source_kind, stem, image_path, mapped_kp_ids_json,
                       verify_status, blueprint_json, state_json, mimic_item_refs_json,
                       status, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?)""",
                (
                    session_id,
                    space_id,
                    source_kind,
                    cleaned_stem,
                    image_path,
                    json.dumps(mapped_kp_ids, ensure_ascii=False),
                    verify_status,
                    json.dumps(blueprint, ensure_ascii=False),
                    json.dumps(initial_state, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            return _public_session(conn, row)

    return await asyncio.to_thread(_insert)


def _deterministic_match(attempt: str, verified_answer: str) -> bool:
    left = attempt.strip()
    right = verified_answer.strip()
    if not left or not right:
        return False
    if left.casefold() == right.casefold():
        return True
    left_num, right_num = numeric_value(left), numeric_value(right)
    return left_num is not None and right_num is not None and left_num == right_num


async def step_solve_session(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
    session_id: str,
    *,
    action: str,
    text: str = "",
    step_index: int | None = None,
) -> dict[str, Any]:
    """Loop 2: deterministic guided interaction respecting answer-leak and verification invariants."""
    def _load() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        with repository.connection() as conn:
            _require_course(conn, space_id)
            row = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            if row is None:
                raise ResourceNotFoundError("Solve session not found", code="solve_session_not_found")
            return dict(row), json.loads(row["blueprint_json"] or "{}"), json.loads(row["state_json"] or "{}")

    row, blueprint, state = await asyncio.to_thread(_load)
    now = _now().isoformat()
    turns: list[dict[str, Any]] = list(state.get("turns") or [])
    verify_status = str(row["verify_status"])
    verified_answer = blueprint.get("verified_answer") if verify_status == "verified" else None
    hints_map: dict[str, str] = blueprint.get("hints") or {}
    available_levels = [lvl for lvl in (1, 2) if hints_map.get(str(lvl))]
    next_status = str(row["status"])

    if action == "hint":
        current_level = int(state.get("hint_level") or 0)
        next_level = next((lvl for lvl in available_levels if lvl > current_level), None)
        if next_level is not None:
            state["hint_level"] = next_level
            turns.append({
                "id": str(uuid4()),
                "role": "teacher",
                "kind": "hint",
                "hint_level": next_level,
                "text": hints_map[str(next_level)],
                "created_at": now,
            })
        else:
            turns.append({
                "id": str(uuid4()),
                "role": "teacher",
                "kind": "hint_exhausted",
                "text": "",
                "created_at": now,
            })

    elif action == "show_solution":
        state["revealed"] = True
        turns.append({
            "id": str(uuid4()),
            "role": "teacher",
            "kind": "solution_revealed",
            "text": "",
            "created_at": now,
        })

    elif action == "finish":
        next_status = "done"

    elif action == "locate_step":
        steps: list[str] = blueprint.get("steps") or []
        visible = bool(state.get("revealed")) or bool(state.get("solved")) or verify_status != "verified"
        if not visible:
            raise CodedValueError("solve_steps_locked", "Reveal the solution before asking about a specific step.")
        if step_index is None or not (0 <= step_index < len(steps)):
            raise CodedValueError("solve_step_invalid", "Selected derivation step does not exist.")
        mapped_kps: list[str] = json.loads(row["mapped_kp_ids_json"] or "[]")
        pages = await asyncio.to_thread(
            retrieve_structured_pages,
            repository,
            space_id=space_id,
            query=f"{row['stem']} {steps[step_index]}",
            active_kp_id=mapped_kps[0] if mapped_kps else None,
            max_pages=2,
        )
        detail = await gateway.complete_tagged(
            "live",
            "analysis/solve_step_detail",
            {
                "solve_step": _json_block("step", {
                    "problem": row["stem"],
                    "step_index": step_index + 1,
                    "step_text": steps[step_index],
                    "previous_step": steps[step_index - 1] if step_index > 0 else "",
                    "next_step": steps[step_index + 1] if step_index + 1 < len(steps) else "",
                }),
                "page_content": _json_block("sources", [
                    {"material_id": page.material_id, "page": page.page_no, "text": page.markdown[:1800]}
                    for page in pages
                ]),
            },
            parse=_parse_step_detail,
            cache=False,
            max_tokens=1024,
        )
        explanations = dict(state.get("step_explanations") or {})
        explanations[str(step_index)] = detail
        state["step_explanations"] = explanations
        await asyncio.to_thread(
            record_trace,
            repository,
            space_id=space_id,
            surface="solve",
            event_type="locate_stuck",
            summary=steps[step_index][:240],
            source_ref={"kind": "solve", "id": session_id, "step_index": step_index},
            kp_id=mapped_kps[0] if mapped_kps else None,
        )
        turns.append({
            "id": str(uuid4()),
            "role": "teacher",
            "kind": "step_detail",
            "step_index": step_index,
            "text": detail.get("summary") or "",
            "substeps": detail.get("substeps") or [],
            "created_at": now,
        })

    elif action == "submit_idea":
        idea = text.strip()
        if not idea:
            raise CodedValueError("solve_attempt_required", "Enter your idea or attempted answer first.")
        if len(idea) > 3000:
            raise CodedValueError("solve_attempt_too_long", "Attempt text exceeds the 3000-character limit.")
        turns.append({
            "id": str(uuid4()),
            "role": "student",
            "kind": "idea",
            "text": idea,
            "created_at": now,
        })
        if verify_status == "verified" and verified_answer and _deterministic_match(idea, verified_answer):
            state["solved"] = True
            state["revealed"] = True
            turns.append({
                "id": str(uuid4()),
                "role": "teacher",
                "kind": "verdict_correct",
                "verdict": "correct",
                "text": "",
                "created_at": now,
            })
        else:
            feedback = await gateway.complete_tagged(
                "live",
                "analysis/solve_feedback",
                {
                    "item_stem": _json_block("problem", {"stem": row["stem"]}),
                    "reference_answer": _json_block("verification", {
                        "status": verify_status,
                        "answer": verified_answer,
                    }),
                    "learner_attempt": data_block("attempt", idea),
                    "course_context": _json_block("blueprint_context", {
                        "steps": blueprint.get("steps") or [],
                        "pitfalls": blueprint.get("pitfalls") or [],
                        "current_hint_level": int(state.get("hint_level") or 0),
                    }),
                },
                parse=_parse_feedback,
                cache=False,
                max_tokens=512,
            )
            verdict = feedback["verdict"] if verify_status == "verified" else "discuss"
            reply = feedback["reply"]
            if verify_status == "verified" and verdict == "correct":
                state["solved"] = True
                state["revealed"] = True
                turns.append({
                    "id": str(uuid4()),
                    "role": "teacher",
                    "kind": "verdict_correct",
                    "verdict": "correct",
                    "text": reply,
                    "created_at": now,
                })
            else:
                forbidden = _forbidden_for_verified(str(row["stem"]), verified_answer)
                if forbidden and answer_leaks(reply, forbidden):
                    reply = ""
                if verify_status == "verified":
                    current_level = int(state.get("hint_level") or 0)
                    next_level = next((lvl for lvl in available_levels if lvl > current_level), None)
                    if next_level is not None:
                        state["hint_level"] = next_level
                        if not reply:
                            reply = hints_map[str(next_level)]
                turns.append({
                    "id": str(uuid4()),
                    "role": "teacher",
                    "kind": "coaching",
                    "verdict": verdict,
                    "text": reply,
                    "created_at": now,
                })
    else:
        raise CodedValueError("solve_action_invalid", "Unsupported solve action.")

    state["turns"] = turns[-40:]

    def _save() -> dict[str, Any]:
        with repository.connection() as conn:
            conn.execute(
                """UPDATE solve_sessions SET state_json = ?, status = ?, updated_at = ?
                   WHERE id = ? AND space_id = ?""",
                (json.dumps(state, ensure_ascii=False), next_status, now, session_id, space_id),
            )
            updated = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            return _public_session(conn, updated)

    return await asyncio.to_thread(_save)


async def generate_mimic_items(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
    session_id: str,
    *,
    count: int = 1,
) -> dict[str, Any]:
    """Generate 1-2 exam-style isomorphic variants and persist ONLY ItemVerifier-verified items."""
    requested = max(1, min(count, 2))

    def _load_context() -> dict[str, Any]:
        with repository.connection() as conn:
            _require_course(conn, space_id)
            row = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            if row is None:
                raise ResourceNotFoundError("Solve session not found", code="solve_session_not_found")
            mapped_kps: list[str] = json.loads(row["mapped_kp_ids_json"] or "[]")
            primary_kp: str | None = mapped_kps[0] if mapped_kps else None
            if primary_kp is None:
                fallback_kp = conn.execute(
                    "SELECT id FROM knowledge_points WHERE space_id = ? AND status = 'active' ORDER BY ord LIMIT 1",
                    (space_id,),
                ).fetchone()
                primary_kp = str(fallback_kp["id"]) if fallback_kp else None
            if primary_kp is None:
                raise CodedValueError(
                    "solve_kp_required",
                    "Analyze at least one course material first so practice items can link to a knowledge point.",
                )
            kp_row = conn.execute(
                "SELECT id, name, summary, formula FROM knowledge_points WHERE id = ? AND space_id = ?",
                (primary_kp, space_id),
            ).fetchone()
            exam_rows = conn.execute(
                """SELECT i.type, i.stem, i.options_json, i.difficulty
                   FROM exam_items i
                   JOIN item_kp ik ON ik.item_id = i.id
                   LEFT JOIN exam_papers p ON p.id = i.paper_id
                   WHERE i.space_id = ? AND ik.kp_id = ?
                     AND (p.reserved_for_mock IS NULL OR p.reserved_for_mock = 0)
                   ORDER BY i.created_at DESC LIMIT 3""",
                (space_id, primary_kp),
            ).fetchall()
            gap_rows = conn.execute(
                """SELECT text FROM misconceptions
                   WHERE space_id = ? AND kp_id = ? AND resolved_at IS NULL
                   ORDER BY count DESC LIMIT 4""",
                (space_id, primary_kp),
            ).fetchall()
            return {
                "stem": str(row["stem"]),
                "existing_refs": json.loads(row["mimic_item_refs_json"] or "[]"),
                "kp": dict(kp_row) if kp_row else {"id": primary_kp, "name": "", "summary": "", "formula": ""},
                "exam_exemplars": [
                    {
                        "type": str(item["type"]),
                        "stem": str(item["stem"])[:600],
                        "options": json.loads(item["options_json"]) if item["options_json"] else None,
                        "difficulty": item["difficulty"],
                    }
                    for item in exam_rows
                ],
                "misconceptions": [str(gap["text"]) for gap in gap_rows],
            }

    ctx = await asyncio.to_thread(_load_context)
    try:
        candidates = await gateway.complete_tagged(
            "analysis",
            "analysis/mimic_items",
            {
                "generation_count": str(requested),
                "item_stem": _json_block("original_problem", {"stem": ctx["stem"]}),
                "exam_items": _json_block("course_exam_style", ctx["exam_exemplars"]),
                "course_context": _json_block("target_kp", {
                    "kp": ctx["kp"],
                    "misconceptions": ctx["misconceptions"],
                }),
            },
            parse=_parse_mimic_items,
            cache=False,
            max_tokens=2048,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("mimic_generation_failed", str(exc)) from None

    verifier = ItemVerifier(gateway)
    verified_items: list[dict[str, Any]] = []
    for candidate in candidates:
        verifier_input = dict(candidate)
        if candidate["type"] == "choice":
            verifier_input["options"] = {opt["key"]: opt["text"] for opt in candidate["options"]}
        decision = await verifier.verify(verifier_input)
        if decision.get("status") != "verified":
            _LOG.info("solve_mimic_discarded_status=%s", decision.get("status"))
            continue
        verified_items.append({
            **candidate,
            "kp_id": ctx["kp"]["id"],
            "verify": {"status": "verified"},
        })
        if len(verified_items) >= requested:
            break

    if not verified_items:
        raise CodedValueError(
            "mimic_verification_failed",
            "Generated practice variants did not pass independent answer verification.",
        )

    now = _now().isoformat()

    def _persist() -> dict[str, Any]:
        with repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            if row is None:
                raise ResourceNotFoundError("Solve session not found", code="solve_session_not_found")
            refs: list[str] = json.loads(row["mimic_item_refs_json"] or "[]")
            for item in verified_items:
                item_id = f"ib_{uuid4().hex[:16]}"
                payload = {**item, "bank_id": item_id, "origin": {"kind": "generated"}}
                conn.execute(
                    """INSERT INTO item_bank(
                           id, space_id, kp_id, origin, exam_item_id, purpose, type,
                           difficulty, variant_of, item_json, verify_status, reserved, created_at
                       ) VALUES (?, ?, ?, 'generated', NULL, 'practice', ?, ?, ?, ?, 'verified', 0, ?)""",
                    (
                        item_id,
                        space_id,
                        ctx["kp"]["id"],
                        item["type"],
                        item["difficulty"],
                        session_id,
                        json.dumps(payload, ensure_ascii=False),
                        now,
                    ),
                )
                refs.append(item_id)
            conn.execute(
                "UPDATE solve_sessions SET mimic_item_refs_json = ?, updated_at = ? WHERE id = ? AND space_id = ?",
                (json.dumps(refs, ensure_ascii=False), now, session_id, space_id),
            )
            updated = conn.execute(
                "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
                (session_id, space_id),
            ).fetchone()
            return _public_session(conn, updated)

    return await asyncio.to_thread(_persist)


def submit_mimic_answer(
    repository: SQLiteRepository,
    space_id: str,
    session_id: str,
    item_id: str,
    *,
    answer: object,
    dont_know: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Deterministically grade a verified mimic item, record BKT evidence, and enqueue review on miss."""
    submitted = now.astimezone(timezone.utc) if now else _now()
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_course(conn, space_id)
        row = conn.execute(
            "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
            (session_id, space_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Solve session not found", code="solve_session_not_found")
        refs: list[str] = json.loads(row["mimic_item_refs_json"] or "[]")
        if item_id not in refs:
            raise ResourceNotFoundError("Mimic item not found in this solve session", code="mimic_item_not_found")
        bank_row = conn.execute(
            "SELECT * FROM item_bank WHERE id = ? AND space_id = ? AND verify_status = 'verified'",
            (item_id, space_id),
        ).fetchone()
        if bank_row is None:
            raise ResourceNotFoundError("Verified mimic item not found", code="mimic_item_not_found")

        state: dict[str, Any] = json.loads(row["state_json"] or "{}")
        mimic_results: dict[str, dict[str, Any]] = dict(state.get("mimic_results") or {})
        if item_id in mimic_results:
            return {"session": _public_session(conn, row), "result": mimic_results[item_id]}

        item = json.loads(bank_row["item_json"])
        item.update(id=str(bank_row["id"]), kp_id=str(bank_row["kp_id"]), type=str(bank_row["type"]))
        item["verify"] = {"status": "verified"}
        try:
            graded = grade_objective(item, answer, dont_know=dont_know)
        except InvalidAnswer as exc:
            raise CodedValueError("invalid_answer", str(exc)) from None

        # Follow learner-model-and-planning.md §2.2: post-reveal isomorphic variants carry hint_level=1 (w=0.6)
        hint_level = 1 if (state.get("revealed") and not state.get("solved")) else 0
        kp_id = str(bank_row["kp_id"])
        current = conn.execute(
            "SELECT * FROM kp_mastery WHERE space_id = ? AND kp_id = ?",
            (space_id, kp_id),
        ).fetchone()
        enrollment = conn.execute(
            "SELECT enrollment_json FROM course_enrollment WHERE space_id = ?",
            (space_id,),
        ).fetchone()
        settings = json.loads(enrollment["enrollment_json"]) if enrollment else {}
        before = float(current["p"]) if current else initial_mastery_probability(settings.get("self_level", "never"))
        option_count = len(item.get("options") or []) if item["type"] == "choice" else None
        ev = Evidence("practice", graded["verdict"], hint_level, item["type"], "exact", option_count)
        after = update_mastery_probability(before, ev)

        clean = graded["verdict"] == "correct" and hint_level == 0
        clean_item = clean and conn.execute(
            "SELECT 1 FROM evidence WHERE space_id = ? AND item_ref = ? AND verdict = 'correct' AND hint_level = 0",
            (space_id, item_id),
        ).fetchone()
        day = submitted.date().isoformat()
        clean_day = clean and current and current["last_clean_day"] == day
        count = (int(current["evidence_count"]) if current else 0) + 1
        clean_count = (int(current["clean_correct_count"]) if current else 0) + int(clean and not clean_item)
        days = (int(current["clean_days"]) if current else 0) + int(clean and not clean_day)
        objective = bool(current and current["objective_clean"]) or clean
        status = classify_mastery(
            after,
            evidence_count=count,
            taught=bool(current and current["taught_at"]),
            clean_correct_count=clean_count,
            clean_days=days,
            objective_clean=objective,
        )

        conn.execute(
            """INSERT INTO evidence(
                   id, space_id, kp_id, item_ref, source, verdict, hint_level, item_type,
                   n_options, judged_by, via, p_before, p_after, detail_json, created_at
               ) VALUES (?, ?, ?, ?, 'practice', ?, ?, ?, ?, 'exact', 'control', ?, ?, ?, ?)""",
            (
                str(uuid4()),
                space_id,
                kp_id,
                item_id,
                graded["verdict"],
                hint_level,
                item["type"],
                option_count,
                before,
                after,
                json.dumps({"answer": graded.get("value"), "solve_session_id": session_id}, ensure_ascii=False),
                submitted.isoformat(),
            ),
        )
        conn.execute(
            """INSERT INTO kp_mastery(
                   space_id, kp_id, p, status, evidence_count, clean_correct_count,
                   clean_days, last_clean_day, objective_clean, inferred, last_evidence_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
               ON CONFLICT(space_id, kp_id) DO UPDATE SET
                   p=excluded.p, status=excluded.status, evidence_count=excluded.evidence_count,
                   clean_correct_count=excluded.clean_correct_count, clean_days=excluded.clean_days,
                   last_clean_day=excluded.last_clean_day, objective_clean=excluded.objective_clean,
                   inferred=0, last_evidence_at=excluded.last_evidence_at""",
            (
                space_id,
                kp_id,
                after,
                status,
                count,
                clean_count,
                days,
                day if clean else (current["last_clean_day"] if current else None),
                objective,
                submitted.isoformat(),
            ),
        )
        if graded["verdict"] != "correct":
            _add_wrong_card(conn, space_id, item, submitted)

        result = {
            "item_id": item_id,
            "verdict": graded["verdict"],
            "learner_answer": graded.get("value"),
            "hint_level": hint_level,
            "p_before": before,
            "p_after": after,
            "mastery_status": status,
            "answer": item.get("answer"),
            "solution": item.get("solution") or str(item.get("answer") or ""),
            "submitted_at": submitted.isoformat(),
        }
        mimic_results[item_id] = result
        state["mimic_results"] = mimic_results
        conn.execute(
            "UPDATE solve_sessions SET state_json = ?, updated_at = ? WHERE id = ? AND space_id = ?",
            (json.dumps(state, ensure_ascii=False), submitted.isoformat(), session_id, space_id),
        )
        updated = conn.execute(
            "SELECT * FROM solve_sessions WHERE id = ? AND space_id = ?",
            (session_id, space_id),
        ).fetchone()
        return {"session": _public_session(conn, updated), "result": result}
