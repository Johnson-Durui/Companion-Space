from __future__ import annotations

import asyncio
import base64
from functools import lru_cache
import json
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from app.api.deps import ServiceContainer, get_container, require_owner
from app.llm.usage import UsageRow, list_usage
from app.services.settings_store import get_setting, put_setting
from app.services.tutor_catalog import Character
from app.voice.tts.edge import DEFAULT_VOICE, EdgeUnavailableError, EdgeVoiceUnavailableError

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class SettingsView(BaseModel):
    default_character_id: str | None
    data_dir: str
    analysis_concurrency: int


class SettingsUpdate(BaseModel):
    analysis_concurrency: int = Field(ge=1, le=16)


class DefaultCharacterRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)


class DefaultCharacterResponse(BaseModel):
    default_character_id: str


class PreviewRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)] | None = None
    voice_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{5,60}$")


class PreviewResult(BaseModel):
    kind: Literal["audio", "browser"]
    text: str
    audio_b64: str | None = None
    content_type: str | None = None
    warning: str | None = None


def _require_tutor(container: ServiceContainer, identifier: str) -> Character:
    character = container.tutors.get_character(identifier)
    if character is None:
        raise HTTPException(404, detail={"code": "character_not_found", "message": "Teacher is unavailable"})
    return character


def _settings_view(container: ServiceContainer) -> SettingsView:
    repository = container.repository
    saved_default = get_setting(repository, "default_character_id", None)
    if saved_default and container.tutors.get_character(saved_default) is None:
        fallback = container.tutors.resolve_active_character(None)
        saved_default = fallback.id if fallback else None
    return SettingsView(
        default_character_id=saved_default,
        data_dir=str(container.settings.storage_root),
        analysis_concurrency=get_setting(repository, "analysis_concurrency", 4),
    )


@router.get("/settings", response_model=SettingsView)
def get_settings(container: Container) -> SettingsView:
    return _settings_view(container)


@router.put("/settings", response_model=SettingsView)
async def update_settings(payload: SettingsUpdate, container: Container) -> SettingsView:
    limit = payload.analysis_concurrency
    async with container.settings_lock:
        await asyncio.to_thread(put_setting, container.repository, "analysis_concurrency", limit)
        container.gateway.set_concurrency(limit)
        await container.jobs.set_concurrency(limit)
    return await asyncio.to_thread(_settings_view, container)


@router.get("/characters", response_model=list[Character])
def get_characters(container: Container) -> list[Character]:
    return container.tutors.list_characters()


@router.put("/settings/default-character", response_model=DefaultCharacterResponse)
def choose_character(payload: DefaultCharacterRequest, container: Container) -> DefaultCharacterResponse:
    character = _require_tutor(container, payload.character_id)
    put_setting(container.repository, "default_character_id", character.id)
    return DefaultCharacterResponse(default_character_id=character.id)


@router.get("/usage", response_model=list[UsageRow])
def get_usage(container: Container) -> list[UsageRow]:
    return list_usage(container.repository)


@lru_cache
def _voice_copy(root: Path) -> dict[str, str]:
    locale = root / "services/api/app/i18n/zh-CN.json"
    return json.loads(locale.read_text(encoding="utf-8"))


@router.post("/tts/preview", response_model=PreviewResult)
async def preview(payload: PreviewRequest, container: Container) -> PreviewResult:
    character = await asyncio.to_thread(_require_tutor, container, payload.character_id)
    copy = await asyncio.to_thread(_voice_copy, container.settings.repo_root)
    text = payload.text or copy["preview_sample"].format(name=character.name)
    voice = payload.voice_id or character.voice.voice_id
    warning = None
    try:
        try:
            audio = await container.gateway.preview_voice(text, voice, character.voice.rate, character.voice.pitch)
        except EdgeVoiceUnavailableError:
            if voice == DEFAULT_VOICE:
                raise
            audio = await container.gateway.preview_voice(text, DEFAULT_VOICE, character.voice.rate, character.voice.pitch)
            warning = copy["preview_voice_changed"]
    except EdgeUnavailableError:
        return PreviewResult(kind="browser", text=text, warning=copy["preview_browser"])
    return PreviewResult(
        kind="audio",
        text=text,
        audio_b64=base64.b64encode(audio).decode("ascii"),
        content_type="audio/mpeg",
        warning=warning,
    )
