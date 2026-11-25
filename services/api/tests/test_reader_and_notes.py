from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.llm.gateway import LLMGateway
from app.main import create_app
from app.models.domain import StudySpace


def _seed_reader_course(repository, *, space_id: str, suffix: str) -> dict[str, str]:
    now = datetime.now(timezone.utc).isoformat()
    repository.upsert_space(
        StudySpace(
            id=space_id,
            name=f"Reader Course {suffix}",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    mat_id = f"mat-{suffix}"
    kp_id = f"kp-{suffix}"
    item_id = f"ib-{suffix}"
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO materials(
                   id, space_id, title, kind, filename, storage_path, chunk_count,
                   created_at, updated_at, role, parse_status
               ) VALUES (?, ?, 'Calculus Ch.1', 'pdf', 'calc.pdf', ?, 0, ?, ?, 'textbook', 'parsed')""",
            (mat_id, space_id, f"spaces/{space_id}/materials/{mat_id}.pdf", now, now),
        )
        conn.execute(
            """INSERT INTO material_sections(
                   id, space_id, material_id, parent_id, level, title, page_start, page_end, ord
               ) VALUES (?, ?, ?, NULL, 1, '1.1 Limits', 1, 2, 0)""",
            (f"sec-{suffix}", space_id, mat_id),
        )
        conn.executemany(
            """INSERT INTO material_pages(material_id, page_no, space_id, markdown, source, quality)
               VALUES (?, ?, ?, ?, 'text', 1.0)""",
            [
                (mat_id, 1, space_id, "Limit definition: $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$."),
                (mat_id, 2, space_id, "Continuity requires left limit equals right limit equals function value."),
            ],
        )
        conn.execute(
            """INSERT INTO knowledge_points(
                   id, space_id, name, norm_name, kind, summary, importance, difficulty,
                   ord, source_refs_json, status, created_at, updated_at
               ) VALUES (?, ?, 'First Important Limit', 'first important limit', 'theorem',
                         'sin(x)/x approaches 1', 'core', 2, 0, ?, 'active', ?, ?)""",
            (kp_id, space_id, json.dumps([{"material_id": mat_id, "page_no": 1}]), now, now),
        )
        conn.execute(
            """INSERT INTO kp_exam_stats(
                   kp_id, space_id, n_items, score_share, recency_weight, trend, types_json, weight, updated_at
               ) VALUES (?, ?, 4, 0.2, 1.0, 'rising', '{"choice":4}', 0.25, ?)""",
            (kp_id, space_id, now),
        )
        conn.execute(
            """INSERT INTO course_enrollment(space_id, enrollment_json, interview_status, placement_status, updated_at)
               VALUES (?, '{"self_level":"basic"}', 'done', 'done', ?)""",
            (space_id, now),
        )
        item_json = json.dumps(
            {
                "stem": "Evaluate $\\lim_{x \\to 0} \\frac{\\sin x}{x}$.",
                "options": [{"key": "A", "text": "0"}, {"key": "B", "text": "1"}],
                "answer": "B",
                "solution": "Standard first important limit equals 1.",
            },
            ensure_ascii=False,
        )
        conn.execute(
            """INSERT INTO item_bank(
                   id, space_id, kp_id, origin, purpose, type, difficulty, item_json,
                   verify_status, reserved, created_at
               ) VALUES (?, ?, ?, 'generated', 'practice', 'choice', 1, ?, 'verified', 0, ?)""",
            (item_id, space_id, kp_id, item_json, now),
        )
    return {"mat_id": mat_id, "kp_id": kp_id, "item_id": item_id}


def _auth_client(isolated_settings, gateway_factory):
    app = create_app(settings=isolated_settings, gateway_factory=gateway_factory)
    client = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000))
    boot = client.post("/api/v2/session/bootstrap", headers={"Origin": "http://127.0.0.1:8000"})
    assert boot.status_code == 200
    csrf = client.cookies.get("companion_csrf", "")
    client.headers.update({"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": csrf})
    container = app.dependency_overrides[get_container]()
    return client, container


class _ReaderNotesGateway(LLMGateway):
    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        if prompt_name == "analysis/reader_ask":
            payload = json.dumps(
                {
                    "explanation": "当 x 趋近 0 时，sin(x) 与 x 是等价无穷小，因此比值趋近 1。",
                    "key_takeaway": "第一重要极限：sin(x)/x → 1",
                    "block_type": "callout",
                    "block_content": "第一重要极限前提：x 必须使用弧度制且趋近于 0。",
                },
                ensure_ascii=False,
            )
            return parse(f"<answer>{payload}</answer>")
        if prompt_name == "analysis/note_suggest":
            payload = json.dumps(
                [
                    {
                        "reason": "补充常见易错条件：角度必须用弧度制。",
                        "block_type": "callout",
                        "title": "易错提醒：弧度制",
                        "content": "注意 $\\sin x / x \\to 1$ 仅在弧度制下成立。",
                    }
                ],
                ensure_ascii=False,
            )
            return parse(f"<suggestions>{payload}</suggestions>")
        raise AssertionError(f"Unexpected prompt: {prompt_name}")


def test_reader_overview_page_ask_and_quick_check_bkt(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, _ReaderNotesGateway)
    ids_a = _seed_reader_course(container.repository, space_id="course-read-a", suffix="ra")
    _seed_reader_course(container.repository, space_id="course-read-b", suffix="rb")

    overview = client.get(f"/api/v2/courses/course-read-a/materials/{ids_a['mat_id']}/reader")
    assert overview.status_code == 200
    ov = overview.json()
    assert ov["page_count"] == 2
    assert len(ov["sections"]) == 1
    assert ov["pages"][0]["kps"][0]["exam_count"] == 4

    # Cross-course isolation on reader
    cross = client.get(f"/api/v2/courses/course-read-b/materials/{ids_a['mat_id']}/reader")
    assert cross.status_code == 404
    assert cross.json()["code"] == "material_not_found"

    page = client.get(f"/api/v2/courses/course-read-a/materials/{ids_a['mat_id']}/pages/1/reader")
    assert page.status_code == 200
    pg = page.json()
    assert pg["section_title"] == "1.1 Limits"
    assert pg["quick_quiz"] is not None
    assert pg["quick_quiz"]["id"] == ids_a["item_id"]
    # Answer must NEVER leak before answering
    assert "answer" not in pg["quick_quiz"]
    assert "solution" not in pg["quick_quiz"]

    # Passage ask records an L1 learning_traces entry with surface='read'
    asked = client.post(
        f"/api/v2/courses/course-read-a/materials/{ids_a['mat_id']}/pages/1/ask",
        json={"passage": "sin(x)/x = 1", "question": "为什么等于 1？"},
    )
    assert asked.status_code == 200
    ask_body = asked.json()
    assert "等价无穷小" in ask_body["explanation"]
    assert ask_body["suggested_block"]["source_ref"]["page_no"] == 1

    with container.repository.connection() as conn:
        trace_row = conn.execute(
            "SELECT surface, kp_id FROM learning_traces WHERE space_id = 'course-read-a'",
        ).fetchone()
    assert trace_row is not None
    assert trace_row["surface"] == "read"
    assert trace_row["kp_id"] == ids_a["kp_id"]

    # Quick check wrong answer updates BKT down and creates mistake card
    wrong = client.post(
        f"/api/v2/courses/course-read-a/reader/quiz/{ids_a['item_id']}/answer",
        json={"answer": "A"},
    )
    assert wrong.status_code == 200
    w_body = wrong.json()
    assert w_body["verdict"] == "incorrect"
    assert w_body["p_after"] < w_body["p_before"]

    with container.repository.connection() as conn:
        wrong_cards = conn.execute(
            "SELECT COUNT(*) FROM review_cards WHERE space_id = 'course-read-a' AND item_ref = ?",
            (ids_a["item_id"],),
        ).fetchone()[0]
    assert wrong_cards == 1

    # Quick check correct answer updates BKT up
    right = client.post(
        f"/api/v2/courses/course-read-a/reader/quiz/{ids_a['item_id']}/answer",
        json={"answer": "B"},
    )
    assert right.status_code == 200
    r_body = right.json()
    assert r_body["verdict"] == "correct"
    assert r_body["p_after"] > r_body["p_before"]


def test_block_notes_quick_capture_readonly_diff_flashcard_and_export(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, _ReaderNotesGateway)
    ids_a = _seed_reader_course(container.repository, space_id="course-note-a", suffix="na")
    _seed_reader_course(container.repository, space_id="course-note-b", suffix="nb")

    # Quick capture creates default notebook and preserves source_ref
    quick = client.post(
        "/api/v2/courses/course-note-a/notes/quick/blocks",
        json={
            "block_type": "math",
            "title": "第一重要极限",
            "content": "\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1",
            "source_ref": {
                "kind": "material_page",
                "material_id": ids_a["mat_id"],
                "material_title": "Calculus Ch.1",
                "page_no": 1,
                "kp_id": ids_a["kp_id"],
            },
            "default_title": "随堂精选笔记",
        },
    )
    assert quick.status_code == 201
    note = quick.json()
    note_id = note["id"]
    block_id = note["blocks"][0]["id"]
    assert note["title"] == "随堂精选笔记"
    assert note["blocks"][0]["source_ref"]["page_no"] == 1

    # Cross-course isolation on notes
    cross_note = client.get(f"/api/v2/courses/course-note-b/notes/{note_id}")
    assert cross_note.status_code == 404
    assert cross_note.json()["code"] == "note_not_found"

    # Dito-style read-only Diff suggestions MUST NOT mutate note_blocks in SQLite
    suggested = client.post(f"/api/v2/courses/course-note-a/notes/{note_id}/suggest")
    assert suggested.status_code == 200
    sugs = suggested.json()
    assert len(sugs) == 1
    assert "弧度制" in sugs[0]["content"]

    after_suggest = client.get(f"/api/v2/courses/course-note-a/notes/{note_id}")
    assert len(after_suggest.json()["blocks"]) == 1

    # Convert block into FSRS flashcard
    card_res = client.post(
        f"/api/v2/courses/course-note-a/notes/{note_id}/blocks/{block_id}/flashcard",
        json={},
    )
    assert card_res.status_code == 201
    card_id = card_res.json()["card_id"]
    due = container.repository.due_review_cards(
        "course-note-a",
        due_at=datetime.now(timezone.utc).isoformat(),
    )
    assert any(card["id"] == card_id and card["kind"] == "flashcard" for card in due)

    # Export Markdown & Anki TSV
    md_res = client.get(f"/api/v2/courses/course-note-a/notes/{note_id}/export?format=md")
    assert md_res.status_code == 200
    assert "# 随堂精选笔记" in md_res.text
    assert "> Source: Calculus Ch.1 p.1" in md_res.text

    tsv_res = client.get(f"/api/v2/courses/course-note-a/notes/{note_id}/export?format=anki_tsv")
    assert tsv_res.status_code == 200
    parts = tsv_res.text.strip().split("\t")
    assert len(parts) == 3
    assert parts[0] == "第一重要极限"

    # Update & delete block, then delete note
    patched = client.patch(
        f"/api/v2/courses/course-note-a/notes/{note_id}/blocks/{block_id}",
        json={"title": "重要极限（已修订）"},
    )
    assert patched.status_code == 200
    assert patched.json()["blocks"][0]["title"] == "重要极限（已修订）"

    deleted_blk = client.delete(f"/api/v2/courses/course-note-a/notes/{note_id}/blocks/{block_id}")
    assert deleted_blk.status_code == 200
    assert deleted_blk.json()["blocks"] == []

    deleted_note = client.delete(f"/api/v2/courses/course-note-a/notes/{note_id}")
    assert deleted_note.status_code == 204


def test_reader_page_normalizes_dict_quiz_options(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, _ReaderNotesGateway)
    ids = _seed_reader_course(container.repository, space_id="course-dict-opt", suffix="do")
    dict_item_json = json.dumps(
        {
            "stem": "Which value equals $\\lim_{x \\to 0} \\frac{\\sin x}{x}$?",
            "options": {"A": "0", "B": "1", "C": "2"},
            "answer": "B",
            "solution": "The first important limit equals 1.",
        },
        ensure_ascii=False,
    )
    with container.repository.connection() as conn:
        conn.execute(
            "UPDATE item_bank SET item_json = ? WHERE id = ?",
            (dict_item_json, ids["item_id"]),
        )

    page = client.get(f"/api/v2/courses/course-dict-opt/materials/{ids['mat_id']}/pages/1/reader")
    assert page.status_code == 200
    quiz = page.json()["quick_quiz"]
    assert quiz is not None
    assert quiz["options"] == [
        {"key": "A", "text": "0"},
        {"key": "B", "text": "1"},
        {"key": "C", "text": "2"},
    ]

    ans = client.post(
        f"/api/v2/courses/course-dict-opt/reader/quiz/{ids['item_id']}/answer",
        json={"answer": "B"},
    )
    assert ans.status_code == 200
    assert ans.json()["verdict"] == "correct"
