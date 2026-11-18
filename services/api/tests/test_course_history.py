from datetime import datetime, timezone

from app.api.deps import get_container
from app.models.domain import CompanionTurn, SessionRecord
from support_legacy_records import seed_session, seed_turn


def test_legacy_transcript_is_read_only_and_course_scoped(client, owner_token):
    headers = {"Authorization": f"Bearer {owner_token}"}
    first = client.post("/api/v2/courses", headers=headers, json={"name": "Course A"}).json()["id"]
    second = client.post("/api/v2/courses", headers=headers, json={"name": "Course B"}).json()["id"]
    repository = get_container().repository
    now = datetime.now(timezone.utc)
    session = seed_session(repository, SessionRecord(id="conversation", space_id=first, created_at=now, updated_at=now))
    seed_turn(repository, CompanionTurn(id="turn", session_id=session.id, space_id=first, role="user",
                                        display_text="Example <script>", spoken_text="Example", created_at=now))

    collection = client.get(f"/api/v2/courses/{first}/history", headers=headers)
    assert collection.status_code == 200, collection.json()
    assert [entry["id"] for entry in collection.json()["legacy"]] == [session.id]
    assert client.get(f"/api/v2/courses/{second}/history", headers=headers).json()["legacy"] == []
    export_path = f"/api/v2/courses/{first}/legacy/{session.id}/markdown"
    assert client.get(export_path).status_code == 401
    assert client.get(f"/api/v2/courses/{second}/legacy/{session.id}/markdown", headers=headers).status_code == 404
    exported = client.get(export_path, headers=headers)
    assert exported.status_code == 200 and exported.headers["content-type"].startswith("text/markdown")
    assert "Example &lt;script&gt;" in exported.text
    assert repository.list_turns(session.id)[0].display_text == "Example <script>"

