from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from functools import partial
from pathlib import Path

import numpy as np

from app.analysis.course_data import CourseData
from app.analysis.documents import DocumentBookmark, DocumentParser, ParsedPage
from app.analysis.indexing import chunk_document
from app.analysis.structure import build_sections
from app.llm.gateway import LLMGateway, usage_observer
from app.providers.errors import MissingRoleError, ProviderError, provider_error_code
from app.services.jobs import Job, JobFailure, JobProgress, JobRunner, ReportProgress

logger = logging.getLogger(__name__)
_IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_SCAN_NOTICE = (
    "Pages without readable text need a vision model. Connect one in Settings, then run analysis again."
)
_PARSE_NOTICE = "Could not read this document. Check that it opens and upload a supported copy."


class AnalysisPipeline:
    def __init__(self, data: CourseData, jobs: JobRunner, gateway: LLMGateway) -> None:
        self.data = data
        self.jobs = jobs
        self.gateway = gateway
        self.parser = DocumentParser(max_pdf_pages=data.repository.settings.max_pdf_pages)
        self.mutation_lock = asyncio.Lock()
        self.vision_slots = asyncio.Semaphore(3)
        jobs.register("parse", self.run)

    async def run(self, job: Job, report: ReportProgress) -> None:
        observer = usage_observer.set(partial(self.jobs.record_tokens, job.id))
        try:
            await self._run(job, report)
        except ProviderError as error:
            raise JobFailure(provider_error_code(error)) from error
        finally:
            usage_observer.reset(observer)

    async def _run(self, job: Job, report: ReportProgress) -> None:
        if job.stage is None:
            await report(JobProgress(stage="parse", progress=0))
        space_id = job.space_id
        if not space_id:
            raise JobFailure("The course was not found.")
        rows = await asyncio.to_thread(self.data.material_rows, space_id)
        if job.material_id:
            rows = [row for row in rows if row["id"] == job.material_id]
        refresh = bool(job.payload.get("refresh"))
        roles = await asyncio.to_thread(self.gateway.registry.get_roles)
        counts = len(rows)
        if not rows:
            raise JobFailure("Import course material first.")

        revision = [[row["id"], row["updated_at"]] for row in rows]
        if job.payload.get("revision") != revision:
            job.payload = {key: job.payload[key] for key in ("refresh", "parse_only") if key in job.payload}
            job.payload["revision"] = revision
            await asyncio.to_thread(self.jobs.checkpoint, job)

        if not job.payload.get("indexed"):
            parsed = set(job.payload.get("parsed", ()))
            for offset, material in enumerate(rows):
                await report(JobProgress(
                    stage="parse", progress=0.17 * offset / counts, detail=f"{offset + 1}/{counts}",
                ))
                if material["id"] not in parsed and (
                    refresh or material["parse_status"] in {"pending", "failed"}
                    or material["parse_status"] == "needs_vision" and "vision" in roles
                ):
                    await self._parse(material)
                parsed.add(material["id"])
                job.payload["parsed"] = sorted(parsed)
                await asyncio.to_thread(self.jobs.checkpoint, job)
            current = await asyncio.to_thread(self.data.material_rows, space_id)
            selected = {material["id"] for material in rows}
            rows = [material for material in current if material["id"] in selected]
            for offset, material in enumerate(rows):
                model = roles["embedding"].model if "embedding" in roles else None
                if not material.get("indexed") or refresh or material.get("embedding_model") != model:
                    await self._index(
                        material, report, 0.17 + 0.08 * offset / counts, "embedding" in roles, roles,
                    )
            job.payload["indexed"] = True
            await asyncio.to_thread(self.jobs.checkpoint, job)

        if job.material_id:
            return
        if job.payload.get("parse_only"):
            return
        await self._analyze(job, report, rows)

    async def _parse(self, material: dict) -> None:
        try:
            path = await asyncio.to_thread(self.data.original, material)
            image_dir = await asyncio.to_thread(self.data.images_dir, material["space_id"], material["id"])
            doc = await asyncio.to_thread(self.parser.parse, path, page_image_dir=image_dir)
            tasks = [asyncio.create_task(self._transcribe(page)) for page in doc.pages]
            try:
                pages = await asyncio.gather(*tasks)
            except BaseException:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise
            bookmarks = [asdict(bookmark) for bookmark in doc.bookmarks]
        except (OSError, ValueError, RuntimeError) as error:
            if isinstance(error, ProviderError):
                await asyncio.to_thread(
                    self.data.set_parse_state, material, "failed", error=provider_error_code(error),
                )
                raise
            logger.warning("Document could not be parsed", extra={"error_type": type(error).__name__})
            await asyncio.to_thread(self.data.set_parse_state, material, "failed", error=_PARSE_NOTICE)
            raise JobFailure(_PARSE_NOTICE) from error
        serialized = [
            {
                **asdict(page),
                "source": "pasted" if material["kind"] == "note" else page.source,
                "image_path": Path(page.image_path).relative_to(self.data.root).as_posix() if page.image_path else None,
            }
            for page in pages
        ]
        await asyncio.to_thread(
            self.data.save_pages, material, serialized, bookmarks,
            error=_SCAN_NOTICE if any(page.quality == 0 for page in pages) else None,
        )

    async def _transcribe(self, page: ParsedPage) -> ParsedPage:
        if page.quality or page.image_path is None:
            return page
        path = Path(page.image_path)
        async with self.vision_slots:
            try:
                text = await self.gateway.transcribe_page(
                    await asyncio.to_thread(path.read_bytes), mime=_IMAGE_TYPES[path.suffix.lower()], cache=True,
                )
            except MissingRoleError:
                return page
        if not text.strip():
            return page
        return ParsedPage(
            page_no=page.page_no, markdown=text, source="vision", quality=1.0, image_path=page.image_path,
        )

    async def _index(
        self, material: dict, report: ReportProgress, progress: float, embed: bool, roles: dict,
    ) -> None:
        await report(JobProgress(stage="structure", progress=progress))
        pages = await asyncio.to_thread(
            self.data.pages, material["space_id"], material["id"],
        )
        source_pages = tuple(ParsedPage(**page) for page in pages if page["quality"] > 0)
        bookmarks = tuple(DocumentBookmark(**entry) for entry in material.get("bookmarks", []))
        sections = await asyncio.to_thread(build_sections, material["id"], source_pages, bookmarks)
        await asyncio.to_thread(self.data.save_sections, material, [asdict(section) for section in sections])
        await report(JobProgress(stage="index", progress=progress + 0.02))
        chunks = await asyncio.to_thread(chunk_document, source_pages, sections)
        vectors: list[bytes | None] = [None] * len(chunks)
        model = None
        if embed and chunks:
            values = await self.gateway.embed([chunk.content for chunk in chunks])
            normalized = values / np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-12)
            vectors = [row.astype("<f4", copy=False).tobytes() for row in normalized]
            model = roles["embedding"].model
        await asyncio.to_thread(self.data.save_chunks, material, [asdict(chunk) for chunk in chunks], vectors, model)

    async def _analyze(self, job: Job, report: ReportProgress, materials: list[dict]) -> None:
        from app.analysis.course_analysis import analyze_course

        await analyze_course(self, job, report, materials)
