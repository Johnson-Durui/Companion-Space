from abc import ABC, abstractmethod

from app.models.voice import VoiceTranscriptionResponse


class STTProvider(ABC):
    name: str

    @abstractmethod
    def transcribe(self, *, audio_bytes: bytes, filename: str) -> VoiceTranscriptionResponse:
        raise NotImplementedError
