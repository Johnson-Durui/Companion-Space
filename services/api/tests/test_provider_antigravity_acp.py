from __future__ import annotations

import asyncio
import json
import sys
from contextlib import aclosing
from pathlib import Path

import pytest

from app.models.domain import ProviderCapability
from app.providers.antigravity_acp import (
    AntigravityACPProvider,
    AntigravityLoginRequiredError,
    aclose_all_acp_clients,
    ensure_agy_scratch_dir,
    resolve_agy_executable,
)
from app.providers.base import LLMRequest, Message
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderRateLimitError,
    ProviderUnavailableError,
    provider_error_code,
)
from app.services import provider_registry
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService

_ACP_HARNESS_SCRIPT = r"""
import json
import os
import sys
import time

mode = os.environ.get("ACP_TEST_MODE", "normal")
log_path = os.environ.get("ACP_TEST_LOG")
sessions = {}
counter = 0

def log(entry):
    if log_path:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    log(msg)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        emit({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"promptCapabilities": {"image": True}},
            },
        })
    elif method == "session/new":
        if mode == "auth_error":
            emit({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "authentication required: please sign in"},
            })
            continue
        counter += 1
        sid = f"sess-{counter}"
        sessions[sid] = {"model": "gemini-4-neon-high", "meta": params.get("_meta")}
        emit({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": sid,
                "models": {
                    "currentModelId": "gemini-4-neon-high",
                    "availableModels": [
                        {"modelId": "gemini-4-hydrogen-low", "name": "Hydrogen Low"},
                        {"modelId": "gemini-4-hydrogen-medium", "name": "Hydrogen Medium"},
                    ],
                },
            },
        })
    elif method == "session/set_model":
        sid = params.get("sessionId")
        if sid in sessions:
            sessions[sid]["model"] = params.get("modelId")
        emit({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params.get("sessionId")
        prompt = params.get("prompt") or []
        if mode == "rate_limit":
            emit({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": 429, "message": "rate limit exceeded"},
            })
            continue
        if mode == "permission_request":
            emit({
                "jsonrpc": "2.0",
                "id": "srv-perm-1",
                "method": "session/request_permission",
                "params": {"sessionId": sid, "tool": "shell"},
            })
            # Wait for client cancellation reply on next stdin line before completing.
            reply = json.loads(sys.stdin.readline())
            log({"permission_reply": reply})
            emit({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "denied-cleanly"},
                    },
                },
            })
            emit({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 2}},
            })
            continue
        if mode == "hang_until_cancel":
            emit({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "first-"},
                    },
                },
            })
            # Wait until session/cancel arrives on stdin.
            for next_raw in sys.stdin:
                next_msg = json.loads(next_raw)
                log(next_msg)
                if next_msg.get("method") == "session/cancel":
                    emit({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "cancelled"}})
                    break
            continue

        has_image = any(block.get("type") == "image" for block in prompt)
        emit({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": sid,
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "private-thought"},
                },
            },
        })
        if has_image:
            chunks = ["red"]
        else:
            chunks = ["<th", "ink>hidden</thi", "nk>Hello ", "world"]
        for text in chunks:
            emit({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text},
                    },
                },
            })
        emit({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "stopReason": "end_turn",
                "usage": {"inputTokens": 21, "outputTokens": 7},
            },
        })
    elif method == "session/close":
        sessions.pop(params.get("sessionId"), None)
        emit({"jsonrpc": "2.0", "id": req_id, "result": {}})
"""


def _write_harness(tmp_path: Path) -> Path:
    script = tmp_path / "acp_harness.py"
    script.write_text(_ACP_HARNESS_SCRIPT, encoding="utf-8")
    return script


def test_acp_streaming_thinking_vision_discovery_and_cleanup(tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)
    log_path = tmp_path / "acp.log"
    monkeypatch.setenv("ACP_TEST_MODE", "normal")
    monkeypatch.setenv("ACP_TEST_LOG", str(log_path))

    scratch = tmp_path / "scratch"
    provider = AntigravityACPProvider(
        timeout=15.0,
        command_override=(sys.executable, "-u", str(harness)),
        scratch_dir=scratch,
    )

    async def exercise():
        try:
            models = await provider.discover_models(ProviderCapability.chat_llm)
            assert models == ["gemini-4-hydrogen-low", "gemini-4-hydrogen-medium"]
            assert await provider.discover_models(ProviderCapability.embedding) == []

            req = LLMRequest(
                model="gemini-4-hydrogen-low",
                system="Be concise.",
                messages=[Message(role="user", content="Hi")],
                json_object=True,
                timeout_s=10,
            )
            chunks = [chunk async for chunk in provider.stream(req)]
            assert "".join(c.text for c in chunks) == "Hello world"
            assert "private-thought" in "".join(c.reasoning for c in chunks)
            assert "hidden" in "".join(c.reasoning for c in chunks)
            assert chunks[-1].finish_reason == "stop"
            assert chunks[-1].usage is not None
            assert chunks[-1].usage.input_tokens == 21
            assert chunks[-1].usage.output_tokens == 7

            vision_req = LLMRequest(
                model="gemini-4-hydrogen-low",
                system="Check image.",
                messages=[Message(role="user", content=[
                    {"type": "image", "image_b64": "iVBORw0KGgo=", "mime": "image/png"},
                    {"type": "text", "text": "Color?"},
                ])],
                timeout_s=10,
            )
            vision_chunks = [chunk async for chunk in provider.stream(vision_req)]
            assert "".join(c.text for c in vision_chunks) == "red"
        finally:
            await aclose_all_acp_clients()

    asyncio.run(exercise())

    agent_md = scratch / ".agents" / "agents" / "pure-llm.md"
    assert agent_md.is_file()
    assert "tools: []" in agent_md.read_text(encoding="utf-8")

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    new_reqs = [r for r in records if r.get("method") == "session/new"]
    assert any(
        "Return only a valid JSON object" in (((r.get("params") or {}).get("_meta") or {})
        .get("antigravity", {}).get("systemPrompt", {}).get("append", ""))
        for r in new_reqs
    )
    prompt_reqs = [r for r in records if r.get("method") == "session/prompt"]
    image_blocks = [
        blk for r in prompt_reqs for blk in r["params"]["prompt"] if blk.get("type") == "image"
    ]
    assert image_blocks == [{"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"}]
    close_reqs = [r for r in records if r.get("method") == "session/close"]
    assert len(close_reqs) >= 2


def test_acp_auto_denies_permission_requests_and_cancels_on_abort(tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)
    log_path = tmp_path / "acp-perm.log"
    monkeypatch.setenv("ACP_TEST_LOG", str(log_path))

    async def exercise():
        monkeypatch.setenv("ACP_TEST_MODE", "permission_request")
        provider = AntigravityACPProvider(
            timeout=10.0,
            command_override=(sys.executable, "-u", str(harness)),
            scratch_dir=tmp_path / "scratch-perm",
        )
        try:
            req = LLMRequest(
                model="gemini-4-hydrogen-low",
                system="Sys",
                messages=[Message(role="user", content="Run")],
                timeout_s=10,
            )
            text = "".join([c.text async for c in provider.stream(req)])
            assert text == "denied-cleanly"
        finally:
            await aclose_all_acp_clients()

        monkeypatch.setenv("ACP_TEST_MODE", "hang_until_cancel")
        provider2 = AntigravityACPProvider(
            timeout=10.0,
            command_override=(sys.executable, "-u", str(harness)),
            scratch_dir=tmp_path / "scratch-cancel",
        )
        try:
            req2 = LLMRequest(
                model="gemini-4-hydrogen-low",
                system="Sys",
                messages=[Message(role="user", content="Slow")],
                timeout_s=10,
            )
            async with aclosing(provider2.stream(req2)) as stream:
                first = await anext(stream)
                assert first.text == "first-"
        finally:
            await aclose_all_acp_clients()

    asyncio.run(exercise())

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    assert any(
        r.get("permission_reply", {}).get("result", {}).get("outcome", {}).get("outcome") == "cancelled"
        for r in records
    )
    assert any(r.get("method") == "session/cancel" for r in records)


def test_acp_error_mapping_and_binary_resolution(tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)

    async def run_with_mode(mode: str):
        monkeypatch.setenv("ACP_TEST_MODE", mode)
        provider = AntigravityACPProvider(
            timeout=5.0,
            command_override=(sys.executable, "-u", str(harness)),
            scratch_dir=tmp_path / f"scratch-{mode}",
        )
        req = LLMRequest(
            model="gemini-4-hydrogen-low",
            system="Sys",
            messages=[Message(role="user", content="Test")],
            timeout_s=5,
        )
        try:
            return [c async for c in provider.stream(req)]
        finally:
            await aclose_all_acp_clients()

    with pytest.raises(AntigravityLoginRequiredError) as auth_exc:
        asyncio.run(run_with_mode("auth_error"))
    assert provider_error_code(auth_exc.value) == "provider_cli_not_logged_in"

    with pytest.raises(ProviderRateLimitError):
        asyncio.run(run_with_mode("rate_limit"))

    missing_exe = tmp_path / "does-not-exist-agy.exe"
    monkeypatch.setenv("AGY_CLI_PATH", str(missing_exe))
    with pytest.raises(ProviderUnavailableError):
        resolve_agy_executable()

    existing_exe = tmp_path / "agy-bin.exe"
    existing_exe.write_bytes(b"")
    monkeypatch.setenv("AGY_CLI_PATH", str(existing_exe))
    assert resolve_agy_executable() == str(existing_exe)

    scratch = ensure_agy_scratch_dir(tmp_path / "scratch-check")
    assert (scratch / ".agents" / "agents" / "pure-llm.md").is_file()


def test_registry_antigravity_preset_keyless_validation_and_probe(
    isolated_settings, tmp_path: Path, monkeypatch,
) -> None:
    harness = _write_harness(tmp_path)
    monkeypatch.setenv("ACP_TEST_MODE", "normal")
    repository = SQLiteRepository(isolated_settings)
    vault = VaultService(isolated_settings, repository)
    vault.bootstrap()
    registry = ProviderRegistryService(repository, vault)

    with pytest.raises(ValueError, match="API key"):
        registry.save_connection(preset_id="antigravity", api_key="should-be-rejected")

    with pytest.raises(ProviderConfigurationError, match="base URL"):
        registry.save_connection(preset_id="antigravity", base_url="https://example.com")

    conn = registry.save_connection(preset_id="antigravity")
    assert conn["provider"] == "antigravity-acp"
    assert conn["base_url"] is None
    assert vault.get_provider_secret(conn["id"]) is None
    roles = registry.get_roles()
    assert {"live", "analysis", "vision"} <= set(roles)
    assert roles["live"].params.get("probe_timeout_s") == 25

    adapter = AntigravityACPProvider(
        timeout=10.0,
        command_override=(sys.executable, "-u", str(harness)),
        scratch_dir=tmp_path / "scratch-reg",
    )
    monkeypatch.setattr(provider_registry, "build_provider_adapter", lambda *_a, **_k: adapter)

    async def probe():
        try:
            return await registry.test_connection(conn["id"])
        finally:
            await aclose_all_acp_clients()

    results = asyncio.run(probe())
    assert {r.role for r in results if r.ok} == {"live", "analysis", "vision"}
