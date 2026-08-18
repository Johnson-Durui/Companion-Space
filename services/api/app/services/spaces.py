from __future__ import annotations

import asyncio
import logging
import queue
import re
import shutil
import threading
import time
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator
from uuid import uuid4

from pypdf import PdfReader

from app.core.config import Settings
from app.models.domain import (
    Chunk,
    IngestionJob,
    Material,
    MaterialKind,
    ModelAssignment,
    ProviderCapability,
    RetrievalHit,
    RetrievalResult,
    StudySpace,
)
from app.providers.errors import ProviderConfigurationError, ProviderProtocolError
from app.rag.embeddings import build_embedding_provider, cosine_similarity, extract_terms, normalize_text
from app.rag.parser import DocumentParser
from app.rag.reranker import build_reranker_provider
from app.services.characters import CharacterService
from app.services.material_storage import (
    MATERIAL_STORAGE_PATH_ERROR,
    SUPPORTED_MATERIAL_SUFFIXES,
    build_material_storage_key,
    canonical_material_storage_key,
)
from app.services.provider_registry import (
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_MOCK_ANALYSIS_MODEL,
    BUILTIN_MOCK_MODEL,
    BUILTIN_MOCK_STT_MODEL,
    BUILTIN_MOCK_TTS_MODEL,
    ProviderRegistryService,
    ResolvedProvider,
    ensure_builtin_mock_connection,
)
from app.services.repository import SQLiteRepository

if TYPE_CHECKING:
    from app.services.metrics import MetricsService


HEADING_PATTERN = re.compile(r"^(#{1,3}\s+.+|[0-9]+\.\s+.+|第[一二三四五六七八九十百千0-9]+[章节部分].+)$", re.MULTILINE)
INGESTION_TERMINAL_STATUSES = frozenset({"completed", "failed"})
INGESTION_ACTIVE_STATUSES = frozenset({"queued", "processing"})
_WORKER_STOP = object()
logger = logging.getLogger(__name__)


def _paragraph_chunks(text: str, limit: int = 420) -> list[str]:
    blocks = [block.strip() for block in re.split(r"\n{2,}", text) if block.strip()]
    chunks: list[str] = []
    current = ""
    for block in blocks:
        candidate = f"{current}\n\n{block}".strip()
        if current and len(candidate) > limit:
            chunks.append(current)
            current = block
            continue
        current = candidate
    if current:
        chunks.append(current)
    return chunks


class StudySpaceService:
    def __init__(self, settings: Settings, repository: SQLiteRepository) -> None:
        self.settings = settings
        self.repository = repository
        self.parser = DocumentParser(
            max_pdf_pages=settings.max_pdf_pages,
            max_extracted_text_chars=settings.max_extracted_text_chars,
        )
        self.embedding_provider = build_embedding_provider(settings)
        self.reranker = build_reranker_provider(settings)
        self.provider_registry: ProviderRegistryService | None = None
        self.metrics: MetricsService | None = None
        self._ingestion_queue: queue.Queue[str | object] = queue.Queue()
        self._queued_job_ids: set[str] = set()
        self._worker_lock = threading.Lock()
        self._worker_thread: threading.Thread | None = None
        self._embedding_assignment_lock = threading.RLock()

    def set_provider_registry(self, provider_registry: ProviderRegistryService) -> None:
        self.provider_registry = provider_registry

    def set_metrics(self, metrics: MetricsService) -> None:
        self.metrics = metrics

    def start_ingestion_worker(self) -> None:
        with self._worker_lock:
            if self._worker_thread is not None and self._worker_thread.is_alive():
                return
            self.repository.requeue_processing_ingestion_jobs()
            self._worker_thread = threading.Thread(
                target=self._ingestion_worker_loop,
                name="companion-ingestion",
                daemon=True,
            )
            self._worker_thread.start()
        for job in self.repository.list_pending_ingestion_jobs():
            self._put_ingestion_job(job.id)

    def close(self) -> None:
        with self._worker_lock:
            worker = self._worker_thread
            if worker is None:
                return
            self._ingestion_queue.put(_WORKER_STOP)
        worker.join(timeout=5)
        with self._worker_lock:
            if self._worker_thread is worker and not worker.is_alive():
                self._worker_thread = None

    def _put_ingestion_job(self, job_id: str) -> None:
        with self._worker_lock:
            if job_id in self._queued_job_ids:
                return
            self._queued_job_ids.add(job_id)
        self._ingestion_queue.put(job_id)

    def _enqueue_ingestion_job(self, job_id: str) -> None:
        self.start_ingestion_worker()
        self._put_ingestion_job(job_id)

    def _ingestion_worker_loop(self) -> None:
        while True:
            queued = self._ingestion_queue.get()
            try:
                if queued is _WORKER_STOP:
                    return
                job_id = str(queued)
                claimed = self.repository.claim_ingestion_job(job_id)
                if claimed is None:
                    continue
                self._process_ingestion_job(claimed)
            finally:
                if queued is not _WORKER_STOP:
                    with self._worker_lock:
                        self._queued_job_ids.discard(str(queued))
                self._ingestion_queue.task_done()

    def _process_ingestion_job(self, job: IngestionJob) -> None:
        try:
            material = self.repository.get_material(job.material_id)
            if material is None or material.space_id != job.space_id:
                return
            storage_path = self._validated_material_path(material)
            parsed = self.parser.parse(storage_path)
            chunks = self._build_chunks(
                space_id=job.space_id,
                material=material,
                text=parsed,
            )
            if not chunks:
                raise ValueError("Material did not yield indexable text")
            completed_at = datetime.now(timezone.utc)
            completed_material = material.model_copy(
                update={
                    "chunk_count": len(chunks),
                    "updated_at": completed_at,
                }
            )
            completed_job = job.model_copy(
                update={
                    "status": "completed",
                    "error_message": None,
                    "updated_at": completed_at,
                }
            )
            with self._embedding_assignment_lock:
                self._ensure_chunks_match_current_embedding_assignment(
                    space_id=job.space_id,
                    chunks=chunks,
                )
                self.repository.complete_ingestion(
                    material=completed_material,
                    job=completed_job,
                    chunks=chunks,
                )
            if self.metrics is not None:
                self.metrics.record_event_safe(
                    "material_ready",
                    {
                        "space_id": job.space_id,
                        "material_id": job.material_id,
                    },
                    once=True,
                )
        except Exception as exc:
            self.repository.fail_ingestion_job(
                job_id=job.id,
                error_message=self._safe_ingestion_error(exc),
            )
            logger.warning(
                "Material ingestion failed",
                extra={
                    "extra_payload": {
                        "job_id": job.id,
                        "material_id": job.material_id,
                        "reason_type": type(exc).__name__,
                    }
                },
            )
            if self.metrics is not None:
                self.metrics.record_event_safe(
                    "ingestion_failed",
                    {
                        "space_id": job.space_id,
                        "material_id": job.material_id,
                        "code": type(exc).__name__.casefold(),
                    },
                )

    @staticmethod
    def _safe_ingestion_error(exc: Exception) -> str:
        message = str(exc)
        safe_prefixes = (
            "Encrypted PDFs are not supported",
            "Material did not yield indexable text",
            "PDF did not yield extractable text",
            "PDF exceeds ",
            "PDF file is damaged or unsupported",
            "Material extracted text exceeds safety limit",
            "Text material",
            "Unsupported document type",
        )
        if any(message.startswith(prefix) for prefix in safe_prefixes):
            return message
        return "Unable to index this material"

    def list_spaces(self) -> list[StudySpace]:
        return self.repository.list_spaces()

    def get_space(self, space_id: str) -> StudySpace | None:
        return self.repository.get_space(space_id)

    def get_space_detail(self, space_id: str) -> dict[str, Any]:
        space = self.require_space(space_id)
        return {
            "space": space,
            "materials": self.repository.list_materials(space_id),
            "jobs": self.repository.list_ingestion_jobs(space_id),
            "assignments": self.repository.list_model_assignments(space_id),
        }

    @contextmanager
    def embedding_assignment_change(self) -> Iterator[None]:
        with self._embedding_assignment_lock:
            yield

    def mark_materials_for_embedding_reindex(self, space_id: str) -> list[IngestionJob]:
        with self._embedding_assignment_lock:
            self.require_space(space_id)
            active_material_ids = {
                job.material_id
                for job in self.repository.list_ingestion_jobs(space_id)
                if job.status in INGESTION_ACTIVE_STATUSES
            }
            now = datetime.now(timezone.utc)
            jobs: list[IngestionJob] = []
            for material in self.repository.list_materials(space_id):
                if material.id in active_material_ids:
                    continue
                job = IngestionJob(
                    id=str(uuid4()),
                    space_id=space_id,
                    material_id=material.id,
                    status="failed",
                    error_message=(
                        "Embedding model changed. Retry indexing this material "
                        "before using dense retrieval."
                    ),
                    created_at=now,
                    updated_at=now,
                )
                self.repository.upsert_ingestion_job(job)
                jobs.append(job)
            return jobs

    def create_space(self, *, name: str, topic: str = "", goal: str = "") -> StudySpace:
        now = datetime.now(timezone.utc)
        space = StudySpace(id=str(uuid4()), name=name, topic=topic, goal=goal, created_at=now, updated_at=now)
        ensure_builtin_mock_connection(self.repository)
        tts_target = (
            self.provider_registry.bootstrap_tts_target()
            if self.provider_registry is not None
            else nullcontext((BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_TTS_MODEL))
        )
        with tts_target as (tts_connection_id, tts_model_name):
            self.repository.upsert_space(space)
            for capability, model_name in (
                (ProviderCapability.chat_llm, BUILTIN_MOCK_MODEL),
                (ProviderCapability.analysis_llm, BUILTIN_MOCK_ANALYSIS_MODEL),
                (ProviderCapability.stt, BUILTIN_MOCK_STT_MODEL),
                (ProviderCapability.tts, tts_model_name),
            ):
                connection_id = (
                    tts_connection_id
                    if capability is ProviderCapability.tts
                    else BUILTIN_MOCK_CONNECTION_ID
                )
                self.repository.upsert_model_assignment(
                    ModelAssignment(
                        id=str(uuid4()),
                        space_id=space.id,
                        capability=capability,
                        provider_connection_id=connection_id,
                        model_name=model_name,
                        is_bootstrap_default=True,
                        created_at=now,
                        updated_at=now,
                    )
                )
        self._material_dir(space.id).mkdir(parents=True, exist_ok=True)
        return space

    def update_space(self, space_id: str, *, name: str, topic: str, goal: str) -> StudySpace:
        return self.repository.update_space_metadata(
            space_id=space_id,
            name=name,
            topic=topic,
            goal=goal,
            updated_at=datetime.now(timezone.utc),
        )

    def set_default_character(
        self,
        space_id: str,
        *,
        character_pack_id: str | None,
    ) -> StudySpace:
        return self.repository.set_space_default_character(
            space_id=space_id,
            character_pack_id=character_pack_id,
            validate_character=lambda character: CharacterService(
                self.repository
            ).ensure_relationship_allowed(character.recipe),
        )

    def delete_space(self, space_id: str) -> bool:
        self.require_space(space_id)
        space_dir = self._space_dir(space_id)
        staged_dir: Path | None = None
        if space_dir.exists():
            staged_dir = self._contained_child(
                self.settings.spaces_root,
                f".deleting-{space_id}-{uuid4()}",
            )
            space_dir.rename(staged_dir)

        try:
            deleted = self.repository.delete_space(space_id)
        except Exception:
            if staged_dir is not None and staged_dir.exists() and not space_dir.exists():
                staged_dir.rename(space_dir)
            raise

        if not deleted:
            if staged_dir is not None and staged_dir.exists() and not space_dir.exists():
                staged_dir.rename(space_dir)
            return False

        if staged_dir is not None:
            shutil.rmtree(staged_dir)
        return True

    def require_space(self, space_id: str) -> StudySpace:
        space = self.repository.get_space(space_id)
        if space is None:
            raise ValueError("Study space not found")
        return space

    def list_materials(self, space_id: str) -> list[Material]:
        self.require_space(space_id)
        return self.repository.list_materials(space_id)

    def list_ingestion_jobs(self, space_id: str) -> list[IngestionJob]:
        self.require_space(space_id)
        return self.repository.list_ingestion_jobs(space_id)

    def delete_material(self, *, space_id: str, material_id: str) -> bool:
        self.require_space(space_id)
        material = self.repository.get_material(material_id)
        if material is None:
            raise ValueError("Material not found")
        if material.space_id != space_id:
            raise ValueError("Material not found")

        storage_path = self._validated_material_path(material)
        material_root = self._material_dir(space_id).resolve()

        staged_path: Path | None = None
        if storage_path.exists():
            if not storage_path.is_file():
                raise ValueError("Material storage path is not a file")
            staged_path = self._contained_child(
                material_root,
                f".deleting-{material_id}-{uuid4()}{storage_path.suffix}",
            )
            storage_path.rename(staged_path)

        try:
            deleted = self.repository.delete_material(space_id=space_id, material_id=material_id)
        except Exception:
            if staged_path is not None and staged_path.exists() and not storage_path.exists():
                staged_path.rename(storage_path)
            raise
        if not deleted:
            if staged_path is not None and staged_path.exists() and not storage_path.exists():
                staged_path.rename(storage_path)
            return False
        if staged_path is not None:
            staged_path.unlink()
        return True

    def resolve_material_path(self, material: Material) -> Path:
        try:
            storage_key = canonical_material_storage_key(material)
            storage_path = self._contained_child(
                self.settings.storage_root,
                storage_key,
            )
            material_root = self._material_dir(material.space_id).resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError(MATERIAL_STORAGE_PATH_ERROR) from exc
        if not storage_path.is_relative_to(material_root):
            raise ValueError(MATERIAL_STORAGE_PATH_ERROR)
        return storage_path

    def _validated_material_path(self, material: Material) -> Path:
        return self.resolve_material_path(material)

    def ingest_bytes(self, *, space_id: str, filename: str, data: bytes, title: str | None = None) -> tuple[Material, IngestionJob]:
        self.require_space(space_id)
        self._validate_upload(filename=filename, data=data)
        now = datetime.now(timezone.utc)
        material_id = str(uuid4())
        job_id = str(uuid4())
        material_title = (title or Path(filename).stem).strip()
        if (
            not material_title
            or len(material_title) > 120
            or any(
                ord(character) < 32 or ord(character) == 127
                for character in material_title
            )
        ):
            raise ValueError("Material title must contain 1 to 120 characters")
        storage_key = build_material_storage_key(
            space_id=space_id,
            material_id=material_id,
            filename=filename,
        )
        storage_path = self._contained_child(self.settings.storage_root, storage_key)
        storage_path.write_bytes(data)
        material = Material(
            id=material_id,
            space_id=space_id,
            title=material_title,
            kind=self._infer_kind(filename),
            filename=filename,
            storage_path=storage_key,
            chunk_count=0,
            created_at=now,
            updated_at=now,
        )
        job = IngestionJob(
            id=job_id,
            space_id=space_id,
            material_id=material_id,
            status="queued",
            created_at=now,
            updated_at=now,
        )
        try:
            self.repository.create_material_with_job(material=material, job=job)
        except Exception:
            storage_path.unlink(missing_ok=True)
            raise
        self._enqueue_ingestion_job(job.id)
        return material, job

    def ingest_note(self, *, space_id: str, title: str, content: str) -> tuple[Material, IngestionJob]:
        filename = f"{re.sub(r'[^A-Za-z0-9_-]+', '-', title).strip('-') or 'note'}.md"
        return self.ingest_bytes(space_id=space_id, filename=filename, data=content.encode("utf-8"), title=title)

    def retry_material(self, *, space_id: str, material_id: str) -> tuple[Material, IngestionJob]:
        self.require_space(space_id)
        material = self.repository.get_material(material_id)
        if material is None or material.space_id != space_id:
            raise ValueError("Material not found")
        jobs = [
            job
            for job in self.repository.list_ingestion_jobs(space_id)
            if job.material_id == material_id
        ]
        latest = jobs[0] if jobs else None
        if latest is None or latest.status != "failed":
            if latest is not None and latest.status in INGESTION_ACTIVE_STATUSES:
                raise ValueError("Material already has an active ingestion job")
            raise ValueError("Only failed material ingestion can be retried")
        now = datetime.now(timezone.utc)
        job = IngestionJob(
            id=str(uuid4()),
            space_id=space_id,
            material_id=material_id,
            status="queued",
            created_at=now,
            updated_at=now,
        )
        job = self.repository.create_retry_ingestion_job(
            failed_job_id=latest.id,
            retry_job=job,
        )
        self._enqueue_ingestion_job(job.id)
        return material, job

    def wait_for_ingestion(
        self,
        job_id: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> IngestionJob:
        deadline = time.monotonic() + timeout_seconds
        while True:
            job = self.repository.get_ingestion_job(job_id)
            if job is None:
                raise ValueError("Ingestion job not found")
            if job.status in INGESTION_TERMINAL_STATUSES:
                return job
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out waiting for material ingestion")
            time.sleep(0.01)

    def retrieve(
        self,
        *,
        space_id: str,
        query: str,
        pools: tuple[str, ...] = ("materials",),
    ) -> RetrievalResult:
        self._validate_retrieval_pools(pools)
        normalized_query = normalize_text(query)
        rewritten_query = self._rewrite_query(normalized_query)
        query_vector = self.embedding_provider.embed(rewritten_query)
        chunks = self.repository.search_chunks_fts(
            space_id=space_id,
            query=rewritten_query,
            limit=max(self.settings.retrieval_top_k * 4, self.settings.retrieval_top_k),
        )
        return self._rank_retrieval(
            query=query,
            normalized_query=normalized_query,
            rewritten_query=rewritten_query,
            chunks=chunks,
            query_vector=query_vector,
        )

    async def retrieve_async(
        self,
        *,
        space_id: str,
        query: str,
        pools: tuple[str, ...] = ("materials",),
    ) -> RetrievalResult:
        self._validate_retrieval_pools(pools)
        normalized_query = normalize_text(query)
        rewritten_query = self._rewrite_query(normalized_query)
        chunks = self.repository.search_chunks_fts(
            space_id=space_id,
            query=rewritten_query,
            limit=max(self.settings.retrieval_top_k * 4, self.settings.retrieval_top_k),
        )
        if not chunks:
            return self._empty_retrieval(
                normalized_query=normalized_query,
                rewritten_query=rewritten_query,
            )
        assignment = next(
            (
                item
                for item in self.repository.list_model_assignments(space_id)
                if item.capability is ProviderCapability.embedding
            ),
            None,
        )
        if assignment is None:
            self._ensure_local_chunk_embedding_provenance(chunks)
            return self._rank_retrieval(
                query=query,
                normalized_query=normalized_query,
                rewritten_query=rewritten_query,
                chunks=chunks,
                query_vector=self.embedding_provider.embed(rewritten_query),
            )
        if self.provider_registry is None:
            raise ProviderConfigurationError(
                provider="embedding",
                public_detail="Embedding provider registry is not available.",
            )
        resolved = self.provider_registry.resolve(
            space_id=space_id,
            capability=ProviderCapability.embedding,
        )
        self._ensure_chunk_embedding_provenance(
            chunks=chunks,
            resolved=resolved,
        )
        vectors = await resolved.adapter.embed(
            model=assignment.model_name,
            texts=[rewritten_query],
        )
        if len(vectors) != 1:
            raise ProviderProtocolError(
                provider=resolved.connection.provider,
                public_detail="Provider returned an invalid embeddings response.",
            )
        return self._rank_retrieval(
            query=query,
            normalized_query=normalized_query,
            rewritten_query=rewritten_query,
            chunks=chunks,
            query_vector=vectors[0],
        )

    @staticmethod
    def _validate_retrieval_pools(pools: tuple[str, ...]) -> None:
        if pools != ("materials",):
            raise ValueError("Material, memory, and review retrieval pools must remain separate")

    @staticmethod
    def _empty_retrieval(
        *,
        normalized_query: str,
        rewritten_query: str,
    ) -> RetrievalResult:
        return RetrievalResult(
            normalized_query=normalized_query,
            rewritten_query=rewritten_query,
            intent="study",
            hits=[],
            used_space_materials=False,
        )

    def _rank_retrieval(
        self,
        *,
        query: str,
        normalized_query: str,
        rewritten_query: str,
        chunks: list[Chunk],
        query_vector: dict[str, float] | list[float],
    ) -> RetrievalResult:
        query_terms = set(extract_terms(rewritten_query))

        hits: list[RetrievalHit] = []
        for chunk in chunks:
            dense_score = cosine_similarity(query_vector, chunk.dense_vector)
            sparse_score = self._sparse_score(query_terms, chunk.sparse_terms)
            keyword_boost = 0.0
            if chunk.title and normalize_text(chunk.title) in rewritten_query:
                keyword_boost += 0.08
            final_score = round(dense_score * 0.55 + sparse_score * 0.45 + keyword_boost, 6)
            if final_score <= 0:
                continue
            hits.append(RetrievalHit(chunk=chunk, dense_score=dense_score, sparse_score=sparse_score, final_score=final_score))

        hits.sort(key=lambda item: item.final_score, reverse=True)
        hits = self.reranker.rerank(query, hits[: max(self.settings.retrieval_top_k * 3, self.settings.retrieval_top_k)])
        return RetrievalResult(
            normalized_query=normalized_query,
            rewritten_query=rewritten_query,
            intent="study",
            hits=hits[: self.settings.retrieval_top_k],
            used_space_materials=bool(hits),
        )

    def format_context(self, result: RetrievalResult) -> str:
        return "\n\n".join(
            f"title: {hit.chunk.title}\nlocator: {hit.chunk.locator}\ncontent: {hit.chunk.content[:320]}"
            for hit in result.hits
        )

    def _build_chunks(self, *, space_id: str, material: Material, text: str) -> list[Chunk]:
        payloads = self._build_chunk_payloads(material=material, text=text)
        if not payloads:
            return []
        dense_vectors, provenance = self._embed_chunk_payloads(
            space_id=space_id,
            payloads=payloads,
        )
        now = datetime.now(timezone.utc)
        chunks: list[Chunk] = []
        for payload, dense_vector in zip(payloads, dense_vectors, strict=True):
            metadata = dict(payload["metadata"])
            metadata.update(provenance)
            chunks.append(
                Chunk(
                    id=str(uuid4()),
                    space_id=space_id,
                    material_id=material.id,
                    title=material.title,
                    locator=str(payload["locator"]),
                    content=str(payload["content"]),
                    sparse_terms=list(payload["sparse_terms"]),
                    dense_vector=dense_vector,
                    metadata=metadata,
                    created_at=now,
                )
            )
        return chunks

    def _build_chunk_payloads(self, *, material: Material, text: str) -> list[dict[str, Any]]:
        sections = [block.strip() for block in HEADING_PATTERN.split(text) if block.strip()] or _paragraph_chunks(text)
        section_name = material.title
        payloads: list[dict[str, Any]] = []
        for block in sections:
            lines = [line.strip() for line in block.splitlines() if line.strip()]
            if not lines:
                continue
            if HEADING_PATTERN.match(lines[0]):
                section_name = re.sub(r"^#+\s*", "", lines[0])
            for index, paragraph in enumerate(_paragraph_chunks(block), start=1):
                content = paragraph[:1400]
                payloads.append(
                    {
                        "locator": f"{section_name} #{index}",
                        "content": content,
                        "sparse_terms": list(dict.fromkeys(extract_terms(paragraph)))[:120],
                        "metadata": {"section": section_name, "kind": material.kind.value},
                    }
                )
        return payloads

    def _embed_chunk_payloads(
        self,
        *,
        space_id: str,
        payloads: list[dict[str, Any]],
    ) -> tuple[list[dict[str, float] | list[float]], dict[str, str]]:
        assignment = next(
            (
                item
                for item in self.repository.list_model_assignments(space_id)
                if item.capability is ProviderCapability.embedding
            ),
            None,
        )
        if assignment is None:
            return (
                [self.embedding_provider.embed(str(payload["content"])) for payload in payloads],
                {
                    "embedding_source": "local",
                    "embedding_connection_id": "",
                    "embedding_model": "",
                    "embedding_provider": "local",
                },
            )
        if self.provider_registry is None:
            raise ProviderConfigurationError(
                provider="embedding",
                public_detail="Embedding provider registry is not available.",
            )
        resolved = self.provider_registry.resolve(
            space_id=space_id,
            capability=ProviderCapability.embedding,
        )
        vectors = asyncio.run(
            resolved.adapter.embed(
                model=assignment.model_name,
                texts=[str(payload["content"]) for payload in payloads],
            )
        )
        if len(vectors) != len(payloads):
            raise ProviderProtocolError(
                provider=resolved.connection.provider,
                public_detail="Provider returned an invalid embeddings response.",
            )
        return (
            vectors,
            {
                "embedding_source": "provider",
                "embedding_connection_id": resolved.connection.id,
                "embedding_model": assignment.model_name,
                "embedding_provider": resolved.connection.provider,
            },
        )

    def _ensure_chunk_embedding_provenance(
        self,
        *,
        chunks: list[Chunk],
        resolved: ResolvedProvider,
    ) -> None:
        expected_connection_id = resolved.connection.id
        expected_model = resolved.assignment.model_name
        mismatched = [
            chunk.id
            for chunk in chunks
            if chunk.metadata.get("embedding_source") != "provider"
            or chunk.metadata.get("embedding_connection_id") != expected_connection_id
            or chunk.metadata.get("embedding_model") != expected_model
        ]
        if mismatched:
            raise ProviderConfigurationError(
                provider=resolved.connection.provider,
                public_detail=(
                    "Stored material embeddings do not match the configured embedding model. "
                    "Retry ingestion for this study space."
                ),
            )

    def _ensure_chunks_match_current_embedding_assignment(
        self,
        *,
        space_id: str,
        chunks: list[Chunk],
    ) -> None:
        assignment = next(
            (
                item
                for item in self.repository.list_model_assignments(space_id)
                if item.capability is ProviderCapability.embedding
            ),
            None,
        )
        if assignment is None:
            self._ensure_local_chunk_embedding_provenance(chunks)
            return
        if self.provider_registry is None:
            raise ProviderConfigurationError(
                provider="embedding",
                public_detail="Embedding provider registry is not available.",
            )
        resolved = self.provider_registry.resolve(
            space_id=space_id,
            capability=ProviderCapability.embedding,
        )
        self._ensure_chunk_embedding_provenance(
            chunks=chunks,
            resolved=resolved,
        )

    @staticmethod
    def _ensure_local_chunk_embedding_provenance(chunks: list[Chunk]) -> None:
        if any(
            chunk.metadata.get("embedding_source") not in {None, "local"}
            for chunk in chunks
        ):
            raise ProviderConfigurationError(
                provider="embedding",
                public_detail=(
                    "Stored material embeddings do not match local retrieval. "
                    "Retry ingestion for this study space."
                ),
            )

    def _space_dir(self, space_id: str) -> Path:
        return self._contained_child(self.settings.spaces_root, space_id)

    def _material_dir(self, space_id: str) -> Path:
        return self._contained_child(self._space_dir(space_id), "materials")

    @staticmethod
    def _contained_child(root: Path, relative_path: str) -> Path:
        if Path(relative_path).is_absolute():
            raise ValueError("Storage path must be relative")
        resolved_root = root.resolve()
        raw_candidate = resolved_root / relative_path
        cursor = resolved_root
        for part in Path(relative_path).parts:
            cursor /= part
            if cursor.is_symlink():
                raise ValueError("Storage path contains a symbolic link")
        candidate = raw_candidate.resolve()
        if not candidate.is_relative_to(resolved_root):
            raise ValueError("Storage path escapes its configured root")
        return candidate

    def _infer_kind(self, filename: str) -> MaterialKind:
        suffix = Path(filename).suffix.lower()
        if suffix == ".pdf":
            return MaterialKind.pdf
        if suffix == ".md":
            return MaterialKind.markdown
        return MaterialKind.text

    def _validate_upload(self, *, filename: str, data: bytes) -> None:
        if (
            not filename
            or len(filename) > 255
            or "\x00" in filename
            or any(ord(character) < 32 or ord(character) == 127 for character in filename)
            or "/" in filename
            or "\\" in filename
            or Path(filename).name != filename
        ):
            raise ValueError("Material filename must be a safe base name")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED_MATERIAL_SUFFIXES:
            raise ValueError("Only PDF, Markdown, and TXT materials are supported in v0.1")
        if len(data) > self.settings.max_document_size_bytes:
            raise ValueError("Document exceeds 50 MiB limit")
        if not data:
            raise ValueError("Material file is empty")
        if suffix == ".pdf":
            self._validate_pdf_upload(data)
            return
        self._validate_text_upload(data)

    def _validate_pdf_upload(self, data: bytes) -> None:
        if not data.startswith(b"%PDF-"):
            raise ValueError("PDF signature does not match the file extension")
        try:
            reader = PdfReader(BytesIO(data), strict=False)
            if reader.is_encrypted:
                raise ValueError("Encrypted PDFs are not supported")
            page_count = len(reader.pages)
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("PDF file is damaged or unsupported") from exc
        if page_count > self.settings.max_pdf_pages:
            raise ValueError(f"PDF exceeds {self.settings.max_pdf_pages} page limit")

    @staticmethod
    def _validate_text_upload(data: bytes) -> None:
        executable_signatures = (
            b"#!",
            b"MZ",
            b"\x7fELF",
            b"\xca\xfe\xba\xbe",
            b"\xce\xfa\xed\xfe",
            b"\xcf\xfa\xed\xfe",
            b"\xfe\xed\xfa\xce",
            b"\xfe\xed\xfa\xcf",
            b"PK\x03\x04",
        )
        if data.startswith(executable_signatures):
            raise ValueError("Executable or archive content is not allowed")
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("Text material must be valid UTF-8") from exc
        if "\x00" in text:
            raise ValueError("Text material contains binary data")
        control_count = sum(
            1
            for character in text
            if ord(character) < 32 and character not in {"\n", "\r", "\t"}
        )
        if control_count > max(2, len(text) // 100):
            raise ValueError("Text material contains binary data")
        if not text.strip():
            raise ValueError("Text material is empty")

    @staticmethod
    def _rewrite_query(query: str) -> str:
        return query

    @staticmethod
    def _sparse_score(query_terms: set[str], chunk_terms: list[str]) -> float:
        if not query_terms or not chunk_terms:
            return 0.0
        overlap = query_terms.intersection(chunk_terms)
        if not overlap:
            return 0.0
        return round(len(overlap) / max(len(query_terms), 1), 6)
