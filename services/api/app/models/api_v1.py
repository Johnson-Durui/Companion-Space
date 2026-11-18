from __future__ import annotations


from pydantic import BaseModel, ConfigDict, Field

from app.models.domain import (
    CharacterPack,
    CharacterRecipe,
)


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


class CharacterListResponse(BaseModel):
    items: list[CharacterPack]
