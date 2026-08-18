from contextlib import asynccontextmanager
from time import perf_counter

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.deps import get_container
from app.api.v1 import router as v1_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.tracing import trace_id_middleware
from app.models.domain import ProviderCapability
from app.providers.errors import (
    ProviderError,
    ProviderTimeoutError,
    provider_error_code,
    provider_error_payload,
    provider_error_status,
)
from app.services.repository import CharacterInUseError
from app.services.vault import VaultError


def _cors_origins() -> list[str]:
    return get_settings().cors_origins


def _json_error(status_code: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, "code": code})


def _provider_timeout_capability(
    request: Request,
    exc: ProviderTimeoutError,
) -> ProviderCapability:
    capability = getattr(exc, "capability", None)
    if isinstance(capability, ProviderCapability):
        return capability
    if isinstance(capability, str):
        try:
            return ProviderCapability(capability)
        except ValueError:
            pass

    query_capability = request.query_params.get("capability")
    if query_capability is not None:
        try:
            return ProviderCapability(query_capability)
        except ValueError:
            pass

    route = request.scope.get("route")
    route_path = getattr(route, "path", request.url.path)
    capability_by_route = {
        "/api/v1/providers/connections/{connection_id}/models": ProviderCapability.chat_llm,
        "/api/v1/characters/{character_id}/voice-preview": ProviderCapability.tts,
        "/api/v1/sessions/{session_id}/turns": ProviderCapability.chat_llm,
        "/api/v1/sessions/{session_id}/turns/stream": ProviderCapability.chat_llm,
        "/api/v1/sessions/{session_id}/demos": ProviderCapability.analysis_llm,
    }
    return capability_by_route.get(route_path, ProviderCapability.chat_llm)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    configure_logging()
    container = get_container()
    try:
        container.providers.start_builtin_neural_tts_activation()
        container.companion.start_learning_artifact_recovery()
        yield
    finally:
        await container.aclose()


app = FastAPI(
    title="Companion Space API",
    version="0.1.0",
    lifespan=lifespan,
)


async def local_metrics_middleware(request: Request, call_next):
    started_at = perf_counter()
    response = None
    try:
        response = await call_next(request)
        return response
    finally:
        if request.url.path.startswith("/api/v1/"):
            route = request.scope.get("route")
            route_path = getattr(route, "path", request.url.path)
            status_code = response.status_code if response is not None else 500
            duration_ms = round((perf_counter() - started_at) * 1000, 3)
            metrics = get_container().metrics
            metrics.record_event_safe(
                "api_request",
                {
                    "route": route_path,
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                },
            )
            if status_code >= 400:
                metrics.record_event_safe(
                    "api_error",
                    {"route": route_path, "status_code": status_code},
                )


app.middleware("http")(local_metrics_middleware)
app.middleware("http")(trace_id_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(v1_router)


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(
    _: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    errors = [
        {
            "loc": list(item.get("loc", ())),
            "msg": str(item.get("msg", "Invalid value")),
            "type": str(item.get("type", "value_error")),
        }
        for item in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "Request validation failed",
            "code": "validation_error",
            "errors": errors,
        },
    )


@app.exception_handler(ProviderError)
async def handle_provider_error(request: Request, exc: ProviderError) -> JSONResponse:
    if isinstance(exc, ProviderTimeoutError):
        get_container().metrics.record_event_safe(
            "model_timeout",
            {
                "capability": _provider_timeout_capability(
                    request,
                    exc,
                ).value,
                "provider_kind": exc.provider,
                "code": provider_error_code(exc),
            },
        )
    return JSONResponse(
        status_code=provider_error_status(exc),
        content=provider_error_payload(exc),
    )


@app.exception_handler(VaultError)
async def handle_vault_error(_: Request, exc: VaultError) -> JSONResponse:
    message = str(exc)
    lowered = message.lower()
    if "already initialized" in lowered:
        return _json_error(status.HTTP_409_CONFLICT, "Vault already initialized", "vault_already_initialized")
    if "not initialized" in lowered:
        return _json_error(status.HTTP_404_NOT_FOUND, "Vault is not initialized", "vault_not_initialized")
    if "invalid vault password" in lowered or "unable to decrypt vault payload" in lowered:
        return _json_error(status.HTTP_401_UNAUTHORIZED, "Invalid vault password", "vault_invalid_password")
    if "locked" in lowered:
        return _json_error(status.HTTP_423_LOCKED, "Vault is locked", "vault_locked")
    return _json_error(status.HTTP_400_BAD_REQUEST, "Vault request failed", "vault_error")


@app.exception_handler(CharacterInUseError)
async def handle_character_in_use_error(
    _: Request,
    exc: CharacterInUseError,
) -> JSONResponse:
    return _json_error(
        status.HTTP_409_CONFLICT,
        str(exc),
        "character_in_use",
    )


@app.exception_handler(ValueError)
async def handle_value_error(_: Request, exc: ValueError) -> JSONResponse:
    message = str(exc)
    lowered = message.lower()
    if "not found" in lowered:
        return _json_error(status.HTTP_404_NOT_FOUND, message, "not_found")
    if "already has an active turn" in lowered:
        return _json_error(
            status.HTTP_409_CONFLICT,
            message,
            "session_busy",
        )
    return _json_error(status.HTTP_400_BAD_REQUEST, message, "invalid_request")


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}
