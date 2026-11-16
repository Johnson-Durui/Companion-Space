from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from app.models.domain import (
    LearningArtifactsStatus,
    MemoryItem,
    MemoryStatus,
    ReviewItem,
    ReviewStatus,
    SessionRecord,
)
from app.providers.errors import (
    ProviderError,
)
from app.services.vault import VaultLockedError

if TYPE_CHECKING:
    pass


class CompanionLearningJobs:
    def schedule_learning_artifacts(
        self,
        *,
        session_id: str,
        include_candidates: bool,
    ) -> None:
        session = self.repository.get_session(session_id)
        if session is None:
            return
        if (
            session.ended_at is not None
            and include_candidates
            and session.artifacts_status is LearningArtifactsStatus.ready
            and session.artifacts_updated_at is not None
            and session.artifacts_updated_at >= session.ended_at
        ):
            return
        if session.ended_at is not None and not include_candidates:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._set_artifacts_status(
            session_id,
            LearningArtifactsStatus.pending,
            error=None,
        )
        existing = self._artifact_tasks.get(session_id)
        if existing is not None and not existing.done():
            existing.cancel()
        task = loop.create_task(
            self._run_learning_artifact_job(
                session_id=session_id,
                include_candidates=include_candidates,
            )
        )
        self._artifact_tasks[session_id] = task

    def start_learning_artifact_recovery(self) -> int:
        if self._artifact_recovery_started:
            return 0
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return 0

        sessions = self.repository.list_recoverable_artifact_sessions()
        # ponytail: one API process today; add DB leases before multi-worker support.
        self._artifact_recovery_started = True
        for session in sessions:
            self.schedule_learning_artifacts(
                session_id=session.id,
                include_candidates=session.ended_at is not None,
            )
        return len(sessions)

    async def wait_for_learning_artifacts(
        self,
        session_id: str,
        *,
        timeout_seconds: float = 2.0,
    ) -> SessionRecord:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            task = self._artifact_tasks.get(session_id)
            if task is None or task.done():
                return self.get_session(session_id)
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for learning artifacts")
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=remaining)
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                raise

    def update_session_recap(
        self,
        *,
        session_id: str,
        summary: str,
        notes: str,
    ) -> SessionRecord:
        return self.repository.update_session_recap_fields(
            session_id=session_id,
            summary=summary.strip(),
            notes=notes.strip(),
            updated_at=datetime.now(timezone.utc),
        )

    def undo_session_recap(self, session_id: str) -> SessionRecord:
        return self.repository.undo_session_recap_fields(
            session_id=session_id,
            updated_at=datetime.now(timezone.utc),
        )

    async def _run_learning_artifact_job(
        self,
        *,
        session_id: str,
        include_candidates: bool,
    ) -> None:
        try:
            session = self.get_session(session_id)
            while True:
                try:
                    async with self._artifact_generation_slots:
                        self._set_artifacts_status(
                            session_id,
                            LearningArtifactsStatus.running,
                            error=None,
                        )
                        artifacts = await self._generate_learning_artifacts(
                            session_id=session_id,
                            include_candidates=include_candidates,
                        )
                        if (
                            not include_candidates
                            and self.get_session(session_id).ended_at is not None
                        ):
                            return
                        now = datetime.now(timezone.utc)
                        self.repository.complete_session_generated_artifacts(
                            session_id=session.id,
                            generated_summary=artifacts.summary,
                            memory_items=[
                                MemoryItem(
                                    id=str(uuid4()),
                                    space_id=session.space_id,
                                    content=item.content,
                                    status=MemoryStatus.candidate,
                                    sensitive=item.sensitive,
                                    source_session_id=session.id,
                                    created_at=now,
                                    updated_at=now,
                                )
                                for item in artifacts.memory_candidates
                            ],
                            review_items=[
                                ReviewItem(
                                    id=str(uuid4()),
                                    space_id=session.space_id,
                                    prompt=item.prompt,
                                    answer=item.answer,
                                    due_at=now,
                                    status=ReviewStatus.pending,
                                    source_session_id=session.id,
                                    created_at=now,
                                    updated_at=now,
                                )
                                for item in artifacts.review_items
                            ],
                            replace_generated_items=include_candidates,
                            updated_at=now,
                        )
                    break
                except VaultLockedError:
                    self._set_artifacts_status(
                        session_id,
                        LearningArtifactsStatus.pending,
                        error=None,
                    )
                    while True:
                        await asyncio.sleep(0.25)
                        if self.providers.vault.status().unlocked:
                            break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            message = (
                exc.public_detail
                if isinstance(exc, ProviderError)
                else "Learning recap generation failed."
            )
            self._set_artifacts_status(
                session_id,
                LearningArtifactsStatus.error,
                error=message,
            )
        finally:
            task = self._artifact_tasks.get(session_id)
            if task is asyncio.current_task():
                self._artifact_tasks.pop(session_id, None)

    def _set_artifacts_status(
        self,
        session_id: str,
        status: LearningArtifactsStatus,
        *,
        error: str | None,
    ) -> None:
        self.repository.update_session_artifacts_status(
            session_id=session_id,
            status=status,
            error=error,
            updated_at=datetime.now(timezone.utc),
        )
