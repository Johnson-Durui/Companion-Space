from __future__ import annotations


from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)

from app.api.deps import (
    ServiceContainer,
    get_container,
    require_owner,
)
from app.models.api_v1 import (
    LocalMetricSignalRequest,
)

router = APIRouter()


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
            raise ValueError("This local metric signal requires only a numeric value")
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
            raise ValueError("The audio residue signal requires only residue_found")
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
            raise ValueError("The text fallback signal requires only a reason code")
        event_payload = {
            "session_id": payload.session_id,
            "code": payload.code,
        }
    else:
        raise ValueError("Unsupported local metric client signal")
    container.metrics.record_event(payload.event, event_payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
