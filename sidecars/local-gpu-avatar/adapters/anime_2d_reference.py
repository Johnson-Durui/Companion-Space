from __future__ import annotations

import array
import io
import math
from time import monotonic

from PIL import Image, ImageEnhance, ImageOps

from adapter_base import BaseAvatarRenderer
from protocol import CODEC_WEBP


class Anime2DReferenceRenderer(BaseAvatarRenderer):
    """Lightweight Pillow protocol-reference renderer for zero-GPU testing.

    Note: This reference adapter validates end-to-end TutorVideo Sidecar Protocol v1
    streaming, audio RMS reactivity, pose offsets, and instant interrupts on any PC.
    For neural lip-sync or full upper-body generation, plug in your own local GPU
    model via `adapters/gpu_bridge_template.py`.
    """

    driver_name = "anime-2d-protocol-reference"
    license_name = "Apache-2.0"
    gpu_info = "CPU Pillow reference baseline (swap to gpu_bridge_template for RTX GPU models)"

    def __init__(self) -> None:
        self._canvas: Image.Image | None = None
        self._width = 384
        self._height = 682
        self._pose = "idle_companion"
        self._emotion = "warm"
        self._action: str | None = None
        self._action_until = 0.0
        self._speech_energy = 0.0
        self._gen = 0

    def load_anchor(self, image_bytes: bytes, *, width: int, height: int) -> None:
        self._width = max(256, min(720, width))
        self._height = max(256, min(1280, height))
        with Image.open(io.BytesIO(image_bytes)) as img:
            normalized = ImageOps.exif_transpose(img).convert("RGB")
            # Keep slight margin for smooth breathing / nod / board-point camera shifts.
            pad_w = int(self._width * 1.08)
            pad_h = int(self._height * 1.08)
            self._canvas = ImageOps.fit(normalized, (pad_w, pad_h), method=Image.Resampling.BILINEAR)

    def on_audio_pcm(self, *, gen: int, seg: int, sample_rate: int, pcm16: bytes) -> None:
        if gen < self._gen or len(pcm16) < 2:
            return
        self._gen = max(self._gen, gen)
        samples = array.array("h")
        samples.frombytes(pcm16[: len(pcm16) - (len(pcm16) % 2)])
        if not samples:
            return
        mean_sq = sum(sample * sample for sample in samples) / len(samples)
        rms = math.sqrt(mean_sq) / 32768.0
        self._speech_energy = min(1.0, max(self._speech_energy * 0.5, rms * 4.5))

    def on_pose(self, *, pose: str, gen: int) -> None:
        if gen > 0 and gen < self._gen:
            return
        self._gen = max(self._gen, gen)
        self._pose = pose

    def on_mood(self, *, emotion: str, intensity: float, gen: int) -> None:
        if gen > 0 and gen < self._gen:
            return
        self._gen = max(self._gen, gen)
        self._emotion = emotion

    def on_instant_action(self, *, action: str, gen: int) -> None:
        if gen > 0 and gen < self._gen:
            return
        self._gen = max(self._gen, gen)
        self._action = action
        self._action_until = monotonic() + 1.8

    def on_interrupt(self, *, gen: int) -> None:
        self._gen = max(self._gen, gen)
        self._action = None
        self._action_until = 0.0
        self._speech_energy = 0.0
        self._pose = "listening_empathy"

    def render_frame(self, elapsed_sec: float) -> tuple[bytes, int]:
        if self._canvas is None:
            blank = Image.new("RGB", (self._width, self._height), color=(14, 38, 42))
            out = io.BytesIO()
            blank.save(out, format="WEBP", quality=75)
            return out.getvalue(), CODEC_WEBP

        now = monotonic()
        if self._action and now > self._action_until:
            self._action = None
        self._speech_energy *= 0.88

        max_dx = (self._canvas.width - self._width) // 2
        max_dy = (self._canvas.height - self._height) // 2
        dx = 0.0
        dy = math.sin(elapsed_sec * 1.9) * (max_dy * 0.25)

        if self._pose == "listening_empathy":
            dy += math.sin(elapsed_sec * 3.4) * (max_dy * 0.35)
        elif self._pose == "board_guiding" or self._action == "board_point":
            dx -= max_dx * 0.65
        elif self._pose == "lecturing":
            dy -= self._speech_energy * (max_dy * 0.45)

        if self._action in {"praise_thumbs_up", "praise_clap"}:
            dy -= max_dy * 0.45
        elif self._action == "think_chin":
            dx += max_dx * 0.35

        left = int(max(0, min(self._canvas.width - self._width, max_dx + dx)))
        top = int(max(0, min(self._canvas.height - self._height, max_dy + dy)))
        frame = self._canvas.crop((left, top, left + self._width, top + self._height))

        if self._action in {"praise_thumbs_up", "praise_clap"} or self._emotion == "cheerful":
            frame = ImageEnhance.Brightness(frame).enhance(1.06)
        elif self._pose == "idle_companion":
            frame = ImageEnhance.Brightness(frame).enhance(0.95)

        out = io.BytesIO()
        frame.save(out, format="WEBP", quality=78, method=1)
        return out.getvalue(), CODEC_WEBP

    def close(self) -> None:
        self._canvas = None
