from __future__ import annotations

from datetime import date

from app.learning.mastery import initial_mastery_probability
from app.learning.planner import PlanningPoint, build_plan, persist_plan, stabilize_plan
from app.learning.profiles import EnrollmentSettings


async def rebuild_course_plan(repository, gateway, course_id: str, *, today: date, reason: str) -> dict | None:
    """Rebuild a course plan from durable mastery after a completed lesson."""
    enrollment = repository.get_course_enrollment(course_id)
    if enrollment is None:
        return None
    settings = EnrollmentSettings.model_validate({
        key: value for key, value in enrollment.items() if key in EnrollmentSettings.model_fields
    })
    points = repository.learning_points(course_id)
    for point in points:
        if point["p"] is None:
            probability = initial_mastery_probability(
                settings.self_level, hard_unit=point["unit_id"] in settings.hard_units,
            )
            repository.save_mastery(course_id, point["id"], probability=probability, inferred=False)
            point.update(p=probability, status="unseen", inferred=0, evidence_count=0)
    previous = repository.current_plan(course_id)
    previous_params = previous.get("params", {}) if previous else {}
    known = {point["id"] for point in points}
    highlighted = set(previous_params.get("highlighted_kp_ids", ())) & known
    mapping_status = previous_params.get("hints_mapping", "unused" if not settings.teacher_hints.strip() else "unavailable")
    planning_points = [PlanningPoint(
        id=point["id"], name=point["name"], kind=point["kind"], difficulty=point["difficulty"],
        order=point["ord"], prerequisites=tuple(point["prerequisite_ids"]), weight=point["weight"],
        probability=point["p"], assumed=bool(point["assumed"]), status=point["status"],
        highlighted=point["id"] in highlighted,
    ) for point in points]
    with repository.connection() as connection:
        practice = {row["kp_id"] for row in connection.execute(
            """SELECT DISTINCT kp_id FROM item_bank WHERE space_id = ? AND purpose IN ('practice', 'check')
               AND verify_status = 'verified' AND reserved = 0""", (course_id,),
        )}
        has_mock = bool(connection.execute(
            "SELECT 1 FROM exam_papers WHERE space_id = ? AND reserved_for_mock = 1 LIMIT 1", (course_id,),
        ).fetchone())
    result = build_plan(
        planning_points, today=today, exam_date=settings.exam_date, weekly_days=settings.weekly_days,
        session_minutes=settings.session_minutes, has_practice=practice, has_mock=has_mock,
    )
    result["params"] = {
        "today": today.isoformat(), "exam_date": settings.exam_date.isoformat() if settings.exam_date else None,
        "hints_mapping": mapping_status, "highlighted_kp_ids": sorted(highlighted),
        "deferred_weight": result.get("deferred_weight"),
        "over_capacity": result.get("over_capacity"),
        "capacity_minutes": result.get("capacity_minutes"),
    }
    result = stabilize_plan(result, previous)
    return persist_plan(repository, course_id, result, reason=reason)
