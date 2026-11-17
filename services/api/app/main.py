from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.deps import get_container
from app.api.v1 import router as v1_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.tracing import trace_id_middleware
from app.providers.errors import (
    ProviderError,
    provider_error_payload,
    provider_error_status,
)
from app.services.repository import CharacterInUseError
from app.services.vault import VaultError


def _cors_origins() -> list[str]:
    return get_settings().cors_origins


def _json_error(status_code: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, "code": code})


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
    version="2.0.0",
    lifespan=lifespan,
)


app.middleware("http")(trace_id_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Audio-Sample-Rate", "X-Audio-Channels"],
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
async def handle_provider_error(_: Request, exc: ProviderError) -> JSONResponse:
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
