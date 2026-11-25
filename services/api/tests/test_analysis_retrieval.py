from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from app.analysis.indexing import pack_embedding
from app.analysis.retrieval import retrieve_for_kp, retrieve_structured_pages, retrieve_with_structure
from app.models.domain import StudySpace
from app.services.repository import SQLiteRepository
from app.teaching.runtime import LessonRuntime


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


def _seed_structured(repository: SQLiteRepository, *, space_id: str, suffix: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    repository.upsert_space(
        StudySpace(
            id=space_id,
            name=f"Structured {suffix}",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    material_id = f"mat-{suffix}"
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO materials
               (id, space_id, title, kind, filename, storage_path, chunk_count,
                created_at, updated_at, role, parse_status)
               VALUES (?, ?, 'Calculus', 'pdf', 'calc.pdf', ?, 0, ?, ?, 'textbook', 'parsed')""",
            (material_id, space_id, f"spaces/{space_id}/materials/{material_id}.pdf", now, now),
        )
        conn.executemany(
            """INSERT INTO material_sections
               (id, material_id, space_id, parent_id, level, title, page_start, page_end, ord)
               VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?)""",
            [
                (f"sec-1-{suffix}", material_id, space_id, "第一章 函数与极限定义", 1, 3, 0),
                (f"sec-5-{suffix}", material_id, space_id, "第五章 夹逼准则与收敛证明", 10, 12, 1),
                (f"sec-8-{suffix}", material_id, space_id, "第八章 边界反例汇总", 20, 21, 2),
            ],
        )
        conn.executemany(
            """INSERT INTO material_pages
               (material_id, page_no, space_id, markdown, source, quality, image_path)
               VALUES (?, ?, ?, ?, 'text', 1.0, ?)""",
            [
                (
                    material_id,
                    2,
                    space_id,
                    f"第2页正文({suffix})：极限的严格 epsilon-delta 定义要求在去心邻域内成立。",
                    f"spaces/{space_id}/pages/p2.jpg",
                ),
                (
                    material_id,
                    10,
                    space_id,
                    f"第10页正文({suffix})：夹逼准则要求左右两侧函数在同一极限点收敛到相同值。",
                    None,
                ),
                (
                    material_id,
                    20,
                    space_id,
                    f"第20页正文({suffix})：振荡函数 sin(1/x) 在零点附近不存在极限。",
                    f"spaces/{space_id}/pages/p20.jpg",
                ),
            ],
        )
        conn.executemany(
            """INSERT INTO knowledge_points
               (id, space_id, name, norm_name, kind, summary, importance, difficulty,
                ord, source_refs_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'concept', ?, 'core', 2, ?, ?, 'active', ?, ?)""",
            [
                (
                    f"kp-limit-{suffix}",
                    space_id,
                    "函数极限定义",
                    "函数极限定义",
                    "描述自变量趋近某点时函数值的收敛行为",
                    0,
                    json.dumps([{"material_id": material_id, "page_no": 2}]),
                    now,
                    now,
                ),
                (
                    f"kp-squeeze-{suffix}",
                    space_id,
                    "夹逼准则",
                    "夹逼准则",
                    "利用上下界函数共同极限夹出中间函数极限",
                    1,
                    json.dumps([{"material_id": material_id, "page_no": 10}]),
                    now,
                    now,
                ),
            ],
        )
        conn.execute(
            """INSERT INTO kp_edges (space_id, from_kp, to_kp, source)
               VALUES (?, ?, ?, 'analysis')""",
            (space_id, f"kp-limit-{suffix}", f"kp-squeeze-{suffix}"),
        )


def test_retrieve_structured_pages_follows_kp_graph_and_section_tree(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed_structured(repository, space_id="course-a", suffix="a")
    _seed_structured(repository, space_id="course-b", suffix="b")

    pages = retrieve_structured_pages(
        repository,
        space_id="course-a",
        query="第五章怎么用到了函数极限定义？",
        active_kp_id="kp-squeeze-a",
        max_pages=3,
    )

    assert pages
    assert all(page.material_id == "mat-a" for page in pages)
    by_page = {page.page_no: page for page in pages}
    assert 2 in by_page
    assert by_page[2].has_image is True
    assert by_page[2].section_title == "第一章 函数与极限定义"
    assert "epsilon-delta" in by_page[2].markdown
    assert by_page[2].source in {"graph_neighbor", "section_match"}


def test_retrieve_with_structure_routes_via_toc_and_blocks_cross_course_pages(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed_structured(repository, space_id="course-a", suffix="a")
    _seed_structured(repository, space_id="course-b", suffix="b")

    class _StubGateway:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, dict]] = []

        async def complete_tagged(self, role, template, variables, *, parse, **options):
            self.calls.append((role, template, variables))
            raw = (
                '<pages>['
                '{"material_id":"mat-b","page_no":20},'
                '{"material_id":"mat-a","page_no":999},'
                '{"material_id":"mat-a","page_no":20}'
                ']</pages>'
            )
            return parse(raw)

    gateway = _StubGateway()

    # Query has no direct chunk/section/neighbor overlap -> invokes TOC router
    routed = asyncio.run(
        retrieve_with_structure(
            repository,
            gateway,
            space_id="course-a",
            query="为什么某个函数在零附近剧烈震荡就不收敛？",
            active_kp_id="kp-squeeze-a",
            max_pages=3,
        )
    )
    assert len(gateway.calls) == 1
    assert gateway.calls[0][1] == "analysis/toc_route"
    assert all(page.material_id == "mat-a" for page in routed)
    assert any(page.page_no == 20 and page.source == "toc_reasoned" and page.has_image for page in routed)
    assert all(page.page_no != 999 for page in routed)

    # Strong local section match -> does NOT invoke TOC router again
    direct = asyncio.run(
        retrieve_with_structure(
            repository,
            gateway,
            space_id="course-a",
            query="边界反例汇总有哪些？",
            active_kp_id="kp-squeeze-a",
            max_pages=2,
        )
    )
    assert len(gateway.calls) == 1
    assert any(page.page_no == 20 for page in direct)


def test_runtime_answer_question_injects_structured_full_page_sources(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed_structured(repository, space_id="course-a", suffix="a")
    now = datetime.now(timezone.utc).isoformat()
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO study_plans(id, space_id, version, status, created_at)
               VALUES ('plan-1', 'course-a', 1, 'active', ?)""",
            (now,),
        )
        conn.execute(
            """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes, status)
               VALUES ('pi-1', 'plan-1', 'course-a', 1, 'lesson', 'Squeeze', '["kp-squeeze-a"]', 20, 'todo')""",
        )
    plan = {
        "title": "Squeeze Theorem",
        "segments": [{
            "id": "s1",
            "kp_id": "kp-squeeze-a",
            "keypoints": ["Bound from both sides"],
            "checks": [],
            "approaches": [{"kind": "intuition", "keypoint": "all", "outline": "Sandwich idea"}],
            "sources": [{"material_id": "mat-a", "page_start": 10, "page_end": 10}],
        }],
        "items": {},
    }
    repository.save_lesson_plan("course-a", "pi-1", plan=plan)
    repository.upsert_course_enrollment("course-a", {})
    lesson = repository.create_or_resume_lesson("course-a", "pi-1", state={"stage": "teaching", "seg_idx": 0})

    class _CaptureGateway:
        def __init__(self) -> None:
            self.prompts: list[str] = []

        async def stream_text(self, role, system, messages, **options):
            self.prompts.append(messages[0].content)
            yield "<say>Good question, check page two.</say>"

    gateway = _CaptureGateway()
    runtime = LessonRuntime(repository, gateway, "course-a", lesson["id"])
    asyncio.run(
        runtime.step({
            "type": "student_utterance",
            "intent": "question",
            "text": "这和第一章的函数极限定义有什么关系？",
        })
    )

    assert len(gateway.prompts) == 1
    assert "epsilon-delta" in gateway.prompts[0]
    assert "第一章 函数与极限定义" in gateway.prompts[0]
    assert '"has_image": true' in gateway.prompts[0]
