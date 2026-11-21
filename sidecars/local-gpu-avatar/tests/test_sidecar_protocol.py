from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

SIDECAR_ROOT = str(Path(__file__).resolve().parents[1])
if SIDECAR_ROOT not in sys.path:
    sys.path.insert(0, SIDECAR_ROOT)

from protocol import (  # noqa: E402
    CODEC_WEBP,
    HEADER_STRUCT,
    TSVA_MAGIC,
    TSVF_MAGIC,
    decode_tsva_frame,
    encode_tsvf_frame,
)
from server import create_sidecar_app  # noqa: E402


def _sample_anchor_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (320, 480), color=(90, 145, 165)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_tsva_and_tsvf_binary_framing() -> None:
    raw = HEADER_STRUCT.pack(TSVA_MAGIC, 5, 2, 1, 24000) + b"\x10\x00\x20\x00"
    parsed = decode_tsva_frame(raw)
    assert parsed is not None
    assert (parsed.gen, parsed.seg, parsed.flags, parsed.sample_rate) == (5, 2, 1, 24000)
    assert parsed.pcm16 == b"\x10\x00\x20\x00"

    encoded = encode_tsvf_frame(gen=5, ts_ms=420, payload=b"RIFFwebp", codec=CODEC_WEBP)
    magic, gen, ts_ms, codec, flags = HEADER_STRUCT.unpack_from(encoded, 0)
    assert (magic, gen, ts_ms, codec, flags) == (TSVF_MAGIC, 5, 420, CODEC_WEBP, 0)
    assert encoded[HEADER_STRUCT.size:] == b"RIFFwebp"


def test_sidecar_endpoints_stream_control_interrupt_and_delete() -> None:
    app = create_sidecar_app("anime_2d_reference")
    with TestClient(app) as client:
        caps = client.get("/v1/avatar/capabilities")
        assert caps.status_code == 200
        assert caps.json()["protocol_version"] == 1
        assert "ws_frames" in caps.json()["transports"]

        created = client.post(
            "/v1/avatar/sessions",
            json={
                "character_id": "tutor-echo",
                "anchor_image_b64": _sample_anchor_b64(),
                "anchor_mime": "image/png",
                "aspect_ratio": "9:16",
                "fps": 20,
                "resolution": "384x682",
                "transport": "ws_frames",
            },
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["session_id"]

        with client.websocket_connect(created.json()["stream_path"]) as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            ws.send_json({"type": "pose", "gen": 2, "payload": {"pose": "lecturing"}})
            ws.send_json({"type": "instant_action", "gen": 2, "payload": {"action": "praise_thumbs_up"}})
            ws.send_bytes(HEADER_STRUCT.pack(TSVA_MAGIC, 2, 1, 0, 24000) + (b"\x00\x10" * 64))
            ws.send_json({"type": "ping", "gen": 2, "payload": {"t": 99}})

            got_frame = False
            got_pong = False
            for _ in range(10):
                msg = ws.receive()
                if msg.get("bytes"):
                    magic, _gen, _ts, codec, _flags = HEADER_STRUCT.unpack_from(msg["bytes"], 0)
                    assert magic == TSVF_MAGIC
                    assert codec == CODEC_WEBP
                    assert len(msg["bytes"]) > HEADER_STRUCT.size
                    got_frame = True
                elif msg.get("text"):
                    if '"pong"' in msg["text"]:
                        got_pong = True
                if got_frame and got_pong:
                    break
            assert got_frame and got_pong
            ws.send_json({"type": "interrupt", "gen": 3, "payload": {}})

        closed = client.delete(f"/v1/avatar/sessions/{session_id}")
        assert closed.status_code == 200
        assert closed.json()["closed"] is True
