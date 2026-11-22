from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field, JsonValue, StringConstraints, TypeAdapter, model_validator

Role = Literal["live", "analysis", "checker", "vision", "embedding", "tts", "stt"]

_CREDENTIAL_FIELDS = {
    "apikey", "xapikey", "authorization", "password", "token", "accesstoken",
    "refreshtoken", "oauthtoken", "secret", "clientsecret", "secretkey", "headers",
}
_CONTROL_FIELDS = {"model", "messages", "stream", "contents", "system", "system_instruction", "systemInstruction"}


def _contains_credentials(value: JsonValue) -> bool:
    if isinstance(value, dict):
        return any(
            key.lower().replace("_", "").replace("-", "") in _CREDENTIAL_FIELDS
            or _contains_credentials(nested)
            for key, nested in value.items()
        )
    if isinstance(value, list):
        return any(_contains_credentials(nested) for nested in value)
    return False


class RoleAssignment(BaseModel):
    connection_id: str = Field(min_length=1)
    model: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_params(self) -> RoleAssignment:
        if self.params.keys() & _CONTROL_FIELDS:
            raise ValueError("Use the dedicated role fields to select the model and connection.")
        if _contains_credentials(self.params):
            raise ValueError("Store API keys in the connection settings.")
        return self


class PresetSupport(BaseModel):
    json_object: bool = False
    vision: bool = False
    list_models: bool = True


class ProviderPreset(BaseModel):
    id: str
    label: str
    adapter: str
    base_url: str | None = None
    key_url: str | None = None
    cn_reachable: bool
    free_tier_note: str
    models: dict[Role, str | None]
    params: dict[Role, dict[str, JsonValue]] = Field(default_factory=dict)
    supports: PresetSupport = Field(default_factory=PresetSupport)
    notes: str = ""
    manual_live: str | None = None
    requires_api_key: bool = True
    key_guide: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_live(self) -> ProviderPreset:
        if not self.models.get("live") and not self.manual_live:
            raise ValueError("A preset without a live model needs an explanation.")
        return self


@lru_cache
def _presets() -> dict[str, ProviderPreset]:
    path = Path(__file__).with_suffix(".json")
    records = TypeAdapter(list[ProviderPreset]).validate_json(path.read_text(encoding="utf-8"))
    presets = {record.id: record for record in records}
    if len(presets) != len(records):
        raise ValueError("Provider preset IDs must be unique.")
    return presets


def list_presets() -> list[ProviderPreset]:
    return list(_presets().values())


def get_preset(preset_id: str) -> ProviderPreset:
    if preset_id not in _presets():
        raise ValueError("Provider preset not found.")
    return _presets()[preset_id]
