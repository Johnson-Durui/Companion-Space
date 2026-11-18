from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest

from app.core.config import Settings
from app.services.repository import SQLiteRepository
from app.services.vault import InvalidVaultPasswordError, VaultDependencyError, VaultLockedError, VaultPayloadError, VaultService

SECRET = "test-credential-never-persisted-in-plain-text"
PASSWORD = "test-password-only"


class IsolatedCredentialStore:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, value: str) -> None:
        self.values[service, account] = value

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        del self.values[service, account]


@pytest.fixture
def temp_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path / "isolated-storage"))
    return Settings()


@pytest.fixture
def credential_store(monkeypatch: pytest.MonkeyPatch) -> IsolatedCredentialStore:
    store = IsolatedCredentialStore()
    monkeypatch.setattr("app.services.vault_keys._keyring_backend", lambda: store)
    return store


def _no_credential_store(monkeypatch: pytest.MonkeyPatch) -> None:
    def unavailable():
        raise RuntimeError("No system credential backend in this test")

    monkeypatch.setattr("app.services.vault_keys._keyring_backend", unavailable)


def _reopen(settings: Settings) -> VaultService:
    return VaultService(settings, SQLiteRepository(settings))


def test_keyring_mode_preserves_credentials_and_browser_token_on_restart(
    temp_config: Settings, credential_store: IsolatedCredentialStore,
) -> None:
    vault = _reopen(temp_config)
    boot = vault.bootstrap()
    assert boot.unlocked and not boot.password_enabled and boot.key_storage == "credential_store"
    vault.put_provider_secret("connection", SECRET)
    owner_token = vault.issue_owner_token()
    cookie = vault.protect_browser_token(owner_token)
    assert owner_token not in cookie
    assert len(credential_store.values) == 1
    assert not (temp_config.storage_root / "key.bin").exists()

    restarted = _reopen(temp_config)
    assert restarted.bootstrap().unlocked
    assert restarted.get_provider_secret("connection") == SECRET
    assert restarted.unprotect_browser_token(cookie) == owner_token
    assert restarted.validate_owner_token(owner_token)
    assert SECRET.encode() not in temp_config.vault_path.read_bytes()


def test_credential_store_unavailable_falls_back_to_an_owner_only_file(
    temp_config: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_credential_store(monkeypatch)
    config = _reopen(temp_config)
    status = config.bootstrap()
    assert status.unlocked and status.key_storage == "key_file" and status.warning == "key_file_fallback"
    key_file = temp_config.storage_root / "key.bin"
    assert len(key_file.read_bytes()) == 32
    if os.name != "nt":
        assert key_file.stat().st_mode & 0o777 == 0o600
    config.put_provider_secret("connection", SECRET)
    assert _reopen(temp_config).bootstrap().unlocked
    for path in temp_config.storage_root.glob("*"):
        if path.is_file():
            assert SECRET.encode() not in path.read_bytes()


@pytest.mark.parametrize("mode", ["unreadable", "mismatched"])
def test_unverified_credential_write_never_creates_a_duplicate_key_file(
    temp_config: Settings, monkeypatch: pytest.MonkeyPatch, mode: str,
) -> None:
    class UnverifiableStore(IsolatedCredentialStore):
        def get_password(self, service: str, account: str) -> str | None:
            real = super().get_password(service, account)
            if real is not None:
                if mode == "unreadable":
                    raise OSError("Cannot read credentials after writing")
                return "an unexpected response"
            return None

    store = UnverifiableStore()
    monkeypatch.setattr("app.services.vault_keys._keyring_backend", lambda: store)
    vault = _reopen(temp_config)
    with pytest.raises(VaultDependencyError, match="Cannot verify|Could not confirm"):
        vault.bootstrap()
    assert len(store.values) == 1
    assert not (temp_config.storage_root / "key.bin").exists()
    assert not temp_config.vault_path.exists()


@pytest.mark.parametrize("storage", ["credential_store", "key_file"])
def test_enabling_password_retires_external_key_and_disabling_restores_zero_password(
    temp_config: Settings, credential_store: IsolatedCredentialStore,
    monkeypatch: pytest.MonkeyPatch, storage: str,
) -> None:
    if storage == "key_file":
        _no_credential_store(monkeypatch)
    vault = _reopen(temp_config)
    assert vault.bootstrap().key_storage == storage
    vault.put_provider_secret("connection", SECRET)
    owner_token = vault.issue_owner_token()
    vault.set_password(PASSWORD)
    assert not vault.validate_owner_token(owner_token)
    assert credential_store.values == {}
    assert not (temp_config.storage_root / "key.bin").exists()
    assert SECRET.encode() not in temp_config.vault_path.read_bytes()

    restarted = _reopen(temp_config)
    boot = restarted.bootstrap()
    assert boot.password_enabled and not boot.unlocked
    with pytest.raises(VaultLockedError):
        restarted.get_provider_secret("connection")
    with pytest.raises(InvalidVaultPasswordError):
        restarted.unlock("wrong-password")
    restarted.unlock(PASSWORD)
    assert restarted.get_provider_secret("connection") == SECRET
    with pytest.raises(InvalidVaultPasswordError):
        restarted.set_password(None, "wrong-password")
    restarted.set_password(None, PASSWORD)
    assert restarted.status().key_storage == storage

    reopened = _reopen(temp_config)
    assert reopened.bootstrap().unlocked
    assert reopened.get_provider_secret("connection") == SECRET


def _write_legacy(settings: Settings, vault: VaultService) -> bytes:
    old_key, salt = vault._derive_key(PASSWORD)
    document = vault._encrypt_payload(
        old_key, {"sentinel": "companion-space", "provider_secrets": {"connection": SECRET}},
    )
    document["salt"] = vault._b64(salt)
    contents = json.dumps(document).encode()
    settings.vault_path.write_bytes(contents)
    return contents


@pytest.mark.parametrize("skip", [False, True])
def test_legacy_migration_keeps_a_backup_and_can_be_skipped_explicitly(
    temp_config: Settings, credential_store: IsolatedCredentialStore, skip: bool,
) -> None:
    vault = _reopen(temp_config)
    legacy = _write_legacy(temp_config, vault)
    status = vault.bootstrap()
    assert status.key_storage == "legacy" and not status.unlocked
    with pytest.raises(InvalidVaultPasswordError):
        vault.unlock("wrong-password")
    assert temp_config.vault_path.read_bytes() == legacy
    if skip:
        vault.skip_migration()
    else:
        vault.unlock(PASSWORD)
    assert temp_config.vault_path.with_suffix(".json.bak").read_bytes() == legacy
    restarted = _reopen(temp_config)
    assert restarted.bootstrap().unlocked
    assert restarted.get_provider_secret("connection") == (None if skip else SECRET)


def test_interrupted_atomic_replace_cannot_destroy_credentials(
    temp_config: Settings, credential_store: IsolatedCredentialStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = _reopen(temp_config)
    vault.bootstrap()
    vault.put_provider_secret("connection", SECRET)
    original = temp_config.vault_path.read_bytes()
    real_replace = os.replace

    def interrupted_replace(source, target, *args, **kwargs):
        if Path(target) == temp_config.vault_path:
            raise OSError("interrupted")
        return real_replace(source, target, *args, **kwargs)

    monkeypatch.setattr("app.services.vault_keys.os.replace", interrupted_replace)
    with pytest.raises(VaultPayloadError, match="existing data was preserved"):
        vault.put_provider_secret("connection", "replacement")
    assert temp_config.vault_path.read_bytes() == original
    assert temp_config.vault_path.with_suffix(".json.bak").read_bytes() == original
    with pytest.raises(VaultPayloadError):
        vault.set_password(PASSWORD)
    assert len(credential_store.values) == 1
    restarted = _reopen(temp_config)
    assert restarted.bootstrap().unlocked
    assert restarted.get_provider_secret("connection") == SECRET


def test_failed_password_disable_never_persists_the_wrapped_document_key(
    temp_config: Settings, credential_store: IsolatedCredentialStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = _reopen(temp_config)
    vault.initialize(PASSWORD)
    vault.put_provider_secret("connection", SECRET)
    original = temp_config.vault_path.read_bytes()
    real_replace = os.replace

    def interrupted(source, target, *args, **kwargs):
        if Path(target) == temp_config.vault_path:
            raise OSError("interrupted")
        return real_replace(source, target, *args, **kwargs)

    monkeypatch.setattr("app.services.vault_keys.os.replace", interrupted)
    with pytest.raises(VaultPayloadError):
        vault.set_password(None, PASSWORD)

    assert temp_config.vault_path.read_bytes() == original
    external_key = base64.b64decode(next(iter(credential_store.values.values())))
    with pytest.raises(VaultPayloadError):
        vault._decrypt_payload(external_key, json.loads(original))
    restarted = _reopen(temp_config)
    assert not restarted.bootstrap().unlocked
    restarted.unlock(PASSWORD)
    assert restarted.get_provider_secret("connection") == SECRET


def test_bootstrap_requires_real_loopback_and_session_cookie_is_bound_to_csrf(
    temp_config: Settings, credential_store: IsolatedCredentialStore,
) -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=temp_config)
    loopback = "http://127.0.0.1:8765"
    remote = TestClient(app, client=("192.0.2.30", 49999), base_url=loopback)
    assert remote.post("/api/v2/session/bootstrap", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 403
    with TestClient(app, client=("127.0.0.1", 49999), base_url=loopback) as local:
        assert local.post("/api/v2/session/bootstrap", headers={"Host": "rebound.example"}).status_code == 403
        assert local.post("/api/v2/session/bootstrap", headers={"Origin": "https://external.example"}).status_code == 403
        assert not temp_config.vault_path.exists()
        boot = local.post("/api/v2/session/bootstrap", headers={"Origin": loopback})
        assert boot.status_code == 200, boot.text
        assert boot.json() == {
            "state": "ready", "password_enabled": False, "key_storage": "credential_store", "warning": None,
        }
        owner_cookie = next(h for h in boot.headers.get_list("set-cookie") if h.startswith("companion_owner_session="))
        assert "httponly" in owner_cookie.lower() and "samesite=strict" in owner_cookie.lower()
        assert local.get("/api/v2/settings/security").status_code == 200
        assert local.put("/api/v2/settings/security/password", json={"password": PASSWORD}).status_code == 403
        headers = {"Origin": "https://external.example", "X-CSRF-Token": local.cookies["companion_csrf"]}
        assert local.put("/api/v2/settings/security/password", json={"password": PASSWORD}, headers=headers).status_code == 403
        headers["Origin"] = loopback
        locked = local.put("/api/v2/settings/security/password", json={"password": PASSWORD}, headers=headers)
        assert locked.status_code == 200 and locked.json()["password_enabled"] is True
