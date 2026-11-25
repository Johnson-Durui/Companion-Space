from __future__ import annotations

import asyncio
import base64
import sqlite3
import struct
import threading
import zlib
from contextlib import aclosing
from dataclasses import dataclass
from datetime import datetime, timezone
from time import monotonic
from uuid import uuid4

from pydantic import BaseModel, TypeAdapter

from app.core.errors import CodedValueError, ResourceNotFoundError
from app.llm.presets import Role, RoleAssignment, get_preset
from app.models.domain import ModelAssignment, ProviderCapability, ProviderConnection
from app.providers.base import LLMProvider, LLMRequest, Message, ProviderAdapter
from app.providers.errors import (
    MissingRoleError,
    ProviderConfigurationError,
    ProviderError,
    ProviderProtocolError,
    provider_error_code,
)
from app.providers.factory import (
    ELEVENLABS_DEFAULT_BASE_URL,
    GEMINI_DEFAULT_BASE_URL,
    build_provider_adapter,
)
from app.providers.url_policy import is_local_endpoint, validate as validate_url
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService


class _Unset:
    pass


UNSET = _Unset()

_TEXT_CAPABILITIES = (ProviderCapability.chat_llm, ProviderCapability.analysis_llm)
_CAPABILITIES = {
    "openai-compatible": (*_TEXT_CAPABILITIES, ProviderCapability.embedding, ProviderCapability.stt, ProviderCapability.tts),
    "ollama": (*_TEXT_CAPABILITIES, ProviderCapability.embedding),
    "lm-studio": (*_TEXT_CAPABILITIES, ProviderCapability.embedding),
    "anthropic": _TEXT_CAPABILITIES,
    "gemini": (*_TEXT_CAPABILITIES, ProviderCapability.embedding),
    "antigravity-acp": _TEXT_CAPABILITIES,
    "codex-app-server": _TEXT_CAPABILITIES,
    "elevenlabs": (ProviderCapability.tts,),
    "local-neural": (ProviderCapability.tts,),
}
_NO_KEY_PROVIDERS = {"local-neural", "antigravity-acp", "codex-app-server"}
_NO_URL_PROVIDERS = {"antigravity-acp", "codex-app-server"}
_OPTIONAL_KEY = {"ollama", "lm-studio", *_NO_KEY_PROVIDERS}
_NATIVE_BASES = {"gemini": GEMINI_DEFAULT_BASE_URL, "elevenlabs": ELEVENLABS_DEFAULT_BASE_URL}
_ROLE_CAPABILITIES: dict[Role, ProviderCapability] = {
    "live": ProviderCapability.chat_llm,
    "analysis": ProviderCapability.analysis_llm,
    "checker": ProviderCapability.analysis_llm,
    "vision": ProviderCapability.chat_llm,
    "embedding": ProviderCapability.embedding,
    "tts": ProviderCapability.tts,
    "stt": ProviderCapability.stt,
}
_ROLE_MAP = TypeAdapter(dict[Role, RoleAssignment])
PROVIDER_SPEECH_PREVIEW_MAX_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class ResolvedProvider:
    assignment: ModelAssignment
    connection: ProviderConnection
    adapter: ProviderAdapter


@dataclass(frozen=True)
class ResolvedRole:
    assignment: RoleAssignment
    connection: ProviderConnection
    adapter: ProviderAdapter
    using_analysis_fallback: bool = False


class RoleTestResult(BaseModel):
    role: Role
    ok: bool
    latency_ms: int
    code: str | None = None
    message: str | None = None


def _read_roles(conn: sqlite3.Connection) -> dict[Role, RoleAssignment]:
    row = conn.execute("SELECT value_json FROM app_settings WHERE key = 'model_roles'").fetchone()
    return _ROLE_MAP.validate_json(row[0]) if row else {}


def _write_roles(conn: sqlite3.Connection, roles: dict[Role, RoleAssignment]) -> None:
    conn.execute(
        """
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES ('model_roles', ?, ?)
        ON CONFLICT(key) DO UPDATE
        SET value_json = excluded.value_json, updated_at = excluded.updated_at
        """,
        (_ROLE_MAP.dump_json(roles).decode(), datetime.now(timezone.utc).isoformat()),
    )


def _requires_key(provider: str, base_url: str | None) -> bool:
    if provider == "openai-compatible":
        return not is_local_endpoint(base_url)
    return provider not in _OPTIONAL_KEY


def _base_url(base_url: str | None, provider: str) -> str | None:
    if base_url is None:
        return None
    if provider in _NO_URL_PROVIDERS:
        if not base_url.strip():
            return None
        raise ProviderConfigurationError(
            provider=provider, public_detail="This local CLI connection does not use a base URL.",
        )
    result = validate_url(base_url, provider=provider)
    native = _NATIVE_BASES.get(provider)
    if native is not None and result != native:
        raise ProviderConfigurationError(
            provider=provider, public_detail="Use this provider's native endpoint.",
        )
    return result


def _probe_timeout_s(params: dict[str, object], *, default: float = 12.0) -> float:
    raw = params.get("probe_timeout_s")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(max(5.0, min(60.0, raw)))
    return default


class ProviderRegistryService:
    def __init__(self, repository: SQLiteRepository, vault: VaultService) -> None:
        self.repository = repository
        self.vault = vault
        self._write_lock = threading.RLock()

    async def aclose(self) -> None:
        """Adapters close streams and clients at the end of each request."""

    def close(self) -> None:
        """Adapters do not retain clients between requests."""

    def list_connections(self) -> list[dict]:
        return [connection.model_dump() for connection in self.repository.list_provider_connections()]

    def get_connection(self, connection_id: str) -> dict | None:
        connection = self.repository.get_provider_connection(connection_id)
        return connection.model_dump() if connection is not None else None

    def save_connection(
        self,
        *,
        provider: str | None = None,
        label: str | None = None,
        api_key: str = "",
        base_url: str | None = None,
        preset_id: str | None = None,
    ) -> dict:
        preset = get_preset(preset_id) if preset_id is not None else None
        if preset is not None:
            if provider is not None and provider != preset.adapter:
                raise CodedValueError("provider_preset_mismatch", "This preset uses a different provider adapter.")
            provider = preset.adapter
            label = label or preset.label
            base_url = base_url if base_url is not None else preset.base_url
            if preset.id == "custom" and base_url is None:
                raise CodedValueError("provider_base_url_required", "Enter this connection's base URL.")
        if provider not in _CAPABILITIES:
            raise CodedValueError("provider_unsupported", "Select a supported provider.")
        if not label or not label.strip():
            raise CodedValueError("provider_label_required", "Enter a name for the connection.")
        base_url = _base_url(base_url, provider)
        api_key = api_key.strip()
        if _requires_key(provider, base_url) and not api_key:
            raise CodedValueError("provider_api_key_required", "Enter an API key for this connection.")
        if provider in _NO_KEY_PROVIDERS and api_key:
            raise CodedValueError("provider_api_key_not_supported", "This local connection does not accept an API key.")
        now = datetime.now(timezone.utc)
        connection = ProviderConnection(
            id=str(uuid4()), provider=provider, label=label.strip(),
            base_url=base_url, capabilities=list(_CAPABILITIES[provider]),
            created_at=now, updated_at=now,
        )
        with self._write_lock:
            if api_key:
                self.vault.put_provider_secret(connection.id, api_key)
            saved = False
            try:
                self.repository.upsert_provider_connection(connection)
                saved = True
                if preset is not None:
                    with self.repository.connection() as conn:
                        conn.execute("BEGIN IMMEDIATE")
                        roles = _read_roles(conn)
                        for role, model in preset.models.items():
                            if model and role not in roles:
                                roles[role] = RoleAssignment(
                                    connection_id=connection.id, model=model, params=preset.params.get(role, {}),
                                )
                        _write_roles(conn, roles)
            except Exception:
                if saved:
                    self.repository.delete_provider_connection(connection.id)
                if api_key:
                    self.vault.delete_provider_secret(connection.id)
                raise
        return connection.model_dump()

    def update_connection(
        self,
        connection_id: str,
        *,
        label: str | None = None,
        base_url: str | None | _Unset = UNSET,
        api_key: str | None = None,
    ) -> dict:
        with self._write_lock:
            existing = self._require_connection(connection_id)
            fields = {}
            if label is not None:
                if not label.strip():
                    raise CodedValueError("provider_label_required", "Enter a name for the connection.")
                fields["label"] = label.strip()
            if not isinstance(base_url, _Unset):
                fields["base_url"] = _base_url(base_url, existing.provider)
            old_secret = None
            if "base_url" in fields and api_key is None and _requires_key(existing.provider, fields["base_url"]):
                if not self.vault.get_provider_secret(connection_id):
                    raise CodedValueError("provider_api_key_required", "Enter an API key for this connection.")
            if api_key is not None:
                api_key = api_key.strip()
                if not api_key or existing.provider in _NO_KEY_PROVIDERS:
                    raise CodedValueError("provider_api_key_not_supported", "Enter a key for a connection that accepts API keys.")
                old_secret = self.vault.get_provider_secret(connection_id)
                self.vault.put_provider_secret(connection_id, api_key)
            try:
                if fields or api_key is not None:
                    fields["updated_at"] = datetime.now(timezone.utc)
                    existing = self.repository.upsert_provider_connection(existing.model_copy(update=fields))
            except Exception:
                if api_key is not None:
                    if old_secret is None:
                        self.vault.delete_provider_secret(connection_id)
                    else:
                        self.vault.put_provider_secret(connection_id, old_secret)
                raise
        return existing.model_dump()

    def delete_connection(self, connection_id: str) -> bool:
        with self._write_lock:
            if self.repository.get_provider_connection(connection_id) is None:
                return False
            secret = self.vault.get_provider_secret(connection_id)
            if secret is not None:
                self.vault.delete_provider_secret(connection_id)
            try:
                with self.repository.connection() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    roles = _read_roles(conn)
                    _write_roles(conn, {
                        role: assignment for role, assignment in roles.items()
                        if assignment.connection_id != connection_id
                    })
                    conn.execute("DELETE FROM provider_connections WHERE id = ?", (connection_id,))
            except Exception:
                if secret is not None:
                    self.vault.put_provider_secret(connection_id, secret)
                raise
        return True

    def get_roles(self) -> dict[Role, RoleAssignment]:
        with self.repository.connection() as conn:
            return _read_roles(conn)

    def set_roles(self, roles: dict[Role, RoleAssignment]) -> dict[Role, RoleAssignment]:
        roles = _ROLE_MAP.validate_python(roles)
        with self._write_lock:
            for role, assignment in roles.items():
                connection = self._require_connection(assignment.connection_id)
                self._ensure_capability(connection, _ROLE_CAPABILITIES[role])
            with self.repository.connection() as conn:
                _write_roles(conn, roles)
        return roles

    def resolve_role(self, role: Role) -> ResolvedRole:
        roles = self.get_roles()
        assignment = roles.get(role)
        using_analysis_fallback = role == "checker" and assignment is None
        if using_analysis_fallback:
            assignment = roles.get("analysis")
        if assignment is None:
            raise MissingRoleError(
                provider="connection", public_detail=f"Connect a model for {role} in Settings.",
            )
        connection = self._require_connection(assignment.connection_id)
        self._ensure_capability(connection, _ROLE_CAPABILITIES[role])
        return ResolvedRole(assignment, connection, self._build_adapter(connection), using_analysis_fallback)

    async def discover_models(
        self, connection_id: str, capability: ProviderCapability | None = None,
    ) -> list[str]:
        def build_adapter() -> ProviderAdapter:
            connection = self._require_connection(connection_id)
            if capability is not None:
                self._ensure_capability(connection, capability)
            return self._build_adapter(connection)

        adapter = await asyncio.to_thread(build_adapter)
        return await adapter.discover_models(capability)

    async def test_connection(self, connection_id: str) -> list[RoleTestResult]:
        connection = await asyncio.to_thread(self._require_connection, connection_id)
        roles = await asyncio.to_thread(self.get_roles)
        selected = [(role, binding) for role, binding in roles.items() if binding.connection_id == connection_id]
        if not selected:
            raise MissingRoleError(provider="connection", public_detail="Assign a model role before testing.")

        async def probe(role: Role, assignment: RoleAssignment) -> RoleTestResult:
            started = monotonic()
            outer_timeout = max(20.0, _probe_timeout_s(assignment.params, default=12.0) + 8.0)
            try:
                async with asyncio.timeout(outer_timeout):
                    adapter = await asyncio.to_thread(self._build_adapter, connection)
                    message = await _probe_role(adapter, role, assignment)
            except ProviderError as error:
                return RoleTestResult(
                    role=role, ok=False, latency_ms=round((monotonic() - started) * 1000),
                    code=provider_error_code(error), message=error.public_detail,
                )
            except TimeoutError:
                return RoleTestResult(
                    role=role, ok=False, latency_ms=round((monotonic() - started) * 1000),
                    code="provider_timeout", message="The connection test timed out.",
                )
            return RoleTestResult(
                role=role,
                ok=True,
                latency_ms=round((monotonic() - started) * 1000),
                code="stt_verified_silent" if message else "ok",
                message=message,
            )

        return await asyncio.gather(*(probe(role, binding) for role, binding in selected))

    async def preview_speech(
        self, connection_id: str, *, model: str, text: str, voice_id: str, speaking_rate: float,
    ) -> bytes:
        def prepare() -> ProviderAdapter:
            connection = self._require_connection(connection_id)
            self._ensure_capability(connection, ProviderCapability.tts)
            return self._build_adapter(connection)

        adapter = await asyncio.to_thread(prepare)
        return await _collect_speech(adapter, model=model, text=text, voice_id=voice_id, speed=speaking_rate)

    def save_assignment(
        self, *, space_id: str, capability: ProviderCapability,
        provider_connection_id: str, model_name: str,
    ) -> ModelAssignment:
        if self.repository.get_space(space_id) is None:
            raise ResourceNotFoundError("Study space not found.")
        connection = self._require_connection(provider_connection_id)
        self._ensure_capability(connection, capability)
        if not model_name.strip():
            raise CodedValueError("provider_model_required", "Enter a model name.")
        now = datetime.now(timezone.utc)
        existing = self._find_assignment(space_id, capability)
        return self.repository.upsert_model_assignment(ModelAssignment(
            id=existing.id if existing else str(uuid4()),
            space_id=space_id, capability=capability, provider_connection_id=provider_connection_id,
            model_name=model_name.strip(), created_at=existing.created_at if existing else now, updated_at=now,
        ))

    def delete_assignment(self, *, space_id: str, capability: ProviderCapability) -> bool:
        if self.repository.get_space(space_id) is None:
            raise ResourceNotFoundError("Study space not found.")
        return self.repository.delete_model_assignment(space_id=space_id, capability=capability)

    def resolve(self, *, space_id: str, capability: ProviderCapability) -> ResolvedProvider:
        assignment = self._find_assignment(space_id, capability)
        if assignment is None:
            raise MissingRoleError(
                provider="connection", public_detail=f"Connect a {capability.value} model for this study space.",
            )
        connection = self._require_connection(assignment.provider_connection_id)
        self._ensure_capability(connection, capability)
        return ResolvedProvider(assignment, connection, self._build_adapter(connection))

    def _find_assignment(self, space_id: str, capability: ProviderCapability) -> ModelAssignment | None:
        return next((
            item for item in self.repository.list_model_assignments(space_id)
            if item.capability == capability
        ), None)

    def _build_adapter(self, connection: ProviderConnection) -> ProviderAdapter:
        secret = None if connection.provider in _NO_KEY_PROVIDERS else self.vault.get_provider_secret(connection.id)
        return build_provider_adapter(connection, api_key=secret)

    def _require_connection(self, connection_id: str) -> ProviderConnection:
        connection = self.repository.get_provider_connection(connection_id)
        if connection is None:
            raise ProviderConfigurationError(
                provider="connection", public_detail="Select a saved provider connection.",
            )
        return connection

    @staticmethod
    def _ensure_capability(connection: ProviderConnection, capability: ProviderCapability) -> None:
        if capability not in connection.capabilities:
            raise ProviderConfigurationError(
                provider=connection.provider, public_detail=f"This connection does not support {capability.value}.",
            )


async def _collect_speech(adapter: ProviderAdapter, *, model: str, text: str, voice_id: str, speed: float) -> bytes:
    audio = bytearray()
    stream = adapter.synthesize_speech_stream(model=model, text=text, voice_id=voice_id, speed=speed)
    async with aclosing(stream):
        async for chunk in stream:
            if len(audio) + len(chunk) > PROVIDER_SPEECH_PREVIEW_MAX_BYTES:
                raise ProviderProtocolError(
                    provider=adapter.name, public_detail="The speech preview exceeded the size limit.",
                )
            audio.extend(chunk)
    if not audio or len(audio) % 2:
        raise ProviderProtocolError(provider=adapter.name, public_detail="The provider returned invalid speech audio.")
    return bytes(audio)


def _probe_png() -> str:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    red = b"\xe2\x33\x38"
    white = b"\xff\xff\xff"
    rows = b"".join(
        b"\x00" + (white * 12 + red * 40 + white * 12 if 12 <= y < 52 else white * 64)
        for y in range(64)
    )
    parts = [
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(rows)),
        chunk(b"IEND", b""),
    ]
    return base64.b64encode(b"".join(parts)).decode()


async def _probe_role(adapter: ProviderAdapter, role: Role, assignment: RoleAssignment) -> str | None:
    model = assignment.model
    error = ProviderProtocolError(provider=adapter.name, public_detail=f"The {role} test returned no usable result.")
    if role == "embedding":
        vectors = await adapter.embed(model=model, texts=["Connection check"])
        if len(vectors) != 1 or not vectors[0]:
            raise error
    elif role == "tts":
        voice = assignment.params.get("voice_id", "alloy")
        if not isinstance(voice, str) or not voice.strip():
            raise ProviderConfigurationError(provider=adapter.name, public_detail="Set voice_id for this speech model.")
        await _collect_speech(adapter, model=model, text="语音连接测试。", voice_id=voice, speed=1)
    elif role == "stt":
        # Silence validates format, authentication and endpoint availability.
        transcript = await adapter.transcribe_pcm16(model=model, pcm16=bytes(16000), sample_rate_hz=16000)
        if not transcript.strip():
            return "Speech-to-text endpoint verified with silent audio."
    else:
        if not isinstance(adapter, LLMProvider):
            raise ProviderConfigurationError(provider=adapter.name, public_detail="Choose a chat-capable connection.")
        content = (
            [{"type": "image", "mime": "image/png", "image_b64": _probe_png()},
             {"type": "text", "text": "What color is the square? Answer with one English color word."}]
            if role == "vision" else "Reply with one word to verify this connection."
        )
        params = assignment.params
        budget = params.get("probe_max_tokens", 96)
        limit = budget if isinstance(budget, int) and not isinstance(budget, bool) and budget > 0 else 96
        probe_timeout = _probe_timeout_s(params, default=12.0)
        controlled = {
            "max_tokens", "probe_max_tokens", "probe_timeout_s",
            "temperature", "timeout_s", "json_object", "stop",
        }
        try:
            request = LLMRequest(
                model=model, system="This is a connection check.",
                messages=[Message(role="user", content=content)],
                max_tokens=limit, timeout_s=probe_timeout,
                temperature=params.get("temperature"),
                stop=params.get("stop"),
                json_object=params.get("json_object", False),
                extra_body={key: value for key, value in params.items() if key not in controlled},
            )
        except ValueError:
            raise ProviderConfigurationError(
                provider=adapter.name, public_detail="Review the request options in the role settings.",
            ) from None
        visible = []
        async with aclosing(adapter.stream(request)) as stream:
            async for chunk in stream:
                visible.append(chunk.text)
                if chunk.finish_reason == "length":
                    raise error
        answer = "".join(visible).strip()
        if not answer:
            raise error
        if role == "vision" and answer.casefold().strip(" .!*\"'`") != "red":
            raise ProviderProtocolError(
                provider=adapter.name, public_detail="The vision model could not identify the red square.",
            )
    return None
