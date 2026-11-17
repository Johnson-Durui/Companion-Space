import time

from fastapi.testclient import TestClient
from fakes.e2e import BrowserHarnessGateway

from app.main import create_app
from app.providers.errors import ProviderTimeoutError
from app.services.browser_session import CSRF_COOKIE_NAME, CSRF_HEADER_NAME


def test_course_upload_requires_owner_and_scopes_material_metadata(client: TestClient, owner_token: str):
    assert client.get("/api/v2/courses").status_code == 401
    headers = {"Authorization": f"Bearer {owner_token}"}
    first = client.post("/api/v2/courses", json={"name": "Reading"}, headers=headers)
    second = client.post("/api/v2/courses", json={"name": "A separate course"}, headers=headers)
    assert first.status_code == second.status_code == 201
    course = first.json()["id"]
    other = second.json()["id"]
    upload = client.post(
        f"/api/v2/courses/{course}/materials",
        files=[("files", ("exam-2024.md", b"# Exam\n\nChoose one answer.", "text/markdown"))],
        headers=headers,
    )
    assert upload.status_code == 201
    material, = upload.json()
    assert (material["role"], material["year"]) == ("exam", 2024)
    assert client.patch(
        f"/api/v2/courses/{other}/materials/{material['id']}",
        json={"role": "notes"}, headers=headers,
    ).status_code == 404
    assert client.get(f"/api/v2/courses/{other}/materials", headers=headers).json() == []
    estimate = client.post(
        f"/api/v2/courses/{course}/analysis/start", json={"estimate_only": True}, headers=headers,
    )
    assert estimate.status_code == 200
    assert estimate.json()["estimated_tokens"] > 0
    assert estimate.json()["job"] is None


def test_retry_continues_from_saved_phase_and_retains_the_same_job(isolated_settings):
    calls = []

    class Gateway(BrowserHarnessGateway):
        async def complete_tagged(self, role, prompt_name, variables, **options):
            calls.append(prompt_name)
            if prompt_name == "analysis/course_brief" and calls.count(prompt_name) == 1:
                raise ProviderTimeoutError(provider="test", public_detail="Timed out")
            return await super().complete_tagged(role, prompt_name, variables, **options)

    def app_client():
        return TestClient(
            create_app(gateway_factory=Gateway, settings=isolated_settings),
            base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000),
        )

    def await_terminal(client, headers, course_id, status):
        for _ in range(250):
            job = client.get(f"/api/v2/courses/{course_id}/analysis/status", headers=headers).json()
            if job and job["status"] in {"completed", "failed"}:
                assert job["status"] == status, job
                return job
            time.sleep(0.02)
        raise AssertionError("Course analysis did not reach a terminal state")

    def bootstrap(client):
        assert client.post("/api/v2/session/bootstrap").status_code == 200
        return {CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME], "Origin": "http://127.0.0.1:8000"}

    with app_client() as first:
        headers = bootstrap(first)
        course = first.post("/api/v2/courses", json={"name": "A course"}, headers=headers).json()["id"]
        assert first.post(
            f"/api/v2/courses/{course}/materials/note",
            json={"title": "A note", "content": "# Conditions\n\nRead the two conditions.", "role": "textbook"},
            headers=headers,
        ).status_code == 201
        submitted = first.post(f"/api/v2/courses/{course}/analysis/start", json={}, headers=headers).json()["job"]
        failed = await_terminal(first, headers, course, "failed")
        assert failed["stage"] == "brief"
        assert failed["error"] == "provider_timeout"
        assert failed["payload"] == {}

    with app_client() as resumed:
        headers = bootstrap(resumed)
        retried = resumed.post(
            f"/api/v2/courses/{course}/analysis/retry", json={"stage": "brief"}, headers=headers,
        )
        assert retried.status_code == 200
        assert retried.json()["id"] == submitted["id"]
        await_terminal(resumed, headers, course, "completed")
        assert resumed.get(f"/api/v2/courses/{course}/map", headers=headers).json()["units"]

    assert calls.count("analysis/kp_extract") == 1
    assert calls.count("analysis/kp_reduce") == 1
    assert calls.count("analysis/course_brief") == 2
