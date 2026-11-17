from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from app.models.domain import (
    CompanionTurn,
    ProviderCapability,
    SessionState,
    TurnRole,
)
from app.providers.base import LLMProvider, ProviderReply
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderProtocolError,
)
from app.services.streaming_json import JSONTextFieldStream

if TYPE_CHECKING:
    pass
from app.services.companion_contract import (
    TURN_ACTIVATION_STATES,
    CompanionStreamEvent,
)


class CompanionTurns:
    async def submit_text_turn(self, *, session_id: str, text: str) -> CompanionTurn:
        final_turn: CompanionTurn | None = None
        async for event in self.stream_text_turn(session_id=session_id, text=text):
            if event.turn is not None:
                final_turn = event.turn
        if final_turn is None:
            raise ProviderProtocolError(
                provider="companion",
                public_detail="The provider stream ended without a final reply.",
            )
        return final_turn

    async def stream_text_turn(
        self,
        *,
        session_id: str,
        text: str,
        defer_speaking: bool = False,
    ) -> AsyncIterator[CompanionStreamEvent]:
        character = self.get_session_character(session_id)
        session = self.repository.try_activate_session_turn(
            session_id=session_id,
            allowed_states=TURN_ACTIVATION_STATES,
        )
        if session is None:
            existing_session = self.get_session(session_id)
            if (
                existing_session.ended_at is not None
                or existing_session.state is SessionState.closed
            ):
                raise ValueError("Session is closed")
            raise ValueError("Session already has an active turn")
        space = self.spaces.require_space(session.space_id)
        retrieval = await self.spaces.retrieve_async(
            space_id=session.space_id,
            query=text,
            pools=("materials",),
        )
        confirmed_memory = self._memory_context(session.space_id)
        review_items = self._review_context(session.space_id)
        history = self._build_history(session.id)

        user_turn = CompanionTurn(
            id=str(uuid4()),
            session_id=session_id,
            space_id=session.space_id,
            role=TurnRole.user,
            display_text=text,
            spoken_text=text,
            created_at=datetime.now(timezone.utc),
        )
        self.repository.add_turn(user_turn)

        completed = False
        cancelled = False
        try:
            system_prompt = self.prompt_loader.compose_system_prompt(
                character_profile=self._character_profile(character),
                study_space_profile={
                    "id": space.id,
                    "name": space.name,
                    "topic": space.topic,
                    "goal": space.goal,
                },
                retrieval_context=self._retrieval_context(retrieval),
                memory_context=confirmed_memory,
                review_context=review_items,
            )
            resolved = self.providers.resolve(
                space_id=space.id,
                capability=ProviderCapability.chat_llm,
            )
            vault_epoch = (
                None
                if resolved.connection.provider == "mock"
                else self.providers.vault.session_epoch
            )
            if not isinstance(resolved.adapter, LLMProvider):
                raise ProviderProtocolError(
                    provider=resolved.connection.provider,
                    public_detail=(
                        f"{resolved.connection.label} does not provide streaming chat."
                    ),
                )

            decoder = JSONTextFieldStream("display_text")
            raw_text_parts: list[str] = []
            emitted_display_text = False
            input_tokens = 0
            output_tokens = 0
            async for chunk in resolved.adapter.generate_reply_stream(
                model=resolved.assignment.model_name,
                system_prompt=system_prompt,
                history=history,
                user_message=text,
            ):
                self._assert_vault_session(
                    vault_epoch,
                    provider=resolved.connection.provider,
                )
                raw_text_parts.append(chunk.text)
                if chunk.input_tokens is not None:
                    input_tokens = chunk.input_tokens
                if chunk.output_tokens is not None:
                    output_tokens = chunk.output_tokens
                display_delta = decoder.feed(chunk.text)
                if not display_delta:
                    continue
                if not emitted_display_text:
                    self._assert_session_open_after_generation(session_id)
                    if not defer_speaking:
                        self.set_state(session_id, SessionState.speaking)
                    emitted_display_text = True
                yield CompanionStreamEvent(
                    type="llm.delta",
                    state=(
                        SessionState.thinking
                        if defer_speaking
                        else SessionState.speaking
                    ),
                    text=display_delta,
                )

            self._assert_vault_session(
                vault_epoch,
                provider=resolved.connection.provider,
            )
            result = ProviderReply(
                provider=resolved.connection.provider,
                model=resolved.assignment.model_name,
                raw_text="".join(raw_text_parts),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            self._assert_session_open_after_generation(session_id)
            assistant_turn = self._build_assistant_turn(
                session=session,
                result=result,
                retrieval=retrieval,
                user_text=text,
            )
            if not emitted_display_text:
                if not defer_speaking:
                    self.set_state(session_id, SessionState.speaking)
                yield CompanionStreamEvent(
                    type="llm.delta",
                    state=(
                        SessionState.thinking
                        if defer_speaking
                        else SessionState.speaking
                    ),
                    text=assistant_turn.display_text,
                )
            self.repository.add_turn(assistant_turn)
            self.schedule_learning_artifacts(
                session_id=session.id,
                include_candidates=False,
            )
            if assistant_turn.board_actions:
                yield CompanionStreamEvent(
                    type="board.update",
                    state=(
                        SessionState.thinking
                        if defer_speaking
                        else SessionState.speaking
                    ),
                    payload={
                        "turn_id": assistant_turn.id,
                        "board_actions": [
                            item.model_dump(mode="json")
                            for item in assistant_turn.board_actions
                        ],
                        "citations": [
                            item.model_dump(mode="json")
                            for item in assistant_turn.citations
                        ],
                    },
                )
            final_state = (
                SessionState.thinking if defer_speaking else SessionState.idle
            )
            self.set_state(session_id, final_state)
            completed = True
            yield CompanionStreamEvent(
                type="llm.final",
                state=final_state,
                turn=assistant_turn,
            )
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if not completed and not cancelled:
                self._mark_session_error(session_id)

    def _mark_session_error(self, session_id: str) -> None:
        session = self.repository.get_session(session_id)
        if (
            session is None
            or session.ended_at is not None
            or session.state is SessionState.closed
        ):
            return
        self.set_state(session_id, SessionState.error)

    def _assert_session_open_after_generation(self, session_id: str) -> None:
        session = self.get_session(session_id)
        if (
            session.ended_at is not None
            or session.state is SessionState.closed
        ):
            raise ValueError("Session was closed while generating a reply")

    def _assert_vault_session(
        self,
        expected_epoch: int | None,
        *,
        provider: str,
    ) -> None:
        if expected_epoch is None:
            return
        vault = self.providers.vault
        if (
            vault.session_epoch != expected_epoch
            or not vault.status().unlocked
        ):
            raise ProviderAuthenticationError(
                provider=provider,
                public_detail="Vault was locked during generation.",
            )
