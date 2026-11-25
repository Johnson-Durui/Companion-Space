from __future__ import annotations

import asyncio
import json
import logging
from datetime import timezone
from typing import Any
from uuid import uuid4

from app.core.errors import CodedValueError, ResourceNotFoundError
from app.llm.errors import LLMOutputError
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.repositories.mixins.common import utcnow
from app.services.repository import SQLiteRepository
from app.services.settings_store import get_setting, put_setting

_LOG = logging.getLogger(__name__)
_VALID_SURFACES = frozenset({"lesson", "solve", "read", "practice", "review"})
_VALID_KINDS = frozenset({"mistake_habit", "explanation_pref", "bottleneck_kp", "exam_focus"})
_VALID_STATUSES = frozenset({"active", "pinned", "dismissed"})
_VALID_REF_KINDS = frozenset({"evidence", "lesson", "solve", "trace", "misconception"})
_SYNTHESIS_KEY = "learner_memory_synthesis"


def _now_iso() -> str:
    return utcnow().astimezone(timezone.utc).isoformat()


def _json_block(name: str, value: object) -> str:
    return data_block(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _require_course(conn, space_id: str) -> None:
    if conn.execute("SELECT 1 FROM study_spaces WHERE id = ?", (space_id,)).fetchone() is None:
        raise ResourceNotFoundError("Course not found", code="course_not_found")


def record_trace(
    repository: SQLiteRepository,
    *,
    space_id: str,
    surface: str,
    event_type: str,
    summary: str,
    source_ref: dict[str, Any],
    kp_id: str | None = None,
) -> str:
    """Persist an L1 structured learning trace pointer (never raw audio or free chat)."""
    if surface not in _VALID_SURFACES:
        raise CodedValueError("memory_surface_invalid", "Unsupported trace surface.")
    cleaned_summary = summary.strip()[:300]
    if not cleaned_summary:
        return ""
    trace_id = f"tr_{uuid4().hex[:16]}"
    now = _now_iso()
    with repository.connection() as conn:
        _require_course(conn, space_id)
        conn.execute(
            """INSERT INTO learning_traces(
                   id, space_id, surface, kp_id, event_type, summary, source_ref_json, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                trace_id,
                space_id,
                surface,
                kp_id,
                event_type.strip()[:64],
                cleaned_summary,
                json.dumps(source_ref, ensure_ascii=False),
                now,
            ),
        )
    return trace_id


def _parse_distilled(raw: str) -> list[dict[str, Any]]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "memories"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain memories JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, list):
        raise ValueError("Memories must be a JSON array.")
    items: list[dict[str, Any]] = []
    for entry in parsed[:5]:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("kind") or "").strip()
        statement = str(entry.get("statement") or "").strip()
        kp_id = entry.get("kp_id")
        raw_refs = entry.get("evidence_refs")
        if kind not in _VALID_KINDS or not statement or not isinstance(raw_refs, list):
            continue
        refs: list[dict[str, str]] = []
        for ref in raw_refs[:6]:
            if not isinstance(ref, dict):
                continue
            r_kind = str(ref.get("kind") or "").strip()
            r_id = str(ref.get("id") or "").strip()
            if r_kind in _VALID_REF_KINDS and r_id:
                refs.append({"kind": r_kind, "id": r_id})
        if not refs:
            continue
        items.append({
            "kind": kind,
            "kp_id": str(kp_id).strip() if isinstance(kp_id, str) and kp_id.strip() else None,
            "statement": statement[:160],
            "evidence_refs": refs,
        })
    return items


def _parse_synthesis(raw: str) -> list[dict[str, Any]]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "synthesis"]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError("Expected one plain synthesis JSON block.")
    parsed = json.loads(nodes[0].text)
    if not isinstance(parsed, list):
        raise ValueError("Synthesis must be a JSON array.")
    notes: list[dict[str, Any]] = []
    for entry in parsed[:5]:
        if not isinstance(entry, dict):
            continue
        statement = str(entry.get("statement") or "").strip()
        source_ids = [
            str(item).strip()
            for item in (entry.get("source_memory_ids") or [])
            if isinstance(item, str) and item.strip()
        ]
        if not statement or not source_ids:
            continue
        notes.append({
            "statement": statement[:160],
            "source_memory_ids": list(dict.fromkeys(source_ids))[:6],
        })
    return notes


def _valid_ref_index(conn, space_id: str) -> dict[str, set[str]]:
    return {
        "evidence": {
            str(row["id"])
            for row in conn.execute("SELECT id FROM evidence WHERE space_id = ?", (space_id,))
        },
        "lesson": {
            str(row["id"])
            for row in conn.execute("SELECT id FROM lessons WHERE space_id = ?", (space_id,))
        },
        "solve": {
            str(row["id"])
            for row in conn.execute("SELECT id FROM solve_sessions WHERE space_id = ?", (space_id,))
        },
        "trace": {
            str(row["id"])
            for row in conn.execute("SELECT id FROM learning_traces WHERE space_id = ?", (space_id,))
        },
        "misconception": {
            str(row["id"])
            for row in conn.execute("SELECT id FROM misconceptions WHERE space_id = ?", (space_id,))
        },
    }


def _hydrate_ref(space_id: str, ref: dict[str, str]) -> dict[str, str | None]:
    kind = ref["kind"]
    ref_id = ref["id"]
    href: str | None = None
    if kind == "lesson":
        href = f"/lessons/{ref_id}/history"
    elif kind == "solve":
        href = f"/courses/{space_id}/solve?session={ref_id}"
    elif kind in {"evidence", "misconception"}:
        href = f"/courses/{space_id}/progress"
    elif kind == "trace":
        href = f"/courses/{space_id}/history"
    return {"kind": kind, "id": ref_id, "href": href}


def _serialize_fact(row, *, kp_names: dict[str, str], course_name: str | None = None) -> dict[str, Any]:
    space_id = str(row["space_id"])
    raw_refs = json.loads(row["evidence_refs_json"] or "[]")
    refs = [
        _hydrate_ref(space_id, ref)
        for ref in raw_refs
        if isinstance(ref, dict) and isinstance(ref.get("kind"), str) and isinstance(ref.get("id"), str)
    ]
    kp_id = str(row["kp_id"]) if row["kp_id"] else None
    payload: dict[str, Any] = {
        "id": str(row["id"]),
        "course_id": space_id,
        "kp_id": kp_id,
        "kp_name": kp_names.get(kp_id, "") if kp_id else "",
        "kind": str(row["kind"]),
        "statement": str(row["statement"]),
        "evidence_refs": refs,
        "status": str(row["status"]),
        "user_edited": bool(row["user_edited"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }
    if course_name is not None:
        payload["course_name"] = course_name
    return payload


def list_course_memories(
    repository: SQLiteRepository,
    space_id: str,
    *,
    include_dismissed: bool = False,
) -> list[dict[str, Any]]:
    with repository.connection() as conn:
        _require_course(conn, space_id)
        kp_names = {
            str(row["id"]): str(row["name"])
            for row in conn.execute("SELECT id, name FROM knowledge_points WHERE space_id = ?", (space_id,))
        }
        status_clause = "" if include_dismissed else "AND status != 'dismissed'"
        rows = conn.execute(
            f"""SELECT * FROM memory_facts
                WHERE space_id = ? {status_clause}
                ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                         updated_at DESC, id DESC""",
            (space_id,),
        ).fetchall()
    return [_serialize_fact(row, kp_names=kp_names) for row in rows]


def update_course_memory(
    repository: SQLiteRepository,
    space_id: str,
    memory_id: str,
    *,
    statement: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    with repository.connection() as conn:
        _require_course(conn, space_id)
        row = conn.execute(
            "SELECT * FROM memory_facts WHERE id = ? AND space_id = ?",
            (memory_id, space_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Memory fact not found", code="memory_not_found")
        next_statement = str(row["statement"])
        user_edited = int(row["user_edited"])
        if statement is not None:
            cleaned = statement.strip()
            if not cleaned:
                raise CodedValueError("memory_statement_required", "Memory statement cannot be empty.")
            next_statement = cleaned[:160]
            user_edited = 1
        next_status = str(row["status"])
        if status is not None:
            if status not in _VALID_STATUSES:
                raise CodedValueError("memory_status_invalid", "Unsupported memory status.")
            next_status = status
        conn.execute(
            """UPDATE memory_facts SET statement = ?, status = ?, user_edited = ?, updated_at = ?
               WHERE id = ? AND space_id = ?""",
            (next_statement, next_status, user_edited, now, memory_id, space_id),
        )
        updated = conn.execute(
            "SELECT * FROM memory_facts WHERE id = ? AND space_id = ?",
            (memory_id, space_id),
        ).fetchone()
        kp_names = {
            str(kp["id"]): str(kp["name"])
            for kp in conn.execute("SELECT id, name FROM knowledge_points WHERE space_id = ?", (space_id,))
        }
    return _serialize_fact(updated, kp_names=kp_names)


async def distill_course_memories(
    repository: SQLiteRepository,
    gateway: Any,
    space_id: str,
) -> list[dict[str, Any]]:
    """Distill L2 course memory facts strictly grounded in real SQLite evidence/traces."""
    def _gather() -> dict[str, Any]:
        with repository.connection() as conn:
            _require_course(conn, space_id)
            ev_rows = conn.execute(
                """SELECT e.id, e.kp_id, kp.name AS kp_name, e.source, e.verdict, e.hint_level, e.created_at
                   FROM evidence e
                   LEFT JOIN knowledge_points kp ON kp.id = e.kp_id AND kp.space_id = e.space_id
                   WHERE e.space_id = ? ORDER BY e.created_at DESC LIMIT 24""",
                (space_id,),
            ).fetchall()
            trace_rows = conn.execute(
                """SELECT id, surface, kp_id, event_type, summary, created_at
                   FROM learning_traces WHERE space_id = ? ORDER BY created_at DESC LIMIT 20""",
                (space_id,),
            ).fetchall()
            gap_rows = conn.execute(
                """SELECT id, kp_id, text, count FROM misconceptions
                   WHERE space_id = ? AND resolved_at IS NULL ORDER BY count DESC LIMIT 10""",
                (space_id,),
            ).fetchall()
            lesson_rows = conn.execute(
                """SELECT id, recap_json FROM lessons
                   WHERE space_id = ? AND status = 'done' AND recap_json IS NOT NULL
                   ORDER BY ended_at DESC LIMIT 4""",
                (space_id,),
            ).fetchall()
            approaches = conn.execute("SELECT kind, n, success FROM approach_stats ORDER BY kind").fetchall()
            existing = conn.execute(
                "SELECT statement, status FROM memory_facts WHERE space_id = ?",
                (space_id,),
            ).fetchall()
        return {
            "evidence": [dict(row) for row in ev_rows],
            "traces": [dict(row) for row in trace_rows],
            "misconceptions": [dict(row) for row in gap_rows],
            "lessons": [
                {"id": str(row["id"]), "summary": json.loads(row["recap_json"]).get("summary", "")[:240]}
                for row in lesson_rows
            ],
            "approach_stats": [dict(row) for row in approaches],
            "existing_statements": [str(row["statement"]) for row in existing],
        }

    bundle = await asyncio.to_thread(_gather)
    if not (bundle["evidence"] or bundle["traces"] or bundle["misconceptions"] or bundle["lessons"]):
        return await asyncio.to_thread(list_course_memories, repository, space_id)

    try:
        candidates = await gateway.complete_tagged(
            "analysis",
            "analysis/memory_distill",
            {"memory_evidence": _json_block("course_evidence", bundle)},
            parse=_parse_distilled,
            cache=False,
            max_tokens=1024,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("memory_distill_failed", str(exc)) from None

    now = _now_iso()

    def _persist() -> list[dict[str, Any]]:
        with repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            valid_refs = _valid_ref_index(conn, space_id)
            valid_kps = {
                str(row["id"])
                for row in conn.execute("SELECT id FROM knowledge_points WHERE space_id = ?", (space_id,))
            }
            existing_norms = {
                str(row["statement"]).strip().casefold()
                for row in conn.execute("SELECT statement FROM memory_facts WHERE space_id = ?", (space_id,))
            }
            for item in candidates:
                verified_refs = [
                    ref for ref in item["evidence_refs"]
                    if ref["id"] in valid_refs.get(ref["kind"], set())
                ]
                # Enforce non-empty real evidence invariant
                if not verified_refs:
                    _LOG.info("memory_fact_dropped_missing_evidence")
                    continue
                norm = item["statement"].strip().casefold()
                if norm in existing_norms:
                    continue
                kp_id = item["kp_id"] if item["kp_id"] in valid_kps else None
                conn.execute(
                    """INSERT INTO memory_facts(
                           id, space_id, kp_id, kind, statement, evidence_refs_json,
                           status, user_edited, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)""",
                    (
                        f"mem_{uuid4().hex[:16]}",
                        space_id,
                        kp_id,
                        item["kind"],
                        item["statement"],
                        json.dumps(verified_refs, ensure_ascii=False),
                        now,
                        now,
                    ),
                )
                existing_norms.add(norm)
        return list_course_memories(repository, space_id)

    return await asyncio.to_thread(_persist)


def recall_course_memories(
    repository: SQLiteRepository,
    *,
    space_id: str,
    kp_id: str | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """Recall active/pinned L2 course memories for prompt injection (never dismissed)."""
    if limit <= 0:
        return []
    with repository.connection() as conn:
        rows = conn.execute(
            """SELECT id, kp_id, kind, statement, status FROM memory_facts
               WHERE space_id = ? AND status IN ('pinned', 'active')
               ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END,
                        CASE WHEN kp_id = ? THEN 0 ELSE 1 END,
                        updated_at DESC LIMIT ?""",
            (space_id, kp_id or "", limit),
        ).fetchall()
    return [dict(row) for row in rows]


def _load_synthesis_store(repository: SQLiteRepository) -> dict[str, Any]:
    raw = get_setting(repository, _SYNTHESIS_KEY, None)
    if isinstance(raw, dict) and isinstance(raw.get("notes"), list):
        return raw
    return {"notes": [], "updated_at": None}


def recall_global_memory_notes(repository: SQLiteRepository, *, limit: int = 2) -> list[str]:
    store = _load_synthesis_store(repository)
    active = [
        note for note in store["notes"]
        if isinstance(note, dict) and note.get("status", "active") in {"pinned", "active"} and note.get("statement")
    ]
    active.sort(key=lambda item: 0 if item.get("status") == "pinned" else 1)
    return [str(item["statement"]) for item in active[:limit]]


def get_memory_archive(repository: SQLiteRepository, *, include_dismissed: bool = False) -> dict[str, Any]:
    store = _load_synthesis_store(repository)
    with repository.connection() as conn:
        courses = {
            str(row["id"]): str(row["name"])
            for row in conn.execute("SELECT id, name FROM study_spaces")
        }
        kp_names = {
            (str(row["space_id"]), str(row["id"])): str(row["name"])
            for row in conn.execute("SELECT space_id, id, name FROM knowledge_points")
        }
        status_clause = "" if include_dismissed else "WHERE status != 'dismissed'"
        rows = conn.execute(
            f"""SELECT * FROM memory_facts {status_clause}
                ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                         updated_at DESC LIMIT 60""",
        ).fetchall()

    course_memories = [
        _serialize_fact(
            row,
            kp_names={str(row["kp_id"]): kp_names.get((str(row["space_id"]), str(row["kp_id"])), "")} if row["kp_id"] else {},
            course_name=courses.get(str(row["space_id"]), ""),
        )
        for row in rows
    ]
    notes = [
        note for note in store["notes"]
        if isinstance(note, dict) and (include_dismissed or note.get("status", "active") != "dismissed")
    ]
    return {
        "synthesis_notes": notes,
        "course_memories": course_memories,
        "total_active_facts": sum(1 for item in course_memories if item["status"] != "dismissed"),
        "updated_at": store.get("updated_at"),
    }


async def refresh_memory_archive(repository: SQLiteRepository, gateway: Any) -> dict[str, Any]:
    """Synthesize L3 cross-course habits grounded in active/pinned L2 course facts."""
    archive = await asyncio.to_thread(get_memory_archive, repository, include_dismissed=True)
    active_facts = [item for item in archive["course_memories"] if item["status"] in {"active", "pinned"}]
    if not active_facts:
        return await asyncio.to_thread(get_memory_archive, repository)

    try:
        generated = await gateway.complete_tagged(
            "analysis",
            "analysis/memory_synthesize",
            {
                "memory_evidence": _json_block("active_course_memories", [
                    {
                        "id": item["id"],
                        "course": item.get("course_name", ""),
                        "kind": item["kind"],
                        "statement": item["statement"],
                    }
                    for item in active_facts[:30]
                ]),
            },
            parse=_parse_synthesis,
            cache=False,
            max_tokens=1024,
        )
    except (LLMOutputError, ValueError) as exc:
        raise CodedValueError("memory_synthesis_failed", str(exc)) from None

    valid_ids = {item["id"] for item in active_facts}
    now = _now_iso()

    def _save() -> dict[str, Any]:
        store = _load_synthesis_store(repository)
        existing_notes = [n for n in store["notes"] if isinstance(n, dict)]
        preserved = [
            note for note in existing_notes
            if note.get("status") in {"pinned", "dismissed"} or note.get("user_edited")
        ]
        seen_norms = {str(note.get("statement") or "").strip().casefold() for note in preserved}
        merged = list(preserved)
        for cand in generated:
            cited = [mid for mid in cand["source_memory_ids"] if mid in valid_ids]
            if not cited:
                continue
            norm = cand["statement"].strip().casefold()
            if norm in seen_norms:
                continue
            merged.append({
                "id": f"syn_{uuid4().hex[:12]}",
                "statement": cand["statement"],
                "source_memory_ids": cited,
                "status": "active",
                "user_edited": False,
                "updated_at": now,
            })
            seen_norms.add(norm)
        put_setting(repository, _SYNTHESIS_KEY, {"notes": merged[:12], "updated_at": now})
        return get_memory_archive(repository)

    return await asyncio.to_thread(_save)


def update_global_memory_note(
    repository: SQLiteRepository,
    note_id: str,
    *,
    statement: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    store = _load_synthesis_store(repository)
    notes = [dict(note) for note in store["notes"] if isinstance(note, dict)]
    target = next((note for note in notes if note.get("id") == note_id), None)
    if target is None:
        raise ResourceNotFoundError("Global memory note not found", code="memory_not_found")
    if statement is not None:
        cleaned = statement.strip()
        if not cleaned:
            raise CodedValueError("memory_statement_required", "Memory statement cannot be empty.")
        target["statement"] = cleaned[:160]
        target["user_edited"] = True
    if status is not None:
        if status not in _VALID_STATUSES:
            raise CodedValueError("memory_status_invalid", "Unsupported memory status.")
        target["status"] = status
    target["updated_at"] = _now_iso()
    put_setting(repository, _SYNTHESIS_KEY, {"notes": notes, "updated_at": target["updated_at"]})
    return get_memory_archive(repository)


def build_compact_memory_summary(
    repository: SQLiteRepository,
    *,
    space_id: str,
    kp_id: str | None = None,
    max_chars: int = 150,
) -> list[str]:
    """Assemble <=150-char active/pinned memory snippets for Realizer injection."""
    course_hits = [item["statement"] for item in recall_course_memories(repository, space_id=space_id, kp_id=kp_id, limit=2)]
    global_hits = recall_global_memory_notes(repository, limit=1)
    combined: list[str] = []
    used = 0
    for text in (*course_hits, *global_hits):
        cleaned = text.strip()
        if not cleaned or cleaned in combined:
            continue
        if used + len(cleaned) > max_chars:
            remaining = max_chars - used
            if remaining >= 12:
                combined.append(cleaned[:remaining])
            break
        combined.append(cleaned)
        used += len(cleaned)
    return combined
