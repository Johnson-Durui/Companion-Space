from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated

from app.models.domain import (
    CompanionTurn,
    SessionState,
)
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

if TYPE_CHECKING:
    pass


DEFAULT_CHARACTER_PACK_ID = "default-cool-companion"


class SessionNotFoundError(ValueError):
    """Raised when a session identifier has no matching durable record."""


class CharacterNotFoundError(ValueError):
    """Raised when a session references a character pack that no longer exists."""


MEMORY_CONTEXT_LIMIT = 5


MEMORY_CONTEXT_CONTENT_LIMIT = 240


REVIEW_CONTEXT_LIMIT = 5


REVIEW_CONTEXT_PROMPT_LIMIT = 240


REVIEW_CONTEXT_ANSWER_LIMIT = 400


TURN_ACTIVATION_STATES = (
    SessionState.idle,
    SessionState.listening,
    SessionState.interrupted,
    SessionState.error,
)


ALLOWED_SESSION_STATE_TRANSITIONS: dict[SessionState, frozenset[SessionState]] = {
    SessionState.idle: frozenset(
        {
            SessionState.listening,
            SessionState.thinking,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.listening: frozenset(
        {
            SessionState.idle,
            SessionState.thinking,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.thinking: frozenset(
        {
            SessionState.idle,
            SessionState.speaking,
            SessionState.interrupted,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.speaking: frozenset(
        {
            SessionState.idle,
            SessionState.interrupted,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.interrupted: frozenset(
        {
            SessionState.idle,
            SessionState.listening,
            SessionState.thinking,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.error: frozenset(
        {
            SessionState.idle,
            SessionState.listening,
            SessionState.thinking,
            SessionState.error,
            SessionState.closed,
        }
    ),
    SessionState.closed: frozenset({SessionState.closed}),
}


@dataclass(frozen=True)
class CompanionStreamEvent:
    type: str
    state: SessionState
    text: str = ""
    turn: CompanionTurn | None = None
    payload: dict | None = None


ArtifactSummary = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1200)]


ArtifactMemoryText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]


ArtifactReviewPrompt = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]


ArtifactReviewAnswer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=400)]


class GeneratedMemoryArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: ArtifactMemoryText
    sensitive: bool = False


class GeneratedReviewArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: ArtifactReviewPrompt
    answer: ArtifactReviewAnswer


class GeneratedLearningArtifacts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: ArtifactSummary
    memory_candidates: list[GeneratedMemoryArtifact] = Field(default_factory=list, max_length=3)
    review_items: list[GeneratedReviewArtifact] = Field(default_factory=list, max_length=3)
