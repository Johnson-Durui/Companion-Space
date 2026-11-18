from __future__ import annotations

from ipaddress import ip_address
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.api.deps import ServiceContainer, get_container, require_owner
from app.services.browser_session import (
    CSRF_COOKIE_NAME,
    OWNER_COOKIE_NAME,
    is_allowed_browser_origin,
    set_browser_session_cookies,
)
from app.services.vault import KeyStorage, VaultStatus

router = APIRouter()


class LocalSessionStatus(BaseModel):
    state: Literal["ready", "locked", "migration_required"]
    password_enabled: bool
    key_storage: KeyStorage
    warning: str | None


class UnlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr = Field(min_length=1, max_length=200)


class SetPasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr | None = Field(min_length=8, max_length=200)
    current_password: SecretStr | None = Field(default=None, min_length=1, max_length=200)


def is_loopback(host: str | None) -> bool:
    if host == "localhost":
        return True
    try:
        return ip_address(host or "").is_loopback
    except ValueError:
        return False


def require_local_http(request: Request, container: ServiceContainer) -> None:
    try:
        host = request.url.hostname
        requested_port = request.url.port
    except ValueError:
        host = None
        requested_port = None

    peer = request.client
    if peer is None or peer.host == "localhost" or not is_loopback(peer.host) or not is_loopback(host):
        raise HTTPException(403, detail={"code": "loopback_required", "message": "A local connection is required."})
    origin = request.headers.get("origin")
    if origin is not None and not is_allowed_browser_origin(origin, request.url.scheme, host, requested_port, container.settings):
        raise HTTPException(403, detail={"code": "origin_denied", "message": "Request origin is not allowed."})


def _state(status: VaultStatus) -> LocalSessionStatus:
    state = "migration_required" if status.key_storage == "legacy" else "ready" if status.unlocked else "locked"
    return LocalSessionStatus(
        state=state,
        password_enabled=status.password_enabled,
        key_storage=status.key_storage,
        warning=status.warning,
    )


def _complete_session(
    request: Request, response: Response, container: ServiceContainer,
    *, replace: bool = False,
) -> LocalSessionStatus:
    state = _state(container.vault.status())
    response.headers["Cache-Control"] = "no-store"
    if state.state == "ready":
        cookie = request.cookies.get(OWNER_COOKIE_NAME, "")
        token = container.vault.unprotect_browser_token(cookie) if cookie else None
        if replace or token is None or not container.vault.validate_owner_token(token):
            token = container.vault.issue_owner_token()
        elif request.cookies.get(CSRF_COOKIE_NAME):
            return state
        set_browser_session_cookies(
            response,
            settings=container.settings,
            protected_token=container.vault.protect_browser_token(token),
            secure=request.url.scheme == "https",
        )
    return state


@router.post("/session/bootstrap", response_model=LocalSessionStatus)
def bootstrap(
    request: Request, response: Response,
    container: ServiceContainer = Depends(get_container),
) -> LocalSessionStatus:
    require_local_http(request, container)
    container.vault.bootstrap()
    return _complete_session(request, response, container)


@router.post("/session/unlock", response_model=LocalSessionStatus)
def unlock(
    body: UnlockRequest, request: Request, response: Response,
    container: ServiceContainer = Depends(get_container),
) -> LocalSessionStatus:
    require_local_http(request, container)
    container.vault.unlock(body.password.get_secret_value())
    return _complete_session(request, response, container, replace=True)


@router.post("/session/skip-migration", response_model=LocalSessionStatus)
def skip_migration(
    request: Request, response: Response,
    container: ServiceContainer = Depends(get_container),
) -> LocalSessionStatus:
    require_local_http(request, container)
    container.vault.skip_migration()
    return _complete_session(request, response, container, replace=True)


@router.get("/settings/security", response_model=LocalSessionStatus)
def security(
    response: Response,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> LocalSessionStatus:
    response.headers["Cache-Control"] = "no-store"
    return _state(container.vault.status())


@router.put("/settings/security/password", response_model=LocalSessionStatus)
def set_password(
    body: SetPasswordRequest, request: Request, response: Response,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> LocalSessionStatus:
    require_local_http(request, container)
    container.vault.set_password(
        body.password.get_secret_value() if body.password is not None else None,
        body.current_password.get_secret_value() if body.current_password is not None else None,
    )
    return _complete_session(request, response, container, replace=True)
