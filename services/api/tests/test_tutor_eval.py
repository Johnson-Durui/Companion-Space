import asyncio
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest


def _module():
    path = Path(__file__).resolve().parents[3] / "evals/tutor_eval.py"
    spec = importlib.util.spec_from_file_location("tutor_eval", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tutor_eval_rejects_a_self_judging_model_and_scores_code_invariants():
    module = _module()
    env = {
        "EVAL_BASE_URL": "https://provider.example/v1", "EVAL_API_KEY": "secret",
        "EVAL_MODEL_LIVE": "teacher", "EVAL_MODEL_JUDGE": "teacher", "SIM_MODEL": "student",
    }
    with pytest.raises(ValueError, match="independent judge"):
        module.validate_model_separation(env)

    plan = {"items": {"q": {"bank_id": "bank", "verify": {"status": "verified"}}}}
    events = [
        {"type": "beat.start", "data": {"move": "EXPLAIN", "approach": "visual", "ask_after": False}},
        {"type": "beat.start", "data": {"move": "REEXPLAIN", "approach": "analogy", "ask_after": True}},
    ]
    result = module.score_invariants(events, [{"item_ref": "bank"}], plan)
    assert result["passed"] is True


def test_independent_judge_scores_quality_and_hint_leak_evidence():
    module = _module()

    class Gateway:
        def __init__(self):
            self.payload = None

        async def stream_text(self, _role, system, messages, **_options):
            if "understanding_checks" in system:
                self.payload = json.loads(messages[0].content)
                yield '{"correctness":4.5,"clarity":4,"adaptation":4,"tone":5,'
                yield '"understanding_checks":4,"evidence":{'
                yield '"correctness":"Matches the verified answer.","clarity":"Steps are explicit.",'
                yield '"adaptation":"Feedback follows the learner result.","tone":"Respectful wording.",'
                yield '"understanding_checks":"The question requires applying the rule."}}'
            else:
                yield '{"leaked":false,"reason":"The hint gives a direction, not the result."}'

    events = [
        {"type": "beat.start", "data": {"move": "HINT", "item_id": "q"}},
        {"type": "board", "data": {"op": "add", "id": "b1", "content": "x = 2"}},
        {"type": "say", "data": {"text": "Start by comparing the two conditions."}},
        {"type": "beat.end", "data": {}},
    ]
    plan = {"items": {
        "q": {"bank_id": "bank-q", "stem": "Which condition holds?", "answer": "B",
              "solution": "Compare the conditions.", "verify": {"status": "verified"}},
        "unsafe": {"stem": "Unverified item", "answer": "A", "verify": {"status": "rejected"}},
    }}
    grade_evidence = [{
        "id": "private-row-id", "item_ref": "bank-q", "kp_id": "kp-1",
        "verdict": "correct", "hint_level": 1, "judged_by": "exact",
        "p_before": 0.4, "p_after": 0.6, "detail_json": "private detail",
    }]
    gateway = Gateway()
    quality = asyncio.run(module._judge_quality(gateway, "weak", events, plan, grade_evidence))
    leaks = asyncio.run(module._judge_hint_leaks(gateway, events, plan))
    assert quality["scores"]["correctness"] == 4.5
    assert any(row["type"] == "board" for row in gateway.payload["transcript"])
    assert [item["item_id"] for item in gateway.payload["verified_plan"]["verified_items"]] == ["q"]
    assert gateway.payload["grade_evidence"] == [{
        "kp_id": "kp-1", "item_ref": "bank-q", "verdict": "correct",
        "hint_level": 1, "judged_by": "exact", "p_before": 0.4, "p_after": 0.6,
    }]
    assert leaks == [{
        "item_id": "q", "leaked": False,
        "reason": "The hint gives a direction, not the result.",
    }]

    class MissingEvidenceGateway:
        async def stream_text(self, *_args, **_options):
            yield '{"correctness":5,"clarity":5,"adaptation":5,"tone":5,'
            yield '"understanding_checks":5,"evidence":{}}'

    with pytest.raises(ValueError, match="nonempty evidence"):
        asyncio.run(module._judge_quality(MissingEvidenceGateway(), "weak", events, plan, grade_evidence))


def _aggregate_runs(module, *, status="done", hints=True):
    runs = []
    for course in module.SAMPLE_COURSES:
        for slot in module.LESSON_SLOTS:
            for persona in module.PERSONAS:
                beats = 3 if persona == "strong" else 4
                runs.append({
                    "set": "sample", "course": course, "lesson_slot": slot,
                    "persona": persona, "status": status,
                    "invariants": {"passed": True},
                    "quality": {"scores": {
                        "correctness": 4.5, "clarity": 4.0, "adaptation": 4.0,
                        "tone": 4.0, "understanding_checks": 4.0,
                    }},
                    "hint_leaks": [{"leaked": False}] if hints else [],
                    "adaptation": {
                        "beat_count": beats, "backfill_count": 0, "plan_has_backfill": False,
                        "mastered_or_confirming": 0, "rubric_answers": 1,
                    },
                })
    return runs


def test_empty_invariant_evidence_and_unfinished_or_hintless_runs_fail_closed():
    module = _module()
    empty = module.score_invariants([], [], {"items": {}})
    assert empty["passed"] is False
    assert empty["checks"]["has_classroom_events"] is False
    assert empty["checks"]["has_judged_evidence"] is False

    unfinished = module.aggregate_results(_aggregate_runs(module, status="active"), expected_cases=20)
    assert unfinished["status"] == "failed"
    assert unfinished["lessons_finished"] is False

    hintless = module.aggregate_results(_aggregate_runs(module, hints=False), expected_cases=20)
    assert hintless["status"] == "failed"
    assert hintless["hint_leaks"]["coverage_passed"] is False


def test_complete_implemented_metrics_remain_unverified_until_full_spec_is_scored():
    module = _module()
    aggregate = module.aggregate_results(_aggregate_runs(module), expected_cases=20)
    assert aggregate["status"] == "unverified"
    assert aggregate["gate_complete"] is False
    assert aggregate["missing_required_metrics"]


def _manifest_cases(module):
    cases = []
    for course in module.SAMPLE_COURSES:
        for slot in module.LESSON_SLOTS:
            for persona in module.PERSONAS:
                cases.append({
                    "set": "sample", "course": course, "lesson_slot": slot, "persona": persona,
                    "data_dir": str(module.DATA_ROOT / f"{course}-{slot}-{persona}"),
                    "course_id": f"course-{course}", "lesson_id": f"lesson-{course}-{slot}",
                })
    return cases


def test_manifest_preflight_requires_the_exact_two_course_sample_matrix():
    module = _module()
    manifest = {"cases": _manifest_cases(module)}
    result = module.validate_manifest(manifest, inspect_databases=False)
    assert result == {"sample_cases": 20, "holdout_cases": 0, "holdout_status": "unverified_not_run"}

    duplicate_lesson = {"cases": _manifest_cases(module)}
    for case in duplicate_lesson["cases"]:
        if case["course"] == "history-1911" and case["lesson_slot"] == 2:
            case["lesson_id"] = "lesson-history-1911-1"
    with pytest.raises(ValueError, match="different lessons"):
        module.validate_manifest(duplicate_lesson, inspect_databases=False)

    manifest["cases"][-1] = {**manifest["cases"][-1], "course": "probability-basics"}
    with pytest.raises(ValueError, match="exactly two lessons"):
        module.validate_manifest(manifest, inspect_databases=False)


def test_case_database_preflight_rejects_a_completed_or_used_lesson(tmp_path, monkeypatch):
    module = _module()
    monkeypatch.setattr(module, "DATA_ROOT", tmp_path.resolve())
    data_dir = tmp_path / "case"
    data_dir.mkdir()
    database = sqlite3.connect(data_dir / "companion.db")
    database.executescript("""
        CREATE TABLE study_spaces (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE lessons (
            id TEXT PRIMARY KEY, space_id TEXT, plan_item_id TEXT,
            lesson_plan_id TEXT, status TEXT
        );
        CREATE TABLE lesson_plans (
            id TEXT PRIMARY KEY, space_id TEXT, plan_item_id TEXT, status TEXT
        );
        CREATE TABLE lesson_events (lesson_id TEXT);
        CREATE TABLE evidence (lesson_id TEXT);
        INSERT INTO study_spaces VALUES ('course', 'history-1911');
        INSERT INTO lesson_plans VALUES ('plan', 'course', 'item', 'ready');
        INSERT INTO lessons VALUES ('lesson', 'course', 'item', 'plan', 'active');
    """)
    database.commit()
    case = {"data_dir": str(data_dir), "course_id": "course", "lesson_id": "lesson", "course": "history-1911"}
    module._validate_case_database(case)
    with pytest.raises(ValueError, match="declared course"):
        module._validate_case_database({**case, "course": "probability-basics"})

    database.execute("UPDATE lessons SET status = 'done'")
    database.commit()
    database.close()
    with pytest.raises(ValueError, match="fresh and active"):
        module._validate_case_database(case)
