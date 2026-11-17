from __future__ import annotations

import asyncio
import base64
import json
from contextlib import aclosing
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from app.api.deps import ServiceContainer, get_container, require_owner
from app.providers.url_policy import is_local_endpoint
from app.services.settings_store import get_setting, put_setting
from app.voice.stt import MAX_PCM_BYTES, VoiceTranscriber
from app.voice.tts.engines import resolve_tts
from app.voice.tts.edge import DEFAULT_VOICE

router = APIRouter(prefix="/voice", dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]
VoiceEngine = Literal["edge", "openai_compat", "elevenlabs", "local_neural", "gpt_sovits", "browser"]
_VOICE_SETTINGS_KEY = "voice_settings"


class VoiceSetting(BaseModel):
    engine: VoiceEngine = "edge"
    voice_id: str = Field(default="", max_length=240)
    model: str = Field(default="", max_length=240)
    rate: float = Field(default=1, ge=0.5, le=2)
    pitch: int = Field(default=0, ge=-100, le=100)
    options: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=12)

    @model_validator(mode="after")
    def validate_engine_options(self) -> VoiceSetting:
        if self.engine != "browser" and not self.voice_id.strip():
            raise ValueError("Choose a voice for the selected engine.")
        if self.engine == "gpt_sovits":
            endpoint = self.options.get("base_url")
            if not isinstance(endpoint, str) or not is_local_endpoint(endpoint):
                raise ValueError("Set a local GPT-SoVITS endpoint.")
        if any(len(key) > 80 or isinstance(value, str) and len(value) > 1_000 for key, value in self.options.items()):
            raise ValueError("Voice options are too long.")
        return self


class VoiceSettings(BaseModel):
    default: VoiceSetting = Field(default_factory=lambda: VoiceSetting(voice_id=DEFAULT_VOICE))
    characters: dict[str, VoiceSetting] = Field(default_factory=dict, max_length=100)


class VoiceStatus(BaseModel):
    stt_configured: bool
    tts_configured: bool
    input_modes: list[Literal["push_to_talk", "hands_free"]]
    sample_rate_hz: Literal[16000] = 16000


class MicrophoneTestResult(BaseModel):
    accepted: bool
    text: str = ""
    discard_reason: Literal["too_short", "silence", "empty", "echo"] | None = None


class VoicePreviewRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    text: str | None = Field(default=None, min_length=1, max_length=240)


class VoicePreviewResult(BaseModel):
    kind: Literal["audio", "browser"]
    text: str
    engine: str
    format: Literal["pcm_s16le", "mp3"] | None = None
    sample_rate_hz: int | None = None
    audio_b64: str | None = None
    warning: str | None = None


def load_voice_settings(container: ServiceContainer) -> VoiceSettings:
    value = get_setting(container.repository, _VOICE_SETTINGS_KEY, None)
    return VoiceSettings.model_validate(value) if value is not None else VoiceSettings()


async def _bounded_pcm_body(request: Request) -> bytes:
    pcm16 = bytearray()
    async for chunk in request.stream():
        if len(pcm16) + len(chunk) > MAX_PCM_BYTES:
            raise HTTPException(
                413,
                detail={"code": "audio_too_large", "message": "Speech input is limited to 60 seconds."},
            )
        pcm16.extend(chunk)
    return bytes(pcm16)


@lru_cache
def _voice_copy(root: Path) -> dict[str, str]:
    path = root / "services/api/app/i18n/zh-CN.json"
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/settings", response_model=VoiceSettings)
def get_voice_settings(container: Container) -> VoiceSettings:
    return load_voice_settings(container)


@router.put("/settings", response_model=VoiceSettings)
async def update_voice_settings(payload: VoiceSettings, container: Container) -> VoiceSettings:
    known = {character.id for character in container.tutors.list_characters()}
    unknown = payload.characters.keys() - known
    if unknown:
        raise HTTPException(
            404,
            detail={"code": "character_not_found", "message": "A configured teacher is unavailable."},
        )
    async with container.settings_lock:
        await asyncio.to_thread(
            put_setting,
            container.repository,
            _VOICE_SETTINGS_KEY,
            payload.model_dump(mode="json"),
        )
    return payload


@router.get("/status", response_model=VoiceStatus)
async def get_voice_status(container: Container) -> VoiceStatus:
    roles = await asyncio.to_thread(container.providers.get_roles)
    return VoiceStatus(
        stt_configured="stt" in roles,
        tts_configured=True,
        input_modes=["push_to_talk", "hands_free"],
    )


@router.post("/preview", response_model=VoicePreviewResult)
async def preview_voice(payload: VoicePreviewRequest, container: Container) -> VoicePreviewResult:
    character = await asyncio.to_thread(container.tutors.get_character, payload.character_id)
    if character is None:
        raise HTTPException(
            404,
            detail={"code": "character_not_found", "message": "Teacher is unavailable."},
        )
    text = payload.text or _voice_copy(container.settings.repo_root)["preview_sample"].format(name=character.name)
    configured = await asyncio.to_thread(load_voice_settings, container)
    override = configured.characters.get(character.id)
    if override is not None and override.engine == "browser":
        return VoicePreviewResult(kind="browser", text=text, engine="browser")
    service, voice = await resolve_tts(container, character.id)
    if voice.engine == "browser":
        return VoicePreviewResult(kind="browser", text=text, engine="browser")

    audio = bytearray()
    engine = voice.engine
    audio_format = None
    sample_rate = None
    warning = None
    async with aclosing(service.stream(text, voice)) as chunks:
        async for chunk in chunks:
            engine = chunk.engine
            if chunk.kind == "fallback":
                warning = chunk.reason
                if chunk.engine == "browser":
                    return VoicePreviewResult(
                        kind="browser", text=text, engine="browser", warning=warning,
                    )
                continue
            audio_format = chunk.format
            sample_rate = chunk.sample_rate_hz
            if chunk.data:
                audio.extend(chunk.data)
            if len(audio) > 10 * 1024 * 1024:
                raise ValueError("Voice preview exceeds the configured size limit.")
    if not audio or audio_format is None:
        raise ValueError("The speech engine returned no preview audio.")
    return VoicePreviewResult(
        kind="audio",
        text=text,
        engine=engine,
        format=audio_format,
        sample_rate_hz=sample_rate,
        audio_b64=base64.b64encode(audio).decode("ascii"),
        warning=warning,
    )


@router.post("/microphone-test", response_model=MicrophoneTestResult)
async def microphone_test(
    request: Request,
    container: Container,
    content_length: Annotated[int | None, Header()] = None,
) -> MicrophoneTestResult:
    if content_length is not None and content_length > MAX_PCM_BYTES:
        raise HTTPException(
            413,
            detail={"code": "audio_too_large", "message": "Speech input is limited to 60 seconds."},
        )
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type not in {"audio/pcm", "application/octet-stream"}:
        raise HTTPException(
            415,
            detail={"code": "unsupported_audio", "message": "Send little-endian 16 kHz PCM audio."},
        )
    pcm16 = await _bounded_pcm_body(request)
    result = await VoiceTranscriber(container.gateway).transcribe_pcm16(pcm16)
    return MicrophoneTestResult(
        accepted=result.accepted,
        text=result.text,
        discard_reason=result.discard_reason,
    )
