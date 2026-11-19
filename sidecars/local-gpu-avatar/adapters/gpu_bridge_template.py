"""Apache-2.0 adapter skeleton for connecting local GPU neural anime avatar models.

How to use on your own RTX GPU (e.g. RTX 5060 8GB / 5060Ti 16GB / 4090):
1. Create a SEPARATE Python virtual environment for your chosen inference engine
   (e.g. MuseTalk for 4-6 GB VRAM mouth-region lip-sync, LivePortrait for head/expression
   motion, or LiveAct / FlashHead for 12-24 GB VRAM full real-time anime video).
   Keep any GPL-licensed upstream engines strictly in your own local sidecar process —
   never copy GPL code into Companion Space's main repository.
2. Subclass `BaseAvatarRenderer` (or fill in the methods below) and launch:
      set AVATAR_ADAPTER=gpu_bridge
      uvicorn server:app --host 127.0.0.1 --port 8090
"""

from __future__ import annotations

import collections
import io

from PIL import Image

from adapter_base import BaseAvatarRenderer
from protocol import CODEC_WEBP


class LocalGpuBridgeTemplate(BaseAvatarRenderer):
    """Template illustrating real-time PCM16 audio buffering + generation-safe interrupts."""

    driver_name = "local-gpu-bridge-template"
    license_name = "Apache-2.0"
    gpu_info = "Template: connect MuseTalk / LivePortrait / LiveAct / FlashHead here"

    def __init__(self) -> None:
        self._anchor_rgb: Image.Image | None = None
        self._audio_queue: collections.deque[tuple[int, bytes]] = collections.deque(maxlen=64)
        self._active_gen = 0
        self._pose = "idle_companion"
        self._emotion = "neutral"

    def load_anchor(self, image_bytes: bytes, *, width: int, height: int) -> None:
        # 1. Decode anchor portrait and pre-extract face landmarks / latents once on GPU.
        #    Example (MuseTalk / LivePortrait):
        #      self._avatar_latents = self.pipeline.prepare_source_image(image_bytes)
        with Image.open(io.BytesIO(image_bytes)) as img:
            self._anchor_rgb = img.convert("RGB").resize((width, height), Image.Resampling.BILINEAR)

    def on_audio_pcm(self, *, gen: int, seg: int, sample_rate: int, pcm16: bytes) -> None:
        # 2. Drop audio from interrupted/stale generations immediately.
        if gen < self._active_gen:
            return
        self._active_gen = max(self._active_gen, gen)
        # Push 24kHz mono PCM16 into your Whisper/HuBERT/wav2vec streaming feature extractor.
        self._audio_queue.append((gen, pcm16))

    def on_pose(self, *, pose: str, gen: int) -> None:
        if gen > 0 and gen < self._active_gen:
            return
        self._active_gen = max(self._active_gen, gen)
        self._pose = pose
        # Map pose ("lecturing", "board_guiding", "listening_empathy", "idle_companion")
        # to your model's driving motion template or conditioning vector.

    def on_mood(self, *, emotion: str, intensity: float, gen: int) -> None:
        if gen > 0 and gen < self._active_gen:
            return
        self._active_gen = max(self._active_gen, gen)
        self._emotion = emotion

    def on_instant_action(self, *, action: str, gen: int) -> None:
        if gen > 0 and gen < self._active_gen:
            return
        self._active_gen = max(self._active_gen, gen)
        # Immediately blend a short gesture latent (nod / thumbs-up / board-point / chin-think).

    def on_interrupt(self, *, gen: int) -> None:
        # 3. Hard-clear queued audio chunks so the character stops speaking within <=300ms.
        self._active_gen = max(self._active_gen, gen + 1)
        self._audio_queue.clear()
        self._pose = "listening_empathy"

    def render_frame(self, elapsed_sec: float) -> tuple[bytes, int]:
        # 4. Run one forward step of your GPU model using latest audio feature + pose latent,
        #    then encode the RGB numpy frame to WebP (or JPEG) bytes.
        #    Here we fall back to the loaded anchor image until your model pipeline is wired.
        if self._audio_queue:
            self._audio_queue.popleft()
        image = self._anchor_rgb or Image.new("RGB", (512, 896), color=(14, 38, 42))
        out = io.BytesIO()
        image.save(out, format="WEBP", quality=80, method=1)
        return out.getvalue(), CODEC_WEBP

    def close(self) -> None:
        # 5. Free CUDA tensors and call torch.cuda.empty_cache() if applicable.
        self._audio_queue.clear()
        self._anchor_rgb = None
