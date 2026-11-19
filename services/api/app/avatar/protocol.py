from __future__ import annotations

from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from app.providers.errors import ProviderConfigurationError
from app.providers.url_policy import is_local_endpoint, validate

TransportMode = Literal["webrtc", "ws_frames"]


def validate_sidecar_base_url(url: str, *, allow_lan: bool = False) -> str:
    """Validate local sidecar URL: loopback only by default, RFC1918 private only when allow_lan=True."""
    normalized = validate(url, provider="avatar-sidecar")
    host = (urlsplit(normalized).hostname or "").rstrip(".").lower()
    if not host:
        raise ProviderConfigurationError(
            provider="avatar-sidecar",
            public_detail="Enter a valid local sidecar URL.",
        )

    is_loopback = host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost")
    if not is_loopback:
        try:
            is_loopback = ip_address(host).is_loopback
        except ValueError:
            is_loopback = False

    if is_loopback:
        return normalized
    if allow_lan and is_local_endpoint(normalized):
        return normalized
    raise ProviderConfigurationError(
        provider="avatar-sidecar",
        public_detail=(
            "Local GPU sidecars must use a loopback address (127.0.0.1 / localhost) "
            "unless LAN access is explicitly enabled for a private network address."
        ),
    )


class SidecarCapabilities(BaseModel):
    protocol_version: Literal[1] = 1
    driver_name: str = Field(min_length=1, max_length=120)
    license: str = Field(default="Unknown", max_length=120)
    transports: list[TransportMode] = Field(default_factory=lambda: ["ws_frames"])
    max_fps: int = Field(default=25, ge=5, le=60)
    supported_resolutions: list[str] = Field(default_factory=lambda: ["512x896"])
    supports_single_image: bool = True
    instant_actions: list[str] = Field(default_factory=list)
    gpu_info: str | None = Field(default=None, max_length=240)
    ready: bool = True


class SidecarTestResult(BaseModel):
    ok: bool
    latency_ms: int
    capabilities: SidecarCapabilities | None = None
    error: str | None = None


class SidecarSessionRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    driver_id: str | None = Field(default=None, max_length=120)
    aspect_ratio: Literal["9:16", "3:4"] = "9:16"
    fps: int = Field(default=25, ge=10, le=60)
    resolution: str = Field(default="512x896", max_length=32)
    sdp_offer: str | None = Field(default=None, max_length=65536)


class SidecarSessionResponse(BaseModel):
    session_id: str
    transport: TransportMode
    sdp_answer: str | None = None
    stream_path: str
    ticket: str
    fps: int
    width: int
    height: int


class SidecarSessionCloseResponse(BaseModel):
    closed: bool
    active_sec: float = 0.0
