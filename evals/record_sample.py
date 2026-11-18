"""Capture a genuine finished text lesson and option feedback from an isolated sample analysis."""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import date
from pathlib import Path

from dotenv import dotenv_values

from app.analysis.results import CourseResults
from app.api.deps import build_container
from app.core.config import Settings
from app.llm.presets import RoleAssignment
from app.teaching.director import Director
from app.teaching.planner import LessonPlanner
from app.teaching.runtime import LessonRuntime, _item_for_ask

ROOT = Path(__file__).resolve().parents[1]
EVAL_DATA = ROOT / "evals/out/data"


async def _feedback(runtime: LessonRuntime, lesson: dict, plan: dict, ask: dict, item: dict) -> dict:
    state = lesson["state"]
    learner = runtime._learner()
    values = {}
    for option in item.get("options") or []:
        command = {"type": "student_answer", "item_id": ask["item_id"], "value": option["key"], "via": "control"}
        event = await runtime._understand(command, state, ask, item, plan)
        decision = Director.decide(state, event, learner, plan)
        context = runtime._context(lesson, plan, {**state, **decision.state_patch}, decision.args)
        lines = [
            row.data["text"]
            async for row in runtime.realizer.run(decision, context=context, board=lesson["board"] or {}, item=item)
            if row.type == "say" and row.data.get("text")
        ]
        if not lines:
            raise ValueError("No real feedback was generated for an option.")
        values[option["key"]] = lines
    return values


def _live_settings(container, env: dict) -> str:
    roles = container.providers.get_roles()
    model = env.get("EVAL_MODEL_LIVE") or env.get("EVAL_MODEL_ANALYSIS")
    if not model or "analysis" not in roles:
        raise ValueError("A completed sample analysis and live model are required.")
    connections = container.providers.list_connections()
    label = "EVAL2" if model.endswith("@2") else "EVAL"
    connection = next((entry for entry in connections if entry["label"] == label), None)
    if connection is None:
        raise ValueError("The evaluating connection for the live model is missing.")
    model = model.removesuffix("@2")
    container.providers.set_roles({**roles, "live": RoleAssignment(
        connection_id=connection["id"], model=model, params=json.loads(env.get("EVAL_EXTRA_BODY_LIVE") or "{}"),
    )})
    return model


async def record(container, course_id: str, kp_id: str, model: str, *, item_id: str | None = None) -> dict:
    repo = container.repository
    item_id = item_id or repo.create_point_lesson_item(course_id, kp_id, minutes=25)
    if item_id is None:
        raise ValueError("The sample knowledge point does not exist.")
    saved = repo.get_lesson_plan(course_id, item_id) or await LessonPlanner(repo, container.gateway).prepare(course_id, item_id)
    plan = saved["plan"]
    if not any(item["type"] == "choice" for item in plan["items"].values()):
        raise ValueError("Choose a sample lesson with verified single-choice questions.")
    opened = repo.create_or_resume_lesson(
        course_id, item_id, lesson_plan_id=saved["id"], character_id=None,
        state={"stage": "opening", "pace": "normal", "style_id": "guided"},
    )
    if opened is None or opened["status"] not in {"active", "done"}:
        raise ValueError("An active or completed recording lesson is required.")
    runtime = LessonRuntime(repo, container.gateway, course_id, opened["id"], jobs=container.jobs)
    checkpoint = container.settings.storage_root / f"replay-options-{opened['id']}.json"
    branches = json.loads(checkpoint.read_text(encoding="utf-8")) if checkpoint.is_file() else {}
    for _ in range(180):
        lesson = repo.get_lesson(course_id, opened["id"])
        if lesson["status"] == "done":
            break
        if not lesson["seq"]:
            await runtime.step({"type": "lesson_start"})
            continue
        state = lesson["state"]
        ask = state.get("active_ask")
        if not ask:
            await runtime.step({"type": "beat_done"})
            continue
        if ask["kind"] != "item":
            value = "continue"
            if ask["purpose"] == "probe":
                probed = _item_for_ask({"kind": "item", "item_id": state["item"]["id"]}, plan)
                value = probed["solution"]
            await runtime.step({"type": "ask_reply", "purpose": ask["purpose"], "value": value})
            continue
        item = _item_for_ask(ask, plan)
        emitted = repo.list_lesson_events(course_id, opened["id"], after=max(0, lesson["seq"] - 8))
        public = next((row for row in reversed(emitted) if row["type"] == "ask" and row["data"].get("item_id") == ask["item_id"]), None)
        if item is None or public is None:
            raise RuntimeError("The active question is missing its assessed item or public event.")
        if item["type"] != "choice" and not branches:
            quick = {"type": "quick_action", "kind": "skip"}
            verification = Director.decide(state, quick, runtime._learner(), plan)
            optional = _item_for_ask(verification.ask, plan)
            if (optional and optional["type"] == "choice"
                    and set(optional.get("keypoints", [])) <= set(range(state.get("kp_cursor", 0)))):
                await runtime.step(quick)
                continue
        if item.get("options") and item["type"] == "choice" and str(public["seq"]) not in branches:
            branches[str(public["seq"])] = await _feedback(runtime, lesson, plan, ask, item)
            staged = checkpoint.with_suffix(".tmp")
            staged.write_text(json.dumps(branches, ensure_ascii=False), encoding="utf-8")
            staged.replace(checkpoint)
        value = item["answer"]
        if item["type"] == "multi" and isinstance(value, str):
            value = [part.strip() for part in value.replace("，", ",").split(",") if part.strip()]
        await runtime.step({"type": "student_answer", "item_id": ask["item_id"], "value": value, "via": "control"})
    else:
        raise RuntimeError("The recorded lesson did not reach its natural end.")
    if not branches:
        raise RuntimeError("No check question with recorded option feedback was reached.")
    course = container.analysis.data.course(course_id)
    return {
        "schema_version": 1, "model": model, "recorded_at": date.today().isoformat(),
        "title": repo.get_plan_item(course_id, item_id)["title"],
        "course": course.name,
        "course_map": CourseResults(container.analysis.data).course_map(course_id).model_dump(mode="json"),
        "lesson_plan": plan,
        "events": repo.list_lesson_events(course_id, opened["id"]),
        "branches": branches,
        "recap": lesson["recap"],
    }


async def run(data: Path, target: Path, kp_id: str, course_id: str, env: dict) -> None:
    data = data.resolve()
    if not data.is_relative_to(EVAL_DATA.resolve()) or not (data / "companion.db").is_file():
        raise ValueError("Use an existing isolated evaluation database under evals/out/data.")
    container = build_container(Settings(COMPANION_DATA_DIR=str(data), _env_file=None))
    try:
        if not container.vault.bootstrap().unlocked:
            from getpass import getpass

            container.vault.unlock(getpass("Isolated evaluation vault password: "))
        model = _live_settings(container, env)
        replay = await record(container, course_id, kp_id, model)
    finally:
        await container.aclose()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(replay, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--course", required=True)
    parser.add_argument("--kp", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = ROOT / ".env.eval"
    env = dotenv_values(config, encoding="utf-8", interpolate=False) if config.is_file() else {}
    asyncio.run(run(args.data, args.output, args.kp, args.course, env))


if __name__ == "__main__":
    main()
