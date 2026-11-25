from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from datetime import datetime, timezone

import pytest

from app.llm.errors import LLMOutputError
from app.models.domain import StudySpace
from app.services.repository import SQLiteRepository
from app.teaching.planner import LessonPlanError, LessonPlanner


class QueuedGateway:
    def __init__(self, *plans: dict) -> None:
        self.plans = list(plans)
        self.calls = []

    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        self.calls.append((role, prompt_name, variables, options))
        if prompt_name == "analysis/lesson_check_scope" and not (
            self.plans
            and isinstance(self.plans[0], dict)
            and set(self.plans[0]) == {"requires_target", "uses_later"}
        ):
            value = {"requires_target": True, "uses_later": False}
        else:
            value = self.plans.pop(0)
        tag = {
            "analysis/more_items": "items",
            "analysis/lesson_checks": "items",
            "analysis/lesson_check_scope": "check_scope",
        }.get(prompt_name, "lesson_plan")
        return parse(f"<{tag}>{json.dumps(value, ensure_ascii=False)}</{tag}>")


class RecordingVerifier:
    results: list[dict] = []
    seen: list[dict] = []

    def __init__(self, gateway) -> None:
        self.gateway = gateway

    async def verify(self, item):
        self.seen.append(deepcopy(item))
        return self.results.pop(0)


def _seed(repository: SQLiteRepository, space_id: str = "course") -> None:
    now = datetime.now(timezone.utc)
    repository.upsert_space(StudySpace(id=space_id, name="Course", created_at=now, updated_at=now))
    stamp = now.isoformat()
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO materials
               (id, space_id, title, kind, filename, storage_path, chunk_count,
                created_at, updated_at, role, parse_status)
               VALUES (?, ?, 'Book', 'markdown', 'book.md', ?, 1, ?, ?, 'textbook', 'parsed')""",
            (f"material-{space_id}", space_id, f"spaces/{space_id}/book.md", stamp, stamp),
        )
        conn.execute(
            """INSERT INTO knowledge_points
               (id, space_id, name, norm_name, kind, summary, pitfalls_json, question_types_json,
                importance, difficulty, ord, source_refs_json, status, created_at, updated_at)
               VALUES (?, ?, 'Topic', 'topic', 'concept', 'Grounded summary', '[]', '["choice"]',
                       'core', 2, 0, ?, 'active', ?, ?)""",
            (
                f"kp-{space_id}",
                space_id,
                json.dumps([{"material_id": f"material-{space_id}", "page_no": 2}]),
                stamp,
                stamp,
            ),
        )
        conn.execute(
            """INSERT INTO chunks
               (id, space_id, material_id, title, locator, content, sparse_terms, dense_vector,
                metadata_json, created_at, section_id, page_no)
               VALUES (?, ?, ?, 'Book', '2', 'Grounded source', '[]', '{}', '{}', ?, 'section', 2)""",
            (f"chunk-{space_id}", space_id, f"material-{space_id}", stamp),
        )
        conn.execute(
            "INSERT INTO study_plans(id, space_id, version, status, created_at) VALUES (?, ?, 1, 'active', ?)",
            (f"plan-{space_id}", space_id, stamp),
        )
        conn.execute(
            """INSERT INTO plan_items
               (id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
               VALUES (?, ?, ?, 1, 'lesson', 'Lesson', ?, 25)""",
            (
                f"plan-item-{space_id}",
                f"plan-{space_id}",
                space_id,
                json.dumps([f"kp-{space_id}"]),
            ),
        )
        for item_id, reserved, variant_of in (
            (f"bank-base-{space_id}", 0, None),
            (f"bank-variant-{space_id}", 0, f"bank-base-{space_id}"),
            (f"bank-reserved-{space_id}", 1, None),
        ):
            conn.execute(
                """INSERT INTO item_bank
                   (id, space_id, kp_id, origin, purpose, type, difficulty, variant_of,
                    item_json, verify_status, reserved, created_at)
                   VALUES (?, ?, ?, 'textbook', 'check', 'choice', 1, ?, ?, 'verified', ?, ?)""",
                (
                    item_id,
                    space_id,
                    f"kp-{space_id}",
                    variant_of,
                    json.dumps({
                        "stem": f"Stem {item_id}",
                        "options": {"A": "first choice", "B": "second choice"},
                        "answer": "B",
                        "solution": "second choice",
                    }),
                    reserved,
                    stamp,
                ),
            )


def _question(kp_id: str) -> dict:
    return {
        "kp_id": kp_id,
        "type": "numeric",
        "difficulty": 1,
        "variant_of": "c1",
        "keypoints": [1],
        "stem": "Add the two values.",
        "answer": "8",
        "solution": "The sum is 8.",
        "fallback_hints": {"1": "Combine both values.", "2": "Use addition."},
    }


def _example(answer: str) -> dict:
    return {
        "type": "numeric",
        "stem": "Worked example",
        "answer": answer,
        "solution": f"The result is {answer}.",
    }


def _valid_plan(space_id: str = "course") -> dict:
    kp_id = f"kp-{space_id}"
    return {
        "title": "Grounded lesson",
        "est_minutes": 25,
        "objectives": [{"kp_id": kp_id, "text": "Apply the idea"}],
        "segments": [{
            "id": "s1",
            "kp_id": kp_id,
            "kind": "concept",
            "goal": "Apply the idea",
            "est_minutes": 20,
            "keypoints": ["First point", "Second point"],
            "approaches": [
                {"kind": kind, "keypoint": "all", "outline": kind}
                for kind in ("intuition", "example", "visual", "formal")
            ],
            "examples": [_example("3"), _example("5")],
            "misconceptions": [],
            "checks": ["c1", "c2", "c3"],
            "backfills": [],
            "sources": [{"material_id": "invented", "page_start": 999, "page_end": 999}],
        }],
        "practice": [],
        "wrap": {"summary_points": ["Apply"], "cards": []},
        "items": {
            "c1": {
                "bank_id": f"bank-base-{space_id}",
                "keypoints": [0],
                "fallback_hints": {"1": "Compare the choices.", "2": "Eliminate one choice."},
            },
            "c2": {
                "bank_id": f"bank-variant-{space_id}",
                "keypoints": [0, 1],
                "fallback_hints": {"1": "Compare the choices.", "2": "Eliminate one choice."},
            },
            "c3": _question(kp_id),
        },
    }


def test_prepare_supplements_then_verifies_persists_and_scopes(
    isolated_settings, monkeypatch,
) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    _seed(repository, "other")
    invalid = _valid_plan()
    invalid["segments"][0]["approaches"] = invalid["segments"][0]["approaches"][:1]
    gateway = QueuedGateway(invalid, _valid_plan())
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"} for _ in range(3)]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))

    plan_calls = [call for call in gateway.calls if call[1] == "analysis/lesson_plan"]
    assert len(plan_calls) == 2
    assert not gateway.calls[0][2]["lesson_feedback"]
    assert plan_calls[1][2]["lesson_feedback"].startswith('<data name="validation">')
    supplied = gateway.calls[0][2]["existing_items"]
    assert "bank-base-course" in supplied and "bank-reserved-course" not in supplied
    assert "bank-base-other" not in supplied
    assert len(RecordingVerifier.seen) == 3
    assert saved["plan"]["segments"][0]["sources"] == [{
        "material_id": "material-course", "page_start": 2, "page_end": 2,
    }]
    generated = saved["plan"]["items"]["c3"]
    assert generated["verify"]["status"] == "verified"
    assert generated["forbidden"]["number"] == "8"
    assert generated["variant_of"] == "c1"
    assert saved["plan"]["items"]["c2"]["variant_of"] == "c1"
    with repository.connection() as conn:
        row = conn.execute(
            "SELECT space_id, verify_status, reserved, variant_of FROM item_bank WHERE id = ?",
            (generated["bank_id"],),
        ).fetchone()
    assert tuple(row) == ("course", "verified", 0, "bank-base-course")


def test_prepare_fails_closed_after_generated_item_verification_rejected(
    isolated_settings, monkeypatch,
) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    gateway = QueuedGateway(_valid_plan(), _valid_plan())
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "unverified"}, {"status": "unverified"}]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    with pytest.raises(LessonPlanError, match="after one supplement attempt"):
        asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))

    assert repository.get_lesson_plan("course", "plan-item-course") is None
    with repository.connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM item_bank WHERE space_id = 'course' AND origin = 'generated'"
        ).fetchone()[0] == 0


def test_checker_format_error_uses_remaining_preparation_attempt(isolated_settings, monkeypatch):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    gateway = QueuedGateway(_valid_plan(), _valid_plan())

    async def verify(_self, _item):
        if len([call for call in gateway.calls if call[1] == "analysis/lesson_plan"]) == 1:
            raise LLMOutputError(public_detail="Invalid checker output.")
        return {"status": "verified"}

    monkeypatch.setattr("app.teaching.planner.ItemVerifier.verify", verify)
    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))
    assert saved["status"] == "ready"
    plan_calls = [call for call in gateway.calls if call[1] == "analysis/lesson_plan"]
    assert len(plan_calls) == 2
    assert plan_calls[1][2]["lesson_feedback"]


def test_prepare_allows_a_new_base_and_normalizes_variant_bank_reference(isolated_settings, monkeypatch):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    plan = _valid_plan()
    plan["items"]["c3"]["variant_of"] = "bank-base-course"
    plan["items"]["c4"] = {**_question("kp-course"), "variant_of": None}
    plan["segments"][0]["checks"].append("c4")
    gateway = QueuedGateway(plan)

    async def verify(_self, _item):
        return {"status": "verified"}

    monkeypatch.setattr("app.teaching.planner.ItemVerifier.verify", verify)
    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))
    items = saved["plan"]["items"]
    assert items["c3"]["variant_of"] == "c1"
    assert items["c4"]["variant_of"] is None
    with repository.connection() as conn:
        assert conn.execute(
            "SELECT variant_of FROM item_bank WHERE id = ?", (items["c4"]["bank_id"],),
        ).fetchone()[0] is None


def test_prepare_generates_and_semantically_checks_only_the_missing_progressive_check(
    isolated_settings, monkeypatch,
):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    plan = _valid_plan()
    plan["items"]["c1"]["keypoints"] = [0, 1]
    supplement = {
        "slot": "s1:0",
        "kp_id": "kp-course",
        "type": "short",
        "difficulty": 1,
        "variant_of": None,
        "keypoints": [0],
        "stem": "State the first point.",
        "answer": "first",
        "solution": "The first point is first.",
        "fallback_hints": {"1": "Recall the opening idea.", "2": "Use the introductory definition."},
    }
    gateway = QueuedGateway(
        plan,
        [supplement],
        {"requires_target": True, "uses_later": False},
    )
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"} for _ in range(4)]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))

    call_names = [call[1] for call in gateway.calls]
    assert call_names[0] == "analysis/lesson_plan"
    assert "analysis/lesson_checks" in call_names
    supplement_call = next(call for call in gateway.calls if call[1] == "analysis/lesson_checks")
    slots = supplement_call[2]["check_slots"]
    assert '"target_index":0' in slots
    assert '"taught":["First point"]' in slots
    scope_calls = [call for call in gateway.calls if call[1] == "analysis/lesson_check_scope"]
    scope_question = scope_calls[-1][2]["item_context"]
    assert '"answer"' not in scope_question and '"solution"' not in scope_question
    generated_id = saved["plan"]["segments"][0]["checks"][-1]
    assert saved["plan"]["items"][generated_id]["keypoints"] == [0]
    assert saved["plan"]["items"][generated_id]["verify"]["status"] == "verified"


@pytest.mark.parametrize(
    ("dependencies", "scope"),
    [
        ([0, 1], {"requires_target": True, "uses_later": False}),
        ([0], {"requires_target": False, "uses_later": False}),
        ([0], {"requires_target": True, "uses_later": True}),
    ],
)
def test_prepare_fails_closed_when_supplement_scope_is_unsafe(
    isolated_settings, monkeypatch, dependencies, scope,
):
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    plan = _valid_plan()
    plan["items"]["c1"]["keypoints"] = [0, 1]
    unsafe = {
        "slot": "s1:0",
        "kp_id": "kp-course",
        "type": "short",
        "difficulty": 1,
        "variant_of": None,
        "keypoints": dependencies,
        "stem": "Combine both points.",
        "answer": "combined",
        "solution": "Use both points.",
        "fallback_hints": {"1": "Recall the ideas.", "2": "Apply the definition."},
    }
    sequence = [plan, [unsafe]]
    if dependencies == [0]:
        sequence.append(scope)
    gateway = QueuedGateway(*sequence, *sequence)
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"} for _ in range(6)]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    with pytest.raises(LessonPlanError, match="after one supplement attempt"):
        asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))

    assert repository.get_lesson_plan("course", "plan-item-course") is None


def test_more_items_generates_verifies_and_excludes_other_course_context(
    isolated_settings, monkeypatch,
) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    _seed(repository, "other")
    with repository.connection() as conn:
        conn.execute(
            "UPDATE item_bank SET verify_status = 'unverified' WHERE id = 'bank-variant-course'"
        )
    item = _question("kp-course")
    item["variant_of"] = "bank-base-course"
    gateway = QueuedGateway([item])
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"}]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    items = asyncio.run(LessonPlanner(repository, gateway).more_items("course", "kp-course", 1))

    supplied = gateway.calls[0][2]["existing_items"]
    assert "bank-base-course" in supplied
    assert "bank-reserved-course" not in supplied
    assert "bank-base-other" not in supplied
    assert len(items) == 1 and items[0]["verify"]["status"] == "verified"
    with repository.connection() as conn:
        stored = conn.execute(
            "SELECT space_id, origin, verify_status FROM item_bank WHERE id = ?",
            (items[0]["bank_id"],),
        ).fetchone()
    assert tuple(stored) == ("course", "generated", "verified")


def test_canonicalize_objective_normalizes_dict_options_latex_numeric_and_variants() -> None:
    from app.teaching.understanding import grade_objective

    # Dict options + punctuated choice answer -> canonical list options & key
    choice_item = {
        "type": "Choice",
        "stem": "Pick 1/6.",
        "options": {"A": "1/2", "B": "1/6", "C": "1/3"},
        "answer": "B.",
        "verify": {"status": "verified"},
    }
    assert LessonPlanner._canonicalize_objective(choice_item) is True
    assert choice_item["type"] == "choice"
    assert choice_item["options"] == [
        {"key": "A", "text": "1/2"},
        {"key": "B", "text": "1/6"},
        {"key": "C", "text": "1/3"},
    ]
    assert choice_item["answer"] == "B"
    assert grade_objective(choice_item, "B")["verdict"] == "correct"

    # Dict options + LaTeX numeric answer matching option text
    choice_from_latex = {
        "type": "single_choice",
        "stem": "Pick 1/6.",
        "options": {"A": "1/2", "B": "1/6"},
        "answer": r"$\frac{1}{6}$",
        "verify": {"status": "verified"},
    }
    assert LessonPlanner._canonicalize_objective(choice_from_latex) is True
    assert choice_from_latex["answer"] == "B"

    # Numeric answers: LaTeX fraction, percent, thousands separator, fullwidth, integer zero
    for raw_answer, student_input in (
        ("$1/6$", "1/6"),
        (r"$$-\frac{1}{6}$$", "-1/6"),
        ("50%", "0.5"),
        (r"$25\%$", "1/4"),
        ("1,250", "1250"),
        ("３ ／ ４", "0.75"),
        (0, "0"),
        (0.25, "1/4"),
    ):
        num_item = {
            "type": "numeric",
            "stem": "Compute.",
            "answer": raw_answer,
            "tolerance": None,
            "verify": {"status": "verified"},
        }
        assert LessonPlanner._canonicalize_objective(num_item) is True, raw_answer
        assert grade_objective(num_item, student_input)["verdict"] == "correct"

    # Multi-select & true_false normalization
    multi_item = {
        "type": "multi_select",
        "stem": "Select all.",
        "options": {"A": "first", "B": "second", "C": "third"},
        "answer": "CA",
        "verify": {"status": "verified"},
    }
    assert LessonPlanner._canonicalize_objective(multi_item) is True
    assert multi_item["type"] == "multi"
    assert multi_item["answer"] == "A,C"
    assert grade_objective(multi_item, ["C", "A"])["verdict"] == "correct"

    tf_item = {
        "type": "true_false",
        "stem": "Is it true?",
        "answer": "正确",
        "verify": {"status": "verified"},
    }
    assert LessonPlanner._canonicalize_objective(tf_item) is True
    assert tf_item["type"] == "choice"
    assert tf_item["answer"] == "T"
    assert grade_objective(tf_item, "T")["verdict"] == "correct"

    # Truly ungradeable items MUST still be rejected
    for bad in (
        {"type": "numeric", "answer": "not a number"},
        {"type": "numeric", "answer": "1/0"},
        {"type": "numeric", "answer": "1 2"},
        {"type": "choice", "options": [{"key": "A", "text": "1"}, {"key": "B", "text": "2"}], "answer": ["A", "B"]},
        {"type": "choice", "options": [{"key": "A", "text": "only one"}], "answer": "A"},
        {"type": "matching", "answer": "A-1"},
    ):
        assert LessonPlanner._canonicalize_objective(dict(bad)) is False, bad


def test_prepare_prunes_ungradeable_extra_item_and_normalizes_generated_items(
    isolated_settings, monkeypatch,
) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    plan = _valid_plan()
    # Replace c3 with a LaTeX numeric answer + add an extra ungradeable item c4
    plan["items"]["c3"] = {
        **_question("kp-course"),
        "answer": r"$\frac{1}{6}$",
        "solution": "P = 1/6.",
        "fallback_hints": {"1": "Multiply the probabilities.", "2": "Compute half of one third."},
    }
    plan["items"]["c4"] = {
        "kp_id": "kp-course",
        "type": "numeric",
        "difficulty": 2,
        "variant_of": None,
        "keypoints": [1],
        "stem": "Malformed numeric question.",
        "answer": "depends on x",
        "solution": "No single number.",
        "fallback_hints": {"1": "Hint one.", "2": "Hint two."},
    }
    plan["segments"][0]["checks"].append("c4")
    plan["practice"] = []

    # Also add a dict-option choice item c5 as practice
    plan["items"]["c5"] = {
        "kp_id": "kp-course",
        "type": "choice",
        "difficulty": 1,
        "variant_of": None,
        "keypoints": [0, 1],
        "stem": "Which is 1/6?",
        "options": {"A": "1/2", "B": "1/6"},
        "answer": "B.",
        "solution": "Equals 1/6.",
        "fallback_hints": {"1": "Compute the product.", "2": "Check the denominator."},
    }
    plan["practice"] = ["c5"]

    gateway = QueuedGateway(plan)
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"} for _ in range(4)]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))
    saved_plan = saved["plan"]

    # Bad c4 was pruned cleanly without aborting the plan; c3 and c5 were normalized and verified
    assert "c4" not in saved_plan["items"]
    assert "c4" not in saved_plan["segments"][0]["checks"]
    assert saved_plan["items"]["c3"]["answer"] == "1/6"
    assert saved_plan["items"]["c5"]["answer"] == "B"
    assert saved_plan["items"]["c5"]["options"] == [{"key": "A", "text": "1/2"}, {"key": "B", "text": "1/6"}]
    assert saved_plan["practice"] == ["c5"]


def test_prepare_supplements_when_required_generated_item_is_ungradeable(
    isolated_settings, monkeypatch,
) -> None:
    repository = SQLiteRepository(isolated_settings)
    _seed(repository)
    plan = _valid_plan()
    # Make c1 cover [0], c2 cover [0] (so only c3 covers keypoint 1), and make c3 ungradeable
    plan["items"]["c2"]["keypoints"] = [0]
    plan["items"]["c3"] = {
        **_question("kp-course"),
        "variant_of": None,
        "answer": "unparseable expression",
    }
    # Add another valid variant c4 covering [0] so variant count >= 2 stays satisfied
    plan["items"]["c4"] = {
        **_question("kp-course"),
        "keypoints": [0],
        "answer": 0,
        "solution": "The result is 0.",
        "fallback_hints": {"1": "Check disjoint events.", "2": "Intersection is empty."},
    }
    plan["segments"][0]["checks"].append("c4")

    supplement = {
        "slot": "s1:1",
        "kp_id": "kp-course",
        "type": "Choice",
        "difficulty": 1,
        "variant_of": None,
        "keypoints": [1],
        "stem": "Select the value of 1/2 * 1/3.",
        "options": {"A": "1/2", "B": "1/6"},
        "answer": "B",
        "solution": "Product is 1/6.",
        "fallback_hints": {"1": "Multiply numerators and denominators.", "2": "2 times 3 is 6."},
    }
    gateway = QueuedGateway(
        plan,
        [supplement],
        {"requires_target": True, "uses_later": False},
    )
    RecordingVerifier.seen = []
    RecordingVerifier.results = [{"status": "verified"} for _ in range(4)]
    monkeypatch.setattr("app.teaching.planner.ItemVerifier", RecordingVerifier)

    saved = asyncio.run(LessonPlanner(repository, gateway).prepare("course", "plan-item-course"))
    saved_plan = saved["plan"]
    assert "c3" not in saved_plan["items"]
    assert saved_plan["items"]["c4"]["answer"] == "0"
    assert any(
        item["keypoints"] == [1] and item["type"] == "choice" and item["answer"] == "B"
        for item in saved_plan["items"].values()
    )
