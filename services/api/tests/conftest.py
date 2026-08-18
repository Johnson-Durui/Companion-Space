from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.core.config import Settings, get_settings
from app.main import app


@pytest.fixture()
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    # Tests opt into neural TTS explicitly; a developer's local .env must not
    # change the baseline assignment contract for the whole suite.
    settings = Settings(
        object_storage_path=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=False,
    )
    get_settings.cache_clear()
    get_container.cache_clear()
    monkeypatch.setattr("app.api.deps.get_settings", lambda: settings)
    monkeypatch.setattr("app.main.get_container", get_container)
    yield settings
    get_container().close()
    get_container.cache_clear()
    get_settings.cache_clear()


@pytest.fixture()
def client(isolated_settings: Settings) -> TestClient:
    _ = isolated_settings
    return TestClient(app)


@pytest.fixture()
def owner_token(client: TestClient) -> str:
    response = client.post("/api/v1/vault/init", json={"password": "super-secret-pass"})
    assert response.status_code == 200
    return response.json()["owner_token"]
