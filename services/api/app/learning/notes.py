from __future__ import annotations

import asyncio
import json
from datetime import timezone
from typing import Any
from uuid import uuid4

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
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository
from app.teaching.understanding import InvalidAnswer, grade_objective

_BLOCK_TYPES = frozenset({
    "title", "text", "math", "list", "table", "code", "callout", "steps", "diagram", "plot", "image",
})
_OBJECTIVE_TYPES = ("choice", "numeric", "short")


def _now_iso() -> str:
    return utcnow().astimezone(timezone.utc).isoformat()


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _normalize_quiz_options(raw: object) -> list[dict[str, str]] | None:
    if isinstance(raw, dict):
        return [{"key": str(key), "text": str(value)} for key, value in raw.items()]
    if isinstance(raw, list):
        return [
            {str(k): str(v) for k, v in entry.items()}
            for entry in raw
            if isinstance(entry, dict)
        ]
    return None


def _require_course(conn, space_id: str) -> None:
    if conn.execute("SELECT 1 FROM study_spaces WHERE id = ?", (space_id,)).fetchone() is None:
        raise ResourceNotFoundError("Course not found", code="course_not_found")


def _parse_reader_answer(raw: str) -> dict[str, str]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "answer"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain answer JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, dict):
        raise ValueError("Reader answer must be a JSON object.")
    explanation = str(parsed.get("explanation") or "").strip()
    if not explanation:
        raise ValueError("Reader explanation cannot be empty.")
    block_type = str(parsed.get("block_type") or "callout").strip()
    if block_type not in _BLOCK_TYPES:
        block_type = "callout"
    return {
        "explanation": explanation[:2000],
        "key_takeaway": str(parsed.get("key_takeaway") or "").strip()[:160],
        "block_type": block_type,
        "block_content": str(parsed.get("block_content") or explanation).strip()[:3000],
    }


def _parse_note_suggestions(raw: str) -> list[dict[str, str]]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "suggestions"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain suggestions JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, list):
        raise ValueError("Suggestions must be a JSON array.")
    items: list[dict[str, str]] = []
    for entry in parsed[:3]:
        if not isinstance(entry, dict):
            continue
        content = str(entry.get("content") or "").strip()
        if not content:
            continue
        block_type = str(entry.get("block_type") or "callout").strip()
        if block_type not in _BLOCK_TYPES:
            block_type = "callout"
        items.append({
            "id": f"sug_{uuid4().hex[:10]}",
            "reason": str(entry.get("reason") or "").strip()[:120],
            "block_type": block_type,
            "title": str(entry.get("title") or "").strip()[:80],
            "content": content[:3000],
        })
    return items


def _kps_by_page(conn, space_id: str, material_id: str) -> dict[int, list[dict[str, Any]]]:
    rows = conn.execute(
        """SELECT kp.id, kp.name, kp.source_refs_json,
                  m.p AS mastery_p, m.status AS mastery_status,
                  s.n_items AS exam_count, s.weight AS exam_weight
           FROM knowledge_points kp
           LEFT JOIN kp_mastery m ON m.kp_id = kp.id AND m.space_id = kp.space_id
           LEFT JOIN kp_exam_stats s ON s.kp_id = kp.id AND s.space_id = kp.space_id
           WHERE kp.space_id = ? AND kp.status = 'active' ORDER BY kp.ord""",
        (space_id,),
    ).fetchall()
    mapping: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        try:
            refs = json.loads(row["source_refs_json"] or "[]")
        except (TypeError, json.JSONDecodeError):
            refs = []
        pages = {
            int(ref["page_no"])
            for ref in refs
            if isinstance(ref, dict) and ref.get("material_id") == material_id and isinstance(ref.get("page_no"), int)
        }
        info = {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "mastery_p": row["mastery_p"],
            "mastery_status": str(row["mastery_status"] or "unseen"),
            "exam_count": int(row["exam_count"] or 0),
            "exam_weight": row["exam_weight"],
        }
        for page_no in pages:
            mapping.setdefault(page_no, []).append(info)
    return mapping


def get_reader_overview(repository: SQLiteRepository, space_id: str, material_id: str) -> dict[str, Any]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        mat = conn.execute(
            """SELECT id, title, filename, role, parse_status FROM materials
               WHERE id = ? AND space_id = ?""",
            (material_id, space_id),
        ).fetchone()
        if mat is None:
            raise ResourceNotFoundError("Material not found", code="material_not_found")
        sections = conn.execute(
            """SELECT id, parent_id, level, title, page_start, page_end, ord
               FROM material_sections WHERE space_id = ? AND material_id = ? ORDER BY ord""",
            (space_id, material_id),
        ).fetchall()
        pages = conn.execute(
            """SELECT page_no, image_path FROM material_pages
               WHERE space_id = ? AND material_id = ? ORDER BY page_no""",
            (space_id, material_id),
        ).fetchall()
        kp_map = _kps_by_page(conn, space_id, material_id)
    return {
        "course_id": space_id,
        "material_id": str(mat["id"]),
        "title": str(mat["title"] or mat["filename"]),
        "role": str(mat["role"]),
        "parse_status": str(mat["parse_status"]),
        "page_count": len(pages),
        "sections": [dict(sec) for sec in sections],
        "pages": [
            {
                "page_no": int(page["page_no"]),
                "has_image": bool(page["image_path"]),
                "kps": kp_map.get(int(page["page_no"]), []),
            }
            for page in pages
        ],
    }


def get_reader_page(repository: SQLiteRepository, space_id: str, material_id: str, page_no: int) -> dict[str, Any]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        mat = conn.execute(
            "SELECT id, title, filename FROM materials WHERE id = ? AND space_id = ?",
            (material_id, space_id),
        ).fetchone()
        if mat is None:
            raise ResourceNotFoundError("Material not found", code="material_not_found")
        page = conn.execute(
            """SELECT page_no, markdown, source, quality, image_path FROM material_pages
               WHERE space_id = ? AND material_id = ? AND page_no = ?""",
            (space_id, material_id, page_no),
        ).fetchone()
        if page is None:
            raise ResourceNotFoundError("Material page not found", code="material_page_not_found")
        total_pages = int(conn.execute(
            "SELECT COUNT(*) FROM material_pages WHERE space_id = ? AND material_id = ?",
            (space_id, material_id),
        ).fetchone()[0])
        sec = conn.execute(
            """SELECT title FROM material_sections
               WHERE space_id = ? AND material_id = ?
                 AND page_start IS NOT NULL AND page_start <= ?
                 AND (page_end IS NULL OR page_end >= ?)
               ORDER BY level DESC, page_start DESC LIMIT 1""",
            (space_id, material_id, page_no, page_no),
        ).fetchone()
        kps = _kps_by_page(conn, space_id, material_id).get(page_no, [])

        quick_quiz = None
        if kps:
            kp_ids = [kp["id"] for kp in kps]
            placeholders = ",".join("?" for _ in kp_ids)
            item_row = conn.execute(
                f"""SELECT id, kp_id, type, difficulty, item_json FROM item_bank
                    WHERE space_id = ? AND verify_status = 'verified' AND reserved = 0
                      AND kp_id IN ({placeholders}) AND type IN (?, ?, ?)
                    ORDER BY difficulty, id LIMIT 1""",
                (space_id, *kp_ids, *_OBJECTIVE_TYPES),
            ).fetchone()
            if item_row is not None:
                parsed_item = json.loads(item_row["item_json"])
                quick_quiz = {
                    "id": str(item_row["id"]),
                    "kp_id": str(item_row["kp_id"]),
                    "type": str(item_row["type"]),
                    "difficulty": int(item_row["difficulty"] or 2),
                    "stem": str(parsed_item.get("stem") or ""),
                    "options": _normalize_quiz_options(parsed_item.get("options")) if item_row["type"] == "choice" else None,
                }
    return {
        "course_id": space_id,
        "material_id": str(mat["id"]),
        "material_title": str(mat["title"] or mat["filename"]),
        "page_no": int(page["page_no"]),
        "total_pages": total_pages,
        "section_title": str(sec["title"]) if sec and sec["title"] else None,
        "markdown": str(page["markdown"] or ""),
        "has_image": bool(page["image_path"]),
        "image_url": f"/api/v2/materials/{material_id}/pages/{page_no}/image" if page["image_path"] else None,
        "kps": kps,
        "quick_quiz": quick_quiz,
    }


async def ask_reader_page(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
    material_id: str,
    page_no: int,
    *,
    passage: str,
    question: str = "",
) -> dict[str, Any]:
    cleaned_passage = passage.strip()
    if not cleaned_passage:
        raise CodedValueError("reader_passage_required", "Select a passage or enter text to ask about.")
    if len(cleaned_passage) > 3000:
        raise CodedValueError("reader_passage_too_long", "Selected passage exceeds 3000 characters.")

    page_data = await asyncio.to_thread(get_reader_page, repository, space_id, material_id, page_no)
    try:
        answer = await gateway.complete_tagged(
            "live",
            "analysis/reader_ask",
            {
                "selected_passage": data_block("passage", cleaned_passage),
                "student_question": data_block("question", question.strip()[:500] or "Explain this passage."),
                "page_content": _json_block("page", {
                    "title": page_data["material_title"],
                    "section": page_data["section_title"],
                    "page_no": page_no,
                    "kps": [kp["name"] for kp in page_data["kps"]],
                    "markdown": page_data["markdown"][:3500],
                }),
            },
            parse=_parse_reader_answer,
            cache=False,
            max_tokens=1024,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("reader_ask_failed", str(exc)) from None

    primary_kp = page_data["kps"][0]["id"] if page_data["kps"] else None
    await asyncio.to_thread(
        record_trace,
        repository,
        space_id=space_id,
        surface="read",
        event_type="ask",
        summary=cleaned_passage[:220],
        source_ref={"kind": "material_page", "material_id": material_id, "page_no": page_no},
        kp_id=primary_kp,
    )
    return {
        "explanation": answer["explanation"],
        "key_takeaway": answer["key_takeaway"],
        "suggested_block": {
            "block_type": answer["block_type"],
            "title": answer["key_takeaway"] or page_data["section_title"] or page_data["material_title"],
            "content": answer["block_content"],
            "source_ref": {
                "kind": "material_page",
                "material_id": material_id,
                "material_title": page_data["material_title"],
                "page_no": page_no,
                "kp_id": primary_kp,
            },
        },
    }


def answer_reader_quick_check(
    repository: SQLiteRepository,
    space_id: str,
    item_id: str,
    *,
    answer: object,
    dont_know: bool = False,
) -> dict[str, Any]:
    submitted = utcnow().astimezone(timezone.utc)
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_course(conn, space_id)
        bank_row = conn.execute(
            "SELECT * FROM item_bank WHERE id = ? AND space_id = ? AND verify_status = 'verified' AND reserved = 0",
            (item_id, space_id),
        ).fetchone()
        if bank_row is None:
            raise ResourceNotFoundError("Quick check item not found", code="reader_quiz_not_found")
        item = json.loads(bank_row["item_json"])
        item.update(id=str(bank_row["id"]), kp_id=str(bank_row["kp_id"]), type=str(bank_row["type"]))
        item["verify"] = {"status": "verified"}
        try:
            graded = grade_objective(item, answer, dont_know=dont_know)
        except InvalidAnswer as exc:
            raise CodedValueError("invalid_answer", str(exc)) from None

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
        ev = Evidence("practice", graded["verdict"], 0, item["type"], "exact", option_count)
        after = update_mastery_probability(before, ev)
        clean = graded["verdict"] == "correct"
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
               ) VALUES (?, ?, ?, ?, 'practice', ?, 0, ?, ?, 'exact', 'control', ?, ?, ?, ?)""",
            (
                str(uuid4()),
                space_id,
                kp_id,
                item_id,
                graded["verdict"],
                item["type"],
                option_count,
                before,
                after,
                json.dumps({"answer": graded.get("value"), "surface": "read"}, ensure_ascii=False),
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
    return {
        "item_id": item_id,
        "verdict": graded["verdict"],
        "p_before": before,
        "p_after": after,
        "mastery_status": status,
        "answer": item.get("answer"),
        "solution": item.get("solution") or str(item.get("answer") or ""),
    }


def _serialize_note_detail(conn, note_row) -> dict[str, Any]:
    space_id = str(note_row["space_id"])
    note_id = str(note_row["id"])
    blocks = conn.execute(
        """SELECT * FROM note_blocks WHERE note_id = ? AND space_id = ? ORDER BY ord, created_at, id""",
        (note_id, space_id),
    ).fetchall()
    kp_name = ""
    if note_row["kp_id"]:
        kp = conn.execute(
            "SELECT name FROM knowledge_points WHERE id = ? AND space_id = ?",
            (note_row["kp_id"], space_id),
        ).fetchone()
        kp_name = str(kp["name"]) if kp else ""
    return {
        "id": note_id,
        "course_id": space_id,
        "title": str(note_row["title"]),
        "kp_id": str(note_row["kp_id"]) if note_row["kp_id"] else None,
        "kp_name": kp_name,
        "blocks": [
            {
                "id": str(blk["id"]),
                "ord": int(blk["ord"]),
                "block_type": str(blk["block_type"]),
                "title": str(blk["title"]) if blk["title"] else None,
                "content": str(blk["content"]),
                "source_ref": json.loads(blk["source_ref_json"]) if blk["source_ref_json"] else None,
                "created_at": str(blk["created_at"]),
                "updated_at": str(blk["updated_at"]),
            }
            for blk in blocks
        ],
        "created_at": str(note_row["created_at"]),
        "updated_at": str(note_row["updated_at"]),
    }


def list_course_notes(repository: SQLiteRepository, space_id: str) -> list[dict[str, Any]]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        rows = conn.execute(
            """SELECT n.*, kp.name AS kp_name,
                      (SELECT COUNT(*) FROM note_blocks b WHERE b.note_id = n.id) AS block_count
               FROM course_notes n
               LEFT JOIN knowledge_points kp ON kp.id = n.kp_id AND kp.space_id = n.space_id
               WHERE n.space_id = ?
               ORDER BY n.updated_at DESC, n.id DESC""",
            (space_id,),
        ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "course_id": str(row["space_id"]),
            "title": str(row["title"]),
            "kp_id": str(row["kp_id"]) if row["kp_id"] else None,
            "kp_name": str(row["kp_name"] or ""),
            "block_count": int(row["block_count"] or 0),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }
        for row in rows
    ]


def create_course_note(
    repository: SQLiteRepository,
    space_id: str,
    *,
    title: str,
    kp_id: str | None = None,
) -> dict[str, Any]:
    cleaned = title.strip()
    if not cleaned:
        raise CodedValueError("note_title_required", "Provide a note title.")
    now = _now_iso()
    note_id = f"note_{uuid4().hex[:14]}"
    with repository.connection() as conn:
        _require_course(conn, space_id)
        valid_kp = None
        if kp_id:
            kp = conn.execute(
                "SELECT id FROM knowledge_points WHERE id = ? AND space_id = ?",
                (kp_id, space_id),
            ).fetchone()
            valid_kp = str(kp["id"]) if kp else None
        conn.execute(
            """INSERT INTO course_notes(id, space_id, title, kp_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (note_id, space_id, cleaned[:120], valid_kp, now, now),
        )
        row = conn.execute(
            "SELECT * FROM course_notes WHERE id = ? AND space_id = ?",
            (note_id, space_id),
        ).fetchone()
        return _serialize_note_detail(conn, row)


def get_course_note(repository: SQLiteRepository, space_id: str, note_id: str) -> dict[str, Any]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        row = conn.execute(
            "SELECT * FROM course_notes WHERE id = ? AND space_id = ?",
            (note_id, space_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Course note not found", code="note_not_found")
        return _serialize_note_detail(conn, row)


def delete_course_note(repository: SQLiteRepository, space_id: str, note_id: str) -> None:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        cur = conn.execute("DELETE FROM course_notes WHERE id = ? AND space_id = ?", (note_id, space_id))
        if cur.rowcount == 0:
            raise ResourceNotFoundError("Course note not found", code="note_not_found")


def add_note_block(
    repository: SQLiteRepository,
    space_id: str,
    note_id: str,
    *,
    block_type: str,
    content: str,
    title: str | None = None,
    source_ref: dict[str, Any] | None = None,
    default_title: str = "Notebook",
) -> dict[str, Any]:
    if block_type not in _BLOCK_TYPES:
        raise CodedValueError("note_block_type_invalid", "Unsupported note block type.")
    cleaned = content.strip()
    if not cleaned:
        raise CodedValueError("note_block_content_required", "Block content cannot be empty.")
    now = _now_iso()
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_course(conn, space_id)
        resolved_note_id = note_id
        if note_id == "quick":
            existing = conn.execute(
                "SELECT id FROM course_notes WHERE space_id = ? ORDER BY updated_at DESC LIMIT 1",
                (space_id,),
            ).fetchone()
            if existing is not None:
                resolved_note_id = str(existing["id"])
            else:
                resolved_note_id = f"note_{uuid4().hex[:14]}"
                conn.execute(
                    """INSERT INTO course_notes(id, space_id, title, kp_id, created_at, updated_at)
                       VALUES (?, ?, ?, NULL, ?, ?)""",
                    (resolved_note_id, space_id, default_title[:120], now, now),
                )
        else:
            if conn.execute(
                "SELECT 1 FROM course_notes WHERE id = ? AND space_id = ?",
                (resolved_note_id, space_id),
            ).fetchone() is None:
                raise ResourceNotFoundError("Course note not found", code="note_not_found")

        max_ord = conn.execute(
            "SELECT COALESCE(MAX(ord), -1) FROM note_blocks WHERE note_id = ? AND space_id = ?",
            (resolved_note_id, space_id),
        ).fetchone()[0]
        block_id = f"nb_{uuid4().hex[:14]}"
        conn.execute(
            """INSERT INTO note_blocks(
                   id, note_id, space_id, ord, block_type, title, content, source_ref_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                block_id,
                resolved_note_id,
                space_id,
                int(max_ord) + 1,
                block_type,
                title.strip()[:120] if isinstance(title, str) and title.strip() else None,
                cleaned[:8000],
                json.dumps(source_ref, ensure_ascii=False) if source_ref else None,
                now,
                now,
            ),
        )
        conn.execute(
            "UPDATE course_notes SET updated_at = ? WHERE id = ? AND space_id = ?",
            (now, resolved_note_id, space_id),
        )
        row = conn.execute(
            "SELECT * FROM course_notes WHERE id = ? AND space_id = ?",
            (resolved_note_id, space_id),
        ).fetchone()
        return _serialize_note_detail(conn, row)


def update_note_block(
    repository: SQLiteRepository,
    space_id: str,
    note_id: str,
    block_id: str,
    *,
    content: str | None = None,
    title: str | None = None,
    ord: int | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    with repository.connection() as conn:
        _require_course(conn, space_id)
        row = conn.execute(
            "SELECT * FROM note_blocks WHERE id = ? AND note_id = ? AND space_id = ?",
            (block_id, note_id, space_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Note block not found", code="note_block_not_found")
        next_content = str(row["content"])
        if content is not None:
            cleaned = content.strip()
            if not cleaned:
                raise CodedValueError("note_block_content_required", "Block content cannot be empty.")
            next_content = cleaned[:8000]
        next_title = row["title"] if title is None else (title.strip()[:120] or None)
        next_ord = int(row["ord"]) if ord is None else max(0, int(ord))
        conn.execute(
            """UPDATE note_blocks SET content = ?, title = ?, ord = ?, updated_at = ?
               WHERE id = ? AND note_id = ? AND space_id = ?""",
            (next_content, next_title, next_ord, now, block_id, note_id, space_id),
        )
        conn.execute(
            "UPDATE course_notes SET updated_at = ? WHERE id = ? AND space_id = ?",
            (now, note_id, space_id),
        )
        note_row = conn.execute(
            "SELECT * FROM course_notes WHERE id = ? AND space_id = ?",
            (note_id, space_id),
        ).fetchone()
        return _serialize_note_detail(conn, note_row)


def delete_note_block(repository: SQLiteRepository, space_id: str, note_id: str, block_id: str) -> dict[str, Any]:
    now = _now_iso()
    with repository.connection() as conn:
        _require_course(conn, space_id)
        cur = conn.execute(
            "DELETE FROM note_blocks WHERE id = ? AND note_id = ? AND space_id = ?",
            (block_id, note_id, space_id),
        )
        if cur.rowcount == 0:
            raise ResourceNotFoundError("Note block not found", code="note_block_not_found")
        conn.execute(
            "UPDATE course_notes SET updated_at = ? WHERE id = ? AND space_id = ?",
            (now, note_id, space_id),
        )
        note_row = conn.execute(
            "SELECT * FROM course_notes WHERE id = ? AND space_id = ?",
            (note_id, space_id),
        ).fetchone()
        return _serialize_note_detail(conn, note_row)


async def suggest_note_additions(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
    note_id: str,
) -> list[dict[str, str]]:
    """Read-only Dito-style Diff suggestions: never mutates the learner's note directly."""
    note = await asyncio.to_thread(get_course_note, repository, space_id, note_id)
    if not note["blocks"]:
        return []
    try:
        return await gateway.complete_tagged(
            "analysis",
            "analysis/note_suggest",
            {
                "note_blocks": _json_block("note", {
                    "title": note["title"],
                    "blocks": [
                        {"type": blk["block_type"], "title": blk["title"], "content": blk["content"][:1200]}
                        for blk in note["blocks"][:16]
                    ],
                }),
                "course_context": _json_block("kp", {"kp_name": note["kp_name"]}),
            },
            parse=_parse_note_suggestions,
            cache=False,
            max_tokens=1024,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("note_suggest_failed", str(exc)) from None


def create_flashcard_from_note_block(
    repository: SQLiteRepository,
    space_id: str,
    note_id: str,
    block_id: str,
    *,
    front: str | None = None,
    back: str | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    with repository.connection() as conn:
        _require_course(conn, space_id)
        note = conn.execute(
            "SELECT id, title, kp_id FROM course_notes WHERE id = ? AND space_id = ?",
            (note_id, space_id),
        ).fetchone()
        if note is None:
            raise ResourceNotFoundError("Course note not found", code="note_not_found")
        blk = conn.execute(
            "SELECT * FROM note_blocks WHERE id = ? AND note_id = ? AND space_id = ?",
            (block_id, note_id, space_id),
        ).fetchone()
        if blk is None:
            raise ResourceNotFoundError("Note block not found", code="note_block_not_found")
        card_front = (front or blk["title"] or note["title"]).strip()[:400]
        card_back = (back or blk["content"]).strip()[:2000]
        source_ref = json.loads(blk["source_ref_json"] or "{}")
        kp_id = source_ref.get("kp_id") or note["kp_id"]
        card_id = str(uuid4())
        conn.execute(
            """INSERT INTO review_cards(
                   id, space_id, kp_id, kind, front, back, item_ref, due_at, state, created_at, updated_at
               ) VALUES (?, ?, ?, 'flashcard', ?, ?, NULL, ?, 'pending', ?, ?)""",
            (card_id, space_id, kp_id, card_front, card_back, now, now, now),
        )
    return {"card_id": card_id, "front": card_front, "back": card_back}


def export_course_note(
    repository: SQLiteRepository,
    space_id: str,
    note_id: str,
    *,
    fmt: str = "md",
) -> tuple[str, str, str]:
    note = get_course_note(repository, space_id, note_id)
    if fmt == "anki_tsv":
        lines: list[str] = []
        tag = note["kp_name"].replace(" ", "_") if note["kp_name"] else "companion_space"
        for blk in note["blocks"]:
            front = (blk["title"] or note["title"]).replace("\t", " ").replace("\n", " ").strip()
            back = blk["content"].replace("\t", " ").replace("\n", "<br>").strip()
            lines.append(f"{front}\t{back}\t{tag}")
        return "\n".join(lines), "text/tab-separated-values; charset=utf-8", f"{note['id']}.tsv"

    md_parts = [f"# {note['title']}"]
    for blk in note["blocks"]:
        if blk["title"]:
            md_parts.append(f"## {blk['title']}")
        if blk["block_type"] == "math":
            md_parts.append(f"$$\n{blk['content']}\n$$")
        elif blk["block_type"] == "code":
            md_parts.append(f"```\n{blk['content']}\n```")
        else:
            md_parts.append(blk["content"])
        ref = blk.get("source_ref")
        if isinstance(ref, dict) and ref.get("page_no"):
            src_name = ref.get("material_title") or ref.get("material_id") or ""
            md_parts.append(f"> Source: {src_name} p.{ref['page_no']}")
    return "\n\n".join(md_parts) + "\n", "text/markdown; charset=utf-8", f"{note['id']}.md"
