from __future__ import annotations

import asyncio
import base64
import json
from contextlib import aclosing
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.api.deps import ServiceContainer, get_container, require_owner
from app.providers.url_policy import is_local_endpoint
from app.services.settings_store import get_setting, put_setting
from app.voice.sherpa import ENGINE, MODEL_DOWNLOAD_BYTES, MODEL_LICENSE_URL
from app.voice.stt import MAX_PCM_BYTES, STT_SETTING_KEY, SttEngine, VoiceTranscriber, get_stt_engine
from app.voice.tts.engines import resolve_tts

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
    default: VoiceSetting | None = None
    characters: dict[str, VoiceSetting] = Field(default_factory=dict, max_length=100)


class VoiceStatus(BaseModel):
    stt_configured: bool
    tts_configured: bool
    input_modes: list[Literal["push_to_talk", "hands_free"]]
    sample_rate_hz: Literal[16000] = 16000


class SttSettings(BaseModel):
    engine: SttEngine
    local_runtime_available: bool
    local_model_available: bool
    license_url: str = MODEL_LICENSE_URL
    download_bytes: int = MODEL_DOWNLOAD_BYTES


class SttSettingUpdate(BaseModel):
    engine: SttEngine
    download_model: bool = False


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


class VoiceSpeakRequest(BaseModel):
    character_id: str | None = Field(default=None, min_length=1, max_length=120)
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)] | None = None
    voice_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{2,60}$")


class VoiceSpeakResult(BaseModel):
    kind: Literal["audio", "unavailable"]
    text: str
    engine: str
    format: Literal["pcm_s16le", "mp3"] | None = None
    sample_rate_hz: int | None = None
    audio_b64: str | None = None
    warning: str | None = None
    reason_code: str | None = None


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


@router.get("/stt", response_model=SttSettings)
def get_stt_settings(container: Container) -> SttSettings:
    return SttSettings(
        engine=get_stt_engine(container.repository),
        local_runtime_available=container.local_stt.runtime_available(),
        local_model_available=container.local_stt.model_available(),
    )


@router.put("/stt", response_model=SttSettings)
async def update_stt_settings(payload: SttSettingUpdate, container: Container) -> SttSettings:
    if payload.engine == ENGINE and not container.local_stt.model_available():
        if not payload.download_model:
            raise HTTPException(409, detail={"code": "model_download_required", "message": "Review the license and download the model first."})
        await asyncio.to_thread(container.local_stt.install)
    if payload.engine == ENGINE and not container.local_stt.runtime_available():
        raise HTTPException(409, detail={"code": "local_stt_required", "message": "Install the optional local STT runtime."})
    async with container.settings_lock:
        await asyncio.to_thread(put_setting, container.repository, STT_SETTING_KEY, payload.engine)
    return await asyncio.to_thread(get_stt_settings, container)


@router.get("/status", response_model=VoiceStatus)
def get_voice_status(container: Container) -> VoiceStatus:
    stt = get_stt_settings(container)
    ready = (
        stt.local_model_available and stt.local_runtime_available
        if stt.engine == ENGINE else "stt" in container.providers.get_roles()
    )
    return VoiceStatus(
        stt_configured=ready,
        tts_configured=True,
        input_modes=["push_to_talk", "hands_free"],
    )


async def synthesize_tutor_speech(
    container: ServiceContainer,
    *,
    character_id: str | None = None,
    text: str | None = None,
    voice_id: str | None = None,
) -> VoiceSpeakResult:
    if character_id:
        character = await asyncio.to_thread(container.tutors.get_character, character_id)
    else:
        default_id = await asyncio.to_thread(get_setting, container.repository, "default_character_id", None)
        character = await asyncio.to_thread(container.tutors.resolve_active_character, default_id)
    if character is None:
        raise HTTPException(
            404,
            detail={"code": "character_not_found", "message": "Teacher is unavailable."},
        )
    spoken_text = text or _voice_copy(container.settings.repo_root)["preview_sample"].format(name=character.name)
    configured = await asyncio.to_thread(load_voice_settings, container)
    override = configured.characters.get(character.id)
    if voice_id is None and override is not None and override.engine == "browser":
        return VoiceSpeakResult(
            kind="unavailable", text=spoken_text, engine="browser", reason_code="browser_engine",
        )
    service, voice = await resolve_tts(container, character.id)
    if voice_id:
        voice = voice.__class__(
            engine="edge" if voice.engine == "browser" else voice.engine,
            voice_id=voice_id,
            model=voice.model,
            rate=voice.rate,
            pitch=voice.pitch,
            options=voice.options,
        )
    if voice.engine == "browser":
        return VoiceSpeakResult(
            kind="unavailable", text=spoken_text, engine="browser", reason_code="browser_engine",
        )

    audio = bytearray()
    engine = voice.engine
    audio_format: Literal["pcm_s16le", "mp3"] | None = None
    sample_rate = None
    warning = None
    try:
        async with aclosing(service.stream(spoken_text, voice)) as chunks:
            async for chunk in chunks:
                engine = chunk.engine
                if chunk.kind == "fallback":
                    warning = chunk.reason
                    if chunk.engine == "browser":
                        return VoiceSpeakResult(
                            kind="unavailable",
                            text=spoken_text,
                            engine="browser",
                            warning=warning,
                            reason_code="tts_unavailable",
                        )
                    continue
                audio_format = chunk.format
                sample_rate = chunk.sample_rate_hz
                if chunk.data:
                    audio.extend(chunk.data)
                if len(audio) > 10 * 1024 * 1024:
                    return VoiceSpeakResult(
                        kind="unavailable",
                        text=spoken_text,
                        engine=engine,
                        reason_code="tts_too_large",
                    )
    except Exception:
        return VoiceSpeakResult(
            kind="unavailable",
            text=spoken_text,
            engine=engine,
            reason_code="tts_unavailable",
        )
    if not audio or audio_format is None:
        return VoiceSpeakResult(
            kind="unavailable",
            text=spoken_text,
            engine=engine,
            warning=warning,
            reason_code="tts_empty",
        )
    return VoiceSpeakResult(
        kind="audio",
        text=spoken_text,
        engine=engine,
        format=audio_format,
        sample_rate_hz=sample_rate,
        audio_b64=base64.b64encode(audio).decode("ascii"),
        warning=warning,
        reason_code=None,
    )


@router.post("/speak", response_model=VoiceSpeakResult)
async def speak_text(payload: VoiceSpeakRequest, container: Container) -> VoiceSpeakResult:
    return await synthesize_tutor_speech(
        container,
        character_id=payload.character_id,
        text=payload.text,
        voice_id=payload.voice_id,
    )


@router.post("/preview", response_model=VoicePreviewResult)
async def preview_voice(payload: VoicePreviewRequest, container: Container) -> VoicePreviewResult:
    result = await synthesize_tutor_speech(
        container,
        character_id=payload.character_id,
        text=payload.text,
    )
    if result.kind == "unavailable":
        return VoicePreviewResult(
            kind="browser",
            text=result.text,
            engine="browser",
            warning=result.warning,
        )
    return VoicePreviewResult(
        kind="audio",
        text=result.text,
        engine=result.engine,
        format=result.format,
        sample_rate_hz=result.sample_rate_hz,
        audio_b64=result.audio_b64,
        warning=result.warning,
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
    result = await VoiceTranscriber(
        container.gateway, local=container.local_stt, repository=container.repository,
    ).transcribe_pcm16(pcm16)
    return MicrophoneTestResult(
        accepted=result.accepted,
        text=result.text,
        discard_reason=result.discard_reason,
    )
