import sqlite3

import pytest

from app.analysis.course_data import CourseData
from app.analysis.models import CourseInput
from app.services.repository import SQLiteRepository


def test_plan_items_belong_to_the_same_course_and_are_removed_with_it(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    courses = CourseData(repository)
    first = courses.create_course(CourseInput(name="First"))
    second = courses.create_course(CourseInput(name="Second"))
    with repository.connection() as conn:
        conn.execute(
            "INSERT INTO study_plans (id, space_id, version, status, created_at) VALUES (?, ?, 1, 'active', ?)",
            ("plan", first.id, "2026-11-17"),
        )
        insert_item = """INSERT INTO plan_items (id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes)
                         VALUES ('item', 'plan', ?, 1, 'lesson', 'Read', '[]', 15)"""
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert_item, (second.id,))
        conn.execute(insert_item, (first.id,))

    repository.upsert_course_enrollment(first.id, {"exam_name": "First exam"})
    repository.upsert_course_enrollment(second.id, {"exam_name": "Second exam"})
    assert repository.delete_space(first.id)
    with repository.connection() as conn:
        assert conn.execute("SELECT id FROM plan_items WHERE space_id = ?", (first.id,)).fetchone() is None
        assert conn.execute("SELECT id FROM study_plans WHERE space_id = ?", (first.id,)).fetchone() is None
        assert conn.execute("SELECT space_id FROM course_enrollment WHERE space_id = ?", (first.id,)).fetchone() is None
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert repository.get_course_enrollment(second.id)["exam_name"] == "Second exam"
