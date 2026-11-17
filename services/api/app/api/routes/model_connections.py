from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints

from app.api.deps import ServiceContainer, get_container, require_owner
from app.llm.presets import ProviderPreset, Role, RoleAssignment, list_presets
from app.providers.errors import ProviderConfigurationError, provider_error_code
from app.services.provider_registry import RoleTestResult

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class ConnectionView(BaseModel):
    id: str
    provider: str
    label: str
    base_url: str | None
    capabilities: list[str]
    created_at: datetime
    updated_at: datetime


class ConnectionPatch(BaseModel):
    label: Label | None = None
    base_url: str | None = Field(default=None, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)


class ConnectionCreate(BaseModel):
    provider: str | None = Field(default=None, max_length=100)
    preset_id: str | None = Field(default=None, max_length=100)
    label: Label | None = None
    base_url: str | None = Field(default=None, max_length=2048)
    api_key: str = Field(default="", max_length=4096)


class ModelList(BaseModel):
    models: list[str]


@router.get("/providers/presets", response_model=list[ProviderPreset])
def get_presets() -> list[ProviderPreset]:
    return list_presets()


@router.get("/providers/connections", response_model=list[ConnectionView])
def get_connections(container: Container):
    return container.providers.list_connections()


@router.get("/providers/connections/{connection_id}", response_model=ConnectionView)
def get_connection(connection_id: str, container: Container):
    connection = container.providers.get_connection(connection_id)
    if connection is None:
        raise HTTPException(404, "Model connection not found")
    return connection


@router.post("/providers/connections", response_model=ConnectionView, status_code=201)
def create_connection(payload: ConnectionCreate, container: Container):
    try:
        return container.providers.save_connection(**payload.model_dump())
    except ProviderConfigurationError as error:
        raise HTTPException(400, detail={"code": provider_error_code(error), "message": error.public_detail}) from error


@router.patch("/providers/connections/{connection_id}", response_model=ConnectionView)
def patch_connection(connection_id: str, payload: ConnectionPatch, container: Container):
    get_connection(connection_id, container)
    try:
        return container.providers.update_connection(connection_id, **payload.model_dump(exclude_unset=True))
    except ProviderConfigurationError as error:
        raise HTTPException(400, detail={"code": provider_error_code(error), "message": error.public_detail}) from error


@router.delete("/providers/connections/{connection_id}", status_code=204)
def delete_connection(connection_id: str, container: Container) -> Response:
    if not container.providers.delete_connection(connection_id):
        raise HTTPException(404, "Model connection not found")
    return Response(status_code=204)


@router.get("/providers/connections/{connection_id}/models", response_model=ModelList)
async def discover_models(connection_id: str, container: Container) -> ModelList:
    return ModelList(models=await container.gateway.discover_models(connection_id))


@router.post("/providers/connections/{connection_id}/test", response_model=list[RoleTestResult])
async def test_connection(connection_id: str, container: Container):
    return await container.gateway.test_connection(connection_id)


@router.get("/settings/model-roles", response_model=dict[Role, RoleAssignment])
def get_model_roles(container: Container):
    return container.providers.get_roles()


@router.put("/settings/model-roles", response_model=dict[Role, RoleAssignment])
def put_model_roles(payload: dict[Role, RoleAssignment], container: Container):
    return container.providers.set_roles(payload)
