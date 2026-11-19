from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import FileResponse

from app.api.deps import ServiceContainer, get_container, require_owner
from app.api.routes._shared import _read_limited_body
from app.core.errors import ResourceNotFoundError
from app.services.tutor_catalog import Character, TutorUpdate
from app.services.tutorpack import ARCHIVE_SUFFIXES, IMAGE_SUFFIXES, MAX_ARCHIVE_BYTES, MAX_IMAGE_BYTES

router = APIRouter(prefix="/characters", dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


@router.post("/import", response_model=Character, status_code=201)
async def import_tutor(
    request: Request, container: Container, x_filename: Annotated[str, Header(max_length=1200)],
) -> Character:
    filename = unquote(x_filename)
    suffix = Path(filename).suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        limit = min(MAX_IMAGE_BYTES, container.settings.max_character_pack_size_bytes)
    elif suffix in ARCHIVE_SUFFIXES:
        limit = min(MAX_ARCHIVE_BYTES, container.settings.max_character_pack_size_bytes)
    else:
        raise ValueError("Choose a .tutorpack, .zip, .png, .jpg, or .webp file.")
    data = await _read_limited_body(request, max_bytes=limit)
    return await asyncio.to_thread(container.tutors.import_upload, filename, data)


@router.put("/{character_id}", response_model=Character)
async def update_tutor(character_id: str, payload: TutorUpdate, container: Container) -> Character:
    character = await asyncio.to_thread(container.tutors.update_character, character_id, payload)
    if character is None:
        raise ResourceNotFoundError("Teacher is unavailable.")
    return character


@router.delete("/{character_id}", status_code=204)
async def delete_tutor(character_id: str, container: Container) -> Response:
    deleted = await asyncio.to_thread(container.tutors.delete_character, character_id)
    if not deleted:
        raise ResourceNotFoundError("Teacher is unavailable.")
    return Response(status_code=204)


@router.get("/{character_id}/assets/{asset_path:path}", include_in_schema=False)
async def tutor_asset(character_id: str, asset_path: str, container: Container) -> FileResponse:
    found = await asyncio.to_thread(container.tutors.asset_file, character_id, asset_path)
    if found is None:
        raise ResourceNotFoundError("The character asset is unavailable.")
    file, media_type = found
    return FileResponse(
        file,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
    )
