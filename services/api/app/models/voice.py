from pydantic import BaseModel, Field


class VoiceTranscriptionResponse(BaseModel):
    provider: str
    text: str
    language: str = "zh"


class VoiceSynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice_mode: str = "companion"


class VoiceSynthesisResponse(BaseModel):
    provider: str
    voice_mode: str
    audio_base64: str | None = None
    content_type: str | None = None
    preview_text: str


class InterruptResponse(BaseModel):
    interrupted: bool = True
