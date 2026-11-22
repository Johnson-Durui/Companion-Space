from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import FileResponse, Response
from pydantic import TypeAdapter, ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.analysis.documents import validate_upload
from app.analysis.models import (
    Course, CourseInput, CourseMap, CourseMaterial, ExamItem, KnowledgePoint, MaterialMetadata,
    NoteInput, PageData, PointUpdate, RequestModel,
)
from app.analysis.results import CourseResults
from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.job_events import job_progress_response
from app.learning.journey import CourseJourney, load_course_journeys
from app.services.jobs import Job, latest_analysis_job

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]
PageNumber = Annotated[int, Path(ge=1)]
_METADATA = TypeAdapter(list[MaterialMetadata])
_LARGE_ANALYSIS = 300_000


class StartAnalysis(RequestModel):
    confirmed: bool = False
    estimate_only: bool = False
    refresh: bool = False


class RetryAnalysis(RequestModel):
    stage: str


class AnalysisStart(RequestModel):
    estimated_tokens: int
    requires_confirmation: bool
    job: Job | None


class TodayLesson(RequestModel):
    id: str
    title: str
    est_minutes: int
    status: str
    kind: str = "lesson"
    lesson_id: str | None = None


class PlanWhyEntry(RequestModel):
    kp_id: str
    kp_name: str = ""
    weight: float = 0.0
    mastery: float = 0.0
    highlighted: bool = False
    is_prereq: bool = False


class CourseDashboard(RequestModel):
    course_id: str
    has_plan: bool = False
    due_review_count: int
    today_lesson: TodayLesson | None = None
    today_practice: TodayLesson | None = None
    today_lesson_why: list[PlanWhyEntry] = []
    lesson_index: int | None = None
    lesson_total: int | None = None
    remaining_days: int | None = None
    exam_name: str | None = None
    exam_date: str | None = None
    target_score: float | None = None
    secured_score: float | None = None
    score_scale: float | None = None
    journey: CourseJourney | None = None


def public_job(job: Job | None) -> Job | None:
    return job.model_copy(update={"payload": {}}) if job else None


@router.get("/courses")
def list_courses(container: Container) -> list[Course]:
    return container.analysis.data.courses()


@router.get("/courses/{course_id}/journey")
def course_journey(course_id: str, container: Container) -> CourseJourney:
    container.analysis.data.course(course_id)
    journeys = load_course_journeys(container.repository, [course_id])
    return journeys[course_id]


@router.get("/courses/dashboard")
def course_dashboard(container: Container) -> list[CourseDashboard]:
    today = date.today()
    now = datetime.now(timezone.utc).isoformat()
    with container.repository.connection() as conn:
        course_ids = [row["id"] for row in conn.execute("SELECT id FROM study_spaces")]
        planned = {
            row["space_id"]
            for row in conn.execute(
                """SELECT DISTINCT s.space_id FROM study_plans s
                   JOIN plan_items p ON p.plan_id = s.id AND p.space_id = s.space_id
                   WHERE s.status='active'""",
            )
        }
        lessons = {}
        lesson_why_raw: dict[str, str] = {}
        for row in conn.execute(
            """WITH eligible AS (
                 SELECT p.space_id, p.id, p.title, p.est_minutes, p.status, p.kind, p.lesson_id, p.ord, p.why_text,
                        ROW_NUMBER() OVER (
                          PARTITION BY p.space_id
                          ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
                                   COALESCE(p.scheduled_date, ''), p.ord, p.id
                        ) AS choice
                 FROM plan_items p JOIN study_plans s ON s.id=p.plan_id AND s.space_id=p.space_id
                 WHERE s.status='active' AND p.kind='lesson'
                   AND (p.status='active' OR (p.status='todo' AND p.scheduled_date<=?))
               ) SELECT space_id,id,title,est_minutes,status,kind,lesson_id,why_text FROM eligible WHERE choice=1""",
            (today.isoformat(),),
        ):
            lesson = dict(row)
            sid = lesson.pop("space_id")
            lesson_why_raw[sid] = lesson.pop("why_text") or "[]"
            lessons[sid] = lesson
        practices = {}
        for row in conn.execute(
            """WITH eligible AS (
                 SELECT p.space_id, p.id, p.title, p.est_minutes, p.status, p.kind, p.lesson_id, p.ord,
                        ROW_NUMBER() OVER (
                          PARTITION BY p.space_id
                          ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
                                   COALESCE(p.scheduled_date, ''), p.ord, p.id
                        ) AS choice
                 FROM plan_items p JOIN study_plans s ON s.id=p.plan_id AND s.space_id=p.space_id
                 WHERE s.status='active' AND p.kind!='lesson'
                   AND (p.status='active' OR (p.status='todo' AND p.scheduled_date<=?))
               ) SELECT space_id,id,title,est_minutes,status,kind,lesson_id FROM eligible WHERE choice=1""",
            (today.isoformat(),),
        ):
            practice = dict(row)
            practices[practice.pop("space_id")] = practice
        lesson_positions: dict[str, tuple[dict[str, int], int]] = {}
        for row in conn.execute(
            """SELECT p.space_id, p.id
               FROM plan_items p JOIN study_plans s ON s.id=p.plan_id AND s.space_id=p.space_id
               WHERE s.status='active' AND p.kind='lesson'
               ORDER BY p.space_id, p.ord, p.id""",
        ):
            pos_map, total = lesson_positions.get(row["space_id"], ({}, 0))
            total += 1
            pos_map[row["id"]] = total
            lesson_positions[row["space_id"]] = (pos_map, total)
        kp_names = {
            (row["space_id"], row["id"]): row["name"]
            for row in conn.execute("SELECT space_id, id, name FROM knowledge_points WHERE status='active'")
        }
        prereq_set = {
            (row["space_id"], row["from_kp"])
            for row in conn.execute("SELECT DISTINCT space_id, from_kp FROM kp_edges")
        }
        highlighted_by_space = {
            row["space_id"]: set(json.loads(row["params_json"] or "{}").get("highlighted_kp_ids", []))
            for row in conn.execute("SELECT space_id, params_json FROM study_plans WHERE status='active'")
        }
        reviews = {row["space_id"]: row["n"] for row in conn.execute(
            """SELECT space_id, COUNT(*) AS n FROM review_cards
               WHERE state!='archived' AND COALESCE(due_at, '')<=? GROUP BY space_id""",
            (now,),
        )}
        projections = {row["space_id"]: dict(row) for row in conn.execute(
            """SELECT k.space_id,
                      SUM(COALESCE(s.score_share,0)*COALESCE(m.p,0)) AS secured_ratio,
                      SUM(COALESCE(s.score_share,0)) AS score_share
               FROM knowledge_points k
               LEFT JOIN kp_exam_stats s ON s.space_id=k.space_id AND s.kp_id=k.id
               LEFT JOIN kp_mastery m ON m.space_id=k.space_id AND m.kp_id=k.id
               WHERE k.status='active' GROUP BY k.space_id""",
        )}
        enrollments = {row["space_id"]: json.loads(row["enrollment_json"] or "{}") for row in conn.execute(
            "SELECT space_id,enrollment_json FROM course_enrollment",
        )}

    journeys = load_course_journeys(container.repository, course_ids, today=today)
    result = []
    for course_id in course_ids:
        enrollment = enrollments.get(course_id, {})
        raw_exam_date = enrollment.get("exam_date")
        exam_date = date.fromisoformat(raw_exam_date) if raw_exam_date else None
        remaining_days = (exam_date - today).days if exam_date and exam_date >= today else None
        projection = projections.get(course_id)
        score_scale = float(enrollment.get("full_score", 100))
        has_score = bool(projection and projection["score_share"] > 0)
        lesson = lessons.get(course_id)
        practice = practices.get(course_id)
        pos_map, total_lessons = lesson_positions.get(course_id, ({}, 0))
        lesson_index = pos_map.get(lesson["id"]) if lesson else None
        highlighted_ids = highlighted_by_space.get(course_id, set())
        raw_why = json.loads(lesson_why_raw.get(course_id, "[]")) if lesson else []
        why_entries = [
            PlanWhyEntry(
                kp_id=str(entry.get("kp_id", "")),
                kp_name=kp_names.get((course_id, str(entry.get("kp_id", ""))), ""),
                weight=float(entry.get("weight", 0.0)),
                mastery=float(entry.get("mastery", 0.0)),
                highlighted=str(entry.get("kp_id", "")) in highlighted_ids,
                is_prereq=(course_id, str(entry.get("kp_id", ""))) in prereq_set,
            )
            for entry in raw_why
            if isinstance(entry, dict) and entry.get("kp_id")
        ]
        raw_target = enrollment.get("target_score")
        target_score = float(raw_target) if isinstance(raw_target, (int, float)) else None
        raw_exam_name = enrollment.get("exam_name")
        exam_name = str(raw_exam_name).strip() if isinstance(raw_exam_name, str) and raw_exam_name.strip() else None
        result.append(CourseDashboard(
            course_id=course_id,
            has_plan=course_id in planned,
            due_review_count=int(reviews.get(course_id, 0)),
            today_lesson=TodayLesson(**lesson) if lesson else None,
            today_practice=TodayLesson(**practice) if practice else None,
            today_lesson_why=why_entries,
            lesson_index=lesson_index,
            lesson_total=total_lessons if total_lessons > 0 else None,
            remaining_days=remaining_days,
            exam_name=exam_name,
            exam_date=raw_exam_date if isinstance(raw_exam_date, str) and raw_exam_date else None,
            target_score=target_score,
            secured_score=round(score_scale * projection["secured_ratio"], 1) if has_score else None,
            score_scale=round(score_scale, 1) if has_score else None,
            journey=journeys.get(course_id),
        ))
    return result


@router.post("/courses", status_code=201)
def create_course(payload: CourseInput, container: Container) -> Course:
    return container.analysis.data.create_course(payload)


@router.get("/courses/{course_id}")
def get_course(course_id: str, container: Container) -> Course:
    return container.analysis.data.course(course_id)


@router.get("/courses/{course_id}/materials")
def list_materials(course_id: str, container: Container) -> list[CourseMaterial]:
    return container.analysis.data.materials(course_id)


async def _ensure_editable(container: Container, course_id: str) -> None:
    job = await asyncio.to_thread(latest_analysis_job, container.repository, course_id)
    if job and job.status in {"queued", "running"}:
        raise HTTPException(409, detail={"code": "analysis_active", "message": "Analysis is already running."})


async def _read_uploads(request: Request, container: ServiceContainer):
    if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        raise HTTPException(
            415,
            detail={"code": "multipart_required", "message": "Use multipart/form-data to upload materials."},
        )
    file_limit = container.settings.max_document_size_bytes
    total_limit = file_limit * 2 + 64 * 1024
    too_large = False

    async def bounded_stream():
        size = 0
        nonlocal too_large
        async for chunk in request.stream():
            size += len(chunk)
            if size > total_limit:
                too_large = True
                raise MultiPartException("Upload batch exceeds the size limit.")
            yield chunk

    try:
        form = await MultiPartParser(
            request.headers, bounded_stream(), max_files=12, max_fields=1, max_part_size=32 * 1024,
        ).parse()
    except (MultiPartException, ValueError) as exc:
        raise HTTPException(
            413 if too_large else 400,
            detail={
                "code": "upload_too_large" if too_large else "upload_invalid",
                "message": "Upload exceeds limits or is malformed.",
            },
        ) from exc
    try:
        files = form.getlist("files")
        if not files or not all(isinstance(file, UploadFile) for file in files):
            raise HTTPException(
                400,
                detail={"code": "material_required", "message": "Select at least one material."},
            )
        raw = form.get("metadata")
        try:
            metadata = _METADATA.validate_json(raw) if isinstance(raw, str) else []
        except ValidationError:
            raise HTTPException(
                422,
                detail={"code": "material_metadata_invalid", "message": "Invalid material metadata."},
            ) from None
        if metadata and len(metadata) != len(files):
            raise HTTPException(
                422,
                detail={"code": "material_metadata_mismatch", "message": "Provide one metadata entry per file."},
            )
        uploads = []
        for index, file in enumerate(files):
            filename = file.filename or ""
            data = await file.read(file_limit + 1)
            if len(data) > file_limit:
                raise HTTPException(
                    413,
                    detail={"code": "material_too_large", "message": "The material exceeds the file size limit."},
                )
            sample, page_count = await asyncio.to_thread(
                validate_upload, filename, data, file_limit, container.settings.max_pdf_pages,
            )
            uploads.append((filename, data, metadata[index] if metadata else MaterialMetadata(), sample, page_count))
        return uploads
    finally:
        await form.close()


@router.post(
    "/courses/{course_id}/materials", status_code=201,
    openapi_extra={"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
        "type": "object", "required": ["files"], "properties": {
            "files": {"type": "array", "items": {"type": "string", "format": "binary"}},
            "metadata": {"type": "string", "description": "JSON array indexed by file order."},
        },
    }}}}},
)
async def upload_materials(course_id: str, request: Request, container: Container) -> list[CourseMaterial]:
    uploads = await _read_uploads(request, container)
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        return await asyncio.to_thread(container.analysis.data.store_uploads, course_id, uploads)


@router.post("/courses/{course_id}/materials/note", status_code=201)
async def paste_material(course_id: str, payload: NoteInput, container: Container) -> CourseMaterial:
    metadata = MaterialMetadata.model_validate(payload.model_dump(exclude={"title", "content"}))
    if metadata.role is None:
        metadata.role = "notes"
    data = payload.content.encode()
    if len(data) > container.settings.max_document_size_bytes:
        raise HTTPException(
            413,
            detail={"code": "material_too_large", "message": "The material exceeds the file size limit."},
        )
    pages = max(1, (len(payload.content) + 1599) // 1600)
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        records = await asyncio.to_thread(
            container.analysis.data.store_uploads, course_id,
            [("note.md", data, metadata, payload.content[:300], pages)], note_title=payload.title,
        )
    return records[0]


@router.patch("/courses/{course_id}/materials/{material_id}")
async def patch_material(
    course_id: str, material_id: str, payload: MaterialMetadata, container: Container,
) -> CourseMaterial:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        return await asyncio.to_thread(container.analysis.data.update_material, course_id, material_id, payload)


@router.put("/courses/{course_id}")
async def update_course(course_id: str, payload: CourseInput, container: Container) -> Course:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        return await asyncio.to_thread(container.analysis.data.update_course, course_id, payload)


@router.delete("/courses/{course_id}", status_code=204)
async def delete_course(course_id: str, container: Container) -> Response:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        await asyncio.to_thread(container.analysis.data.delete_course, course_id)
    return Response(status_code=204)


@router.delete("/courses/{course_id}/materials/{material_id}", status_code=204)
async def delete_material(course_id: str, material_id: str, container: Container) -> Response:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        await asyncio.to_thread(container.analysis.data.delete_material, course_id, material_id)
    return Response(status_code=204)


@router.post("/courses/{course_id}/analysis/start")
async def start_analysis(course_id: str, payload: StartAnalysis, container: Container) -> AnalysisStart:
    analysis = container.analysis
    async with analysis.mutation_lock:
        await asyncio.to_thread(analysis.data.course, course_id)
        materials = await asyncio.to_thread(analysis.data.material_rows, course_id)
        if not materials:
            raise HTTPException(
                400,
                detail={"code": "material_required", "message": "Import course material first."},
            )
        pages = sum(row.get("page_count") or row.get("estimated_pages") or 1 for row in materials)
        estimate = pages * 1800
        needs_confirmation = estimate > _LARGE_ANALYSIS and not payload.confirmed
        current = await asyncio.to_thread(latest_analysis_job, container.repository, course_id)
        job = current if current and current.status in {"queued", "running"} else None
        if not payload.estimate_only and not job and not needs_confirmation:
            job = await container.jobs.submit("parse", space_id=course_id, payload={"refresh": payload.refresh})
    return AnalysisStart(
        estimated_tokens=estimate, requires_confirmation=needs_confirmation, job=public_job(job),
    )


@router.get("/courses/{course_id}/analysis/status")
async def analysis_status(course_id: str, container: Container) -> Job | None:
    await asyncio.to_thread(container.analysis.data.course, course_id)
    job = await asyncio.to_thread(latest_analysis_job, container.repository, course_id)
    return public_job(job)


@router.post("/courses/{course_id}/analysis/retry")
async def retry_analysis(course_id: str, payload: RetryAnalysis, container: Container) -> Job:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        current = await asyncio.to_thread(latest_analysis_job, container.repository, course_id)
        job = await container.jobs.retry_analysis(current.id, course_id, payload.stage) if current else None
    if not job:
        raise HTTPException(
            409,
            detail={"code": "analysis_retry_unavailable", "message": "The requested stage is no longer eligible for retry."},
        )
    return public_job(job)


@router.get("/courses/{course_id}/analysis/events", responses={200: {"content": {"text/event-stream": {}}}})
async def analysis_events(course_id: str, container: Container):
    job = await analysis_status(course_id, container)
    if job is None:
        raise HTTPException(
            404,
            detail={"code": "analysis_not_started", "message": "Start analysis first."},
        )
    return await job_progress_response(container.repository, job.id, space_id=course_id)


@router.get("/courses/{course_id}/map")
def course_map(course_id: str, container: Container) -> CourseMap:
    return CourseResults(container.analysis.data).course_map(course_id)


@router.patch("/courses/{course_id}/kps/{kp_id}")
async def revise_point(
    course_id: str, kp_id: str, payload: PointUpdate, container: Container,
) -> KnowledgePoint:
    async with container.analysis.mutation_lock:
        await _ensure_editable(container, course_id)
        results = CourseResults(container.analysis.data)
        return await asyncio.to_thread(results.revise_point, course_id, kp_id, payload)


@router.get("/courses/{course_id}/exam-items")
def exam_items(
    course_id: str, container: Container, kp_id: str | None = None, unmapped: bool = False,
) -> list[ExamItem]:
    return CourseResults(container.analysis.data).exam_items(course_id, kp_id=kp_id, unmapped=unmapped)


@router.get("/materials/{material_id}/pages/{number}")
def page_details(material_id: str, number: PageNumber, container: Container) -> PageData:
    row = container.analysis.data.get_page(material_id, number)
    return PageData(**row, has_image=bool(row["image_path"]))


@router.get("/materials/{material_id}/pages/{number}/image", response_class=FileResponse)
def page_image(material_id: str, number: PageNumber, container: Container):
    data = container.analysis.data
    row = data.get_page(material_id, number)
    if not row["image_path"]:
        raise HTTPException(
            404,
            detail={"code": "page_image_unavailable", "message": "No original page image is available."},
        )
    image = data.safe_path(row["image_path"])
    if not image.is_relative_to(data.images_dir(row["space_id"], material_id)) or not image.is_file():
        raise HTTPException(
            404,
            detail={"code": "page_image_unavailable", "message": "No original page image is available."},
        )
    return FileResponse(image, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
