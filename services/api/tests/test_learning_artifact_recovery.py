from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.main import app
from app.models.domain import (
    LearningArtifactsStatus,
    MemoryItem,
    MemoryStatus,
    ReviewItem,
    ReviewStatus,
)
from app.providers.errors import ProviderAuthenticationError
from app.services.companion import (
    CompanionService,
    GeneratedLearningArtifacts,
    GeneratedMemoryArtifact,
    GeneratedReviewArtifact,
)
from app.services.vault import VaultLockedError


def _generated_artifacts(summary: str) -> GeneratedLearningArtifacts:
    return GeneratedLearningArtifacts(
        summary=summary,
        memory_candidates=[
            GeneratedMemoryArtifact(content="重启后恢复的记忆候选。")
        ],
        review_items=[
            GeneratedReviewArtifact(
                prompt="重启后复盘了什么？",
                answer="恢复了尚未完成的学习产物任务。",
            )
        ],
    )


def test_repository_lists_only_recoverable_artifact_sessions(
    isolated_settings,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(name="Recovery scan")
    base = datetime(2026, 8, 6, tzinfo=timezone.utc)
    expected_ids: list[str] = []

    for offset, status in enumerate(LearningArtifactsStatus):
        session = container.companion.create_session(space_id=space.id)
        if offset % 2:
            session = container.companion.end_session(session.id)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=status,
            error="old error" if status is LearningArtifactsStatus.error else None,
            updated_at=base + timedelta(seconds=offset),
        )
        if status in {
            LearningArtifactsStatus.pending,
            LearningArtifactsStatus.running,
        }:
            expected_ids.append(session.id)

    recovered = container.repository.list_recoverable_artifact_sessions()

    assert [session.id for session in recovered] == expected_ids


def test_startup_recovers_pending_and_running_with_end_state_boundary(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Recovery boundary")
        open_session = container.companion.create_session(space_id=space.id)
        ended_session = container.companion.create_session(space_id=space.id)
        ended_session = container.companion.end_session(
            ended_session.id,
            summary="用户手动保留的摘要",
        )
        now = datetime.now(timezone.utc)
        container.repository.update_session_artifacts_status(
            session_id=open_session.id,
            status=LearningArtifactsStatus.pending,
            error=None,
            updated_at=now,
        )
        container.repository.update_session_artifacts_status(
            session_id=ended_session.id,
            status=LearningArtifactsStatus.running,
            error=None,
            updated_at=now,
        )
        calls: list[tuple[str, bool]] = []

        async def generate(*, session_id: str, include_candidates: bool):
            calls.append((session_id, include_candidates))
            return _generated_artifacts(f"generated:{session_id}")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 2
        await container.companion.wait_for_learning_artifacts(open_session.id)
        await container.companion.wait_for_learning_artifacts(ended_session.id)
        assert container.companion.start_learning_artifact_recovery() == 0

        assert set(calls) == {
            (open_session.id, False),
            (ended_session.id, True),
        }
        recovered_open = container.companion.get_session(open_session.id)
        recovered_ended = container.companion.get_session(ended_session.id)
        assert recovered_open.artifacts_status is LearningArtifactsStatus.ready
        assert recovered_ended.artifacts_status is LearningArtifactsStatus.ready
        assert recovered_ended.summary == "用户手动保留的摘要"
        assert recovered_ended.generated_summary == f"generated:{ended_session.id}"
        assert container.repository.list_session_memory_items(open_session.id) == []
        assert container.repository.list_session_review_items(open_session.id) == []
        assert len(container.repository.list_session_memory_items(ended_session.id)) == 1
        assert len(container.repository.list_session_review_items(ended_session.id)) == 1

    asyncio.run(scenario())


def test_turn_summary_cannot_publish_ready_after_session_end(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Artifact finalization boundary")
        session = container.companion.create_session(space_id=space.id)
        summary_started = asyncio.Event()
        release_summary = asyncio.Event()
        calls: list[bool] = []

        async def generate(*, session_id: str, include_candidates: bool):
            assert session_id == session.id
            calls.append(include_candidates)
            if not include_candidates:
                summary_started.set()
                await release_summary.wait()
                return _generated_artifacts("Stale turn summary")
            return _generated_artifacts("Final session summary")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        container.companion.schedule_learning_artifacts(
            session_id=session.id,
            include_candidates=False,
        )
        await summary_started.wait()
        container.companion.end_session(session.id)
        release_summary.set()
        await container.companion.wait_for_learning_artifacts(session.id)

        container.companion.schedule_learning_artifacts(
            session_id=session.id,
            include_candidates=True,
        )
        completed = await container.companion.wait_for_learning_artifacts(session.id)

        assert calls == [False, True]
        assert completed.generated_summary == "Final session summary"
        assert completed.artifacts_status is LearningArtifactsStatus.ready
        assert len(container.repository.list_session_memory_items(session.id)) == 1
        assert len(container.repository.list_session_review_items(session.id)) == 1

    asyncio.run(scenario())


def test_recovery_limits_learning_artifact_generation_concurrency(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Recovery concurrency")
        session_ids: list[str] = []
        now = datetime.now(timezone.utc)
        for _ in range(3):
            session = container.companion.create_session(space_id=space.id)
            session = container.companion.end_session(session.id)
            container.repository.update_session_artifacts_status(
                session_id=session.id,
                status=LearningArtifactsStatus.pending,
                error=None,
                updated_at=now,
            )
            session_ids.append(session.id)

        active = 0
        peak = 0
        entered = asyncio.Event()
        release = asyncio.Event()

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal active, peak
            _ = session_id, include_candidates
            active += 1
            peak = max(peak, active)
            entered.set()
            try:
                await release.wait()
                return _generated_artifacts("Recovered serially")
            finally:
                active -= 1

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 3
        await asyncio.wait_for(entered.wait(), timeout=1)
        await asyncio.sleep(0.01)
        assert peak == 1

        release.set()
        for session_id in session_ids:
            recovered = await container.companion.wait_for_learning_artifacts(
                session_id,
            )
            assert recovered.artifacts_status is LearningArtifactsStatus.ready
        assert peak == 1

    asyncio.run(scenario())


def test_recovered_job_waits_for_vault_unlock_instead_of_failing(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Locked recovery")
        session = container.companion.create_session(space_id=space.id)
        session = container.companion.end_session(session.id)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.running,
            error=None,
            updated_at=datetime.now(timezone.utc),
        )
        vault_unlocked = False
        attempts = 0

        monkeypatch.setattr(
            container.providers.vault,
            "status",
            lambda: SimpleNamespace(unlocked=vault_unlocked),
        )

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal attempts
            _ = session_id, include_candidates
            attempts += 1
            if not vault_unlocked:
                raise VaultLockedError("Vault is locked")
            return _generated_artifacts("Vault 解锁后恢复完成。")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 1
        for _ in range(100):
            if attempts == 1:
                break
            await asyncio.sleep(0.01)
        assert attempts == 1
        waiting = container.companion.get_session(session.id)
        assert waiting.artifacts_status is LearningArtifactsStatus.pending
        assert waiting.artifacts_error is None

        vault_unlocked = True
        await container.companion.wait_for_learning_artifacts(
            session.id,
            timeout_seconds=2,
        )
        recovered = container.companion.get_session(session.id)
        assert attempts == 2
        assert recovered.artifacts_status is LearningArtifactsStatus.ready
        assert recovered.artifacts_error is None

    asyncio.run(scenario())


def test_vault_wait_releases_generation_slot_for_runnable_jobs(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Mixed Vault recovery")
        locked_session = container.companion.create_session(space_id=space.id)
        locked_session = container.companion.end_session(locked_session.id)
        runnable_session = container.companion.create_session(space_id=space.id)
        runnable_session = container.companion.end_session(runnable_session.id)
        base = datetime.now(timezone.utc)
        container.repository.update_session_artifacts_status(
            session_id=locked_session.id,
            status=LearningArtifactsStatus.running,
            error=None,
            updated_at=base,
        )
        container.repository.update_session_artifacts_status(
            session_id=runnable_session.id,
            status=LearningArtifactsStatus.pending,
            error=None,
            updated_at=base + timedelta(seconds=1),
        )
        vault_unlocked = False
        locked_attempted = asyncio.Event()
        locked_attempts = 0

        monkeypatch.setattr(
            container.providers.vault,
            "status",
            lambda: SimpleNamespace(unlocked=vault_unlocked),
        )

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal locked_attempts
            assert include_candidates is True
            if session_id == locked_session.id:
                locked_attempts += 1
                locked_attempted.set()
                if not vault_unlocked:
                    raise VaultLockedError("Vault is locked")
            return _generated_artifacts(f"recovered:{session_id}")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 2
        await asyncio.wait_for(locked_attempted.wait(), timeout=1)
        runnable = await container.companion.wait_for_learning_artifacts(
            runnable_session.id,
            timeout_seconds=1,
        )
        assert runnable.artifacts_status is LearningArtifactsStatus.ready
        assert (
            container.companion.get_session(locked_session.id).artifacts_status
            is LearningArtifactsStatus.pending
        )

        vault_unlocked = True
        locked = await container.companion.wait_for_learning_artifacts(
            locked_session.id,
            timeout_seconds=2,
        )
        assert locked_attempts == 2
        assert locked.artifacts_status is LearningArtifactsStatus.ready

    asyncio.run(scenario())


def test_uninitialized_vault_recovery_resumes_after_initialization(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        assert container.vault.status().initialized is False
        space = container.spaces.create_space(name="Uninitialized Vault recovery")
        session = container.companion.create_session(space_id=space.id)
        session = container.companion.end_session(session.id)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.running,
            error=None,
            updated_at=datetime.now(timezone.utc),
        )
        attempted = asyncio.Event()
        attempts = 0

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal attempts
            _ = session_id, include_candidates
            attempts += 1
            attempted.set()
            if not container.vault.status().unlocked:
                raise VaultLockedError("Vault is locked")
            return _generated_artifacts("Recovered after Vault initialization")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 1
        await asyncio.wait_for(attempted.wait(), timeout=1)
        waiting = container.companion.get_session(session.id)
        assert waiting.artifacts_status is LearningArtifactsStatus.pending
        assert waiting.artifacts_error is None
        assert not container.companion._artifact_tasks[session.id].done()

        container.vault.initialize("super-secret-pass")
        recovered = await container.companion.wait_for_learning_artifacts(
            session.id,
            timeout_seconds=2,
        )
        assert attempts == 2
        assert recovered.artifacts_status is LearningArtifactsStatus.ready
        assert recovered.artifacts_error is None

    asyncio.run(scenario())


def test_shutdown_cancels_recovery_while_waiting_for_vault(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Vault wait shutdown")
        session = container.companion.create_session(space_id=space.id)
        session = container.companion.end_session(session.id)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.pending,
            error=None,
            updated_at=datetime.now(timezone.utc),
        )
        attempted = asyncio.Event()
        attempts = 0

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal attempts
            _ = session_id, include_candidates
            attempts += 1
            attempted.set()
            raise VaultLockedError("Vault is locked")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 1
        await asyncio.wait_for(attempted.wait(), timeout=1)
        assert (
            container.companion.get_session(session.id).artifacts_status
            is LearningArtifactsStatus.pending
        )

        await asyncio.wait_for(container.companion.aclose(), timeout=1)
        persisted = container.companion.get_session(session.id)
        assert attempts == 1
        assert container.companion._artifact_tasks == {}
        assert persisted.artifacts_status is LearningArtifactsStatus.pending
        assert persisted.artifacts_error is None

    asyncio.run(scenario())


def test_recovery_replaces_stale_rows_without_losing_user_decisions(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Recovery row replacement")
        session = container.companion.create_session(space_id=space.id)
        session = container.companion.end_session(session.id)
        now = datetime.now(timezone.utc)
        stale_candidate = MemoryItem(
            id=str(uuid4()),
            space_id=space.id,
            content="Stale candidate",
            status=MemoryStatus.candidate,
            source_session_id=session.id,
            created_at=now,
            updated_at=now,
        )
        confirmed = stale_candidate.model_copy(
            update={
                "id": str(uuid4()),
                "content": "Confirmed memory",
                "status": MemoryStatus.confirmed,
            }
        )
        stale_review = ReviewItem(
            id=str(uuid4()),
            space_id=space.id,
            prompt="Stale review",
            answer="Stale answer",
            due_at=now,
            status=ReviewStatus.pending,
            source_session_id=session.id,
            created_at=now,
            updated_at=now,
        )
        completed = stale_review.model_copy(
            update={
                "id": str(uuid4()),
                "prompt": "Completed review",
                "status": ReviewStatus.completed,
            }
        )
        for memory in (stale_candidate, confirmed):
            container.repository.upsert_memory_item(memory)
        for review in (stale_review, completed):
            container.repository.upsert_review_item(review)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.running,
            error=None,
            updated_at=now,
        )

        async def generate(*, session_id: str, include_candidates: bool):
            _ = session_id
            assert include_candidates is True
            return _generated_artifacts("Fresh recovered summary")

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 1
        recovered = await container.companion.wait_for_learning_artifacts(
            session.id,
        )
        memories = container.repository.list_session_memory_items(session.id)
        reviews = container.repository.list_session_review_items(session.id)

        assert recovered.artifacts_status is LearningArtifactsStatus.ready
        assert {item.content for item in memories if item.status is MemoryStatus.candidate} == {
            "重启后恢复的记忆候选。"
        }
        assert {item.id for item in memories if item.status is MemoryStatus.confirmed} == {
            confirmed.id
        }
        assert {item.prompt for item in reviews if item.status is ReviewStatus.pending} == {
            "重启后复盘了什么？"
        }
        assert {item.id for item in reviews if item.status is ReviewStatus.completed} == {
            completed.id
        }
        assert stale_candidate.id not in {item.id for item in memories}
        assert stale_review.id not in {item.id for item in reviews}
        assert container.repository.list_recoverable_artifact_sessions() == []

    asyncio.run(scenario())


def test_recovery_start_is_idempotent_and_shutdown_leaves_work_recoverable(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def scenario() -> None:
        container = get_container()
        space = container.spaces.create_space(name="Recovery shutdown")
        session = container.companion.create_session(space_id=space.id)
        session = container.companion.end_session(session.id)
        container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.pending,
            error=None,
            updated_at=datetime.now(timezone.utc),
        )
        entered = asyncio.Event()
        cancelled = asyncio.Event()
        calls = 0

        async def generate(*, session_id: str, include_candidates: bool):
            nonlocal calls
            _ = session_id, include_candidates
            calls += 1
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        monkeypatch.setattr(
            container.companion,
            "_generate_learning_artifacts",
            generate,
        )

        assert container.companion.start_learning_artifact_recovery() == 1
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert container.companion.start_learning_artifact_recovery() == 0
        assert calls == 1

        await container.companion.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=1)
        persisted = container.companion.get_session(session.id)
        assert persisted.artifacts_status in {
            LearningArtifactsStatus.pending,
            LearningArtifactsStatus.running,
        }
        assert persisted.artifacts_error is None

    asyncio.run(scenario())


def test_recovery_provider_failure_is_persisted_and_visible_in_session_api(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    container = get_container()
    space = container.spaces.create_space(name="Recovery failure")
    session = container.companion.create_session(space_id=space.id)
    session = container.companion.end_session(session.id)
    container.repository.update_session_artifacts_status(
        session_id=session.id,
        status=LearningArtifactsStatus.running,
        error=None,
        updated_at=datetime.now(timezone.utc),
    )

    async def generate(*, session_id: str, include_candidates: bool):
        _ = session_id, include_candidates
        raise ProviderAuthenticationError(
            provider="test-analysis",
            public_detail="Reconnect the provider.",
        )

    monkeypatch.setattr(
        container.companion,
        "_generate_learning_artifacts",
        generate,
    )

    async def scenario() -> None:
        assert container.companion.start_learning_artifact_recovery() == 1
        failed = await container.companion.wait_for_learning_artifacts(
            session.id,
        )
        assert failed.artifacts_status is LearningArtifactsStatus.error
        assert failed.artifacts_error == "Reconnect the provider."
        assert container.companion._artifact_tasks == {}

    asyncio.run(scenario())

    response = client.get(
        f"/api/v1/sessions/{session.id}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert response.status_code == 200
    assert response.json()["session"]["artifacts_status"] == "error"
    assert response.json()["session"]["artifacts_error"] == "Reconnect the provider."
    assert response.json()["memory_candidates"] == []
    assert response.json()["review_items"] == []


def test_real_lifespan_recovers_cancelled_job_in_fresh_container(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings

    async def leave_recoverable_job() -> tuple[object, str]:
        old_container = get_container()
        space = old_container.spaces.create_space(name="Real lifespan recovery")
        session = old_container.companion.create_session(space_id=space.id)
        session = old_container.companion.end_session(session.id)
        old_container.repository.update_session_artifacts_status(
            session_id=session.id,
            status=LearningArtifactsStatus.pending,
            error=None,
            updated_at=datetime.now(timezone.utc),
        )
        entered = asyncio.Event()

        async def block(*, session_id: str, include_candidates: bool):
            _ = session_id, include_candidates
            entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(
            old_container.companion,
            "_generate_learning_artifacts",
            block,
        )
        assert old_container.companion.start_learning_artifact_recovery() == 1
        await asyncio.wait_for(entered.wait(), timeout=1)
        await old_container.aclose()
        return old_container, session.id

    old_container, session_id = asyncio.run(leave_recoverable_job())
    persisted = old_container.repository.get_session(session_id)
    assert persisted is not None
    assert persisted.artifacts_status is LearningArtifactsStatus.running
    get_container.cache_clear()
    calls: list[tuple[str, bool]] = []

    async def generate(
        self: CompanionService,
        *,
        session_id: str,
        include_candidates: bool,
    ) -> GeneratedLearningArtifacts:
        _ = self
        calls.append((session_id, include_candidates))
        return _generated_artifacts("Recovered by real lifespan")

    monkeypatch.setattr(
        CompanionService,
        "_generate_learning_artifacts",
        generate,
    )

    with TestClient(app):
        fresh_container = get_container()
        assert fresh_container is not old_container
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            recovered = fresh_container.repository.get_session(session_id)
            if (
                recovered is not None
                and recovered.artifacts_status is LearningArtifactsStatus.ready
            ):
                break
            time.sleep(0.01)
        else:
            raise AssertionError("Lifespan did not recover the persisted job")

        assert calls == [(session_id, True)]
        assert recovered is not None
        assert recovered.generated_summary == "Recovered by real lifespan"
        assert len(fresh_container.repository.list_session_memory_items(session_id)) == 1
        assert len(fresh_container.repository.list_session_review_items(session_id)) == 1

    assert fresh_container.companion._artifact_tasks == {}
