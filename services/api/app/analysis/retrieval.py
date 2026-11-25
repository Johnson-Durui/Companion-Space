from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from app.analysis.indexing import cosine_similarity
from app.core.errors import ResourceNotFoundError
from app.llm.errors import LLMOutputError
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.providers.errors import ProviderError
from app.services.repository import SQLiteRepository


_LOG = logging.getLogger(__name__)
_QUERY_PART = re.compile(r"[A-Za-z0-9_]{3,}|[\u4e00-\u9fff]{3,}")
_ASCII_TOKEN = re.compile(r"[a-z0-9_]{2,}")
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
_QUERY_MATCH_SOURCES = frozenset({"graph_neighbor", "kp_match", "section_match", "chunk_match"})


@dataclass(frozen=True, slots=True)
class RetrievedChunk:
    id: str
    material_id: str
    page_no: int | None
    content: str
    score: float
    source_ref: bool


@dataclass(frozen=True, slots=True)
class PageContext:
    material_id: str
    page_no: int
    section_title: str | None
    markdown: str
    has_image: bool
    source: str
    kp_ids: tuple[str, ...] = ()


def retrieve_for_kp(
    repository: SQLiteRepository,
    *,
    space_id: str,
    kp_id: str,
    k: int = 6,
    query_embedding: bytes | None = None,
) -> tuple[RetrievedChunk, ...]:
    if k <= 0:
        return ()
    with repository.connection() as conn:
        point = conn.execute(
            """SELECT name, summary, source_refs_json FROM knowledge_points
               WHERE id = ? AND space_id = ? AND status = 'active'""",
            (kp_id, space_id),
        ).fetchone()
        if point is None:
            raise ResourceNotFoundError("Knowledge point not found")

        source_refs = _source_refs(point["source_refs_json"])
        direct = _direct_chunks(conn, space_id, source_refs)
        direct_ids = {row["id"] for row in direct}
        query = f"{point['name']} {point['summary']}".strip()
        candidates = _search_chunks(conn, space_id, query, max(k * 4, 16))
        if query_embedding is not None:
            dense_rows = conn.execute(
                """SELECT id, material_id, page_no, content, embedding FROM chunks
                   WHERE space_id = ? AND embedding IS NOT NULL""",
                (space_id,),
            ).fetchall()
            candidates = _merge_rows(candidates, dense_rows)

    results = [
        RetrievedChunk(
            id=row["id"],
            material_id=row["material_id"],
            page_no=row["page_no"],
            content=row["content"],
            score=2.0 - index / max(len(direct), 1),
            source_ref=True,
        )
        for index, row in enumerate(direct)
    ]
    supplemental = _rank_candidates(
        candidates,
        excluded=direct_ids,
        query_embedding=query_embedding,
    )
    results.extend(supplemental[: max(0, k - len(results))])
    return tuple(results[:k])


def _source_refs(raw: str | None) -> list[tuple[str, int]]:
    try:
        values = json.loads(raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    refs: list[tuple[str, int]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        material_id = value.get("material_id")
        page_no = value.get("page_no")
        if isinstance(material_id, str) and isinstance(page_no, int):
            refs.append((material_id, page_no))
    return list(dict.fromkeys(refs))


def _direct_chunks(conn, space_id: str, refs: list[tuple[str, int]]):
    if not refs:
        return []
    clauses = " OR ".join("(material_id = ? AND page_no = ?)" for _ in refs)
    parameters = [space_id, *(part for ref in refs for part in ref)]
    rows = conn.execute(
        f"""SELECT id, material_id, page_no, content, embedding FROM chunks
            WHERE space_id = ? AND ({clauses}) ORDER BY page_no, created_at, id""",
        parameters,
    ).fetchall()
    order = {ref: index for index, ref in enumerate(refs)}
    return sorted(
        rows,
        key=lambda row: (order.get((row["material_id"], row["page_no"]), len(order)), row["id"]),
    )


def _search_chunks(conn, space_id: str, query: str, limit: int):
    parts = list(dict.fromkeys(_QUERY_PART.findall(query.lower())))[:12]
    if parts:
        fts_query = " OR ".join(f'"{part.replace(chr(34), chr(34) * 2)}"' for part in parts)
        return conn.execute(
            """SELECT c.id, c.material_id, c.page_no, c.content, c.embedding,
                      bm25(chunks_fts) AS sparse_rank
               FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
               WHERE chunks_fts.space_id = ? AND chunks_fts MATCH ? AND c.space_id = ?
               ORDER BY sparse_rank, c.created_at, c.id LIMIT ?""",
            (space_id, fts_query, space_id, limit),
        ).fetchall()

    compact = query.strip()
    if not compact:
        return []
    escaped = compact.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return conn.execute(
        """SELECT id, material_id, page_no, content, embedding, 0 AS sparse_rank
           FROM chunks WHERE space_id = ? AND content LIKE ? ESCAPE '\\'
           ORDER BY created_at, id LIMIT ?""",
        (space_id, f"%{escaped}%", limit),
    ).fetchall()


def _merge_rows(first, second):
    return list({row["id"]: row for row in [*first, *second]}.values())


def _rank_candidates(
    rows,
    *,
    excluded: set[str],
    query_embedding: bytes | None,
) -> list[RetrievedChunk]:
    ranked: list[RetrievedChunk] = []
    for sparse_position, row in enumerate(rows):
        if row["id"] in excluded:
            continue
        sparse_score = 1 / (1 + sparse_position)
        dense_score = 0.0
        if query_embedding is not None and row["embedding"] is not None:
            dense_score = max(0.0, cosine_similarity(query_embedding, row["embedding"]))
        score = 0.65 * sparse_score + 0.35 * dense_score
        ranked.append(
            RetrievedChunk(
                id=row["id"],
                material_id=row["material_id"],
                page_no=row["page_no"],
                content=row["content"],
                score=score,
                source_ref=False,
            )
        )
    ranked.sort(key=lambda item: (-item.score, item.id))
    return ranked


def _query_tokens(text: str) -> set[str]:
    lowered = text.lower()
    tokens: set[str] = set(_ASCII_TOKEN.findall(lowered))
    for run in _CJK_RUN.findall(lowered):
        if len(run) == 2:
            tokens.add(run)
        else:
            for index in range(len(run) - 1):
                tokens.add(run[index : index + 2])
    return tokens


def _token_overlap(query_tokens: set[str], target_text: str) -> tuple[int, float]:
    target_tokens = _query_tokens(target_text)
    if not query_tokens or not target_tokens:
        return 0, 0.0
    hits = len(query_tokens & target_tokens)
    return hits, hits / len(target_tokens)


def _record_candidate(
    candidates: dict[tuple[str, int], tuple[float, str, set[str]]],
    ref: tuple[str, int],
    *,
    score: float,
    source: str,
    kp_id: str | None = None,
) -> None:
    existing = candidates.get(ref)
    if existing is None:
        candidates[ref] = (score, source, {kp_id} if kp_id else set())
        return
    prev_score, prev_source, prev_kps = existing
    merged_kps = set(prev_kps)
    if kp_id:
        merged_kps.add(kp_id)
    if score > prev_score:
        candidates[ref] = (score, source, merged_kps)
    else:
        candidates[ref] = (prev_score, prev_source, merged_kps)


def _hydrate_pages(
    conn,
    space_id: str,
    ordered_refs: list[tuple[tuple[str, int], str, tuple[str, ...]]],
    *,
    max_pages: int,
    require_material_page: bool = False,
) -> tuple[PageContext, ...]:
    results: list[PageContext] = []
    seen: set[tuple[str, int]] = set()
    for (material_id, page_no), source, kp_ids in ordered_refs:
        if len(results) >= max_pages:
            break
        if (material_id, page_no) in seen:
            continue
        page_row = conn.execute(
            """SELECT markdown, image_path FROM material_pages
               WHERE space_id = ? AND material_id = ? AND page_no = ?""",
            (space_id, material_id, page_no),
        ).fetchone()
        if page_row is not None:
            markdown = str(page_row["markdown"] or "").strip()
            has_image = bool(page_row["image_path"])
        elif not require_material_page:
            chunk_rows = conn.execute(
                """SELECT content FROM chunks
                   WHERE space_id = ? AND material_id = ? AND page_no = ?
                   ORDER BY created_at, id""",
                (space_id, material_id, page_no),
            ).fetchall()
            markdown = "\n\n".join(str(row["content"] or "").strip() for row in chunk_rows if row["content"]).strip()
            has_image = False
        else:
            continue
        if not markdown:
            continue
        section_row = conn.execute(
            """SELECT title FROM material_sections
               WHERE space_id = ? AND material_id = ?
                 AND page_start IS NOT NULL AND page_start <= ?
                 AND (page_end IS NULL OR page_end >= ?)
               ORDER BY level DESC, page_start DESC, ord DESC LIMIT 1""",
            (space_id, material_id, page_no, page_no),
        ).fetchone()
        seen.add((material_id, page_no))
        results.append(
            PageContext(
                material_id=material_id,
                page_no=page_no,
                section_title=str(section_row["title"]) if section_row and section_row["title"] else None,
                markdown=markdown,
                has_image=has_image,
                source=source,
                kp_ids=kp_ids,
            )
        )
    return tuple(results)


def retrieve_structured_pages(
    repository: SQLiteRepository,
    *,
    space_id: str,
    query: str,
    active_kp_id: str | None = None,
    max_pages: int = 3,
) -> tuple[PageContext, ...]:
    """Retrieve full source pages using KP graph neighbors, section tree titles, and FTS."""
    if max_pages <= 0:
        return ()
    cleaned = query.strip()
    lowered_query = cleaned.lower()
    tokens = _query_tokens(cleaned)
    candidates: dict[tuple[str, int], tuple[float, str, set[str]]] = {}

    with repository.connection() as conn:
        neighbor_ids: set[str] = set()
        if active_kp_id:
            edge_rows = conn.execute(
                """SELECT from_kp, to_kp FROM kp_edges
                   WHERE space_id = ? AND (from_kp = ? OR to_kp = ?)""",
                (space_id, active_kp_id, active_kp_id),
            ).fetchall()
            for row in edge_rows:
                if row["from_kp"] != active_kp_id:
                    neighbor_ids.add(str(row["from_kp"]))
                if row["to_kp"] != active_kp_id:
                    neighbor_ids.add(str(row["to_kp"]))

        kp_rows = conn.execute(
            """SELECT id, name, summary, source_refs_json FROM knowledge_points
               WHERE space_id = ? AND status = 'active'""",
            (space_id,),
        ).fetchall()
        for row in kp_rows:
            kp_id = str(row["id"])
            refs = _source_refs(row["source_refs_json"])
            if not refs:
                continue
            name = str(row["name"] or "")
            summary = str(row["summary"] or "")
            exact_name = len(name.strip()) >= 2 and name.strip().lower() in lowered_query
            name_hits, name_ratio = _token_overlap(tokens, name)
            hits, ratio = _token_overlap(tokens, f"{name} {summary}")
            strong_neighbor = exact_name or (name_hits >= 2 and name_ratio >= 0.4) or (hits >= 3 and ratio >= 0.25)
            if kp_id in neighbor_ids and strong_neighbor:
                score = 3.2 + (0.6 if exact_name else 0.0) + max(name_ratio, ratio)
                for ref in refs:
                    _record_candidate(candidates, ref, score=score, source="graph_neighbor", kp_id=kp_id)
            elif kp_id == active_kp_id:
                for ref in refs:
                    _record_candidate(candidates, ref, score=0.5, source="direct_kp", kp_id=kp_id)
            elif exact_name or (name_hits >= 2 and name_ratio >= 0.5) or (hits >= 3 and ratio >= 0.4):
                score = 2.6 + (0.5 if exact_name else 0.0) + max(name_ratio, ratio)
                for ref in refs:
                    _record_candidate(candidates, ref, score=score, source="kp_match", kp_id=kp_id)

        section_rows = conn.execute(
            """SELECT material_id, title, page_start, page_end FROM material_sections
               WHERE space_id = ? AND page_start IS NOT NULL
               ORDER BY material_id, ord""",
            (space_id,),
        ).fetchall()
        for row in section_rows:
            title = str(row["title"] or "")
            hits, ratio = _token_overlap(tokens, title)
            if hits < 2 and ratio < 0.5:
                continue
            if hits < 1 or ratio < 0.25:
                continue
            page_start = int(row["page_start"])
            page_end = int(row["page_end"]) if row["page_end"] is not None else page_start
            page_rows = conn.execute(
                """SELECT page_no FROM material_pages
                   WHERE space_id = ? AND material_id = ? AND page_no >= ? AND page_no <= ?
                   ORDER BY page_no LIMIT 3""",
                (space_id, row["material_id"], page_start, page_end),
            ).fetchall()
            score = 2.4 + ratio + min(hits, 4) * 0.08
            for page_row in page_rows:
                _record_candidate(
                    candidates,
                    (str(row["material_id"]), int(page_row["page_no"])),
                    score=score,
                    source="section_match",
                )

        if cleaned:
            chunk_rows = _search_chunks(conn, space_id, cleaned, max(max_pages * 4, 12))
            for rank, row in enumerate(chunk_rows):
                if row["page_no"] is None:
                    continue
                _record_candidate(
                    candidates,
                    (str(row["material_id"]), int(row["page_no"])),
                    score=1.8 / (1 + rank),
                    source="chunk_match",
                )

        ordered = [
            (ref, source, tuple(sorted(kps)))
            for ref, (_, source, kps) in sorted(
                candidates.items(),
                key=lambda item: (-item[1][0], item[0][0], item[0][1]),
            )
        ]
        return _hydrate_pages(conn, space_id, ordered, max_pages=max_pages)


def _load_toc_index(repository: SQLiteRepository, space_id: str) -> dict[str, Any] | None:
    with repository.connection() as conn:
        sections = conn.execute(
            """SELECT material_id, level, title, page_start, page_end FROM material_sections
               WHERE space_id = ? ORDER BY material_id, ord LIMIT 60""",
            (space_id,),
        ).fetchall()
        pages = conn.execute(
            """SELECT material_id, page_no FROM material_pages
               WHERE space_id = ? ORDER BY material_id, page_no LIMIT 200""",
            (space_id,),
        ).fetchall()
        if not pages:
            return None
        kps = conn.execute(
            """SELECT id, name, summary, source_refs_json FROM knowledge_points
               WHERE space_id = ? AND status = 'active' ORDER BY ord LIMIT 40""",
            (space_id,),
        ).fetchall()
    return {
        "sections": [
            {
                "material_id": str(row["material_id"]),
                "level": int(row["level"]),
                "title": str(row["title"]),
                "page_start": row["page_start"],
                "page_end": row["page_end"],
            }
            for row in sections
        ],
        "available_pages": [
            {"material_id": str(row["material_id"]), "page_no": int(row["page_no"])}
            for row in pages
        ],
        "knowledge_points": [
            {
                "id": str(row["id"]),
                "name": str(row["name"]),
                "summary": str(row["summary"] or "")[:120],
                "pages": [
                    {"material_id": mid, "page_no": pno}
                    for mid, pno in _source_refs(row["source_refs_json"])[:3]
                ],
            }
            for row in kps
        ],
    }


def _parse_toc_route(raw: str) -> list[tuple[str, int]]:
    roots = [node for node in parse_blocks(raw) if node.tag == "pages"]
    if len(roots) != 1 or roots[0].children:
        raise ValueError("Expected one plain pages JSON block.")
    parsed = json.loads(roots[0].text)
    if not isinstance(parsed, list):
        raise ValueError("Routed pages must be a JSON array.")
    refs: list[tuple[str, int]] = []
    for entry in parsed[:5]:
        if not isinstance(entry, dict):
            continue
        material_id = entry.get("material_id")
        page_no = entry.get("page_no")
        if isinstance(material_id, str) and type(page_no) is int and page_no >= 1:
            refs.append((material_id, page_no))
    return list(dict.fromkeys(refs))


def _hydrate_routed_pages(
    repository: SQLiteRepository,
    space_id: str,
    refs: list[tuple[str, int]],
    *,
    max_pages: int,
) -> tuple[PageContext, ...]:
    with repository.connection() as conn:
        ordered = [(ref, "toc_reasoned", ()) for ref in refs]
        return _hydrate_pages(conn, space_id, ordered, max_pages=max_pages, require_material_page=True)


async def retrieve_with_structure(
    repository: SQLiteRepository,
    gateway: Any,
    *,
    space_id: str,
    query: str,
    active_kp_id: str | None = None,
    max_pages: int = 3,
) -> tuple[PageContext, ...]:
    """Two-stage PageIndex-style retrieval: local graph/TOC/FTS first, then optional TOC routing."""
    local = await asyncio.to_thread(
        retrieve_structured_pages,
        repository,
        space_id=space_id,
        query=query,
        active_kp_id=active_kp_id,
        max_pages=max_pages,
    )
    if (
        not query.strip()
        or gateway is None
        or not hasattr(gateway, "complete_tagged")
        or any(page.source in _QUERY_MATCH_SOURCES for page in local)
    ):
        return local

    toc = await asyncio.to_thread(_load_toc_index, repository, space_id)
    if toc is None or not toc["sections"]:
        return local

    try:
        routed_refs = await gateway.complete_tagged(
            "live",
            "analysis/toc_route",
            {
                "course_context": data_block("toc", json.dumps(toc, ensure_ascii=False, separators=(",", ":"))),
                "student_question": data_block("question", query.strip()[:500]),
            },
            parse=_parse_toc_route,
            cache=True,
            max_tokens=256,
        )
    except (ValueError, KeyError, TypeError, ProviderError, LLMOutputError) as exc:
        _LOG.warning("structured_retrieval_toc_fallback=%s", type(exc).__name__)
        return local

    routed = await asyncio.to_thread(_hydrate_routed_pages, repository, space_id, routed_refs, max_pages=max_pages)
    if not routed:
        return local

    merged: list[PageContext] = list(routed)
    seen = {(page.material_id, page.page_no) for page in routed}
    for page in local:
        if len(merged) >= max_pages:
            break
        if (page.material_id, page.page_no) not in seen:
            merged.append(page)
            seen.add((page.material_id, page.page_no))
    return tuple(merged[:max_pages])
