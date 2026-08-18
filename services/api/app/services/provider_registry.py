from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
from contextlib import suppress
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Callable, Iterable
from uuid import uuid4

from app.models.domain import ModelAssignment, ProviderCapability, ProviderConnection
from app.providers.base import ProviderAdapter
from app.providers.errors import ProviderConfigurationError, ProviderError
from app.providers.factory import build_provider_adapter
from app.providers.local_neural_tts import LOCAL_NEURAL_TTS_MODEL, LocalNeuralTTSProvider
from app.providers.pinned_http import (
    ProviderHostResolutionError,
    default_host_resolver as _default_host_resolver,
    resolve_provider_base_url,
)
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService


class _Unset:
    pass


UNSET = _Unset()
HostResolver = Callable[[str], Iterable[str]]
logger = logging.getLogger(__name__)


def _is_retryable_sqlite_error(error: sqlite3.Error) -> bool:
    error_code = getattr(error, "sqlite_errorcode", None)
    if isinstance(error_code, int):
        return (error_code & 0xFF) in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
    if not isinstance(error, sqlite3.OperationalError):
        return False
    message = str(error).strip().lower()
    return message in {
        "database is busy",
        "database is locked",
        "database schema is locked",
        "database table is locked",
    }


@dataclass(frozen=True)
class ProviderDescriptor:
    slug: str
    capabilities: tuple[ProviderCapability, ...]
    supports_custom_base_url: bool = False
    requires_api_key: bool = True
    default_models: tuple[str, ...] = ()


@dataclass(frozen=True)
class ResolvedProvider:
    assignment: ModelAssignment
    connection: ProviderConnection
    adapter: ProviderAdapter


BUILTIN_MOCK_CONNECTION_ID = "builtin-mock"
BUILTIN_MOCK_MODEL = "mock-companion-v1"
BUILTIN_MOCK_ANALYSIS_MODEL = "mock-analysis-v1"
BUILTIN_MOCK_STT_MODEL = "mock-stt-v1"
BUILTIN_MOCK_TTS_MODEL = "mock-voice-v1"
BUILTIN_NEURAL_TTS_CONNECTION_ID = "builtin-neural-tts"


PROVIDER_REGISTRY: dict[str, ProviderDescriptor] = {
    "mock": ProviderDescriptor(
        slug="mock",
        capabilities=(
            ProviderCapability.chat_llm,
            ProviderCapability.analysis_llm,
            ProviderCapability.embedding,
            ProviderCapability.stt,
            ProviderCapability.tts,
        ),
        requires_api_key=False,
        default_models=("mock-companion-v1", "mock-analysis-v1"),
    ),
    "local-neural": ProviderDescriptor(
        slug="local-neural",
        capabilities=(ProviderCapability.tts,),
        requires_api_key=False,
        default_models=(LOCAL_NEURAL_TTS_MODEL,),
    ),
    "openai-compatible": ProviderDescriptor(
        slug="openai-compatible",
        capabilities=(
            ProviderCapability.chat_llm,
            ProviderCapability.analysis_llm,
            ProviderCapability.embedding,
            ProviderCapability.stt,
            ProviderCapability.tts,
        ),
        supports_custom_base_url=True,
    ),
    "anthropic": ProviderDescriptor(
        slug="anthropic",
        capabilities=(ProviderCapability.chat_llm, ProviderCapability.analysis_llm),
        default_models=("claude-sonnet-4-6", "claude-opus-4-6"),
    ),
    "gemini": ProviderDescriptor(
        slug="gemini",
        capabilities=(
            ProviderCapability.chat_llm,
            ProviderCapability.analysis_llm,
            ProviderCapability.embedding,
        ),
        default_models=("gemini-2.5-pro", "gemini-2.5-flash"),
    ),
    "elevenlabs": ProviderDescriptor(
        slug="elevenlabs",
        capabilities=(ProviderCapability.tts,),
    ),
    "ollama": ProviderDescriptor(
        slug="ollama",
        capabilities=(
            ProviderCapability.chat_llm,
            ProviderCapability.analysis_llm,
            ProviderCapability.embedding,
        ),
        supports_custom_base_url=True,
        requires_api_key=False,
    ),
}


def ensure_builtin_mock_connection(
    repository: SQLiteRepository,
) -> ProviderConnection:
    existing = repository.get_provider_connection(BUILTIN_MOCK_CONNECTION_ID)
    if existing is not None:
        return existing
    now = datetime.now(timezone.utc)
    descriptor = PROVIDER_REGISTRY["mock"]
    connection = ProviderConnection(
        id=BUILTIN_MOCK_CONNECTION_ID,
        provider="mock",
        label="Built-in Mock",
        capabilities=list(descriptor.capabilities),
        created_at=now,
        updated_at=now,
    )
    return repository.upsert_provider_connection(connection)


def ensure_builtin_neural_tts_connection(
    repository: SQLiteRepository,
) -> ProviderConnection:
    now = datetime.now(timezone.utc)
    connection = ProviderConnection(
        id=BUILTIN_NEURAL_TTS_CONNECTION_ID,
        provider="local-neural",
        label="Built-in Neural TTS",
        base_url=repository.settings.local_neural_tts_base_url.rstrip("/"),
        capabilities=[ProviderCapability.tts],
        created_at=now,
        updated_at=now,
    )
    with repository.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO provider_connections
            (id, provider, label, base_url, capabilities_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, '["tts"]', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                label = excluded.label,
                base_url = excluded.base_url,
                capabilities_json = excluded.capabilities_json,
                updated_at = excluded.updated_at
            """,
            (
                connection.id,
                connection.provider,
                connection.label,
                connection.base_url,
                connection.created_at.isoformat(),
                connection.updated_at.isoformat(),
            ),
        )
    return connection


class ProviderRegistryService:
    def __init__(self, repository: SQLiteRepository, vault: VaultService) -> None:
        self.repository = repository
        self.vault = vault
        self._builtin_neural_tts_ready = False
        self._neural_activation_task: asyncio.Task[None] | None = None
        self._bootstrap_tts_lock = threading.RLock()
        ensure_builtin_mock_connection(repository)
        if repository.settings.builtin_neural_tts_enabled:
            ensure_builtin_neural_tts_connection(repository)

    @property
    def is_builtin_neural_tts_ready(self) -> bool:
        return self._builtin_neural_tts_ready

    async def probe_builtin_neural_tts_ready(self) -> bool:
        if not self.repository.settings.builtin_neural_tts_enabled:
            return False
        provider = LocalNeuralTTSProvider(
            base_url=self.repository.settings.local_neural_tts_base_url,
            timeout=3.0,
        )
        models = await provider.discover_models(ProviderCapability.tts)
        return LOCAL_NEURAL_TTS_MODEL in models

    async def activate_builtin_neural_tts_if_ready(self) -> bool:
        if not await self.probe_builtin_neural_tts_ready():
            return False
        with self._bootstrap_tts_lock:
            self._builtin_neural_tts_ready = True
        return True

    @contextmanager
    def bootstrap_tts_target(self):
        with self._bootstrap_tts_lock:
            if self._builtin_neural_tts_ready:
                yield (
                    BUILTIN_NEURAL_TTS_CONNECTION_ID,
                    LOCAL_NEURAL_TTS_MODEL,
                )
            else:
                yield (BUILTIN_MOCK_CONNECTION_ID, BUILTIN_MOCK_TTS_MODEL)

    def start_builtin_neural_tts_activation(self) -> None:
        if (
            not self.repository.settings.builtin_neural_tts_enabled
            or self._neural_activation_task is not None
        ):
            return
        self._neural_activation_task = asyncio.create_task(
            self._activate_builtin_neural_tts_when_ready()
        )

    async def _activate_builtin_neural_tts_when_ready(self) -> None:
        announced_wait = False
        while not self._builtin_neural_tts_ready:
            try:
                if await self.activate_builtin_neural_tts_if_ready():
                    return
            except ProviderError:
                if not announced_wait:
                    logger.info("Local neural TTS sidecar is offline; Mock TTS stays in use until it appears")
                    announced_wait = True
            except sqlite3.Error as exc:
                if not _is_retryable_sqlite_error(exc):
                    raise
                logger.warning(
                    "Local neural TTS bootstrap migration will retry: %s",
                    type(exc).__name__,
                )
            await asyncio.sleep(2)

    async def aclose(self) -> None:
        task = self._neural_activation_task
        self._neural_activation_task = None
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    def close(self) -> None:
        task = self._neural_activation_task
        self._neural_activation_task = None
        if task is not None:
            task.cancel()

    def list_registry(self) -> list[dict[str, Any]]:
        return [
            {
                "provider": descriptor.slug,
                "capabilities": [cap.value for cap in descriptor.capabilities],
                "supports_custom_base_url": descriptor.supports_custom_base_url,
                "requires_api_key": descriptor.requires_api_key,
                "default_models": list(descriptor.default_models),
            }
            for descriptor in PROVIDER_REGISTRY.values()
        ]

    def list_connections(self) -> list[dict[str, Any]]:
        items = []
        for connection in self.repository.list_provider_connections():
            items.append(self._serialize_connection(connection))
        return items

    def get_connection(self, connection_id: str) -> dict[str, Any]:
        return self._serialize_connection(self._require_connection(connection_id))

    def save_connection(
        self,
        *,
        provider: str,
        label: str,
        api_key: str = "",
        base_url: str | None = None,
    ) -> dict[str, Any]:
        descriptor = PROVIDER_REGISTRY.get(provider)
        if descriptor is None:
            raise ValueError(f"Unsupported provider: {provider}")
        if provider == "local-neural":
            raise ValueError(
                "Local neural TTS is available only through the built-in connection"
            )
        if not label.strip():
            raise ValueError("Provider label cannot be empty")
        if descriptor.requires_api_key and not api_key:
            raise ValueError("Provider API key cannot be empty")
        normalized_base_url = _normalize_base_url(
            base_url,
            provider=provider,
        )
        if (
            normalized_base_url is not None
            and not descriptor.supports_custom_base_url
        ):
            raise ValueError(f"{provider} does not support a custom Base URL")
        now = datetime.now(timezone.utc)
        connection = ProviderConnection(
            id=str(uuid4()),
            provider=provider,
            label=label.strip(),
            base_url=normalized_base_url,
            capabilities=list(descriptor.capabilities),
            created_at=now,
            updated_at=now,
        )
        secret_to_store = api_key if provider != "mock" else ""
        if secret_to_store:
            self.vault.put_provider_secret(connection.id, api_key)
        try:
            self.repository.upsert_provider_connection(connection)
        except Exception:
            if secret_to_store:
                self.vault.delete_provider_secret(connection.id)
            raise
        return self._serialize_connection(connection)

    def update_connection(
        self,
        connection_id: str,
        *,
        label: str | None = None,
        base_url: str | None | _Unset = UNSET,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        existing = self._require_connection(connection_id)
        if connection_id == BUILTIN_MOCK_CONNECTION_ID:
            raise ValueError("The built-in Mock connection cannot be edited")
        if connection_id == BUILTIN_NEURAL_TTS_CONNECTION_ID:
            raise ValueError("The built-in Neural TTS connection cannot be edited")
        descriptor = PROVIDER_REGISTRY[existing.provider]
        if label is not None and not label.strip():
            raise ValueError("Provider label cannot be empty")
        if api_key is not None and not api_key:
            raise ValueError("Provider API key cannot be empty")
        if existing.provider == "mock":
            api_key = None
        normalized_base_url = (
            _normalize_base_url(
                base_url,
                provider=existing.provider,
            )
            if not isinstance(base_url, _Unset)
            else base_url
        )
        if (
            not isinstance(normalized_base_url, _Unset)
            and normalized_base_url is not None
            and not descriptor.supports_custom_base_url
        ):
            raise ValueError(
                f"{existing.provider} does not support a custom Base URL"
            )

        update_fields: dict[str, Any] = {}
        if label is not None:
            update_fields["label"] = label.strip()
        if not isinstance(normalized_base_url, _Unset):
            update_fields["base_url"] = normalized_base_url
        if update_fields or api_key is not None:
            update_fields["updated_at"] = datetime.now(timezone.utc)

        old_secret: str | None = None
        if api_key is not None:
            old_secret = self.vault.get_provider_secret(connection_id)
            self.vault.put_provider_secret(connection_id, api_key)

        try:
            updated = (
                self.repository.upsert_provider_connection(existing.model_copy(update=update_fields))
                if update_fields
                else existing
            )
        except Exception:
            if api_key is not None:
                if old_secret is None:
                    self.vault.delete_provider_secret(connection_id)
                else:
                    self.vault.put_provider_secret(connection_id, old_secret)
            raise
        return self._serialize_connection(updated)

    def delete_connection(self, connection_id: str) -> bool:
        if connection_id == BUILTIN_MOCK_CONNECTION_ID:
            raise ValueError("The built-in Mock connection cannot be deleted")
        if connection_id == BUILTIN_NEURAL_TTS_CONNECTION_ID:
            raise ValueError("The built-in Neural TTS connection cannot be deleted")
        self._require_connection(connection_id)
        secret = self.vault.get_provider_secret(connection_id)
        self.vault.delete_provider_secret(connection_id)
        try:
            self.repository.delete_provider_connection(connection_id)
        except Exception:
            if secret is not None:
                self.vault.put_provider_secret(connection_id, secret)
            raise
        return True

    def save_assignment(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
        provider_connection_id: str,
        model_name: str,
    ) -> ModelAssignment:
        if self.repository.get_space(space_id) is None:
            raise ValueError("Study space not found")
        connection = self._require_connection(provider_connection_id)
        if capability not in connection.capabilities:
            raise ValueError(
                f"Provider {connection.provider} does not provide "
                f"{capability.value}"
            )
        if not model_name.strip():
            raise ValueError("Model name cannot be empty")
        now = datetime.now(timezone.utc)
        existing = next(
            (
                item
                for item in self.repository.list_model_assignments(space_id)
                if item.capability == capability
            ),
            None,
        )
        assignment = ModelAssignment(
            id=existing.id if existing is not None else str(uuid4()),
            space_id=space_id,
            capability=capability,
            provider_connection_id=provider_connection_id,
            model_name=model_name.strip(),
            created_at=existing.created_at if existing is not None else now,
            updated_at=now,
        )
        saved = self.repository.upsert_model_assignment(assignment)
        if (
            capability is ProviderCapability.chat_llm
            and connection.provider != "mock"
        ):
            for bootstrap_capability in (
                ProviderCapability.analysis_llm,
                ProviderCapability.stt,
                ProviderCapability.tts,
            ):
                bootstrap_assignment = next(
                    (
                        item
                        for item in self.repository.list_model_assignments(space_id)
                        if item.capability is bootstrap_capability
                    ),
                    None,
                )
                if (
                    bootstrap_assignment is not None
                    and bootstrap_assignment.provider_connection_id
                    == BUILTIN_MOCK_CONNECTION_ID
                    and bootstrap_assignment.is_bootstrap_default
                ):
                    if (
                        self.repository.settings.builtin_neural_tts_enabled
                        and bootstrap_capability is ProviderCapability.tts
                        and bootstrap_assignment.model_name == BUILTIN_MOCK_TTS_MODEL
                    ):
                        continue
                    self.repository.delete_model_assignment(
                        space_id=space_id,
                        capability=bootstrap_capability,
                    )
        return saved

    def delete_assignment(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
    ) -> bool:
        if self.repository.get_space(space_id) is None:
            raise ValueError("Study space not found")
        return self.repository.delete_model_assignment(
            space_id=space_id,
            capability=capability,
        )

    async def discover_models(
        self,
        connection_id: str,
        capability: ProviderCapability | None = None,
    ) -> list[str]:
        connection = self._require_connection(connection_id)
        if capability is not None and capability not in connection.capabilities:
            raise ProviderConfigurationError(
                provider=connection.provider,
                public_detail=(
                    f"{connection.label} does not provide {capability.value}."
                ),
            )
        return await self._build_adapter(connection).discover_models(capability)

    async def test_connection(self, connection_id: str) -> dict[str, Any]:
        connection = self._require_connection(connection_id)
        started_at = monotonic()
        models = await self._build_adapter(connection).discover_models()
        return {
            "connection_id": connection_id,
            "provider": connection.provider,
            "ok": True,
            "mode": (
                "local"
                if connection.provider in {"mock", "ollama", "local-neural"}
                else "remote"
            ),
            "capabilities": [cap.value for cap in connection.capabilities],
            "models": models,
            "latency_ms": round((monotonic() - started_at) * 1000),
            "message": "连接验证成功",
        }

    def resolve(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
    ) -> ResolvedProvider:
        assignment = next(
            (
                item
                for item in self.repository.list_model_assignments(space_id)
                if item.capability is capability
            ),
            None,
        )
        if assignment is None:
            raise ProviderConfigurationError(
                provider="unassigned",
                public_detail=(
                    f"No {capability.value} model assignment exists for this study space."
                ),
            )
        return self._resolve_assignment(assignment, capability=capability)

    def resolve_pinned(
        self,
        *,
        space_id: str,
        capability: ProviderCapability,
        connection_id: str,
        model_name: str,
    ) -> ResolvedProvider:
        """Resolve a session snapshot without consulting the mutable space assignment."""
        now = datetime.now(timezone.utc)
        assignment = ModelAssignment(
            id=f"session-pinned:{space_id}:{capability.value}",
            space_id=space_id,
            capability=capability,
            provider_connection_id=connection_id,
            model_name=model_name,
            created_at=now,
            updated_at=now,
        )
        return self._resolve_assignment(assignment, capability=capability)

    def _resolve_assignment(
        self,
        assignment: ModelAssignment,
        *,
        capability: ProviderCapability,
    ) -> ResolvedProvider:
        connection = self.repository.get_provider_connection(
            assignment.provider_connection_id
        )
        if connection is None:
            raise ProviderConfigurationError(
                provider="missing",
                public_detail="The assigned provider connection no longer exists.",
            )
        if capability not in connection.capabilities:
            raise ProviderConfigurationError(
                provider=connection.provider,
                public_detail=(
                    f"{connection.label} does not provide {capability.value}."
                ),
            )
        return ResolvedProvider(
            assignment=assignment,
            connection=connection,
            adapter=self._build_adapter(connection),
        )

    def _build_adapter(self, connection: ProviderConnection) -> ProviderAdapter:
        descriptor = PROVIDER_REGISTRY.get(connection.provider)
        if descriptor is None:
            raise ProviderConfigurationError(
                provider=connection.provider,
                public_detail=f"Unsupported provider: {connection.provider}.",
            )
        secret: str | None = None
        if connection.provider not in {"mock", "local-neural"}:
            secret = self.vault.get_provider_secret(connection.id)
        if descriptor.requires_api_key and not secret:
            raise ProviderConfigurationError(
                provider=connection.provider,
                public_detail=(
                    f"{connection.label} has no API Key in the unlocked vault."
                ),
            )
        return build_provider_adapter(connection, api_key=secret)

    def _require_connection(self, connection_id: str) -> ProviderConnection:
        connection = self.repository.get_provider_connection(connection_id)
        if connection is None:
            raise ValueError("Provider connection not found")
        return connection

    @staticmethod
    def _serialize_connection(connection: ProviderConnection) -> dict[str, Any]:
        return {
            "id": connection.id,
            "provider": connection.provider,
            "label": connection.label,
            "base_url": connection.base_url,
            "capabilities": [cap.value for cap in connection.capabilities],
            "created_at": connection.created_at,
            "updated_at": connection.updated_at,
        }


def _normalize_base_url(
    base_url: str | None | _Unset,
    *,
    provider: str,
    resolver: HostResolver | None = None,
) -> str | None | _Unset:
    if isinstance(base_url, _Unset) or base_url is None:
        return base_url
    candidate = base_url.strip()
    if not candidate:
        return None
    try:
        return resolve_provider_base_url(
            candidate,
            provider=provider,
            resolver=resolver or _default_host_resolver,
        ).base_url
    except ProviderHostResolutionError as error:
        raise ValueError("Provider Base URL hostname could not be resolved") from error
