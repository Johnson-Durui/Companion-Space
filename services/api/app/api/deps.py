from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache

from fastapi import Depends, Header, HTTPException, Request, status

from app.analysis.course_data import CourseData
from app.analysis.pipeline import AnalysisPipeline
from app.core.config import Settings, get_settings
from app.llm.gateway import LLMGateway
from app.services.browser_session import OWNER_COOKIE_NAME, require_cookie_csrf
from app.services.characters import CharacterService
from app.services.jobs import JobRunner
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.settings_store import get_setting
from app.services.tutor_catalog import TutorCatalog
from app.services.vault import OwnerTokenState, VaultService

OWNER_SESSION_REQUIRED = "Owner session required"
OWNER_SESSION_INVALID = "Invalid owner session"
VAULT_LOCKED = "Vault is locked"
type GatewayFactory = Callable[[ProviderRegistryService], LLMGateway]


@dataclass
class ServiceContainer:
    settings: Settings
    repository: SQLiteRepository
    vault: VaultService
    analysis: AnalysisPipeline
    characters: CharacterService
    tutors: TutorCatalog
    providers: ProviderRegistryService
    gateway: LLMGateway
    jobs: JobRunner
    settings_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    preparing_lessons: set[str] = field(default_factory=set)
    live_lessons: set[str] = field(default_factory=set)

    async def aclose(self) -> None:
        try:
            await self.jobs.aclose()
        finally:
            await self.providers.aclose()

    def close(self) -> None:
        self.providers.close()


def build_container(settings: Settings, gateway_factory: GatewayFactory = LLMGateway) -> ServiceContainer:
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    providers = ProviderRegistryService(repository, vault)
    tutors = TutorCatalog(repository)
    tutors.seed()
    jobs = JobRunner(repository, concurrency=get_setting(repository, "analysis_concurrency", 4))
    gateway = gateway_factory(providers)
    return ServiceContainer(
        settings=settings,
        repository=repository,
        vault=vault,
        analysis=AnalysisPipeline(CourseData(repository), jobs, gateway),
        characters=CharacterService(repository),
        tutors=tutors,
        providers=providers,
        gateway=gateway,
        jobs=jobs,
    )


@lru_cache
def get_container() -> ServiceContainer:
    return build_container(get_settings())


def _owner_token(request: Request, authorization: str | None, container: ServiceContainer) -> tuple[str | None, bool]:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip(), False
    protected = request.cookies.get(OWNER_COOKIE_NAME)
    return (container.vault.unprotect_browser_token(protected), True) if protected else (None, False)


def require_owner(
    request: Request,
    authorization: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> str:
    token, from_cookie = _owner_token(request, authorization, container)
    if not token:
        detail, code = OWNER_SESSION_REQUIRED, "owner_session_required"
    else:
        owner_state = container.vault.owner_token_state(token)
        if owner_state is OwnerTokenState.valid:
            if from_cookie:
                require_cookie_csrf(request, container.settings)
            return token
        if owner_state is OwnerTokenState.vault_locked:
            detail, code = VAULT_LOCKED, "vault_locked"
        else:
            detail, code = OWNER_SESSION_INVALID, "owner_session_invalid"
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": detail},
        headers={"WWW-Authenticate": "Bearer"},
    )


def optional_owner(
    request: Request,
    authorization: str | None = Header(default=None),
    container: ServiceContainer = Depends(get_container),
) -> str | None:
    token, _ = _owner_token(request, authorization, container)
    return token if token and container.vault.owner_token_state(token) is OwnerTokenState.valid else None
