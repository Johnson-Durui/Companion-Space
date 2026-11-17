from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    Header,
    Response,
    status,
)
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import (
    ServiceContainer,
    get_container,
    optional_owner,
    require_owner,
)
from app.models.api_v1 import (
    VaultBrowserStatusResponse,
    VaultPasswordPayload,
    VaultStatusResponse,
    VaultUnlockResponse,
)
from app.services.browser_session import (
    clear_browser_session_cookies,
    set_browser_session_cookies,
)

router = APIRouter()

class VaultPasswordRotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=8, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


@router.get("/vault/status", response_model=VaultBrowserStatusResponse)
def vault_status(
    owner_token: str | None = Depends(optional_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultBrowserStatusResponse:
    status_payload = container.vault.status()
    return VaultBrowserStatusResponse(
        initialized=status_payload.initialized,
        unlocked=status_payload.unlocked,
        owner_session_authenticated=owner_token is not None,
    )


@router.post("/vault/init", response_model=VaultUnlockResponse)
def vault_init(
    payload: VaultPasswordPayload,
    response: Response,
    x_companion_browser: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> VaultUnlockResponse:
    container.vault.initialize(payload.password)
    token = container.vault.issue_owner_token()
    if x_companion_browser == "1":
        set_browser_session_cookies(
            response,
            settings=container.settings,
            protected_token=container.vault.protect_browser_token(token),
        )
    container.metrics.record_event_safe("vault_initialized", {}, once=True)
    return VaultUnlockResponse(
        initialized=True,
        unlocked=True,
        owner_token=None if x_companion_browser == "1" else token,
    )


@router.post("/vault/unlock", response_model=VaultUnlockResponse)
def vault_unlock(
    payload: VaultPasswordPayload,
    response: Response,
    x_companion_browser: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> VaultUnlockResponse:
    container.vault.unlock(payload.password)
    token = container.vault.issue_owner_token()
    if x_companion_browser == "1":
        set_browser_session_cookies(
            response,
            settings=container.settings,
            protected_token=container.vault.protect_browser_token(token),
        )
    return VaultUnlockResponse(
        initialized=True,
        unlocked=True,
        owner_token=None if x_companion_browser == "1" else token,
    )


@router.post("/vault/lock", response_model=VaultStatusResponse)
def vault_lock(
    response: Response,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultStatusResponse:
    container.vault.lock()
    clear_browser_session_cookies(response)
    return VaultStatusResponse(
        initialized=container.vault.status().initialized, unlocked=False
    )


@router.post("/vault/reset", response_model=VaultStatusResponse)
def vault_reset(
    payload: VaultPasswordPayload,
    response: Response,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultStatusResponse:
    container.vault.reset(payload.password)
    clear_browser_session_cookies(response)
    return VaultStatusResponse(initialized=False, unlocked=False)


@router.post("/vault/password", response_model=VaultUnlockResponse)
def rotate_vault_password(
    payload: VaultPasswordRotationRequest,
    response: Response,
    x_companion_browser: str | None = Header(default=None),
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> VaultUnlockResponse:
    container.vault.rotate_password(payload.current_password, payload.new_password)
    owner_token = container.vault.issue_owner_token()
    if x_companion_browser == "1":
        set_browser_session_cookies(
            response,
            settings=container.settings,
            protected_token=container.vault.protect_browser_token(owner_token),
        )
    return VaultUnlockResponse(
        initialized=True,
        unlocked=True,
        owner_token=None if x_companion_browser == "1" else owner_token,
    )


@router.post("/vault/logout", status_code=status.HTTP_204_NO_CONTENT)
def vault_logout(
    response: Response,
    token: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.repository.delete_owner_session(token)
    clear_browser_session_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
