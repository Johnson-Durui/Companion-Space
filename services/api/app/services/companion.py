from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from app.core.config import Settings
from app.models.domain import (
    CharacterPack,
    LearningArtifactsStatus,
    SessionRecord,
    SessionState,
    StudySpace,
)
from app.services.characters import CharacterService
from app.services.prompt_loader import PromptLoader
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService

if TYPE_CHECKING:
    from app.services.metrics import MetricsService
from app.services.companion_contract import (
    DEFAULT_CHARACTER_PACK_ID as DEFAULT_CHARACTER_PACK_ID,
    SessionNotFoundError as SessionNotFoundError,
    CharacterNotFoundError as CharacterNotFoundError,
    ALLOWED_SESSION_STATE_TRANSITIONS as ALLOWED_SESSION_STATE_TRANSITIONS,
    CompanionStreamEvent as CompanionStreamEvent,
    GeneratedMemoryArtifact as GeneratedMemoryArtifact,
    GeneratedReviewArtifact as GeneratedReviewArtifact,
    GeneratedLearningArtifacts as GeneratedLearningArtifacts,
)
from app.services.companion_turns import CompanionTurns
from app.services.companion_turn_context import CompanionTurnContext
from app.services.companion_learning_jobs import CompanionLearningJobs
from app.services.companion_learning_artifacts import CompanionLearningArtifacts


class CompanionService(CompanionTurns, CompanionTurnContext, CompanionLearningJobs, CompanionLearningArtifacts):
    def __init__(
        self,
        settings: Settings,
        repository: SQLiteRepository,
        spaces: StudySpaceService,
        providers: ProviderRegistryService,
        *,
        metrics: MetricsService | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.spaces = spaces
        self.providers = providers
        self.metrics = metrics
        self.characters = CharacterService(repository)
        self.prompt_loader = PromptLoader(settings)
        self._artifact_tasks: dict[str, asyncio.Task[None]] = {}
        self._artifact_generation_slots = asyncio.Semaphore(1)
        self._artifact_recovery_started = False

    def create_session(self, *, space_id: str, character_pack_id: str | None = None) -> SessionRecord:
        self.spaces.require_space(space_id)
        if character_pack_id is None:
            self._ensure_default_character()
        now = datetime.now(timezone.utc)
        session = SessionRecord(
            id=str(uuid4()),
            space_id=space_id,
            character_pack_id=None,
            state=SessionState.idle,
            artifacts_status=LearningArtifactsStatus.idle,
            created_at=now,
            updated_at=now,
        )
        return self.repository.create_session(
            session,
            requested_character_pack_id=character_pack_id,
            fallback_character_pack_id=DEFAULT_CHARACTER_PACK_ID,
            validate_character=lambda character: self.characters.ensure_relationship_allowed(
                character.recipe
            ),
        )

    async def aclose(self) -> None:
        tasks = [task for task in self._artifact_tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._artifact_tasks.clear()

    def close(self) -> None:
        for task in self._artifact_tasks.values():
            if not task.done():
                task.cancel()

    def list_sessions(self, space_id: str) -> list[SessionRecord]:
        return self.repository.list_sessions(space_id)

    def get_session(self, session_id: str) -> SessionRecord:
        session = self.repository.get_session(session_id)
        if session is None:
            raise SessionNotFoundError("Session not found")
        return session

    def get_session_character(self, session_id: str) -> CharacterPack:
        session = self.get_session(session_id)
        space = self.spaces.require_space(session.space_id)
        return self._resolve_character(
            session_character_pack_id=session.character_pack_id,
            space=space,
        )

    def set_state(
        self,
        session_id: str,
        state: SessionState,
        *,
        reason_code: str,
    ) -> SessionRecord:
        session = self.get_session(session_id)
        if session.state is state:
            return session
        if session.ended_at is not None or session.state is SessionState.closed:
            self.record_illegal_state_transition(
                session_id,
                state,
                reason_code=reason_code,
            )
            raise ValueError("Illegal session state transition")
        allowed_states = ALLOWED_SESSION_STATE_TRANSITIONS.get(
            session.state,
            frozenset(),
        )
        if state not in allowed_states:
            self.record_illegal_state_transition(
                session_id,
                state,
                reason_code=reason_code,
            )
            raise ValueError("Illegal session state transition")
        updated = session.model_copy(update={"state": state, "updated_at": datetime.now(timezone.utc)})
        self.repository.upsert_session(updated)
        return updated

    def record_illegal_state_transition(
        self,
        session_id: str,
        state: SessionState,
        *,
        reason_code: str,
    ) -> None:
        session = self.get_session(session_id)
        if self.metrics is None:
            return
        self.metrics.record_event_safe(
            "illegal_state_transition",
            {
                "session_id": session_id,
                "state_from": session.state.value,
                "state_to": state.value,
                "code": reason_code,
            },
        )

    def end_session(self, session_id: str, summary: str = "") -> SessionRecord:
        session = self.get_session(session_id)
        if session.ended_at is not None or session.state is SessionState.closed:
            return session
        manual_summary = summary.strip()
        next_summary = manual_summary or session.summary
        updated = session.model_copy(
            update={
                "state": SessionState.closed,
                "summary": next_summary,
                "updated_at": datetime.now(timezone.utc),
                "ended_at": datetime.now(timezone.utc),
            }
        )
        self.repository.upsert_session(updated)
        return updated

    def _resolve_character(
        self,
        *,
        session_character_pack_id: str | None,
        space: StudySpace,
    ) -> CharacterPack:
        character_id = session_character_pack_id or space.default_character_pack_id
        if character_id is None:
            character = self._ensure_default_character()
            self.characters.ensure_relationship_allowed(character.recipe)
            return character
        character = self.repository.get_character(character_id)
        if character is None:
            raise CharacterNotFoundError(f"Character not found: {character_id}")
        self.characters.ensure_relationship_allowed(character.recipe)
        return character

    def _ensure_default_character(self) -> CharacterPack:
        character = self.repository.get_character(DEFAULT_CHARACTER_PACK_ID)
        if character is not None:
            return character
        return self.characters._seed_default_character()
