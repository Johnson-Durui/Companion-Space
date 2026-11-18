from __future__ import annotations

import argparse
import asyncio
from getpass import getpass
from sys import stderr
from time import monotonic

from app.api.deps import build_container
from app.core.config import get_settings
from app.learning.styles import STYLE_IDS, initial_lesson_style
from app.providers.errors import ProviderError
from app.services.settings_store import get_setting
from app.services.tutor_catalog import StyleId
from app.services.vault import VaultError
from app.teaching.planner import LessonPlanner
from app.teaching.runtime import LessonRuntime
from app.teaching.sim_student import PERSONAS, SimulatedStudent
from app.teaching.timers import due_timer_event, lesson_time_limit_ms, silence_delay_ms
from app.teaching.understanding import InvalidAnswer

_ACTIONS = ("confused", "example", "hint", "show_answer", "repeat", "skip", "slower", "faster", "break")


def _event(line: str, state: dict) -> dict | None:
    ask = state.get("active_ask") or {}
    if not line:
        return None if ask else {"type": "beat_done"}
    if line in {":pause", ":end"}:
        return {"type": "control", "action": line[1:]}
    if line == ":dont_know" and ask.get("kind") == "item":
        return {"type": "student_answer", "item_id": ask["item_id"], "dont_know": True, "via": "control"}
    if line.startswith(":ask "):
        return {"type": "student_utterance", "intent": "question", "text": line[5:].strip()}
    if line.startswith(":"):
        action = line[1:]
        if action in _ACTIONS or action.startswith("style:"):
            return {"type": "quick_action", "kind": action}
        raise InvalidAnswer("Unknown command. Use :help to list commands.")
    if ask.get("kind") == "item":
        return {"type": "student_answer", "item_id": ask["item_id"], "value": line, "via": "control"}
    if ask:
        return {"type": "ask_reply", "purpose": ask["purpose"], "value": line}
    return {"type": "student_utterance", "text": line}


def _print_events(events: list[dict]) -> None:
    for event in events:
        data = event["data"]
        match event["type"]:
            case "say":
                print(data["text"])
            case "board" if data["op"] != "clear":
                print(data.get("title", ""), data.get("content", "") or data.get("spec", ""))
            case "ask" if data.get("widget"):
                widget = data["widget"]
                print(widget["stem"])
                for option in widget["options"]:
                    print(f'  {option["key"]}. {option["text"]}')
            case "ask" if data.get("purpose") == "break":
                print("continue / easier / end")
            case "judge" if "correct_answer" in data:
                print(data["correct_answer"])


async def _wait_for_line(runtime: LessonRuntime, lesson: dict, plan: dict, limit_ms: int) -> tuple[str | None, int]:
    reading = asyncio.create_task(asyncio.to_thread(input, "You > "))
    while True:
        state = lesson["state"]
        ask = state.get("active_ask")
        item = plan["items"].get(ask.get("item_id"), {}) if ask else {}
        delay = silence_delay_ms(ask, item.get("type"))
        active_ms = state.get("active_ms", 0)
        waits = [delay] if delay is not None else []
        stage = state.get("stage", "opening")
        time_sent = state.get("time_up_sent", False)
        if stage in {"opening", "teaching", "practice"} and not time_sent and (ask or "playback_after_seq" in state):
            waits.append(max(0, limit_ms - active_ms))
        started = monotonic()
        done, _ = await asyncio.wait({reading}, timeout=min(waits) / 1000 if waits else None)
        elapsed_ms = round((monotonic() - started) * 1000)
        if done:
            return reading.result().strip(), elapsed_ms
        elapsed_ms = max(elapsed_ms, min(waits))
        due = due_timer_event(
            stage=stage, active_ask=ask, item_type=item.get("type"),
            waiting_ms=elapsed_ms, active_ms=active_ms + elapsed_ms,
            time_limit_ms=limit_ms, time_up_sent=time_sent,
        )
        if due is None:
            return (await reading).strip(), elapsed_ms
        _print_events(await runtime.step({"type": due}, elapsed_ms=elapsed_ms))
        lesson = await asyncio.to_thread(runtime.repository.get_lesson, runtime.space_id, runtime.lesson_id)
        if lesson["status"] == "paused":
            print("Paused. Press Enter to resume.")
            await reading
            return None, 0


async def _run(args: argparse.Namespace) -> None:
    container = await asyncio.to_thread(build_container, get_settings())
    repository = container.repository
    try:
        reader = repository.get_lesson if args.lesson else repository.get_plan_item
        reference = args.lesson or args.prepare
        course_ids = [args.course] if args.course else [
            space.id for space in await asyncio.to_thread(repository.list_spaces)
        ]
        for course_id in course_ids:
            found = await asyncio.to_thread(reader, course_id, reference)
            if found is not None:
                break
        else:
            raise ValueError("The requested classroom or study plan item was not found.")

        if args.prepare and found["lesson_id"]:
            args.lesson = found["lesson_id"]
            found = await asyncio.to_thread(repository.get_lesson, course_id, args.lesson)
        if args.lesson and found["status"] in {"done", "abandoned"}:
            print(f'{found["id"]} · {found["status"]}')
            if found["recap"]:
                print(found["recap"]["summary"])
            return

        vault_status = await asyncio.to_thread(container.vault.bootstrap)
        if not vault_status.unlocked:
            password = await asyncio.to_thread(getpass, "Vault password: ")
            await asyncio.to_thread(container.vault.unlock, password)
        if args.prepare and not args.lesson:
            ready = await asyncio.to_thread(repository.get_lesson_plan, course_id, reference)
            if ready is None:
                ready = await LessonPlanner(repository, container.gateway).prepare(course_id, reference)
            profile = await asyncio.to_thread(repository.get_learner_profile)
            character = await asyncio.to_thread(get_setting, repository, "default_character_id", None)
            tutor = await asyncio.to_thread(container.tutors.get_character, character) if character else None
            explicit_fields = await asyncio.to_thread(
                get_setting, repository, "learner_profile_explicit_fields", None,
            )
            raw_plan_style = ready["plan"].get("style_id")
            plan_style: StyleId | None = (
                raw_plan_style if isinstance(raw_plan_style, str) and raw_plan_style in STYLE_IDS else None
            )
            found = await asyncio.to_thread(
                repository.create_or_resume_lesson, course_id, reference, lesson_plan_id=ready["id"],
                state={
                    "stage": "opening", "pace": profile.get("pace", "normal") if profile else "normal",
                    "style_id": initial_lesson_style(
                        profile=profile, tutor=tutor, explicit_profile_fields=explicit_fields, plan_style=plan_style,
                    ),
                },
                character_id=character,
            )
            if found is None:
                raise ValueError("A prepared plan is required before class can begin.")

        lesson_id = found["id"]
        runtime = LessonRuntime(repository, container.gateway, course_id, lesson_id, jobs=container.jobs)
        saved = await asyncio.to_thread(
            repository.get_lesson_plan, course_id, found["plan_item_id"], lesson_plan_id=found["lesson_plan_id"],
        )
        if saved is None:
            raise ValueError("The verified plan for this classroom is unavailable.")
        plan = saved["plan"]
        simulator = SimulatedStudent(args.student.removeprefix("sim:")) if args.student.startswith("sim:") else None
        enrollment = await asyncio.to_thread(repository.get_course_enrollment, course_id) or {}
        limit_ms = lesson_time_limit_ms(enrollment.get("session_minutes", 30), plan["est_minutes"])
        print(f"Lesson {lesson_id} · :help for commands")
        event = {"type": "lesson_resume" if found["seq"] or found["status"] == "paused" else "lesson_start"}
        elapsed_ms = 0
        turns = 0
        while True:
            if event:
                try:
                    _print_events(await runtime.step(event, elapsed_ms=elapsed_ms))
                except InvalidAnswer as exc:
                    print(str(exc), file=stderr)
            found = await asyncio.to_thread(repository.get_lesson, course_id, lesson_id)
            if found["status"] != "active":
                print(found["status"])
                if found["recap"]:
                    print(found["recap"]["summary"])
                return
            if simulator is not None:
                turns += 1
                if turns > args.max_turns:
                    await runtime.step({"type": "control", "action": "pause"})
                    raise ValueError("The simulated student exceeded the turn limit.")
                event = simulator.next_event(found["state"], plan)
                elapsed_ms = 1_000
                continue
            try:
                line, elapsed_ms = await _wait_for_line(runtime, found, plan, limit_ms)
            except EOFError:
                current = await asyncio.to_thread(repository.get_lesson, course_id, lesson_id)
                if current["status"] == "active":
                    await runtime.step({"type": "control", "action": "pause"})
                return
            if line is None:
                event = {"type": "lesson_resume"}
                continue
            found = await asyncio.to_thread(repository.get_lesson, course_id, lesson_id)
            if line == ":help":
                print("Enter advances the explanation. Type an answer when asked.")
                print(":" + "  :".join((*_ACTIONS, "style:<id>", "ask <question>", "dont_know", "pause", "end")))
                event = None
                continue
            try:
                event = _event(line, found["state"])
            except InvalidAnswer as exc:
                print(str(exc), file=stderr)
                event = None
    finally:
        await container.aclose()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a prepared Companion Space text lesson.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--lesson", help="Resume a lesson by ID")
    target.add_argument("--prepare", metavar="PLAN_ITEM", help="Prepare and open an existing lesson plan item")
    parser.add_argument("--course", help="Limit the lookup to this course ID")
    parser.add_argument("--student", default="human", help="human or sim:<strong|weak|confused|guesser|answer_seeker>")
    parser.add_argument("--max-turns", type=int, default=200)
    args = parser.parse_args()
    if args.student != "human" and args.student not in {f"sim:{persona}" for persona in PERSONAS}:
        parser.error("--student must be human or sim:<strong|weak|confused|guesser|answer_seeker>")
    if args.student.startswith("sim:"):
        root = get_settings().repo_root.resolve()
        data = get_settings().storage_root.resolve()
        evaluation_root = (root / "evals/out/data").resolve()
        if not data.is_relative_to(evaluation_root):
            parser.error("simulated students require COMPANION_DATA_DIR under evals/out/data/<run>/<persona>")
    try:
        asyncio.run(_run(args))
    except ProviderError as exc:
        print(exc.public_detail, file=stderr)
        return 1
    except (ValueError, VaultError) as exc:
        print(str(exc), file=stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
