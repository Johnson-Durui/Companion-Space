from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.avatar.protocol import validate_sidecar_base_url
from app.services.repository import SQLiteRepository
from app.services.settings_store import get_setting, put_setting

AVATAR_DRIVER_SETTINGS_KEY = "avatar_driver_settings"
ShortLabel = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
SidecarId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class LocalSidecarEntry(BaseModel):
    id: SidecarId
    label: ShortLabel
    base_url: str = Field(min_length=1, max_length=512)
    allow_lan: bool = False
    transport_preference: Literal["auto", "webrtc", "ws_frames"] = "auto"
    enabled: bool = True

    @model_validator(mode="after")
    def validate_url(self) -> LocalSidecarEntry:
        self.base_url = validate_sidecar_base_url(self.base_url, allow_lan=self.allow_lan)
        return self


class CloudLiveSettings(BaseModel):
    enabled: bool = False
    connection_id: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=160)
    idle_suspend_sec: int = Field(default=30, ge=5, le=300)
    max_session_minutes: int = Field(default=10, ge=1, le=120)
    max_session_cost_cny: float = Field(default=20.0, ge=1.0, le=500.0)


class AvatarDriverSettings(BaseModel):
    default_sidecar_id: str | None = Field(default=None, max_length=80)
    local_sidecars: list[LocalSidecarEntry] = Field(default_factory=list, max_length=16)
    cloud_live: CloudLiveSettings = Field(default_factory=CloudLiveSettings)

    @model_validator(mode="after")
    def validate_unique_ids(self) -> AvatarDriverSettings:
        seen: set[str] = set()
        for entry in self.local_sidecars:
            if entry.id in seen:
                raise ValueError(f"Duplicate local sidecar ID: {entry.id}")
            seen.add(entry.id)
        if self.default_sidecar_id and self.default_sidecar_id not in seen:
            self.default_sidecar_id = None
        return self


def load_avatar_driver_settings(repository: SQLiteRepository) -> AvatarDriverSettings:
    raw = get_setting(repository, AVATAR_DRIVER_SETTINGS_KEY, None)
    if raw is None:
        return AvatarDriverSettings()
    return AvatarDriverSettings.model_validate(raw)


def save_avatar_driver_settings(
    repository: SQLiteRepository, settings: AvatarDriverSettings
) -> AvatarDriverSettings:
    put_setting(repository, AVATAR_DRIVER_SETTINGS_KEY, settings.model_dump())
    return settings
