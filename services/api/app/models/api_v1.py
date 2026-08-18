from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.models.domain import (
    CharacterPack,
    CharacterRecipe,
    Citation,
    CompanionTurn,
    IngestionJob,
    LessonScript,
    MaterialKind,
    MemoryItem,
    ModelAssignment,
    ProviderCapability,
    ReviewItem,
    ReviewStatus,
    SessionRecord,
    StudySpace,
)


class VaultPasswordPayload(BaseModel):
    password: str = Field(min_length=8, max_length=200)


class VaultStatusResponse(BaseModel):
    initialized: bool
    unlocked: bool


class NeuralTtsSidecarStatusResponse(BaseModel):
    enabled: bool
    ready: bool
    connection_id: str
    model: str | None = None
    new_spaces_use_neural: bool
    how_to_switch: str


class VaultUnlockResponse(BaseModel):
    initialized: bool
    unlocked: bool
    owner_token: str | None = None


class OwnerPreferencesResponse(BaseModel):
    adult_relationships_enabled: bool
    adult_age_confirmed_at: datetime | None


class OwnerPreferencesUpdateRequest(BaseModel):
    adult_relationships_enabled: bool
    confirm_age_18_or_older: bool = False


class LocalMetricSignalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: str = Field(min_length=1, max_length=80)
    session_id: str = Field(min_length=1, max_length=128)
    value: float | None = None
    residue_found: bool | None = None
    code: Literal[
        "realtime_url_missing",
        "owner_token_missing",
        "realtime_url_invalid",
        "realtime_disconnected",
        "microphone_denied",
        "realtime_connect_failed",
        "realtime_server_error",
    ] | None = None


class RealtimeTicketResponse(BaseModel):
    ticket: str
    expires_at: datetime


class ProviderConnectionCreateRequest(BaseModel):
    provider: str
    label: str = Field(min_length=1, max_length=120)
    api_key: str = Field(default="", max_length=400)
    base_url: str | None = None


class ProviderConnectionUpdateRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    api_key: str | None = Field(default=None, min_length=1, max_length=400)
    base_url: str | None = None


class StudySpaceCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    topic: str = ""
    goal: str = ""


class StudySpaceUpdateRequest(StudySpaceCreateRequest):
    model_config = ConfigDict(extra="forbid")


class StudySpaceDefaultCharacterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    character_pack_id: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=128),
    ] | None


class MaterialNoteRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1)


class CharacterCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    recipe: CharacterRecipe = Field(default_factory=CharacterRecipe)


class CharacterUpdateRequest(CharacterCreateRequest):
    model_config = ConfigDict(extra="forbid")


class CharacterDuplicateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class CharacterVoicePreviewRequest(BaseModel):
    space_id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=240)
    voice_id: str | None = Field(default=None, min_length=1, max_length=120)
    speaking_rate: float | None = Field(default=None, ge=0.5, le=2.0)


class LegacyKnowledgeImportRequest(BaseModel):
    document_id: str


class SessionCreateRequest(BaseModel):
    space_id: str
    character_pack_id: str | None = None


class SessionTurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class SessionDemoRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=240)


class SessionSummaryRequest(BaseModel):
    summary: str = ""


class SessionRecapUpdateRequest(BaseModel):
    summary: str = ""
    notes: str = ""


class MemoryUpdateRequest(BaseModel):
    content: str
    status: str
    sensitive: bool = False


class ReviewUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str | None = None
    answer: str | None = None
    due_at: datetime | None = None
    status: ReviewStatus | None = None


class ModelAssignmentRequest(BaseModel):
    capability: ProviderCapability
    provider_connection_id: str
    model_name: str = Field(min_length=1, max_length=120)


class SessionTranscriptResponse(BaseModel):
    session: SessionRecord
    turns: list[CompanionTurn]
    memory_candidates: list[MemoryItem] = Field(default_factory=list)
    review_items: list[ReviewItem] = Field(default_factory=list)


class SessionDemoResponse(BaseModel):
    session_id: str
    topic: str
    script: LessonScript
    citations: list[Citation] = Field(default_factory=list)
    used_space_materials: bool


class MaterialResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    space_id: str
    title: str
    kind: MaterialKind
    filename: str
    chunk_count: int
    created_at: datetime
    updated_at: datetime


class MaterialIngestionResponse(BaseModel):
    material: MaterialResponse
    job: IngestionJob


class SpaceDetailResponse(BaseModel):
    space: StudySpace
    materials: list[MaterialResponse]
    jobs: list[IngestionJob]
    assignments: list[ModelAssignment]


class CharacterListResponse(BaseModel):
    items: list[CharacterPack]


class MemoryListResponse(BaseModel):
    items: list[MemoryItem]


class ReviewListResponse(BaseModel):
    items: list[ReviewItem]
