from __future__ import annotations

from dataclasses import replace

import pytest

from app.learning.mastery import (
    Evidence,
    classify_mastery,
    initial_mastery_probability,
    update_mastery_probability,
)


LESSON_NUMERIC = Evidence(
    source="lesson_check",
    verdict="correct",
    hint_level=0,
    item_type="numeric",
    judged_by="exact",
)


@pytest.mark.parametrize(
    ("initial", "evidence", "expected"),
    [
        (
            0.15,
            Evidence("lesson_check", "correct", 0, "choice", "exact", n_options=4),
            0.4619,
        ),
        (0.50, replace(LESSON_NUMERIC, verdict="incorrect"), 0.0952),
        (0.60, replace(LESSON_NUMERIC, hint_level=2), 0.7198),
        (0.90, replace(LESSON_NUMERIC, verdict="incorrect"), 0.7031),
        (0.90, replace(LESSON_NUMERIC, source="review", verdict="incorrect"), 0.6750),
        (
            0.20,
            Evidence("lesson_check", "correct", 0, "short", "model"),
            0.5243,
        ),
        (
            0.056,
            Evidence("lesson_check", "incorrect", 0, "choice", "exact", n_options=4),
            0.0200,
        ),
    ],
)
def test_probability_examples(initial: float, evidence: Evidence, expected: float) -> None:
    assert round(update_mastery_probability(initial, evidence), 4) == expected


def test_retry_only_adds_small_learning_transfer_after_a_correct_lesson_answer() -> None:
    after_incorrect = update_mastery_probability(0.50, replace(LESSON_NUMERIC, verdict="incorrect"))
    after_retry = update_mastery_probability(after_incorrect, replace(LESSON_NUMERIC, retry=True))
    after_second_retry = update_mastery_probability(
        after_retry,
        replace(LESSON_NUMERIC, verdict="incorrect", retry=True),
    )
    after_third_retry = update_mastery_probability(
        after_second_retry,
        replace(LESSON_NUMERIC, verdict="incorrect", retry=True),
    )

    assert round(after_retry, 4) == 0.1314
    assert after_second_retry == after_retry
    assert after_third_retry == after_retry


def test_probability_update_invariants() -> None:
    for initial in (0.02, 0.15, 0.50, 0.90, 0.98):
        assert update_mastery_probability(initial, LESSON_NUMERIC) >= initial
        assert update_mastery_probability(
            initial,
            replace(LESSON_NUMERIC, verdict="incorrect"),
        ) <= initial
        assert update_mastery_probability(initial, replace(LESSON_NUMERIC, hint_level=3)) == initial
        assert update_mastery_probability(
            initial, replace(LESSON_NUMERIC, verdict="incorrect", hint_level=3),
        ) == initial
        assert update_mastery_probability(initial, replace(LESSON_NUMERIC, hint_level=3, retry=True)) == initial
        assert update_mastery_probability(initial, replace(LESSON_NUMERIC, verdict="partial")) == initial
        assert update_mastery_probability(initial, replace(LESSON_NUMERIC, verdict="revealed")) == initial


@pytest.mark.parametrize(("item_type", "n_options", "required"), [("choice", 4, 3), ("numeric", None, 2)])
@pytest.mark.parametrize("initial", [0.08, 0.15, 0.20])
def test_low_priors_need_repeated_clean_answers(
    item_type: str,
    n_options: int | None,
    required: int,
    initial: float,
) -> None:
    evidence = Evidence("lesson_check", "correct", 0, item_type, "exact", n_options=n_options)
    probability = initial

    for _ in range(required - 1):
        probability = update_mastery_probability(probability, evidence)
        assert probability < 0.85

    assert update_mastery_probability(probability, evidence) >= 0.85


def test_two_choice_guesses_do_not_establish_mastery() -> None:
    evidence = Evidence("lesson_check", "correct", 0, "choice", "exact", n_options=4)

    for initial in (0.08, 0.15, 0.20):
        after_two = update_mastery_probability(update_mastery_probability(initial, evidence), evidence)
        assert 0.68 <= after_two <= 0.83


def test_mastery_status_requires_durable_clean_evidence() -> None:
    assert classify_mastery(0.20, evidence_count=0, taught=False) == "unseen"
    assert classify_mastery(0.49, evidence_count=1, taught=False) == "learning"
    assert classify_mastery(0.80, evidence_count=2, taught=True) == "shaky"
    assert (
        classify_mastery(
            0.90,
            evidence_count=2,
            taught=True,
            clean_correct_count=2,
            clean_days=1,
            objective_clean=True,
        )
        == "shaky"
    )
    assert (
        classify_mastery(
            0.90,
            evidence_count=2,
            taught=True,
            clean_correct_count=2,
            clean_days=2,
            objective_clean=False,
        )
        == "shaky"
    )
    assert (
        classify_mastery(
            0.90,
            evidence_count=2,
            taught=True,
            clean_correct_count=2,
            clean_days=2,
            objective_clean=True,
        )
        == "mastered"
    )
    assert (
        classify_mastery(
            0.90,
            evidence_count=2,
            taught=True,
            clean_correct_count=2,
            clean_days=2,
            objective_clean=False,
            has_objective_items=False,
        )
        == "mastered"
    )


def test_inferred_mastery_has_no_student_facing_status() -> None:
    assert classify_mastery(0.90, evidence_count=0, taught=False, inferred=True) is None


@pytest.mark.parametrize(
    ("self_level", "hard_unit", "expected"),
    [
        ("never", False, 0.08),
        ("attended_but_lost", False, 0.20),
        ("basic", False, 0.50),
        ("strong", False, 0.70),
        ("basic", True, 0.35),
    ],
)
def test_initial_prior(self_level: str, hard_unit: bool, expected: float) -> None:
    assert initial_mastery_probability(self_level, hard_unit=hard_unit) == expected


def test_invalid_probability_inputs_are_rejected() -> None:
    for probability in (-0.1, 0.0, 1.0):
        with pytest.raises(ValueError):
            update_mastery_probability(probability, LESSON_NUMERIC)
    for option_count in (0, 1):
        with pytest.raises(ValueError):
            update_mastery_probability(
                0.5,
                Evidence("lesson_check", "correct", 0, "choice", "exact", n_options=option_count),
            )
