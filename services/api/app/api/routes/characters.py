from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote

from fastapi import (
    APIRouter,
    Depends,
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
    CharacterCreateRequest,
    CharacterDuplicateRequest,
    CharacterListResponse,
    CharacterUpdateRequest,
    CharacterVoicePreviewRequest,
)
from app.models.domain import (
    ProviderCapability,
)
from app.providers.errors import (
    ProviderProtocolError,
)
from app.services.characters import CHARACTER_CARD_MAX_BYTES
from app.services.realtime import (
    TTS_CONTENT_TYPE,
    TTS_SAMPLE_RATE_HZ,
)
from app.api.routes._shared import _read_limited_body

router = APIRouter()

CHARACTER_VOICE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024


@router.get("/characters", response_model=CharacterListResponse)
def list_characters(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> CharacterListResponse:
    return CharacterListResponse(items=container.characters.list_characters())


@router.post("/characters", status_code=status.HTTP_201_CREATED)
def create_character(
    payload: CharacterCreateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    character = container.characters.create_character(
        name=payload.name,
        description=payload.description,
        recipe=payload.recipe,
    )
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.post("/characters/import", status_code=status.HTTP_201_CREATED)
async def import_character(
    request: Request,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    filename = unquote(request.headers.get("x-filename", "character-pack.zip"))
    max_bytes = container.settings.max_character_pack_size_bytes
    if Path(filename).suffix.lower() == ".json":
        max_bytes = min(max_bytes, CHARACTER_CARD_MAX_BYTES)
    data = await _read_limited_body(
        request,
        max_bytes=max_bytes,
    )
    character = container.characters.import_character_upload(
        filename=filename,
        data=data,
    )
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.get("/characters/{character_id}")
def get_character(
    character_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.characters.require_character(character_id)


@router.put("/characters/{character_id}/avatar")
async def replace_character_avatar(
    character_id: str,
    request: Request,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    encoded_filename = request.headers.get("x-filename")
    if not encoded_filename:
        raise ValueError("X-Filename header is required for avatar replacement")
    filename = unquote(encoded_filename)
    data = await _read_limited_body(
        request,
        max_bytes=container.settings.max_character_pack_size_bytes,
    )
    character = container.characters.replace_character_avatar(
        character_id,
        filename=filename,
        data=data,
    )
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.delete("/characters/{character_id}/avatar")
def remove_character_avatar(
    character_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    character = container.characters.remove_character_avatar(character_id)
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.put("/characters/{character_id}/motions/{state}")
async def put_character_motion(
    character_id: str,
    state: str,
    request: Request,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    encoded_filename = request.headers.get("x-filename")
    if not encoded_filename:
        raise ValueError("X-Filename header is required for managed motion upload")
    data = await _read_limited_body(
        request,
        max_bytes=container.settings.max_character_pack_size_bytes,
    )
    return container.characters.put_managed_motion(
        character_id,
        state,
        filename=unquote(encoded_filename),
        data=data,
    )


@router.delete("/characters/{character_id}/motions/{state}")
def delete_character_motion(
    character_id: str,
    state: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return container.characters.delete_managed_motion(character_id, state)


@router.put("/characters/{character_id}")
def update_character(
    character_id: str,
    payload: CharacterUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    character = container.characters.update_character(
        character_id,
        name=payload.name,
        description=payload.description,
        recipe=payload.recipe,
    )
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.post(
    "/characters/{character_id}/duplicate",
    status_code=status.HTTP_201_CREATED,
)
def duplicate_character(
    character_id: str,
    payload: CharacterDuplicateRequest | None = None,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    character = container.characters.duplicate_character(
        character_id,
        name=payload.name if payload else None,
    )
    container.metrics.record_event_safe(
        "character_saved",
        {"character_id": character.id},
        once=True,
    )
    return character


@router.post("/characters/{character_id}/voice-preview")
async def preview_character_voice(
    character_id: str,
    payload: CharacterVoicePreviewRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    character = container.characters.require_character(character_id)
    container.characters.ensure_relationship_allowed(character.recipe)
    resolved = container.providers.resolve(
        space_id=payload.space_id,
        capability=ProviderCapability.tts,
    )
    audio = bytearray()
    async for chunk in resolved.adapter.synthesize_speech_stream(
        model=resolved.assignment.model_name,
        text=payload.text,
        voice_id=payload.voice_id or character.recipe.voice_id,
        speed=(
            payload.speaking_rate
            if payload.speaking_rate is not None
            else character.recipe.speaking_rate
        ),
        sample_rate_hz=TTS_SAMPLE_RATE_HZ,
    ):
        if len(audio) + len(chunk) > CHARACTER_VOICE_PREVIEW_MAX_BYTES:
            raise ValueError("Voice preview exceeds the configured size limit")
        audio.extend(chunk)
    if not audio:
        raise ProviderProtocolError(
            provider=resolved.connection.provider,
            public_detail="The TTS provider returned an empty voice preview.",
        )
    return Response(
        content=bytes(audio),
        media_type=TTS_CONTENT_TYPE,
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Channels": "1",
            "X-Audio-Sample-Rate": str(TTS_SAMPLE_RATE_HZ),
        },
    )


@router.get("/characters/{character_id}/export")
def export_character(
    character_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    archive = container.characters.export_character_pack(character_id)
    return Response(
        content=archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="character-pack-{character_id}.zip"'
            )
        },
    )


@router.get("/characters/{character_id}/assets/{asset_path:path}")
def get_character_asset(
    character_id: str,
    asset_path: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    content, media_type = container.characters.read_character_asset(
        character_id, asset_path
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={"Cache-Control": "private, no-store"},
    )


@router.delete("/characters/{character_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_character(
    character_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.characters.delete_character(character_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
