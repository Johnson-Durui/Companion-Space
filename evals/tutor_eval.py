"""Run or score isolated M4 simulated classrooms.

The manifest points to isolated databases containing pre-prepared lessons. Each
case has set, course, lesson_slot, persona, data_dir, course_id, and lesson_id.
Data directories must live below evals/out/data/.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sqlite3
from collections import Counter
from contextlib import aclosing
from pathlib import Path

from dotenv import dotenv_values

from app.api.deps import build_container
from app.core.config import Settings
from app.llm.presets import RoleAssignment
from app.providers.base import Message
from app.llm.usage import list_usage
from app.teaching.runtime import LessonRuntime
from app.teaching.sim_student import PERSONAS

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = (ROOT / "evals/out").resolve()
DATA_ROOT = (OUTPUT / "data").resolve()
QUALITY_THRESHOLDS = {
    "correctness": 4.5, "clarity": 4.0, "adaptation": 4.0,
    "tone": 4.0, "understanding_checks": 4.0,
}
SAMPLE_COURSES = ("probability-basics", "history-1911")
HOLDOUT_COURSES = ("kinematics",)
LESSON_SLOTS = (1, 2)
UNIMPLEMENTED_REQUIRED_METRICS = (
    "verified_source_examples_only",
    "per_keypoint_reexplain_diversity",
    "demonstration_timing_and_followup_variant",
    "know_it_verification_flow",
    "silence_reminder_pause_and_no_evidence",
    "hint_level_scenario_coverage",
    "fallback_hint_interception_rate",
    "format_failure_rates",
    "teaching_style_feature_compliance",
)


def _binding(env: dict, variable: str) -> tuple[str, str, str]:
    model = str(env.get(variable) or "")
    prefix = "SIM" if variable == "SIM_MODEL" and env.get("SIM_BASE_URL") else (
        "EVAL2" if model.endswith("@2") else "EVAL"
    )
    missing = [name for name in (variable, f"{prefix}_BASE_URL", f"{prefix}_API_KEY") if not env.get(name)]
    if missing:
        raise ValueError("Missing " + ", ".join(missing))
    return prefix, str(env[f"{prefix}_BASE_URL"]).rstrip("/").casefold(), model.removesuffix("@2")


def validate_model_separation(env: dict) -> dict[str, str]:
    live_prefix, live_base, live_model = _binding(env, "EVAL_MODEL_LIVE")
    judge_prefix, judge_base, judge_model = _binding(env, "EVAL_MODEL_JUDGE")
    sim_variable = "SIM_MODEL" if env.get("SIM_MODEL") else "EVAL_MODEL_SIM"
    _, _, sim_model = _binding(env, sim_variable)
    if (live_base, live_model.casefold()) == (judge_base, judge_model.casefold()):
        raise ValueError("The independent judge cannot use the tutor provider/model fingerprint.")
    return {
        "tutor": f"{live_model}@{live_prefix}", "simulator": sim_model,
        "judge": f"{judge_model}@{judge_prefix}",
    }


def score_invariants(events: list[dict], evidence: list[dict], plan: dict) -> dict[str, object]:
    verified = {
        item.get("bank_id") for item in plan.get("items", {}).values()
        if item.get("verify", {}).get("status") == "verified"
    }
    judged = [row for row in evidence if row.get("item_ref")]
    approaches = [
        row["data"].get("approach") for row in events
        if row["type"] == "beat.start" and row["data"].get("move") in {"EXPLAIN", "REEXPLAIN"}
    ]
    reexplain_distinct = all(
        approach is not None and approach not in approaches[:index]
        for index, approach in enumerate(approaches[:4])
    )
    pure_explains = 0
    maximum_pure_explains = 0
    for row in events:
        if row["type"] != "beat.start":
            continue
        if row["data"].get("move") in {"EXPLAIN", "REEXPLAIN", "REPEAT"} and not row["data"].get("ask_after"):
            pure_explains += 1
            maximum_pure_explains = max(maximum_pure_explains, pure_explains)
        else:
            pure_explains = 0
    checks = {
        "has_classroom_events": bool(events),
        "has_judged_evidence": bool(judged),
        "verified_judged_items": bool(judged) and all(row["item_ref"] in verified for row in judged),
        "first_four_approaches_distinct": reexplain_distinct,
        "no_more_than_two_pure_explanation_beats": maximum_pure_explains <= 2,
    }
    return {"checks": checks, "passed": all(checks.values()), "maximum_pure_explanation_beats": maximum_pure_explains}


def _isolated(path: str) -> Path:
    data = Path(path).resolve()
    if not data.is_relative_to(DATA_ROOT) or data == DATA_ROOT:
        raise ValueError("Evaluation data must be under evals/out/data/<run>/<persona>.")
    return data


def _matrix(courses: tuple[str, ...]) -> Counter:
    return Counter((course, slot, persona) for course in courses for slot in LESSON_SLOTS for persona in PERSONAS)


def _validate_case_database(case: dict) -> None:
    data_dir = _isolated(case["data_dir"])
    database = (data_dir / "companion.db").resolve()
    if database.parent != data_dir or not database.is_file():
        raise ValueError(f"Evaluation database does not exist: {database}")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        lesson = connection.execute(
            """SELECT l.space_id, l.plan_item_id, l.lesson_plan_id, l.status, s.name AS course
               FROM lessons l JOIN study_spaces s ON s.id = l.space_id WHERE l.id = ?""",
            (case["lesson_id"],),
        ).fetchone()
        if lesson is None or lesson["space_id"] != case["course_id"] or lesson["course"] != case["course"]:
            raise ValueError("Manifest lesson was not found in the declared course database.")
        if lesson["status"] != "active":
            raise ValueError("Evaluation lessons must be fresh and active before provider calls.")
        event_count = connection.execute(
            "SELECT COUNT(*) FROM lesson_events WHERE lesson_id = ?", (case["lesson_id"],),
        ).fetchone()[0]
        evidence_count = connection.execute(
            "SELECT COUNT(*) FROM evidence WHERE lesson_id = ?", (case["lesson_id"],),
        ).fetchone()[0]
        if event_count or evidence_count:
            raise ValueError("Evaluation lessons must have no events or evidence before provider calls.")
        plan = connection.execute(
            """SELECT status FROM lesson_plans
               WHERE id = ? AND space_id = ? AND plan_item_id = ?""",
            (lesson["lesson_plan_id"], case["course_id"], lesson["plan_item_id"]),
        ).fetchone()
        if plan is None or plan["status"] != "ready":
            raise ValueError("Manifest lesson does not reference a ready prepared lesson plan.")
    except sqlite3.DatabaseError as exc:
        raise ValueError(f"Evaluation database is incomplete: {database}") from exc
    finally:
        connection.close()


def validate_manifest(manifest: dict, *, inspect_databases: bool = True) -> dict:
    cases = manifest.get("cases") if isinstance(manifest, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ValueError("Evaluation manifest has no classroom cases.")
    required = {"set", "course", "lesson_slot", "persona", "data_dir", "course_id", "lesson_id"}
    for index, case in enumerate(cases, 1):
        if not isinstance(case, dict):
            raise ValueError(f"Manifest case {index} must be an object.")
        missing = sorted(required - set(case))
        if missing:
            raise ValueError(f"Manifest case {index} is missing: {', '.join(missing)}")
        if any(not isinstance(case[key], str) or not case[key].strip() for key in required - {"lesson_slot"}):
            raise ValueError(f"Manifest case {index} has an invalid text field.")
        if case["set"] not in {"sample", "holdout"}:
            raise ValueError(f"Manifest case {index} has an unknown set.")
        if case["persona"] not in PERSONAS:
            raise ValueError(f"Manifest case {index} has an unknown persona.")
        if type(case["lesson_slot"]) is not int or case["lesson_slot"] not in LESSON_SLOTS:
            raise ValueError(f"Manifest case {index} has an invalid lesson slot.")

    sample = [case for case in cases if case["set"] == "sample"]
    sample_matrix = Counter((case["course"], case["lesson_slot"], case["persona"]) for case in sample)
    if sample_matrix != _matrix(SAMPLE_COURSES):
        raise ValueError("Sample evaluation must contain exactly two lessons for each persona in both sample courses.")
    holdout = [case for case in cases if case["set"] == "holdout"]
    if holdout:
        holdout_matrix = Counter((case["course"], case["lesson_slot"], case["persona"]) for case in holdout)
        if holdout_matrix != _matrix(HOLDOUT_COURSES):
            raise ValueError("Holdout evaluation must contain exactly two lessons for each persona in the holdout course.")

    paths = [str(_isolated(case["data_dir"])) for case in cases]
    if len(paths) != len(set(paths)):
        raise ValueError("Every evaluation case must use a distinct isolated data directory.")
    course_ids: dict[str, set[str]] = {}
    lesson_ids: dict[tuple[str, int], set[str]] = {}
    for case in cases:
        course_ids.setdefault(case["course"], set()).add(case["course_id"])
        lesson_ids.setdefault((case["course"], case["lesson_slot"]), set()).add(case["lesson_id"])
    if any(len(values) != 1 for values in course_ids.values()):
        raise ValueError("Each logical course must use one stable course id across persona copies.")
    if any(len(values) != 1 for values in lesson_ids.values()):
        raise ValueError("Each logical lesson slot must use one stable lesson id across persona copies.")
    if len({next(iter(values)) for values in course_ids.values()}) != len(course_ids):
        raise ValueError("Different logical courses must use different course ids.")
    for course in course_ids:
        ids = {next(iter(lesson_ids[(course, slot)])) for slot in LESSON_SLOTS}
        if len(ids) != len(LESSON_SLOTS):
            raise ValueError("The two lesson slots in a course must reference different lessons.")
    if inspect_databases:
        for case in cases:
            _validate_case_database(case)
    return {
        "sample_cases": len(sample), "holdout_cases": len(holdout),
        "holdout_status": "ready" if holdout else "unverified_not_run",
    }


async def run_case(case: dict, env: dict) -> dict:
    persona = case.get("persona")
    if persona not in PERSONAS:
        raise ValueError(f"Unknown simulated student persona: {persona}")
    settings = Settings(COMPANION_DATA_DIR=str(_isolated(case["data_dir"])), _env_file=None)
    container = await asyncio.to_thread(build_container, settings)
    sim_settings = Settings(COMPANION_DATA_DIR=str(settings.storage_root / "sim-provider"), _env_file=None)
    sim_container = await asyncio.to_thread(build_container, sim_settings)
    judge_settings = Settings(COMPANION_DATA_DIR=str(settings.storage_root / "judge-provider"), _env_file=None)
    judge_container = await asyncio.to_thread(build_container, judge_settings)
    try:
        status = await asyncio.to_thread(container.vault.bootstrap)
        if not status.initialized:
            await asyncio.to_thread(container.vault.initialize, secrets.token_urlsafe(24))
        elif not status.unlocked:
            raise ValueError("The isolated evaluation vault is locked; use a fresh case data directory.")
        prefix, _, model = _binding(env, "EVAL_MODEL_LIVE")
        connection = await asyncio.to_thread(
            container.providers.save_connection,
            provider="openai-compatible", label=f"Tutor eval {prefix}",
            base_url=env[f"{prefix}_BASE_URL"], api_key=env[f"{prefix}_API_KEY"],
        )
        await asyncio.to_thread(container.providers.set_roles, {
            "live": RoleAssignment(
                connection_id=connection["id"], model=model,
                params=json.loads(env.get("EVAL_EXTRA_BODY_LIVE") or "{}"),
            ),
        })
        sim_status = await asyncio.to_thread(sim_container.vault.bootstrap)
        if not sim_status.initialized:
            await asyncio.to_thread(sim_container.vault.initialize, secrets.token_urlsafe(24))
        sim_variable = "SIM_MODEL" if env.get("SIM_MODEL") else "EVAL_MODEL_SIM"
        sim_prefix, _, sim_model = _binding(env, sim_variable)
        sim_connection = await asyncio.to_thread(
            sim_container.providers.save_connection,
            provider="openai-compatible", label=f"Student eval {sim_prefix}",
            base_url=env[f"{sim_prefix}_BASE_URL"], api_key=env[f"{sim_prefix}_API_KEY"],
        )
        await asyncio.to_thread(sim_container.providers.set_roles, {
            "live": RoleAssignment(connection_id=sim_connection["id"], model=sim_model),
        })
        judge_status = await asyncio.to_thread(judge_container.vault.bootstrap)
        if not judge_status.initialized:
            await asyncio.to_thread(judge_container.vault.initialize, secrets.token_urlsafe(24))
        judge_prefix, _, judge_model = _binding(env, "EVAL_MODEL_JUDGE")
        judge_connection = await asyncio.to_thread(
            judge_container.providers.save_connection,
            provider="openai-compatible", label=f"Judge eval {judge_prefix}",
            base_url=env[f"{judge_prefix}_BASE_URL"], api_key=env[f"{judge_prefix}_API_KEY"],
        )
        await asyncio.to_thread(judge_container.providers.set_roles, {
            "live": RoleAssignment(connection_id=judge_connection["id"], model=judge_model),
        })
        runtime = LessonRuntime(container.repository, container.gateway, case["course_id"], case["lesson_id"])
        lesson = await asyncio.to_thread(container.repository.get_lesson, case["course_id"], case["lesson_id"])
        if lesson is None:
            raise ValueError("Manifest lesson was not found in its isolated database.")
        saved = await asyncio.to_thread(
            container.repository.get_lesson_plan, case["course_id"], lesson["plan_item_id"],
            lesson_plan_id=lesson["lesson_plan_id"],
        )
        event = {"type": "lesson_resume" if lesson["seq"] else "lesson_start"}
        for _ in range(200):
            await runtime.step(event, elapsed_ms=1_000)
            lesson = await asyncio.to_thread(container.repository.get_lesson, case["course_id"], case["lesson_id"])
            if lesson["status"] != "active":
                break
            event = await _model_student_event(
                sim_container.gateway, persona, lesson["state"], saved["plan"], case.get("knowledge", {}),
            )
        else:
            raise ValueError("Simulated classroom exceeded 200 turns.")
        events = await asyncio.to_thread(container.repository.list_lesson_events, case["course_id"], case["lesson_id"])
        with container.repository.connection() as connection:
            evidence = [dict(row) for row in connection.execute(
                "SELECT * FROM evidence WHERE lesson_id = ? ORDER BY created_at", (case["lesson_id"],),
            )]
            mastery_statuses = [row["status"] for row in connection.execute(
                "SELECT status FROM kp_mastery WHERE space_id = ?", (case["course_id"],),
            )]
        quality = await _judge_quality(judge_container.gateway, persona, events, saved["plan"], evidence)
        leaks = await _judge_hint_leaks(judge_container.gateway, events, saved["plan"])
        beats = [row for row in events if row["type"] == "beat.start"]
        return {
            "set": case["set"], "course": case["course"], "lesson_slot": case["lesson_slot"],
            "persona": persona, "lesson_id": case["lesson_id"],
            "status": lesson["status"], "invariants": score_invariants(events, evidence, saved["plan"]),
            "quality": quality, "hint_leaks": leaks, "events": events,
            "adaptation": {
                "beat_count": len(beats),
                "backfill_count": sum(row["data"].get("move") == "BACKFILL" for row in beats),
                "plan_has_backfill": any(segment.get("backfills") for segment in saved["plan"].get("segments", [])),
                "mastered_or_confirming": sum(status in {"mastered", "confirming"} for status in mastery_statuses),
                "rubric_answers": sum(row.get("judged_by") == "model" for row in evidence),
            },
            "usage": {
                "tutor": [row.model_dump() for row in list_usage(container.repository)],
                "simulator": [row.model_dump() for row in list_usage(sim_container.repository)],
                "judge": [row.model_dump() for row in list_usage(judge_container.repository)],
            },
        }
    finally:
        await judge_container.aclose()
        await sim_container.aclose()
        await container.aclose()


async def _model_student_event(gateway, persona: str, state: dict, plan: dict, knowledge: dict) -> dict:
    instructions = (ROOT / f"evals/prompts/student_{persona}.md").read_text(encoding="utf-8")
    ask = state.get("active_ask") or {}
    item = plan.get("items", {}).get(ask.get("item_id"), {})
    public_item = {
        key: item[key] for key in ("type", "stem", "options", "rubric") if key in item
    }
    context = {
        "stage": state.get("stage"), "active_ask": ask, "question": public_item,
        "knowledge": knowledge, "approaches_used": state.get("approaches_used", []),
        "waiting_for_next_beat": "playback_after_seq" in state,
    }
    system = (
        instructions + "\nReturn exactly one JSON object and no prose. Allowed forms: "
        '{"type":"beat_done"}; {"type":"quick_action","kind":"confused|show_answer|hint|example"}; '
        '{"type":"student_answer","value":"..."}; {"type":"ask_reply","value":"..."}.'
    )
    pieces = []
    stream = gateway.stream_text(
        "live", system, [Message(role="user", content=json.dumps(context, ensure_ascii=False))],
        max_tokens=160, temperature=0,
    )
    async with aclosing(stream):
        async for piece in stream:
            pieces.append(piece)
    raw = "".join(pieces).strip().removeprefix("```json").removesuffix("```").strip()
    event = json.loads(raw)
    if not isinstance(event, dict) or event.get("type") not in {
        "beat_done", "quick_action", "student_answer", "ask_reply",
    }:
        raise ValueError("The simulated student returned an invalid classroom action.")
    if event["type"] == "student_answer":
        if ask.get("kind") != "item":
            raise ValueError("The simulated student answered when no item was active.")
        event.update(item_id=ask["item_id"], via="text")
    elif event["type"] == "ask_reply":
        event["purpose"] = ask.get("purpose")
    return event


async def _json_completion(gateway, system: str, payload: dict, *, max_tokens: int = 500) -> dict:
    pieces = []
    stream = gateway.stream_text(
        "live", system, [Message(role="user", content=json.dumps(payload, ensure_ascii=False))],
        max_tokens=max_tokens, temperature=0,
    )
    async with aclosing(stream):
        async for piece in stream:
            pieces.append(piece)
    raw = "".join(pieces).strip().removeprefix("```json").removesuffix("```").strip()
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("The independent judge returned a non-object result.")
    return result


def _verified_plan_context(plan: dict) -> dict:
    items = []
    for item_id, item in plan.get("items", {}).items():
        if item.get("verify", {}).get("status") != "verified":
            continue
        items.append({
            key: value for key, value in {
                "item_id": item_id, "bank_id": item.get("bank_id"), "kp_id": item.get("kp_id"),
                "type": item.get("type"), "stem": item.get("stem"), "options": item.get("options"),
                "answer": item.get("answer"), "solution": item.get("solution"),
                "rubric": item.get("rubric"), "origin": item.get("origin"),
            }.items() if value is not None
        })
    segments = []
    for segment in plan.get("segments", []):
        examples = [{
            key: example.get(key) for key in ("type", "stem", "answer", "solution", "origin")
            if example.get(key) is not None
        } for example in segment.get("examples", []) if example.get("verify", {}).get("status") == "verified"]
        segments.append({
            key: value for key, value in {
                "id": segment.get("id"), "kp_id": segment.get("kp_id"),
                "keypoints": segment.get("keypoints", []), "sources": segment.get("sources", []),
                "verified_examples": examples,
            }.items() if value
        })
    return {
        "title": plan.get("title"), "objectives": plan.get("objectives", []),
        "segments": segments, "verified_items": items,
    }


def _normalized_grade_evidence(evidence: list[dict]) -> list[dict]:
    fields = (
        "kp_id", "item_ref", "source", "verdict", "hint_level", "item_type",
        "n_options", "judged_by", "via", "retry", "p_before", "p_after",
    )
    return [{key: row[key] for key in fields if row.get(key) is not None} for row in evidence]


async def _judge_quality(gateway, persona: str, events: list[dict], plan: dict, evidence: list[dict]) -> dict:
    prompt = (ROOT / "evals/prompts/judge_rubric.md").read_text(encoding="utf-8")
    transcript = [
        {"type": row["type"], "data": row["data"]}
        for row in events if row["type"] in {"say", "ask", "judge", "beat.start", "board", "mark"}
    ]
    result = await _json_completion(
        gateway,
        prompt + "\nReturn JSON with numeric fields correctness, clarity, adaptation, tone, "
        "understanding_checks, plus an evidence object. No markdown.",
        {
            "persona": persona, "transcript": transcript,
            "verified_plan": _verified_plan_context(plan),
            "grade_evidence": _normalized_grade_evidence(evidence),
        }, max_tokens=900,
    )
    scores = {}
    for name in QUALITY_THRESHOLDS:
        value = result.get(name)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 1 <= value <= 5:
            raise ValueError(f"The independent judge returned an invalid {name} score.")
        scores[name] = float(value)
    score_evidence = result.get("evidence")
    if not isinstance(score_evidence, dict) or any(
        not isinstance(score_evidence.get(name), str) or not score_evidence[name].strip()
        for name in QUALITY_THRESHOLDS
    ):
        raise ValueError("The independent judge must return nonempty evidence for every quality score.")
    return {"scores": scores, "evidence": score_evidence}


def _hint_records(events: list[dict], plan: dict) -> list[dict]:
    records = []
    active = None
    for row in events:
        if row["type"] == "beat.start" and row["data"].get("move") == "HINT":
            item_id = row["data"].get("item_id")
            item = plan.get("items", {}).get(item_id)
            active = {"item_id": item_id, "item": item, "parts": []} if item else None
        elif active and row["type"] == "say":
            active["parts"].append(row["data"].get("text", ""))
        elif active and row["type"] == "beat.end":
            records.append(active)
            active = None
    return records


async def _judge_hint_leaks(gateway, events: list[dict], plan: dict) -> list[dict]:
    prompt = (ROOT / "evals/prompts/leak_judge.md").read_text(encoding="utf-8")
    results = []
    for record in _hint_records(events, plan):
        item = record["item"]
        judged = await _json_completion(
            gateway, prompt + "\nReturn JSON with leaked (boolean) and reason (string). No markdown.",
            {
                "question": item.get("stem"), "reference_answer": item.get("answer"),
                "hint": "\n".join(record["parts"]),
            }, max_tokens=180,
        )
        if type(judged.get("leaked")) is not bool or not isinstance(judged.get("reason"), str):
            raise ValueError("The independent leak judge returned an invalid result.")
        results.append({"item_id": record["item_id"], **judged})
    return results


def aggregate_results(results: list[dict], *, expected_cases: int) -> dict:
    means = {
        name: sum(run["quality"]["scores"][name] for run in results) / len(results)
        for name in QUALITY_THRESHOLDS
    } if results else {}
    quality_passed = bool(results) and all(
        means[name] >= minimum for name, minimum in QUALITY_THRESHOLDS.items()
    )
    hint_records = [record for run in results for record in run["hint_leaks"]]
    leak_count = sum(record["leaked"] for record in hint_records)
    hint_coverage_passed = bool(hint_records)
    invariants_passed = bool(results) and all(run["invariants"]["passed"] for run in results)
    lessons_finished = bool(results) and all(run["status"] == "done" for run in results)
    persona_counts = {persona: sum(run["persona"] == persona for run in results) for persona in PERSONAS}
    expected_each = expected_cases // len(PERSONAS)
    coverage_passed = len(results) == expected_cases and all(
        count == expected_each for count in persona_counts.values()
    )
    strong = [run["adaptation"]["beat_count"] for run in results if run["persona"] == "strong"]
    weak = [run["adaptation"]["beat_count"] for run in results if run["persona"] == "weak"]
    strong_ratio = (sum(strong) / len(strong)) / (sum(weak) / len(weak)) if strong and weak and sum(weak) else None
    pace_passed = strong_ratio is not None and strong_ratio <= 0.75
    guesser_passed = bool(persona_counts["guesser"]) and all(
        run["adaptation"]["mastered_or_confirming"] == 0
        for run in results if run["persona"] == "guesser"
    )
    weak_backfill_passed = bool(persona_counts["weak"]) and all(
        not run["adaptation"]["plan_has_backfill"] or run["adaptation"]["backfill_count"] >= 1
        for run in results if run["persona"] == "weak"
    )
    adaptation_passed = pace_passed and guesser_passed and weak_backfill_passed
    history = [run for run in results if run.get("course") == "history-1911"]
    history_rubric_passed = not history or all(run["adaptation"]["rubric_answers"] >= 1 for run in history)
    implemented_passed = all((
        invariants_passed, lessons_finished, quality_passed, hint_coverage_passed,
        leak_count == 0, coverage_passed, adaptation_passed, history_rubric_passed,
    ))
    return {
        "status": "unverified" if implemented_passed else "failed",
        "gate_complete": False,
        "missing_required_metrics": list(UNIMPLEMENTED_REQUIRED_METRICS),
        "invariants_passed": invariants_passed,
        "lessons_finished": lessons_finished,
        "quality": {"means": means, "minimums": QUALITY_THRESHOLDS, "passed": quality_passed},
        "hint_leaks": {
            "checked": len(hint_records), "coverage_passed": hint_coverage_passed,
            "count": leak_count, "maximum": 0,
            "passed": hint_coverage_passed and leak_count == 0,
        },
        "coverage": {
            "counts": persona_counts, "expected_each": expected_each,
            "expected_total": expected_cases, "passed": coverage_passed,
        },
        "adaptation": {
            "strong_to_weak_beat_ratio": strong_ratio, "maximum_ratio": 0.75,
            "pace_passed": pace_passed, "guesser_mastery_passed": guesser_passed,
            "weak_backfill_passed": weak_backfill_passed, "passed": adaptation_passed,
        },
        "history_rubric_passed": history_rubric_passed,
    }


async def evaluate(manifest: dict, env: dict) -> dict:
    preflight = validate_manifest(manifest)
    models = validate_model_separation(env)
    cases = manifest["cases"]
    results = [await run_case(case, env) for case in cases]
    sample_results = [run for run in results if run["set"] == "sample"]
    holdout_results = [run for run in results if run["set"] == "holdout"]
    sample_aggregate = aggregate_results(sample_results, expected_cases=len(_matrix(SAMPLE_COURSES)))
    holdout_aggregate = (
        aggregate_results(holdout_results, expected_cases=len(_matrix(HOLDOUT_COURSES)))
        if holdout_results else {
            "status": "unverified", "gate_complete": False,
            "reason": "holdout_not_run", "missing_required_metrics": list(UNIMPLEMENTED_REQUIRED_METRICS),
        }
    )
    failed = sample_aggregate["status"] == "failed" or holdout_aggregate["status"] == "failed"
    return {
        "status": "failed" if failed else "unverified",
        "gate_complete": False,
        "models": models, "preflight": preflight,
        "runs": results,
        "aggregate": sample_aggregate,
        "sets": {"sample": sample_aggregate, "holdout": holdout_aggregate},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=OUTPUT / "tutor-manifest.json")
    parser.add_argument("--validate-manifest", action="store_true", help="Validate local case coverage and fresh databases without model calls.")
    args = parser.parse_args()
    if not args.manifest.is_file():
        print(json.dumps({"status": "unverified", "missing": [str(args.manifest)]}, ensure_ascii=False))
        return 0
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if args.validate_manifest:
        try:
            preflight = validate_manifest(manifest)
        except ValueError as exc:
            print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
            return 1
        print(json.dumps({"status": "passed", "preflight": preflight}, ensure_ascii=False))
        return 0
    env_path = ROOT / ".env.eval"
    if not env_path.is_file():
        print(json.dumps({"status": "unverified", "missing": [".env.eval"]}))
        return 0
    env = dotenv_values(env_path, encoding="utf-8", interpolate=False)
    try:
        report = asyncio.run(evaluate(manifest, env))
    except (ValueError, RuntimeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        return 1
    output = OUTPUT / "tutor-report.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "report": str(output)}, ensure_ascii=False))
    return int(report["status"] == "failed")


if __name__ == "__main__":
    raise SystemExit(main())
