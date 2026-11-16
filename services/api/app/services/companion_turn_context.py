from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from app.models.domain import (
    CharacterPack,
    Citation,
    CompanionTurn,
    MemoryStatus,
    RetrievalResult,
    ReviewStatus,
    SessionRecord,
    TurnRole,
    UsageRecord,
)
from app.providers.base import ProviderMessage, ProviderReply
from app.services.companion_parsing import parse_provider_payload, sanitize_board_actions

if TYPE_CHECKING:
    pass
from app.services.companion_contract import (
    MEMORY_CONTEXT_LIMIT,
    MEMORY_CONTEXT_CONTENT_LIMIT,
    REVIEW_CONTEXT_LIMIT,
    REVIEW_CONTEXT_PROMPT_LIMIT,
    REVIEW_CONTEXT_ANSWER_LIMIT,
)


class CompanionTurnContext:
    def _build_assistant_turn(
        self,
        *,
        session: SessionRecord,
        result: ProviderReply,
        retrieval,
        user_text: str,
    ) -> CompanionTurn:
        parsed = self._parse_provider_payload(result.raw_text)
        citations = [
            Citation(
                chunk_id=hit.chunk.id,
                material_id=hit.chunk.material_id,
                title=hit.chunk.title,
                locator=hit.chunk.locator,
                excerpt=hit.chunk.content[:180],
            )
            for hit in retrieval.hits[:3]
        ]
        display_text = parsed["display_text"]
        if citations and "资料命中" not in display_text:
            display_text = f"{display_text}\n\n资料命中：{'; '.join(f'{item.title} {item.locator}' for item in citations[:2])}"
        if not retrieval.hits:
            display_text = f"{display_text}\n\n未使用空间资料。"
        return CompanionTurn(
            id=str(uuid4()),
            session_id=session.id,
            space_id=session.space_id,
            role=TurnRole.assistant,
            display_text=display_text,
            spoken_text=parsed["spoken_text"],
            emotion=parsed["emotion"],
            board_actions=parsed["board_actions"],
            citations=citations,
            suggested_actions=parsed["suggested_actions"],
            usage=UsageRecord(
                input_tokens=result.input_tokens
                or max(len(user_text) // 4, 1),
                output_tokens=result.output_tokens
                or max(len(parsed["spoken_text"]) // 4, 1),
            ),
            created_at=datetime.now(timezone.utc),
        )

    def _record_citation_metrics(
        self,
        *,
        session: SessionRecord,
        citations: list[Citation],
        retrieval: RetrievalResult,
    ) -> None:
        if self.metrics is None:
            return
        valid_hits = {
            (hit.chunk.id, hit.chunk.material_id, hit.chunk.locator)
            for hit in retrieval.hits
            if hit.chunk.space_id == session.space_id
        }
        for citation in citations:
            self.metrics.record_event_safe(
                "citation_verified",
                {
                    "session_id": session.id,
                    "matched": (
                        citation.chunk_id,
                        citation.material_id,
                        citation.locator,
                    )
                    in valid_hits,
                },
            )

    @staticmethod
    def _parse_provider_payload(raw_text: str) -> dict:
        return parse_provider_payload(raw_text)

    @staticmethod
    def _sanitize_board_actions(raw_board_actions: object):
        return sanitize_board_actions(raw_board_actions)

    def _build_history(self, session_id: str) -> list[ProviderMessage]:
        return [
            ProviderMessage(role=turn.role.value, content=turn.display_text)
            for turn in self.repository.list_turns(session_id)
        ]

    @staticmethod
    def _character_profile(character: CharacterPack) -> dict:
        recipe = character.recipe
        return {
            "id": character.id,
            "name": character.name,
            "description": character.description,
            "appearance": {
                "base_model": recipe.base_model,
                "face_style": recipe.face_style,
                "hairstyle": recipe.hairstyle,
                "outfit": recipe.outfit,
                "accessories": recipe.accessories,
            },
            "dialogue": {
                "personality": recipe.personality,
                "relationship_role": recipe.relationship_role,
                "warmth": recipe.warmth,
                "initiative": recipe.initiative,
                "humor": recipe.humor,
                "challenge": recipe.challenge,
            },
        }

    @staticmethod
    def _retrieval_context(retrieval) -> list[dict]:
        return [
            {
                "chunk_id": hit.chunk.id,
                "material_id": hit.chunk.material_id,
                "title": hit.chunk.title,
                "locator": hit.chunk.locator,
                "content": hit.chunk.content,
            }
            for hit in retrieval.hits
        ]

    def _memory_context(self, space_id: str) -> list[dict]:
        confirmed = [
            item
            for item in self.repository.list_memory_items(space_id)
            if item.status is MemoryStatus.confirmed
        ]
        return [
            {
                "content": self._truncate_text(
                    item.content,
                    MEMORY_CONTEXT_CONTENT_LIMIT,
                ),
                "sensitive": item.sensitive,
            }
            for item in confirmed[:MEMORY_CONTEXT_LIMIT]
        ]

    def _review_context(self, space_id: str) -> list[dict]:
        pending = [
            item
            for item in self.repository.list_review_items(space_id)
            if item.status is ReviewStatus.pending
        ]
        pending.sort(
            key=lambda item: (
                item.due_at is None,
                self._datetime_sort_value(item.due_at),
                -self._datetime_sort_value(item.updated_at),
            )
        )
        return [
            {
                "prompt": self._truncate_text(
                    item.prompt,
                    REVIEW_CONTEXT_PROMPT_LIMIT,
                ),
                "answer": self._truncate_text(
                    item.answer,
                    REVIEW_CONTEXT_ANSWER_LIMIT,
                ),
                "status": item.status.value,
                "due_at": (
                    item.due_at.isoformat()
                    if item.due_at is not None
                    else None
                ),
            }
            for item in pending[:REVIEW_CONTEXT_LIMIT]
        ]

    @staticmethod
    def _truncate_text(value: str, limit: int) -> str:
        normalized = value.strip()
        if len(normalized) <= limit:
            return normalized
        return normalized[:limit].rstrip()

    @staticmethod
    def _datetime_sort_value(value: datetime | None) -> float:
        if value is None:
            return float("inf")
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
