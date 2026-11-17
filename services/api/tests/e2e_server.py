"""Dedicated single-process browser fixture. Use only from the test runner."""

import os
from tempfile import TemporaryDirectory

import keyring
from keyring.backends.fail import Keyring
import uvicorn

from app.core.config import Settings
from app.main import create_app
from fakes.e2e import BrowserHarnessGateway


if __name__ == "__main__":
    keyring.set_keyring(Keyring())
    with TemporaryDirectory(prefix="companion-browser-test-") as directory:
        port = int(os.environ.get("E2E_API_PORT", "8731"))
        origin = f"http://127.0.0.1:{port}"
        settings = Settings(COMPANION_DATA_DIR=directory, app_base_url=origin, api_base_url=origin, _env_file=None)
        uvicorn.run(create_app(gateway_factory=BrowserHarnessGateway, settings=settings),
                    host="127.0.0.1", port=port, proxy_headers=False, access_log=False)
