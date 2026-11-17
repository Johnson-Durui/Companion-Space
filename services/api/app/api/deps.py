from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from fastapi import Depends, Header, HTTPException, Request, status

from app.core.config import Settings, get_settings
from app.services.characters import CharacterService
from app.services.browser_session import OWNER_COOKIE_NAME, require_cookie_csrf
from app.services.companion import CompanionService
from app.services.legacy_import import LegacyKnowledgeImporter
from app.services.metrics import MetricsService
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService
from app.services.vault import OwnerTokenState, VaultService

OWNER_SESSION_REQUIRED = "Owner session required"
OWNER_SESSION_INVALID = "Invalid owner session"
VAULT_LOCKED = "Vault is locked"


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
        legacy_importer=legacy_importer,
    )


def require_owner(
    request: Request,
    authorization: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> str:
    bearer_token = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer_token = authorization.split(" ", 1)[1].strip()

    token = bearer_token
    if token is None:
        protected_token = request.cookies.get(OWNER_COOKIE_NAME)
        if protected_token:
            token = container.vault.unprotect_browser_token(protected_token)
            if token is not None:
                require_cookie_csrf(request, container.settings)

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=OWNER_SESSION_REQUIRED,
            headers={"WWW-Authenticate": "Bearer"},
        )
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


def optional_owner(
    request: Request,
    authorization: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> str | None:
    bearer_token = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer_token = authorization.split(" ", 1)[1].strip()
    token = bearer_token
    if token is None:
        protected_token = request.cookies.get(OWNER_COOKIE_NAME)
        if protected_token:
            token = container.vault.unprotect_browser_token(protected_token)
    if not token or container.vault.owner_token_state(token) is not OwnerTokenState.valid:
        return None
    return token
