from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

State = Mapping[str, Any]
Event = Mapping[str, Any]
LessonPlan = Mapping[str, Any]
VALID_STYLES = frozenset({"guided", "direct", "analogy", "exam", "rigorous"})


@dataclass(frozen=True, slots=True)
class Decision:
    move: str | None
    args: dict[str, Any]
    ask: dict[str, Any] | None
    state_patch: dict[str, Any]


class Director:
    @staticmethod
    def decide(state: State, event: Event, learner: Mapping[str, Any], plan: LessonPlan) -> Decision:
        return decide(state, event, learner, plan)


def decide(state: State, event: Event, learner: Mapping[str, Any], plan: LessonPlan) -> Decision:
    """Return the next deterministic teaching action without mutating its inputs."""
    current = deepcopy(dict(state))
    event = _flatten_event(event)
    event_type = str(event.get("type", "unknown"))
    patch: dict[str, Any] = {}

    if event_type == "lesson_resume":
        if current.get("active_ask"):
            ask = deepcopy(current["active_ask"])
            ask.pop("asked_seq", None)
            ask["nudged"] = False
            return Decision(None, {"reissue_ask": True}, ask, {"active_ask": ask})
        event_type = "beat_done"

    if event_type == "interrupt":
        patch["heard"] = {"gen": event.get("gen", 0), "seq": event.get("heard_seq", 0)}
        pending = current.get("pending_beat")
        if pending and float(event.get("heard_fraction", 0)) >= 0.7:
            _commit_pending(current, patch)
        elif pending:
            patch["pending_beat"] = None
        return Decision(None, {}, None, patch)

    active_ask = current.get("active_ask")
    active_item = active_ask if isinstance(active_ask, Mapping) and active_ask.get("kind") == "item" else None

    if event_type == "student_answer" and (
        not active_item
        or event.get("item_id") != active_item.get("item_id")
        or active_item.get("item_id") in current.get("items_done", {})
    ):
        return Decision(None, {"judge": {"item_id": event.get("item_id"), "stale": True}}, None, {})

    if event_type == "time_up" or (event_type == "control" and event.get("action") == "end"):
        if current.get("stage") in {"wrap", "done"}:
            return Decision(None, {"finish": current.get("stage") == "done"}, None, {})
        if active_item:
            return Decision(None, {}, deepcopy(active_ask), {"wrap_pending": True})
        return _move("WRAP", patch={"stage": "wrap", "wrap_pending": False, "active_ask": None, "queued": []})

    action = _quick_action(event)
    if action in {"slower", "faster"} or action.startswith("style:"):
        if action.startswith("style:"):
            style_id = action.partition(":")[2]
            if style_id not in VALID_STYLES:
                return Decision(None, {"invalid_style": style_id}, None, {})
            patch["style_id"] = style_id
        else:
            pace = str(current.get("pace", "normal"))
            levels = ("slow", "normal", "fast")
            index = levels.index(pace) if pace in levels else 1
            index += -1 if action == "slower" else 1
            patch["pace"] = levels[max(0, min(index, len(levels) - 1))]
        _queue_resume(patch, current)
        return _move("ADJUST", args={"action": action}, patch=patch)
    if action == "break":
        _queue_resume(patch, current)
        return _move("BREAK", ask={"kind": "ack", "purpose": "break"}, patch=patch)
    if action == "show_answer" and active_item:
        return _show_solution(current, plan, active_item, patch)
    if action == "hint" and active_item:
        return _hint(current, active_item, patch)
    if action == "hint":
        action = "confused"
    if action == "confused":
        if current.get("stage") == "practice" and active_item:
            return _hint(current, active_item, patch)
        return _confused(current, learner, plan, patch)
    if action == "example":
        _queue_resume(patch, current)
        example = _unused_example(current, plan)
        if example:
            return _pending_move("EXAMPLE", current, {"example": example}, patch)
        return _reexplain(current, learner, plan, patch)
    if action == "repeat":
        _queue_resume(patch, current)
        return _pending_move("REPEAT", current, {}, patch)
    if action.startswith("locate:"):
        result = _reexplain(current, learner, plan, patch)
        return Decision(result.move, {**result.args, "target": action.partition(":")[2]}, result.ask, result.state_patch)
    if action == "skip":
        return _skip(current, learner, plan, patch)
    if action == "continue" and isinstance(active_ask, Mapping) and active_ask.get("purpose") == "break":
        return _ask_reply(current, {"purpose": "break", "value": "continue"}, learner, plan, patch)

    if event_type == "ask_reply":
        return _ask_reply(current, event, learner, plan, patch)

    if event_type == "student_utterance":
        intent = str(event.get("intent") or event.get("understanding", {}).get("intent", "unclear"))
        if intent == "question":
            _queue_resume(patch, current)
            patch.update({"offtopic_streak": 0, "unclear_streak": 0})
            return _move("ANSWER_QUESTION", args={"question": event.get("text")}, patch=patch)
        if intent == "confusion":
            return _confused(current, learner, plan, patch)
        if intent == "unclear":
            count = int(current.get("unclear_streak", 0)) + 1
            patch["unclear_streak"] = count
            return _move("CLARIFY" if count < 2 else "RESUME", args={"input_fallback": count >= 2}, ask=deepcopy(active_ask), patch=patch)
        count = int(current.get("offtopic_streak", 0)) + 1
        patch["offtopic_streak"] = count
        return _move("RESUME" if count < 3 else None, args={"offtopic": True}, ask=deepcopy(active_ask), patch=patch)

    if event_type == "silence" and active_ask:
        if not active_ask.get("nudged"):
            ask = deepcopy(active_ask)
            ask["nudged"] = True
            return _move("NUDGE", ask=deepcopy(active_ask), patch={"active_ask": ask})
        return Decision(None, {}, None, {"status": "paused"})

    if event_type == "student_answer":
        return _answer(current, event, learner, plan, patch)

    if event_type == "lesson_start" and current.get("stage") == "opening":
        prereq = _lowest_mastery_backfill(learner, plan)
        if prereq:
            item_id = prereq.get("check")
            ask = _item_ask(str(item_id), "prereq")
            return _move("OPEN", ask=ask, patch=_ask_patch(ask))
        return _move("OPEN")

    if event_type == "beat_done":
        _commit_pending(current, patch)
        current.update(deepcopy(patch))
        if not current.get("active_ask") and current.get("queued"):
            queued = deepcopy(current["queued"])
            next_decision = queued.pop(0)
            patch["queued"] = queued
            patch.update(deepcopy(next_decision.get("state_patch", {})))
            ask = deepcopy(next_decision.get("ask"))
            if ask is not None and not patch.get("active_ask"):
                patch["active_ask"] = {**ask, "nudged": False}
            return Decision(next_decision.get("move"), next_decision.get("args", {}), ask, patch)
        stage = current.get("stage")
        if stage == "opening":
            patch["stage"] = "teaching"
            current["stage"] = "teaching"
            return _teaching_next(current, learner, plan, patch)
        if stage == "teaching":
            return _teaching_next(current, learner, plan, patch)
        if stage == "practice":
            item_id = _next_practice(current, plan)
            if item_id:
                ask = _item_ask(item_id, "practice")
                item = _item_state(item_id, hint_level=1)
                return _move("PRACTICE_ITEM", args={"item_id": item_id}, ask=ask, patch={**patch, **_ask_patch(ask, item)})
            return _move("WRAP", patch={**patch, "stage": "wrap"})
        if stage == "wrap":
            return Decision(None, {"finish": True}, None, {**patch, "stage": "done"})
        if stage == "done":
            return Decision(None, {"finish": True}, None, patch)

    if active_ask:
        return _move("RESUME", ask=deepcopy(active_ask), patch=patch)
    return Decision(None, {"director_unmatched": True}, None, patch)


def _ask_reply(
    current: dict[str, Any],
    event: Event,
    learner: Mapping[str, Any],
    plan: LessonPlan,
    patch: dict[str, Any],
) -> Decision:
    active = current.get("active_ask")
    purpose = str(event.get("purpose", ""))
    if not isinstance(active, Mapping) or active.get("kind") == "item" or purpose != active.get("purpose"):
        return Decision(None, {"reply_stale": True, "purpose": purpose}, None, {})
    patch.update({"active_ask": None, "offtopic_streak": 0, "unclear_streak": 0})

    if purpose == "predict":
        approach = _next_approach(current, learner, plan)
        return _pending_move(
            "EXPLAIN",
            current,
            {
                "keypoint": current.get("kp_cursor", 0),
                "approach": approach,
                "prediction": event.get("value"),
            },
            patch,
        )

    if purpose == "summary":
        omissions = deepcopy(event.get("omissions", []))
        return _move(
            "TRANSITION",
            args={"summary_omissions": omissions},
            patch={
                **patch,
                "seg_idx": int(current.get("seg_idx", 0)) + 1,
                **_new_segment_patch(),
            },
        )

    if purpose == "probe":
        item = deepcopy(current.get("item") or {})
        item_id = str(item.get("id", event.get("item_id", "")))
        sound = event.get("reason_verdict") == "sound"
        evidence = {
            "record": True,
            "item_id": item_id,
            "purpose": "probe",
            "verdict": "correct" if sound else "partial",
            "hint_level": item.get("hint_level", 0),
        }
        item["evidence_deferred"] = False
        patch["item"] = item
        if sound:
            patch.update(
                {
                    "seg_clean_streak": int(current.get("seg_clean_streak", 0)) + 1,
                    "confusion_streak": 0,
                    "failed_items": 0,
                }
            )
            _queue_wrap_if_pending(current, patch)
            return _move("FEEDBACK_CORRECT", args={"evidence": evidence}, patch=patch)
        variant = _variant_for(item_id, current, plan)
        if variant:
            ask = _item_ask(variant, "check")
            patch["queued"] = [
                {
                    "move": "CHECK",
                    "args": {"item_id": variant},
                    "ask": ask,
                    "state_patch": _ask_patch(ask),
                }
            ]
        _queue_wrap_if_pending(current, patch)
        return _move("FEEDBACK_PARTIAL", args={"evidence": evidence, "explain_reason": True}, patch=patch)

    if purpose == "break":
        choice = str(event.get("value", "continue"))
        if choice in {"end", "today_end"}:
            return _move("WRAP", patch={**patch, "queued": [], "stage": "wrap", "wrap_pending": False})
        if choice == "easier":
            original = _queued_resume_ask(current)
            excluded = original.get("item_id") if original else None
            item_id = _select_check(current, plan, exclude={excluded} if excluded else set())
            if item_id:
                ask = _item_ask(item_id, "check")
                return _move(
                    "CHECK",
                    args={"item_id": item_id, "prefer_difficulty": 1},
                    ask=ask,
                    patch={**patch, "queued": [], **_ask_patch(ask)},
                )
            example = _unused_example(current, plan)
            if example:
                return _pending_move("EXAMPLE", current, {"example": example}, {**patch, "queued": []})
        resumed = _pop_queued(current, patch)
        if resumed:
            return resumed
        return Decision(None, {"continue": True}, None, patch)

    return Decision(None, {"reply_stale": True, "purpose": purpose}, None, {})


def _answer(current: dict[str, Any], event: Event, learner: Mapping[str, Any], plan: LessonPlan, patch: dict[str, Any]) -> Decision:
    active = deepcopy(current["active_ask"])
    purpose = str(active.get("purpose"))
    verdict = str(event.get("verdict", "incorrect"))
    item = deepcopy(current.get("item") or _item_state(str(active["item_id"])))
    first = item.get("first_verdict") is None
    item["attempts"] = int(item.get("attempts", 0)) + 1
    if first:
        item["first_verdict"] = verdict
    patch.update({"item": item, "offtopic_streak": 0, "unclear_streak": 0})
    evidence = {"record": first, "item_id": active["item_id"], "purpose": purpose, "verdict": verdict, "hint_level": item.get("hint_level", 0)}

    if purpose == "prereq":
        patch.update({"stage": "teaching", "active_ask": None})
        if verdict == "correct":
            return _move("FEEDBACK_CORRECT", args={"evidence": evidence}, patch=patch)
        return _move("BACKFILL", args={"kp_id": _item(plan, active["item_id"]).get("kp_id"), "evidence": evidence}, patch=patch)

    if purpose == "backfill":
        patch.update(
            {
                "active_ask": None,
                "backfill": None,
                "items_done": {
                    **current.get("items_done", {}),
                    active["item_id"]: "correct" if verdict == "correct" else "revealed",
                },
            }
        )
        if verdict == "correct":
            return _move("FEEDBACK_CORRECT", args={"evidence": evidence}, patch=patch)
        result = _show_solution(current, plan, active, patch)
        return Decision(result.move, {**result.args, "evidence": evidence}, result.ask, result.state_patch)

    if purpose == "verify_skip":
        patch["active_ask"] = None
        patch["skip_used"] = True
        if verdict == "correct":
            patch["segment_passed_by_skip"] = True
            return _move("FEEDBACK_CORRECT", args={"evidence": evidence}, patch=patch)
        return _move("ADJUST", args={"evidence": evidence}, patch=patch)

    if verdict == "correct":
        patch["items_done"] = {**current.get("items_done", {}), active["item_id"]: "correct"}
        patch["active_ask"] = None
        if first and int(item.get("hint_level", 0)) == 0:
            kp_id = _item(plan, active["item_id"]).get("kp_id")
            objective = _item(plan, active["item_id"]).get("type") in {"choice", "multi"}
            if objective and _mastery(learner, kp_id) < 0.6 and not current.get("probed_seg"):
                item["evidence_deferred"] = True
                patch.update({"item": item, "probed_seg": True})
                return _move("PROBE", args={"evidence": {**evidence, "record": False}}, ask={"kind": "open", "purpose": "probe"}, patch=patch)
            patch.update({"seg_clean_streak": int(current.get("seg_clean_streak", 0)) + 1, "confusion_streak": 0, "failed_items": 0})
        _queue_wrap_if_pending(current, patch)
        return _move("FEEDBACK_CORRECT", args={"evidence": evidence}, patch=patch)

    if verdict == "partial" and int(item["attempts"]) < 2:
        return _move("FEEDBACK_PARTIAL", args={"evidence": evidence}, ask=active, patch=patch)

    patch["seg_clean_streak"] = 0
    next_level = int(item.get("hint_level", 0)) + 1
    if verdict == "dont_know":
        next_level = max(next_level, 2)
    if next_level <= 2:
        item["hint_level"] = next_level
        patch["item"] = item
        return _move("HINT", args={"item_id": active["item_id"], "level": next_level, "evidence": evidence}, ask=active, patch=patch)
    result = _show_solution(current, plan, active, patch)
    return Decision(result.move, {**result.args, "evidence": evidence}, result.ask, result.state_patch)


def _teaching_next(current: dict[str, Any], learner: Mapping[str, Any], plan: LessonPlan, patch: dict[str, Any]) -> Decision:
    segments = plan.get("segments", [])
    seg_idx = int(current.get("seg_idx", 0))
    if seg_idx >= len(segments):
        item_id = _next_practice(current, plan)
        if item_id:
            ask = _item_ask(item_id, "practice")
            item = _item_state(item_id, hint_level=1)
            return _move("PRACTICE_ITEM", args={"item_id": item_id}, ask=ask, patch={**patch, "stage": "practice", **_ask_patch(ask, item)})
        return _move("WRAP", patch={**patch, "stage": "wrap"})
    segment = segments[seg_idx]
    if int(current.get("explains_since_check", 0)) >= 1:
        latest_keypoint = int(current.get("kp_cursor", 0)) - 1
        item_id = _select_check(
            current,
            plan,
            prefer_keypoint=latest_keypoint if latest_keypoint >= 0 else None,
        )
        if item_id:
            ask = _item_ask(item_id, "check")
            return _move("CHECK", args={"item_id": item_id}, ask=ask, patch={**patch, "explains_since_check": 0, **_ask_patch(ask)})
    cursor = int(current.get("kp_cursor", 0))
    keypoints = segment.get("keypoints", [])
    if cursor < len(keypoints):
        if cursor == 0 and not current.get("skip_used") and _mastery(learner, segment.get("kp_id")) >= 0.7:
            item_id = _select_check(current, plan, allow_all_keypoints=True, objective_only=True, highest=True)
            if item_id:
                ask = _item_ask(item_id, "verify_skip")
                return _move("VERIFY_SKIP", args={"item_id": item_id}, ask=ask, patch={**patch, **_ask_patch(ask)})
        if current.get("style_id") == "guided" and _mastery(learner, segment.get("kp_id")) >= 0.4 and not current.get("predicted_kp"):
            return _move("PREDICT", ask={"kind": "open", "purpose": "predict"}, patch={**patch, "predicted_kp": True})
        approach = _next_approach(current, learner, plan)
        return _pending_move("EXPLAIN", current, {"keypoint": cursor, "approach": approach}, patch)
    if int(current.get("seg_clean_streak", 0)) >= 2:
        return _move("TRANSITION", patch={**patch, "seg_idx": seg_idx + 1, **_new_segment_patch()})
    item_id = _select_check(current, plan)
    if item_id:
        ask = _item_ask(item_id, "check")
        return _move("CHECK", args={"item_id": item_id}, ask=ask, patch={**patch, **_ask_patch(ask)})
    return _move("TRANSITION", args={"needs_practice": True}, patch={**patch, "seg_idx": seg_idx + 1, **_new_segment_patch()})


def _confused(current: dict[str, Any], learner: Mapping[str, Any], plan: LessonPlan, patch: dict[str, Any]) -> Decision:
    count = int(current.get("confusion_streak", 0)) + 1
    patch["confusion_streak"] = count
    _queue_resume(patch, current)
    segment = _segment(current, plan)
    if count == 3:
        candidates = [entry for entry in segment.get("backfills", []) if entry.get("kp_id") not in current.get("backfilled", [])]
        if candidates:
            backfill = min(candidates, key=lambda entry: _mastery(learner, entry.get("kp_id")))
            item_id = str(backfill["check"])
            ask = _item_ask(item_id, "backfill")
            patch.update({"backfilled": [*current.get("backfilled", []), backfill["kp_id"]], "backfill": {"kp_id": backfill["kp_id"], "return": {"seg_idx": current.get("seg_idx", 0), "kp_cursor": current.get("kp_cursor", 0), "item_id": (current.get("active_ask") or {}).get("item_id")}}, **_ask_patch(ask)})
            return _move("BACKFILL", args={"kp_id": backfill["kp_id"]}, ask=ask, patch=patch)
    return _reexplain(current, learner, plan, patch)


def _reexplain(current: dict[str, Any], learner: Mapping[str, Any], plan: LessonPlan, patch: dict[str, Any]) -> Decision:
    approach = _next_approach(current, learner, plan)
    if approach.get("kind") in current.get("approaches_used", []):
        patch["approaches_used"] = []
    return _pending_move("REEXPLAIN", current, {"approach": approach}, patch)


def _hint(current: dict[str, Any], active_item: Mapping[str, Any], patch: dict[str, Any]) -> Decision:
    item = deepcopy(current.get("item") or _item_state(str(active_item["item_id"])))
    level = int(item.get("hint_level", 0))
    if level >= 2:
        return _move("RESUME", args={"hint_limit": True}, ask=deepcopy(active_item), patch=patch)
    item["hint_level"] = level + 1
    patch["item"] = item
    return _move("HINT", args={"item_id": active_item["item_id"], "level": level + 1}, ask=deepcopy(active_item), patch=patch)


def _show_solution(current: dict[str, Any], plan: LessonPlan, active_item: Mapping[str, Any], patch: dict[str, Any]) -> Decision:
    item_id = str(active_item["item_id"])
    item = deepcopy(current.get("item") or _item_state(item_id))
    first = item.get("first_verdict") is None
    if first:
        item["first_verdict"] = "revealed"
    evidence = {
        "record": first,
        "item_id": item_id,
        "purpose": active_item.get("purpose"),
        "verdict": "revealed",
        "hint_level": item.get("hint_level", 0),
    }
    patch.update(
        {
            "active_ask": None,
            "item": item,
            "items_done": {**current.get("items_done", {}), item_id: "revealed"},
            "failed_items": int(current.get("failed_items", 0)) + 1,
        }
    )
    variant = (
        None
        if current.get("wrap_pending") or active_item.get("purpose") in {"backfill", "prereq"}
        else _variant_for(item_id, current, plan)
    )
    failed_items = int(patch["failed_items"])
    if failed_items >= 2 and not current.get("wrap_pending"):
        break_ask = {"kind": "ack", "purpose": "break"}
        queued = [
            {
                "move": "BREAK",
                "args": {},
                "ask": break_ask,
                "state_patch": {"active_ask": {**break_ask, "nudged": False}},
            }
        ]
        if variant:
            ask = _item_ask(variant, "check")
            queued.append(
                {
                    "move": "CHECK",
                    "args": {"item_id": variant, "prefer_difficulty": 1},
                    "ask": ask,
                    "state_patch": _ask_patch(ask),
                }
            )
        patch["queued"] = queued
    elif variant:
        ask = _item_ask(variant, "check")
        patch["queued"] = [{"move": "CHECK", "args": {"item_id": variant}, "ask": ask, "state_patch": _ask_patch(ask)}]
    _queue_wrap_if_pending(current, patch)
    return _move("SHOW_SOLUTION", args={"item_id": item_id, "evidence": evidence}, patch=patch)


def _skip(current: dict[str, Any], learner: Mapping[str, Any], plan: LessonPlan, patch: dict[str, Any]) -> Decision:
    if current.get("stage") == "teaching" and not current.get("skip_used"):
        item_id = _select_check(current, plan, allow_all_keypoints=True, objective_only=True, highest=True)
        if item_id:
            ask = _item_ask(item_id, "verify_skip")
            return _move("VERIFY_SKIP", args={"item_id": item_id}, ask=ask, patch={**patch, **_ask_patch(ask)})
    if current.get("stage") == "practice" and current.get("active_ask"):
        item_id = current["active_ask"]["item_id"]
        return _move(None, patch={"items_done": {**current.get("items_done", {}), item_id: "skipped"}, "active_ask": None})
    return _move("ADJUST", args={"skip_denied": True}, patch=patch)


def _commit_pending(current: dict[str, Any], patch: dict[str, Any]) -> None:
    pending = current.get("pending_beat")
    if not pending:
        return
    move = pending.get("move")
    patch["pending_beat"] = None
    patch["explains_since_check"] = int(current.get("explains_since_check", 0)) + 1
    if move != "REPEAT" and pending.get("kind"):
        patch["approaches_used"] = [*current.get("approaches_used", []), pending["kind"]]
    if move == "EXAMPLE" and pending.get("example_id"):
        patch["examples_used"] = [*current.get("examples_used", []), pending["example_id"]]
    if move == "EXPLAIN":
        patch["kp_cursor"] = int(current.get("kp_cursor", 0)) + 1


def _pending_move(move: str, current: dict[str, Any], args: dict[str, Any], patch: dict[str, Any]) -> Decision:
    pending: dict[str, Any] = {"move": move}
    approach = args.get("approach")
    if isinstance(approach, Mapping):
        pending.update({"kind": approach.get("kind"), "keypoint": current.get("kp_cursor", 0)})
    example = args.get("example")
    if isinstance(example, Mapping):
        pending["example_id"] = example.get("id")
    patch["pending_beat"] = pending
    return _move(move, args=args, patch=patch)


def _select_check(
    current: Mapping[str, Any],
    plan: LessonPlan,
    *,
    allow_all_keypoints: bool = False,
    objective_only: bool = False,
    highest: bool = False,
    exclude: set[str] | None = None,
    prefer_keypoint: int | None = None,
) -> str | None:
    segment = _segment(current, plan)
    taught = set(range(len(segment.get("keypoints", [])))) if allow_all_keypoints else set(range(int(current.get("kp_cursor", 0))))
    candidates = []
    for item_id in segment.get("checks", []):
        item = _item(plan, item_id)
        if (
            item_id in current.get("items_done", {})
            or str(item_id) in (exclude or set())
            or item.get("verify", {}).get("status") != "verified"
        ):
            continue
        if objective_only and item.get("type") not in {"choice", "multi", "numeric", "short"}:
            continue
        if set(item.get("keypoints", [])) <= taught:
            candidates.append((int(item.get("difficulty", 1)), str(item_id)))
    if not candidates:
        return None
    if prefer_keypoint is not None:
        preferred = [candidate for candidate in candidates if prefer_keypoint in set(_item(plan, candidate[1]).get("keypoints", []))]
        if preferred:
            candidates = preferred
    candidates.sort(reverse=highest)
    return candidates[0][1]


def _next_approach(current: Mapping[str, Any], learner: Mapping[str, Any], plan: LessonPlan) -> dict[str, Any]:
    cursor = int(current.get("kp_cursor", 0))
    approaches = [entry for entry in _segment(current, plan).get("approaches", []) if entry.get("keypoint") in {"all", cursor}]
    used = set(current.get("approaches_used", []))
    available = [entry for entry in approaches if entry.get("kind") not in used]
    pool = available or approaches
    stats = learner.get("approach_stats", {})
    return deepcopy(max(pool, key=lambda entry: _approach_score(stats.get(entry.get("kind"), {})), default={"kind": "intuition", "keypoint": cursor}))


def _approach_score(stats: Any) -> float:
    if not isinstance(stats, Mapping) or not stats.get("n"):
        return 0.0
    return float(stats.get("success", 0)) / float(stats["n"])


def _unused_example(current: Mapping[str, Any], plan: LessonPlan) -> dict[str, Any] | None:
    used = set(current.get("examples_used", []))
    for example in _segment(current, plan).get("examples", []):
        if example.get("id") not in used and example.get("verify", {}).get("status") == "verified":
            return deepcopy(example)
    return None


def _variant_for(item_id: str, current: Mapping[str, Any], plan: LessonPlan) -> str | None:
    taught = set(range(int(current.get("kp_cursor", 0))))
    allowed: set[str] | None = None
    if current.get("stage") == "teaching":
        checks = _segment(current, plan).get("checks")
        if isinstance(checks, list) and checks:
            allowed = {str(check_id) for check_id in checks}
    for candidate_id, candidate in plan.get("items", {}).items():
        candidate_taught = taught
        if current.get("stage") == "practice":
            candidate_segment = next(
                (segment for segment in plan.get("segments", []) if segment.get("kp_id") == candidate.get("kp_id")),
                {},
            )
            candidate_taught = set(range(len(candidate_segment.get("keypoints", []))))
        if (
            candidate.get("variant_of") == item_id
            and candidate_id not in current.get("items_done", {})
            and (allowed is None or str(candidate_id) in allowed)
            and candidate.get("verify", {}).get("status") == "verified"
            and set(candidate.get("keypoints", [])) <= candidate_taught
        ):
            return str(candidate_id)
    return None


def _lowest_mastery_backfill(learner: Mapping[str, Any], plan: LessonPlan) -> Mapping[str, Any] | None:
    segments = plan.get("segments", [])
    backfills = segments[0].get("backfills", []) if segments else []
    return min(backfills, key=lambda entry: _mastery(learner, entry.get("kp_id")), default=None)


def _mastery(learner: Mapping[str, Any], kp_id: Any) -> float:
    value = learner.get("mastery", {}).get(kp_id, 0.0)
    return float(value.get("p", 0.0) if isinstance(value, Mapping) else value)


def _next_practice(current: Mapping[str, Any], plan: LessonPlan) -> str | None:
    return next((str(item_id) for item_id in plan.get("practice", []) if item_id not in current.get("items_done", {})), None)


def _segment(current: Mapping[str, Any], plan: LessonPlan) -> Mapping[str, Any]:
    segments = plan.get("segments", [])
    index = int(current.get("seg_idx", 0))
    return segments[index] if 0 <= index < len(segments) else {}


def _item(plan: LessonPlan, item_id: Any) -> Mapping[str, Any]:
    return plan.get("items", {}).get(str(item_id), {})


def _item_ask(item_id: str, purpose: str) -> dict[str, Any]:
    return {"kind": "item", "item_id": item_id, "purpose": purpose}


def _item_state(item_id: str, *, hint_level: int = 0) -> dict[str, Any]:
    return {"id": item_id, "hint_level": hint_level, "attempts": 0, "first_verdict": None, "evidence_deferred": False}


def _ask_patch(ask: Mapping[str, Any], item: Mapping[str, Any] | None = None) -> dict[str, Any]:
    active = {**ask, "nudged": False}
    return {"active_ask": active, "item": deepcopy(item or _item_state(str(ask["item_id"])))}


def _queue_resume(patch: dict[str, Any], current: Mapping[str, Any]) -> None:
    active = current.get("active_ask")
    if not active:
        return
    queued = [entry for entry in current.get("queued", []) if entry.get("move") != "RESUME"]
    patch["queued"] = [{"move": "RESUME", "args": {}, "ask": deepcopy(active), "state_patch": {}}, *queued]
    patch["active_ask"] = None


def _queued_resume_ask(current: Mapping[str, Any]) -> dict[str, Any] | None:
    for entry in current.get("queued", []):
        if entry.get("move") == "RESUME" and isinstance(entry.get("ask"), Mapping):
            return deepcopy(entry["ask"])
    return None


def _pop_queued(current: Mapping[str, Any], patch: dict[str, Any]) -> Decision | None:
    queued = deepcopy(current.get("queued", []))
    if not queued:
        return None
    entry = queued.pop(0)
    ask = deepcopy(entry.get("ask"))
    patch["queued"] = queued
    patch.update(deepcopy(entry.get("state_patch", {})))
    if ask is not None and not patch.get("active_ask"):
        patch["active_ask"] = {**ask, "nudged": False}
    return Decision(entry.get("move"), entry.get("args", {}), ask, patch)


def _queue_wrap_if_pending(current: Mapping[str, Any], patch: dict[str, Any]) -> None:
    if not current.get("wrap_pending"):
        return
    patch["queued"] = [
        {"move": "WRAP", "args": {}, "ask": None, "state_patch": {"stage": "wrap"}}
    ]
    patch["wrap_pending"] = False


def _new_segment_patch() -> dict[str, Any]:
    return {"kp_cursor": 0, "seg_clean_streak": 0, "explains_since_check": 0, "seg_active_ms": 0, "approaches_used": [], "examples_used": [], "confusion_streak": 0, "probed_seg": False, "skip_used": False}


def _move(move: str | None, *, args: dict[str, Any] | None = None, ask: dict[str, Any] | None = None, patch: dict[str, Any] | None = None) -> Decision:
    state_patch = patch or {}
    if ask is not None and not state_patch.get("active_ask"):
        state_patch["active_ask"] = {**ask, "nudged": False}
    return Decision(move, args or {}, ask, state_patch)


def _flatten_event(event: Event) -> dict[str, Any]:
    result = dict(event)
    data = result.pop("data", None)
    if isinstance(data, Mapping):
        result.update(data)
    return result


def _quick_action(event: Mapping[str, Any]) -> str:
    if event.get("type") != "quick_action":
        return ""
    return str(event.get("kind", ""))
