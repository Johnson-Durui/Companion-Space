from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.routing import Match

from app.api.deps import GatewayFactory, ServiceContainer, build_container, get_container
from app.api.v2 import router as v2_router
from app.core.config import Settings, get_settings
from app.core.errors import ResourceNotFoundError
from app.core.logging import configure_logging
from app.core.tracing import trace_id_middleware
from app.llm.gateway import LLMGateway
from app.providers.errors import ProviderError, provider_error_payload, provider_error_status
from app.services.repository import CharacterInUseError
from app.services.vault import (
    InvalidVaultPasswordError,
    VaultAlreadyInitializedError,
    VaultDependencyError,
    VaultError,
    VaultLockedError,
    VaultNotInitializedError,
    VaultPayloadError,
    VaultStateError,
)

_HTTP_CODES = {400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
               405: "method_not_allowed", 409: "conflict", 413: "payload_too_large", 415: "unsupported_media"}
_VAULT_ERRORS = {
    VaultAlreadyInitializedError: (409, "vault_already_initialized", "Vault already initialized"),
    VaultNotInitializedError: (409, "vault_not_initialized", "Vault is not initialized"),
    InvalidVaultPasswordError: (401, "vault_invalid_password", "Invalid vault password"),
    VaultLockedError: (423, "vault_locked", "Vault is locked"),
    VaultPayloadError: (409, "vault_payload_error", "Could not open encrypted credentials"),
    VaultStateError: (409, "vault_invalid_operation", "Check the current credential storage mode and password"),
    VaultDependencyError: (503, "vault_dependency_error", "Credential encryption is unavailable"),
}
_HASHED_ASSET = re.compile(r"^assets/.+-[A-Za-z0-9_-]{8,}\.[^/]+$")


def _error(status: int, code: str, message: str, *, headers=None, **extra) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message, "detail": message, **extra},
        headers=headers,
    )


async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and {"code", "message"} <= exc.detail.keys():
        code, message = exc.detail["code"], exc.detail["message"]
    else:
        code, message = _HTTP_CODES.get(exc.status_code, "request_error"), str(exc.detail)
    return _error(exc.status_code, code, message, headers=exc.headers)


async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{"loc": list(item["loc"]), "type": item["type"]} for item in exc.errors()]
    return _error(422, "validation_error", "Request validation failed", errors=errors)


async def provider_error(_: Request, exc: ProviderError) -> JSONResponse:
    payload = provider_error_payload(exc)
    return _error(provider_error_status(exc), payload["code"], payload.get("message") or payload["detail"])


async def vault_error(_: Request, exc: VaultError) -> JSONResponse:
    for kind, details in _VAULT_ERRORS.items():
        if isinstance(exc, kind):
            return _error(*details)
    return _error(400, "vault_error", "Credential operation failed")


async def character_in_use(_: Request, exc: CharacterInUseError) -> JSONResponse:
    return _error(409, "character_in_use", str(exc))


async def invalid_request(_: Request, exc: ValueError) -> JSONResponse:
    code = getattr(exc, "code", "invalid_request")
    status = getattr(exc, "status_code", 400)
    return _error(status, code, str(exc))


class _WebRoute(APIRoute):
    def matches(self, scope):
        prefix = scope.get("path", "").lstrip("/").split("/", 1)[0]
        if prefix in {"api", "static", "healthz"}:
            return Match.NONE, {}
        return super().matches(scope)


async def missing_resource(_: Request, exc: ResourceNotFoundError) -> JSONResponse:
    return _error(404, getattr(exc, "code", "not_found"), str(exc))


def _serve_web(app: FastAPI, root: Path) -> None:
    avatars = root / "assets/avatars"
    dist = (root / "apps/web/dist").resolve()
    app.mount("/static/avatars", StaticFiles(directory=avatars, check_dir=False), name="avatars")

    router = APIRouter(route_class=_WebRoute)

    @router.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web(path: str):
        file = (dist / path).resolve()
        if file.is_relative_to(dist) and file.is_file():
            cache = "public, max-age=31536000, immutable" if _HASHED_ASSET.fullmatch(path) else "no-cache"
            return FileResponse(file, headers={"Cache-Control": cache})
        index = (dist / "index.html").resolve()
        if (
            not file.is_relative_to(dist) or not index.is_relative_to(dist) or not index.is_file()
            or path.split("/", 1)[0] == "assets" or Path(path).suffix
        ):
            raise HTTPException(404, "Not found")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    app.include_router(router)


def create_app(gateway_factory: GatewayFactory | None = None, *, settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    if gateway_factory is None and settings is None:
        container_factory = get_container
    else:
        @lru_cache
        def container_factory() -> ServiceContainer:
            return build_container(app_settings, gateway_factory or LLMGateway)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        configure_logging()
        container = await asyncio.to_thread(container_factory)
        try:
            await container.jobs.start()
            yield
        finally:
            await container.aclose()
            container_factory.cache_clear()

    application = FastAPI(title="Companion Space API", version="1.0.0", lifespan=lifespan)
    if container_factory is not get_container:
        application.dependency_overrides[get_container] = container_factory

    application.middleware("http")(trace_id_middleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Audio-Sample-Rate", "X-Audio-Channels"],
        allow_credentials=True,
    )
    application.add_exception_handler(HTTPException, http_error)
    application.add_exception_handler(RequestValidationError, validation_error)
    application.add_exception_handler(ProviderError, provider_error)
    application.add_exception_handler(VaultError, vault_error)
    application.add_exception_handler(CharacterInUseError, character_in_use)
    application.add_exception_handler(ResourceNotFoundError, missing_resource)
    application.add_exception_handler(ValueError, invalid_request)
    application.include_router(v2_router)

    @application.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    _serve_web(application, app_settings.repo_root)
    return application


app = create_app()
