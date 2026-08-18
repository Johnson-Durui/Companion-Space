from __future__ import annotations

import asyncio
import logging
import multiprocessing
import os
import queue
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Any, Callable, Literal
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

MODEL_ID = "qwen3-tts-0.6b-customvoice"
SOURCE_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_REVISION = "85e237c12c027371202489a0ec509ded67b5e4b5"
SAMPLE_RATE = 24_000
SPEAKERS = ("Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric")
VOICE_ALIASES = {
    "default": "Vivian",
    "nova": "Vivian",
    "mika-soft-cn": "Vivian",
    "mio-stage-cn": "Serena",
    "rei-midnight": "Dylan",
    "aki-genki-cn": "Eric",
}

Emotion = Literal[
    "neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned"
]


@dataclass(frozen=True)
class EmotionProfile:
    speed_multiplier: float
    instruct: str


EMOTION_PROFILES: dict[Emotion, EmotionProfile] = {
    "neutral": EmotionProfile(1.00, "自然平稳，语气克制。"),
    "warm": EmotionProfile(1.00, "温柔亲切，节奏舒缓。"),
    "cheerful": EmotionProfile(1.06, "明快愉悦，带轻微笑意。"),
    "curious": EmotionProfile(1.03, "好奇轻快，句尾略微上扬。"),
    "focused": EmotionProfile(0.98, "清晰专注，节奏稳定。"),
    "playful": EmotionProfile(1.10, "俏皮活泼，带轻微笑意，避免夸张。"),
    "concerned": EmotionProfile(0.90, "关切温和，语速稍慢，避免沉重。"),
}

logger = logging.getLogger(__name__)
_WORKER_RESPONSE_TIMEOUT_SECONDS = 180.0
_WORKER_STARTUP_TIMEOUT_SECONDS = 1_800.0


class InferenceCancelledError(RuntimeError):
    """The active worker generation was retired before producing a response."""


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    input: str = Field(min_length=1, max_length=320)
    voice: str
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    emotion: Emotion = "warm"
    response_format: str = "pcm"

    @field_validator("input")
    @classmethod
    def reject_blank_input(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("input must contain non-whitespace characters")
        return value

    @field_validator("model")
    @classmethod
    def require_model(cls, value: str) -> str:
        if value != MODEL_ID:
            raise ValueError(f"model must be {MODEL_ID}")
        return value

    @field_validator("voice")
    @classmethod
    def require_known_voice(cls, value: str) -> str:
        if value not in SPEAKERS and value not in VOICE_ALIASES:
            raise ValueError("voice must be an official preset speaker or supported legacy alias")
        return value

    @field_validator("response_format")
    @classmethod
    def require_pcm(cls, value: str) -> str:
        if value != "pcm":
            raise ValueError("response_format must be pcm")
        return value


def load_qwen_model() -> Any:
    import torch
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel

    requested = os.getenv("TTS_DEVICE", "auto").lower()
    use_cuda = requested != "cpu" and torch.cuda.is_available()
    if requested == "cuda" and not use_cuda:
        raise RuntimeError("TTS_DEVICE=cuda but CUDA is unavailable")

    snapshot_path = snapshot_download(
        repo_id=SOURCE_MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=os.getenv("TTS_MODEL_CACHE", "/models"),
    )
    return Qwen3TTSModel.from_pretrained(
        snapshot_path,
        local_files_only=True,
        device_map="cuda:0" if use_cuda else "cpu",
        dtype=torch.bfloat16 if use_cuda else torch.float32,
        attn_implementation="sdpa",
        use_safetensors=True,
    )


def _model_worker(request_queue: Any, response_queue: Any) -> None:
    try:
        model = load_qwen_model()
    except Exception as exc:
        response_queue.put(("startup", False, type(exc).__name__))
        return
    response_queue.put(("startup", True, None))
    while True:
        job = request_queue.get()
        if job is None:
            return
        job_id, text, speaker, speed, instruct = job
        try:
            wavs, sample_rate = model.generate_custom_voice(
                text=text,
                language="Chinese",
                speaker=speaker,
                instruct=instruct,
            )
            response_queue.put(
                (job_id, True, to_pcm16(wavs[0], sample_rate, speed))
            )
        except Exception as exc:
            response_queue.put((job_id, False, type(exc).__name__))


@dataclass
class Runtime:
    loader: Callable[[], Any] | None = None

    def __post_init__(self) -> None:
        self.model: Any | None = None
        self.status = "loading"
        self.error: str | None = None
        self._load_lock = asyncio.Lock()
        # ponytail: one inference lock is intentional for the 8 GB target GPU.
        self._inference_lock = asyncio.Lock()
        self._worker: Any | None = None
        self._request_queue: Any | None = None
        self._response_queue: Any | None = None
        self._active_job_id: str | None = None
        self._active_job_worker: Any | None = None
        self._reset_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._rewarm_task: asyncio.Task[None] | None = None
        self._cleanup_tasks: set[asyncio.Task[None]] = set()
        self._worker_stop_failed = False
        self._closing = False

    async def load(self) -> None:
        async with self._load_lock:
            if self._closing or self.model is not None or self._worker_stop_failed:
                return
            self.status = "loading"
            self.error = None
            try:
                if self.loader is not None:
                    loaded_model = await asyncio.to_thread(self.loader)
                    if self._closing:
                        return
                    self.model = loaded_model
                else:
                    await self._start_worker()
                    if self._closing:
                        return
                    self.model = True
            except Exception as exc:
                logger.exception("Qwen3-TTS model loading failed")
                self.status = "error"
                self.error = type(exc).__name__
                return
            self.status = "ready"

    async def synthesize(
        self,
        request: SpeechRequest,
        *,
        inference_id: str | None = None,
    ) -> bytes:
        if self.model is None:
            await self.load()
        if self.model is None:
            raise RuntimeError(self.error or "model unavailable")

        speaker = VOICE_ALIASES.get(request.voice, request.voice)
        profile = EMOTION_PROFILES[request.emotion]
        speed = min(2.0, max(0.5, request.speed * profile.speed_multiplier))
        async with self._inference_lock:
            if self.loader is None:
                return await self._synthesize_in_worker(
                    text=request.input,
                    speaker=speaker,
                    speed=speed,
                    instruct=profile.instruct,
                    inference_id=inference_id,
                )
            wavs, sample_rate = await asyncio.to_thread(
                self.model.generate_custom_voice,
                text=request.input,
                language="Chinese",
                speaker=speaker,
                instruct=profile.instruct,
            )
            return await asyncio.to_thread(to_pcm16, wavs[0], sample_rate, speed)

    async def _start_worker(self) -> None:
        if self._worker_stop_failed:
            raise RuntimeError("Qwen worker stop failure requires process restart")
        await self._stop_worker()
        current_task = asyncio.current_task()
        pending_cleanups = tuple(
            task
            for task in self._cleanup_tasks
            if task is not current_task and not task.done()
        )
        if pending_cleanups:
            await asyncio.gather(*pending_cleanups, return_exceptions=True)
        if self._worker_stop_failed:
            raise RuntimeError("Qwen worker stop failure requires process restart")
        if self._closing:
            raise asyncio.CancelledError
        context = multiprocessing.get_context("spawn")
        request_queue = context.Queue(maxsize=1)
        response_queue = context.Queue(maxsize=1)
        worker = context.Process(
            target=_model_worker,
            args=(request_queue, response_queue),
            daemon=True,
        )
        self._request_queue = request_queue
        self._response_queue = response_queue
        self._worker = worker
        worker.start()
        try:
            _, ok, detail = await self._read_worker_response(
                worker=worker,
                response_queue=response_queue,
                timeout=_WORKER_STARTUP_TIMEOUT_SECONDS
            )
        except asyncio.CancelledError:
            await self._stop_worker(expected_worker=worker)
            raise
        except Exception:
            await self._stop_worker(expected_worker=worker)
            raise
        if not ok:
            await self._stop_worker(expected_worker=worker)
            raise RuntimeError(f"Qwen worker failed to start: {detail}")

    async def _synthesize_in_worker(
        self,
        *,
        text: str,
        speaker: str,
        speed: float,
        instruct: str,
        inference_id: str | None,
    ) -> bytes:
        if self._worker is None or not self._worker.is_alive():
            self.model = None
            await self.load()
        worker = self._worker
        request_queue = self._request_queue
        response_queue = self._response_queue
        if worker is None or request_queue is None or response_queue is None:
            raise RuntimeError("Qwen worker request queue is unavailable")
        job_id = inference_id or str(uuid4())
        self._active_job_id = job_id
        self._active_job_worker = worker
        request_queue.put((job_id, text, speaker, speed, instruct))
        try:
            response_id, ok, payload = await self._read_worker_response(
                worker=worker,
                response_queue=response_queue,
                timeout=_WORKER_RESPONSE_TIMEOUT_SECONDS,
                job_id=job_id,
            )
        except asyncio.CancelledError:
            if self._active_job_id == job_id:
                await self._reset_worker_after_cancel(job_id, worker)
            raise
        except InferenceCancelledError:
            raise
        except Exception as exc:
            await self._recover_failed_worker(job_id, worker, type(exc).__name__)
            raise
        async with self._reset_lock:
            if (
                self._active_job_id != job_id
                or self._active_job_worker is not worker
            ):
                raise InferenceCancelledError("TTS inference was cancelled")
            self._active_job_id = None
            self._active_job_worker = None
        if response_id != job_id:
            raise RuntimeError("Qwen worker response ID mismatch")
        if not ok or not isinstance(payload, bytes):
            raise RuntimeError(f"Qwen worker synthesis failed: {payload}")
        return payload

    async def cancel(self, inference_id: str) -> bool:
        return await self._reset_worker_after_cancel(
            inference_id,
            self._active_job_worker,
        )

    async def _reset_worker_after_cancel(
        self,
        inference_id: str,
        worker: Any | None,
    ) -> bool:
        async with self._reset_lock:
            if (
                self._closing
                or not inference_id
                or self._active_job_id != inference_id
                or worker is None
                or self._active_job_worker is not worker
                or self._worker is not worker
            ):
                return False
            request_queue = self._request_queue
            response_queue = self._response_queue
            self._active_job_id = None
            self._active_job_worker = None
            self._worker = None
            self._request_queue = None
            self._response_queue = None
            self.model = None
            self.status = "loading"
            self.error = None
            cleanup_task = asyncio.create_task(
                self._cleanup_retired_generation(
                    worker,
                    request_queue,
                    response_queue,
                )
            )
            self._cleanup_tasks.add(cleanup_task)
            cleanup_task.add_done_callback(self._cleanup_task_done)
            return True

    def _cleanup_task_done(self, task: asyncio.Task[None]) -> None:
        self._cleanup_tasks.discard(task)
        if task.cancelled():
            return
        exception = task.exception()
        if exception is not None:
            logger.error(
                "Retired Qwen worker cleanup failed",
                exc_info=(type(exception), exception, exception.__traceback__),
            )

    async def _cleanup_retired_generation(
        self,
        worker: Any,
        request_queue: Any | None,
        response_queue: Any | None,
    ) -> None:
        try:
            await self._stop_generation(worker, request_queue, response_queue)
        except Exception as exc:
            self._mark_worker_stop_failed(exc)
            raise
        if not self._closing:
            self._schedule_rewarm()

    async def _recover_failed_worker(
        self,
        job_id: str,
        worker: Any,
        reason: str,
    ) -> None:
        async with self._reset_lock:
            if (
                self._active_job_id != job_id
                or self._active_job_worker is not worker
            ):
                return
            self._active_job_id = None
            self._active_job_worker = None
            await self._stop_worker(expected_worker=worker)
            self.model = None
            self.status = "error"
            self.error = reason
            self._schedule_rewarm()

    def _mark_worker_stop_failed(self, exception: Exception) -> None:
        self._worker_stop_failed = True
        self.model = None
        self.status = "error"
        self.error = type(exception).__name__

    def _schedule_rewarm(self) -> None:
        if self._closing or self._worker_stop_failed or (
            self._rewarm_task is not None and not self._rewarm_task.done()
        ):
            return

        async def rewarm() -> None:
            retry_delay = 1.0
            try:
                while (
                    not self._closing
                    and not self._worker_stop_failed
                    and self.model is None
                ):
                    await self.load()
                    if self.model is not None or self._closing:
                        return
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2.0, 30.0)
            finally:
                if self._rewarm_task is asyncio.current_task():
                    self._rewarm_task = None

        self._rewarm_task = asyncio.create_task(rewarm())

    async def _read_worker_response(
        self,
        *,
        worker: Any,
        response_queue: Any,
        timeout: float,
        job_id: str | None = None,
    ) -> tuple[Any, bool, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                if job_id is not None and (
                    self._worker is not worker
                    or self._active_job_id != job_id
                    or self._active_job_worker is not worker
                ):
                    raise InferenceCancelledError("TTS inference was cancelled")
                raise RuntimeError("Qwen worker timed out")
            try:
                return response_queue.get_nowait()
            except queue.Empty:
                if not worker.is_alive():
                    if job_id is not None and (
                        self._worker is not worker
                        or self._active_job_id != job_id
                        or self._active_job_worker is not worker
                    ):
                        raise InferenceCancelledError("TTS inference was cancelled")
                    raise RuntimeError("Qwen worker exited unexpectedly")
                await asyncio.sleep(min(0.05, remaining))
            except (EOFError, OSError, ValueError) as exc:
                if job_id is not None and (
                    self._worker is not worker
                    or self._active_job_id != job_id
                    or self._active_job_worker is not worker
                ):
                    raise InferenceCancelledError(
                        "TTS inference was cancelled"
                    ) from exc
                raise RuntimeError("Qwen worker response queue failed") from exc

    async def _stop_worker(self, *, expected_worker: Any | None = None) -> None:
        if expected_worker is not None and self._worker is not expected_worker:
            return
        worker = self._worker
        request_queue = self._request_queue
        response_queue = self._response_queue
        self._worker = None
        self._request_queue = None
        self._response_queue = None
        self._active_job_id = None
        self._active_job_worker = None
        try:
            await self._stop_generation(worker, request_queue, response_queue)
        except Exception as exc:
            self._mark_worker_stop_failed(exc)
            raise

    async def _stop_generation(
        self,
        worker: Any | None,
        request_queue: Any | None,
        response_queue: Any | None,
    ) -> None:
        async with self._stop_lock:
            stop_task = asyncio.create_task(
                asyncio.to_thread(
                    self._stop_generation_sync,
                    worker,
                    request_queue,
                    response_queue,
                )
            )
            try:
                await asyncio.shield(stop_task)
            except asyncio.CancelledError:
                await stop_task
                raise

    @staticmethod
    def _stop_generation_sync(
        worker: Any | None,
        request_queue: Any | None,
        response_queue: Any | None,
    ) -> None:
        try:
            if worker is not None:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(timeout=5)
                if worker.is_alive():
                    worker.kill()
                    worker.join(timeout=5)
                if worker.is_alive():
                    raise RuntimeError("Qwen worker remained alive after kill")
                with suppress(Exception):
                    worker.close()
        finally:
            for active_queue in (request_queue, response_queue):
                if active_queue is not None:
                    with suppress(Exception):
                        active_queue.close()
                    with suppress(Exception):
                        active_queue.cancel_join_thread()

    async def aclose(self) -> None:
        async with self._reset_lock:
            self._closing = True
            rewarm_task = self._rewarm_task
            self._rewarm_task = None
            cleanup_tasks = tuple(self._cleanup_tasks)
        if rewarm_task is not None:
            rewarm_task.cancel()
            with suppress(asyncio.CancelledError):
                await rewarm_task
        cleanup_cancelled = False
        if cleanup_tasks:
            cleanup_wait = asyncio.gather(*cleanup_tasks, return_exceptions=True)
            try:
                await asyncio.shield(cleanup_wait)
            except asyncio.CancelledError:
                await cleanup_wait
                cleanup_cancelled = True
        async with self._reset_lock:
            await self._stop_worker()
            self.model = None
        if cleanup_cancelled:
            raise asyncio.CancelledError

    def start(self) -> None:
        self._schedule_rewarm()

    def is_ready(self) -> bool:
        if self.status != "ready" or self.model is None:
            return False
        if self.loader is not None:
            return True
        return self._worker is not None and self._worker.is_alive()


def to_pcm16(wav: Any, sample_rate: int, speed: float) -> bytes:
    import librosa
    import numpy as np

    audio = np.asarray(wav, dtype=np.float32).squeeze()
    if audio.ndim != 1 or audio.size == 0:
        raise ValueError("model returned empty or non-mono audio")
    if not np.isfinite(audio).all():
        raise ValueError("model returned non-finite audio")
    if sample_rate != SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=SAMPLE_RATE)
    if speed != 1.0:
        audio = librosa.effects.time_stretch(y=audio, rate=speed)
    if audio.size == 0 or not np.isfinite(audio).all():
        raise ValueError("audio processing returned invalid audio")
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).round().astype("<i2").tobytes()


def create_app(runtime: Runtime | None = None) -> FastAPI:
    active_runtime = runtime or Runtime()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        active_runtime.start()
        try:
            yield
        finally:
            await active_runtime.aclose()

    app = FastAPI(title="Companion Space Qwen3-TTS", lifespan=lifespan)

    @app.get("/healthz")
    async def healthz() -> Response:
        if active_runtime.status == "ready" and not active_runtime.is_ready():
            active_runtime.model = None
            active_runtime.status = "error"
            active_runtime.error = "WorkerExited"
            active_runtime._schedule_rewarm()
        body = {"status": active_runtime.status, "model": MODEL_ID}
        if active_runtime.error:
            body["error"] = active_runtime.error
        return JSONResponse(body, status_code=200 if active_runtime.status == "ready" else 503)

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{
                "id": MODEL_ID,
                "object": "model",
                "owned_by": "Qwen",
                "source_model": SOURCE_MODEL_ID,
                "revision": MODEL_REVISION,
                "speakers": list(SPEAKERS),
            }],
        }

    @app.post("/v1/audio/speech")
    async def speech(
        request: SpeechRequest,
        client_request: Request,
        inference_id: str | None = Header(default=None, alias="X-Inference-ID"),
    ) -> Response:
        synthesis_task = asyncio.create_task(
            active_runtime.synthesize(request, inference_id=inference_id)
        )
        try:
            while not synthesis_task.done():
                if await client_request.is_disconnected():
                    synthesis_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await synthesis_task
                    raise HTTPException(status_code=499, detail="TTS request was cancelled")
                await asyncio.sleep(0.05)
            pcm = await synthesis_task
        except InferenceCancelledError as exc:
            raise HTTPException(status_code=499, detail="TTS request was cancelled") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail="TTS model is unavailable") from exc
        except (IndexError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=500, detail="TTS produced invalid audio") from exc
        return Response(
            pcm,
            media_type="application/octet-stream",
            headers={
                "X-Audio-Format": "pcm_s16le",
                "X-Audio-Channels": "1",
                "X-Audio-Sample-Rate": str(SAMPLE_RATE),
            },
        )

    @app.delete("/v1/audio/speech/{inference_id}", status_code=204)
    async def cancel_speech(inference_id: str) -> Response:
        if not await active_runtime.cancel(inference_id):
            raise HTTPException(status_code=404, detail="TTS inference is not active")
        return Response(status_code=204)

    return app


app = create_app()
