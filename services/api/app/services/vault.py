from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from app.core.config import Settings
from app.models.domain import PairingChallenge, TrustedDevice
from app.services.repository import OwnerPreferences, SQLiteRepository

try:
    from argon2.low_level import Type, hash_secret_raw
except ImportError:  # pragma: no cover
    Type = None
    hash_secret_raw = None

try:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover
    AESGCM = None

    class InvalidTag(Exception):
        pass


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


class PairingChallengeError(VaultError):
    pass


class InvalidDeviceRefreshTokenError(VaultError):
    pass


class OwnerTokenState(str, Enum):
    valid = "valid"
    invalid = "invalid"
    vault_locked = "vault_locked"


@dataclass
class VaultStatus:
    initialized: bool
    unlocked: bool


class VaultService:
    PAIRING_TTL_SECONDS = 5 * 60
    PAIRING_MAX_ATTEMPTS = 5
    DEVICE_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
    DEVICE_ACCESS_TTL_SECONDS = 15 * 60
    DEVICE_REFRESH_RECOVERY_TTL_SECONDS = 30

    def __init__(self, settings: Settings, repository: SQLiteRepository) -> None:
        self.settings = settings
        self.repository = repository
        self._session_key: bytes | None = None
        self._session_epoch = 0
        self._locked_owner_token_hashes: set[str] = set()
        self.settings.storage_root.mkdir(parents=True, exist_ok=True)

    @property
    def dependencies_ready(self) -> bool:
        return bool(AESGCM)

    @property
    def session_epoch(self) -> int:
        return self._session_epoch

    def status(self) -> VaultStatus:
        return VaultStatus(initialized=self.settings.vault_path.exists(), unlocked=self._session_key is not None)

    def initialize(self, password: str) -> None:
        if self.settings.vault_path.exists():
            raise VaultAlreadyInitializedError("Vault already initialized")
        self.repository.set_owner_preferences(
            adult_relationships_enabled=False,
            adult_age_confirmed_at=None,
        )
        key, salt = self._derive_key(password)
        payload = self._encrypt_payload(key, {"sentinel": "companion-space", "provider_secrets": {}})
        payload["salt"] = self._b64(salt)
        self._write_payload(payload)
        self._session_key = key
        self._session_epoch += 1
        self._locked_owner_token_hashes.clear()
        self._clear_mobile_credentials()

    def unlock(self, password: str) -> None:
        key = self._key_for_password(password)
        self._session_key = key
        self._session_epoch += 1
        self._locked_owner_token_hashes.clear()

    def lock(self) -> None:
        self._locked_owner_token_hashes = self.repository.list_owner_session_hashes()
        self._session_key = None
        self._session_epoch += 1
        self.repository.delete_all_realtime_tickets()
        self.repository.delete_all_owner_sessions()
        self.repository.delete_all_pairing_challenges()

    def verify_password(self, password: str) -> bool:
        try:
            self._key_for_password(password)
        except InvalidVaultPasswordError:
            return False
        return True

    def reset(self, password: str) -> None:
        self._key_for_password(password)
        self.repository.set_owner_preferences(
            adult_relationships_enabled=False,
            adult_age_confirmed_at=None,
        )
        self._session_key = None
        self._session_epoch += 1
        self._locked_owner_token_hashes.clear()
        self.settings.vault_path.unlink(missing_ok=True)
        self.repository.delete_all_realtime_tickets()
        self.repository.delete_all_owner_sessions()
        self._clear_mobile_credentials()

    def rotate_password(self, current_password: str, new_password: str) -> None:
        current_key = self._key_for_password(current_password)
        payload = self._decrypt_payload(current_key, self._read_payload())
        next_key, salt = self._derive_key(new_password)
        encrypted = self._encrypt_payload(next_key, payload)
        encrypted["salt"] = self._b64(salt)
        self._write_payload(encrypted)
        self._session_key = next_key
        self._session_epoch += 1
        self._locked_owner_token_hashes.clear()
        self.repository.delete_all_realtime_tickets()
        self.repository.delete_all_owner_sessions()
        self._clear_mobile_credentials()

    def get_owner_preferences(self) -> OwnerPreferences:
        return self.repository.get_owner_preferences()

    def update_adult_relationship_preferences(
        self,
        *,
        enabled: bool,
        confirm_age_18_or_older: bool,
    ) -> OwnerPreferences:
        if enabled and not confirm_age_18_or_older:
            raise ValueError(
                "You must confirm that the local owner is 18 or older"
            )
        return self.repository.set_owner_preferences(
            adult_relationships_enabled=enabled,
            adult_age_confirmed_at=(
                datetime.now(timezone.utc) if enabled else None
            ),
        )

    def issue_owner_token(
        self,
        *,
        ttl_seconds: int | None = None,
        device_id: str | None = None,
    ) -> str:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        token = secrets.token_urlsafe(32)
        self.repository.put_owner_session(
            session_id=str(uuid4()),
            token=token,
            ttl_seconds=ttl_seconds,
            device_id=device_id,
        )
        return token

    def create_pairing_challenge(self) -> tuple[str, PairingChallenge]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        code = f"{secrets.randbelow(100_000_000):08d}"
        challenge_id = str(uuid4())
        challenge = self.repository.create_pairing_challenge(
            challenge_id=challenge_id,
            code_verifier=self._pairing_code_verifier(challenge_id, code),
            ttl_seconds=self.PAIRING_TTL_SECONDS,
            max_attempts=self.PAIRING_MAX_ATTEMPTS,
        )
        return code, challenge

    def pair_device(
        self,
        *,
        challenge_id: str | None,
        code: str,
        name: str,
    ) -> tuple[TrustedDevice, str, str, datetime]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        refresh_token = self._b64url(secrets.token_bytes(32))
        access_token = secrets.token_urlsafe(32)
        status, device, owner_session = self.repository.pair_trusted_device(
            challenge_id=challenge_id,
            code_verifier_for_challenge=lambda resolved_id: self._pairing_code_verifier(
                resolved_id,
                code,
            ),
            device_id=str(uuid4()),
            name=name,
            refresh_token=refresh_token,
            refresh_ttl_seconds=self.DEVICE_REFRESH_TTL_SECONDS,
            owner_session_id=str(uuid4()),
            access_token=access_token,
            access_ttl_seconds=self.DEVICE_ACCESS_TTL_SECONDS,
        )
        if status != "consumed" or device is None or owner_session is None:
            raise PairingChallengeError("Invalid or expired pairing challenge")
        return device, refresh_token, access_token, owner_session.expires_at

    def _pairing_code_verifier(self, challenge_id: str, code: str) -> str:
        if self._session_key is None:  # pragma: no cover - caller invariant
            raise VaultLockedError("Vault is locked")
        return hmac.new(
            self._session_key,
            b"companion-mobile-pairing-v1\0"
            + challenge_id.encode("utf-8")
            + b"\0"
            + code.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()

    def refresh_device_access(self, refresh_token: str) -> tuple[TrustedDevice, str, str, datetime]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        next_refresh_token = self._derive_mobile_token(
            refresh_token, purpose=b"refresh"
        )
        access_token = self._derive_mobile_token(
            refresh_token, purpose=b"access"
        )
        owner_session_id = self._derive_mobile_token(
            refresh_token, purpose=b"session"
        )
        rotated = self.repository.rotate_trusted_device_token(
            refresh_token=refresh_token,
            next_refresh_token=next_refresh_token,
            owner_session_id=owner_session_id,
            access_token=access_token,
            access_ttl_seconds=self.DEVICE_ACCESS_TTL_SECONDS,
            refresh_ttl_seconds=self.DEVICE_REFRESH_TTL_SECONDS,
            recovery_ttl_seconds=self.DEVICE_REFRESH_RECOVERY_TTL_SECONDS,
        )
        if rotated is None:
            raise InvalidDeviceRefreshTokenError("Invalid device refresh token")
        device, owner_session = rotated
        return device, next_refresh_token, access_token, owner_session.expires_at

    def _derive_mobile_token(self, refresh_token: str, *, purpose: bytes) -> str:
        if self._session_key is None:  # pragma: no cover - caller invariant
            raise VaultLockedError("Vault is locked")
        digest = hmac.new(
            self._session_key,
            b"companion-mobile-v1\0" + purpose + b"\0" + refresh_token.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return self._b64url(digest)

    def list_trusted_devices(self) -> list[TrustedDevice]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        return self.repository.list_trusted_devices()

    def revoke_trusted_device(self, device_id: str) -> bool:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        return self.repository.delete_trusted_device(device_id)

    def _clear_mobile_credentials(self) -> None:
        self.repository.delete_all_pairing_challenges()
        self.repository.delete_all_trusted_devices()

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
        record = self.repository.get_realtime_ticket(ticket)
        if record is None or record.session_id != session_id:
            return None
        if self.owner_session_state(record.owner_session_id) is not OwnerTokenState.valid:
            return None
        self.repository.delete_realtime_ticket_by_id(record.id)
        return record.owner_session_id

    def put_provider_secret(self, connection_id: str, api_key: str) -> None:
        payload = self._require_unlocked_payload()
        payload.setdefault("provider_secrets", {})[connection_id] = api_key
        self._persist_decrypted(payload)

    def get_provider_secret(self, connection_id: str) -> str | None:
        payload = self._require_unlocked_payload()
        return payload.get("provider_secrets", {}).get(connection_id)

    def delete_provider_secret(self, connection_id: str) -> None:
        payload = self._require_unlocked_payload()
        payload.setdefault("provider_secrets", {}).pop(connection_id, None)
        self._persist_decrypted(payload)

    def _require_unlocked_payload(self) -> dict[str, Any]:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        return self._decrypt_payload(self._session_key, self._read_payload())

    def _persist_decrypted(self, payload: dict[str, Any]) -> None:
        if self._session_key is None:
            raise VaultLockedError("Vault is locked")
        encrypted = self._encrypt_payload(self._session_key, payload)
        current = self._read_payload()
        encrypted["salt"] = current["salt"]
        self._write_payload(encrypted)

    def _key_for_password(self, password: str) -> bytes:
        payload = self._read_payload()
        try:
            salt = self._unb64(payload["salt"])
        except (KeyError, TypeError, ValueError, binascii.Error) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        key, _ = self._derive_key(password, salt=salt)
        decrypted = self._decrypt_payload(key, payload, invalid_tag_is_password=True)
        sentinel = decrypted.get("sentinel")
        if not isinstance(sentinel, str) or not secrets.compare_digest(sentinel, "companion-space"):
            raise InvalidVaultPasswordError("Invalid vault password")
        return key

    def _derive_key(self, password: str, *, salt: bytes | None = None) -> tuple[bytes, bytes]:
        if not self.dependencies_ready:
            raise VaultDependencyError("Vault dependencies missing: cryptography is required")
        actual_salt = salt or secrets.token_bytes(16)
        if hash_secret_raw and Type is not None:
            key = hash_secret_raw(
                secret=password.encode("utf-8"),
                salt=actual_salt,
                time_cost=3,
                memory_cost=65536,
                parallelism=2,
                hash_len=32,
                type=Type.ID,
            )
        else:
            key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), actual_salt, 390000, dklen=32)
        return key, actual_salt

    def _encrypt_payload(self, key: bytes, payload: dict[str, Any]) -> dict[str, str]:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(key).encrypt(nonce, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
        return {"nonce": self._b64(nonce), "ciphertext": self._b64(ciphertext)}

    def _decrypt_payload(
        self,
        key: bytes,
        payload: dict[str, str],
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
        except (KeyError, TypeError, ValueError, binascii.Error) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        try:
            decoded = json.loads(plaintext.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if not isinstance(decoded, dict):
            raise VaultPayloadError("Vault payload is invalid")
        return decoded

    def _read_payload(self) -> dict[str, str]:
        if not self.settings.vault_path.exists():
            raise VaultNotInitializedError("Vault not initialized")
        try:
            payload = json.loads(self.settings.vault_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VaultPayloadError("Vault payload is invalid") from exc
        if not isinstance(payload, dict):
            raise VaultPayloadError("Vault payload is invalid")
        return payload

    def _write_payload(self, payload: dict[str, str]) -> None:
        self.settings.vault_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

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
    def _is_b64url(value: str) -> bool:
        if not value:
            return False
        padding = "=" * (-len(value) % 4)
        try:
            decoded = base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))
        except (ValueError, binascii.Error):
            return False
        return bool(decoded)
