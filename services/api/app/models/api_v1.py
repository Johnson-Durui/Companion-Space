from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.models.domain import (
    CharacterPack,
    CharacterRecipe,
    IngestionJob,
    MaterialKind,
    ModelAssignment,
    ProviderCapability,
    StudySpace,
)


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


class ModelAssignmentRequest(BaseModel):
    capability: ProviderCapability
    provider_connection_id: str
    model_name: str = Field(min_length=1, max_length=120)


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
