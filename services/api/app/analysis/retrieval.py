from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.analysis.indexing import cosine_similarity
from app.core.errors import ResourceNotFoundError
from app.services.repository import SQLiteRepository


_QUERY_PART = re.compile(r"[A-Za-z0-9_]{3,}|[\u4e00-\u9fff]{3,}")


@dataclass(frozen=True, slots=True)
class RetrievedChunk:
    id: str
    material_id: str
    page_no: int | None
    content: str
    score: float
    source_ref: bool


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
