from datetime import datetime, timezone

import pytest

from app.api.deps import get_container
from app.models.domain import Citation
from app.services.pedagogical_orchestrator import PedagogicalOrchestrator


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def _space_and_session(client, owner_token: str, *, name: str):
    headers = _headers(owner_token)
    space_response = client.post(
        "/api/v1/spaces",
        headers=headers,
        json={"name": name, "topic": "algorithms", "goal": "grounded learning"},
    )
    assert space_response.status_code == 201
    space = space_response.json()
    session_response = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": space["id"]},
    )
    assert session_response.status_code == 201
    return space, session_response.json()


def test_classroom_restores_grounded_board_and_hides_quiz_answer(client, owner_token) -> None:
    headers = _headers(owner_token)
    space, session = _space_and_session(client, owner_token, name="Binary search")
    note_response = client.post(
        f"/api/v1/spaces/{space['id']}/materials/note",
        headers=headers,
        json={
            "title": "Boundary notes",
            "content": "Binary search preserves a closed interval and checks left <= right. The midpoint avoids overflow.",
        },
    )
    assert note_response.status_code == 201
    get_container().spaces.wait_for_ingestion(note_response.json()["job"]["id"], timeout_seconds=2)

    missing = client.get(f"/api/v1/sessions/{session['id']}/classroom", headers=headers)
    assert missing.status_code == 404

    started = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/start",
        headers=headers,
        json={"topic": "binary search boundaries"},
    )
    assert started.status_code == 200
    payload = started.json()
    assert [item["kind"] for item in payload["board_actions"]] == [
        "concept_sheet",
        "step_sandbox",
        "interactive_diagram",
        "checkpoint_quiz",
        "laser_focus",
    ]
    quiz = next(item for item in payload["board_actions"] if item["kind"] == "checkpoint_quiz")
    diagram_action = next(
        item for item in payload["board_actions"] if item["kind"] == "interactive_diagram"
    )
    assert diagram_action["payload"]["edges"][0] == {
        "from_id": "S0",
        "to_id": "S1",
        "label": None,
    }
    assert "correct_answer_id" not in quiz["payload"]
    assert "explanation" not in quiz["payload"]
    assert payload["citations"]
    assert set(quiz["citation_ids"]) == {item["chunk_id"] for item in payload["citations"]}

    asked = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={
            "type": "ask",
            "action_id": "sandbox",
            "question": "为什么这里要保留闭区间？",
        },
    )
    assert asked.status_code == 200
    assert asked.json()["feedback"]["kind"] == "answer"
    assert "预设回复" in asked.json()["tutor"]["narration"]
    provider_question = get_container().repository.list_turns(session["id"])[-2]
    assert "当前板书：单步推演" in provider_question.display_text
    assert "为什么这里要保留闭区间" in provider_question.display_text

    restored = client.get(f"/api/v1/sessions/{session['id']}/classroom", headers=headers)
    assert restored.status_code == 200
    assert restored.json()["active_action_id"] == "concept"

    sandbox = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "advance"},
    ).json()
    assert sandbox["phase"] == "sandbox"
    sandbox_action = next(item for item in sandbox["board_actions"] if item["kind"] == "step_sandbox")
    assert sandbox_action["payload"]["current_step"] == 0
    for expected_step in (1, 2):
        sandbox = client.post(
            f"/api/v1/sessions/{session['id']}/classroom/events",
            headers=headers,
            json={"type": "advance"},
        ).json()
        sandbox_action = next(item for item in sandbox["board_actions"] if item["kind"] == "step_sandbox")
        assert sandbox["phase"] == "sandbox"
        assert sandbox_action["payload"]["current_step"] == expected_step
    diagram = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "advance"},
    ).json()
    assert diagram["phase"] == "diagram"
    quiz_phase = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "advance"},
    ).json()
    assert quiz_phase["phase"] == "quiz"

    wrong = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "quiz_answer", "answer_id": "a"},
    )
    assert wrong.status_code == 200
    assert wrong.json()["feedback"] == {
        "kind": "correction",
        "message": "这个选项会破坏边界不变量。请观察指针收缩后目标是否仍在区间内。",
        "correct": False,
    }

    correct = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "quiz_answer", "answer_id": "b"},
    )
    assert correct.status_code == 200
    assert correct.json()["phase"] == "review"
    assert correct.json()["feedback"]["correct"] is True


def test_classroom_flashcards_are_space_scoped_confirmed_and_fsrs_scheduled(client, owner_token) -> None:
    headers = _headers(owner_token)
    first_space, session = _space_and_session(client, owner_token, name="First")
    second_space, _ = _space_and_session(client, owner_token, name="Second")
    start = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/start",
        headers=headers,
        json={"topic": "state invariants"},
    )
    assert start.status_code == 200
    generic_sandbox = next(
        item for item in start.json()["board_actions"] if item["kind"] == "step_sandbox"
    )
    assert "left <= right" not in generic_sandbox["payload"]["code"]

    ended_early = client.post(
        f"/api/v1/sessions/{session['id']}/end",
        headers=headers,
        json={"summary": "Finished the classroom"},
    )
    assert ended_early.status_code == 200
    early_cards = client.get(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards",
        headers=headers,
        params={"status_filter": "proposed"},
    )
    assert early_cards.json()["items"] == []

    completed_session = client.post(
        "/api/v1/sessions",
        headers=headers,
        json={"space_id": first_space["id"]},
    ).json()
    assert client.post(
        f"/api/v1/sessions/{completed_session['id']}/classroom/start",
        headers=headers,
        json={"topic": "state invariants"},
    ).status_code == 200
    for _ in range(5):
        advanced = client.post(
            f"/api/v1/sessions/{completed_session['id']}/classroom/events",
            headers=headers,
            json={"type": "advance"},
        )
        assert advanced.status_code == 200
    assert advanced.json()["phase"] == "quiz"
    assert client.post(
        f"/api/v1/sessions/{completed_session['id']}/classroom/events",
        headers=headers,
        json={"type": "quiz_answer", "answer_id": "b"},
    ).status_code == 200
    ended = client.post(
        f"/api/v1/sessions/{completed_session['id']}/end",
        headers=headers,
        json={"summary": "Finished the classroom"},
    )
    assert ended.status_code == 200
    proposed = client.get(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards",
        headers=headers,
        params={"status_filter": "proposed"},
    )
    assert proposed.status_code == 200
    cards = proposed.json()["items"]
    assert len(cards) == 2
    assert all(card["status"] == "proposed" for card in cards)

    assert client.get(
        f"/api/v1/spaces/{second_space['id']}/classroom/flashcards",
        headers=headers,
    ).json()["items"] == []

    card_id = cards[0]["id"]
    rate_before_confirm = client.post(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards/{card_id}/rate",
        headers=headers,
        json={"rating": 3},
    )
    assert rate_before_confirm.status_code == 409

    confirmed = client.post(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards/{card_id}/confirm",
        headers=headers,
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "active"
    assert confirmed.json()["due_at"] is not None

    rated = client.post(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards/{card_id}/rate",
        headers=headers,
        json={"rating": 3},
    )
    assert rated.status_code == 200, rated.text
    rated_card = rated.json()
    assert rated_card["reps"] == 1
    assert rated_card["stability"] is not None
    assert rated_card["difficulty"] is not None
    assert datetime.fromisoformat(rated_card["due_at"]) > datetime.now(timezone.utc)

    active = client.get(
        f"/api/v1/spaces/{first_space['id']}/classroom/flashcards",
        headers=headers,
        params={"status_filter": "active"},
    )
    assert active.status_code == 200
    assert [item["id"] for item in active.json()["items"]] == [card_id]
    assert active.json()["items"][0]["citations"] == cards[0]["citations"]


def test_binary_search_sandbox_accepts_only_declared_editable_target(client, owner_token) -> None:
    headers = _headers(owner_token)
    _, session = _space_and_session(client, owner_token, name="Editable sandbox")
    started = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/start",
        headers=headers,
        json={"topic": "binary search"},
    )
    assert started.status_code == 200
    sandbox = next(
        item for item in started.json()["board_actions"] if item["kind"] == "step_sandbox"
    )
    assert sandbox["payload"]["editable_parameters"] == ["target"]

    updated = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "update_parameters", "action_id": "sandbox", "parameters": {"target": 31}},
    )
    assert updated.status_code == 200
    updated_sandbox = next(
        item for item in updated.json()["board_actions"] if item["kind"] == "step_sandbox"
    )
    assert updated_sandbox["payload"]["current_step"] == 0
    assert updated_sandbox["payload"]["steps"][-1]["values"]["value"] == 31

    rejected = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/events",
        headers=headers,
        json={"type": "update_parameters", "parameters": {"values": "malicious replacement"}},
    )
    assert rejected.status_code == 400


def test_classroom_rejects_citation_metadata_outside_server_retrieval(client, owner_token) -> None:
    headers = _headers(owner_token)
    space, session = _space_and_session(client, owner_token, name="Citation validation")
    note = client.post(
        f"/api/v1/spaces/{space['id']}/materials/note",
        headers=headers,
        json={"title": "Ground truth", "content": "A verified source chunk for classroom use."},
    ).json()
    get_container().spaces.wait_for_ingestion(note["job"]["id"], timeout_seconds=2)
    chunk = get_container().repository.list_chunks(space["id"])[0]
    orchestrator = PedagogicalOrchestrator(
        get_container().repository,
        get_container().spaces,
        get_container().companion,
        get_container().demos,
    )
    with pytest.raises(RuntimeError, match="metadata does not match"):
        orchestrator._validated_citations(
            space["id"],
            [
                Citation(
                    chunk_id=chunk.id,
                    material_id=chunk.material_id,
                    title="Forged title",
                    locator=chunk.locator,
                    excerpt=chunk.content,
                )
            ],
        )


def test_provider_lesson_script_is_validated_into_topic_specific_board(
    client,
    owner_token,
    monkeypatch,
) -> None:
    headers = _headers(owner_token)
    _, session = _space_and_session(client, owner_token, name="Provider curriculum")

    async def provider_lesson(*, session_id: str, topic: str):
        assert session_id == session["id"]
        assert topic == "Kirchhoff current law"
        return {
            "session_id": session_id,
            "topic": topic,
            "script": {
                "title": "KCL node analysis",
                "steps": [
                    {
                        "board": {"kind": "markdown", "content": "At a node, signed current sums to zero."},
                        "caption": "Choose current directions",
                        "narration": "Assign a sign to every branch current.",
                    },
                    {
                        "board": {"kind": "mermaid", "content": "flowchart LR\nI1 --> N\nN --> I2"},
                        "caption": "Write the node equation",
                        "narration": "Use the chosen signs to write the conservation equation.",
                    },
                    {
                        "board": {
                            "kind": "highlight",
                            "content": "I1 - I2 - I3 = 0",
                            "target": "node equation",
                        },
                        "caption": "Check conservation",
                        "narration": "Substitute values and verify the signed sum is zero.",
                    },
                ],
            },
            "citations": [],
            "used_space_materials": False,
        }

    monkeypatch.setattr(get_container().demos, "create_demo", provider_lesson)
    response = client.post(
        f"/api/v1/sessions/{session['id']}/classroom/start",
        headers=headers,
        json={"topic": "Kirchhoff current law"},
    )
    assert response.status_code == 200
    actions = response.json()["board_actions"]
    concept = next(item for item in actions if item["kind"] == "concept_sheet")
    sandbox = next(item for item in actions if item["kind"] == "step_sandbox")
    diagram = next(item for item in actions if item["kind"] == "interactive_diagram")
    assert concept["payload"]["sections"][0]["markdown"] == (
        "At a node, signed current sums to zero."
    )
    assert sandbox["payload"]["steps"][1]["values"]["board"].startswith("flowchart")
    assert "At a node, signed current sums to zero." in sandbox["payload"]["code"]
    assert "lesson.advance(step)" not in sandbox["payload"]["code"]
    assert diagram["payload"]["mermaid"] == "flowchart LR\nI1 --> N\nN --> I2"
