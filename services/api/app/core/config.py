from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field

MOBILE_APP_ORIGINS = (
    "https://app.companion.local",
    "capacitor://app.companion.local",
)
DEV_BROWSER_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:  # pragma: no cover
    from pydantic import BaseModel

    class BaseSettings(BaseModel):
        pass

    def SettingsConfigDict(**kwargs):
        return kwargs


class Settings(BaseSettings):
    app_display_name: str = "Companion Space"
    app_env: str = "development"
    default_character_style: str = "cool"
    app_base_url: str = "http://localhost:3000"
    api_base_url: str = "http://localhost:8000"
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    object_storage_path: str = "./storage"
    sqlite_db_filename: str = "companion.db"
    sqlite_busy_timeout_ms: int = Field(default=5_000, ge=0, le=60_000)
    vault_filename: str = "vault.json"
    embedding_provider: str = "bge_m3"
    reranker_provider: str = "bge_reranker_v2_m3"
    retrieval_top_k: int = 4
    embedding_model_name: str = "BAAI/bge-m3"
    reranker_model_name: str = "BAAI/bge-reranker-v2-m3"
    allow_ml_fallback: bool = True

    memory_write_enabled: bool = True
    audio_persist_enabled: bool = False
    builtin_neural_tts_enabled: bool = False
    local_neural_tts_base_url: str = "http://127.0.0.1:8001"
    citation_required: bool = True
    owner_session_ttl_hours: int = 12
    realtime_ticket_ttl_seconds: int = 90
    max_document_size_bytes: int = 50 * 1024 * 1024
    max_pdf_pages: int = 500
    max_extracted_text_chars: int = 2_000_000
    max_character_pack_size_bytes: int = 200 * 1024 * 1024

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def repo_root(self) -> Path:
        return Path(__file__).resolve().parents[4]

    @property
    def prompt_dir(self) -> Path:
        return self.repo_root / "libs" / "prompts"

    @property
    def schema_dir(self) -> Path:
        return self.repo_root / "libs" / "schemas"

    @property
    def storage_root(self) -> Path:
        return (self.repo_root / self.object_storage_path).resolve()

    @property
    def metadata_db_path(self) -> Path:
        return self.storage_root / self.sqlite_db_filename

    @property
    def vault_path(self) -> Path:
        return self.storage_root / self.vault_filename

    @property
    def spaces_root(self) -> Path:
        return self.storage_root / "spaces"

    @property
    def characters_root(self) -> Path:
        return self.storage_root / "characters"

    @property
    def knowledge_base_root(self) -> Path:
        return self.storage_root / "knowledge_base"

    @property
    def knowledge_base_documents_dir(self) -> Path:
        return self.knowledge_base_root / "documents"

    @property
    def knowledge_base_manifests_dir(self) -> Path:
        return self.knowledge_base_root / "manifests"

    @property
    def knowledge_base_registry_path(self) -> Path:
        return self.knowledge_base_manifests_dir / "documents.json"

    @property
    def model_cache_dir(self) -> Path:
        return self.storage_root / "model_cache"

    @property
    def cors_origins(self) -> list[str]:
        configured = [
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        ]
        origins = [*configured, *MOBILE_APP_ORIGINS]
        if self.app_env == "development":
            origins.extend(DEV_BROWSER_ORIGINS)
        return list(dict.fromkeys(origin for origin in origins if origin))

    @property
    def websocket_allowed_origins(self) -> set[str]:
        origins = {origin for origin in self.cors_origins if origin}
        for candidate in (self.app_base_url, self.api_base_url):
            parsed = urlsplit(candidate)
            if parsed.scheme and parsed.netloc:
                origins.add(f"{parsed.scheme}://{parsed.netloc}".lower())
        return {origin.lower() for origin in origins}

@lru_cache
def get_settings() -> Settings:
    return Settings()
