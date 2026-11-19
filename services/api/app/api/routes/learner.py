import asyncio
from datetime import date, datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.analysis.results import CourseResults
from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError
from app.learning.interview import (
    InterviewAnswer, TOPICS, allowed_fields, extract_slots, map_teacher_hints, merge_answer,
    render_question,
)
from app.learning.mastery import Evidence, initial_mastery_probability, update_mastery_probability
from app.learning.placement import PlacementCandidate, inferred_updates, select_candidate, should_stop
from app.learning.planner import PlanningPoint, build_plan, persist_plan, stabilize_plan
from app.learning.profiles import CourseEnrollment, EnrollmentSettings, LearnerProfile
from app.providers.errors import ProviderError
from app.services.settings_store import get_setting, put_setting
from app.teaching.preparation import queue_upcoming_lessons

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class InterviewState(BaseModel):
    topics: list[str]
    completed: list[str]
    current: str | None
    status: str
    question: str | None = None
    rendered: bool = False
    fallback_to_chips: bool = False
    tutor: dict | None = None


class PlacementAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str
    answer: str | list[str] | float | None = None
    dont_know: bool = False


class PlacementQuestion(BaseModel):
    item_id: str
    kp_id: str
    type: str
    stem: str
    options: object = Field(default_factory=dict)
    answered: int
    started_at: datetime


class PlacementResult(BaseModel):
    status: str
    question: PlacementQuestion | None
    mastery: list[dict]
    summary: "PlacementSummary | None" = None


class PlacementSummary(BaseModel):
    strongest_name: str
    strongest_probability: float
    priority_name: str
    priority_probability: float
    inferred_count: int


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    today: date = Field(default_factory=date.today)
    reason: Literal["setup", "diagnostic", "schedule_changed", "manual"] = "manual"


class SkipQuizRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answers: dict[str, str | list[str] | float] | None = None


class PlanItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    direction: Literal["first", "earlier", "later"] | None = None
    pinned: bool | None = None


@router.get("/learner/profile")
def get_learner_profile(container: Container) -> LearnerProfile:
    return LearnerProfile.model_validate(container.repository.get_learner_profile() or {})


@router.put("/learner/profile")
def put_learner_profile(payload: LearnerProfile, container: Container) -> LearnerProfile:
    container.repository.upsert_learner_profile(payload.model_dump(mode="json"))
    put_setting(container.repository, "learner_profile_explicit_fields", sorted(LearnerProfile.model_fields))
    return payload


@router.get("/courses/{course_id}/enrollment")
def get_course_enrollment(course_id: str, container: Container) -> CourseEnrollment:
    enrollment = container.repository.get_course_enrollment(course_id)
    if enrollment is None:
        raise ResourceNotFoundError("Course not found")
    return CourseEnrollment.model_validate({**enrollment, "course_id": course_id})


@router.put("/courses/{course_id}/enrollment")
def put_course_enrollment(course_id: str, payload: EnrollmentSettings, container: Container) -> CourseEnrollment:
    enrollment = container.repository.upsert_course_enrollment(course_id, payload.model_dump(mode="json"))
    if enrollment is None:
        raise ResourceNotFoundError("Course not found")
    return CourseEnrollment.model_validate({**enrollment, "course_id": course_id})


def _course_or_404(container: ServiceContainer, course_id: str) -> dict:
    enrollment = container.repository.get_course_enrollment(course_id)
    if enrollment is None:
        raise ResourceNotFoundError("Course not found")
    return enrollment


def _tutor(container: ServiceContainer) -> dict | None:
    character_id = get_setting(container.repository, "default_character_id", None)
    character = container.tutors.get_character(character_id) if character_id else None
    if character is None:
        characters = container.tutors.list_characters()
        character = characters[0] if characters else None
    return character.model_dump(mode="json") if character else None


@router.get("/courses/{course_id}/interview")
async def get_interview(course_id: str, container: Container) -> InterviewState:
    enrollment = _course_or_404(container, course_id)
    state = container.repository.get_interview_state(course_id)
    current = state.get("current", TOPICS[0])
    tutor = _tutor(container)
    question, rendered = None, False
    if current and tutor:
        try:
            question = await render_question(container.gateway, topic=current, tutor=tutor, context={
                "completed": state.get("completed", []),
            })
            rendered = True
        except (ProviderError, ValueError):
            pass
    return InterviewState(
        topics=list(TOPICS), completed=state.get("completed", []),
        current=current, status=enrollment["interview_status"], question=question,
        rendered=rendered, fallback_to_chips=not rendered, tutor=tutor,
    )


@router.post("/courses/{course_id}/interview/answer")
async def answer_interview(course_id: str, payload: InterviewAnswer, container: Container) -> InterviewState:
    enrollment = _course_or_404(container, course_id)
    interview_state = container.repository.get_interview_state(course_id)
    if payload.topic != interview_state.get("current", TOPICS[0]):
        raise ValueError("Answer the current interview topic before continuing.")
    if payload.text:
        scope: dict[str, object] = {"allowed_fields": allowed_fields(payload.topic)}
        if payload.topic == "hard_parts":
            course_map = await asyncio.to_thread(CourseResults(container.analysis.data).course_map, course_id)
            scope["course_units"] = [{"id": unit.id, "title": unit.title} for unit in course_map.units]
        try:
            extracted = await extract_slots(
                container.gateway, topic=payload.topic, text=payload.text,
                context=scope,
            )
            if not extracted and not payload.values:
                raise ValueError("The answer did not yield any supported fields.")
        except (ProviderError, ValueError):
            return InterviewState(
                topics=list(TOPICS), completed=interview_state.get("completed", []),
                current=payload.topic, status="active", fallback_to_chips=True, tutor=_tutor(container),
            )
        payload = payload.model_copy(update={"values": {**extracted, **payload.values}})
    state = merge_answer(interview_state, payload)
    profile = container.repository.get_learner_profile() or {}
    profile_fields = LearnerProfile.model_fields.keys()
    enrollment_fields = EnrollmentSettings.model_fields.keys()
    profile.update({key: value for key, value in payload.values.items() if key in profile_fields})
    enrollment.update({key: value for key, value in payload.values.items() if key in enrollment_fields})
    enrollment.pop("interview_status", None)
    enrollment.pop("placement_status", None)
    profile = LearnerProfile.model_validate(profile).model_dump(mode="json")
    enrollment = EnrollmentSettings.model_validate(enrollment).model_dump(mode="json")
    container.repository.upsert_learner_profile(profile)
    explicit_fields = set(get_setting(container.repository, "learner_profile_explicit_fields", []))
    explicit_fields.update(key for key in payload.values if key in profile_fields)
    put_setting(container.repository, "learner_profile_explicit_fields", sorted(explicit_fields))
    container.repository.upsert_course_enrollment(course_id, enrollment)
    container.repository.save_interview_state(course_id, state)
    status = "done" if state["current"] is None else "active"
    container.repository.update_enrollment_progress(course_id, interview_status=status)
    return InterviewState(
        topics=list(TOPICS), completed=state["completed"], current=state["current"], status=status,
        tutor=_tutor(container),
    )


@router.post("/courses/{course_id}/interview/skip")
def skip_interview(course_id: str, container: Container) -> InterviewState:
    if container.repository.update_enrollment_progress(course_id, interview_status="skipped") is None:
        raise ResourceNotFoundError("Course not found")
    return InterviewState(topics=list(TOPICS), completed=[], current=None, status="skipped")


def _initial_points(container: ServiceContainer, course_id: str, enrollment: dict) -> list[dict]:
    points = container.repository.learning_points(course_id)
    for point in points:
        if point["p"] is None:
            probability = initial_mastery_probability(
                enrollment["self_level"], hard_unit=point["unit_id"] in enrollment["hard_units"],
            )
            container.repository.save_mastery(course_id, point["id"], probability=probability, inferred=False)
            point.update(p=probability, status="unseen", inferred=0, evidence_count=0)
    return points


def _mastery(points: list[dict]) -> list[dict]:
    return [{
        "kp_id": point["id"], "name": point["name"], "unit_id": point["unit_id"],
        "probability": point["p"], "status": None if point["inferred"] else point["status"],
        "inferred": bool(point["inferred"]),
    } for point in points]


def _placement_summary(points: list[dict]) -> PlacementSummary | None:
    if not points:
        return None
    strongest = max(points, key=lambda point: (point["p"], -point["ord"]))
    weakest = min(points, key=lambda point: (point["p"], point["ord"]))
    inferred = sum(bool(point["inferred"]) for point in points)
    return PlacementSummary(
        strongest_name=strongest["name"], strongest_probability=strongest["p"],
        priority_name=weakest["name"], priority_probability=weakest["p"], inferred_count=inferred,
    )


def _placement_result(container: ServiceContainer, course_id: str, started_at: datetime) -> PlacementResult:
    enrollment = _course_or_404(container, course_id)
    points = _initial_points(container, course_id, enrollment)
    items = container.repository.diagnostic_items(course_id)
    answered = container.repository.answered_diagnostic_items(course_id)
    by_kp = {item["kp_id"]: item for item in items if item["id"] not in answered}
    successors = {point["id"]: 0.0 for point in points}
    for point in points:
        for prerequisite in point["prerequisite_ids"]:
            successors[prerequisite] = successors.get(prerequisite, 0) + point["weight"]
    candidates = [PlacementCandidate(
        kp_id=point["id"], unit_id=point["unit_id"], order=point["ord"], weight=point["weight"],
        probability=point["p"], successor_weight=successors.get(point["id"], 0),
    ) for point in points if point["id"] in by_kp]
    candidate = select_candidate(candidates)
    max_weight = max((item.weight + 0.5 * item.successor_weight for item in candidates), default=0)
    max_information = max((item.information / max_weight for item in candidates), default=None) if max_weight else None
    done = not items or candidate is None or should_stop(
        answered=len(answered), started_at=started_at, now=datetime.now(timezone.utc),
        max_information=max_information,
    )
    if done:
        status = "skipped" if not items else "done"
        container.repository.update_enrollment_progress(course_id, placement_status=status)
        return PlacementResult(
            status=status, question=None, mastery=_mastery(points), summary=_placement_summary(points),
        )
    container.repository.update_enrollment_progress(course_id, placement_status="active")
    item = by_kp[candidate.kp_id]
    public = {key: value for key, value in item.items() if key not in {"answer", "solution", "verify", "rubric"}}
    return PlacementResult(
        status="active", mastery=_mastery(points),
        question=PlacementQuestion(
            item_id=item["id"], kp_id=item["kp_id"], type=item["type"],
            stem=str(public.get("stem", "")), options=public.get("options", {}),
            answered=len(answered), started_at=started_at,
        ),
    )


@router.get("/courses/{course_id}/placement")
def get_placement(course_id: str, container: Container) -> PlacementResult:
    enrollment = _course_or_404(container, course_id)
    if enrollment["placement_status"] in {"done", "skipped"}:
        points = _initial_points(container, course_id, enrollment)
        return PlacementResult(
            status=enrollment["placement_status"], question=None, mastery=_mastery(points),
            summary=_placement_summary(points),
        )
    return _placement_result(container, course_id, datetime.now(timezone.utc))


def _is_correct(item: dict, answer: object) -> bool:
    expected = item.get("answer")
    if item["type"] == "multi":
        return {str(value).strip().upper() for value in (answer if isinstance(answer, list) else [])} == {
            str(value).strip().upper() for value in (expected if isinstance(expected, list) else str(expected or "").split(","))
        }
    if item["type"] == "numeric":
        try:
            return abs(float(answer) - float(expected)) <= 1e-9
        except (TypeError, ValueError):
            return False
    return str(answer).strip().casefold() == str(expected).strip().casefold()


@router.post("/courses/{course_id}/placement/answer")
def answer_placement(course_id: str, payload: PlacementAnswer, container: Container) -> PlacementResult:
    enrollment = _course_or_404(container, course_id)
    item = next((entry for entry in container.repository.diagnostic_items(course_id) if entry["id"] == payload.item_id), None)
    if item is None or payload.item_id in container.repository.answered_diagnostic_items(course_id):
        raise ResourceNotFoundError("Diagnostic item not found")
    points = {point["id"]: point for point in _initial_points(container, course_id, enrollment)}
    point = points[item["kp_id"]]
    verdict = "dont_know" if payload.dont_know else ("correct" if _is_correct(item, payload.answer) else "incorrect")
    options = item.get("options", {})
    evidence = Evidence(
        source="diagnostic", verdict=verdict, hint_level=0, item_type=item["type"], judged_by="exact",
        n_options=len(options) if item["type"] == "choice" else None,
    )
    updated = update_mastery_probability(point["p"], evidence)
    container.repository.save_diagnostic_evidence(
        course_id, point["id"], item["id"], verdict=verdict, item_type=item["type"],
        n_options=evidence.n_options, p_before=point["p"], p_after=updated,
    )
    refreshed = container.repository.learning_points(course_id)
    probabilities = {entry["id"]: entry["p"] for entry in refreshed}
    prerequisites = {entry["id"]: entry["prerequisite_ids"] for entry in refreshed}
    evidenced = {entry["id"] for entry in refreshed if entry["evidence_count"]}
    for kp_id, probability in inferred_updates(
        kp_id=point["id"], verdict=verdict, probability=updated, item_type=item["type"],
        prerequisites=prerequisites, probabilities=probabilities, evidenced=evidenced,
    ).items():
        container.repository.save_mastery(course_id, kp_id, probability=probability, inferred=True)
    return _placement_result(container, course_id, datetime.now(timezone.utc))


@router.post("/courses/{course_id}/placement/finish")
def finish_placement(course_id: str, container: Container) -> PlacementResult:
    enrollment = _course_or_404(container, course_id)
    container.repository.update_enrollment_progress(course_id, placement_status="done")
    points = _initial_points(container, course_id, enrollment)
    return PlacementResult(status="done", question=None, mastery=_mastery(points), summary=_placement_summary(points))


@router.get("/courses/{course_id}/plan")
def get_plan(course_id: str, container: Container) -> dict:
    _course_or_404(container, course_id)
    return container.repository.current_plan(course_id) or {"items": [], "deferred": [], "version": 0}


@router.post("/courses/{course_id}/plan")
async def create_plan(course_id: str, payload: PlanRequest, container: Container) -> dict:
    enrollment = _course_or_404(container, course_id)
    settings = EnrollmentSettings.model_validate({
        key: value for key, value in enrollment.items() if key in EnrollmentSettings.model_fields
    })
    points = _initial_points(container, course_id, enrollment)
    mapping_status = "unused"
    highlighted: set[str] = set()
    if enrollment.get("teacher_hints", "").strip():
        try:
            highlighted = await map_teacher_hints(
                container.gateway, text=enrollment["teacher_hints"], points=points,
            )
            mapping_status = "mapped"
        except (ProviderError, ValueError):
            mapping_status = "unavailable"
    planning_points = [PlanningPoint(
        id=point["id"], name=point["name"], kind=point["kind"], difficulty=point["difficulty"],
        order=point["ord"], prerequisites=tuple(point["prerequisite_ids"]), weight=point["weight"],
        probability=point["p"], assumed=bool(point["assumed"]), status=point["status"],
        highlighted=point["id"] in highlighted,
    ) for point in points]
    with container.repository.connection() as connection:
        practice = {row["kp_id"] for row in connection.execute(
            """SELECT DISTINCT kp_id FROM item_bank WHERE space_id = ? AND purpose IN ('practice', 'check')
               AND verify_status = 'verified' AND reserved = 0""", (course_id,),
        )}
        has_mock = bool(connection.execute(
            "SELECT 1 FROM exam_papers WHERE space_id = ? AND reserved_for_mock = 1 LIMIT 1", (course_id,),
        ).fetchone())
    result = build_plan(
        planning_points, today=payload.today, exam_date=settings.exam_date,
        weekly_days=settings.weekly_days, session_minutes=settings.session_minutes,
        has_practice=practice, has_mock=has_mock,
    )
    result["params"] = {
        "today": payload.today.isoformat(), "exam_date": settings.exam_date.isoformat()
        if settings.exam_date else None,
        "hints_mapping": mapping_status, "highlighted_kp_ids": sorted(highlighted),
    }
    if payload.reason != "setup":
        result = stabilize_plan(result, container.repository.current_plan(course_id))
    ready: list[str] = []
    saved = persist_plan(
        container.repository, course_id, result, reason=payload.reason, on_plan_ready=ready.append,
    )
    if ready:
        await queue_upcoming_lessons(container.jobs, container.repository, course_id)
    return saved


@router.post("/courses/{course_id}/plan/replan")
async def replan(course_id: str, payload: PlanRequest, container: Container) -> dict:
    return await create_plan(course_id, payload, container)


@router.patch("/plan-items/{item_id}")
def adjust_plan_item(item_id: str, payload: PlanItemPatch, container: Container) -> dict:
    if payload.direction is None and payload.pinned is None:
        raise ValueError("Choose a plan item adjustment.")
    plan = container.repository.adjust_plan_item(
        item_id, direction=payload.direction, pinned=payload.pinned,
    )
    if plan is None:
        raise ResourceNotFoundError("Plan item not found")
    return plan


@router.post("/plan-items/{item_id}/skip-quiz")
def skip_quiz(item_id: str, payload: SkipQuizRequest, container: Container) -> dict:
    plan_item = container.repository.locate_plan_item(item_id)
    if plan_item is None:
        raise ResourceNotFoundError("Plan item not found")
    questions = container.repository.skip_quiz_items(plan_item["space_id"], plan_item["kp_ids"])
    if len(questions) != len(plan_item["kp_ids"]):
        return {"available": False, "passed": False, "questions": []}
    public = [{key: value for key, value in question.items() if key not in {"answer", "solution", "verify", "rubric"}}
              for question in questions]
    if payload.answers is None:
        return {"available": True, "passed": False, "questions": public}
    passed = all(question["id"] in payload.answers and _is_correct(question, payload.answers[question["id"]])
                 for question in questions)
    if passed:
        points = {point["id"]: point for point in container.repository.learning_points(plan_item["space_id"])}
        for question in questions:
            point = points[question["kp_id"]]
            options = question.get("options", {})
            evidence = Evidence(
                source="skip_verify", verdict="correct", hint_level=0, item_type=question["type"],
                judged_by="exact", n_options=len(options) if question["type"] == "choice" else None,
            )
            updated = update_mastery_probability(point["p"], evidence)
            container.repository.save_diagnostic_evidence(
                plan_item["space_id"], point["id"], question["id"], verdict="correct",
                item_type=question["type"], n_options=evidence.n_options,
                p_before=point["p"], p_after=updated, source="skip_verify",
            )
        container.repository.mark_plan_item_skipped(plan_item["space_id"], item_id)
    return {"available": True, "passed": passed, "questions": public}
