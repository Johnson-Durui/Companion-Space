from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

TimerEvent = Literal["silence", "time_up"]

_ITEM_SILENCE_MS = {
    "choice": 30_000,
    "multi": 30_000,
    "numeric": 60_000,
    "short": 60_000,
    "steps": 90_000,
    "explain": 90_000,
    "proof": 90_000,
    "essay": 90_000,
}
_OPEN_ASK_KINDS = frozenset({"open", "summary", "ack"})
_ACTIVE_STAGES = frozenset({"opening", "teaching", "practice"})


def silence_delay_ms(
    ask: Mapping[str, object] | None,
    item_type: str | None = None,
) -> int | None:
    if ask is None:
        return None
    kind = ask.get("kind")
    if kind in _OPEN_ASK_KINDS:
        return 30_000
    if kind != "item":
        return None
    resolved_type = item_type or _ask_item_type(ask)
    try:
        return _ITEM_SILENCE_MS[str(resolved_type)]
    except KeyError as exc:
        raise ValueError(f"unsupported classroom item type: {resolved_type}") from exc


def lesson_time_limit_ms(session_minutes: float, plan_est_minutes: float) -> int:
    if session_minutes <= 0 or plan_est_minutes <= 0:
        raise ValueError("lesson durations must be positive")
    return round(max(session_minutes, plan_est_minutes) * 1.25 * 60_000)


def due_timer_event(
    *,
    stage: str,
    active_ask: Mapping[str, object] | None,
    waiting_ms: int,
    active_ms: int,
    time_limit_ms: int,
    item_type: str | None = None,
    time_up_sent: bool = False,
    paused: bool = False,
) -> TimerEvent | None:
    if min(waiting_ms, active_ms, time_limit_ms) < 0:
        raise ValueError("elapsed times and limits cannot be negative")
    if paused or stage not in _ACTIVE_STAGES:
        return None
    if not time_up_sent and active_ms >= time_limit_ms:
        return "time_up"
    delay = silence_delay_ms(active_ask, item_type)
    if delay is not None and waiting_ms >= delay:
        return "silence"
    return None


def _ask_item_type(ask: Mapping[str, object]) -> str | None:
    direct = ask.get("item_type")
    if direct is not None:
        return str(direct)
    widget = ask.get("widget")
    return str(widget.get("type")) if isinstance(widget, Mapping) and widget.get("type") else None
