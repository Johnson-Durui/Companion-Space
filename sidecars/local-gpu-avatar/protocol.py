from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field

TSVA_MAGIC = b"TSVA"
TSVF_MAGIC = b"TSVF"
HEADER_STRUCT = struct.Struct(">4sIIHH")

CODEC_WEBP = 1
CODEC_JPEG = 2


@dataclass(frozen=True)
class TsvaAudioFrame:
    gen: int
    seg: int
    flags: int
    sample_rate: int
    pcm16: bytes


def decode_tsva_frame(data: bytes) -> TsvaAudioFrame | None:
    if len(data) < HEADER_STRUCT.size:
        return None
    magic, gen, seg, flags, sample_rate = HEADER_STRUCT.unpack_from(data, 0)
    if magic != TSVA_MAGIC:
        return None
    return TsvaAudioFrame(
        gen=gen,
        seg=seg,
        flags=flags,
        sample_rate=sample_rate or 24000,
        pcm16=data[HEADER_STRUCT.size:],
    )


def encode_tsvf_frame(
    *,
    gen: int,
    ts_ms: int,
    payload: bytes,
    codec: int = CODEC_WEBP,
    flags: int = 0,
) -> bytes:
    header = HEADER_STRUCT.pack(TSVF_MAGIC, gen & 0xFFFFFFFF, ts_ms & 0xFFFFFFFF, codec, flags)
    return header + payload


class CapabilitiesResponse(BaseModel):
    protocol_version: Literal[1] = 1
    driver_name: str
    license: str = "Apache-2.0"
    transports: list[Literal["webrtc", "ws_frames"]] = Field(default_factory=lambda: ["ws_frames"])
    max_fps: int = 25
    supported_resolutions: list[str] = Field(default_factory=lambda: ["384x682", "512x896"])
    supports_single_image: bool = True
    instant_actions: list[str] = Field(
        default_factory=lambda: [
            "greet",
            "empathy_nod",
            "think_chin",
            "praise_thumbs_up",
            "praise_clap",
            "gentle_encourage",
            "board_point",
            "farewell",
        ]
    )
    gpu_info: str | None = None
    ready: bool = True


class CreateSessionRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    anchor_image_b64: str = Field(min_length=16)
    anchor_mime: str = Field(default="image/webp", max_length=64)
    aspect_ratio: Literal["9:16", "3:4"] = "9:16"
    fps: int = Field(default=25, ge=10, le=60)
    resolution: str = Field(default="512x896", max_length=32)
    transport: Literal["webrtc", "ws_frames"] = "ws_frames"
    sdp_offer: str | None = None


class CreateSessionResponse(BaseModel):
    session_id: str
    transport: Literal["webrtc", "ws_frames"] = "ws_frames"
    sdp_answer: str | None = None
    stream_path: str
    fps: int
    width: int
    height: int


class CloseSessionResponse(BaseModel):
    closed: bool
    active_sec: float
