from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import subprocess
from pathlib import Path
from tempfile import mkstemp
from typing import Literal

ExternalKeyStorage = Literal["credential_store", "key_file"]
_SERVICE = "Companion Space"
logger = logging.getLogger(__name__)


class KeyStorageError(RuntimeError):
    pass


def _keyring_backend():
    import keyring

    return keyring.get_keyring()


def _restrict_key_file(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)
        return
    windows_tools = Path(os.environ["SystemRoot"]) / "System32"
    options = {
        "capture_output": True,
        "timeout": 10,
        "check": True,
        "creationflags": subprocess.CREATE_NO_WINDOW,
    }
    result = subprocess.run([windows_tools / "whoami.exe", "/user", "/fo", "csv", "/nh"], **options)
    sid = re.search(rb'"(S-1-(?:\d+-)*\d+)"', result.stdout)
    if sid is None:
        raise KeyStorageError("Cannot identify the current Windows user")
    subprocess.run(
        [
            windows_tools / "icacls.exe", path,
            "/inheritance:r", "/grant:r", f"*{sid[1].decode('ascii')}:F", "/q",
        ],
        **options,
    )


def atomic_write(path: Path, contents: bytes, *, private: bool = False) -> None:
    descriptor, name = mkstemp(dir=path.parent, prefix=".companion-", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            if private:
                _restrict_key_file(temporary)
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


class VaultKeyStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.account = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()

    def save(self, key: bytes) -> ExternalKeyStorage:
        encoded = base64.b64encode(key).decode("ascii")
        if self._store_in_credentials(encoded):
            return "credential_store"
        try:
            atomic_write(self.path, key, private=True)
        except (OSError, subprocess.SubprocessError, KeyError) as exc:
            raise KeyStorageError("Cannot write a protected key file") from exc
        return "key_file"

    def _store_in_credentials(self, encoded: str) -> bool:
        try:
            backend = _keyring_backend()
            if getattr(backend, "priority", 1) <= 0:
                return False
            previous = backend.get_password(_SERVICE, self.account)
        except Exception as exc:
            logger.info("System credential store unavailable", extra={"error_type": type(exc).__name__})
            return False

        write_error = None
        try:
            backend.set_password(_SERVICE, self.account, encoded)
        except Exception as exc:
            write_error = exc

        try:
            stored = backend.get_password(_SERVICE, self.account)
        except Exception as exc:
            raise KeyStorageError("Cannot verify the system credential write") from exc
        if stored == encoded:
            return True
        if write_error is not None and stored == previous:
            logger.info("System credential store rejected the write", extra={"error_type": type(write_error).__name__})
            return False
        # Creating a file here could leave the same key in two locations;
        # only fallback when the existing credential was proven unchanged.
        raise KeyStorageError("Could not confirm where the encryption key is stored")

    def load(self, storage: ExternalKeyStorage) -> bytes:
        try:
            if storage == "credential_store":
                encoded = _keyring_backend().get_password(_SERVICE, self.account)
                key = base64.b64decode(encoded, validate=True) if encoded else b""
            else:
                if self.path.is_symlink():
                    raise KeyStorageError("The key file must not be a symbolic link")
                key = self.path.read_bytes()
        except Exception as exc:
            raise KeyStorageError("The saved encryption key is unavailable") from exc
        if len(key) != 32:
            raise KeyStorageError("The saved encryption key is missing or invalid")
        return key

    def delete(self, storage: ExternalKeyStorage) -> None:
        try:
            if storage == "credential_store":
                backend = _keyring_backend()
                if backend.get_password(_SERVICE, self.account) is not None:
                    backend.delete_password(_SERVICE, self.account)
            else:
                self.path.unlink(missing_ok=True)
        except Exception as exc:
            raise KeyStorageError("Cannot remove the previous encryption key") from exc
