from fastapi.testclient import TestClient

from app.services.browser_session import CSRF_COOKIE_NAME, CSRF_HEADER_NAME


def test_profile_is_saved_and_requires_owner_csrf(client: TestClient):
    profile_path = "/api/v2/learner/profile"
    assert client.get(profile_path).status_code == 401
    assert client.post("/api/v2/session/bootstrap").status_code == 200
    assert client.put(profile_path, json={"nickname": "Lin"}).status_code == 403
    headers = {
        CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME],
        "Origin": "http://127.0.0.1:8000",
    }
    updated = client.put(profile_path, json={"nickname": " Lin ", "pace": "slow"}, headers=headers)
    assert updated.status_code == 200
    assert (updated.json()["nickname"], updated.json()["pace"]) == ("Lin", "slow")
    assert client.get(profile_path).json() == updated.json()


def test_enrollment_validates_and_is_scoped_to_the_course(client: TestClient, owner_token: str):
    headers = {"Authorization": f"Bearer {owner_token}"}
    first = client.post("/api/v2/courses", headers=headers, json={"name": "Course one"}).json()["id"]
    second = client.post("/api/v2/courses", headers=headers, json={"name": "Course two"}).json()["id"]
    first_path = f"/api/v2/courses/{first}/enrollment"
    second_path = f"/api/v2/courses/{second}/enrollment"
    original = client.get(second_path, headers=headers).json()
    assert original["course_id"] == second
    assert client.get(first_path).status_code == 401

    settings = {
        "goal_type": "exam", "exam_date": "2027-01-10", "weekly_days": [2, 4],
        "session_minutes": 45, "target_score": 75, "full_score": 80, "self_level": "basic",
    }
    saved = client.put(first_path, json=settings, headers=headers)
    assert saved.status_code == 200
    assert saved.json()["course_id"] == first
    assert all(saved.json()[key] == value for key, value in settings.items())
    for wrong in ({"weekly_days": [0]}, {"weekly_days": [2, 2]}, {"target_score": 81},
                  {"placement_status": "done"}, {"session_minutes": 0}):
        assert client.put(first_path, json={**settings, **wrong}, headers=headers).status_code == 422
    assert client.get(first_path, headers=headers).json() == saved.json()
    assert client.get(second_path, headers=headers).json() == original

    assert client.delete(f"/api/v2/courses/{first}", headers=headers).status_code == 204
    assert client.get(first_path, headers=headers).status_code == 404
    assert client.put(first_path, json=settings, headers=headers).status_code == 404
