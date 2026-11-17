from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.services.jobs import TERMINAL_STATUSES, Job, get_job
from app.services.repository import SQLiteRepository


async def job_progress_response(
    repository: SQLiteRepository, job_id: str, *, space_id: str | None = None,
) -> StreamingResponse:
    initial = await asyncio.to_thread(get_job, repository, job_id)
    if initial is None or initial.space_id != space_id:
        raise HTTPException(404, detail={"code": "job_missing", "message": "Job not found."})

    async def events() -> AsyncIterator[str]:
        job: Job | None = initial
        previous = None
        loop = asyncio.get_running_loop()
        last_sent = loop.time()
        while job is not None and job.space_id == space_id:
            data = job.model_dump_json(exclude={"payload"})
            if data != previous:
                yield f"event: job\ndata: {data}\n\n"
                previous = data
                last_sent = loop.time()
            elif loop.time() - last_sent > 15:
                yield ": keep-alive\n\n"
                last_sent = loop.time()
            if job.status in TERMINAL_STATUSES:
                break
            await asyncio.sleep(0.3)
            job = await asyncio.to_thread(get_job, repository, job_id)

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
