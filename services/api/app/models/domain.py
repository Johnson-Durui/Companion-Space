from __future__ import annotations

import json
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

RecipeToken = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
RecipeRelation = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
RecipeColor = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]
BoardContent = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
BoardTarget = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]
CompanionEmotion = Literal[
    "neutral",
    "warm",
    "cheerful",
    "curious",
    "focused",
    "playful",
    "concerned",
]
TtsPlaybackPolicy = Literal["browser-compat", "server-neural", "server"]
LessonTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
LessonCaption = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=400)]
LessonNarration = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1200)]


def _load_character_recipe_defaults(filename: str) -> dict[str, Any]:
    path = Path(__file__).resolve().parents[4] / "libs" / "schemas" / filename
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{filename} must contain a JSON object.")
    return payload


DEFAULT_CHARACTER_RECIPE_DATA = _load_character_recipe_defaults("default_character_recipe.json")
DEFAULT_NOVA_CHARACTER_RECIPE_DATA = _load_character_recipe_defaults("default_nova_character_recipe.json")


class ProviderCapability(str, Enum):
    chat_llm = "chat_llm"
    analysis_llm = "analysis_llm"
    embedding = "embedding"
    stt = "stt"
    tts = "tts"


class SessionState(str, Enum):
    idle = "idle"
    listening = "listening"
    thinking = "thinking"
    speaking = "speaking"
    interrupted = "interrupted"
    error = "error"
    closed = "closed"


class MaterialKind(str, Enum):
    pdf = "pdf"
    markdown = "markdown"
    text = "text"
    note = "note"


class MemoryStatus(str, Enum):
    candidate = "candidate"
    confirmed = "confirmed"
    discarded = "discarded"


class ReviewStatus(str, Enum):
    pending = "pending"
    completed = "completed"


class LearningArtifactsStatus(str, Enum):
    idle = "idle"
    pending = "pending"
    running = "running"
    ready = "ready"
    error = "error"


class TurnRole(str, Enum):
    user = "user"
    assistant = "assistant"


class BoardActionKind(str, Enum):
    mermaid = "mermaid"
    markdown = "markdown"
    highlight = "highlight"


class Citation(BaseModel):
    chunk_id: str
    material_id: str
    title: str
    locator: str
    excerpt: str | None = None


class UsageRecord(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    audio_input_bytes: int = 0
    audio_output_bytes: int = 0


class BoardAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: BoardActionKind
    content: BoardContent
    target: BoardTarget | None = None

    @model_validator(mode="after")
    def validate_target(self) -> "BoardAction":
        if self.kind is BoardActionKind.highlight and self.target is None:
            raise ValueError("Highlight board actions require a target.")
        return self


class StudySpace(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=120)
    topic: str = ""
    goal: str = ""
    default_character_pack_id: str | None = None
    created_at: datetime
    updated_at: datetime


class Material(BaseModel):
    id: str
    space_id: str
    title: str
    kind: MaterialKind
    filename: str
    storage_path: str
    chunk_count: int = 0
    created_at: datetime
    updated_at: datetime


class Chunk(BaseModel):
    id: str
    space_id: str
    material_id: str
    title: str
    locator: str
    content: str
    sparse_terms: list[str] = Field(default_factory=list)
    dense_vector: dict[str, float] | list[float] = Field(default_factory=dict)
    metadata: dict[str, str | int | bool | None] = Field(default_factory=dict)
    created_at: datetime


class IngestionJob(BaseModel):
    id: str
    space_id: str
    material_id: str
    status: str
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


class CharacterRecipe(BaseModel):
    avatar_model: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["avatar_model"]
    avatar_framing: Literal["full_body", "portrait"] = DEFAULT_CHARACTER_RECIPE_DATA["avatar_framing"]
    stage_background: Literal["neutral", "study", "midnight"] = DEFAULT_CHARACTER_RECIPE_DATA[
        "stage_background"
    ]
    base_model: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["base_model"]
    face_style: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["face_style"]
    hairstyle: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["hairstyle"]
    outfit: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["outfit"]
    accessories: list[RecipeToken] = Field(
        default_factory=lambda: list(DEFAULT_CHARACTER_RECIPE_DATA["accessories"]),
        max_length=12,
    )
    palette: dict[str, RecipeColor] = Field(
        default_factory=lambda: dict(DEFAULT_CHARACTER_RECIPE_DATA["palette"]),
        max_length=12,
    )
    personality: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["personality"]
    warmth: int = Field(default=DEFAULT_CHARACTER_RECIPE_DATA["warmth"], ge=0, le=100)
    initiative: int = Field(default=DEFAULT_CHARACTER_RECIPE_DATA["initiative"], ge=0, le=100)
    humor: int = Field(default=DEFAULT_CHARACTER_RECIPE_DATA["humor"], ge=0, le=100)
    challenge: int = Field(default=DEFAULT_CHARACTER_RECIPE_DATA["challenge"], ge=0, le=100)
    relationship_role: RecipeRelation = DEFAULT_CHARACTER_RECIPE_DATA["relationship_role"]
    voice_provider: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["voice_provider"]
    voice_model: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["voice_model"]
    voice_id: RecipeToken = DEFAULT_CHARACTER_RECIPE_DATA["voice_id"]
    speaking_rate: float = Field(default=DEFAULT_CHARACTER_RECIPE_DATA["speaking_rate"], ge=0.5, le=2.0)
    motions: dict[str, RecipeToken] = Field(
        default_factory=lambda: dict(DEFAULT_CHARACTER_RECIPE_DATA["motions"]),
        max_length=12,
    )


DEFAULT_CHARACTER_RECIPE_DATA = CharacterRecipe.model_validate(DEFAULT_CHARACTER_RECIPE_DATA).model_dump(mode="json")
DEFAULT_NOVA_CHARACTER_RECIPE_DATA = CharacterRecipe.model_validate(DEFAULT_NOVA_CHARACTER_RECIPE_DATA).model_dump(mode="json")


class CharacterPack(BaseModel):
    id: str
    name: str
    description: str = ""
    recipe: CharacterRecipe = Field(default_factory=CharacterRecipe)
    asset_manifest: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ProviderConnection(BaseModel):
    id: str
    provider: str
    label: str
    base_url: str | None = None
    capabilities: list[ProviderCapability] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ModelAssignment(BaseModel):
    id: str
    space_id: str
    capability: ProviderCapability
    provider_connection_id: str
    model_name: str
    is_bootstrap_default: bool = False
    created_at: datetime
    updated_at: datetime


class SessionRecord(BaseModel):
    id: str
    space_id: str
    character_pack_id: str | None = None
    state: SessionState = SessionState.idle
    summary: str = ""
    generated_summary: str = ""
    notes: str = ""
    artifacts_status: LearningArtifactsStatus = LearningArtifactsStatus.idle
    artifacts_error: str | None = None
    artifacts_updated_at: datetime | None = None
    tts_connection_id: str | None = None
    tts_model_name: str | None = None
    tts_playback_policy: TtsPlaybackPolicy | None = None
    created_at: datetime
    updated_at: datetime
    ended_at: datetime | None = None


class CompanionTurn(BaseModel):
    id: str
    session_id: str
    space_id: str
    role: TurnRole
    display_text: str
    spoken_text: str
    emotion: CompanionEmotion = "warm"
    board_actions: list[BoardAction] = Field(default_factory=list, max_length=1)
    citations: list[Citation] = Field(default_factory=list)
    suggested_actions: list[str] = Field(default_factory=list)
    usage: UsageRecord = Field(default_factory=UsageRecord)
    created_at: datetime


class LessonStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board: BoardAction
    caption: LessonCaption
    narration: LessonNarration


class LessonScript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: LessonTitle
    steps: list[LessonStep] = Field(min_length=3, max_length=8)


class MemoryItem(BaseModel):
    id: str
    space_id: str
    content: str
    status: MemoryStatus = MemoryStatus.candidate
    sensitive: bool = False
    source_session_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ReviewItem(BaseModel):
    id: str
    space_id: str
    prompt: str
    answer: str = ""
    due_at: datetime | None = None
    status: ReviewStatus = ReviewStatus.pending
    source_session_id: str | None = None
    created_at: datetime
    updated_at: datetime


class MemoryCandidate(BaseModel):
    content: str
    sensitive: bool = False


class RetrievalHit(BaseModel):
    chunk: Chunk
    dense_score: float
    sparse_score: float
    final_score: float


class RetrievalResult(BaseModel):
    normalized_query: str
    rewritten_query: str
    intent: str
    hits: list[RetrievalHit] = Field(default_factory=list)
    used_space_materials: bool = False


class RealtimeEvent(BaseModel):
    type: str
    session_id: str
    state: SessionState | None = None
    payload: dict = Field(default_factory=dict)


class PairingChallenge(BaseModel):
    id: str
    code_hash: str
    attempts_remaining: int
    expires_at: datetime
    created_at: datetime


class TrustedDevice(BaseModel):
    id: str
    name: str
    refresh_token_hash: str
    refresh_expires_at: datetime
    created_at: datetime
    last_seen_at: datetime
