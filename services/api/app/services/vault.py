from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from pathlib import Path
import secrets
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from threading import RLock
from typing import Any, Literal
from uuid import uuid4

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings
from app.services.repository import SQLiteRepository
from app.services.vault_keys import KeyStorageError, VaultKeyStore, atomic_write

_VAULT_VERSION = 2
KeyStorage = Literal["credential_store", "key_file", "password", "legacy"]


class VaultError(RuntimeError):
    pass


class VaultAlreadyInitializedError(VaultError):
    pass


class VaultNotInitializedError(VaultError):
    pass


class VaultLockedError(VaultError):
    pass


class InvalidVaultPasswordError(VaultError):
    pass


class VaultDependencyError(VaultError):
    pass


class VaultPayloadError(VaultError):
    pass


class VaultStateError(VaultError):
    pass


class OwnerTokenState(str, Enum):
    valid = "valid"
    invalid = "invalid"
    vault_locked = "vault_locked"


@dataclass(frozen=True)
class VaultStatus:
    initialized: bool
    unlocked: bool
    key_storage: KeyStorage = "credential_store"

    @property
    def password_enabled(self) -> bool:
        return self.key_storage == "password"

    @property
    def warning(self) -> str | None:
        return "key_file_fallback" if self.key_storage == "key_file" else None


class VaultService:
    def __init__(self, settings: Settings, repository: SQLiteRepository) -> None:
        self.settings = settings
        self.repository = repository
        self._session_key: bytes | None = None
        self._session_epoch = 0
        self._locked_owner_token_hashes: set[str] = set()
        self._mutex = RLock()
        self.keys = VaultKeyStore(settings.storage_root / "key.bin")
        self.settings.storage_root.mkdir(parents=True, exist_ok=True)

    @property
    def dependencies_ready(self) -> bool:
        return True

    @property
    def session_epoch(self) -> int:
        return self._session_epoch

    def status(self) -> VaultStatus:
        with self._mutex:
            if not self.settings.vault_path.exists():
                return VaultStatus(initialized=False, unlocked=False)
            storage = self._storage(self._read_payload())
            return VaultStatus(True, self._session_key is not None, storage)

    def bootstrap(self) -> VaultStatus:
        with self._mutex:
            if not self.settings.vault_path.exists():
                self.initialize()
            else:
                document = self._read_payload()
                storage = self._storage(document)
                if storage == "password":
                    self._finish_password_transition(document)
                elif storage != "legacy" and self._session_key is None:
                    try:
                        key = self.keys.load(storage)
                    except KeyStorageError as exc:
                        raise VaultDependencyError(str(exc)) from exc
                    self._read_secrets(key, document)
                    self._session_key = key
            return self.status()

    def initialize(self, password: str | None = None) -> None:
        with self._mutex:
            if self.settings.vault_path.exists():
                raise VaultAlreadyInitializedError("Vault already initialized")
            if self._backup_path.exists():
                raise VaultPayloadError("Restore the saved vault file before initializing")
            self._initialize_empty(password)

    def _initialize_empty(self, password: str | None) -> None:
        key = secrets.token_bytes(32)
        payload = {"sentinel": "companion-space", "provider_secrets": {}}
        self._save_document(key, payload, password)
        self._session_key = key
        self._session_epoch += 1
        self._locked_owner_token_hashes.clear()

    def unlock(self, password: str) -> None:
        with self._mutex:
            document = self._read_payload()
            storage = self._storage(document)
            key = self._key_for_password(password, document)
            if storage == "legacy":
                payload = self._read_secrets(key, document)
                key = secrets.token_bytes(32)
                self._save_document(key, payload, password=None)
                self._revoke_owner_sessions()
            else:
                self._read_secrets(key, document)
                self._finish_password_transition(document)
            self._session_key = key
            self._session_epoch += 1
            self._locked_owner_token_hashes.clear()

    def skip_migration(self) -> None:
        with self._mutex:
            if self._storage(self._read_payload()) != "legacy":
                raise VaultStateError("No vault migration is pending")
            self._initialize_empty(password=None)
            self._revoke_owner_sessions()

    def lock(self) -> None:
        with self._mutex:
            self._locked_owner_token_hashes = self.repository.list_owner_session_hashes()
            self._session_key = None
            self._session_epoch += 1
            self._revoke_owner_sessions()

    def verify_password(self, password: str) -> bool:
        with self._mutex:
            document = self._read_payload()
            try:
                key = self._key_for_password(password, document)
                self._read_secrets(key, document)
            except InvalidVaultPasswordError:
                return False
            return True

    def set_password(self, password: str | None, current_password: str | None = None) -> None:
        with self._mutex:
            key = self._require_key()
            previous = self._read_payload()
            storage = self._storage(previous)
            if storage == "password":
                if current_password is None:
                    raise VaultStateError("Current password required")
                if self._key_for_password(current_password, previous) != key:
                    raise InvalidVaultPasswordError("Invalid vault password")
            elif storage == "legacy":
                raise VaultStateError("Complete vault migration first")
            elif password is None:
                return

            payload = self._read_secrets(key, previous)
            if password is not None and storage != "password":
                # Publish the password-wrapped key first. Reopen removes any
                # stale external copy if the process stopped during cleanup.
                next_document = self._save_document(key, payload, password, retire_storage=storage)
                try:
                    self._finish_password_transition(next_document)
                except VaultError:
                    # The wrapped key is durable. Require unlocking it before
                    # resuming operations if retiring the external copy failed.
                    self.lock()
                    raise
            else:
                # Any external key staged before disabling the password must
                # be unable to decrypt the still-password-protected document.
                if password is None:
                    key = secrets.token_bytes(32)
                self._save_document(key, payload, password)
                self._session_key = key
            self._session_epoch += 1
            self._revoke_owner_sessions()

    def rotate_password(self, current_password: str, new_password: str) -> None:
        self.set_password(new_password, current_password)

    def reset(self, password: str) -> None:
        with self._mutex:
            document = self._read_payload()
            self._key_for_password(password, document)
            self._finish_password_transition(document)
            self.settings.vault_path.unlink()
            self._backup_path.unlink(missing_ok=True)
            self._session_key = None
            self._session_epoch += 1
            self._locked_owner_token_hashes.clear()
            self._revoke_owner_sessions()

    def _revoke_owner_sessions(self) -> None:
        self.repository.revoke_owner_sessions()

    def issue_owner_token(
        self,
        *,
        ttl_seconds: int | None = None,
    ) -> str:
        with self._mutex:
            self._require_key()
            token = secrets.token_urlsafe(32)
            self.repository.put_owner_session(
                session_id=str(uuid4()),
                token=token,
                ttl_seconds=ttl_seconds,
            )
            return token

    def protect_browser_token(self, token: str) -> str:
        with self._mutex:
            session_key = self._require_key()
        nonce = secrets.token_bytes(12)
        key = hmac.new(
            session_key,
            b"companion-browser-session-v1",
            hashlib.sha256,
        ).digest()
        encrypted = AESGCM(key).encrypt(
            nonce,
            token.encode("utf-8"),
            b"companion-owner-session",
        )
        return self._b64url(nonce + encrypted)

    def unprotect_browser_token(self, protected_token: str) -> str | None:
        with self._mutex:
            session_key = self._session_key
        if session_key is None:
            return None
        try:
            payload = self._b64url_decode(protected_token)
            nonce, encrypted = payload[:12], payload[12:]
            if len(nonce) != 12 or not encrypted:
                return None
            key = hmac.new(
                session_key,
                b"companion-browser-session-v1",
                hashlib.sha256,
            ).digest()
            return AESGCM(key).decrypt(
                nonce,
                encrypted,
                b"companion-owner-session",
            ).decode("utf-8")
        except (InvalidTag, ValueError, binascii.Error, UnicodeDecodeError):
            return None

    def owner_token_state(self, token: str) -> OwnerTokenState:
        token_hash = self.repository.hash_token(token)
        if self._session_key is None and token_hash in self._locked_owner_token_hashes:
            return OwnerTokenState.vault_locked
        if self.repository.get_owner_session(token) is None:
            return OwnerTokenState.invalid
        if self._session_key is None:
            return OwnerTokenState.vault_locked
        return OwnerTokenState.valid

    def validate_owner_token(self, token: str) -> bool:
        return self.owner_token_state(token) is OwnerTokenState.valid

    def owner_session_state(self, owner_session_id: str) -> OwnerTokenState:
        if self._session_key is None:
            return OwnerTokenState.vault_locked
        if self.repository.get_owner_session_by_id(owner_session_id) is None:
            return OwnerTokenState.invalid
        return OwnerTokenState.valid

    def validate_owner_session(self, owner_session_id: str) -> bool:
        return self.owner_session_state(owner_session_id) is OwnerTokenState.valid

    def issue_realtime_ticket(self, owner_token: str, *, session_id: str) -> tuple[str, datetime]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        owner_session = self.repository.get_owner_session(owner_token)
        if owner_session is None:
            raise VaultLockedError("Owner session is invalid")
        ticket = self._b64url(secrets.token_bytes(24))
        record = self.repository.put_realtime_ticket(
            ticket_id=str(uuid4()),
            token=ticket,
            owner_session_id=owner_session.id,
            session_id=session_id,
            ttl_seconds=self.settings.realtime_ticket_ttl_seconds,
        )
        return ticket, record.expires_at

    def consume_realtime_ticket(self, ticket: str, *, session_id: str) -> str | None:
        if self._session_key is None or not self._is_b64url(ticket):
            return None
        record = self.repository.consume_realtime_ticket(ticket, session_id=session_id)
        if record is None or self.owner_session_state(record) is not OwnerTokenState.valid:
            return None
        return record

    def put_provider_secret(self, connection_id: str, api_key: str) -> None:
        with self._mutex:
            key = self._require_key()
            document = self._read_payload()
            payload = self._read_secrets(key, document)
            payload["provider_secrets"][connection_id] = api_key
            document.update(self._encrypt_payload(key, payload))
            self._write_payload(document)

    def get_provider_secret(self, connection_id: str) -> str | None:
        with self._mutex:
            payload = self._read_secrets(self._require_key(), self._read_payload())
            return payload["provider_secrets"].get(connection_id)

    def delete_provider_secret(self, connection_id: str) -> None:
        with self._mutex:
            key = self._require_key()
            document = self._read_payload()
            payload = self._read_secrets(key, document)
            if payload["provider_secrets"].pop(connection_id, None) is not None:
                document.update(self._encrypt_payload(key, payload))
                self._write_payload(document)

    def _require_key(self) -> bytes:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        return self._session_key

    def _finish_password_transition(self, document: dict[str, Any]) -> None:
        storage = document.get("retire_storage")
        if storage in ("credential_store", "key_file"):
            try:
                self.keys.delete(storage)
            except KeyStorageError as exc:
                raise VaultDependencyError(str(exc)) from exc
            del document["retire_storage"]
            self._write_payload(document, backup=False)

    def _save_document(
        self, key: bytes, payload: dict[str, Any], password: str | None,
        *, retire_storage: KeyStorage | None = None,
    ) -> dict[str, Any]:
        base: dict[str, Any] = {"version": _VAULT_VERSION, **self._encrypt_payload(key, payload)}
        if password is None:
            try:
                base["key_storage"] = self.keys.save(key)
            except KeyStorageError as exc:
                raise VaultDependencyError(str(exc)) from exc
        else:
            password_key, salt = self._derive_key(password)
            base["key_storage"] = "password"
            base["password_wrap"] = {
                "salt": self._b64(salt),
                **self._encrypt_payload(password_key, {"dek": self._b64(key)}),
            }
        if retire_storage is not None:
            base["retire_storage"] = retire_storage
        self._write_payload(base)
        return base

    @staticmethod
    def _storage(document: dict[str, Any]) -> KeyStorage:
        if "version" not in document:
            return "legacy"
        storage = document.get("key_storage")
        if document["version"] != _VAULT_VERSION or storage not in ("credential_store", "key_file", "password"):
            raise VaultPayloadError("Unsupported vault format")
        return storage

    def _key_for_password(self, password: str, document: dict[str, Any]) -> bytes:
        storage = self._storage(document)
        if storage not in ("legacy", "password"):
            raise VaultStateError("No password is configured")
        try:
            payload = document if storage == "legacy" else document["password_wrap"]
            salt = self._unb64(payload["salt"])
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if len(salt) != 16:
            raise VaultPayloadError("Vault payload is invalid")
        key, _ = self._derive_key(password, salt=salt)
        decoded = self._decrypt_payload(key, payload, invalid_tag_is_password=True)
        if storage == "legacy":
            self._check_payload(decoded)
            return key
        try:
            dek = self._unb64(decoded["dek"])
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if len(dek) != 32:
            raise VaultPayloadError("Vault payload is invalid")
        return dek

    @staticmethod
    def _derive_key(password: str, *, salt: bytes | None = None) -> tuple[bytes, bytes]:
        actual_salt = salt if salt is not None else secrets.token_bytes(16)
        key = hash_secret_raw(
            secret=password.encode("utf-8"),
            salt=actual_salt,
            time_cost=3,
            memory_cost=65536,
            parallelism=2,
            hash_len=32,
            type=Type.ID,
        )
        return key, actual_salt

    def _read_secrets(self, key: bytes, document: dict[str, Any]) -> dict[str, Any]:
        payload = self._decrypt_payload(key, document)
        self._check_payload(payload)
        return payload

    @staticmethod
    def _check_payload(payload: dict[str, Any]) -> None:
        if payload.get("sentinel") != "companion-space" or not isinstance(payload.get("provider_secrets"), dict):
            raise VaultPayloadError("Vault payload is invalid")

    def _encrypt_payload(self, key: bytes, payload: dict[str, Any]) -> dict[str, str]:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(key).encrypt(nonce, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
        return {"nonce": self._b64(nonce), "ciphertext": self._b64(ciphertext)}

    def _decrypt_payload(
        self,
        key: bytes,
        payload: dict[str, Any],
        *,
        invalid_tag_is_password: bool = False,
    ) -> dict[str, Any]:
        try:
            plaintext = AESGCM(key).decrypt(
                self._unb64(payload["nonce"]),
                self._unb64(payload["ciphertext"]),
                None,
            )
        except InvalidTag as exc:
            if invalid_tag_is_password:
                raise InvalidVaultPasswordError("Invalid vault password") from exc
            raise VaultPayloadError("Unable to decrypt vault payload") from exc
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        try:
            decoded = json.loads(plaintext.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if not isinstance(decoded, dict):
            raise VaultPayloadError("Vault payload is invalid")
        return decoded

    @property
    def _backup_path(self) -> Path:
        return self.settings.vault_path.with_suffix(self.settings.vault_path.suffix + ".bak")

    def _read_payload(self) -> dict[str, Any]:
        if not self.settings.vault_path.exists():
            raise VaultNotInitializedError("Vault not initialized")
        try:
            payload = json.loads(self.settings.vault_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if not isinstance(payload, dict):
            raise VaultPayloadError("Vault payload is invalid")
        return payload

    def _write_payload(self, payload: dict[str, Any], *, backup: bool = True) -> None:
        path = self.settings.vault_path
        try:
            if backup and path.exists():
                atomic_write(self._backup_path, path.read_bytes())
            atomic_write(path, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except OSError as exc:
            raise VaultPayloadError("Unable to save the vault; existing data was preserved") from exc

    @staticmethod
    def _b64(value: bytes) -> str:
        return base64.b64encode(value).decode("ascii")

    @staticmethod
    def _unb64(value: str) -> bytes:
        return base64.b64decode(value.encode("ascii"), validate=True)

    @staticmethod
    def _b64url(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

    @staticmethod
    def _b64url_decode(value: str) -> bytes:
        padding = "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))

    @staticmethod
    def _is_b64url(value: str) -> bool:
        if not value:
            return False
        padding = "=" * (-len(value) % 4)
        try:
            decoded = base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))
        except (ValueError, binascii.Error):
            return False
        return bool(decoded)
