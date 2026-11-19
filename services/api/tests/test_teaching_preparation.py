import asyncio

from app.services.repository import SQLiteRepository
from app.services.jobs import JobRunner
from app.teaching.planner import LessonPlanner
from app.teaching.preparation import prepare_upcoming_lessons, queue_upcoming_lessons, register_preparation_jobs
from test_teaching_storage import _seed_plan


def test_preparation_only_builds_the_next_two_unstarted_lessons(isolated_settings, monkeypatch):
    repository = SQLiteRepository(isolated_settings)
    with repository.connection() as connection:
        _seed_plan(connection, "course", "one")
        for item_id, order in (("two", 2), ("three", 3)):
            connection.execute(
                """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
                   VALUES (?, 'plan:course', 'course', ?, 'lesson', ?, '["kp1"]', 20)""",
                (item_id, order, item_id),
            )

    calls = []

    async def prepare(_self, course_id, item_id):
        calls.append((course_id, item_id))
        return {"id": f"ready:{item_id}"}

    monkeypatch.setattr(LessonPlanner, "prepare", prepare)
    result = asyncio.run(prepare_upcoming_lessons(repository, object(), "course"))
    assert calls == [("course", "one"), ("course", "two")]
    assert result == [{"id": "ready:one"}, {"id": "ready:two"}]


def test_upcoming_preparation_is_persistently_queued_without_running_inline(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    with repository.connection() as connection:
        _seed_plan(connection, "course", "one")
        for item_id, order in (("two", 2), ("three", 3)):
            connection.execute(
                """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
                   VALUES (?, 'plan:course', 'course', ?, 'lesson', ?, '["kp1"]', 20)""",
                (item_id, order, item_id),
            )
    jobs = JobRunner(repository)
    register_preparation_jobs(jobs, repository, object(), set())
    queued = asyncio.run(queue_upcoming_lessons(jobs, repository, "course"))
    assert [job.payload["plan_item_id"] for job in queued] == ["one", "two"]
    assert all(job.status == "queued" for job in queued)
