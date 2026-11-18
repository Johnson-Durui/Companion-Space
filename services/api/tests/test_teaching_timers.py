from __future__ import annotations

import pytest

from app.teaching.timers import due_timer_event, lesson_time_limit_ms, silence_delay_ms


@pytest.mark.parametrize(
    ("ask", "item_type", "expected"),
    [
        ({"kind": "item"}, "choice", 30_000),
        ({"kind": "item"}, "multi", 30_000),
        ({"kind": "item"}, "numeric", 60_000),
        ({"kind": "item"}, "short", 60_000),
        ({"kind": "item"}, "steps", 90_000),
        ({"kind": "item"}, "explain", 90_000),
        ({"kind": "open"}, None, 30_000),
        ({"kind": "summary"}, None, 30_000),
        ({"kind": "ack"}, None, 30_000),
        (None, None, None),
    ],
)
def test_silence_delay_depends_on_the_active_ask(
    ask: dict[str, str] | None,
    item_type: str | None,
    expected: int | None,
) -> None:
    assert silence_delay_ms(ask, item_type) == expected


def test_unknown_item_type_is_rejected() -> None:
    with pytest.raises(ValueError, match="item type"):
        silence_delay_ms({"kind": "item"}, "video")


@pytest.mark.parametrize(
    ("session_minutes", "plan_minutes", "expected"),
    [(25, 20, 1_875_000), (15, 28, 2_100_000), (25.5, 25, 1_912_500)],
)
def test_time_limit_uses_the_longer_planned_duration(
    session_minutes: float,
    plan_minutes: float,
    expected: int,
) -> None:
    assert lesson_time_limit_ms(session_minutes, plan_minutes) == expected


@pytest.mark.parametrize(("session_minutes", "plan_minutes"), [(0, 20), (20, 0), (-1, 20)])
def test_time_limit_rejects_non_positive_durations(
    session_minutes: float,
    plan_minutes: float,
) -> None:
    with pytest.raises(ValueError, match="positive"):
        lesson_time_limit_ms(session_minutes, plan_minutes)


def test_due_timer_prioritizes_the_one_shot_lesson_limit() -> None:
    assert due_timer_event(
        stage="teaching",
        active_ask={"kind": "item"},
        item_type="choice",
        waiting_ms=30_000,
        active_ms=100_000,
        time_limit_ms=100_000,
    ) == "time_up"

    assert due_timer_event(
        stage="teaching",
        active_ask={"kind": "item"},
        item_type="choice",
        waiting_ms=30_000,
        active_ms=100_000,
        time_limit_ms=100_000,
        time_up_sent=True,
    ) == "silence"


def test_due_timer_emits_silence_only_at_the_question_threshold() -> None:
    common = {
        "stage": "teaching",
        "active_ask": {"kind": "item"},
        "item_type": "numeric",
        "active_ms": 10_000,
        "time_limit_ms": 100_000,
    }
    assert due_timer_event(**common, waiting_ms=59_999) is None
    assert due_timer_event(**common, waiting_ms=60_000) == "silence"


@pytest.mark.parametrize("stage", ["wrap", "done"])
def test_terminal_stages_have_no_due_timer(stage: str) -> None:
    assert due_timer_event(
        stage=stage,
        active_ask={"kind": "item"},
        item_type="choice",
        waiting_ms=99_000,
        active_ms=99_000,
        time_limit_ms=1,
    ) is None


def test_paused_or_non_waiting_lessons_do_not_emit_silence() -> None:
    args = {
        "stage": "teaching",
        "active_ask": None,
        "waiting_ms": 90_000,
        "active_ms": 10_000,
        "time_limit_ms": 100_000,
    }
    assert due_timer_event(**args) is None
    assert due_timer_event(**args, paused=True) is None
