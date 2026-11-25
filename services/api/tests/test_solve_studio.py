from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.api.deps import get_container
from app.llm.gateway import LLMGateway
from app.main import create_app
from app.models.domain import StudySpace


def _seed_course(repository, *, space_id: str, suffix: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    repository.upsert_space(
        StudySpace(
            id=space_id,
            name=f"Course {suffix}",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    mat_id = f"mat-{suffix}"
    exam_pub_mat = f"mat-exam-pub-{suffix}"
    exam_res_mat = f"mat-exam-res-{suffix}"
    kp_id = f"kp-{suffix}"
    with repository.connection() as conn:
        conn.executemany(
            """INSERT INTO materials(
                   id, space_id, title, kind, filename, storage_path, chunk_count,
                   created_at, updated_at, role, parse_status
               ) VALUES (?, ?, ?, 'pdf', ?, ?, 0, ?, ?, ?, 'parsed')""",
            [
                (mat_id, space_id, "Book", "book.pdf", f"spaces/{space_id}/materials/{mat_id}.pdf", now, now, "textbook"),
                (exam_pub_mat, space_id, "2024 Exam", "exam24.pdf", f"spaces/{space_id}/materials/{exam_pub_mat}.pdf", now, now, "exam"),
                (exam_res_mat, space_id, "2025 Exam", "exam25.pdf", f"spaces/{space_id}/materials/{exam_res_mat}.pdf", now, now, "exam"),
            ],
        )
        conn.execute(
            """INSERT INTO material_pages(material_id, page_no, space_id, markdown, source, quality)
               VALUES (?, 1, ?, 'Linear equations isolate the unknown step by step.', 'text', 1.0)""",
            (mat_id, space_id),
        )
        conn.execute(
            """INSERT INTO knowledge_points(
                   id, space_id, name, norm_name, kind, summary, importance, difficulty,
                   ord, source_refs_json, status, created_at, updated_at
               ) VALUES (?, ?, 'Linear Equation', 'linear equation', 'method', 'Isolate x cleanly',
                         'core', 1, 0, ?, 'active', ?, ?)""",
            (kp_id, space_id, json.dumps([{"material_id": mat_id, "page_no": 1}]), now, now),
        )
        conn.execute(
            """INSERT INTO exam_papers(id, space_id, material_id, name, year, full_score, reserved_for_mock)
               VALUES (?, ?, ?, '2024 Exam', 2024, 100, 0)""",
            (f"paper-pub-{suffix}", space_id, exam_pub_mat),
        )
        conn.execute(
            """INSERT INTO exam_papers(id, space_id, material_id, name, year, full_score, reserved_for_mock)
               VALUES (?, ?, ?, '2025 Reserved', 2025, 100, 1)""",
            (f"paper-res-{suffix}", space_id, exam_res_mat),
        )
        conn.execute(
            """INSERT INTO exam_items(
                   id, space_id, paper_id, material_id, type, stem, answer, answer_status, created_at
               ) VALUES (?, ?, ?, ?, 'numeric', 'PUBLIC_STYLE_EXEMPLAR solve 2x = 12', '6', 'official_verified', ?)""",
            (f"ei-pub-{suffix}", space_id, f"paper-pub-{suffix}", exam_pub_mat, now),
        )
        conn.execute(
            """INSERT INTO exam_items(
                   id, space_id, paper_id, material_id, type, stem, answer, answer_status, created_at
               ) VALUES (?, ?, ?, ?, 'numeric', 'SECRET_RESERVED_EXAM_ITEM', '99', 'official_verified', ?)""",
            (f"ei-res-{suffix}", space_id, f"paper-res-{suffix}", exam_res_mat, now),
        )
        conn.executemany(
            "INSERT INTO item_kp(item_id, kp_id, confidence) VALUES (?, ?, 'high')",
            [(f"ei-pub-{suffix}", kp_id), (f"ei-res-{suffix}", kp_id)],
        )
        conn.execute(
            """INSERT INTO course_enrollment(space_id, enrollment_json, interview_status, placement_status, updated_at)
               VALUES (?, '{"self_level":"basic"}', 'done', 'done', ?)""",
            (space_id, now),
        )


def _auth_client(isolated_settings, gateway_factory):
    app = create_app(settings=isolated_settings, gateway_factory=gateway_factory)
    client = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000))
    boot = client.post("/api/v2/session/bootstrap", headers={"Origin": "http://127.0.0.1:8000"})
    assert boot.status_code == 200
    csrf = client.cookies.get("companion_csrf", "")
    client.headers.update({"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": csrf})
    container = app.dependency_overrides[get_container]()
    return client, container


def _visible_content_json(body: dict) -> str:
    return json.dumps({
        key: body.get(key)
        for key in ("approach_prompt", "key_formula", "hints", "steps", "pitfalls", "verified_answer")
    } | {
        "turn_texts": [turn.get("text") for turn in (body.get("turns") or [])],
    }, ensure_ascii=False)


class _SolveStudioGateway(LLMGateway):
    def __init__(self, registry, *, mode: str = "verified") -> None:
        super().__init__(registry)
        self.mode = mode
        self.calls: list[tuple[str, str, dict]] = []

    async def transcribe_page(self, image_bytes: bytes, *, mime: str = "image/jpeg", cache: bool = False) -> str:
        self.calls.append(("vision", "transcribe_page", {"size": len(image_bytes), "mime": mime}))
        return "Find x in linear equation 2x + 16 = 100."

    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        self.calls.append((role, prompt_name, dict(variables)))
        if prompt_name == "analysis/item_solve":
            stem = variables["item_stem"]
            attempt = int(variables.get("solve_attempt", "1"))
            if "BAD_MIMIC" in stem:
                ans = "11" if attempt == 1 else "19"
                return parse(f"<solve><valid>true</valid><confidence>high</confidence><answer>{ans}</answer></solve>")
            if "GOOD_CHOICE_MIMIC" in stem:
                return parse("<solve><valid>true</valid><confidence>high</confidence><answer>15</answer></solve>")
            if "GOOD_NUM_MIMIC" in stem:
                return parse("<solve><valid>true</valid><confidence>high</confidence><answer>7</answer></solve>")
            if self.mode == "unverified":
                ans = "12" if attempt == 1 else "15"
                return parse(f"<solve><valid>true</valid><confidence>high</confidence><answer>{ans}</answer></solve>")
            return parse("<solve><valid>true</valid><confidence>high</confidence><answer>42</answer></solve>")

        if prompt_name == "analysis/item_choice_map":
            return parse("<mapping><choice>B</choice></mapping>")

        if prompt_name == "analysis/item_equiv":
            ref = variables.get("reference_answer", "")
            cand = variables.get("candidate_answer", "")
            equiv = ("Divide 30 by 2 to get 15" in ref and "B" in cand) or ("x=7" in ref and "7" in cand)
            return parse(f"<comparison><equivalent>{'true' if equiv else 'false'}</equivalent></comparison>")

        if prompt_name == "analysis/solve_blueprint":
            return parse(
                "<blueprint>"
                '{"approach_prompt":"Which term should you move first?",'
                '"key_formula":"2x = 100 - 16",'
                '"hints":{"1":"Subtract 16 from both sides first.","2":"Divide 84 by 2 to get = 42."},'
                '"steps":["Subtract 16: 2x = 84","Divide both sides by 2: x = 42"],'
                '"pitfalls":["Forgetting to change sign when moving 16"]}'
                "</blueprint>"
            )

        if prompt_name == "analysis/solve_feedback":
            if self.mode == "unverified":
                return parse('<feedback>{"verdict":"discuss","reply":"Let us inspect the boundary conditions together."}</feedback>')
            return parse('<feedback>{"verdict":"incorrect","reply":"Close, actually x = 42."}</feedback>')

        if prompt_name == "analysis/solve_step_detail":
            return parse('<detail>{"summary":"Isolate 2x by subtracting 16.","substeps":["2x + 16 - 16 = 100 - 16","2x = 84"]}</detail>')

        if prompt_name == "analysis/mimic_items":
            if self.mode == "all_bad_mimic":
                return parse(
                    "<items>"
                    '[{"type":"numeric","stem":"BAD_MIMIC solve 3x = 33","answer":"11","solution":"x=11","difficulty":2}]'
                    "</items>"
                )
            if self.mode == "numeric_mimic":
                return parse(
                    "<items>"
                    '[{"type":"numeric","stem":"GOOD_NUM_MIMIC solve 4x = 28","answer":"7","solution":"x=7","difficulty":1}]'
                    "</items>"
                )
            return parse(
                "<items>["
                '{"type":"numeric","stem":"BAD_MIMIC solve 3x = 33","answer":"11","solution":"x=11","difficulty":2},'
                '{"type":"choice","stem":"GOOD_CHOICE_MIMIC solve 2x = 30",'
                '"options":[{"key":"A","text":"10"},{"key":"B","text":"15"},{"key":"C","text":"20"},{"key":"D","text":"30"}],'
                '"answer":"B","solution":"Divide 30 by 2 to get 15.","difficulty":2}'
                "]</items>"
            )
        raise AssertionError(f"Unexpected prompt {prompt_name}")


def test_solve_loop_verifies_hides_answer_scrubs_leaking_hints_and_isolates_courses(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, lambda reg: _SolveStudioGateway(reg, mode="verified"))
    try:
        _seed_course(container.repository, space_id="course-a", suffix="a")
        _seed_course(container.repository, space_id="course-b", suffix="b")

        created = client.post(
            "/api/v2/courses/course-a/solve",
            json={"stem": "Solve linear equation 2x + 16 = 100."},
        )
        assert created.status_code == 201
        body = created.json()
        sid = body["id"]
        assert body["verify_status"] == "verified"
        assert body["verified_answer"] is None
        assert body["steps"] == []
        assert body["hints"] == []
        assert body["max_hint_level"] == 1  # Leaking hint 2 containing "= 42" was scrubbed
        assert "42" not in _visible_content_json(body)
        assert body["mapped_kps"][0]["id"] == "kp-a"

        # Strict course isolation
        assert client.get(f"/api/v2/courses/course-b/solve/{sid}").status_code == 404
        assert client.get("/api/v2/courses/course-b/solve").json() == []
        assert len(client.get("/api/v2/courses/course-a/solve").json()) == 1

        # Step locate blocked before reveal
        locked = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/action",
            json={"action": "locate_step", "step_index": 0},
        )
        assert locked.status_code == 400
        assert locked.json()["code"] == "solve_steps_locked"

        # Request hint 1 (clean, no leak)
        hinted = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/action",
            json={"action": "hint"},
        )
        assert hinted.status_code == 200
        assert len(hinted.json()["hints"]) == 1
        assert "42" not in _visible_content_json(hinted.json())

        # Wrong attempt whose model reply tries to leak "= 42" gets scrubbed
        wrong = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/action",
            json={"action": "submit_idea", "text": "x = 10"},
        )
        assert wrong.status_code == 200
        assert wrong.json()["solved"] is False
        assert "42" not in _visible_content_json(wrong.json())

        # Reveal full steps and ask about step 0
        revealed = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/action",
            json={"action": "show_solution"},
        )
        assert revealed.status_code == 200
        assert revealed.json()["verified_answer"] == "42"
        assert len(revealed.json()["steps"]) == 2

        located = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/action",
            json={"action": "locate_step", "step_index": 0},
        )
        assert located.status_code == 200
        assert "0" in located.json()["step_explanations"]
        assert len(located.json()["step_explanations"]["0"]["substeps"]) == 2
    finally:
        client.close()
        container.close()


def test_solve_unverified_problem_is_honest_and_never_auto_grades(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, lambda reg: _SolveStudioGateway(reg, mode="unverified"))
    try:
        _seed_course(container.repository, space_id="course-a", suffix="a")
        created = client.post(
            "/api/v2/courses/course-a/solve",
            json={"stem": "Ambiguous boundary problem."},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["verify_status"] == "unverified"
        assert body["verified_answer"] is None
        assert len(body["steps"]) == 2  # Collaborative walk-through visible

        discussed = client.post(
            f"/api/v2/courses/course-a/solve/{body['id']}/action",
            json={"action": "submit_idea", "text": "Maybe 12?"},
        )
        assert discussed.status_code == 200
        assert discussed.json()["solved"] is False
        assert discussed.json()["turns"][-1]["verdict"] == "discuss"
        with container.repository.connection() as conn:
            assert conn.execute("SELECT COUNT(*) FROM evidence").fetchone()[0] == 0
    finally:
        client.close()
        container.close()


def test_solve_image_upload_validates_and_transcribes(isolated_settings) -> None:
    client, container = _auth_client(isolated_settings, lambda reg: _SolveStudioGateway(reg, mode="verified"))
    try:
        _seed_course(container.repository, space_id="course-a", suffix="a")
        _seed_course(container.repository, space_id="course-b", suffix="b")

        # Invalid image bytes rejected cleanly
        bad = client.post(
            "/api/v2/courses/course-a/solve/image",
            files={"file": ("broken.png", b"not-an-image", "image/png")},
        )
        assert bad.status_code == 400
        assert bad.json()["code"] == "solve_image_invalid"

        buf = BytesIO()
        Image.new("RGB", (64, 48), color=(240, 240, 240)).save(buf, format="PNG")
        ok = client.post(
            "/api/v2/courses/course-a/solve/image",
            files={"file": ("prob.png", buf.getvalue(), "image/png")},
            data={"stem": "Extra hint note"},
        )
        assert ok.status_code == 201
        body = ok.json()
        assert body["source_kind"] == "image"
        assert body["has_image"] is True
        assert "2x + 16 = 100" in body["stem"]
        assert "Extra hint note" in body["stem"]

        img_resp = client.get(body["image_url"])
        assert img_resp.status_code == 200
        assert img_resp.headers["content-type"].startswith("image/jpeg")
        assert client.get(f"/api/v2/courses/course-b/solve/{body['id']}/image").status_code == 404
    finally:
        client.close()
        container.close()


def test_mimic_items_enforce_item_verifier_bkt_post_reveal_discount_and_wrong_card(isolated_settings) -> None:
    gateway_ref: list[_SolveStudioGateway] = []

    def factory(reg):
        gw = _SolveStudioGateway(reg, mode="verified")
        gateway_ref.append(gw)
        return gw

    client, container = _auth_client(isolated_settings, factory)
    try:
        _seed_course(container.repository, space_id="course-a", suffix="a")
        gw = gateway_ref[0]

        created = client.post(
            "/api/v2/courses/course-a/solve",
            json={"stem": "Solve linear equation 2x + 16 = 100."},
        )
        sid = created.json()["id"]
        # Reveal original solution first so subsequent mimic item applies post-reveal hint_level=1 discount
        client.post(f"/api/v2/courses/course-a/solve/{sid}/action", json={"action": "show_solution"})

        mimic = client.post(f"/api/v2/courses/course-a/solve/{sid}/mimic", json={"count": 1})
        assert mimic.status_code == 200
        mimic_body = mimic.json()
        assert len(mimic_body["mimic_items"]) == 1
        item = mimic_body["mimic_items"][0]
        assert "GOOD_CHOICE_MIMIC" in item["stem"]
        assert item["answer"] is None  # Answer hidden until answered

        # Verify reserved exam paper was never exposed to mimic prompt, while public exemplar was used
        mimic_call = next(call for call in gw.calls if call[1] == "analysis/mimic_items")
        assert "PUBLIC_STYLE_EXEMPLAR" in mimic_call[2]["exam_items"]
        assert "SECRET_RESERVED_EXAM_ITEM" not in mimic_call[2]["exam_items"]

        # Submit correct answer -> post-reveal hint_level=1 discount, mastery rises, clean_correct stays 0
        ans = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/mimic/{item['id']}/answer",
            json={"answer": "B"},
        )
        assert ans.status_code == 200
        res = ans.json()["result"]
        assert res["verdict"] == "correct"
        assert res["hint_level"] == 1
        assert res["p_after"] > res["p_before"]

        # Idempotent repeat submission does not record duplicate evidence
        repeat = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/mimic/{item['id']}/answer",
            json={"answer": "A"},
        )
        assert repeat.status_code == 200
        assert repeat.json()["result"]["verdict"] == "correct"

        with container.repository.connection() as conn:
            ev_count = conn.execute("SELECT COUNT(*) FROM evidence WHERE space_id = 'course-a'").fetchone()[0]
            mastery = conn.execute("SELECT clean_correct_count FROM kp_mastery WHERE kp_id = 'kp-a'").fetchone()
            assert ev_count == 1
            assert mastery["clean_correct_count"] == 0

        # Second mimic item: wrong answer -> drops mastery and adds review card
        gw.mode = "numeric_mimic"
        mimic2 = client.post(f"/api/v2/courses/course-a/solve/{sid}/mimic", json={"count": 1})
        assert mimic2.status_code == 200
        item2 = mimic2.json()["mimic_items"][-1]
        wrong = client.post(
            f"/api/v2/courses/course-a/solve/{sid}/mimic/{item2['id']}/answer",
            json={"answer": "999"},
        )
        assert wrong.status_code == 200
        res2 = wrong.json()["result"]
        assert res2["verdict"] == "incorrect"
        assert res2["p_after"] < res2["p_before"]
        with container.repository.connection() as conn:
            cards = conn.execute("SELECT item_ref FROM review_cards WHERE space_id = 'course-a'").fetchall()
            assert [row["item_ref"] for row in cards] == [item2["id"]]

        # When all mimic candidates fail ItemVerifier -> structured 400 and nothing added
        gw.mode = "all_bad_mimic"
        failed = client.post(f"/api/v2/courses/course-a/solve/{sid}/mimic", json={"count": 1})
        assert failed.status_code == 400
        assert failed.json()["code"] == "mimic_verification_failed"
    finally:
        client.close()
        container.close()


def test_solve_image_uses_storage_root_not_cwd_and_rejects_oversized_upload(tmp_path, monkeypatch) -> None:
    import keyring
    from keyring.backends.fail import Keyring

    from app.core.config import Settings
    from app.teaching.solve import _MAX_IMAGE_BYTES

    expected_root = tmp_path / "expected_storage"
    other_cwd = tmp_path / "other_cwd"
    other_cwd.mkdir()

    monkeypatch.setattr(keyring, "get_keyring", Keyring)
    monkeypatch.setattr(Settings, "storage_root", property(lambda self: expected_root))
    monkeypatch.chdir(other_cwd)

    settings = Settings(COMPANION_DATA_DIR="./rel-storage", builtin_neural_tts_enabled=False, _env_file=None)
    client, container = _auth_client(settings, lambda reg: _SolveStudioGateway(reg, mode="verified"))
    try:
        _seed_course(container.repository, space_id="course-cwd", suffix="cwd")

        # Oversized image (> 8 MB) rejected with 413 solve_image_invalid
        oversized = client.post(
            "/api/v2/courses/course-cwd/solve/image",
            files={"file": ("huge.png", b"\x00" * (_MAX_IMAGE_BYTES + 1), "image/png")},
        )
        assert oversized.status_code == 413
        assert oversized.json()["code"] == "solve_image_invalid"

        buf = BytesIO()
        Image.new("RGB", (64, 48), color=(240, 240, 240)).save(buf, format="PNG")
        ok = client.post(
            "/api/v2/courses/course-cwd/solve/image",
            files={"file": ("prob.png", buf.getvalue(), "image/png")},
        )
        assert ok.status_code == 201
        body = ok.json()

        # Saved under settings.storage_root, NOT under CWD (other_cwd/rel-storage)
        expected = expected_root / f"courses/course-cwd/solve/{body['id']}.jpg"
        assert expected.is_file()
        assert not (other_cwd / "rel-storage").exists()

        img_resp = client.get(body["image_url"])
        assert img_resp.status_code == 200
    finally:
        client.close()
        container.close()
