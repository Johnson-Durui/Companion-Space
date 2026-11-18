from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.job_events import job_progress_response
from app.core.config import Settings
from app.services.jobs import JobProgress, JobRunner, get_job
from app.services.repository import SQLiteRepository


def test_runner_limits_parallel_jobs_and_reports_progress_usage(tmp_path: Path) -> None:
    repository = SQLiteRepository(Settings(object_storage_path=str(tmp_path)))

    async def scenario() -> None:
        runner = JobRunner(repository, concurrency=1)
        started = asyncio.Queue()
        finished = asyncio.Event()
        release = asyncio.Event()
        completions: set[str] = set()

        async def handler(job, report):
            await report(JobProgress(stage="parsing", progress=0.5, tokens_in=25, tokens_out=8))
            started.put_nowait(job.id)
            await release.wait()
            completions.add(job.id)
            if len(completions) == 2:
                finished.set()

        runner.register("parse", handler)
        await runner.start()
        try:
            first = await runner.submit("parse", payload={"raw": "private-content"})
            second = await runner.submit("parse", payload={"raw": "private-content"})
            assert await asyncio.wait_for(started.get(), timeout=5) == first.id
            assert get_job(repository, second.id).status == "queued"
            assert started.empty()

            await runner.set_concurrency(2)
            assert await asyncio.wait_for(started.get(), timeout=5) == second.id
            release.set()
            await asyncio.wait_for(finished.wait(), timeout=5)
            response = await job_progress_response(repository, first.id)
            async with asyncio.timeout(5):
                output = "".join([chunk async for chunk in response.body_iterator])
            assert "event: job" in output
            assert '"status":"completed"' in output
            assert '"tokens_in":25' in output and '"tokens_out":8' in output
            assert "private-content" not in output
            with pytest.raises(HTTPException) as missed:
                await job_progress_response(repository, first.id, space_id="other-space")
            assert missed.value.status_code == 404
        finally:
            await runner.aclose()

    asyncio.run(scenario())


def test_runner_restarts_incomplete_jobs_from_durable_state(tmp_path: Path) -> None:
    repository = SQLiteRepository(Settings(object_storage_path=str(tmp_path)))

    async def scenario() -> None:
        stopped = JobRunner(repository)
        enters = asyncio.Event()

        async def interrupted(job, report):
            await report(JobProgress(stage="parsing", progress=0.4, tokens_in=10))
            enters.set()
            await asyncio.Event().wait()

        stopped.register("parse", interrupted)
        await stopped.start()
        try:
            job = await stopped.submit("parse", payload={"version": 1})
            await asyncio.wait_for(enters.wait(), timeout=5)
        finally:
            await stopped.aclose()
        assert get_job(repository, job.id).status == "running"

        recovered = JobRunner(SQLiteRepository(repository.settings))
        seen = asyncio.Queue()

        async def continue_or_fail(item, report):
            seen.put_nowait(item)
            await report(JobProgress(stage="indexing", progress=0.8, tokens_in=5))
            raise ValueError("private detail that the UI should never expose")

        recovered.register("parse", continue_or_fail)
        await recovered.start()
        try:
            item = await asyncio.wait_for(seen.get(), timeout=5)
            assert item.payload == {"version": 1} and item.progress == 0.4
            response = await job_progress_response(repository, job.id)
            async with asyncio.timeout(5):
                output = "".join([chunk async for chunk in response.body_iterator])
            stored = get_job(repository, job.id)
            assert stored.status == "failed" and stored.tokens_in == 15
            assert "private detail" not in output
        finally:
            await recovered.aclose()

    asyncio.run(scenario())
