from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from fastapi import Depends, Header, HTTPException, status

from app.core.config import Settings, get_settings
from app.services.characters import CharacterService
from app.services.companion import CompanionService
from app.services.demos import DemoService
from app.services.legacy_import import LegacyKnowledgeImporter
from app.services.metrics import MetricsService
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService
from app.services.vault import OwnerTokenState, VaultService

OWNER_SESSION_REQUIRED = "Owner session required"
OWNER_SESSION_INVALID = "Invalid owner session"
VAULT_LOCKED = "Vault is locked"
LOCAL_OWNER_SESSION_REQUIRED = "Local owner session required"


@dataclass
class ServiceContainer:
    settings: Settings
    repository: SQLiteRepository
    vault: VaultService
    metrics: MetricsService
    spaces: StudySpaceService
    characters: CharacterService
    providers: ProviderRegistryService
    companion: CompanionService
    demos: DemoService
    legacy_importer: LegacyKnowledgeImporter

    async def aclose(self) -> None:
        await self.companion.aclose()
        await self.providers.aclose()
        self.spaces.close()

    def close(self) -> None:
        self.companion.close()
        self.providers.close()
        self.spaces.close()


@lru_cache
def get_container() -> ServiceContainer:
    settings = get_settings()
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    metrics = MetricsService(repository)
    spaces = StudySpaceService(settings, repository)
    characters = CharacterService(repository)
    providers = ProviderRegistryService(repository, vault)
    spaces.set_provider_registry(providers)
    spaces.set_metrics(metrics)
    spaces.start_ingestion_worker()
    companion = CompanionService(
        settings,
        repository,
        spaces,
        providers,
        metrics=metrics,
    )
    demos = DemoService(settings, repository, spaces, providers, companion)
    legacy_importer = LegacyKnowledgeImporter(settings, spaces)
    return ServiceContainer(
        settings=settings,
        repository=repository,
        vault=vault,
        metrics=metrics,
        spaces=spaces,
        characters=characters,
        providers=providers,
        companion=companion,
        demos=demos,
        legacy_importer=legacy_importer,
    )


def require_owner(
    authorization: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=OWNER_SESSION_REQUIRED,
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.split(" ", 1)[1].strip()
    owner_state = container.vault.owner_token_state(token)
    if owner_state is OwnerTokenState.vault_locked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=VAULT_LOCKED,
            headers={"WWW-Authenticate": "Bearer"},
        )
    if owner_state is OwnerTokenState.invalid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=OWNER_SESSION_INVALID,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


def require_local_owner(
    token: str = Depends(require_owner),
    container: ServiceContainer = Depends(get_container),
) -> str:
    owner_session = container.repository.get_owner_session(token)
    if owner_session is None or owner_session.device_id is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=LOCAL_OWNER_SESSION_REQUIRED,
        )
    return token
