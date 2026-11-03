from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_local_owner,
    require_owner,
)
from app.models.api_v1 import (
    OwnerPreferencesResponse,
    OwnerPreferencesUpdateRequest,
    VaultPasswordPayload,
    VaultStatusResponse,
    VaultUnlockResponse,
)
from app.models.domain import (
    TrustedDevice,
)
from app.services.vault import InvalidDeviceRefreshTokenError, PairingChallengeError

router = APIRouter()

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


@router.get("/vault/status", response_model=VaultStatusResponse)
def vault_status(
    container: ServiceContainer = Depends(get_container),
) -> VaultStatusResponse:
    status_payload = container.vault.status()
    return VaultStatusResponse(
        initialized=status_payload.initialized, unlocked=status_payload.unlocked
    )


@router.post("/vault/init", response_model=VaultUnlockResponse)
def vault_init(
    payload: VaultPasswordPayload, container: ServiceContainer = Depends(get_container)
) -> VaultUnlockResponse:
    container.vault.initialize(payload.password)
    token = container.vault.issue_owner_token()
    container.metrics.record_event_safe("vault_initialized", {}, once=True)
    return VaultUnlockResponse(initialized=True, unlocked=True, owner_token=token)


@router.post("/vault/unlock", response_model=VaultUnlockResponse)
def vault_unlock(
    payload: VaultPasswordPayload, container: ServiceContainer = Depends(get_container)
) -> VaultUnlockResponse:
    container.vault.unlock(payload.password)
    token = container.vault.issue_owner_token()
    return VaultUnlockResponse(initialized=True, unlocked=True, owner_token=token)


@router.post("/vault/lock", response_model=VaultStatusResponse)
def vault_lock(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultStatusResponse:
    container.vault.lock()
    return VaultStatusResponse(
        initialized=container.vault.status().initialized, unlocked=False
    )


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
        device, refresh_token, access_token, access_expires_at = (
            container.vault.pair_device(
                challenge_id=payload.challenge_id,
                code=payload.code,
                name=payload.device_name,
            )
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
        device, refresh_token, access_token, access_expires_at = (
            container.vault.refresh_device_access(payload.refresh_token)
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trusted device not found"
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/vault/preferences", response_model=OwnerPreferencesResponse)
def get_vault_preferences(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> OwnerPreferencesResponse:
    preferences = container.vault.get_owner_preferences()
    return OwnerPreferencesResponse(
        adult_relationships_enabled=(preferences.adult_relationships_enabled),
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
        adult_relationships_enabled=(preferences.adult_relationships_enabled),
        adult_age_confirmed_at=preferences.adult_age_confirmed_at,
    )
