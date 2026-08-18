from __future__ import annotations

import asyncio
import json
import re
from contextlib import suppress
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote, urlsplit

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_local_owner,
    require_owner,
)
from app.models.api_v1 import (
    CharacterCreateRequest,
    CharacterDuplicateRequest,
    CharacterListResponse,
    CharacterUpdateRequest,
    CharacterVoicePreviewRequest,
    LegacyKnowledgeImportRequest,
    LocalMetricSignalRequest,
    MaterialIngestionResponse,
    MaterialNoteRequest,
    MaterialResponse,
    MemoryListResponse,
    MemoryUpdateRequest,
    ModelAssignmentRequest,
    OwnerPreferencesResponse,
    OwnerPreferencesUpdateRequest,
    ProviderConnectionCreateRequest,
    ProviderConnectionUpdateRequest,
    RealtimeTicketResponse,
    ReviewListResponse,
    ReviewUpdateRequest,
    SessionCreateRequest,
    SessionDemoRequest,
    SessionDemoResponse,
    SessionRecapUpdateRequest,
    SessionSummaryRequest,
    SessionTranscriptResponse,
    SessionTurnRequest,
    SpaceDetailResponse,
    StudySpaceCreateRequest,
    StudySpaceDefaultCharacterRequest,
    StudySpaceUpdateRequest,
    NeuralTtsSidecarStatusResponse,
    VaultPasswordPayload,
    VaultStatusResponse,
    VaultUnlockResponse,
)
from app.models.domain import (
    MemoryItem,
    MemoryStatus,
    ModelAssignment,
    ProviderCapability,
    ReviewItem,
    SessionRecord,
    SessionState,
    StudySpace,
    TrustedDevice,
    TtsPlaybackPolicy,
)
from app.providers.errors import (
    ProviderError,
    ProviderProtocolError,
    ProviderTimeoutError,
    provider_error_code,
    provider_error_payload,
)
from app.services.characters import CHARACTER_CARD_MAX_BYTES
from app.services.companion import (
    CharacterNotFoundError,
    CompanionStreamEvent,
    SessionNotFoundError,
)
from app.providers.local_neural_tts import LOCAL_NEURAL_TTS_MODEL
from app.services.provider_registry import (
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_NEURAL_TTS_CONNECTION_ID,
    UNSET,
    ResolvedProvider,
)
from app.services.realtime import (
    PCM16_SAMPLE_RATE_HZ,
    TTS_CONTENT_TYPE,
    TTS_SAMPLE_RATE_HZ,
    RealtimeConnectionState,
)
from app.services.vault import InvalidDeviceRefreshTokenError, PairingChallengeError

router = APIRouter(prefix="/api/v1", tags=["v1"])

REALTIME_PROTOCOL = "companion-v1"
REALTIME_TICKET_PREFIX = "ticket."
CHARACTER_VOICE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024
DEMO_REQUEST_PATTERN = re.compile(r"(演示一下|演示下|demo)", re.IGNORECASE)
DEMO_TOPIC_PREFIX_PATTERN = re.compile(
    r"^\s*(请|麻烦|帮我)?\s*(演示一下|演示下|demo)\s*[:：,， ]*\s*",
    re.IGNORECASE,
)

MobileDeviceName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=80),
]


class PairingChallengeResponse(BaseModel):
    challenge_id: str
    code: str
    expires_at: datetime
    attempts_allowed: int


class PairDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    challenge_id: str | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(pattern=r"^\d{8}$")
    device_name: MobileDeviceName


class DeviceRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=32, max_length=256)


class MobileDeviceResponse(BaseModel):
    id: str
    name: str
    refresh_expires_at: datetime
    created_at: datetime
    last_seen_at: datetime

    @classmethod
    def from_record(cls, device: TrustedDevice) -> "MobileDeviceResponse":
        return cls(
            id=device.id,
            name=device.name,
            refresh_expires_at=device.refresh_expires_at,
            created_at=device.created_at,
            last_seen_at=device.last_seen_at,
        )


class MobileAuthResponse(BaseModel):
    device: MobileDeviceResponse
    refresh_token: str
    access_token: str
    access_token_expires_at: datetime
    token_type: str = "bearer"


class VaultPasswordRotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=8, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


async def _read_limited_body(request: Request, *, max_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_size = int(content_length)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length header") from exc
        if declared_size < 0:
            raise ValueError("Invalid Content-Length header")
        if declared_size > max_bytes:
            raise ValueError("Document exceeds 50 MiB limit")

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > max_bytes:
            raise ValueError("Document exceeds 50 MiB limit")
        body.extend(chunk)
    return bytes(body)


def _origin_allowed(origin: str | None, websocket: WebSocket, container: ServiceContainer) -> bool:
    if not origin:
        return False
    candidate = origin.strip().lower()
    if candidate in container.settings.websocket_allowed_origins:
        return True
    parsed = urlsplit(candidate)
    host = websocket.headers.get("host", "").strip().lower()
    if not parsed.scheme or not parsed.netloc or not host:
        return False
    if parsed.netloc != host:
        return False
    return parsed.scheme in {"http", "https"}


def _extract_realtime_ticket(protocol_header: str | None) -> str | None:
    if not protocol_header:
        return None
    protocols = [item.strip() for item in protocol_header.split(",") if item.strip()]
    if REALTIME_PROTOCOL not in protocols:
        return None
    ticket_protocol = next((item for item in protocols if item.startswith(REALTIME_TICKET_PREFIX)), None)
    if ticket_protocol is None:
        return None
    ticket = ticket_protocol[len(REALTIME_TICKET_PREFIX) :].strip()
    return ticket or None


def _is_demo_request(text: str) -> bool:
    return bool(DEMO_REQUEST_PATTERN.search(text))


def _derive_demo_topic(
    *,
    text: str,
    user_history: list[str],
    fallback_topic: str,
) -> str:
    stripped = DEMO_TOPIC_PREFIX_PATTERN.sub("", text).strip("：:，, 。.!?？")
    if stripped:
        return stripped
    for item in reversed(user_history):
        candidate = item.strip()
        if candidate and candidate != text.strip():
            return candidate[:240]
    fallback = fallback_topic.strip()
    return (fallback or "当前学习主题")[:240]


def _serialize_companion_event(
    session_id: str,
    event: CompanionStreamEvent,
) -> dict:
    payload: dict
    if event.type == "llm.delta":
        payload = {"text": event.text}
    elif event.turn is not None:
        payload = event.turn.model_dump(mode="json")
    elif event.payload is not None:
        payload = event.payload
    else:
        payload = {}
    return {
        "type": event.type,
        "session_id": session_id,
        "state": event.state.value,
        "payload": payload,
    }


def _serialize_provider_error_event(
    session_id: str,
    error: ProviderError,
) -> dict:
    payload = provider_error_payload(error)
    payload["message"] = payload["detail"]
    return _realtime_event(
        session_id,
        event_type="error",
        state=SessionState.error,
        payload=payload,
    )


def _realtime_event(
    session_id: str,
    *,
    event_type: str,
    state: SessionState,
    payload: dict,
) -> dict:
    return {
        "type": event_type,
        "session_id": session_id,
        "state": state.value,
        "payload": payload,
    }


def _error_event(session_id: str, *, detail: str) -> dict:
    return _realtime_event(
        session_id,
        event_type="error",
        state=SessionState.error,
        payload={
            "message": detail,
            "detail": detail,
            "code": "realtime_protocol_error",
        },
    )


def _parse_realtime_client_event(raw_text: str, *, session_id: str) -> dict:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid realtime JSON payload.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Realtime payload must be a JSON object.")
    payload_session_id = payload.get("session_id")
    if payload_session_id is not None and payload_session_id != session_id:
        raise ValueError("Realtime payload session_id mismatch.")
    return payload


def _resolve_realtime_audio_assignments(
    *,
    container: ServiceContainer,
    session: SessionRecord,
) -> tuple[ResolvedProvider, ResolvedProvider, TtsPlaybackPolicy]:
    stt_resolved = container.providers.resolve(
        space_id=session.space_id,
        capability=ProviderCapability.stt,
    )
    if (
        session.tts_connection_id is not None
        and session.tts_model_name is not None
        and session.tts_playback_policy is not None
    ):
        tts_resolved = container.providers.resolve_pinned(
            space_id=session.space_id,
            capability=ProviderCapability.tts,
            connection_id=session.tts_connection_id,
            model_name=session.tts_model_name,
        )
        tts_playback_policy = session.tts_playback_policy
    else:
        tts_resolved = container.providers.resolve(
            space_id=session.space_id,
            capability=ProviderCapability.tts,
        )
        tts_playback_policy = (
            "browser-compat"
            if tts_resolved.connection.id == BUILTIN_MOCK_CONNECTION_ID
            else "server-neural"
            if tts_resolved.connection.id == BUILTIN_NEURAL_TTS_CONNECTION_ID
            else "server"
        )
    return stt_resolved, tts_resolved, tts_playback_policy


@router.get("/tts/sidecar", response_model=NeuralTtsSidecarStatusResponse)
async def tts_sidecar_status(
    container: ServiceContainer = Depends(get_container),
) -> NeuralTtsSidecarStatusResponse:
    enabled = container.repository.settings.builtin_neural_tts_enabled
    ready = False
    if enabled:
        try:
            ready = await container.providers.probe_builtin_neural_tts_ready()
        except ProviderError:
            ready = False
    return NeuralTtsSidecarStatusResponse(
        enabled=enabled,
        ready=ready,
        connection_id=BUILTIN_NEURAL_TTS_CONNECTION_ID,
        model=LOCAL_NEURAL_TTS_MODEL if ready else None,
        new_spaces_use_neural=container.providers.is_builtin_neural_tts_ready,
        how_to_switch=(
            "解锁后打开空间 → 默认模型分配 → TTS 选 Built-in Neural TTS，"
            "模型填 qwen3-tts-0.6b-customvoice。"
            "sidecar ready 时，新空间会自动走这条连接；已有 Mock 空间不会被改写。"
        ),
    )


@router.get("/vault/status", response_model=VaultStatusResponse)
def vault_status(container: ServiceContainer = Depends(get_container)) -> VaultStatusResponse:
    status_payload = container.vault.status()
    return VaultStatusResponse(initialized=status_payload.initialized, unlocked=status_payload.unlocked)


@router.post("/vault/init", response_model=VaultUnlockResponse)
def vault_init(payload: VaultPasswordPayload, container: ServiceContainer = Depends(get_container)) -> VaultUnlockResponse:
    container.vault.initialize(payload.password)
    token = container.vault.issue_owner_token()
    container.metrics.record_event_safe("vault_initialized", {}, once=True)
    return VaultUnlockResponse(initialized=True, unlocked=True, owner_token=token)


@router.post("/vault/unlock", response_model=VaultUnlockResponse)
def vault_unlock(payload: VaultPasswordPayload, container: ServiceContainer = Depends(get_container)) -> VaultUnlockResponse:
    container.vault.unlock(payload.password)
    token = container.vault.issue_owner_token()
    return VaultUnlockResponse(initialized=True, unlocked=True, owner_token=token)


@router.post("/vault/lock", response_model=VaultStatusResponse)
def vault_lock(_: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> VaultStatusResponse:
    container.vault.lock()
    return VaultStatusResponse(initialized=container.vault.status().initialized, unlocked=False)


@router.post("/vault/reset", response_model=VaultStatusResponse)
def vault_reset(
    payload: VaultPasswordPayload,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultStatusResponse:
    container.vault.reset(payload.password)
    return VaultStatusResponse(initialized=False, unlocked=False)


@router.post("/vault/password", response_model=VaultUnlockResponse)
def rotate_vault_password(
    payload: VaultPasswordRotationRequest,
    _: str = Depends(require_local_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultUnlockResponse:
    container.vault.rotate_password(payload.current_password, payload.new_password)
    owner_token = container.vault.issue_owner_token()
    return VaultUnlockResponse(initialized=True, unlocked=True, owner_token=owner_token)


@router.post(
    "/mobile/pairing-challenges",
    response_model=PairingChallengeResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_mobile_pairing_challenge(
    _: str = Depends(require_local_owner),
    container: ServiceContainer = Depends(get_container),
) -> PairingChallengeResponse:
    code, challenge = container.vault.create_pairing_challenge()
    return PairingChallengeResponse(
        challenge_id=challenge.id,
        code=code,
        expires_at=challenge.expires_at,
        attempts_allowed=container.vault.PAIRING_MAX_ATTEMPTS,
    )


@router.post("/mobile/pairing/exchange", response_model=MobileAuthResponse)
def exchange_mobile_pairing_challenge(
    payload: PairDeviceRequest,
    container: ServiceContainer = Depends(get_container),
) -> MobileAuthResponse:
    try:
        device, refresh_token, access_token, access_expires_at = container.vault.pair_device(
            challenge_id=payload.challenge_id,
            code=payload.code,
            name=payload.device_name,
        )
    except PairingChallengeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired pairing challenge",
        ) from exc
    return MobileAuthResponse(
        device=MobileDeviceResponse.from_record(device),
        refresh_token=refresh_token,
        access_token=access_token,
        access_token_expires_at=access_expires_at,
    )


@router.post("/mobile/auth/refresh", response_model=MobileAuthResponse)
def refresh_mobile_access(
    payload: DeviceRefreshRequest,
    container: ServiceContainer = Depends(get_container),
) -> MobileAuthResponse:
    try:
        device, refresh_token, access_token, access_expires_at = container.vault.refresh_device_access(
            payload.refresh_token
        )
    except InvalidDeviceRefreshTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid device refresh token",
        ) from exc
    return MobileAuthResponse(
        device=MobileDeviceResponse.from_record(device),
        refresh_token=refresh_token,
        access_token=access_token,
        access_token_expires_at=access_expires_at,
    )


@router.get("/mobile/devices", response_model=list[MobileDeviceResponse])
def list_mobile_devices(
    _: str = Depends(require_local_owner),
    container: ServiceContainer = Depends(get_container),
) -> list[MobileDeviceResponse]:
    return [
        MobileDeviceResponse.from_record(device)
        for device in container.vault.list_trusted_devices()
    ]


@router.delete("/mobile/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_mobile_device(
    device_id: str,
    _: str = Depends(require_local_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    if not container.vault.revoke_trusted_device(device_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trusted device not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/vault/preferences", response_model=OwnerPreferencesResponse)
def get_vault_preferences(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> OwnerPreferencesResponse:
    preferences = container.vault.get_owner_preferences()
    return OwnerPreferencesResponse(
        adult_relationships_enabled=(
            preferences.adult_relationships_enabled
        ),
        adult_age_confirmed_at=preferences.adult_age_confirmed_at,
    )


@router.put("/vault/preferences", response_model=OwnerPreferencesResponse)
def update_vault_preferences(
    payload: OwnerPreferencesUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> OwnerPreferencesResponse:
    preferences = container.vault.update_adult_relationship_preferences(
        enabled=payload.adult_relationships_enabled,
        confirm_age_18_or_older=payload.confirm_age_18_or_older,
    )
    return OwnerPreferencesResponse(
        adult_relationships_enabled=(
            preferences.adult_relationships_enabled
        ),
        adult_age_confirmed_at=preferences.adult_age_confirmed_at,
    )


@router.get("/providers/registry")
def provider_registry(_: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> list[dict]:
    return container.providers.list_registry()


@router.get("/providers/connections")
def provider_connections(_: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> list[dict]:
    return container.providers.list_connections()


@router.post("/providers/connections", status_code=status.HTTP_201_CREATED)
def create_provider_connection(
    payload: ProviderConnectionCreateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    connection = container.providers.save_connection(
        provider=payload.provider,
        label=payload.label,
        api_key=payload.api_key,
        base_url=payload.base_url,
    )
    return connection


@router.get("/providers/connections/{connection_id}")
def get_provider_connection(
    connection_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return container.providers.get_connection(connection_id)


@router.patch("/providers/connections/{connection_id}")
def update_provider_connection(
    connection_id: str,
    payload: ProviderConnectionUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    base_url = payload.base_url if "base_url" in payload.model_fields_set else UNSET
    return container.providers.update_connection(
        connection_id,
        label=payload.label,
        base_url=base_url,
        api_key=payload.api_key,
    )


@router.get("/providers/connections/{connection_id}/models")
async def discover_provider_models(
    connection_id: str,
    capability: ProviderCapability | None = None,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return {
        "models": await container.providers.discover_models(
            connection_id,
            capability,
        )
    }


@router.post("/providers/connections/{connection_id}/test")
async def test_provider_connection(
    connection_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    result = await container.providers.test_connection(connection_id)
    container.metrics.record_event_safe(
        "provider_connected_or_mock",
        {"provider_kind": str(result["provider"])},
        once=True,
    )
    return result


@router.delete("/providers/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider_connection(
    connection_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.providers.delete_connection(connection_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/spaces")
def list_spaces(_: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)):
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
    return SpaceDetailResponse.model_validate(container.spaces.get_space_detail(space_id))


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
def list_materials(space_id: str, _: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)):
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
    material, job = container.spaces.ingest_bytes(space_id=space_id, filename=filename, data=data, title=title)
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
    material, job = container.spaces.ingest_note(space_id=space_id, title=payload.title, content=payload.content)
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
def list_assignments(space_id: str, _: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)):
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
                for assignment in container.repository.list_model_assignments(
                    space_id
                )
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


@router.get("/characters", response_model=CharacterListResponse)
def list_characters(_: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> CharacterListResponse:
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
    content, media_type = container.characters.read_character_asset(character_id, asset_path)
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


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    session = container.companion.create_session(
        space_id=payload.space_id,
        character_pack_id=payload.character_pack_id,
    )
    container.metrics.record_event_safe(
        "session_started",
        {"space_id": session.space_id, "session_id": session.id},
        once=True,
    )
    return session


@router.get("/spaces/{space_id}/sessions")
def list_sessions(space_id: str, _: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)):
    return container.companion.list_sessions(space_id)


@router.get("/sessions/{session_id}", response_model=SessionTranscriptResponse)
def get_session_transcript(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.get_session(session_id)
    turns = container.repository.list_turns(session_id)
    if session.ended_at is not None:
        container.metrics.record_event_safe(
            "recap_viewed",
            {"space_id": session.space_id, "session_id": session.id},
            once=True,
        )
    return SessionTranscriptResponse(
        session=session,
        turns=turns,
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )


@router.post("/sessions/{session_id}/realtime-ticket", response_model=RealtimeTicketResponse)
def issue_realtime_ticket(
    session_id: str,
    owner_token: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> RealtimeTicketResponse:
    try:
        session = container.companion.get_session(session_id)
    except SessionNotFoundError as error:
        raise HTTPException(status_code=404, detail="Session not found") from error
    try:
        container.companion.get_session_character(session_id)
    except CharacterNotFoundError as error:
        raise HTTPException(
            status_code=409,
            detail="Session character is unavailable",
        ) from error
    try:
        _resolve_realtime_audio_assignments(
            container=container,
            session=session,
        )
    except (ProviderError, ValueError):
        container.metrics.record_event_safe(
            "text_fallback_used",
            {
                "session_id": session_id,
                "code": "missing_realtime_audio",
            },
        )
        raise
    ticket, expires_at = container.vault.issue_realtime_ticket(owner_token, session_id=session_id)
    return RealtimeTicketResponse(ticket=ticket, expires_at=expires_at)


@router.post("/sessions/{session_id}/turns")
async def create_turn(
    session_id: str,
    payload: SessionTurnRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    return await container.companion.submit_text_turn(session_id=session_id, text=payload.text)


@router.post("/sessions/{session_id}/demos", response_model=SessionDemoResponse)
async def create_demo(
    session_id: str,
    payload: SessionDemoRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionDemoResponse:
    demo = await container.demos.create_demo(
        session_id=session_id,
        topic=payload.topic,
    )
    return SessionDemoResponse.model_validate(demo)


@router.post("/sessions/{session_id}/turns/stream")
async def stream_turn(
    session_id: str,
    payload: SessionTurnRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> StreamingResponse:
    stream = container.companion.stream_text_turn(
        session_id=session_id,
        text=payload.text,
    )
    try:
        first_event = await stream.__anext__()
    except StopAsyncIteration as exc:
        raise ProviderProtocolError(
            provider="companion",
            public_detail="The provider stream ended without a reply.",
        ) from exc

    async def event_lines():
        yield (
            json.dumps(
                _serialize_companion_event(session_id, first_event),
                ensure_ascii=False,
            )
            + "\n"
        )
        try:
            async for event in stream:
                yield (
                    json.dumps(
                        _serialize_companion_event(session_id, event),
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except ProviderError as error:
            yield (
                json.dumps(
                    _serialize_provider_error_event(session_id, error),
                    ensure_ascii=False,
                )
                + "\n"
            )

    return StreamingResponse(
        event_lines(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/sessions/{session_id}/end")
async def end_session(
    session_id: str,
    payload: SessionSummaryRequest | None = None,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
):
    session = container.companion.end_session(
        session_id,
        summary=payload.summary if payload else "",
    )
    container.companion.schedule_learning_artifacts(
        session_id=session_id,
        include_candidates=True,
    )
    duration_ms = 0
    if session.ended_at is not None:
        duration_ms = max(
            int((session.ended_at - session.created_at).total_seconds() * 1000),
            0,
        )
    container.metrics.record_event_safe(
        "session_ended",
        {
            "space_id": session.space_id,
            "session_id": session.id,
            "duration_ms": duration_ms,
        },
        once=True,
    )
    return session


@router.put("/sessions/{session_id}/recap", response_model=SessionTranscriptResponse)
def update_session_recap(
    session_id: str,
    payload: SessionRecapUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.update_session_recap(
        session_id=session_id,
        summary=payload.summary,
        notes=payload.notes,
    )
    container.metrics.record_event_safe(
        "recap_edited",
        {"session_id": session.id},
        once=True,
    )
    return SessionTranscriptResponse(
        session=session,
        turns=container.repository.list_turns(session_id),
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )


@router.post("/sessions/{session_id}/recap/undo", response_model=SessionTranscriptResponse)
def undo_session_recap(
    session_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> SessionTranscriptResponse:
    session = container.companion.undo_session_recap(session_id)
    return SessionTranscriptResponse(
        session=session,
        turns=container.repository.list_turns(session_id),
        memory_candidates=container.repository.list_session_memory_items(session_id),
        review_items=container.repository.list_session_review_items(session_id),
    )


@router.get("/memory/{space_id}", response_model=MemoryListResponse)
def list_memory(space_id: str, _: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> MemoryListResponse:
    return MemoryListResponse(items=container.repository.list_memory_items(space_id))


@router.put("/memory/{space_id}/{memory_id}")
def update_memory(
    space_id: str,
    memory_id: str,
    payload: MemoryUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MemoryItem:
    existing = next((item for item in container.repository.list_memory_items(space_id) if item.id == memory_id), None)
    if existing is None:
        raise HTTPException(status_code=404, detail="Memory item not found")
    next_status = MemoryStatus(payload.status)
    if (
        existing.sensitive
        and existing.status is MemoryStatus.candidate
        and next_status is MemoryStatus.confirmed
    ):
        raise HTTPException(
            status_code=409,
            detail="Sensitive memory candidates require the explicit confirm action",
        )
    item = existing.model_copy(
        update={
            "content": payload.content,
            "status": next_status,
            "sensitive": payload.sensitive,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    saved = container.repository.upsert_memory_item(item)
    if next_status is MemoryStatus.confirmed:
        container.metrics.record_event_safe(
            "memory_candidate_confirmed",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    elif next_status is MemoryStatus.discarded:
        container.metrics.record_event_safe(
            "memory_candidate_rejected",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    return saved


@router.post("/memory/{space_id}/{memory_id}/confirm")
def confirm_memory(
    space_id: str,
    memory_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> MemoryItem:
    existing = next(
        (
            item
            for item in container.repository.list_memory_items(space_id)
            if item.id == memory_id
        ),
        None,
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Memory item not found")
    confirmed = existing.model_copy(
        update={
            "status": MemoryStatus.confirmed,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    saved = container.repository.upsert_memory_item(confirmed)
    container.metrics.record_event_safe(
        "memory_candidate_confirmed",
        {"space_id": space_id, "memory_id": memory_id},
        once=True,
    )
    return saved


@router.delete(
    "/memory/{space_id}/{memory_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_memory(
    space_id: str,
    memory_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    existing = next(
        (
            item
            for item in container.repository.list_memory_items(space_id)
            if item.id == memory_id
        ),
        None,
    )
    if not container.repository.delete_memory_item(
        space_id=space_id,
        memory_id=memory_id,
    ):
        raise HTTPException(status_code=404, detail="Memory item not found")
    if existing is not None and existing.status is MemoryStatus.candidate:
        container.metrics.record_event_safe(
            "memory_candidate_rejected",
            {"space_id": space_id, "memory_id": memory_id},
            once=True,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/review-items/{space_id}", response_model=ReviewListResponse)
def list_review(space_id: str, _: str = Depends(require_owner), container: ServiceContainer = Depends(get_container)) -> ReviewListResponse:
    return ReviewListResponse(items=container.repository.list_review_items(space_id))


@router.put("/review-items/{space_id}/{review_id}")
def update_review(
    space_id: str,
    review_id: str,
    payload: ReviewUpdateRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> ReviewItem:
    existing = next((item for item in container.repository.list_review_items(space_id) if item.id == review_id), None)
    if existing is None:
        raise HTTPException(status_code=404, detail="Review item not found")
    changes: dict[str, object] = {
        "updated_at": datetime.now(timezone.utc),
    }
    if payload.prompt is not None:
        changes["prompt"] = payload.prompt
    if payload.answer is not None:
        changes["answer"] = payload.answer
    if "due_at" in payload.model_fields_set:
        changes["due_at"] = payload.due_at
    if payload.status is not None:
        changes["status"] = payload.status
    item = existing.model_copy(update=changes)
    saved = container.repository.upsert_review_item(item)
    container.metrics.record_event_safe(
        "review_item_updated",
        {"space_id": space_id, "review_id": review_id},
    )
    return saved


@router.get("/metrics/local/summary")
def get_local_metrics_summary(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return container.metrics.summary()


@router.get("/metrics/local/events")
def get_local_metric_events(
    limit: int = 100,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> dict:
    return container.metrics.list_events(limit=limit)


@router.post(
    "/metrics/local/signals",
    status_code=status.HTTP_204_NO_CONTENT,
)
def record_local_metric_signal(
    payload: LocalMetricSignalRequest,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    try:
        container.companion.get_session(payload.session_id)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        ) from error

    numeric_events = {
        "interrupt_latency_ms",
        "first_audio_latency_ms",
        "avatar_fps",
        "soak_memory_delta_mb",
    }
    if payload.event in numeric_events:
        if (
            payload.value is None
            or payload.residue_found is not None
            or payload.code is not None
        ):
            raise ValueError(
                "This local metric signal requires only a numeric value"
            )
        event_payload: dict[str, object] = {
            "session_id": payload.session_id,
            "value": payload.value,
        }
    elif payload.event == "audio_residue_scan":
        if (
            payload.residue_found is None
            or payload.value is not None
            or payload.code is not None
        ):
            raise ValueError(
                "The audio residue signal requires only residue_found"
            )
        event_payload = {
            "session_id": payload.session_id,
            "residue_found": payload.residue_found,
        }
    elif payload.event == "text_fallback_used":
        if (
            payload.code is None
            or payload.value is not None
            or payload.residue_found is not None
        ):
            raise ValueError(
                "The text fallback signal requires only a reason code"
            )
        event_payload = {
            "session_id": payload.session_id,
            "code": payload.code,
        }
    else:
        raise ValueError("Unsupported local metric client signal")
    container.metrics.record_event(payload.event, event_payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/review-items/{space_id}/{review_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_review(
    space_id: str,
    review_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    if not container.repository.delete_review_item(
        space_id=space_id,
        review_id=review_id,
    ):
        raise HTTPException(status_code=404, detail="Review item not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.websocket("/sessions/{session_id}/realtime")
async def realtime_session(websocket: WebSocket, session_id: str) -> None:
    container = get_container()
    container.metrics.record_event_safe(
        "ws_attempt",
        {"session_id": session_id},
    )
    if websocket.query_params.get("token") or websocket.query_params.get("owner_token"):
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "query_token_rejected"},
        )
        await websocket.close(code=4401, reason="Owner session required")
        return
    if not _origin_allowed(websocket.headers.get("origin"), websocket, container):
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "origin_rejected"},
        )
        await websocket.close(code=4403, reason="Origin not allowed")
        return
    ticket = _extract_realtime_ticket(websocket.headers.get("sec-websocket-protocol"))
    owner_session_id = container.vault.consume_realtime_ticket(ticket or "", session_id=session_id) if ticket else None
    if owner_session_id is None:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "owner_session_required"},
        )
        await websocket.close(code=4401, reason="Owner session required")
        return

    try:
        session = container.companion.get_session(session_id)
        container.companion.get_session_character(session_id)
        (
            stt_resolved,
            tts_resolved,
            tts_playback_policy,
        ) = _resolve_realtime_audio_assignments(
            container=container,
            session=session,
        )
    except SessionNotFoundError:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "session_not_found"},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(code=4404, reason="Session not found")
        return
    except CharacterNotFoundError:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": "session_character_unavailable"},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(code=4409, reason="Session character is unavailable")
        return
    except ProviderError as error:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": provider_error_code(error)},
        )
        await websocket.accept(subprotocol=REALTIME_PROTOCOL)
        await websocket.close(code=1011, reason="Realtime audio provider is unavailable")
        return

    await websocket.accept(subprotocol=REALTIME_PROTOCOL)
    container.metrics.record_event_safe(
        "ws_connection",
        {"session_id": session_id},
    )
    runtime = RealtimeConnectionState()
    cleanup_tasks: set[asyncio.Task[object]] = set()

    def record_ws_error(code: str) -> None:
        container.metrics.record_event_safe(
            "ws_error",
            {"session_id": session_id, "code": code},
        )

    def track_turn_cleanup(task: asyncio.Task[object]) -> None:
        cleanup_tasks.add(task)

        def observe(completed: asyncio.Task[object]) -> None:
            cleanup_tasks.discard(completed)
            if completed.cancelled():
                return
            if completed.exception() is not None:
                record_ws_error("turn_cleanup_failed")

        task.add_done_callback(observe)

    def transition_state(
        target: SessionState,
        *,
        code: str,
    ) -> SessionState:
        try:
            return container.companion.set_state(
                session_id,
                target,
                reason_code=code,
            ).state
        except ValueError:
            return container.companion.get_session(session_id).state

    def record_provider_failure(
        error: ProviderError,
        *,
        capability: ProviderCapability,
    ) -> None:
        code = provider_error_code(error)
        record_ws_error(code)
        if isinstance(error, ProviderTimeoutError):
            container.metrics.record_event_safe(
                "model_timeout",
                {
                    "capability": capability.value,
                    "provider_kind": error.provider,
                    "code": code,
                },
            )

    async def send_json_event(event: dict, *, generation: int | None = None) -> bool:
        if generation is not None and not runtime.is_generation_current(generation):
            return False
        async with runtime.send_lock:
            if generation is not None and not runtime.is_generation_current(generation):
                return False
            if not container.vault.validate_owner_session(owner_session_id):
                with suppress(RuntimeError):
                    await websocket.close(code=4401, reason="Owner session required")
                return False
            await websocket.send_json(event)
        return True

    async def send_audio_bytes(chunk: bytes, *, generation: int) -> bool:
        if not chunk or not runtime.is_generation_current(generation):
            return False
        async with runtime.send_lock:
            if not runtime.is_generation_current(generation):
                return False
            if not container.vault.validate_owner_session(owner_session_id):
                with suppress(RuntimeError):
                    await websocket.close(code=4401, reason="Owner session required")
                return False
            await websocket.send_bytes(chunk)
        return True

    async def run_turn(
        *,
        generation: int,
        resolved_text: str,
    ) -> None:
        try:
            turn = None
            async for event in container.companion.stream_text_turn(
                session_id=session_id,
                text=resolved_text,
                defer_speaking=True,
            ):
                if not await send_json_event(
                    _serialize_companion_event(session_id, event),
                    generation=generation,
                ):
                    return
                if event.turn is not None:
                    turn = event.turn

            if turn is None:
                raise ProviderProtocolError(
                    provider="companion",
                    public_detail="The provider stream ended without a final reply.",
                )

            if not runtime.is_generation_current(generation):
                return

            if tts_playback_policy == "browser-compat":
                transition_state(SessionState.idle, code="tts_browser_compat")
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="tts.chunk",
                        state=SessionState.idle,
                        payload={
                            "final": True,
                            "sequence": 0,
                            "audio_bytes": 0,
                        },
                    ),
                    generation=generation,
                )
                return

            character = container.companion.get_session_character(session_id)
            total_audio_bytes = 0
            sequence = 0
            started_speaking = False
            speech_kwargs = {
                "model": tts_resolved.assignment.model_name,
                "text": turn.spoken_text,
                "voice_id": character.recipe.voice_id,
                "speed": character.recipe.speaking_rate,
                "sample_rate_hz": TTS_SAMPLE_RATE_HZ,
            }
            if getattr(tts_resolved.adapter, "supports_companion_emotion", False):
                speech_kwargs["emotion"] = turn.emotion
            async for chunk in tts_resolved.adapter.synthesize_speech_stream(**speech_kwargs):
                if not chunk:
                    continue
                if not started_speaking:
                    transition_state(
                        SessionState.speaking,
                        code="tts_started",
                    )
                    started_speaking = True
                if not await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="tts.chunk",
                        state=SessionState.speaking,
                        payload={
                            "final": False,
                            "sequence": sequence,
                            "byte_length": len(chunk),
                            "content_type": TTS_CONTENT_TYPE,
                            "sample_rate_hz": TTS_SAMPLE_RATE_HZ,
                            "preview_text": turn.spoken_text,
                        },
                    ),
                    generation=generation,
                ):
                    return
                if not await send_audio_bytes(chunk, generation=generation):
                    return
                total_audio_bytes += len(chunk)
                sequence += 1

            if not runtime.is_generation_current(generation):
                return
            transition_state(SessionState.idle, code="tts_completed")
            await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="tts.chunk",
                    state=SessionState.idle,
                    payload={
                        "final": True,
                        "sequence": sequence,
                        "audio_bytes": total_audio_bytes,
                    },
                ),
                generation=generation,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.tts,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="tts_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )

    async def run_demo(
        *,
        generation: int,
        topic: str,
    ) -> None:
        try:
            transition_state(SessionState.thinking, code="demo_started")
            demo = await container.demos.create_demo(
                session_id=session_id,
                topic=topic,
            )
            if not runtime.is_generation_current(generation):
                return
            transition_state(SessionState.idle, code="demo_completed")
            await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="demo.ready",
                    state=SessionState.idle,
                    payload=demo,
                ),
                generation=generation,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.analysis_llm,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="demo_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )

    async def run_commit(
        *,
        generation: int,
        committed_text: str,
        committed_audio: bytes,
    ) -> None:
        try:
            resolved_text = committed_text
            if not resolved_text and committed_audio:
                resolved_text = (
                    await stt_resolved.adapter.transcribe_pcm16(
                        model=stt_resolved.assignment.model_name,
                        pcm16=committed_audio,
                        sample_rate_hz=PCM16_SAMPLE_RATE_HZ,
                    )
                ).strip()
            if not resolved_text:
                resolved_text = "继续陪我学习。"

            if not await send_json_event(
                _realtime_event(
                    session_id,
                    event_type="asr.final",
                    state=SessionState.thinking,
                    payload={
                        "text": resolved_text,
                        "audio_bytes": len(committed_audio),
                    },
                ),
                generation=generation,
            ):
                return

            if _is_demo_request(resolved_text):
                space = container.spaces.require_space(session.space_id)
                await run_demo(
                    generation=generation,
                    topic=_derive_demo_topic(
                        text=resolved_text,
                        user_history=[
                            turn.display_text
                            for turn in container.repository.list_turns(session_id)
                            if turn.role.value == "user"
                        ],
                        fallback_topic=space.topic or space.goal,
                    ),
                )
                return

            await run_turn(
                generation=generation,
                resolved_text=resolved_text,
            )
        except asyncio.CancelledError:
            raise
        except ProviderError as error:
            record_provider_failure(
                error,
                capability=ProviderCapability.stt,
            )
            if runtime.is_generation_current(generation):
                transition_state(
                    SessionState.error,
                    code="commit_provider_error",
                )
                await send_json_event(
                    _serialize_provider_error_event(session_id, error),
                    generation=generation,
                )
        except SessionNotFoundError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("session_not_found")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=4404,
                            reason="Session not found",
                        )
        except CharacterNotFoundError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("session_character_unavailable")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=4409,
                            reason="Session character is unavailable",
                        )
        except ValueError:
            if not runtime.is_generation_current(generation):
                return
            record_ws_error("invalid_session_state")
            async with runtime.send_lock:
                if runtime.is_generation_current(generation):
                    with suppress(RuntimeError):
                        await websocket.close(
                            code=1011,
                            reason="Realtime session state is invalid",
                        )
        finally:
            runtime.finish_turn(generation)

    await send_json_event(
        _realtime_event(
            session_id,
            event_type="session.open",
            state=SessionState.idle,
            payload={
                "tts_playback_policy": tts_playback_policy,
                "tts_connection_id": tts_resolved.connection.id,
                "tts_model": tts_resolved.assignment.model_name,
            },
        )
    )
    try:
        while True:
            if not container.vault.validate_owner_session(owner_session_id):
                await websocket.close(code=4401, reason="Owner session required")
                break
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if not container.vault.validate_owner_session(owner_session_id):
                await websocket.close(code=4401, reason="Owner session required")
                break
            if message.get("bytes") is not None:
                try:
                    buffered_audio_bytes = runtime.append_audio_frame(message["bytes"])
                except ValueError as error:
                    record_ws_error("invalid_audio_frame")
                    transition_state(
                        SessionState.error,
                        code="invalid_audio_frame",
                    )
                    await send_json_event(
                        _error_event(session_id, detail=str(error))
                    )
                    continue
                if runtime.has_active_turn():
                    partial_state = container.companion.get_session(session_id).state
                    if partial_state not in {
                        SessionState.thinking,
                        SessionState.speaking,
                    }:
                        partial_state = SessionState.thinking
                else:
                    partial_state = SessionState.listening
                    transition_state(
                        SessionState.listening,
                        code="audio_frame_received",
                    )
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="asr.partial",
                        state=partial_state,
                        payload={"buffered_audio_bytes": buffered_audio_bytes},
                    )
                )
                continue

            if message.get("text") is None:
                continue
            try:
                payload = _parse_realtime_client_event(
                    message["text"],
                    session_id=session_id,
                )
            except ValueError as error:
                record_ws_error("invalid_event_payload")
                transition_state(
                    SessionState.error,
                    code="invalid_event_payload",
                )
                await send_json_event(
                    _error_event(session_id, detail=str(error))
                )
                continue
            event_type = payload.get("type")
            if not isinstance(event_type, str) or not event_type:
                record_ws_error("missing_event_type")
                transition_state(
                    SessionState.error,
                    code="missing_event_type",
                )
                await send_json_event(
                    _error_event(session_id, detail="Realtime event type is required.")
                )
                continue
            event_payload = payload.get("payload", {})
            if event_payload is None:
                event_payload = {}
            if not isinstance(event_payload, dict):
                record_ws_error("invalid_event_body")
                transition_state(
                    SessionState.error,
                    code="invalid_event_body",
                )
                await send_json_event(
                    _error_event(session_id, detail="Realtime payload.payload must be an object.")
                )
                continue
            if event_type == "heartbeat":
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="heartbeat",
                        state=container.companion.get_session(session_id).state,
                        payload={},
                    )
                )
                continue
            if event_type == "turn.interrupt":
                if event_payload.get("clear_audio_buffer") is True:
                    runtime.clear_audio_buffer()
                pending_task = runtime.interrupt_active_turn()
                if pending_task is None:
                    current_state = container.companion.get_session(session_id).state
                    if current_state == SessionState.listening:
                        current_state = transition_state(
                            SessionState.idle,
                            code="audio_buffer_cleared",
                        )
                    await send_json_event(
                        _realtime_event(
                            session_id,
                            event_type="turn.interrupted",
                            state=current_state,
                            payload={"active": False},
                        )
                    )
                    continue
                transition_state(
                    SessionState.interrupted,
                    code="turn_interrupted",
                )
                track_turn_cleanup(pending_task)
                await send_json_event(
                    _realtime_event(
                        session_id,
                        event_type="turn.interrupted",
                        state=SessionState.interrupted,
                        payload={"active": True},
                    )
                )
                continue
            if event_type != "user.commit":
                record_ws_error("unsupported_event")
                transition_state(
                    SessionState.error,
                    code="unsupported_event",
                )
                await send_json_event(
                    _error_event(session_id, detail="Unsupported realtime event.")
                )
                continue

            current_session_state = container.companion.get_session(session_id).state
            if runtime.has_active_turn() or current_session_state in {
                SessionState.thinking,
                SessionState.speaking,
            }:
                record_ws_error("active_turn_conflict")
                container.companion.record_illegal_state_transition(
                    session_id,
                    SessionState.thinking,
                    reason_code="active_turn_conflict",
                )
                transition_state(
                    SessionState.error,
                    code="active_turn_conflict_error",
                )
                await send_json_event(
                    _error_event(session_id, detail="Realtime session already has an active turn.")
                )
                continue
            text_payload = event_payload.get("text")
            committed_text = text_payload.strip() if isinstance(text_payload, str) else ""
            committed_audio = runtime.consume_audio_buffer()
            generation = runtime.reserve_generation()
            task = asyncio.create_task(
                run_commit(
                    generation=generation,
                    committed_text=committed_text,
                    committed_audio=committed_audio,
                )
            )
            runtime.bind_turn(generation=generation, task=task)
    except WebSocketDisconnect:
        return
    except SessionNotFoundError:
        record_ws_error("session_not_found")
        with suppress(RuntimeError):
            await websocket.close(code=4404, reason="Session not found")
        return
    except CharacterNotFoundError:
        record_ws_error("session_character_unavailable")
        with suppress(RuntimeError):
            await websocket.close(code=4409, reason="Session character is unavailable")
        return
    except RuntimeError:
        record_ws_error("runtime_error")
        return
    finally:
        pending_task = runtime.interrupt_active_turn()
        if pending_task is not None:
            track_turn_cleanup(pending_task)
        if cleanup_tasks:
            await asyncio.gather(*tuple(cleanup_tasks), return_exceptions=True)
        runtime.clear_audio_buffer()
        with suppress(ValueError):
            container.companion.end_session(session_id)
            container.companion.schedule_learning_artifacts(
                session_id=session_id,
                include_candidates=True,
            )
