from __future__ import annotations

from copy import deepcopy

import pytest

from app.teaching.director import Decision, decide


def _state(**changes: object) -> dict[str, object]:
    state: dict[str, object] = {
        "stage": "opening",
        "seg_idx": 0,
        "kp_cursor": 0,
        "explains_since_check": 0,
        "approaches_used": [],
        "examples_used": [],
        "active_ask": None,
        "item": None,
        "items_done": {},
        "seg_clean_streak": 0,
        "probed_seg": False,
        "skip_used": False,
        "predicted_kp": False,
        "confusion_streak": 0,
        "offtopic_streak": 0,
        "unclear_streak": 0,
        "failed_items": 0,
        "backfilled": [],
        "backfill": None,
        "pending_beat": None,
        "queued": [],
        "wrap_pending": False,
        "pace": "normal",
        "style_id": "direct",
    }
    state.update(changes)
    return state


@pytest.fixture
def plan() -> dict[str, object]:
    return {
        "segments": [
            {
                "id": "s1",
                "kp_id": "kp1",
                "est_minutes": 5,
                "keypoints": ["first", "second"],
                "approaches": [
                    {"kind": "intuition", "keypoint": "all", "outline": "i"},
                    {"kind": "visual", "keypoint": 0, "outline": "v"},
                    {"kind": "formal", "keypoint": "all", "outline": "f"},
                    {"kind": "contrast", "keypoint": 0, "outline": "c"},
                ],
                "examples": [
                    {"id": "e1", "keypoint": 0, "verify": {"status": "verified"}},
                ],
                "checks": ["c1", "c2", "c3"],
                "backfills": [{"kp_id": "pre", "check": "b1"}],
            }
        ],
        "practice": ["p1"],
        "items": {
            "b1": {"kp_id": "pre", "type": "choice", "difficulty": 1, "verify": {"status": "verified"}},
            "c1": {"kp_id": "kp1", "keypoints": [0], "type": "choice", "difficulty": 1, "verify": {"status": "verified"}},
            "c2": {"kp_id": "kp1", "keypoints": [0], "type": "choice", "difficulty": 1, "variant_of": "c1", "verify": {"status": "verified"}},
            "c3": {"kp_id": "kp1", "keypoints": [0, 1], "type": "short", "difficulty": 2, "verify": {"status": "verified"}},
            "p1": {"kp_id": "kp1", "keypoints": [0, 1], "type": "numeric", "difficulty": 2, "verify": {"status": "verified"}},
        },
    }


def test_decide_is_pure_and_opening_uses_lowest_mastery_prerequisite(plan: dict[str, object]) -> None:
    state = _state()
    original = deepcopy(state)

    result = decide(state, {"type": "lesson_start"}, {"mastery": {"pre": 0.2}}, plan)

    assert state == original
    assert result == Decision(
        move="OPEN",
        args={},
        ask={"kind": "item", "item_id": "b1", "purpose": "prereq"},
        state_patch={"active_ask": {"kind": "item", "item_id": "b1", "purpose": "prereq", "nudged": False}, "item": {"id": "b1", "hint_level": 0, "attempts": 0, "first_verdict": None, "evidence_deferred": False}},
    )


def test_teaching_commits_pending_explanation_then_checks(plan: dict[str, object]) -> None:
    state = _state(
        stage="teaching",
        pending_beat={"move": "EXPLAIN", "kind": "visual", "keypoint": 0},
    )

    result = decide(state, {"type": "beat_done"}, {"mastery": {"kp1": 0.3}}, plan)

    assert result.move == "CHECK"
    assert result.ask == {"kind": "item", "item_id": "c1", "purpose": "check"}
    assert result.state_patch["kp_cursor"] == 1
    assert result.state_patch["approaches_used"] == ["visual"]
    assert result.state_patch["explains_since_check"] == 0


def test_teaching_checks_the_just_explained_keypoint_before_older_unused_checks(plan: dict[str, object]) -> None:
    state = _state(
        stage="teaching",
        kp_cursor=1,
        pending_beat={"move": "EXPLAIN", "kind": "formal", "keypoint": 1},
    )

    result = decide(state, {"type": "beat_done"}, {"mastery": {"kp1": 0.3}}, plan)

    assert result.move == "CHECK"
    assert result.ask == {"kind": "item", "item_id": "c3", "purpose": "check"}


def test_teaching_falls_back_to_an_older_eligible_check_when_latest_has_none(plan: dict[str, object]) -> None:
    plan["segments"][0]["checks"] = ["c1", "c2"]
    state = _state(
        stage="teaching",
        kp_cursor=1,
        pending_beat={"move": "EXPLAIN", "kind": "formal", "keypoint": 1},
    )

    result = decide(state, {"type": "beat_done"}, {"mastery": {"kp1": 0.3}}, plan)

    assert result.move == "CHECK"
    assert result.ask == {"kind": "item", "item_id": "c1", "purpose": "check"}


def test_confusion_uses_distinct_approach_then_backfills_on_third_confusion(plan: dict[str, object]) -> None:
    state = _state(stage="teaching", approaches_used=["intuition"], confusion_streak=0)
    first = decide(state, {"type": "quick_action", "kind": "confused"}, {}, plan)
    assert first.move == "REEXPLAIN"
    assert first.args["approach"]["kind"] == "visual"

    third = decide(
        _state(stage="teaching", approaches_used=["intuition", "visual"], confusion_streak=2),
        {"type": "quick_action", "kind": "confused"},
        {"mastery": {"pre": 0.2}},
        plan,
    )
    assert third.move == "BACKFILL"
    assert third.ask == {"kind": "item", "item_id": "b1", "purpose": "backfill"}
    assert third.state_patch["backfilled"] == ["pre"]


def test_hint_staircase_show_answer_and_variant_queue(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    state = _state(stage="teaching", kp_cursor=1, active_ask=active, item={"id": "c1", "hint_level": 0, "attempts": 0, "first_verdict": None, "evidence_deferred": False})

    hint = decide(state, {"type": "quick_action", "kind": "hint"}, {}, plan)
    assert hint.move == "HINT"
    assert hint.args == {"item_id": "c1", "level": 1}
    assert hint.state_patch["item"]["hint_level"] == 1

    reveal = decide(state, {"type": "quick_action", "kind": "show_answer"}, {}, plan)
    assert reveal.move == "SHOW_SOLUTION"
    assert reveal.args["evidence"] == {
        "record": True,
        "item_id": "c1",
        "purpose": "check",
        "verdict": "revealed",
        "hint_level": 0,
    }
    assert reveal.state_patch["item"]["first_verdict"] == "revealed"
    assert reveal.state_patch["items_done"]["c1"] == "revealed"
    assert reveal.state_patch["queued"][0]["move"] == "CHECK"
    assert reveal.state_patch["queued"][0]["ask"]["item_id"] == "c2"


def test_reveal_does_not_queue_a_variant_that_depends_on_an_untaught_keypoint(plan: dict[str, object]) -> None:
    plan["items"]["c2"]["keypoints"] = [0, 1]
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}

    reveal = decide(
        _state(stage="teaching", kp_cursor=1, active_ask=active),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )

    assert reveal.move == "SHOW_SOLUTION"
    assert "queued" not in reveal.state_patch


def test_teaching_reveal_does_not_reintroduce_a_variant_removed_from_segment_checks(plan: dict[str, object]) -> None:
    plan["segments"][0]["checks"] = ["c1", "c3"]
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}

    reveal = decide(
        _state(stage="teaching", kp_cursor=1, active_ask=active),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )

    assert reveal.move == "SHOW_SOLUTION"
    assert "queued" not in reveal.state_patch


def test_legacy_teaching_plan_without_segment_checks_can_still_use_variant_graph(plan: dict[str, object]) -> None:
    plan["segments"][0]["checks"] = []
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}

    reveal = decide(
        _state(stage="teaching", kp_cursor=1, active_ask=active),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )

    assert reveal.move == "SHOW_SOLUTION"
    assert reveal.state_patch["queued"][0]["ask"]["item_id"] == "c2"


def test_practice_reveal_still_queues_a_variant_after_all_segment_keypoints_are_taught(plan: dict[str, object]) -> None:
    plan["items"]["p2"] = {
        "kp_id": "kp1",
        "keypoints": [0, 1],
        "type": "numeric",
        "difficulty": 2,
        "variant_of": "p1",
        "verify": {"status": "verified"},
    }
    active = {"kind": "item", "item_id": "p1", "purpose": "practice", "nudged": False}

    reveal = decide(
        _state(stage="practice", active_ask=active),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )

    assert reveal.move == "SHOW_SOLUTION"
    assert reveal.state_patch["queued"][0]["ask"]["item_id"] == "p2"


def test_backfill_reveal_preserves_resume_queue_instead_of_inserting_a_variant(plan: dict[str, object]) -> None:
    plan["items"]["b2"] = {
        "kp_id": "pre",
        "keypoints": [],
        "type": "choice",
        "difficulty": 1,
        "variant_of": "b1",
        "verify": {"status": "verified"},
    }
    active = {"kind": "item", "item_id": "b1", "purpose": "backfill", "nudged": False}
    resume = {"move": "RESUME", "args": {}, "ask": {"kind": "item", "item_id": "c1", "purpose": "check"}, "state_patch": {}}

    reveal = decide(
        _state(stage="teaching", kp_cursor=1, active_ask=active, queued=[resume]),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )

    assert reveal.move == "SHOW_SOLUTION"
    assert "queued" not in reveal.state_patch


def test_incorrect_answers_climb_hints_without_replacing_first_verdict(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    item = {"id": "c1", "hint_level": 0, "attempts": 0, "first_verdict": None, "evidence_deferred": False}
    first = decide(_state(stage="teaching", active_ask=active, item=item), {"type": "student_answer", "item_id": "c1", "verdict": "incorrect"}, {}, plan)
    assert first.move == "HINT"
    assert first.args["level"] == 1
    assert first.state_patch["item"]["first_verdict"] == "incorrect"
    assert first.args["evidence"]["record"] is True

    retry_item = {**first.state_patch["item"], "hint_level": 2}
    final = decide(_state(stage="teaching", active_ask=active, item=retry_item), {"type": "student_answer", "item_id": "c1", "verdict": "incorrect"}, {}, plan)
    assert final.move == "SHOW_SOLUTION"
    assert final.state_patch["item"]["first_verdict"] == "incorrect"
    assert final.args["evidence"]["record"] is False


def test_silence_nudges_once_then_pauses_without_evidence(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    first = decide(_state(stage="teaching", active_ask=active), {"type": "silence"}, {}, plan)
    assert first.move == "NUDGE"
    assert first.state_patch["active_ask"]["nudged"] is True

    active["nudged"] = True
    second = decide(_state(stage="teaching", active_ask=active), {"type": "silence"}, {}, plan)
    assert second.move is None
    assert second.state_patch == {"status": "paused"}


def test_stale_answer_is_idempotent(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    result = decide(_state(stage="teaching", active_ask=active), {"type": "student_answer", "item_id": "other", "verdict": "correct"}, {}, plan)
    assert result.move is None
    assert result.args == {"judge": {"item_id": "other", "stale": True}}
    assert result.state_patch == {}


def test_side_question_temporarily_clears_and_then_restores_the_pending_ask(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    answer = decide(
        _state(stage="teaching", active_ask=active),
        {"type": "student_utterance", "intent": "question", "text": "why"},
        {},
        plan,
    )
    assert answer.move == "ANSWER_QUESTION"
    assert answer.state_patch["active_ask"] is None
    assert answer.state_patch["queued"][0]["move"] == "RESUME"

    resumed_state = _state(stage="teaching", **answer.state_patch)
    resumed = decide(resumed_state, {"type": "beat_done"}, {}, plan)
    assert resumed.move == "RESUME"
    assert resumed.ask == active


def test_finishing_segments_enters_practice_with_an_item(plan: dict[str, object]) -> None:
    result = decide(_state(stage="teaching", seg_idx=1), {"type": "beat_done"}, {}, plan)
    assert result.move == "PRACTICE_ITEM"
    assert result.ask == {"kind": "item", "item_id": "p1", "purpose": "practice"}
    assert result.state_patch["stage"] == "practice"
    assert result.state_patch["item"]["hint_level"] == 1


def test_resume_reissues_an_open_ask_and_resets_its_silence_nudge(plan: dict[str, object]) -> None:
    active = {"kind": "open", "purpose": "predict", "asked_seq": 17, "nudged": True}
    result = decide(_state(stage="teaching", active_ask=active), {"type": "lesson_resume"}, {}, plan)
    expected = {"kind": "open", "purpose": "predict", "nudged": False}
    assert result.move is None
    assert result.args == {"reissue_ask": True}
    assert result.ask == expected
    assert result.state_patch["active_ask"] == expected


def test_style_and_pace_actions_only_persist_supported_values(plan: dict[str, object]) -> None:
    invalid = decide(_state(stage="teaching"), {"type": "quick_action", "kind": "style:unknown"}, {}, plan)
    assert invalid.move is None
    assert invalid.args == {"invalid_style": "unknown"}
    assert invalid.state_patch == {}

    slower = decide(_state(stage="teaching"), {"type": "quick_action", "kind": "slower"}, {}, plan)
    assert slower.move == "ADJUST"
    assert slower.state_patch["pace"] == "slow"
    one_step = decide(_state(stage="teaching", pace="fast"), {"type": "quick_action", "kind": "slower"}, {}, plan)
    assert one_step.state_patch["pace"] == "normal"

    style = decide(_state(stage="teaching"), {"type": "quick_action", "kind": "style:rigorous"}, {}, plan)
    assert style.move == "ADJUST"
    assert style.state_patch["style_id"] == "rigorous"


def test_predict_and_summary_replies_advance_without_losing_the_reply(plan: dict[str, object]) -> None:
    predicted = decide(
        _state(stage="teaching", active_ask={"kind": "open", "purpose": "predict", "nudged": False}),
        {"type": "ask_reply", "purpose": "predict", "value": "my guess"},
        {},
        plan,
    )
    assert predicted.move == "EXPLAIN"
    assert predicted.args["prediction"] == "my guess"
    assert predicted.state_patch["active_ask"] is None
    assert predicted.state_patch["pending_beat"]["move"] == "EXPLAIN"

    summarized = decide(
        _state(stage="teaching", active_ask={"kind": "summary", "purpose": "summary", "nudged": False}),
        {"type": "ask_reply", "purpose": "summary", "omissions": ["second"]},
        {},
        plan,
    )
    assert summarized.move == "TRANSITION"
    assert summarized.args["summary_omissions"] == ["second"]
    assert summarized.state_patch["seg_idx"] == 1


def test_probe_reply_records_deferred_evidence_once(plan: dict[str, object]) -> None:
    state = _state(
        stage="teaching",
        active_ask={"kind": "open", "purpose": "probe", "nudged": False},
        item={"id": "c1", "hint_level": 0, "attempts": 1, "first_verdict": "correct", "evidence_deferred": True},
        items_done={"c1": "correct"},
    )
    result = decide(state, {"type": "ask_reply", "purpose": "probe", "reason_verdict": "sound"}, {}, plan)
    assert result.move == "FEEDBACK_CORRECT"
    assert result.args["evidence"] == {
        "record": True,
        "item_id": "c1",
        "purpose": "probe",
        "verdict": "correct",
        "hint_level": 0,
    }
    assert result.state_patch["item"]["evidence_deferred"] is False
    assert result.state_patch["seg_clean_streak"] == 1


def test_break_continue_restores_the_interrupted_item_ask(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    interrupted = decide(
        _state(stage="teaching", active_ask=active),
        {"type": "quick_action", "kind": "break"},
        {},
        plan,
    )
    assert interrupted.move == "BREAK"
    break_state = _state(stage="teaching", **interrupted.state_patch)
    resumed = decide(
        break_state,
        {"type": "ask_reply", "purpose": "break", "value": "continue"},
        {},
        plan,
    )
    assert resumed.move == "RESUME"
    assert resumed.ask == active
    assert resumed.state_patch["active_ask"] == active


def test_backfill_answer_carries_evidence_and_restores_original_question(plan: dict[str, object]) -> None:
    original = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    state = _state(
        stage="teaching",
        active_ask={"kind": "item", "item_id": "b1", "purpose": "backfill", "nudged": False},
        item={"id": "b1", "hint_level": 0, "attempts": 0, "first_verdict": None, "evidence_deferred": False},
        backfill={"kp_id": "pre", "return": {"seg_idx": 0, "kp_cursor": 1, "item_id": "c1"}},
        queued=[{"move": "RESUME", "args": {}, "ask": original, "state_patch": {}}],
    )
    feedback = decide(
        state,
        {"type": "student_answer", "item_id": "b1", "verdict": "correct"},
        {},
        plan,
    )
    assert feedback.move == "FEEDBACK_CORRECT"
    assert feedback.args["evidence"]["record"] is True
    assert feedback.args["evidence"]["purpose"] == "backfill"
    resumed_state = deepcopy(state)
    resumed_state.update(feedback.state_patch)
    resumed = decide(resumed_state, {"type": "beat_done"}, {}, plan)
    assert resumed.move == "RESUME"
    assert resumed.ask == original


def test_wrap_is_emitted_once_then_finish_is_idempotent(plan: dict[str, object]) -> None:
    wrapping = decide(_state(stage="teaching", seg_idx=1, items_done={"p1": "correct"}), {"type": "beat_done"}, {}, plan)
    assert wrapping.move == "WRAP"
    assert wrapping.state_patch["stage"] == "wrap"

    finished = decide(_state(stage="wrap"), {"type": "beat_done"}, {}, plan)
    assert finished.move is None
    assert finished.args == {"finish": True}
    assert finished.state_patch["stage"] == "done"

    repeated = decide(_state(stage="done"), {"type": "time_up"}, {}, plan)
    assert repeated.move is None
    assert repeated.args == {"finish": True}


def test_second_failed_item_forces_break_before_the_variant(plan: dict[str, object]) -> None:
    active = {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}
    revealed = decide(
        _state(
            stage="teaching",
            kp_cursor=1,
            failed_items=1,
            active_ask=active,
            item={"id": "c1", "hint_level": 2, "attempts": 2, "first_verdict": "incorrect", "evidence_deferred": False},
        ),
        {"type": "quick_action", "kind": "show_answer"},
        {},
        plan,
    )
    assert revealed.move == "SHOW_SOLUTION"
    assert [entry["move"] for entry in revealed.state_patch["queued"]] == ["BREAK", "CHECK"]

    after_reveal = _state(stage="teaching")
    after_reveal.update(revealed.state_patch)
    paused = decide(after_reveal, {"type": "beat_done"}, {}, plan)
    assert paused.move == "BREAK"
    assert paused.ask == {"kind": "ack", "purpose": "break"}

    break_state = deepcopy(after_reveal)
    break_state.update(paused.state_patch)
    continued = decide(
        break_state,
        {"type": "ask_reply", "purpose": "break", "value": "continue"},
        {},
        plan,
    )
    assert continued.move == "CHECK"
    assert continued.ask["item_id"] == "c2"


def test_minimal_lesson_trajectory_reaches_done_without_synthetic_events(plan: dict[str, object]) -> None:
    plan = deepcopy(plan)
    plan["segments"][0]["keypoints"] = ["first"]
    plan["segments"][0]["backfills"] = []
    plan["segments"][0]["checks"] = ["c1"]
    plan["practice"] = []
    state = _state()

    def apply(result: Decision) -> Decision:
        state.update(deepcopy(result.state_patch))
        return result

    assert apply(decide(state, {"type": "lesson_start"}, {}, plan)).move == "OPEN"
    assert apply(decide(state, {"type": "beat_done"}, {}, plan)).move == "EXPLAIN"
    assert apply(decide(state, {"type": "beat_done"}, {}, plan)).move == "CHECK"
    assert apply(decide(state, {"type": "student_answer", "item_id": "c1", "verdict": "correct"}, {"mastery": {"kp1": 0.8}}, plan)).move == "FEEDBACK_CORRECT"
    assert apply(decide(state, {"type": "beat_done"}, {}, plan)).move == "TRANSITION"
    assert apply(decide(state, {"type": "beat_done"}, {}, plan)).move == "WRAP"
    finished = apply(decide(state, {"type": "beat_done"}, {}, plan))
    assert finished.move is None
    assert finished.args == {"finish": True}
    assert state["stage"] == "done"


def test_total_for_stage_event_ask_product(plan: dict[str, object]) -> None:
    event_types = ("lesson_start", "lesson_resume", "beat_done", "student_answer", "ask_reply", "student_utterance", "quick_action", "interrupt", "silence", "time_up", "control", "unknown")
    asks = (None, {"kind": "item", "item_id": "c1", "purpose": "check", "nudged": False}, {"kind": "open", "purpose": "predict", "nudged": False})
    for stage in ("opening", "teaching", "practice", "wrap", "done", "unknown"):
        for event_type in event_types:
            for active_ask in asks:
                event = {"type": event_type, "item_id": "c1", "verdict": "correct", "kind": "continue", "action": "resume"}
                result = decide(_state(stage=stage, active_ask=active_ask), event, {}, plan)
                assert isinstance(result, Decision)
