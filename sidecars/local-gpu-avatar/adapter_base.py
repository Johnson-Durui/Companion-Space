from __future__ import annotations

from abc import ABC, abstractmethod


class BaseAvatarRenderer(ABC):
    """Pluggable single-image anime avatar renderer contract (Apache-2.0)."""

    driver_name: str = "base-avatar-renderer"
    license_name: str = "Apache-2.0"
    gpu_info: str | None = None

    @abstractmethod
    def load_anchor(self, image_bytes: bytes, *, width: int, height: int) -> None:
        """Prepare internal state from the character's anchor portrait."""

    @abstractmethod
    def on_audio_pcm(self, *, gen: int, seg: int, sample_rate: int, pcm16: bytes) -> None:
        """Ingest 24 kHz mono PCM16 speech audio for real-time lip-sync / energy."""

    @abstractmethod
    def on_pose(self, *, pose: str, gen: int) -> None:
        """Update the primary teaching pose."""

    @abstractmethod
    def on_mood(self, *, emotion: str, intensity: float, gen: int) -> None:
        """Update facial emotion / mood weight."""

    @abstractmethod
    def on_instant_action(self, *, action: str, gen: int) -> None:
        """Trigger an immediate 150ms teaching micro-action."""

    @abstractmethod
    def on_interrupt(self, *, gen: int) -> None:
        """Atomically drop queued audio/actions for gen and return to listening."""

    @abstractmethod
    def render_frame(self, elapsed_sec: float) -> tuple[bytes, int]:
        """Return (encoded_frame_bytes, codec_id) for the current timestamp."""

    def close(self) -> None:
        """Release VRAM or buffers owned by this session."""
