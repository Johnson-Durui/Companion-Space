from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest

from app.api.deps import get_container
from app.models.domain import (
    CompanionTurn,
    LearningArtifactsStatus,
    MemoryItem,
    MemoryStatus,
    ModelAssignment,
    ProviderCapability,
    ProviderConnection,
    ReviewItem,
    ReviewStatus,
    TurnRole,
)
from app.providers.base import LLMProvider, ProviderMessage, ProviderStreamChunk


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class RecordingAnalysisProvider(LLMProvider):
    name = "recording-analysis"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ):
        self.calls.append(
            {
                "model": model,
                "system_prompt": system_prompt,
                "history": history,
                "user_message": user_message,
            }
        )
        yield ProviderStreamChunk(
            text=json.dumps(
                {
                    "summary": "这场会话先明确了概念，再把关键判断条件压缩成一个可复习结论。",
                    "memory_candidates": [
                        {"content": "用户这轮最卡的是单调区间为什么必要。", "sensitive": False}
                    ],
                    "review_items": [
                        {"prompt": "二分查找为什么需要单调区间？", "answer": "因为判断结果必须能稳定地缩小搜索边界。"}
                    ],
                },
                ensure_ascii=False,
            )
        )


def _patch_provider_factory(
    monkeypatch: pytest.MonkeyPatch,
    provider: LLMProvider,
) -> None:
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: provider,
    )


def _generated_artifact_rows(
    *,
    session_id: str,
    space_id: str,
    now: datetime,
) -> tuple[list[MemoryItem], list[ReviewItem]]:
    return (
        [
            MemoryItem(
                id=str(uuid4()),
                space_id=space_id,
                content="用户想继续巩固二分查找。",
                status=MemoryStatus.candidate,
                sensitive=False,
                source_session_id=session_id,
                created_at=now,
                updated_at=now,
            )
        ],
        [
            ReviewItem(
                id=str(uuid4()),
                space_id=space_id,
                prompt="什么时候可以使用二分查找？",
                answer="搜索区间必须满足可单调判定的条件。",
                due_at=now,
                status=ReviewStatus.pending,
                source_session_id=session_id,
                created_at=now,
                updated_at=now,
            )
        ],
    )


async def _run_mock_artifact_flow(*, sensitive_text: str) -> tuple[Any, Any]:
    container = get_container()
    space = container.spaces.create_space(
        name="M7 recap",
        topic="binary-search",
        goal="understand monotonic range",
    )
    session = container.companion.create_session(space_id=space.id)
    await container.companion.submit_text_turn(
        session_id=session.id,
        text=sensitive_text,
    )
    await container.companion.wait_for_learning_artifacts(session.id)
    container.companion.end_session(session.id)
    container.companion.schedule_learning_artifacts(
        session_id=session.id,
        include_candidates=True,
    )
    await container.companion.wait_for_learning_artifacts(session.id)
    return container, session


def test_fresh_container_starts_blank_without_law_luze_seed(isolated_settings) -> None:
    _ = isolated_settings
    container = get_container()

    assert container.repository.list_spaces() == []
    assert container.repository.list_provider_connections()
    assert container.repository.list_characters() == []
    assert all("律泽" not in connection["label"] for connection in container.providers.list_connections())
    with container.repository.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM materials").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_turn_summary_is_async_and_candidates_arrive_after_session_end(isolated_settings) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(
            name="Async recap",
            topic="binary-search",
            goal="understand monotonic range",
        )
        session = container.companion.create_session(space_id=space.id)
        await container.companion.submit_text_turn(
            session_id=session.id,
            text="我最近因为考试压力很大，还是不明白为什么二分查找一定要有单调区间。",
        )
        session_after_turn = await container.companion.wait_for_learning_artifacts(session.id)
        assert session_after_turn.generated_summary
        assert container.repository.list_session_memory_items(session.id) == []
        assert container.repository.list_session_review_items(session.id) == []

        container.companion.end_session(session.id)
        container.companion.schedule_learning_artifacts(
            session_id=session.id,
            include_candidates=True,
        )
        await container.companion.wait_for_learning_artifacts(session.id)

        memories = container.repository.list_session_memory_items(session.id)
        reviews = container.repository.list_session_review_items(session.id)
        assert len(memories) == 1
        assert memories[0].status is MemoryStatus.candidate
        assert memories[0].sensitive is True
        assert len(reviews) == 1

    asyncio.run(scenario())


def test_artifact_generation_is_idempotent_on_repeated_end_and_poll(isolated_settings) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container, session = await _run_mock_artifact_flow(
            sensitive_text="我想弄懂二分查找的单调性。",
        )
        first_summary = container.companion.get_session(session.id).generated_summary
        first_memory_count = len(container.repository.list_session_memory_items(session.id))
        first_review_count = len(container.repository.list_session_review_items(session.id))
        memory = container.repository.list_session_memory_items(session.id)[0]
        confirmed = memory.model_copy(update={"status": MemoryStatus.confirmed, "updated_at": datetime.now(timezone.utc)})
        container.repository.upsert_memory_item(confirmed)

        container.companion.end_session(session.id)
        container.companion.schedule_learning_artifacts(
            session_id=session.id,
            include_candidates=True,
        )

        assert container.companion.get_session(session.id).generated_summary == first_summary
        assert len(container.repository.list_session_memory_items(session.id)) == first_memory_count
        assert len(container.repository.list_session_review_items(session.id)) == first_review_count

    asyncio.run(scenario())


def test_ready_and_generated_rows_become_visible_in_one_transaction(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Atomic recap",
        topic="binary-search",
        goal="publish artifacts together",
    )
    session = container.companion.create_session(space_id=space.id)
    now = datetime.now(timezone.utc)
    container.repository.update_session_artifacts_status(
        session_id=session.id,
        status=LearningArtifactsStatus.running,
        error=None,
        updated_at=now,
    )
    memories, reviews = _generated_artifact_rows(
        session_id=session.id,
        space_id=space.id,
        now=now,
    )

    original_connection = container.repository.connection
    update_reached = threading.Event()
    allow_commit = threading.Event()
    worker_errors: list[BaseException] = []
    worker_thread: threading.Thread

    class ObservedConnection:
        def __init__(self, connection) -> None:
            self._connection = connection

        def execute(self, sql: str, parameters=()):
            cursor = self._connection.execute(sql, parameters)
            if (
                threading.current_thread() is worker_thread
                and "UPDATE sessions" in sql
                and "generated_summary" in sql
            ):
                update_reached.set()
                if not allow_commit.wait(timeout=5):
                    raise TimeoutError("Test did not release artifact transaction")
            return cursor

        def __getattr__(self, name: str):
            return getattr(self._connection, name)

    @contextmanager
    def observed_connection():
        with original_connection() as connection:
            if threading.current_thread() is worker_thread:
                yield ObservedConnection(connection)
            else:
                yield connection

    monkeypatch.setattr(container.repository, "connection", observed_connection)

    def complete_artifacts() -> None:
        try:
            container.repository.complete_session_generated_artifacts(
                session_id=session.id,
                generated_summary="原子发布的总结",
                memory_items=memories,
                review_items=reviews,
                replace_generated_items=True,
                updated_at=now,
            )
        except BaseException as exc:
            worker_errors.append(exc)

    worker_thread = threading.Thread(target=complete_artifacts)
    worker_thread.start()
    assert update_reached.wait(timeout=5)
    try:
        while_open = container.repository.get_session(session.id)
        assert while_open is not None
        assert while_open.artifacts_status is LearningArtifactsStatus.running
        assert container.repository.list_session_memory_items(session.id) == []
        assert container.repository.list_session_review_items(session.id) == []
    finally:
        allow_commit.set()
        worker_thread.join(timeout=5)

    assert not worker_thread.is_alive()
    assert worker_errors == []
    committed = container.repository.get_session(session.id)
    assert committed is not None
    assert committed.artifacts_status is LearningArtifactsStatus.ready
    assert committed.generated_summary == "原子发布的总结"
    assert [item.id for item in container.repository.list_session_memory_items(session.id)] == [
        memories[0].id
    ]
    assert [item.id for item in container.repository.list_session_review_items(session.id)] == [
        reviews[0].id
    ]


def test_recap_save_cannot_overwrite_concurrent_artifact_completion(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Concurrent recap save",
        topic="binary-search",
        goal="preserve artifact state",
    )
    session = container.companion.create_session(space_id=space.id)
    now = datetime.now(timezone.utc)
    memories, reviews = _generated_artifact_rows(
        session_id=session.id,
        space_id=space.id,
        now=now,
    )
    original_update = container.repository.update_session_recap_fields

    def complete_then_save(**kwargs):
        container.repository.complete_session_generated_artifacts(
            session_id=session.id,
            generated_summary="并发生成的新摘要",
            memory_items=memories,
            review_items=reviews,
            replace_generated_items=True,
            updated_at=now,
        )
        return original_update(**kwargs)

    monkeypatch.setattr(
        container.repository,
        "update_session_recap_fields",
        complete_then_save,
    )

    saved = container.companion.update_session_recap(
        session_id=session.id,
        summary="用户手动摘要",
        notes="用户手动笔记",
    )

    assert saved.summary == "用户手动摘要"
    assert saved.notes == "用户手动笔记"
    assert saved.generated_summary == "并发生成的新摘要"
    assert saved.artifacts_status is LearningArtifactsStatus.ready
    assert [item.id for item in container.repository.list_session_memory_items(session.id)] == [
        memories[0].id
    ]
    assert [item.id for item in container.repository.list_session_review_items(session.id)] == [
        reviews[0].id
    ]


def test_recap_undo_uses_latest_summary_without_overwriting_artifact_completion(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Concurrent recap undo",
        topic="binary-search",
        goal="restore latest generated summary",
    )
    session = container.companion.create_session(space_id=space.id)
    container.repository.update_session_recap_fields(
        session_id=session.id,
        summary="旧的手动摘要",
        notes="旧的手动笔记",
        updated_at=datetime.now(timezone.utc),
    )
    now = datetime.now(timezone.utc)
    memories, reviews = _generated_artifact_rows(
        session_id=session.id,
        space_id=space.id,
        now=now,
    )
    original_undo = container.repository.undo_session_recap_fields

    def complete_then_undo(**kwargs):
        container.repository.complete_session_generated_artifacts(
            session_id=session.id,
            generated_summary="并发生成的最新摘要",
            memory_items=memories,
            review_items=reviews,
            replace_generated_items=True,
            updated_at=now,
        )
        return original_undo(**kwargs)

    monkeypatch.setattr(
        container.repository,
        "undo_session_recap_fields",
        complete_then_undo,
    )

    undone = container.companion.undo_session_recap(session.id)

    assert undone.summary == "并发生成的最新摘要"
    assert undone.notes == ""
    assert undone.generated_summary == "并发生成的最新摘要"
    assert undone.artifacts_status is LearningArtifactsStatus.ready
    assert [item.id for item in container.repository.list_session_memory_items(session.id)] == [
        memories[0].id
    ]
    assert [item.id for item in container.repository.list_session_review_items(session.id)] == [
        reviews[0].id
    ]


def test_sensitive_memory_requires_explicit_confirm_action(client, owner_token: str) -> None:
    space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Sensitive recap", "topic": "binary-search", "goal": "memory"},
    ).json()
    session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space["id"]},
    ).json()

    container = get_container()

    async def scenario() -> None:
        await container.companion.submit_text_turn(
            session_id=session["id"],
            text="我最近因为考试压力很大，所以老是卡在二分查找的判断条件。",
        )
        await container.companion.wait_for_learning_artifacts(session["id"])

    asyncio.run(scenario())
    container.companion.end_session(session["id"])

    async def build_artifacts() -> None:
        container.companion.schedule_learning_artifacts(
            session_id=session["id"],
            include_candidates=True,
        )
        await container.companion.wait_for_learning_artifacts(session["id"])

    asyncio.run(build_artifacts())

    transcript = client.get(
        f"/api/v1/sessions/{session['id']}",
        headers=_auth_headers(owner_token),
    )
    assert transcript.status_code == 200
    memory = transcript.json()["memory_candidates"][0]

    update_response = client.put(
        f"/api/v1/memory/{space['id']}/{memory['id']}",
        headers=_auth_headers(owner_token),
        json={
            "content": memory["content"],
            "status": "confirmed",
            "sensitive": True,
        },
    )
    assert update_response.status_code == 409

    confirm_response = client.post(
        f"/api/v1/memory/{space['id']}/{memory['id']}/confirm",
        headers=_auth_headers(owner_token),
    )
    assert confirm_response.status_code == 200
    assert confirm_response.json()["status"] == "confirmed"


def test_session_recap_can_save_and_undo_without_cross_space_leak(client, owner_token: str) -> None:
    first_space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Space A", "topic": "binary-search", "goal": "A"},
    ).json()
    second_space = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": "Space B", "topic": "graph", "goal": "B"},
    ).json()
    first_session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": first_space["id"]},
    ).json()
    second_session = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": second_space["id"]},
    ).json()

    container = get_container()

    async def scenario() -> None:
        await container.companion.submit_text_turn(
            session_id=first_session["id"],
            text="解释一下二分查找为什么要单调。",
        )
        await container.companion.wait_for_learning_artifacts(first_session["id"])
        container.companion.end_session(first_session["id"])
        container.companion.schedule_learning_artifacts(
            session_id=first_session["id"],
            include_candidates=True,
        )
        await container.companion.wait_for_learning_artifacts(first_session["id"])

    asyncio.run(scenario())

    saved = client.put(
        f"/api/v1/sessions/{first_session['id']}/recap",
        headers=_auth_headers(owner_token),
        json={"summary": "手动摘要", "notes": "手动笔记"},
    )
    assert saved.status_code == 200
    assert saved.json()["session"]["summary"] == "手动摘要"
    assert saved.json()["session"]["notes"] == "手动笔记"
    assert len(saved.json()["memory_candidates"]) == 1

    undone = client.post(
        f"/api/v1/sessions/{first_session['id']}/recap/undo",
        headers=_auth_headers(owner_token),
    )
    assert undone.status_code == 200
    assert undone.json()["session"]["summary"] != "手动摘要"
    assert undone.json()["session"]["notes"] == ""

    other = client.get(
        f"/api/v1/sessions/{second_session['id']}",
        headers=_auth_headers(owner_token),
    )
    assert other.status_code == 200
    assert other.json()["memory_candidates"] == []
    assert other.json()["review_items"] == []


def test_analysis_provider_is_used_for_non_mock_learning_artifacts(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    provider = RecordingAnalysisProvider()
    _patch_provider_factory(monkeypatch, provider)
    container = get_container()
    container.vault.initialize("artifact-secret-pass")

    now = datetime.now(timezone.utc)
    connection = container.repository.upsert_provider_connection(
        ProviderConnection(
            id="analysis-test-connection",
            provider="anthropic",
            label="Anthropic Test",
            capabilities=[ProviderCapability.chat_llm, ProviderCapability.analysis_llm],
            created_at=now,
            updated_at=now,
        )
    )
    container.vault.put_provider_secret(connection.id, "test-secret")

    async def scenario() -> None:
        space = container.spaces.create_space(
            name="Real analysis recap",
            topic="binary-search",
            goal="understand monotonic range",
        )
        container.repository.upsert_model_assignment(
            ModelAssignment(
                id=str(uuid4()),
                space_id=space.id,
                capability=ProviderCapability.analysis_llm,
                provider_connection_id=connection.id,
                model_name="claude-sonnet-4-6",
                created_at=now,
                updated_at=now,
            )
        )
        session = container.companion.create_session(space_id=space.id)
        container.repository.add_turn(
            CompanionTurn(
                id=str(uuid4()),
                session_id=session.id,
                space_id=space.id,
                role=TurnRole.user,
                display_text="解释一下单调区间的必要性。",
                spoken_text="解释一下单调区间的必要性。",
                created_at=now,
            )
        )
        container.repository.add_turn(
            CompanionTurn(
                id=str(uuid4()),
                session_id=session.id,
                space_id=space.id,
                role=TurnRole.assistant,
                display_text="先确认条件是否满足单调，再决定能不能用二分。",
                spoken_text="先确认条件是否满足单调，再决定能不能用二分。",
                created_at=now,
            )
        )
        container.companion.end_session(session.id)
        container.companion.schedule_learning_artifacts(
            session_id=session.id,
            include_candidates=True,
        )
        await container.companion.wait_for_learning_artifacts(session.id)

    asyncio.run(scenario())

    assert len(provider.calls) == 1
    assert provider.calls[0]["model"] == "claude-sonnet-4-6"
    assert provider.calls[0]["history"] == []
    assert "transcript" in provider.calls[0]["system_prompt"]
