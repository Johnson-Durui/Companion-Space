from __future__ import annotations

import hashlib
import importlib.util
import shutil
import tarfile
import tempfile
from pathlib import Path
from threading import Lock

import httpx
import numpy as np

from app.providers.errors import ProviderConfigurationError, ProviderUnavailableError

ENGINE = "local_sherpa"
MODEL_ID = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{MODEL_ID}.tar.bz2"
MODEL_LICENSE_URL = "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE"
MODEL_DOWNLOAD_BYTES = 163_002_883
_ARCHIVE_SHA256 = "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"
_FILES = {"model.int8.onnx": 250 * 1024 * 1024, "tokens.txt": 512 * 1024}


def _download_model(archive: Path) -> None:
    digest = hashlib.sha256()
    remaining = MODEL_DOWNLOAD_BYTES
    with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=45) as response:
        response.raise_for_status()
        with archive.open("wb") as output:
            for data in response.iter_bytes(256 * 1024):
                remaining -= len(data)
                if remaining < 0:
                    raise ValueError("Unexpected model download size.")
                digest.update(data)
                output.write(data)
    if remaining or digest.hexdigest() != _ARCHIVE_SHA256:
        raise ValueError("Downloaded model did not match the upstream checksum.")


def _extract_model(archive: Path, staged: Path) -> None:
    expected = {f"{MODEL_ID}/{name}": (name, limit) for name, limit in _FILES.items()}
    with tarfile.open(archive, mode="r|bz2") as contents:
        for member in contents:
            entry = expected.pop(member.name, None)
            if entry is None:
                continue
            name, limit = entry
            if not member.isfile() or not 0 < member.size <= limit:
                raise ValueError("Unexpected model archive entry.")
            source = contents.extractfile(member)
            if source is None:
                raise ValueError("Model archive entry is unreadable.")
            with source, (staged / name).open("wb") as output:
                shutil.copyfileobj(source, output)
    if expected:
        raise ValueError("The archive did not contain all required model files.")


class LocalSpeechRecognizer:
    def __init__(self, cache_dir: Path) -> None:
        self.model_dir = cache_dir / MODEL_ID
        self._lock = Lock()
        self._recognizer = None

    def runtime_available(self) -> bool:
        return importlib.util.find_spec("sherpa_onnx") is not None

    def model_available(self) -> bool:
        return (self.model_dir / ".ready").is_file() and all((self.model_dir / name).is_file() for name in _FILES)

    def _load(self, directory: Path):
        if not self.runtime_available():
            raise ProviderConfigurationError(provider=ENGINE, public_detail="Install the optional local STT runtime.")
        try:
            import sherpa_onnx

            return sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(directory / "model.int8.onnx"),
                tokens=str(directory / "tokens.txt"),
                language="auto",
                use_itn=True,
                num_threads=2,
                debug=False,
            )
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            raise ProviderUnavailableError(provider=ENGINE, public_detail="Could not load the local STT runtime or model.") from exc

    def install(self) -> None:
        with self._lock:
            if not self.runtime_available():
                raise ProviderConfigurationError(provider=ENGINE, public_detail="Install the optional local STT runtime.")
            if self.model_available():
                return
            try:
                self.model_dir.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=self.model_dir.parent) as temp:
                    staged = Path(temp)
                    archive = staged / "model.tar.bz2"
                    _download_model(archive)
                    _extract_model(archive, staged)
                    self._load(staged)
                    self.model_dir.mkdir(exist_ok=True)
                    for name in _FILES:
                        (staged / name).replace(self.model_dir / name)
                    (self.model_dir / ".ready").touch()
            except (httpx.HTTPError, OSError, ValueError, tarfile.TarError) as exc:
                raise ProviderUnavailableError(
                    provider=ENGINE, public_detail="Could not download or verify the offline speech model. Retry from voice settings.",
                ) from exc

    def recognize(self, pcm16: bytes, sample_rate_hz: int) -> str:
        with self._lock:
            if self._recognizer is None:
                if not self.model_available():
                    raise ProviderConfigurationError(provider=ENGINE, public_detail="Download the model from voice settings first.")
                self._recognizer = self._load(self.model_dir)
            try:
                stream = self._recognizer.create_stream()
                stream.accept_waveform(sample_rate_hz, np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768)
                self._recognizer.decode_stream(stream)
                return stream.result.text
            except (RuntimeError, ValueError) as exc:
                raise ProviderUnavailableError(provider=ENGINE, public_detail="Offline speech recognition failed. Retry the utterance.") from exc
