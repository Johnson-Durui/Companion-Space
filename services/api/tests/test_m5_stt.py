from __future__ import annotations

import asyncio
import math
from array import array
from types import SimpleNamespace

import pytest

from app.voice.stt import MAX_PCM_BYTES, VoiceTranscriber, is_echo


def _speech(duration_ms: int = 400, amplitude: int = 4_000) -> bytes:
    samples = array("h", (
        round(amplitude * math.sin(index * 2 * math.pi * 220 / 16_000))
        for index in range(16_000 * duration_ms // 1_000)
    ))
    return samples.tobytes()


class _Adapter:
    def __init__(self, transcript: str) -> None:
        self.transcript = transcript
        self.calls: list[tuple[str, bytes, int]] = []

    async def transcribe_pcm16(self, model: str, pcm16: bytes, sample_rate_hz: int) -> str:
        self.calls.append((model, pcm16, sample_rate_hz))
        return self.transcript


class _Registry:
    def __init__(self, adapter: _Adapter) -> None:
        self.resolved = SimpleNamespace(
            adapter=adapter,
            assignment=SimpleNamespace(model="speech-model"),
            connection=SimpleNamespace(provider="openai-compatible"),
        )

    def resolve_role(self, role: str):
        assert role == "stt"
        return self.resolved


def _transcriber(transcript: str) -> tuple[VoiceTranscriber, _Adapter]:
    adapter = _Adapter(transcript)
    gateway = SimpleNamespace(registry=_Registry(adapter))
    return VoiceTranscriber(gateway), adapter


def test_transcriber_sends_a_completed_utterance_to_the_configured_role() -> None:
    transcriber, adapter = _transcriber("  这是我的回答。 ")
    audio = _speech()

    result = asyncio.run(transcriber.transcribe_pcm16(audio))

    assert result.accepted
    assert result.text == "这是我的回答。"
    assert adapter.calls == [("speech-model", audio, 16_000)]


@pytest.mark.parametrize(
    ("audio", "transcript", "reason"),
    [
        (_speech(100), "unused", "too_short"),
        (bytes(16_000), "unused", "silence"),
        (_speech(), "  ", "empty"),
        (_speech(), "嗯", "too_short"),
    ],
    ids=("short", "silence", "empty", "filler"),
)
def test_transcriber_discards_non_utterances_without_exposing_audio(audio, transcript, reason) -> None:
    transcriber, adapter = _transcriber(transcript)

    result = asyncio.run(transcriber.transcribe_pcm16(audio))

    assert not result.accepted
    assert result.discard_reason == reason
    assert bool(adapter.calls) is (reason in {"empty", "too_short"} and len(audio) >= 8_000)


def test_transcriber_discards_loudspeaker_echo_after_transcription() -> None:
    transcriber, _ = _transcriber("我们先看这一行公式")

    result = asyncio.run(transcriber.transcribe_pcm16(
        _speech(), echo_reference="我们先看这一行公式。",
    ))

    assert result.discard_reason == "echo"
    assert is_echo("先看这一行公式", "我们先看这一行公式。")
    assert not is_echo("B", "答案可能是 D")


def test_transcriber_rejects_invalid_audio_at_the_memory_boundary() -> None:
    transcriber, _ = _transcriber("unused")

    with pytest.raises(ValueError, match="60 seconds"):
        asyncio.run(transcriber.transcribe_pcm16(bytes(MAX_PCM_BYTES + 2)))
    with pytest.raises(ValueError, match="16-bit PCM"):
        asyncio.run(transcriber.transcribe_pcm16(bytes(8_001)))


def test_voice_settings_are_owner_only_and_persist_per_teacher(client, owner_token) -> None:
    assert client.get("/api/v2/voice/settings").status_code == 401
    headers = {"Authorization": f"Bearer {owner_token}"}
    characters = client.get("/api/v2/characters", headers=headers).json()
    character_id = characters[0]["id"]

    response = client.put(
        "/api/v2/voice/settings",
        headers=headers,
        json={
            "default": {"engine": "browser"},
            "characters": {
                character_id: {
                    "engine": "edge",
                    "voice_id": "zh-CN-XiaoxiaoNeural",
                    "rate": 1.1,
                },
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["characters"][character_id]["rate"] == 1.1
    assert client.get("/api/v2/voice/settings", headers=headers).json() == response.json()

def test_browser_voice_preview_returns_text_for_local_playback(client, owner_token) -> None:
    headers = {"Authorization": f"Bearer {owner_token}"}
    character_id = client.get("/api/v2/characters", headers=headers).json()[0]["id"]
    saved = client.put(
        "/api/v2/voice/settings",
        headers=headers,
        json={
            "default": {"engine": "edge", "voice_id": "zh-CN-XiaoxiaoNeural"},
            "characters": {character_id: {"engine": "browser"}},
        },
    )
    assert saved.status_code == 200

    preview = client.post(
        "/api/v2/voice/preview",
        headers=headers,
        json={"character_id": character_id, "text": "浏览器朗读"},
    )

    assert preview.status_code == 200
    assert preview.json() == {
        "kind": "browser",
        "text": "浏览器朗读",
        "engine": "browser",
        "format": None,
        "sample_rate_hz": None,
        "audio_b64": None,
        "warning": None,
    }


def test_microphone_test_returns_transcript_without_storing_audio(client, owner_token, monkeypatch) -> None:
    from app.api.deps import get_container

    adapter = _Adapter("麦克风识别成功")
    resolved = _Registry(adapter).resolved
    monkeypatch.setattr(get_container().providers, "resolve_role", lambda role: resolved)

    response = client.post(
        "/api/v2/voice/microphone-test",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "Content-Type": "audio/pcm",
        },
        content=_speech(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "accepted": True,
        "text": "麦克风识别成功",
        "discard_reason": None,
    }
    assert len(adapter.calls) == 1


def test_microphone_test_rejects_unbounded_or_wrongly_encoded_input(client, owner_token) -> None:
    headers = {"Authorization": f"Bearer {owner_token}"}

    wrong_type = client.post(
        "/api/v2/voice/microphone-test",
        headers={**headers, "Content-Type": "audio/mpeg"},
        content=b"not pcm",
    )
    oversized = client.post(
        "/api/v2/voice/microphone-test",
        headers={
            **headers,
            "Content-Type": "audio/pcm",
            "Content-Length": str(MAX_PCM_BYTES + 2),
        },
        content=b"",
    )

    assert wrong_type.status_code == 415
    assert oversized.status_code == 413


def test_offline_stt_requires_explicit_download_and_stays_local(client, owner_token, monkeypatch) -> None:
    from app.api.deps import get_container
    from app.voice.sherpa import LocalSpeechRecognizer

    headers = {"Authorization": f"Bearer {owner_token}"}
    endpoint = "/api/v2/voice/stt"
    installed = False

    def install(self):
        nonlocal installed
        installed = True

    monkeypatch.setattr(LocalSpeechRecognizer, "runtime_available", lambda self: True)
    monkeypatch.setattr(LocalSpeechRecognizer, "model_available", lambda self: installed)
    monkeypatch.setattr(LocalSpeechRecognizer, "install", install)
    monkeypatch.setattr(LocalSpeechRecognizer, "recognize", lambda self, audio, rate: "本地识别完成")
    monkeypatch.setattr(get_container().providers, "resolve_role", lambda role: pytest.fail("voice left this device"))

    assert client.get(endpoint).status_code == 401
    settings = client.get(endpoint, headers=headers).json()
    assert settings["engine"] == "openai_compat"
    assert settings["license_url"].startswith("https://")
    assert client.put(endpoint, headers=headers, json={"engine": "local_sherpa"}).status_code == 409
    assert not installed
    assert client.put(endpoint, headers=headers, json={"engine": "local_sherpa", "download_model": True}).status_code == 200
    assert installed
    assert client.get("/api/v2/voice/status", headers=headers).json()["stt_configured"]
    response = client.post(
        "/api/v2/voice/microphone-test",
        headers={**headers, "Content-Type": "audio/pcm"},
        content=_speech(),
    )
    assert response.status_code == 200
    assert response.json()["text"] == "本地识别完成"
