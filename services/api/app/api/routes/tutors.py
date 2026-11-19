from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import FileResponse

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.routes._shared import _read_limited_body
from app.core.errors import ResourceNotFoundError
from app.services.tutor_catalog import Character, TutorUpdate

router = APIRouter(prefix="/characters", dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


@router.post("/import", response_model=Character, status_code=201)
async def import_tutor(
    request: Request, container: Container, x_filename: Annotated[str, Header(max_length=1200)],
) -> Character:
    filename = unquote(x_filename)
    if Path(filename).suffix.lower() != ".vrm":
        raise ValueError("Choose a .vrm file.")
    data = await _read_limited_body(request, max_bytes=container.settings.max_character_pack_size_bytes)
    return await asyncio.to_thread(container.tutors.import_model, filename, data)


@router.put("/{character_id}", response_model=Character)
def update_tutor(character_id: str, payload: TutorUpdate, container: Container) -> Character:
    character = container.tutors.update_character(character_id, payload)
    if character is None:
        raise ResourceNotFoundError("Teacher is unavailable.")
    return character


@router.get("/{character_id}/model", include_in_schema=False)
def tutor_model(character_id: str, container: Container) -> FileResponse:
    file = container.tutors.model_file(character_id)
    if file is None:
        raise ResourceNotFoundError("The imported model is unavailable.")
    return FileResponse(file, media_type="model/gltf-binary", headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})
