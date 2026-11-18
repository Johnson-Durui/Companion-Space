from __future__ import annotations

import json
from datetime import datetime, timezone

from app.analysis.indexing import pack_embedding
from app.analysis.retrieval import retrieve_for_kp
from app.models.domain import StudySpace
from app.services.repository import SQLiteRepository


def _seed(repository: SQLiteRepository, *, space_id: str, suffix: str = "") -> None:
    now = datetime.now(timezone.utc).isoformat()
    repository.upsert_space(
        StudySpace(
            id=space_id,
            name=f"Course {suffix}",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO materials
               (id, space_id, title, kind, filename, storage_path, chunk_count,
                created_at, updated_at, role, parse_status)
               VALUES (?, ?, 'Book', 'markdown', 'book.md', ?, 3, ?, ?, 'textbook', 'parsed')""",
            (f"material-{suffix}", space_id, f"spaces/{space_id}/materials/material-{suffix}.md", now, now),
        )
        conn.execute(
            """INSERT INTO knowledge_points
               (id, space_id, name, norm_name, kind, summary, importance, difficulty,
                ord, source_refs_json, status, created_at, updated_at)
               VALUES (?, ?, '条件概率', '条件概率', 'concept', '已知一个事件后更新另一个事件的概率',
                       'core', 2, 0, ?, 'active', ?, ?)""",
            (
                f"kp-{suffix}",
                space_id,
                json.dumps([{"material_id": f"material-{suffix}", "page_no": 2}]),
                now,
                now,
            ),
        )
        rows = (
            (f"direct-{suffix}", 2, "source page", pack_embedding([0.0, 1.0])),
            (f"search-{suffix}", 3, "条件概率描述已知事件发生后的概率更新。", pack_embedding([1.0, 0.0])),
            (f"dense-{suffix}", 4, "unrelated words", pack_embedding([1.0, 0.0])),
        )
        conn.executemany(
            """INSERT INTO chunks
               (id, space_id, material_id, title, locator, content, sparse_terms,
                dense_vector, metadata_json, created_at, section_id, page_no, embedding)
               VALUES (?, ?, ?, 'Book', ?, ?, '[]', '{}', '{}', ?, 'section', ?, ?)""",
            [
                (
                    chunk_id,
                    space_id,
                    f"material-{suffix}",
                    str(page_no),
                    content,
                    now,
                    page_no,
                    embedding,
                )
                for chunk_id, page_no, content, embedding in rows
            ],
        )


def test_retrieve_for_kp_prioritizes_sources_and_keeps_course_scope(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository, space_id="course-a", suffix="a")
    _seed(repository, space_id="course-b", suffix="b")

    hits = retrieve_for_kp(repository, space_id="course-a", kp_id="kp-a", k=3)

    assert hits[0].id == "direct-a"
    assert hits[0].source_ref
    assert any(hit.id == "search-a" for hit in hits)
    assert all(hit.material_id == "material-a" for hit in hits)


def test_retrieve_for_kp_can_add_dense_candidate(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository, space_id="course-a", suffix="a")

    hits = retrieve_for_kp(
        repository,
        space_id="course-a",
        kp_id="kp-a",
        k=3,
        query_embedding=pack_embedding([1.0, 0.0]),
    )

    assert hits[0].id == "direct-a"
    assert {hit.id for hit in hits[1:]} == {"search-a", "dense-a"}
