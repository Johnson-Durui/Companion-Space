from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from statistics import median
from typing import Any
from uuid import uuid4

from app.services.repository import SQLiteRepository


logger = logging.getLogger(__name__)

ACTIVATION_EVENTS = (
    "vault_initialized",
    "provider_connected_or_mock",
    "space_created",
    "material_ready",
    "character_saved",
    "session_ended",
    "recap_viewed",
)
RELIABILITY_EVENTS = (
    "api_error",
    "ws_error",
    "ingestion_failed",
    "model_timeout",
    "text_fallback_used",
    "illegal_state_transition",
)
QUALITY_EVENTS = (
    "citation_verified",
    "recap_edited",
    "memory_candidate_confirmed",
    "memory_candidate_rejected",
)
PERFORMANCE_EVENTS = (
    "interrupt_latency_ms",
    "first_audio_latency_ms",
    "avatar_fps",
    "soak_memory_delta_mb",
    "audio_residue_scan",
)

_EVENT_KEYS: dict[str, frozenset[str]] = {
    "vault_initialized": frozenset(),
    "provider_connected_or_mock": frozenset({"provider_kind"}),
    "space_created": frozenset({"space_id"}),
    "material_ready": frozenset({"space_id", "material_id"}),
    "character_saved": frozenset({"character_id"}),
    "session_started": frozenset({"space_id", "session_id"}),
    "session_ended": frozenset(
        {"space_id", "session_id", "duration_ms"}
    ),
    "recap_viewed": frozenset({"space_id", "session_id"}),
    "api_request": frozenset({"route", "status_code", "duration_ms"}),
    "api_error": frozenset({"route", "status_code"}),
    "ws_attempt": frozenset({"session_id"}),
    "ws_connection": frozenset({"session_id"}),
    "ws_error": frozenset({"session_id", "code"}),
    "ingestion_failed": frozenset({"space_id", "material_id", "code"}),
    "model_completed": frozenset({"session_id", "provider_kind"}),
    "model_timeout": frozenset({"capability", "provider_kind", "code"}),
    "text_fallback_used": frozenset({"session_id", "code"}),
    "illegal_state_transition": frozenset(
        {"session_id", "state_from", "state_to", "code"}
    ),
    "citation_verified": frozenset({"session_id", "matched"}),
    "recap_edited": frozenset({"session_id"}),
    "memory_candidate_confirmed": frozenset({"space_id", "memory_id"}),
    "memory_candidate_rejected": frozenset({"space_id", "memory_id"}),
    "review_item_updated": frozenset({"space_id", "review_id"}),
    "interrupt_latency_ms": frozenset({"session_id", "value"}),
    "first_audio_latency_ms": frozenset({"session_id", "value"}),
    "avatar_fps": frozenset({"session_id", "value"}),
    "soak_memory_delta_mb": frozenset({"session_id", "value"}),
    "audio_residue_scan": frozenset({"session_id", "residue_found"}),
}
_SENSITIVE_KEY_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "document",
    "key",
    "material_body",
    "notes",
    "password",
    "prompt",
    "secret",
    "spoken_text",
    "summary",
    "token",
    "transcript",
)
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_TOKEN_PATTERN = re.compile(r"^[a-z0-9_.-]{1,80}$")
_ROUTE_PATTERN = re.compile(r"^/api/v1/[A-Za-z0-9_./{}:-]{0,180}$")
_SECRET_VALUE_PATTERN = re.compile(
    r"(?:\bBearer\s+|\bsk-(?:proj-)?|api[_-]?key|password|secret)",
    re.IGNORECASE,
)
_CAPABILITIES = {"chat_llm", "analysis_llm", "embedding", "stt", "tts"}
_SESSION_STATES = {
    "idle",
    "listening",
    "thinking",
    "speaking",
    "interrupted",
    "error",
    "closed",
}


class MetricsService:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository

    def record_event(
        self,
        event_name: str,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        normalized_payload = self._validate_payload(
            event_name,
            payload or {},
        )
        self.repository.insert_local_metric_event(
            event_id=str(uuid4()),
            event_name=event_name,
            payload_json=self._payload_json(normalized_payload),
            occurred_at=datetime.now(timezone.utc),
        )

    def record_event_once(
        self,
        event_name: str,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        normalized_payload = self._validate_payload(
            event_name,
            payload or {},
        )
        payload_json = self._payload_json(normalized_payload)
        if self.repository.local_metric_event_exists(
            event_name=event_name,
            payload_json=payload_json,
        ):
            return
        self.repository.insert_local_metric_event(
            event_id=str(uuid4()),
            event_name=event_name,
            payload_json=payload_json,
            occurred_at=datetime.now(timezone.utc),
        )

    def record_event_safe(
        self,
        event_name: str,
        payload: Mapping[str, Any] | None = None,
        *,
        once: bool = False,
    ) -> None:
        try:
            if once:
                self.record_event_once(event_name, payload)
            else:
                self.record_event(event_name, payload)
        except Exception as exc:
            logger.warning(
                "Local metric write failed",
                extra={
                    "extra_payload": {
                        "event_name": event_name,
                        "reason_type": type(exc).__name__,
                    }
                },
            )

    def list_events(self, *, limit: int = 100) -> dict[str, list[dict[str, Any]]]:
        if not 1 <= limit <= 500:
            raise ValueError("Local metric event limit must be between 1 and 500")
        return {
            "items": [
                self._event_from_row(row)
                for row in self.repository.list_local_metric_event_rows(
                    limit=limit
                )
            ]
        }

    def summary(self) -> dict[str, Any]:
        counts = {
            name: 0
            for name in _EVENT_KEYS
        }
        counts.update(
            self.repository.count_local_metric_events(
                event_names=tuple(_EVENT_KEYS)
            )
        )
        detail_events = [
            self._event_from_row(row)
            for row in self.repository.list_local_metric_event_rows(
                event_names=(
                    "citation_verified",
                    "audio_residue_scan",
                    "interrupt_latency_ms",
                    "first_audio_latency_ms",
                    "avatar_fps",
                    "soak_memory_delta_mb",
                )
            )
        ]
        citation_events = [
            item
            for item in detail_events
            if item["event"] == "citation_verified"
        ]
        residue_events = [
            item
            for item in detail_events
            if item["event"] == "audio_residue_scan"
        ]
        recap_views = counts["recap_viewed"]
        memory_decisions = (
            counts["memory_candidate_confirmed"]
            + counts["memory_candidate_rejected"]
        )
        return {
            "activation": {
                name: counts[name] for name in ACTIVATION_EVENTS
            },
            "reliability": {
                name: counts[name] for name in RELIABILITY_EVENTS
            },
            "quality": {
                "citation_verified": {
                    "matched": sum(
                        item["payload"].get("matched") is True
                        for item in citation_events
                    ),
                    "total": len(citation_events),
                },
                "recap_edited": counts["recap_edited"],
                "memory_candidate_confirmed": counts[
                    "memory_candidate_confirmed"
                ],
                "memory_candidate_rejected": counts[
                    "memory_candidate_rejected"
                ],
            },
            "performance": {
                "interrupt_latency_ms": self._numeric_summary(
                    detail_events,
                    "interrupt_latency_ms",
                    extreme="max",
                ),
                "first_audio_latency_ms": self._numeric_summary(
                    detail_events,
                    "first_audio_latency_ms",
                    extreme="max",
                ),
                "avatar_fps": self._numeric_summary(
                    detail_events,
                    "avatar_fps",
                    extreme="min",
                ),
                "soak_memory_delta_mb": self._numeric_summary(
                    detail_events,
                    "soak_memory_delta_mb",
                    extreme="max",
                ),
                "audio_residue_scan": {
                    "clean": sum(
                        item["payload"].get("residue_found") is False
                        for item in residue_events
                    ),
                    "residue_found": sum(
                        item["payload"].get("residue_found") is True
                        for item in residue_events
                    ),
                },
            },
            "rates": {
                "api_error_rate": self._rate(
                    counts["api_error"],
                    counts["api_request"],
                ),
                "ws_error_rate": self._rate(
                    counts["ws_error"],
                    counts["ws_attempt"],
                ),
                "ingestion_failure_rate": self._rate(
                    counts["ingestion_failed"],
                    counts["ingestion_failed"] + counts["material_ready"],
                ),
                "model_timeout_rate": self._rate(
                    counts["model_timeout"],
                    counts["model_timeout"] + counts["model_completed"],
                ),
                "text_fallback_rate": self._rate(
                    counts["text_fallback_used"],
                    counts["session_started"],
                ),
                "citation_accuracy": self._rate(
                    sum(
                        item["payload"].get("matched") is True
                        for item in citation_events
                    ),
                    len(citation_events),
                ),
                "recap_edit_rate": self._rate(
                    counts["recap_edited"],
                    recap_views,
                ),
                "memory_confirmation_rate": self._rate(
                    counts["memory_candidate_confirmed"],
                    memory_decisions,
                ),
            },
        }

    def _validate_payload(
        self,
        event_name: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        allowed_keys = _EVENT_KEYS.get(event_name)
        if allowed_keys is None:
            raise ValueError(f"Unsupported local metric event: {event_name}")
        if len(payload) > 8:
            raise ValueError("Local metric payload has too many fields")
        payload_keys = frozenset(payload)
        if payload_keys != allowed_keys:
            missing = sorted(allowed_keys - payload_keys)
            unexpected = sorted(payload_keys - allowed_keys)
            details: list[str] = []
            if missing:
                details.append(f"missing {', '.join(missing)}")
            if unexpected:
                details.append(f"unexpected {', '.join(unexpected)}")
            raise ValueError(
                "Invalid local metric payload fields for "
                f"{event_name}: {'; '.join(details)}"
            )
        normalized: dict[str, Any] = {}
        for key, value in payload.items():
            lowered_key = key.casefold()
            if any(part in lowered_key for part in _SENSITIVE_KEY_PARTS):
                raise ValueError(
                    "Local metric payload cannot contain content or secrets"
                )
            if key not in allowed_keys:
                raise ValueError(
                    f"Unsupported payload field for {event_name}: {key}"
                )
            normalized[key] = self._validate_value(key, value)
        return normalized

    @staticmethod
    def _validate_value(key: str, value: Any) -> Any:
        if isinstance(value, str) and _SECRET_VALUE_PATTERN.search(value):
            raise ValueError("Local metric payload cannot contain secrets")
        if key in {
            "space_id",
            "session_id",
            "material_id",
            "character_id",
            "memory_id",
            "review_id",
        }:
            if not isinstance(value, str) or not _IDENTIFIER_PATTERN.fullmatch(
                value
            ):
                raise ValueError(f"Invalid local metric identifier: {key}")
            return value
        if key == "route":
            if not isinstance(value, str) or not _ROUTE_PATTERN.fullmatch(value):
                raise ValueError("Invalid local metric route")
            return value
        if key in {"code", "provider_kind"}:
            if (
                not isinstance(value, str)
                or not _TOKEN_PATTERN.fullmatch(value)
                or _SECRET_VALUE_PATTERN.search(value)
            ):
                raise ValueError(f"Invalid local metric token: {key}")
            return value
        if key == "capability":
            if value not in _CAPABILITIES:
                raise ValueError("Invalid local metric capability")
            return value
        if key in {"state_from", "state_to"}:
            if value not in _SESSION_STATES:
                raise ValueError("Invalid local metric session state")
            return value
        if key == "status_code":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("Invalid local metric status code")
            if not 100 <= value <= 599:
                raise ValueError("Invalid local metric status code")
            return value
        if key in {"value", "duration_ms"}:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                raise ValueError(f"Invalid local metric numeric value: {key}")
            if key == "duration_ms" and value < 0:
                raise ValueError("Local metric duration cannot be negative")
            if abs(value) > 1_000_000_000:
                raise ValueError("Local metric numeric value is out of range")
            return value
        if key in {"matched", "residue_found"}:
            if not isinstance(value, bool):
                raise ValueError(f"Invalid local metric boolean: {key}")
            return value
        raise ValueError(f"Unsupported local metric payload value: {key}")

    @staticmethod
    def _payload_json(payload: Mapping[str, Any]) -> str:
        return json.dumps(
            dict(payload),
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _event_from_row(row: Mapping[str, object]) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "event": str(row["event_name"]),
            "payload": json.loads(str(row["payload_json"])),
            "occurred_at": str(row["occurred_at"]),
        }

    @staticmethod
    def _numeric_summary(
        events: list[dict[str, Any]],
        event_name: str,
        *,
        extreme: str,
    ) -> dict[str, int | float | None]:
        values = [
            item["payload"]["value"]
            for item in events
            if item["event"] == event_name
            and isinstance(item["payload"].get("value"), (int, float))
        ]
        extreme_value = (
            (min(values) if extreme == "min" else max(values))
            if values
            else None
        )
        return {
            "count": len(values),
            extreme: extreme_value,
            "p50": median(values) if values else None,
        }

    @staticmethod
    def _rate(numerator: int, denominator: int) -> float | None:
        if denominator <= 0:
            return None
        return round(numerator / denominator, 4)
