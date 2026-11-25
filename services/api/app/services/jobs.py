from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from app.repositories.mixins.common import _to_db, utcnow
from app.services.repository import SQLiteRepository

JobKind = Literal[
    "parse", "structure", "index", "kp_extract", "kp_reduce", "exam_extract",
    "item_verify", "exam_stats", "diag_pool", "brief", "lesson_prepare",
    "more_items", "recap", "replan",
]
JobStatus = Literal["queued", "running", "completed", "failed"]
TERMINAL_STATUSES = {"completed", "failed"}
logger = logging.getLogger(__name__)


class Job(BaseModel):
    id: str
    space_id: str | None
    material_id: str | None
    kind: JobKind
    stage: str | None
    status: JobStatus
    progress: float
    detail: str | None
    payload: dict[str, Any]
    tokens_in: int
    tokens_out: int
    error: str | None
    created_at: datetime
    updated_at: datetime


class JobProgress(BaseModel):
    stage: str = Field(min_length=1, max_length=80)
    progress: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)
    detail: str | None = Field(default=None, max_length=240)
    tokens_in: int = Field(default=0, ge=0)
    tokens_out: int = Field(default=0, ge=0)


ReportProgress = Callable[[JobProgress], Awaitable[None]]
JobHandler = Callable[[Job, ReportProgress], Awaitable[None]]


class JobFailure(Exception):
    """A safe, actionable failure message intended for the owner."""


def _job(row) -> Job:
    record = dict(row)
    record["payload"] = json.loads(record.pop("payload_json") or "{}")
    return Job.model_validate(record)


def get_job(repository: SQLiteRepository, job_id: str) -> Job | None:
    with repository.connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _job(row) if row is not None else None


def latest_analysis_job(repository: SQLiteRepository, space_id: str) -> Job | None:
    with repository.connection() as conn:
        row = conn.execute(
            """SELECT * FROM jobs WHERE space_id = ? AND kind = 'parse' AND material_id IS NULL
               ORDER BY created_at DESC, rowid DESC LIMIT 1""",
            (space_id,),
        ).fetchone()
    return _job(row) if row is not None else None


class JobRunner:
    def __init__(self, repository: SQLiteRepository, concurrency: int = 4) -> None:
        self._validate_limit(concurrency)
        self.repository = repository
        self._limit = concurrency
        self._active = 0
        self._slots = asyncio.Condition()
        self._handlers: dict[JobKind, JobHandler] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._started = False

    @staticmethod
    def _validate_limit(limit: int) -> None:
        if not 1 <= limit <= 20:
            raise ValueError("Job concurrency must be between 1 and 20")

    async def set_concurrency(self, limit: int) -> None:
        self._validate_limit(limit)
        async with self._slots:
            self._limit = limit
            self._slots.notify_all()

    def register(self, kind: JobKind, handler: JobHandler) -> None:
        if self._started:
            raise RuntimeError("Register job handlers before starting the runner")
        if kind in self._handlers:
            raise ValueError("A handler already exists for this job kind")
        self._handlers[kind] = handler

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        try:
            pending = await asyncio.to_thread(self._recover)
        except BaseException:
            self._started = False
            raise
        for job in pending:
            if job.kind in self._handlers:
                self._enqueue(job.id)

    async def aclose(self) -> None:
        self._started = False
        tasks = tuple(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    async def submit(
        self, kind: JobKind, *, payload: dict[str, Any],
        space_id: str | None = None, material_id: str | None = None,
    ) -> Job:
        if kind not in self._handlers:
            raise ValueError("No handler is registered for this job kind")
        job = await asyncio.to_thread(self._insert, kind, payload, space_id, material_id)
        if self._started:
            self._enqueue(job.id)
        return job

    async def retry_analysis(self, job_id: str, space_id: str, stage: str) -> Job | None:
        def retry():
            with self.repository.connection() as conn:
                row = conn.execute(
                    """UPDATE jobs SET status = 'queued', error = NULL, updated_at = ?
                       WHERE id = ? AND space_id = ? AND stage = ? AND status = 'failed'
                       RETURNING *""",
                    (_to_db(utcnow()), job_id, space_id, stage),
                ).fetchone()
            return _job(row) if row is not None else None

        job = await asyncio.to_thread(retry)
        if job and self._started:
            self._enqueue(job.id)
        return job

    def checkpoint(self, job: Job) -> None:
        with self.repository.connection() as conn:
            conn.execute(
                "UPDATE jobs SET payload_json = ? WHERE id = ? AND space_id = ? AND status = 'running'",
                (json.dumps(job.payload, ensure_ascii=False), job.id, job.space_id),
            )

    def record_tokens(self, job_id: str, input_tokens: int, output_tokens: int) -> None:
        with self.repository.connection() as conn:
            conn.execute(
                """UPDATE jobs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ?
                   WHERE id = ? AND status = 'running'""",
                (input_tokens, output_tokens, _to_db(utcnow()), job_id),
            )

    def _enqueue(self, job_id: str) -> None:
        if job_id in self._tasks:
            return
        task = asyncio.create_task(self._run(job_id), name=f"background-job-{job_id}")
        self._tasks[job_id] = task

        def complete(finished: asyncio.Task[None]) -> None:
            if self._tasks.get(job_id) is finished:
                self._tasks.pop(job_id)
            if not finished.cancelled() and finished.exception() is not None:
                logger.error("Background job persistence failed", extra={"job_id": job_id})

        task.add_done_callback(complete)

    async def _run(self, job_id: str) -> None:
        async with self._slots:
            await self._slots.wait_for(lambda: self._active < self._limit)
            self._active += 1
        try:
            job = await asyncio.to_thread(self._claim, job_id)
            if job is None:
                return

            # Jobs can report progress from async model calls without holding
            # an SQLite connection while waiting for the next chunk.
            async def report(progress: JobProgress) -> None:
                await asyncio.to_thread(self._report, job_id, progress)

            try:
                await self._handlers[job.kind](job, report)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                cause = exc.__cause__ or exc
                logger.warning(
                    "Background job failed (kind=%s job_id=%s error_type=%s cause_type=%s detail=%s)",
                    job.kind,
                    job.id,
                    type(exc).__name__,
                    type(cause).__name__,
                    str(cause)[:400],
                    extra={"job_id": job.id, "job_kind": job.kind, "error_type": type(exc).__name__},
                )
                error = str(exc) if isinstance(exc, JobFailure) else "Job processing failed"
                await asyncio.to_thread(self._finish, job.id, "failed", error)
            else:
                await asyncio.to_thread(self._finish, job.id, "completed", None)
        finally:
            async with self._slots:
                self._active -= 1
                self._slots.notify_all()

    def _insert(self, kind: JobKind, payload: dict, space_id: str | None, material_id: str | None) -> Job:
        job = Job(
            id=str(uuid4()), space_id=space_id, material_id=material_id, kind=kind,
            stage=None, status="queued", progress=0, detail=None, payload=payload,
            tokens_in=0, tokens_out=0, error=None, created_at=utcnow(), updated_at=utcnow(),
        )
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if material_id is not None:
                material = conn.execute(
                    "SELECT space_id FROM materials WHERE id = ?", (material_id,),
                ).fetchone()
                if material is None or material["space_id"] != space_id:
                    raise ValueError("The material does not belong to this space")
            conn.execute(
                """INSERT INTO jobs(id, space_id, material_id, kind, status, payload_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job.id, space_id, material_id, kind, job.status,
                    json.dumps(payload, ensure_ascii=False), _to_db(job.created_at), _to_db(job.updated_at),
                ),
            )
        return job

    def _recover(self) -> list[Job]:
        with self.repository.connection() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
                (_to_db(utcnow()),),
            )
            pending = conn.execute(
                "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC"
            ).fetchall()
        return [_job(row) for row in pending]

    def _claim(self, job_id: str) -> Job | None:
        with self.repository.connection() as conn:
            row = conn.execute(
                """UPDATE jobs SET status = 'running', error = NULL, updated_at = ?
                   WHERE id = ? AND status = 'queued'
                   RETURNING *""",
                (_to_db(utcnow()), job_id),
            ).fetchone()
        return _job(row) if row is not None else None

    def _report(self, job_id: str, progress: JobProgress) -> None:
        with self.repository.connection() as conn:
            conn.execute(
                """UPDATE jobs
                   SET stage = ?, progress = ?, detail = ?, updated_at = ?,
                       tokens_in = tokens_in + ?, tokens_out = tokens_out + ?
                   WHERE id = ? AND status = 'running'""",
                (
                    progress.stage, progress.progress, progress.detail, _to_db(utcnow()),
                    progress.tokens_in, progress.tokens_out, job_id,
                ),
            )

    def _finish(self, job_id: str, status: JobStatus, error: str | None) -> None:
        with self.repository.connection() as conn:
            conn.execute(
                """UPDATE jobs
                   SET status = ?, error = ?, updated_at = ?,
                       progress = CASE WHEN ? = 'completed' THEN 1 ELSE progress END
                   WHERE id = ? AND status = 'running'""",
                (status, error, _to_db(utcnow()), status, job_id),
            )
