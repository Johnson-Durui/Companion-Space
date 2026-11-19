from __future__ import annotations

from dataclasses import dataclass, replace
from copy import deepcopy
from collections.abc import Callable
from datetime import date, timedelta
from math import ceil


_BASE_MINUTES = {"concept": 10, "theorem": 12, "formula": 8, "method": 15, "skill": 15, "fact": 5}
_DIFFICULTY = {1: 0.8, 2: 1.0, 3: 1.3}


@dataclass(frozen=True, slots=True)
class PlanningPoint:
    id: str
    name: str
    kind: str
    difficulty: int
    order: int
    prerequisites: tuple[str, ...]
    weight: float
    probability: float
    assumed: bool = False
    status: str = "unseen"
    highlighted: bool = False

    @property
    def minutes(self) -> int:
        return max(1, ceil(_BASE_MINUTES.get(self.kind, 10) * _DIFFICULTY[self.difficulty] * (1.5 - self.probability)))

    @property
    def value(self) -> float:
        return self.weight * (1 - self.probability)


def _study_dates(today: date, end: date, weekdays: set[int]) -> list[date]:
    dates, cursor = [], today + timedelta(days=1)
    while cursor < end:
        if cursor.isoweekday() in weekdays:
            dates.append(cursor)
        cursor += timedelta(days=1)
    return dates


def _closure(point_id: str, points: dict[str, PlanningPoint], selected: set[str]) -> set[str]:
    result, pending = set(), [point_id]
    while pending:
        current = pending.pop()
        if current in selected or current in result or current not in points:
            continue
        point = points[current]
        if point.assumed or point.status == "mastered" or point.probability >= 0.85:
            continue
        result.add(current)
        pending.extend(point.prerequisites)
    return result


def build_plan(
    points: list[PlanningPoint], *, today: date, exam_date: date | None,
    weekly_days: list[int], session_minutes: int, has_practice: set[str], has_mock: bool,
) -> dict:
    eligible = {point.id: point for point in points if not point.assumed and point.status != "mastered" and point.probability < 0.85}
    adjusted = {key: point.weight * (1.5 if point.highlighted else 1) for key, point in eligible.items()}
    cap = (sum(adjusted.values()) / len(adjusted) * 6) if adjusted else 1
    adjusted = {key: min(weight, cap) for key, weight in adjusted.items()}
    total_weight = sum(adjusted.values()) or 1
    normalized = {key: weight / total_weight for key, weight in adjusted.items()}
    eligible = {key: replace(point, weight=normalized[key]) for key, point in eligible.items()}
    dates = _study_dates(today, exam_date, set(weekly_days)) if exam_date and exam_date > today else []
    capacity = len(dates) * session_minutes * 0.65 if dates else None
    selected, selection_order = set(), []
    remaining = capacity
    while eligible.keys() - selected:
        choices = []
        for key in eligible.keys() - selected:
            closure = _closure(key, eligible, selected)
            cost = sum(eligible[item].minutes for item in closure)
            choices.append((eligible[key].value / max(cost, 1), eligible[key].order, key, closure, cost))
        fitting = [choice for choice in choices if remaining is None or choice[4] <= remaining]
        if not fitting:
            if selected:
                break
            fitting = choices
        _, _, _, closure, cost = min(fitting, key=lambda item: (-item[0], item[1], item[2]))
        for key in sorted(closure, key=lambda item: (eligible[item].order, item)):
            if key not in selected:
                selected.add(key)
                selection_order.append(key)
        if remaining is not None:
            remaining -= cost

    rank = {key: index for index, key in enumerate(selection_order)}
    pending = {key: set(eligible[key].prerequisites) & selected for key in selected}
    ordered = []
    while pending:
        ready = [key for key, prerequisites in pending.items() if not prerequisites]
        if not ready:
            raise ValueError("Knowledge point prerequisites contain a cycle.")
        key = min(ready, key=lambda item: (0.6 * rank[item] + 0.4 * eligible[item].order, item))
        ordered.append(key)
        pending.pop(key)
        for prerequisites in pending.values():
            prerequisites.discard(key)
    limit = session_minutes * 0.65
    lessons: list[list[str]] = []
    for key in ordered:
        if not lessons or len(lessons[-1]) >= 3 or sum(eligible[item].minutes for item in lessons[-1]) + eligible[key].minutes > limit:
            lessons.append([])
        lessons[-1].append(key)
    items = []
    for index, lesson in enumerate(lessons, 1):
        names = [eligible[key].name for key in lesson]
        items.append({
            "kind": "lesson", "kp_ids": lesson, "title": " · ".join(names),
            "est_minutes": sum(eligible[key].minutes for key in lesson),
            "why": [{"kp_id": key, "weight": round(eligible[key].weight, 4), "mastery": round(eligible[key].probability, 4)} for key in lesson],
        })
        if index % 4 == 0 and any(key in has_practice for group in lessons[-4:] for key in group):
            recent = [key for group in lessons[-4:] for key in group]
            items.append({"kind": "practice", "kp_ids": recent, "title": "Practice", "est_minutes": session_minutes})
    if has_mock and items:
        items.insert(min(len(items), max(1, round(len(items) * 0.8))), {
            "kind": "mock", "kp_ids": [], "title": "Mock exam", "est_minutes": session_minutes,
        })
    schedule = dates if dates else [today + timedelta(days=index + 1) for index in range(len(items))]
    for item, scheduled in zip(items, schedule, strict=False):
        item["scheduled_date"] = scheduled.isoformat()
    overflow = items[len(schedule):] if dates else []
    if overflow:
        overflow_ids = {key for item in overflow if item["kind"] == "lesson" for key in item["kp_ids"]}
        selected -= overflow_ids
        items = items[:len(schedule)]
    deferred = [key for key in eligible if key not in selected]
    return {
        "items": items, "deferred": deferred,
        "deferred_weight": round(sum(eligible[key].weight for key in deferred), 4),
        "over_capacity": capacity is not None and bool(eligible) and remaining is not None and remaining < 0,
        "capacity_minutes": round(capacity) if capacity is not None else None,
    }


def _item_key(item: dict) -> tuple[str, tuple[str, ...]]:
    return item["kind"], tuple(item.get("kp_ids", []))


def _priority(item: dict) -> float:
    reasons = item.get("why", [])
    value = sum(reason.get("weight", 0) * (1 - reason.get("mastery", 0)) for reason in reasons)
    return value / max(item.get("est_minutes", 1), 1)


def stabilize_plan(generated: dict, previous: dict | None, *, threshold: float = 1.10) -> dict:
    """Preserve fixed items and avoid low-value churn in a regenerated plan."""
    if not previous:
        return generated
    result = deepcopy(generated)
    fresh = result["items"]
    fresh_by_key = {_item_key(item): item for item in fresh}
    frozen = [
        item for item in previous.get("items", [])
        if item.get("pinned") or item.get("status") in {"active", "done", "skipped"}
    ]
    frozen_keys = {_item_key(item) for item in frozen}
    fresh = [item for item in fresh if _item_key(item) not in frozen_keys]

    common_slots = [index for index, item in enumerate(fresh) if _item_key(item) in {
        _item_key(old) for old in previous.get("items", []) if not old.get("pinned") and old.get("status") == "todo"
    }]
    stable = [
        fresh_by_key[_item_key(item)] for item in previous.get("items", [])
        if not item.get("pinned") and item.get("status") == "todo" and _item_key(item) in fresh_by_key
    ]
    desired = {_item_key(item): index for index, item in enumerate(fresh)}
    changed = True
    while changed:
        changed = False
        for index in range(len(stable) - 1):
            left, right = stable[index:index + 2]
            if desired[_item_key(right)] < desired[_item_key(left)] and _priority(right) > _priority(left) * threshold:
                stable[index:index + 2] = [right, left]
                changed = True
    for index, item in zip(common_slots, stable, strict=False):
        fresh[index] = item

    size = max(len(fresh) + len(frozen), max((item.get("ord", 0) + 1 for item in frozen), default=0))
    merged: list[dict | None] = [None] * size
    for item in frozen:
        position = min(item.get("ord", 0), len(merged) - 1)
        while merged[position] is not None:
            position += 1
            if position == len(merged):
                merged.append(None)
        merged[position] = deepcopy(item)
    pending = iter(fresh)
    merged = [next(pending, None) if item is None else item for item in merged]
    merged.extend(pending)
    result["items"] = [item for item in merged if item is not None]
    return result


def persist_plan(repository, course_id: str, result: dict, *, reason: str,
                 on_plan_ready: Callable[[str], None] | None = None) -> dict:
    saved = repository.replace_plan(course_id, result, reason=reason)
    if on_plan_ready is not None:
        on_plan_ready(saved["id"])
    return saved
