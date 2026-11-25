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
DEFAULT_CODEX_MODELS: tuple[str, ...] = (
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-6.1-terra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
)
_STREAM_BUFFER_LIMIT = 8 * 1024 * 1024


class CodexLoginRequiredError(ProviderAuthenticationError):
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
        super().__init__(f"Codex app-server exited with code {returncode}: {stderr_tail}")


def resolve_codex_executable() -> str:
    env_path = os.environ.get("CODEX_CLI_PATH", "").strip()
    if env_path:
        candidate = Path(env_path)
        if candidate.is_file():
            return str(candidate)
        raise ProviderUnavailableError(
            provider="codex-app-server",
            public_detail="Configured CODEX_CLI_PATH executable was not found.",
        )

    found = shutil.which("codex")
    if found:
        return found

    if sys.platform == "win32":
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        windows_apps = program_files / "WindowsApps"
        try:
            matches = sorted(
                windows_apps.glob("OpenAI.Codex_*/app/resources/codex.exe"),
                reverse=True,
            )
            for match in matches:
                if match.is_file():
                    return str(match)
        except OSError:
            pass

    raise ProviderUnavailableError(
        provider="codex-app-server",
        public_detail="Codex CLI is not installed on this machine.",
    )


def ensure_codex_scratch_dir(scratch_dir: Path | None = None) -> Path:
    root = scratch_dir or (Path(tempfile.gettempdir()) / "companion-space-codex-scratch")
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ProviderUnavailableError(
            provider="codex-app-server",
            public_detail="Could not prepare the local Codex scratch directory.",
        ) from exc
    return root


class _CodexAppServerClient:
    """Persistent `codex app-server --stdio` JSON-RPC client supporting concurrent threads."""

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
        self._thread_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._stderr_tail: deque[str] = deque(maxlen=25)
        self._initialized = False

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
                    provider="codex-app-server",
                    public_detail="Could not start the local Codex app-server process.",
                ) from exc

            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
            try:
                await self.request(
                    "initialize",
                    {"clientInfo": {"name": "companion-space", "version": "0.1"}},
                    timeout=max(5.0, min(30.0, timeout)),
                )
                await self.notify("initialized", {})
            except Exception:
                await self._reset_process()
                raise
            self._initialized = True

    def register_thread(self, thread_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._thread_queues[thread_id] = queue
        return queue

    def unregister_thread(self, thread_id: str) -> None:
        self._thread_queues.pop(thread_id, None)

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
        if "approval" in method.lower():
            response: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"decision": "decline"},
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

                method = msg.get("method")
                params = msg.get("params")
                if isinstance(method, str) and isinstance(params, dict):
                    thread_id = _extract_thread_id(params)
                    if thread_id is not None:
                        queue = self._thread_queues.get(thread_id)
                        if queue is not None:
                            queue.put_nowait({"method": method, "params": params})
                    elif method == "error":
                        for queue in list(self._thread_queues.values()):
                            queue.put_nowait({"method": method, "params": params})
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
            for queue in list(self._thread_queues.values()):
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


_CLIENT_POOL: dict[tuple[tuple[str, ...], int], _CodexAppServerClient] = {}


def _cleanup_all_processes() -> None:
    for client in list(_CLIENT_POOL.values()):
        client.terminate_sync()
    _CLIENT_POOL.clear()


atexit.register(_cleanup_all_processes)


async def aclose_all_codex_clients() -> None:
    loop = asyncio.get_running_loop()
    for key, client in list(_CLIENT_POOL.items()):
        if client.loop is loop and not loop.is_closed():
            await client._reset_process()
        else:
            client.terminate_sync()
        _CLIENT_POOL.pop(key, None)


def _get_client(command: tuple[str, ...], cwd: Path) -> _CodexAppServerClient:
    loop = asyncio.get_running_loop()
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
    client = _CodexAppServerClient(command, cwd, loop)
    _CLIENT_POOL[pool_key] = client
    return client


class CodexAppServerProvider(LLMProvider):
    name = "codex-app-server"

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
        cwd = ensure_codex_scratch_dir(self._scratch_dir_override)
        if self._command_override is not None:
            return self._command_override, cwd
        executable = resolve_codex_executable()
        return (executable, "app-server", "--stdio"), cwd

    async def discover_models(self, capability: ProviderCapability | None = None) -> list[str]:
        if capability not in {None, ProviderCapability.chat_llm, ProviderCapability.analysis_llm}:
            return []
        command, cwd = self._resolve_command_and_cwd()
        client = _get_client(command, cwd)
        try:
            await client.ensure_started(timeout=min(30.0, self.timeout))
            result = await client.request("model/list", {}, timeout=min(20.0, self.timeout))
            raw_list = result.get("data") or result.get("models") or []
            models: list[str] = []
            if isinstance(raw_list, list):
                for entry in raw_list:
                    if isinstance(entry, str) and entry.strip():
                        models.append(entry.strip())
                    elif isinstance(entry, dict):
                        model_id = entry.get("id") or entry.get("model") or entry.get("slug")
                        if isinstance(model_id, str) and model_id.strip():
                            models.append(model_id.strip())
            return list(dict.fromkeys(models)) if models else list(DEFAULT_CODEX_MODELS)
        except Exception as exc:
            raise self._map_error(exc, stderr=client.stderr_summary()) from None

    async def _stream_once(self, request: LLMRequest) -> AsyncIterator[StreamChunk]:
        command, cwd = self._resolve_command_and_cwd()
        client = _get_client(command, cwd)
        deadline = monotonic() + request.timeout_s
        thread_id: str | None = None
        turn_id: str | None = None
        completed = False

        def remaining() -> float:
            left = deadline - monotonic()
            if left <= 0:
                raise TimeoutError("Codex app-server request timed out")
            return left

        try:
            await client.ensure_started(timeout=remaining())

            instructions = _build_instructions(request)
            thread_params: dict[str, Any] = {
                "cwd": str(cwd),
                "ephemeral": True,
                "sandbox": "read-only",
                "approvalPolicy": "never",
            }
            if instructions:
                thread_params["baseInstructions"] = instructions

            thread_res = await client.request("thread/start", thread_params, timeout=remaining())
            raw_tid = (
                thread_res.get("thread", {}).get("id")
                if isinstance(thread_res.get("thread"), dict)
                else None
            ) or thread_res.get("threadId")
            if not isinstance(raw_tid, str) or not raw_tid:
                raise ProviderProtocolError(
                    provider=self.name,
                    public_detail="Codex app-server returned an invalid thread identifier.",
                )
            thread_id = raw_tid
            queue = client.register_thread(thread_id)

            input_blocks = _build_codex_input(request.messages, provider=self.name)
            raw_effort = request.extra_body.get("effort")
            effort = str(raw_effort) if isinstance(raw_effort, str) and raw_effort.strip() else "low"
            turn_params: dict[str, Any] = {
                "threadId": thread_id,
                "model": request.model,
                "effort": effort,
                "input": input_blocks,
            }
            turn_res = await client.request("turn/start", turn_params, timeout=remaining())
            raw_turn_id = (
                turn_res.get("turn", {}).get("id")
                if isinstance(turn_res.get("turn"), dict)
                else None
            ) or turn_res.get("turnId")
            turn_id = raw_turn_id if isinstance(raw_turn_id, str) and raw_turn_id else None

            reasoning_filter = ThinkingFilter()
            latest_usage: Usage | None = None

            while True:
                event = await asyncio.wait_for(queue.get(), timeout=remaining())
                if event.get("_eof"):
                    raise _ProcessExitedError(event.get("returncode"), str(event.get("stderr") or ""))

                method = event.get("method")
                params = event.get("params") if isinstance(event.get("params"), dict) else {}

                if method == "item/agentMessage/delta":
                    delta = params.get("delta")
                    if isinstance(delta, str) and delta:
                        visible, hidden = reasoning_filter.feed(delta)
                        if visible or hidden:
                            yield StreamChunk(text=visible, reasoning=hidden)
                elif method in {"item/reasoning/summaryTextDelta", "item/reasoning/textDelta"}:
                    delta = params.get("delta")
                    if isinstance(delta, str) and delta:
                        yield StreamChunk(reasoning=delta)
                elif method == "thread/tokenUsage/updated":
                    parsed_usage = _extract_codex_usage(params)
                    if parsed_usage is not None:
                        latest_usage = parsed_usage
                elif method == "turn/completed":
                    completed = True
                    turn = params.get("turn") if isinstance(params.get("turn"), dict) else params
                    status = str(turn.get("status") or "completed").lower()
                    turn_error = turn.get("error")
                    if status == "failed" or turn_error:
                        raise _RPCError(turn_error or {"message": "Codex turn failed"})
                    tail_visible, tail_hidden = reasoning_filter.finish()
                    finish_reason = "cancelled" if status == "interrupted" else "stop"
                    if tail_visible or tail_hidden or finish_reason or latest_usage:
                        yield StreamChunk(
                            text=tail_visible,
                            reasoning=tail_hidden,
                            finish_reason=finish_reason,
                            usage=latest_usage,
                        )
                    break
                elif method == "error":
                    if params.get("willRetry") is True:
                        continue
                    raise _RPCError(params.get("error") or params)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise self._map_error(exc, stderr=client.stderr_summary()) from None
        finally:
            if thread_id is not None:
                if not completed and turn_id is not None and client.is_alive():
                    try:
                        await asyncio.shield(
                            client.request(
                                "turn/interrupt",
                                {"threadId": thread_id, "turnId": turn_id},
                                timeout=2.0,
                            )
                        )
                    except (asyncio.CancelledError, Exception):
                        pass
                client.unregister_thread(thread_id)
            if not completed and not client.is_alive():
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
                public_detail="Codex CLI request timed out. Please retry.",
            )
        if isinstance(exc, _ProcessExitedError):
            combined = f"{exc.stderr_tail} {stderr}".lower()
            if _looks_like_auth_error(combined):
                return CodexLoginRequiredError(
                    provider=self.name,
                    public_detail="Codex CLI is not signed in. Run `codex login` once to sign in.",
                )
            return ProviderUnavailableError(
                provider=self.name,
                public_detail="Codex app-server process exited unexpectedly. Please retry.",
            )
        if isinstance(exc, _RPCError):
            details = f"{exc.message} {exc.data or ''} {stderr}".lower()
            if _looks_like_auth_error(details):
                return CodexLoginRequiredError(
                    provider=self.name,
                    public_detail="Codex CLI is not signed in. Run `codex login` once to sign in.",
                )
            if _looks_like_rate_limit(details):
                return ProviderRateLimitError(
                    provider=self.name,
                    public_detail="ChatGPT / Codex rate limit reached. Please retry later.",
                )
            if "timeout" in details or "deadline" in details:
                return ProviderTimeoutError(
                    provider=self.name,
                    public_detail="Codex CLI request timed out. Please retry.",
                )
            if "model" in details and ("not found" in details or "unknown" in details or "unsupported" in details):
                return ProviderConfigurationError(
                    provider=self.name,
                    public_detail="Selected Codex model is unavailable. Refresh the model list.",
                )
            return ProviderProtocolError(
                provider=self.name,
                public_detail="Codex app-server returned an error response.",
            )
        return ProviderProtocolError(
            provider=self.name,
            public_detail="Codex app-server request failed.",
        )


def _extract_thread_id(params: dict[str, Any]) -> str | None:
    direct = params.get("threadId")
    if isinstance(direct, str) and direct:
        return direct
    for key in ("thread", "turn"):
        nested = params.get(key)
        if isinstance(nested, dict):
            candidate = nested.get("threadId") or (nested.get("id") if key == "thread" else None)
            if isinstance(candidate, str) and candidate:
                return candidate
    return None


def _build_instructions(request: LLMRequest) -> str:
    parts: list[str] = []
    if request.system.strip():
        parts.append(request.system.strip())
    if request.json_object:
        parts.append("Return only a valid JSON object without markdown fences or extra text.")
    if request.stop:
        joined = ", ".join(repr(item) for item in request.stop[:6])
        parts.append(f"Stop generating immediately before emitting any of: {joined}.")
    return "\n\n".join(parts)


def _build_codex_input(messages: list[Message], *, provider: str) -> list[dict[str, Any]]:
    if len(messages) == 1 and messages[0].role == "user":
        return _content_to_codex_blocks(messages[0].content, provider=provider)

    blocks: list[dict[str, Any]] = []
    history_lines: list[str] = []
    for message in messages[:-1]:
        role_label = "User" if message.role == "user" else "Assistant"
        if isinstance(message.content, str):
            history_lines.append(f"[{role_label}]: {message.content}")
        else:
            fragments: list[str] = []
            for part in message.content:
                if part["type"] == "image":
                    blocks.append(_image_part_to_codex_block(part, provider=provider))
                    fragments.append("[image]")
                else:
                    fragments.append(part.get("text", ""))
            history_lines.append(f"[{role_label}]: {''.join(fragments)}")

    if history_lines:
        blocks.append({
            "type": "text",
            "text": "Conversation history:\n" + "\n".join(history_lines) + "\n\nCurrent message:",
        })
    blocks.extend(_content_to_codex_blocks(messages[-1].content, provider=provider))
    return blocks


def _content_to_codex_blocks(
    content: str | list[dict[str, Any]],
    *,
    provider: str,
) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    blocks: list[dict[str, Any]] = []
    for part in content:
        if part["type"] == "image":
            blocks.append(_image_part_to_codex_block(part, provider=provider))
        else:
            blocks.append({"type": "text", "text": part.get("text", "")})
    return blocks


def _image_part_to_codex_block(part: dict[str, Any], *, provider: str) -> dict[str, Any]:
    encoded = part.get("image_b64")
    mime = part.get("mime")
    if not isinstance(encoded, str) or not encoded or not isinstance(mime, str) or not mime:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="An image needs bytes and a MIME type.",
        )
    return {"type": "image", "url": f"data:{mime};base64,{encoded}"}


def _extract_codex_usage(params: dict[str, Any]) -> Usage | None:
    token_usage = params.get("tokenUsage") if isinstance(params.get("tokenUsage"), dict) else params
    bucket = (
        token_usage.get("last")
        if isinstance(token_usage.get("last"), dict)
        else token_usage.get("total")
        if isinstance(token_usage.get("total"), dict)
        else token_usage
    )
    if not isinstance(bucket, dict):
        return None
    input_tokens = _nonneg_int(bucket.get("inputTokens") or bucket.get("input_tokens"))
    output_tokens = _nonneg_int(bucket.get("outputTokens") or bucket.get("output_tokens"))
    if input_tokens is None and output_tokens is None:
        return None
    return Usage(input_tokens=input_tokens, output_tokens=output_tokens)


def _nonneg_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _looks_like_auth_error(text: str) -> bool:
    markers = (
        "authentication",
        "unauthenticated",
        "not logged in",
        "not signed in",
        "login required",
        "sign in",
        "unauthorized",
        "401",
    )
    return any(marker in text for marker in markers)


def _looks_like_rate_limit(text: str) -> bool:
    markers = ("rate limit", "too many requests", "quota", "usage limit", "429")
    return any(marker in text for marker in markers)
