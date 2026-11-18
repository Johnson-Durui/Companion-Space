from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class PlacementCandidate:
    kp_id: str
    unit_id: str | None
    order: int
    weight: float
    probability: float
    successor_weight: float = 0.0

    @property
    def information(self) -> float:
        return (self.weight + 0.5 * self.successor_weight) * 4 * self.probability * (1 - self.probability)


def select_candidate(
    candidates: list[PlacementCandidate], *, previous_unit: str | None = None,
) -> PlacementCandidate | None:
    if not candidates:
        return None
    pool = [candidate for candidate in candidates if candidate.unit_id != previous_unit] or candidates
    maximum = max(candidate.weight + 0.5 * candidate.successor_weight for candidate in candidates) or 1
    return min(
        pool,
        key=lambda candidate: (
            -candidate.information / maximum,
            candidate.order,
            candidate.kp_id,
        ),
    )


def should_stop(*, answered: int, started_at: datetime, now: datetime, max_information: float | None) -> bool:
    return (
        answered >= 12
        or (now - started_at).total_seconds() >= 480
        or (answered >= 6 and (max_information is None or max_information < 0.15))
    )


def inferred_updates(
    *, kp_id: str, verdict: str, probability: float, item_type: str,
    prerequisites: dict[str, list[str]], probabilities: dict[str, float], evidenced: set[str],
) -> dict[str, float]:
    updates: dict[str, float] = {}
    if verdict in {"incorrect", "dont_know"} and probability < 0.30:
        successors = [target for target, preds in prerequisites.items() if kp_id in preds]
        updates.update({target: probabilities[target] * 0.6 for target in successors if target not in evidenced})
    if verdict == "correct" and (item_type == "numeric" or probability >= 0.85):
        updates.update({pred: max(probabilities[pred], 0.70) for pred in prerequisites.get(kp_id, []) if pred not in evidenced})
    return updates
