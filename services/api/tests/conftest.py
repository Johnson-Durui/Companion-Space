from __future__ import annotations

from pathlib import Path

import keyring
from keyring.backends.fail import Keyring
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.core.config import Settings, get_settings
from app.main import app


@pytest.fixture()
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings = Settings(
        COMPANION_DATA_DIR=str(tmp_path / "storage"),
        builtin_neural_tts_enabled=False,
        _env_file=None,
    )
    monkeypatch.setattr(keyring, "get_keyring", Keyring)
    get_settings.cache_clear()
    get_container.cache_clear()
    monkeypatch.setattr("app.api.deps.get_settings", lambda: settings)
    yield settings
    if get_container.cache_info().currsize:
        get_container().close()
    get_container.cache_clear()
    get_settings.cache_clear()


@pytest.fixture()
def client(isolated_settings: Settings) -> TestClient:
    return TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000))


@pytest.fixture()
def owner_token(client: TestClient) -> str:
    vault = get_container().vault
    vault.bootstrap()
    return vault.issue_owner_token()
