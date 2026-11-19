from __future__ import annotations

from collections.abc import Collection

from app.services.tutor_catalog import Character, StyleId

STYLE_IDS = frozenset({"guided", "direct", "analogy", "exam", "rigorous"})


def initial_lesson_style(
    *,
    profile: dict | None,
    tutor: Character | None,
    explicit_profile_fields: Collection[str] | None,
    plan_style: StyleId | None = None,
) -> StyleId:
    """Resolve a new lesson's style without changing an existing lesson checkpoint.

    ``None`` for explicit fields denotes a legacy profile, whose saved style remains
    authoritative. New profiles record the fields the learner actually selected.
    """
    if plan_style is not None:
        return plan_style
    profile_style = profile.get("preferred_style_id") if profile else None
    if profile_style and (explicit_profile_fields is None or "preferred_style_id" in explicit_profile_fields):
        return profile_style
    return tutor.default_style_id if tutor is not None else "guided"
