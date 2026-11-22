from __future__ import annotations

import asyncio
from functools import lru_cache
import json
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.routes.voice import synthesize_tutor_speech
from app.llm.usage import UsageRow, list_usage
from app.repositories.mixins.common import utcnow
from app.services.settings_store import get_setting, put_setting
from app.services.tutor_catalog import Character

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


class SettingsView(BaseModel):
    default_character_id: str | None
    data_dir: str
    analysis_concurrency: int
    onboarding_completed_at: str | None = None


class SettingsUpdate(BaseModel):
    analysis_concurrency: int | None = Field(default=None, ge=1, le=16)
    onboarding_completed: bool | None = None


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
    onboarding_completed_at = get_setting(repository, "onboarding_completed_at", None)
    if onboarding_completed_at is None:
        with repository.connection() as conn:
            row = conn.execute("SELECT MIN(created_at) AS first_at FROM study_spaces").fetchone()
        if row and row["first_at"]:
            onboarding_completed_at = str(row["first_at"])
    return SettingsView(
        default_character_id=saved_default,
        data_dir=str(container.settings.storage_root),
        analysis_concurrency=get_setting(repository, "analysis_concurrency", 4),
        onboarding_completed_at=onboarding_completed_at,
    )


@router.get("/settings", response_model=SettingsView)
def get_settings(container: Container) -> SettingsView:
    return _settings_view(container)


@router.put("/settings", response_model=SettingsView)
async def update_settings(payload: SettingsUpdate, container: Container) -> SettingsView:
    async with container.settings_lock:
        if payload.analysis_concurrency is not None:
            limit = payload.analysis_concurrency
            await asyncio.to_thread(put_setting, container.repository, "analysis_concurrency", limit)
            container.gateway.set_concurrency(limit)
            await container.jobs.set_concurrency(limit)
        if payload.onboarding_completed:
            existing = await asyncio.to_thread(
                get_setting, container.repository, "onboarding_completed_at", None,
            )
            if not existing:
                await asyncio.to_thread(
                    put_setting, container.repository, "onboarding_completed_at", utcnow().isoformat(),
                )
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
    copy = await asyncio.to_thread(_voice_copy, container.settings.repo_root)
    spoken = await synthesize_tutor_speech(
        container,
        character_id=payload.character_id,
        text=payload.text,
        voice_id=payload.voice_id,
    )
    if spoken.kind == "unavailable":
        return PreviewResult(
            kind="browser",
            text=spoken.text,
            warning=spoken.warning or copy["preview_browser"],
        )
    content_type = "audio/mpeg" if spoken.format == "mp3" else "audio/pcm"
    return PreviewResult(
        kind="audio",
        text=spoken.text,
        audio_b64=spoken.audio_b64,
        content_type=content_type,
        warning=spoken.warning,
    )
