from abc import ABC, abstractmethod

from app.models.voice import VoiceSynthesisRequest, VoiceSynthesisResponse


class TTSProvider(ABC):
    name: str

    @abstractmethod
    async def synthesize(self, request: VoiceSynthesisRequest) -> VoiceSynthesisResponse:
        raise NotImplementedError
