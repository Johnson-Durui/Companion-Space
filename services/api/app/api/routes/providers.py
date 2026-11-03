from __future__ import annotations


from fastapi import (
    APIRouter,
    Depends,
    Response,
    status,
)

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_owner,
)
from app.models.api_v1 import (
    ProviderConnectionCreateRequest,
    ProviderConnectionUpdateRequest,
    NeuralTtsSidecarStatusResponse,
)
from app.models.domain import (
    ProviderCapability,
)
from app.providers.errors import (
    ProviderError,
)
from app.providers.local_neural_tts import LOCAL_NEURAL_TTS_MODEL
from app.services.provider_registry import (
    BUILTIN_NEURAL_TTS_CONNECTION_ID,
    UNSET,
)

router = APIRouter()


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


@router.get("/providers/registry")
def provider_registry(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> list[dict]:
    return container.providers.list_registry()


@router.get("/providers/connections")
def provider_connections(
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> list[dict]:
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


@router.delete(
    "/providers/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_provider_connection(
    connection_id: str,
    _: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> Response:
    container.providers.delete_connection(connection_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
