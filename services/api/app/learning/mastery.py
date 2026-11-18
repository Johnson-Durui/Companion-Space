from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

EvidenceSource = Literal[
    "diagnostic",
    "lesson_check",
    "probe",
    "practice",
    "skip_verify",
    "backfill",
    "review",
]
Verdict = Literal["correct", "partial", "incorrect", "dont_know", "revealed"]
ItemType = Literal["choice", "multi", "numeric", "short", "explain", "steps"]
JudgedBy = Literal["exact", "model"]
MasteryStatus = Literal["unseen", "learning", "shaky", "mastered"]
SelfLevel = Literal["never", "attended_but_lost", "basic", "strong"]

LEARNING_SOURCES = frozenset({"lesson_check", "probe", "practice", "skip_verify", "backfill"})
HINT_WEIGHTS = (1.0, 0.6, 0.3, 0.0)
MIN_PROBABILITY = 0.02
MAX_PROBABILITY = 0.98
INITIAL_PRIORS: dict[SelfLevel, float] = {
    "never": 0.08,
    "attended_but_lost": 0.20,
    "basic": 0.50,
    "strong": 0.70,
}


@dataclass(frozen=True, slots=True)
class Evidence:
    source: EvidenceSource
    verdict: Verdict
    hint_level: int
    item_type: ItemType
    judged_by: JudgedBy
    n_options: int | None = None
    retry: bool = False


def update_mastery_probability(probability: float, evidence: Evidence) -> float:
    if not MIN_PROBABILITY <= probability <= MAX_PROBABILITY:
        raise ValueError("probability must be between 0.02 and 0.98")
    if evidence.hint_level not in range(4):
        raise ValueError("hint_level must be between zero and three")

    if evidence.hint_level == 3 or evidence.verdict in {"partial", "revealed"}:
        return probability

    if evidence.retry:
        updated = (
            probability + (1 - probability) * 0.04
            if evidence.verdict == "correct" and evidence.source in LEARNING_SOURCES
            else probability
        )
        return _clamp(updated)

    guess = _guess_probability(evidence)
    slip = 0.25 if probability >= 0.85 else (0.15 if evidence.judged_by == "model" else 0.10)
    if evidence.verdict == "correct":
        posterior = probability * (1 - slip) / (
            probability * (1 - slip) + (1 - probability) * guess
        )
        weight = HINT_WEIGHTS[evidence.hint_level]
        updated = probability + weight * (posterior - probability)
        if evidence.source in LEARNING_SOURCES:
            updated += (1 - updated) * 0.12 * weight
    else:
        if evidence.verdict == "dont_know":
            guess = 0
        updated = probability * slip / (probability * slip + (1 - probability) * (1 - guess))
        if evidence.source == "review":
            updated = min(updated, probability * 0.75)

    return _clamp(updated)


def classify_mastery(
    probability: float,
    *,
    evidence_count: int,
    taught: bool,
    clean_correct_count: int = 0,
    clean_days: int = 0,
    objective_clean: bool = False,
    has_objective_items: bool = True,
    inferred: bool = False,
) -> MasteryStatus | None:
    if inferred:
        return None
    if evidence_count == 0 and not taught:
        return "unseen"
    if probability < 0.50:
        return "learning"
    if (
        probability >= 0.85
        and clean_correct_count >= 2
        and clean_days >= 2
        and (objective_clean or not has_objective_items)
    ):
        return "mastered"
    return "shaky"


def initial_mastery_probability(self_level: SelfLevel, *, hard_unit: bool = False) -> float:
    try:
        probability = INITIAL_PRIORS[self_level]
    except KeyError as exc:
        raise ValueError(f"unsupported self level: {self_level}") from exc
    return probability * 0.7 if hard_unit else probability


def _guess_probability(evidence: Evidence) -> float:
    if evidence.judged_by == "model":
        return 0.25
    if evidence.item_type == "choice":
        if evidence.n_options is not None and evidence.n_options < 2:
            raise ValueError("n_options must be at least two")
        return 1 / evidence.n_options if evidence.n_options else 0.25
    if evidence.item_type == "multi":
        return 0.10
    return 0.05


def _clamp(probability: float) -> float:
    return min(MAX_PROBABILITY, max(MIN_PROBABILITY, probability))
