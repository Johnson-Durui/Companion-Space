from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi.routing import APIRoute, APIWebSocketRoute, _iter_routes_with_context

from app.api.v1 import router
from app.main import app


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "api_route_contract.json"
PUBLIC_OPERATIONS = {
    ("GET", "/api/v1/tts/sidecar"),
    ("GET", "/api/v1/vault/status"),
    ("POST", "/api/v1/vault/init"),
    ("POST", "/api/v1/vault/unlock"),
    ("POST", "/api/v1/mobile/pairing/exchange"),
    ("POST", "/api/v1/mobile/auth/refresh"),
}


def _dependency_names(dependant: Any) -> set[str]:
    names: set[str] = set()
    for dependency in dependant.dependencies:
        names.add(getattr(dependency.call, "__name__", str(dependency.call)))
        names.update(_dependency_names(dependency))
    return names


def _schema_refs(value: Any) -> list[str]:
    if isinstance(value, dict):
        refs = [value["$ref"]] if "$ref" in value else []
        for nested in value.values():
            refs.extend(_schema_refs(nested))
        return refs
    if isinstance(value, list):
        return [ref for nested in value for ref in _schema_refs(nested)]
    return []


def _effective_routes() -> list[tuple[Any, Any]]:
    return list(_iter_routes_with_context(router.routes))


def _openapi_path(path: str) -> str:
    return re.sub(r"{([^}:]+):[^}]+}", r"{\1}", path)


def _contract() -> dict[str, Any]:
    schema = app.openapi()
    route_by_operation = {}
    websocket_paths = []
    route_keys = []
    for route, context in _effective_routes():
        effective = context or route
        path = _openapi_path(effective.path)
        if isinstance(route, APIWebSocketRoute):
            websocket_paths.append(
                context.starlette_route.path if context is not None else route.path
            )
            continue
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(effective.methods):
            key = (method, path)
            route_keys.append(key)
            route_by_operation[key] = effective
    assert len(route_keys) == len(set(route_keys)), "Duplicate v1 method/path route"

    operations = []
    for path, path_item in schema["paths"].items():
        if not path.startswith("/api/v1/"):
            continue
        for method, operation in path_item.items():
            if method.upper() not in {"DELETE", "GET", "PATCH", "POST", "PUT"}:
                continue
            key = (method.upper(), path)
            effective = route_by_operation[key]
            responses = operation.get("responses", {})
            operations.append(
                {
                    "method": key[0],
                    "path": path,
                    "handler": effective.name,
                    "operation_id": operation["operationId"],
                    "status_codes": sorted(responses),
                    "request_schema_refs": sorted(
                        set(_schema_refs(operation.get("requestBody", {})))
                    ),
                    "response_schema_refs": sorted(set(_schema_refs(responses))),
                    "auth_dependencies": sorted(
                        {"require_owner", "require_local_owner"}
                        & _dependency_names(effective.dependant)
                    ),
                }
            )
    operations = sorted(operations, key=lambda item: (item["path"], item["method"]))
    operation_ids = [operation["operation_id"] for operation in operations]
    assert len(operation_ids) == len(set(operation_ids)), "Duplicate v1 operation ID"
    return {
        "operations": operations,
        "websocket_paths": sorted(websocket_paths),
    }


def test_v1_transport_contract_matches_reviewed_fixture() -> None:
    assert _contract() == json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_only_explicit_bootstrap_routes_are_public() -> None:
    public = {
        (operation["method"], operation["path"])
        for operation in _contract()["operations"]
        if not operation["auth_dependencies"]
    }
    assert public == PUBLIC_OPERATIONS


def test_realtime_route_is_stable() -> None:
    contract = _contract()
    assert contract["websocket_paths"] == ["/api/v1/sessions/{session_id}/realtime"]
