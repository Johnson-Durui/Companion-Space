from __future__ import annotations

import asyncio
import json
import sys
from contextlib import aclosing
from pathlib import Path

import pytest

from app.models.domain import ProviderCapability
from app.providers.base import LLMRequest, Message
from app.providers.codex_app_server import (
    CodexAppServerProvider,
    CodexLoginRequiredError,
    aclose_all_codex_clients,
    resolve_codex_executable,
)
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderUnavailableError,
    provider_error_code,
)
from app.services import provider_registry
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService

_CODEX_HARNESS_SCRIPT = r"""
import json
import os
import sys

mode = os.environ.get("CODEX_TEST_MODE", "normal")
log_path = os.environ.get("CODEX_TEST_LOG")
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
        emit({"jsonrpc": "2.0", "id": req_id, "result": {"userAgent": "codex-test"}})
    elif method == "initialized":
        continue
    elif method == "model/list":
        emit({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "data": [
                    {"id": "gpt-6.2-astra", "inputModalities": ["text", "image"]},
                    {"id": "gpt-6.2-sol", "inputModalities": ["text", "image"]},
                ]
            },
        })
    elif method == "thread/start":
        if mode == "auth_error":
            emit({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32001, "message": "not logged in: run codex login"},
            })
            continue
        counter += 1
        emit({"jsonrpc": "2.0", "id": req_id, "result": {"thread": {"id": f"thr-{counter}"}}})
    elif method == "turn/start":
        tid = params.get("threadId")
        turn_id = f"turn-{tid}"
        inputs = params.get("input") or []
        emit({"jsonrpc": "2.0", "id": req_id, "result": {"turn": {"id": turn_id, "status": "inProgress"}}})

        if mode == "hang_until_interrupt":
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": tid, "delta": "part-1-"},
            })
            continue

        if mode == "approval_request":
            emit({
                "jsonrpc": "2.0",
                "id": "srv-approve-1",
                "method": "item/commandExecution/requestApproval",
                "params": {"threadId": tid},
            })
            reply = json.loads(sys.stdin.readline())
            log({"approval_reply": reply})
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": tid, "delta": "declined-ok"},
            })
            emit({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {"threadId": tid, "turn": {"id": turn_id, "status": "completed"}},
            })
            continue

        has_image = any(block.get("type") == "image" for block in inputs)
        deltas = ["Red"] if has_image else ["Hel", "lo!"]
        for d in deltas:
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": tid, "delta": d},
            })
        emit({
            "jsonrpc": "2.0",
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": tid,
                "tokenUsage": {"last": {"inputTokens": 30, "outputTokens": 5}},
            },
        })
        emit({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": tid, "turn": {"id": turn_id, "status": "completed"}},
        })
    elif method == "turn/interrupt":
        tid = params.get("threadId")
        turn_id = params.get("turnId")
        emit({"jsonrpc": "2.0", "id": req_id, "result": {}})
        emit({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": tid, "turn": {"id": turn_id, "status": "interrupted"}},
        })
"""


def _write_harness(tmp_path: Path) -> Path:
    script = tmp_path / "codex_harness.py"
    script.write_text(_CODEX_HARNESS_SCRIPT, encoding="utf-8")
    return script


def test_codex_streaming_vision_discovery_and_interrupt(tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)
    log_path = tmp_path / "codex.log"
    monkeypatch.setenv("CODEX_TEST_MODE", "normal")
    monkeypatch.setenv("CODEX_TEST_LOG", str(log_path))

    provider = CodexAppServerProvider(
        timeout=15.0,
        command_override=(sys.executable, "-u", str(harness)),
        scratch_dir=tmp_path / "codex-scratch",
    )

    async def exercise():
        try:
            models = await provider.discover_models(ProviderCapability.chat_llm)
            assert models == ["gpt-6.2-astra", "gpt-6.2-sol"]
            assert await provider.discover_models(ProviderCapability.embedding) == []

            req = LLMRequest(
                model="gpt-6.2-astra",
                system="Helpful tutor",
                messages=[Message(role="user", content="Say hello")],
                timeout_s=10,
            )
            chunks = [c async for c in provider.stream(req)]
            assert "".join(c.text for c in chunks) == "Hello!"
            assert chunks[-1].finish_reason == "stop"
            assert chunks[-1].usage is not None
            assert chunks[-1].usage.input_tokens == 30
            assert chunks[-1].usage.output_tokens == 5

            vision_req = LLMRequest(
                model="gpt-6.2-astra",
                system="Check image",
                messages=[Message(role="user", content=[
                    {"type": "image", "image_b64": "iVBORw0KGgo=", "mime": "image/png"},
                    {"type": "text", "text": "Color?"},
                ])],
                timeout_s=10,
            )
            vision_chunks = [c async for c in provider.stream(vision_req)]
            assert "".join(c.text for c in vision_chunks) == "Red"
        finally:
            await aclose_all_codex_clients()

    asyncio.run(exercise())

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    thread_starts = [r for r in records if r.get("method") == "thread/start"]
    assert thread_starts
    assert thread_starts[0]["params"]["ephemeral"] is True
    assert thread_starts[0]["params"]["sandbox"] == "read-only"
    assert thread_starts[0]["params"]["approvalPolicy"] == "never"
    assert thread_starts[0]["params"]["baseInstructions"] == "Helpful tutor"
    turn_starts = [r for r in records if r.get("method") == "turn/start"]
    image_blocks = [
        blk for r in turn_starts for blk in r["params"]["input"] if blk.get("type") == "image"
    ]
    assert image_blocks == [{"type": "image", "url": "data:image/png;base64,iVBORw0KGgo="}]


def test_codex_cancel_interrupts_and_declines_approvals(tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)
    log_path = tmp_path / "codex-ctrl.log"
    monkeypatch.setenv("CODEX_TEST_LOG", str(log_path))

    async def exercise():
        monkeypatch.setenv("CODEX_TEST_MODE", "approval_request")
        provider = CodexAppServerProvider(
            timeout=10.0,
            command_override=(sys.executable, "-u", str(harness)),
            scratch_dir=tmp_path / "scratch-approve",
        )
        try:
            req = LLMRequest(
                model="gpt-6.2-astra",
                system="Sys",
                messages=[Message(role="user", content="Run")],
                timeout_s=10,
            )
            assert "".join([c.text async for c in provider.stream(req)]) == "declined-ok"
        finally:
            await aclose_all_codex_clients()

        monkeypatch.setenv("CODEX_TEST_MODE", "hang_until_interrupt")
        provider2 = CodexAppServerProvider(
            timeout=10.0,
            command_override=(sys.executable, "-u", str(harness)),
            scratch_dir=tmp_path / "scratch-interrupt",
        )
        try:
            req2 = LLMRequest(
                model="gpt-6.2-astra",
                system="Sys",
                messages=[Message(role="user", content="Slow")],
                timeout_s=10,
            )
            async with aclosing(provider2.stream(req2)) as stream:
                first = await anext(stream)
                assert first.text == "part-1-"
        finally:
            await aclose_all_codex_clients()

    asyncio.run(exercise())

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    assert any(r.get("approval_reply", {}).get("result", {}).get("decision") == "decline" for r in records)
    assert any(r.get("method") == "turn/interrupt" for r in records)


def test_codex_auth_error_binary_lookup_and_registry(isolated_settings, tmp_path: Path, monkeypatch) -> None:
    harness = _write_harness(tmp_path)
    monkeypatch.setenv("CODEX_TEST_MODE", "auth_error")
    provider = CodexAppServerProvider(
        timeout=5.0,
        command_override=(sys.executable, "-u", str(harness)),
        scratch_dir=tmp_path / "scratch-auth",
    )

    async def run_auth():
        try:
            req = LLMRequest(
                model="gpt-6.2-astra",
                system="Sys",
                messages=[Message(role="user", content="Hi")],
                timeout_s=5,
            )
            return [c async for c in provider.stream(req)]
        finally:
            await aclose_all_codex_clients()

    with pytest.raises(CodexLoginRequiredError) as exc:
        asyncio.run(run_auth())
    assert provider_error_code(exc.value) == "provider_cli_not_logged_in"

    monkeypatch.setenv("CODEX_CLI_PATH", str(tmp_path / "missing-codex.exe"))
    with pytest.raises(ProviderUnavailableError):
        resolve_codex_executable()

    existing = tmp_path / "codex-bin.exe"
    existing.write_bytes(b"")
    monkeypatch.setenv("CODEX_CLI_PATH", str(existing))
    assert resolve_codex_executable() == str(existing)

    repository = SQLiteRepository(isolated_settings)
    vault = VaultService(isolated_settings, repository)
    vault.bootstrap()
    registry = ProviderRegistryService(repository, vault)

    with pytest.raises(ValueError, match="API key"):
        registry.save_connection(preset_id="codex", api_key="secret")
    with pytest.raises(ProviderConfigurationError, match="base URL"):
        registry.save_connection(preset_id="codex", base_url="http://127.0.0.1:9999")

    conn = registry.save_connection(preset_id="codex")
    assert conn["provider"] == "codex-app-server"
    assert conn["base_url"] is None
    assert vault.get_provider_secret(conn["id"]) is None
    assert {"live", "analysis", "vision"} <= set(registry.get_roles())

    monkeypatch.setenv("CODEX_TEST_MODE", "normal")
    adapter = CodexAppServerProvider(
        timeout=10.0,
        command_override=(sys.executable, "-u", str(harness)),
        scratch_dir=tmp_path / "scratch-reg",
    )
    monkeypatch.setattr(provider_registry, "build_provider_adapter", lambda *_a, **_k: adapter)

    async def probe():
        try:
            return await registry.test_connection(conn["id"])
        finally:
            await aclose_all_codex_clients()

    results = asyncio.run(probe())
    assert {r.role for r in results if r.ok} == {"live", "analysis", "vision"}
