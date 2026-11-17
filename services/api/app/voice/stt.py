from __future__ import annotations

import asyncio
import math
import re
from array import array
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal

from app.llm.gateway import LLMGateway
from app.providers.errors import ProviderProtocolError

SAMPLE_RATE_HZ = 16_000
MAX_PCM_BYTES = SAMPLE_RATE_HZ * 2 * 60
MIN_AUDIO_MS = 250
_MIN_RMS = 120
_VOICE_CHARS = re.compile(r"[\w\u3400-\u9fff]+", re.UNICODE)
_FILLERS = {"嗯", "啊", "呃", "额", "唔", "hm", "uh", "um"}
DiscardReason = Literal["too_short", "silence", "empty", "echo"]


@dataclass(frozen=True)
class TranscriptionResult:
    text: str = ""
    discard_reason: DiscardReason | None = None

    @property
    def accepted(self) -> bool:
        return self.discard_reason is None


def _samples(pcm16: bytes) -> array[int]:
    if not pcm16 or len(pcm16) % 2:
        raise ValueError("Audio must contain little-endian 16-bit PCM samples.")
    samples = array("h")
    samples.frombytes(pcm16)
    if samples.itemsize != 2:
        raise RuntimeError("This Python build does not expose 16-bit signed samples.")
    return samples


def _rms(pcm16: bytes) -> float:
    samples = _samples(pcm16)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def _normalized_speech(text: str) -> str:
    return "".join(_VOICE_CHARS.findall(text.casefold()))


def is_echo(transcript: str, reference: str | None) -> bool:
    heard = _normalized_speech(transcript)
    spoken = _normalized_speech(reference or "")
    if not heard or not spoken:
        return False
    if heard == spoken:
        return True
    if min(len(heard), len(spoken)) < 4:
        return False
    if heard in spoken or spoken in heard:
        return True
    return SequenceMatcher(a=heard, b=spoken, autojunk=False).ratio() >= 0.86


class VoiceTranscriber:
    """Validate a completed in-memory utterance and send it to the configured STT role."""

    def __init__(self, gateway: LLMGateway) -> None:
        self.gateway = gateway

    async def transcribe_pcm16(
        self,
        pcm16: bytes,
        *,
        sample_rate_hz: int = SAMPLE_RATE_HZ,
        echo_reference: str | None = None,
    ) -> TranscriptionResult:
        if sample_rate_hz != SAMPLE_RATE_HZ:
            raise ValueError("Speech input must use 16 kHz PCM.")
        if len(pcm16) > MAX_PCM_BYTES:
            raise ValueError("Speech input is limited to 60 seconds.")
        if len(pcm16) * 1000 < sample_rate_hz * 2 * MIN_AUDIO_MS:
            return TranscriptionResult(discard_reason="too_short")
        if _rms(pcm16) < _MIN_RMS:
            return TranscriptionResult(discard_reason="silence")

        resolved = await asyncio.to_thread(self.gateway.registry.resolve_role, "stt")
        text = (
            await resolved.adapter.transcribe_pcm16(
                model=resolved.assignment.model,
                pcm16=pcm16,
                sample_rate_hz=sample_rate_hz,
            )
        ).strip()
        if not text:
            return TranscriptionResult(discard_reason="empty")
        if len(text) > 2_000:
            raise ProviderProtocolError(
                provider=resolved.connection.provider,
                public_detail="The speech-to-text provider returned too much text.",
            )
        if is_echo(text, echo_reference):
            return TranscriptionResult(discard_reason="echo")
        normalized = _normalized_speech(text)
        if normalized in _FILLERS:
            return TranscriptionResult(discard_reason="too_short")
        if not normalized:
            raise ProviderProtocolError(
                provider=resolved.connection.provider,
                public_detail="The speech-to-text provider returned no usable words.",
            )
        return TranscriptionResult(text=text)
