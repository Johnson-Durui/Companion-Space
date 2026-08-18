from pathlib import Path

from app.models.voice import VoiceTranscriptionResponse
from app.providers.stt_base import STTProvider


class FasterWhisperSTTProvider(STTProvider):
    name = "faster_whisper"

    def __init__(self, model_size: str = "small") -> None:
        self.model_size = model_size

    def transcribe(self, *, audio_bytes: bytes, filename: str) -> VoiceTranscriptionResponse:
        from faster_whisper import WhisperModel
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".wav", delete=True) as temp_file:
            temp_file.write(audio_bytes)
            temp_file.flush()
            model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
            segments, info = model.transcribe(temp_file.name, language="zh")
            text = "".join(segment.text for segment in segments).strip()
        return VoiceTranscriptionResponse(provider=self.name, text=text, language=info.language or "zh")
