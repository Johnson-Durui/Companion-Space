from __future__ import annotations

from datetime import date
import json
from typing import Literal

from pydantic import BaseModel

from app.services.jobs import latest_analysis_job
from app.services.repository import SQLiteRepository

JourneyStepStatus = Literal["done", "active", "todo", "waiting"]
JourneyNextStep = Literal["materials", "analysis", "interview", "placement", "plan", "learn"]
JourneyStage = Literal[
    "needs_materials",
    "analyzing",
    "interview",
    "placement",
    "plan_ready",
    "learning",
    "today_done",
    "all_done",
    "exam_passed",
]


class JourneySteps(BaseModel):
    materials: JourneyStepStatus
    analysis: JourneyStepStatus
    interview: JourneyStepStatus
    placement: JourneyStepStatus
    plan: JourneyStepStatus


class CourseJourney(BaseModel):
    course_id: str
    steps: JourneySteps
    next_step: JourneyNextStep
    stage: JourneyStage
    has_materials: bool
    materials_ready: bool
    analysis_status: str | None = None
    has_plan: bool
    exam_passed: bool
    all_done: bool
    kps_learned: int = 0
    kps_mastered: int = 0
    kps_total: int = 0
    deferred_count: int = 0
    lessons_completed: int = 0


def compute_course_journey(
    *,
    course_id: str,
    material_count: int,
    kps_total: int,
    kps_learned: int,
    kps_mastered: int,
    diag_item_count: int,
    analysis_status: str | None,
    interview_status: str,
    placement_status: str,
    has_plan: bool,
    has_today_work: bool,
    all_done: bool,
    exam_passed: bool,
    deferred_count: int,
    lessons_completed: int,
) -> CourseJourney:
    has_materials = material_count > 0
    materials_ready = kps_total > 0 or analysis_status == "completed"
    interview_done = interview_status in {"done", "skipped"}
    placement_done = placement_status in {"done", "skipped"}

    step_materials: JourneyStepStatus = "done" if has_materials else "active"
    if materials_ready:
        step_analysis: JourneyStepStatus = "done"
    elif has_materials:
        step_analysis = "active"
    else:
        step_analysis = "todo"

    if interview_done:
        step_interview: JourneyStepStatus = "done"
    elif interview_status == "active" or has_materials:
        step_interview = "active"
    else:
        step_interview = "todo"

    if placement_done:
        step_placement: JourneyStepStatus = "done"
    elif not materials_ready:
        step_placement = "waiting"
    elif placement_status == "active" or interview_done:
        step_placement = "active"
    else:
        step_placement = "todo"

    if has_plan:
        step_plan: JourneyStepStatus = "done"
    elif not materials_ready:
        step_plan = "waiting"
    elif interview_done and (placement_done or diag_item_count == 0):
        step_plan = "active"
    else:
        step_plan = "todo"

    if has_plan:
        next_step: JourneyNextStep = "learn"
    elif not has_materials:
        next_step = "materials"
    elif not materials_ready:
        next_step = "interview" if (analysis_status in {"queued", "running"} and not interview_done) else "analysis"
    elif not interview_done:
        next_step = "interview"
    elif not placement_done and diag_item_count > 0:
        next_step = "placement"
    else:
        next_step = "plan"

    if has_plan:
        if exam_passed:
            stage: JourneyStage = "exam_passed"
        elif all_done:
            stage = "all_done"
        elif has_today_work:
            stage = "learning"
        else:
            stage = "today_done"
    elif not has_materials:
        stage = "needs_materials"
    elif not materials_ready:
        stage = "analyzing"
    elif not interview_done:
        stage = "interview"
    elif not placement_done and diag_item_count > 0:
        stage = "placement"
    else:
        stage = "plan_ready"

    return CourseJourney(
        course_id=course_id,
        steps=JourneySteps(
            materials=step_materials,
            analysis=step_analysis,
            interview=step_interview,
            placement=step_placement,
            plan=step_plan,
        ),
        next_step=next_step,
        stage=stage,
        has_materials=has_materials,
        materials_ready=materials_ready,
        analysis_status=analysis_status,
        has_plan=has_plan,
        exam_passed=exam_passed,
        all_done=all_done,
        kps_learned=kps_learned,
        kps_mastered=kps_mastered,
        kps_total=kps_total,
        deferred_count=deferred_count,
        lessons_completed=lessons_completed,
    )


def load_course_journeys(
    repository: SQLiteRepository,
    course_ids: list[str],
    *,
    today: date | None = None,
) -> dict[str, CourseJourney]:
    if not course_ids:
        return {}
    ref_today = today or date.today()
    today_iso = ref_today.isoformat()
    placeholders = ",".join("?" for _ in course_ids)
    params = tuple(course_ids)
    with repository.connection() as conn:
        materials = {
            row["space_id"]: int(row["n"])
            for row in conn.execute(
                f"SELECT space_id, COUNT(*) AS n FROM materials WHERE space_id IN ({placeholders}) GROUP BY space_id",
                params,
            )
        }
        kp_stats = {
            row["space_id"]: dict(row)
            for row in conn.execute(
                f"""SELECT k.space_id,
                           COUNT(*) AS total,
                           SUM(CASE WHEN COALESCE(m.evidence_count, 0) > 0
                                      OR m.status IN ('learning', 'shaky', 'mastered') THEN 1 ELSE 0 END) AS learned,
                           SUM(CASE WHEN m.status = 'mastered' THEN 1 ELSE 0 END) AS mastered
                    FROM knowledge_points k
                    LEFT JOIN kp_mastery m ON m.space_id = k.space_id AND m.kp_id = k.id
                    WHERE k.space_id IN ({placeholders}) AND k.status = 'active'
                    GROUP BY k.space_id""",
                params,
            )
        }
        diag_counts = {
            row["space_id"]: int(row["n"])
            for row in conn.execute(
                f"""SELECT space_id, COUNT(*) AS n FROM item_bank
                    WHERE space_id IN ({placeholders})
                      AND purpose = 'diagnostic' AND verify_status = 'verified'
                      AND reserved = 0 AND type IN ('choice', 'multi', 'numeric')
                    GROUP BY space_id""",
                params,
            )
        }
        enrollments = {
            row["space_id"]: dict(row)
            for row in conn.execute(
                f"""SELECT space_id, enrollment_json,
                           COALESCE(interview_status, 'todo') AS interview_status,
                           COALESCE(placement_status, 'todo') AS placement_status
                    FROM course_enrollment WHERE space_id IN ({placeholders})""",
                params,
            )
        }
        plans = {
            row["space_id"]: dict(row)
            for row in conn.execute(
                f"""SELECT s.space_id, s.deferred_json,
                           COUNT(p.id) AS total_items,
                           SUM(CASE WHEN p.status IN ('todo', 'active') THEN 1 ELSE 0 END) AS remaining_items,
                           SUM(CASE WHEN p.status = 'active'
                                      OR (p.status = 'todo' AND COALESCE(p.scheduled_date, '') <= ?)
                                    THEN 1 ELSE 0 END) AS due_items
                    FROM study_plans s
                    LEFT JOIN plan_items p ON p.plan_id = s.id AND p.space_id = s.space_id
                    WHERE s.space_id IN ({placeholders}) AND s.status = 'active'
                    GROUP BY s.space_id, s.id""",
                (today_iso, *params),
            )
        }
        lessons_done = {
            row["space_id"]: int(row["n"])
            for row in conn.execute(
                f"""SELECT space_id, COUNT(*) AS n FROM lessons
                    WHERE space_id IN ({placeholders}) AND status = 'done'
                    GROUP BY space_id""",
                params,
            )
        }

    journeys: dict[str, CourseJourney] = {}
    for course_id in course_ids:
        job = latest_analysis_job(repository, course_id)
        analysis_status = job.status if job else None
        enr = enrollments.get(course_id) or {}
        enr_json = json.loads(enr.get("enrollment_json") or "{}")
        exam_raw = enr_json.get("exam_date")
        exam_date = date.fromisoformat(exam_raw) if isinstance(exam_raw, str) and exam_raw else None
        exam_passed = bool(exam_date and exam_date < ref_today)

        plan_row = plans.get(course_id)
        total_items = int(plan_row["total_items"]) if plan_row else 0
        has_plan = total_items > 0
        remaining_items = int(plan_row["remaining_items"] or 0) if plan_row else 0
        due_items = int(plan_row["due_items"] or 0) if plan_row else 0
        deferred_list = json.loads(plan_row["deferred_json"] or "[]") if plan_row else []
        kp_row = kp_stats.get(course_id) or {}

        journeys[course_id] = compute_course_journey(
            course_id=course_id,
            material_count=materials.get(course_id, 0),
            kps_total=int(kp_row.get("total") or 0),
            kps_learned=int(kp_row.get("learned") or 0),
            kps_mastered=int(kp_row.get("mastered") or 0),
            diag_item_count=diag_counts.get(course_id, 0),
            analysis_status=analysis_status,
            interview_status=str(enr.get("interview_status") or "todo"),
            placement_status=str(enr.get("placement_status") or "todo"),
            has_plan=has_plan,
            has_today_work=has_plan and due_items > 0,
            all_done=has_plan and remaining_items == 0,
            exam_passed=exam_passed,
            deferred_count=len(deferred_list) if isinstance(deferred_list, list) else 0,
            lessons_completed=lessons_done.get(course_id, 0),
        )
    return journeys
