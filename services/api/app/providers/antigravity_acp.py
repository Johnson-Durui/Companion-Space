from __future__ import annotations

import asyncio
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import deque
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from time import monotonic
from typing import Any

from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, LLMRequest, Message, StreamChunk, Usage
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.providers.thinking import ThinkingFilter

DEFAULT_TIMEOUT_SECONDS = 90.0
DEFAULT_ANTIGRAVITY_MODELS: tuple[str, ...] = (
    "gemini-4-hydrogen-low",
    "gemini-4-hydrogen-medium",
    "gemini-4-hydrogen-high",
    "gemini-4-neon-low",
    "gemini-4-neon-medium",
    "gemini-4-neon-high",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-medium",
    "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-medium",
)
_PURE_LLM_AGENT_NAME = "pure-llm"
_PURE_LLM_AGENT_MD = (
    "---\n"
    "name: pure-llm\n"
    "description: Stateless text and vision responder with all tools disabled.\n"
    "tools: []\n"
    "mainAgent: true\n"
    "subagent: false\n"
    "---\n\n"
    "You are a stateless assistant. Respond directly to the prompt without calling tools "
    "or inspecting local files.\n"
)
_STREAM_BUFFER_LIMIT = 8 * 1024 * 1024


class AntigravityLoginRequiredError(ProviderAuthenticationError):
    public_code = "provider_cli_not_logged_in"


class _RPCError(RuntimeError):
    def __init__(self, payload: Any) -> None:
        if isinstance(payload, dict):
            self.code = payload.get("code")
            self.message = str(payload.get("message") or "RPC error")
            self.data = payload.get("data")
        else:
            self.code = None
            self.message = str(payload)
            self.data = None
        super().__init__(self.message)


class _ProcessExitedError(RuntimeError):
    def __init__(self, returncode: int | None, stderr_tail: str) -> None:
        self.returncode = returncode
        self.stderr_tail = stderr_tail
        super().__init__(f"ACP process exited with code {returncode}: {stderr_tail}")


def resolve_agy_executable() -> str:
    env_path = os.environ.get("AGY_CLI_PATH", "").strip()
    if env_path:
        candidate = Path(env_path)
        if candidate.is_file():
            return str(candidate)
        raise ProviderUnavailableError(
            provider="antigravity-acp",
            public_detail="Configured AGY_CLI_PATH executable was not found.",
        )

    found = shutil.which("agy")
    if found:
        return found

    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        win_candidate = Path(local_app_data) / "agy" / "bin" / "agy.exe"
        if win_candidate.is_file():
            return str(win_candidate)
    else:
        posix_candidate = Path.home() / ".local" / "bin" / "agy"
        if posix_candidate.is_file():
            return str(posix_candidate)

    raise ProviderUnavailableError(
        provider="antigravity-acp",
        public_detail="Antigravity CLI (agy) is not installed on this machine.",
    )


def ensure_agy_scratch_dir(scratch_dir: Path | None = None) -> Path:
    root = scratch_dir or (Path(tempfile.gettempdir()) / "companion-space-agy-acp")
    agents_dir = root / ".agents" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    agent_file = agents_dir / f"{_PURE_LLM_AGENT_NAME}.md"
    try:
        if not agent_file.is_file() or agent_file.read_text(encoding="utf-8") != _PURE_LLM_AGENT_MD:
            agent_file.write_text(_PURE_LLM_AGENT_MD, encoding="utf-8")
    except OSError as exc:
        raise ProviderUnavailableError(
            provider="antigravity-acp",
            public_detail="Could not prepare the local Antigravity scratch workspace.",
        ) from exc
    return root


class _ACPProcessClient:
    """Persistent ACP v1 stdio JSON-RPC 2.0 client supporting multiplexed sessions."""

    def __init__(
        self,
        command: tuple[str, ...],
        cwd: Path,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.loop = loop
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._session_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._stderr_tail: deque[str] = deque(maxlen=25)
        self._initialized = False
        self.cached_models: list[str] = []

    def is_alive(self) -> bool:
        return self.process is not None and self.process.returncode is None and self._initialized

    def stderr_summary(self) -> str:
        return " | ".join(line for line in self._stderr_tail if line).strip()

    async def ensure_started(self, *, timeout: float = 30.0) -> None:
        if self.is_alive():
            return
        async with self._start_lock:
            if self.is_alive():
                return
            await self._reset_process()
            kwargs: dict[str, Any] = {
                "cwd": str(self.cwd),
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                "stderr": asyncio.subprocess.PIPE,
                "limit": _STREAM_BUFFER_LIMIT,
            }
            if sys.platform == "win32":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                self.process = await asyncio.create_subprocess_exec(*self.command, **kwargs)
            except OSError as exc:
                raise ProviderUnavailableError(
                    provider="antigravity-acp",
                    public_detail="Could not start the local Antigravity CLI process.",
                ) from exc

            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
            try:
                await self.request(
                    "initialize",
                    {
                        "protocolVersion": 1,
                        "clientCapabilities": {},
                        "clientInfo": {"name": "companion-space", "version": "0.1"},
                    },
                    timeout=max(5.0, min(30.0, timeout)),
                )
            except Exception:
                await self._reset_process()
                raise
            self._initialized = True

    def register_session(self, session_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._session_queues[session_id] = queue
        return queue

    def unregister_session(self, session_id: str) -> None:
        self._session_queues.pop(session_id, None)

    def update_cached_models(self, payload: Any) -> list[str]:
        if not isinstance(payload, dict):
            return self.cached_models
        models_block = payload.get("models")
        if not isinstance(models_block, dict):
            return self.cached_models
        available = models_block.get("availableModels")
        if not isinstance(available, list):
            return self.cached_models
        ids: list[str] = []
        for entry in available:
            if isinstance(entry, dict):
                model_id = entry.get("modelId") or entry.get("id")
                if isinstance(model_id, str) and model_id.strip():
                    ids.append(model_id.strip())
        if ids:
            self.cached_models = list(dict.fromkeys(ids))
        return self.cached_models

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        if self.process is None or self.process.returncode is not None:
            raise _ProcessExitedError(
                self.process.returncode if self.process else None,
                self.stderr_summary(),
            )
        self._next_id += 1
        req_id = self._next_id
        future: asyncio.Future[dict[str, Any]] = self.loop.create_future()
        self._pending[req_id] = future
        try:
            await self._send({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params,
            })
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        if self.process is None or self.process.returncode is not None:
            return
        await self._send({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })

    async def _send(self, payload: dict[str, Any]) -> None:
        proc = self.process
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise _ProcessExitedError(
                proc.returncode if proc else None,
                self.stderr_summary(),
            )
        wire = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self._write_lock:
            try:
                proc.stdin.write(wire)
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                raise _ProcessExitedError(proc.returncode, self.stderr_summary()) from exc

    async def _reply_to_server_request(self, req_id: Any, method: str) -> None:
        if method == "session/request_permission":
            response: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"outcome": {"outcome": "cancelled"}},
            }
        else:
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": "Client does not support interactive requests in stateless mode.",
                },
            }
        try:
            await self._send(response)
        except Exception:
            return

    async def _read_stdout(self) -> None:
        proc = self.process
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                raw_line = await proc.stdout.readline()
                if not raw_line:
                    break
                text = raw_line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue

                if "id" in msg and "method" in msg:
                    asyncio.create_task(self._reply_to_server_request(msg["id"], str(msg["method"])))
                    continue

                if "id" in msg:
                    req_id = msg["id"]
                    future = self._pending.pop(req_id, None)
                    if future is not None and not future.done():
                        if "error" in msg and msg["error"] is not None:
                            future.set_exception(_RPCError(msg["error"]))
                        else:
                            result = msg.get("result")
                            future.set_result(result if isinstance(result, dict) else {})
                    continue

                if msg.get("method") == "session/update":
                    params = msg.get("params")
                    if isinstance(params, dict):
                        session_id = params.get("sessionId")
                        update = params.get("update")
                        if isinstance(session_id, str) and isinstance(update, dict):
                            queue = self._session_queues.get(session_id)
                            if queue is not None:
                                queue.put_nowait(update)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._stderr_tail.append(f"stdout_reader_error: {exc}")
        finally:
            self._initialized = False
            rc = proc.returncode
            err = _ProcessExitedError(rc, self.stderr_summary())
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(err)
            self._pending.clear()
            for queue in list(self._session_queues.values()):
                queue.put_nowait({"_eof": True, "returncode": rc, "stderr": self.stderr_summary()})

    async def _read_stderr(self) -> None:
        proc = self.process
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                raw_line = await proc.stderr.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line:
                    self._stderr_tail.append(line[:300])
        except asyncio.CancelledError:
            raise
        except Exception:
            return

    async def _reset_process(self) -> None:
        self._initialized = False
        proc = self.process
        self.process = None
        tasks = [t for t in (self._reader_task, self._stderr_task) if t is not None]
        self._reader_task = None
        self._stderr_task = None
        for task in tasks:
            if not task.done():
                task.cancel()
        if proc is not None:
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            if proc.returncode is None:
                try:
                    proc.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except TimeoutError:
                    try:
                        proc.kill()
                        await proc.wait()
                    except ProcessLookupError:
                        pass
            transport = getattr(proc, "_transport", None)
            if transport is not None:
                try:
                    transport.close()
                except Exception:
                    pass
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def terminate_sync(self) -> None:
        self._initialized = False
        proc = self.process
        self.process = None
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


_CLIENT_POOL: dict[tuple[tuple[str, ...], int], _ACPProcessClient] = {}


def _cleanup_all_processes() -> None:
    for client in list(_CLIENT_POOL.values()):
        client.terminate_sync()
    _CLIENT_POOL.clear()


atexit.register(_cleanup_all_processes)


async def aclose_all_acp_clients() -> None:
    loop = asyncio.get_running_loop()
    for key, client in list(_CLIENT_POOL.items()):
        if client.loop is loop and not loop.is_closed():
            await client._reset_process()
        else:
            client.terminate_sync()
        _CLIENT_POOL.pop(key, None)


def _get_client(command: tuple[str, ...], cwd: Path) -> _ACPProcessClient:
    loop = asyncio.get_running_loop()
    # Prune entries belonging to closed event loops.
    for key, existing in list(_CLIENT_POOL.items()):
        if existing.loop.is_closed():
            existing.terminate_sync()
            _CLIENT_POOL.pop(key, None)

    pool_key = (command, id(loop))
    client = _CLIENT_POOL.get(pool_key)
    if client is not None and client.loop is loop and client.cwd == cwd:
        return client
    if client is not None:
        client.terminate_sync()
    client = _ACPProcessClient(command, cwd, loop)
    _CLIENT_POOL[pool_key] = client
    return client


class AntigravityACPProvider(LLMProvider):
    name = "antigravity-acp"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        command_override: Sequence[str] | None = None,
        scratch_dir: Path | None = None,
    ) -> None:
        if timeout <= 0:
            raise ProviderConfigurationError(
                provider=self.name,
                public_detail="Timeout must be greater than zero.",
            )
        self.timeout = timeout
        self._command_override = tuple(command_override) if command_override is not None else None
        self._scratch_dir_override = scratch_dir

    def _resolve_command_and_cwd(self) -> tuple[tuple[str, ...], Path]:
        cwd = ensure_agy_scratch_dir(self._scratch_dir_override)
        if self._command_override is not None:
            return self._command_override, cwd
        executable = resolve_agy_executable()
        command = (
            executable,
            "acp",
            "--agent",
            _PURE_LLM_AGENT_NAME,
            "--include-default-customizations=false",
        )
        return command, cwd

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        if capability not in {None, ProviderCapability.chat_llm, ProviderCapability.analysis_llm}:
            return []
        command, cwd = self._resolve_command_and_cwd()
        client = _get_client(command, cwd)
        try:
            await client.ensure_started(timeout=min(30.0, self.timeout))
            if client.cached_models:
                return list(client.cached_models)
            session = await client.request(
                "session/new",
                {"cwd": str(cwd), "mcpServers": []},
                timeout=min(25.0, self.timeout),
            )
            models = client.update_cached_models(session)
            session_id = session.get("sessionId")
            if isinstance(session_id, str) and session_id:
                try:
                    await client.request("session/close", {"sessionId": session_id}, timeout=5.0)
                except Exception:
                    pass
            return list(models) if models else list(DEFAULT_ANTIGRAVITY_MODELS)
        except Exception as exc:
            raise self._map_error(exc, stderr=client.stderr_summary()) from None

    async def _stream_once(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        command, cwd = self._resolve_command_and_cwd()
        client = _get_client(command, cwd)
        deadline = monotonic() + request.timeout_s
        session_id: str | None = None
        queue: asyncio.Queue[dict[str, Any]] | None = None
        prompt_task: asyncio.Task[dict[str, Any]] | None = None
        get_task: asyncio.Task[dict[str, Any]] | None = None
        completed = False

        def remaining() -> float:
            left = deadline - monotonic()
            if left <= 0:
                raise TimeoutError("Antigravity ACP request timed out")
            return left

        try:
            await client.ensure_started(timeout=remaining())

            system_text = _build_system_prompt(request)
            new_params: dict[str, Any] = {
                "cwd": str(cwd),
                "mcpServers": [],
            }
            if system_text:
                new_params["_meta"] = {
                    "antigravity": {
                        "systemPrompt": {"append": system_text},
                    },
                }

            session = await client.request("session/new", new_params, timeout=remaining())
            raw_session_id = session.get("sessionId")
            if not isinstance(raw_session_id, str) or not raw_session_id:
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Antigravity CLI returned an invalid session identifier.",
                )
            session_id = raw_session_id
            client.update_cached_models(session)

            current_model = (
                session.get("models", {}).get("currentModelId")
                if isinstance(session.get("models"), dict)
                else None
            )
            if request.model and request.model != current_model:
                await client.request(
                    "session/set_model",
                    {"sessionId": session_id, "modelId": request.model},
                    timeout=remaining(),
                )

            prompt_blocks = _build_acp_prompt_blocks(request.messages, provider=self.name)
            queue = client.register_session(session_id)
            prompt_task = asyncio.create_task(
                client.request(
                    "session/prompt",
                    {"sessionId": session_id, "prompt": prompt_blocks},
                    timeout=remaining(),
                )
            )
            reasoning_filter = ThinkingFilter()

            while True:
                if get_task is None:
                    get_task = asyncio.create_task(queue.get())
                wait_left = remaining()
                done, _ = await asyncio.wait(
                    {prompt_task, get_task},
                    timeout=wait_left,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    raise TimeoutError("Antigravity ACP stream timed out")

                if get_task in done:
                    update = get_task.result()
                    get_task = None
                    if update.get("_eof"):
                        raise _ProcessExitedError(update.get("returncode"), str(update.get("stderr") or ""))
                    chunk = _translate_update(update, reasoning_filter)
                    if chunk is not None:
                        yield chunk

                if prompt_task in done:
                    if get_task is not None:
                        get_task.cancel()
                        try:
                            await get_task
                        except asyncio.CancelledError:
                            pass
                        get_task = None
                    # Drain any trailing notifications queued right before the RPC result.
                    while not queue.empty():
                        trailing = queue.get_nowait()
                        if trailing.get("_eof"):
                            continue
                        chunk = _translate_update(trailing, reasoning_filter)
                        if chunk is not None:
                            yield chunk

                    result = prompt_task.result()
                    completed = True
                    tail_visible, tail_hidden = reasoning_filter.finish()
                    finish_reason = _map_stop_reason(result.get("stopReason"))
                    usage = _extract_acp_usage(result.get("usage"))
                    if tail_visible or tail_hidden or finish_reason or usage:
                        yield StreamChunk(
                            text=tail_visible,
                            reasoning=tail_hidden,
                            finish_reason=finish_reason,
                            usage=usage,
                        )
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise self._map_error(exc, stderr=client.stderr_summary()) from None
        finally:
            if get_task is not None and not get_task.done():
                get_task.cancel()
                try:
                    await get_task
                except (asyncio.CancelledError, Exception):
                    pass
            if prompt_task is not None and not prompt_task.done():
                if session_id is not None:
                    try:
                        await asyncio.shield(
                            asyncio.wait_for(
                                client.notify("session/cancel", {"sessionId": session_id}),
                                timeout=2.0,
                            )
                        )
                    except (asyncio.CancelledError, Exception):
                        pass
                prompt_task.cancel()
                try:
                    await prompt_task
                except (asyncio.CancelledError, Exception):
                    pass
            if session_id is not None:
                client.unregister_session(session_id)
                if client.is_alive():
                    try:
                        await asyncio.shield(
                            client.request("session/close", {"sessionId": session_id}, timeout=2.0)
                        )
                    except (asyncio.CancelledError, Exception):
                        pass
            if not completed and not client.is_alive():
                # Ensure a dead/broken subprocess is cleaned before the next call.
                try:
                    await asyncio.shield(client._reset_process())
                except (asyncio.CancelledError, Exception):
                    pass

    def _map_error(self, exc: Exception, *, stderr: str = "") -> ProviderError:
        if isinstance(exc, ProviderError):
            return exc
        if isinstance(exc, TimeoutError):
            return ProviderTimeoutError(
                provider=self.name,
                public_detail="Antigravity CLI request timed out. Please retry.",
            )
        if isinstance(exc, _ProcessExitedError):
            combined = f"{exc.stderr_tail} {stderr}".lower()
            if _looks_like_auth_error(combined):
                return AntigravityLoginRequiredError(
                    provider=self.name,
                    public_detail="Antigravity CLI is not signed in. Run `agy` once to sign in.",
                )
            return ProviderUnavailableError(
                provider=self.name,
                public_detail="Antigravity CLI process exited unexpectedly. Please retry.",
            )
        if isinstance(exc, _RPCError):
            details = f"{exc.message} {exc.data or ''} {stderr}".lower()
            if _looks_like_auth_error(details):
                return AntigravityLoginRequiredError(
                    provider=self.name,
                    public_detail="Antigravity CLI is not signed in. Run `agy` once to sign in.",
                )
            if _looks_like_rate_limit(details):
                return ProviderRateLimitError(
                    provider=self.name,
                    public_detail="Antigravity subscription rate limit reached. Please retry later.",
                )
            if "timeout" in details or "deadline" in details:
                return ProviderTimeoutError(
                    provider=self.name,
                    public_detail="Antigravity CLI request timed out. Please retry.",
                )
            if "model" in details and ("not found" in details or "unknown" in details or "invalid" in details):
                return ProviderConfigurationError(
                    provider=self.name,
                    public_detail="Selected Antigravity model is unavailable. Refresh the model list.",
                )
            return ProviderProtocolError(
                provider=self.name,
                public_detail="Antigravity CLI returned an error response.",
            )
        return ProviderProtocolError(
            provider=self.name,
            public_detail="Antigravity CLI request failed.",
        )


def _build_system_prompt(request: LLMRequest) -> str:
    parts: list[str] = []
    if request.system.strip():
        parts.append(request.system.strip())
    if request.json_object:
        parts.append("Return only a valid JSON object without markdown fences or extra text.")
    if request.stop:
        joined = ", ".join(repr(item) for item in request.stop[:6])
        parts.append(f"Stop generating immediately before emitting any of: {joined}.")
    return "\n\n".join(parts)


def _build_acp_prompt_blocks(messages: list[Message], *, provider: str) -> list[dict[str, Any]]:
    if len(messages) == 1 and messages[0].role == "user":
        return _content_to_acp_blocks(messages[0].content, provider=provider)

    blocks: list[dict[str, Any]] = []
    history_lines: list[str] = []
    prior = messages[:-1]
    latest = messages[-1]

    for message in prior:
        role_label = "User" if message.role == "user" else "Assistant"
        if isinstance(message.content, str):
            history_lines.append(f"[{role_label}]: {message.content}")
        else:
            text_fragments: list[str] = []
            for part in message.content:
                if part["type"] == "image":
                    blocks.append(_image_part_to_acp_block(part, provider=provider))
                    text_fragments.append("[image]")
                else:
                    text_fragments.append(part.get("text", ""))
            history_lines.append(f"[{role_label}]: {''.join(text_fragments)}")

    if history_lines:
        blocks.append({
            "type": "text",
            "text": "Conversation history:\n" + "\n".join(history_lines) + "\n\nCurrent message:",
        })
    blocks.extend(_content_to_acp_blocks(latest.content, provider=provider))
    return blocks


def _content_to_acp_blocks(
    content: str | list[dict[str, Any]],
    *,
    provider: str,
) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    blocks: list[dict[str, Any]] = []
    for part in content:
        if part["type"] == "image":
            blocks.append(_image_part_to_acp_block(part, provider=provider))
        else:
            blocks.append({"type": "text", "text": part.get("text", "")})
    return blocks


def _image_part_to_acp_block(part: dict[str, Any], *, provider: str) -> dict[str, Any]:
    encoded = part.get("image_b64")
    mime = part.get("mime")
    if not isinstance(encoded, str) or not encoded or not isinstance(mime, str) or not mime:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="An image needs bytes and a MIME type.",
        )
    return {"type": "image", "data": encoded, "mimeType": mime}


def _translate_update(update: dict[str, Any], reasoning_filter: ThinkingFilter) -> StreamChunk | None:
    kind = update.get("sessionUpdate")
    content = update.get("content")
    if not isinstance(content, dict) or content.get("type") != "text":
        return None
    text = content.get("text")
    if not isinstance(text, str) or not text:
        return None
    if kind == "agent_message_chunk":
        visible, hidden = reasoning_filter.feed(text)
        if visible or hidden:
            return StreamChunk(text=visible, reasoning=hidden)
    elif kind == "agent_thought_chunk":
        return StreamChunk(reasoning=text)
    return None


def _map_stop_reason(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw:
        return "stop"
    lowered = raw.lower()
    if lowered in {"end_turn", "stop"}:
        return "stop"
    if lowered in {"max_tokens", "length"}:
        return "length"
    return lowered


def _extract_acp_usage(raw: Any) -> Usage | None:
    if not isinstance(raw, dict):
        return None
    input_tokens = _nonneg_int(raw.get("inputTokens"))
    output_tokens = _nonneg_int(raw.get("outputTokens"))
    if input_tokens is None and output_tokens is None:
        return None
    return Usage(input_tokens=input_tokens, output_tokens=output_tokens)


def _nonneg_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _looks_like_auth_error(text: str) -> bool:
    markers = (
        "authentication required",
        "not authenticated",
        "unauthenticated",
        "not logged in",
        "not signed in",
        "login required",
        "sign in",
        "oauth",
        "credential",
        "401",
    )
    return any(marker in text for marker in markers)


def _looks_like_rate_limit(text: str) -> bool:
    markers = ("rate limit", "too many requests", "quota", "resource_exhausted", "429")
    return any(marker in text for marker in markers)
