from __future__ import annotations

from app.providers.errors import ProviderError, provider_error_code
from app.services.jobs import Job, JobFailure, JobProgress, JobRunner, ReportProgress
from app.teaching.planner import LessonPlanError, LessonPlanner


async def prepare_upcoming_lessons(repository, gateway, course_id: str, *, limit: int = 2) -> list[dict]:
    """Prepare the next unstarted lesson items without invalidating the plan on failure."""
    plan = repository.current_plan(course_id)
    if plan is None:
        return []
    prepared = []
    planner = LessonPlanner(repository, gateway)
    considered = 0
    for item in plan["items"]:
        if item["kind"] != "lesson" or item["status"] != "todo" or item.get("lesson_id"):
            continue
        considered += 1
        if considered > limit:
            break
        saved = repository.get_lesson_plan(course_id, item["id"])
        if saved is not None:
            prepared.append(saved)
            continue
        try:
            prepared.append(await planner.prepare(course_id, item["id"]))
        except (LessonPlanError, ProviderError, ValueError):
            continue
    return prepared


def register_preparation_jobs(jobs: JobRunner, repository, gateway, preparing: set[str]) -> None:
    async def prepare(job: Job, report: ReportProgress) -> None:
        if not job.space_id or not isinstance(job.payload.get("plan_item_id"), str):
            raise ValueError("Lesson preparation job is missing its plan item.")
        plan_item_id = job.payload["plan_item_id"]
        if repository.get_lesson_plan(job.space_id, plan_item_id) is not None:
            return
        if plan_item_id in preparing:
            return
        preparing.add(plan_item_id)
        await report(JobProgress(stage="lesson_prepare", progress=0.05))
        try:
            await LessonPlanner(repository, gateway).prepare(job.space_id, plan_item_id)
            await report(JobProgress(stage="lesson_prepare", progress=1.0))
        except ProviderError as exc:
            raise JobFailure(provider_error_code(exc)) from exc
        except (LessonPlanError, ValueError) as exc:
            raise JobFailure("lesson_prepare_failed") from exc
        finally:
            preparing.discard(plan_item_id)

    jobs.register("lesson_prepare", prepare)


async def queue_upcoming_lessons(jobs: JobRunner, repository, course_id: str, *, limit: int = 2) -> list[Job]:
    plan = repository.current_plan(course_id)
    if plan is None:
        return []
    queued = []
    considered = 0
    for item in plan["items"]:
        if item["kind"] != "lesson" or item["status"] != "todo" or item.get("lesson_id"):
            continue
        considered += 1
        if considered > limit:
            break
        if repository.get_lesson_plan(course_id, item["id"]) is not None:
            continue
        with repository.connection() as connection:
            pending = connection.execute(
                """SELECT 1 FROM jobs WHERE kind = 'lesson_prepare' AND space_id = ?
                   AND status IN ('queued', 'running')
                   AND json_extract(payload_json, '$.plan_item_id') = ? LIMIT 1""",
                (course_id, item["id"]),
            ).fetchone()
        if pending is None:
            queued.append(await jobs.submit(
                "lesson_prepare", space_id=course_id, payload={"plan_item_id": item["id"]},
            ))
    return queued
