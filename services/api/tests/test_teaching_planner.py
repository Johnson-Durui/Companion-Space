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
