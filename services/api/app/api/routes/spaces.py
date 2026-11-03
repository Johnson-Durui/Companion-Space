from __future__ import annotations

from dataclasses import asdict
from urllib.parse import unquote

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_owner,
)
from app.models.api_v1 import (
    LegacyKnowledgeImportRequest,
    MaterialIngestionResponse,
    MaterialNoteRequest,
    MaterialResponse,
    ModelAssignmentRequest,
    SpaceDetailResponse,
    StudySpaceCreateRequest,
    StudySpaceDefaultCharacterRequest,
    StudySpaceUpdateRequest,
)
from app.models.domain import (
    ModelAssignment,
    ProviderCapability,
    StudySpace,
)
from app.api.routes._shared import _read_limited_body

router = APIRouter()


@router.get("/spaces")
def list_spaces(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.spaces.list_spaces()


@router.post("/spaces", status_code=status.HTTP_201_CREATED)
def create_space(
    payload: StudySpaceCreateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    space = container.spaces.create_space(
        name=payload.name,
        topic=payload.topic,
        goal=payload.goal,
    )
    container.metrics.record_event_safe(
        "space_created",
        {"space_id": space.id},
        once=True,
    )
    return space


@router.get("/spaces/{space_id}", response_model=SpaceDetailResponse)
def get_space_detail(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SpaceDetailResponse:
    return SpaceDetailResponse.model_validate(
        container.spaces.get_space_detail(space_id)
    )


@router.put("/spaces/{space_id}")
def update_space(
    space_id: str,
    payload: StudySpaceUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.spaces.update_space(
        space_id,
        name=payload.name,
        topic=payload.topic,
        goal=payload.goal,
    )


@router.put("/spaces/{space_id}/default-character", response_model=StudySpace)
def update_space_default_character(
    space_id: str,
    payload: StudySpaceDefaultCharacterRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> StudySpace:
    return container.spaces.set_default_character(
        space_id,
        character_pack_id=payload.character_pack_id,
    )


@router.delete("/spaces/{space_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_space(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.spaces.delete_space(space_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/spaces/{space_id}/materials", response_model=list[MaterialResponse])
def list_materials(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.spaces.list_materials(space_id)


@router.get("/spaces/{space_id}/ingestion-jobs")
def list_ingestion_jobs(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.spaces.list_ingestion_jobs(space_id)


@router.post(
    "/spaces/{space_id}/materials/upload",
    response_model=MaterialIngestionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_material(
    space_id: str,
    request: Request,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MaterialIngestionResponse:
    data = await _read_limited_body(
        request,
        max_bytes=container.settings.max_document_size_bytes,
    )
    filename = unquote(request.headers.get("x-filename", "material.txt"))
    title_header = request.headers.get("x-title")
    title = unquote(title_header) if title_header else None
    material, job = container.spaces.ingest_bytes(
        space_id=space_id, filename=filename, data=data, title=title
    )
    return MaterialIngestionResponse(material=material, job=job)


@router.post(
    "/spaces/{space_id}/materials/note",
    response_model=MaterialIngestionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_note_material(
    space_id: str,
    payload: MaterialNoteRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MaterialIngestionResponse:
    material, job = container.spaces.ingest_note(
        space_id=space_id, title=payload.title, content=payload.content
    )
    return MaterialIngestionResponse(material=material, job=job)


@router.post(
    "/spaces/{space_id}/materials/{material_id}/retry",
    response_model=MaterialIngestionResponse,
    status_code=status.HTTP_201_CREATED,
)
def retry_material_ingestion(
    space_id: str,
    material_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MaterialIngestionResponse:
    material, job = container.spaces.retry_material(
        space_id=space_id,
        material_id=material_id,
    )
    return MaterialIngestionResponse(material=material, job=job)


@router.delete(
    "/spaces/{space_id}/materials/{material_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_material(
    space_id: str,
    material_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.spaces.delete_material(space_id=space_id, material_id=material_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/spaces/{space_id}/assignments")
def list_assignments(
    space_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.repository.list_model_assignments(space_id)


@router.post("/spaces/{space_id}/assignments", status_code=status.HTTP_201_CREATED)
def save_assignment(
    space_id: str,
    payload: ModelAssignmentRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ModelAssignment:
    if payload.capability is not ProviderCapability.embedding:
        return container.providers.save_assignment(
            space_id=space_id,
            capability=payload.capability,
            provider_connection_id=payload.provider_connection_id,
            model_name=payload.model_name,
        )
    with container.spaces.embedding_assignment_change():
        previous = next(
            (
                assignment
                for assignment in container.repository.list_model_assignments(space_id)
                if assignment.capability is payload.capability
            ),
            None,
        )
        saved = container.providers.save_assignment(
            space_id=space_id,
            capability=payload.capability,
            provider_connection_id=payload.provider_connection_id,
            model_name=payload.model_name,
        )
        if (
            previous is None
            or previous.provider_connection_id != saved.provider_connection_id
            or previous.model_name != saved.model_name
        ):
            container.spaces.mark_materials_for_embedding_reindex(space_id)
        return saved


@router.delete(
    "/spaces/{space_id}/assignments/{capability}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_assignment(
    space_id: str,
    capability: ProviderCapability,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    if capability is ProviderCapability.embedding:
        with container.spaces.embedding_assignment_change():
            deleted = container.providers.delete_assignment(
                space_id=space_id,
                capability=capability,
            )
            if deleted:
                container.spaces.mark_materials_for_embedding_reindex(space_id)
    else:
        deleted = container.providers.delete_assignment(
            space_id=space_id,
            capability=capability,
        )
    if not deleted:
        raise HTTPException(status_code=404, detail="Model assignment not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/legacy-knowledge-base")
def list_legacy_knowledge(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return {
        "items": [
            asdict(candidate)
            for candidate in container.legacy_importer.list_candidates()
        ]
    }


@router.post(
    "/spaces/{space_id}/legacy-knowledge-base/import",
    status_code=status.HTTP_201_CREATED,
)
def import_legacy_knowledge(
    space_id: str,
    payload: LegacyKnowledgeImportRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return asdict(
        container.legacy_importer.import_document(
            space_id=space_id,
            document_id=payload.document_id,
        )
    )
