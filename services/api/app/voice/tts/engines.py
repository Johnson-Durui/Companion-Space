from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import TYPE_CHECKING

import httpx

from app.providers.base import ProviderAdapter, iter_pcm16_audio_chunks
from app.providers.errors import ProviderError, ProviderProtocolError
from app.providers.url_policy import is_local_endpoint, validate
from app.services.settings_store import get_setting
from app.voice.tts.edge import EdgeUnavailableError, synthesize as edge_synthesize
from app.voice.tts.pipeline import EngineAudioChunk, SpeechEngine, SpeechSynthesisError, TTSService, VoiceSpec

if TYPE_CHECKING:
    from app.api.deps import ServiceContainer

_PROVIDER_ENGINES = {
    "openai-compatible": "openai_compat",
    "elevenlabs": "elevenlabs",
    "local-neural": "local_neural",
}


def edge_engine() -> SpeechEngine:
    async def synthesize(text: str, voice: VoiceSpec) -> AsyncIterator[bytes]:
        try:
            async with aclosing(edge_synthesize(text, voice.voice_id, voice.rate, voice.pitch)) as chunks:
                async for chunk in chunks:
                    yield chunk
        except EdgeUnavailableError as error:
            raise SpeechSynthesisError("edge", str(error)) from error

    return SpeechEngine(name="edge", format="mp3", synthesize=synthesize)


def provider_engine(name: str, adapter: ProviderAdapter) -> SpeechEngine:
    async def synthesize(text: str, voice: VoiceSpec) -> AsyncIterator[bytes]:
        try:
            stream = adapter.synthesize_speech_stream(
                model=voice.model,
                text=text,
                voice_id=voice.voice_id,
                speed=voice.rate,
            )
            async with aclosing(stream) as chunks:
                async for chunk in chunks:
                    yield chunk
        except ProviderError as error:
            raise SpeechSynthesisError(name, error.public_detail) from error

    return SpeechEngine(name=name, format="pcm_s16le", synthesize=synthesize, sample_rate_hz=24000)


def gpt_sovits_engine(
    base_url: str,
    *,
    timeout: float = 45,
    transport: httpx.AsyncBaseTransport | None = None,
) -> SpeechEngine:
    root = validate(base_url, provider="gpt-sovits")
    if not is_local_endpoint(root):
        raise ValueError("GPT-SoVITS must use a local endpoint")

    async def synthesize(text: str, voice: VoiceSpec) -> AsyncIterator[bytes | EngineAudioChunk]:
        options = voice.options
        payload = {
            "text": text,
            "text_lang": options.get("text_lang", "zh"),
            "ref_audio_path": options.get("ref_audio_path", voice.voice_id),
            "prompt_text": options.get("prompt_text", ""),
            "prompt_lang": options.get("prompt_lang", "zh"),
            "text_split_method": options.get("text_split_method", "cut5"),
            "batch_size": 1,
            "speed_factor": voice.rate,
            "media_type": "wav",
            "streaming_mode": True,
        }
        async with httpx.AsyncClient(
            base_url=f"{root}/", timeout=timeout, transport=transport, follow_redirects=False,
        ) as client:
            try:
                async with client.stream("POST", "tts", json=payload) as response:
                    if not 200 <= response.status_code < 300:
                        raise SpeechSynthesisError(
                            "gpt_sovits", f"GPT-SoVITS request failed ({response.status_code}).",
                        )
                    content_type = response.headers.get("content-type", "").split(";", 1)[0]
                    if content_type not in {"audio/wav", "audio/x-wav", "application/octet-stream"}:
                        raise SpeechSynthesisError("gpt_sovits", "GPT-SoVITS returned invalid audio.")
                    try:
                        async for chunk in _wav_pcm_stream(response.aiter_bytes()):
                            yield chunk
                    except ProviderProtocolError as error:
                        raise SpeechSynthesisError("gpt_sovits", error.public_detail) from error
            except httpx.TimeoutException as error:
                raise SpeechSynthesisError("gpt_sovits", "GPT-SoVITS timed out.") from error
            except httpx.RequestError as error:
                raise SpeechSynthesisError("gpt_sovits", "GPT-SoVITS is unavailable.") from error

    return SpeechEngine(name="gpt_sovits", format="pcm_s16le", synthesize=synthesize)


async def _wav_pcm_stream(chunks: AsyncIterator[bytes]) -> AsyncIterator[EngineAudioChunk]:
    header = bytearray()
    iterator = chunks.__aiter__()
    async for chunk in iterator:
        header.extend(chunk)
        parsed = _parse_wav_header(header)
        if parsed is None:
            continue
        sample_rate, data_offset = parsed
        payload = bytes(header[data_offset:])

        async def pcm_chunks() -> AsyncIterator[bytes]:
            if payload:
                yield payload
            async for remaining in iterator:
                yield remaining

        async for pcm in iter_pcm16_audio_chunks(pcm_chunks(), provider="gpt-sovits"):
            yield EngineAudioChunk(pcm, sample_rate)
        return
    raise ProviderProtocolError(provider="gpt-sovits", public_detail="GPT-SoVITS returned no WAV header.")


def _parse_wav_header(data: bytearray) -> tuple[int, int] | None:
    if len(data) < 12:
        return None
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ProviderProtocolError(provider="gpt-sovits", public_detail="GPT-SoVITS returned invalid WAV audio.")
    offset = 12
    audio_format = channels = sample_rate = bits = None
    while len(data) >= offset + 8:
        kind = bytes(data[offset:offset + 4])
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        payload = offset + 8
        if kind == b"data":
            if (audio_format, channels, bits) != (1, 1, 16) or sample_rate is None:
                raise ProviderProtocolError(
                    provider="gpt-sovits", public_detail="GPT-SoVITS returned unsupported WAV audio.",
                )
            return sample_rate, payload
        end = payload + size
        if len(data) < end:
            return None
        if kind == b"fmt ":
            if size < 16:
                raise ProviderProtocolError(
                    provider="gpt-sovits", public_detail="GPT-SoVITS returned invalid WAV audio.",
                )
            audio_format = int.from_bytes(data[payload:payload + 2], "little")
            channels = int.from_bytes(data[payload + 2:payload + 4], "little")
            sample_rate = int.from_bytes(data[payload + 4:payload + 8], "little")
            bits = int.from_bytes(data[payload + 14:payload + 16], "little")
        offset = end + size % 2
    return None


async def resolve_tts(container: ServiceContainer, character_id: str | None) -> tuple[TTSService, VoiceSpec]:
    if character_id is None:
        character_id = await asyncio.to_thread(
            get_setting, container.repository, "default_character_id", None,
        )
    if character_id is None:
        catalog = await asyncio.to_thread(container.tutors.list_characters)
        character_id = catalog[0].id if catalog else None
    if character_id is None:
        raise ValueError("No character is available")
    character = await asyncio.to_thread(container.tutors.get_character, character_id)
    if character is None:
        raise ValueError("Character was not found")
    settings = await asyncio.to_thread(get_setting, container.repository, "voice_settings", {})
    configured_default = settings.get("default", {}) if isinstance(settings, dict) else {}
    character_settings = settings.get("characters", {}) if isinstance(settings, dict) else {}
    override = character_settings.get(character_id, {}) if isinstance(character_settings, dict) else {}

    voice_data = character.voice.model_dump()
    if isinstance(override, dict) and override:
        voice_data.update(override)
    elif isinstance(configured_default, dict) and configured_default:
        voice_data.update(configured_default)
    voice = _voice_spec(voice_data)
    if voice is None:
        raise ValueError("Character voice is incomplete")
    engines = {"edge": edge_engine()}
    defaults = {
        "edge": VoiceSpec(
            engine="edge", voice_id="zh-CN-XiaoxiaoNeural", rate=voice.rate, pitch=voice.pitch,
        ),
    }
    provider_default = None
    try:
        resolved = await asyncio.to_thread(container.providers.resolve_role, "tts")
    except ProviderError:
        resolved = None
    if resolved is not None:
        provider_default = _PROVIDER_ENGINES.get(resolved.connection.provider)
        if provider_default is not None:
            engines[provider_default] = provider_engine(provider_default, resolved.adapter)
            params = resolved.assignment.params
            defaults[provider_default] = VoiceSpec(
                engine=provider_default,
                voice_id=str(params.get("voice_id", "alloy")),
                model=resolved.assignment.model,
                rate=float(params.get("rate", 1)),
            )

    default_voice = _voice_spec(configured_default) if isinstance(configured_default, dict) else None
    if default_voice is not None:
        default_engine = default_voice.engine
        defaults[default_engine] = default_voice
    else:
        default_engine = provider_default or "edge"
    for candidate in (voice, default_voice):
        if candidate is not None and candidate.engine == "gpt_sovits":
            base_url = candidate.options.get("base_url")
            if isinstance(base_url, str) and base_url:
                engines["gpt_sovits"] = gpt_sovits_engine(base_url)
    return TTSService(
        engines, default_engine=default_engine, engine_defaults=defaults,
    ), voice


def _voice_spec(data: dict[str, object]) -> VoiceSpec | None:
    engine = data.get("engine")
    voice_id = data.get("voice_id")
    valid_voice = isinstance(voice_id, str) and bool(voice_id)
    if not isinstance(engine, str) or not engine or not (valid_voice or engine == "browser"):
        return None
    options = data.get("options", {})
    return VoiceSpec(
        engine=engine,
        voice_id=voice_id if isinstance(voice_id, str) else "",
        model=str(data.get("model", "")),
        rate=float(data.get("rate", 1)),
        pitch=int(data.get("pitch", 0)),
        options=options if isinstance(options, dict) else {},
    )
