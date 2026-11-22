"""Dedicated single-process browser fixture. Use only from the test runner."""

import os
from tempfile import TemporaryDirectory

import keyring
from keyring.backends.fail import Keyring
import uvicorn

from app.core.config import Settings
from app.api.deps import get_container
from app.main import create_app
from fakes.e2e import BrowserHarnessGateway, seed_classroom, seed_empty_course, seed_stress_course


if __name__ == "__main__":
    keyring.set_keyring(Keyring())
    with TemporaryDirectory(prefix="companion-browser-test-") as directory:
        port = int(os.environ.get("E2E_API_PORT", "8731"))
        origin = f"http://127.0.0.1:{port}"
        settings = Settings(COMPANION_DATA_DIR=directory, app_base_url=origin, api_base_url=origin, _env_file=None)
        application = create_app(gateway_factory=BrowserHarnessGateway, settings=settings)
        container = application.dependency_overrides[get_container]()
        for scenario in (
            "board",
            "voice",
            "today",
            "avatar-teaching",
            "avatar-correct",
            "avatar-incorrect",
            "avatar-inv-incorrect",
            "avatar-inv-dontknow",
            "avatar-inv-actions",
            "avatar-inv-viewports",
            "avatar-inv-phases",
            "avatar-inv-dialog",
        ):
            seed_classroom(container, scenario)
        seed_stress_course(container)
        seed_empty_course(container)
        uvicorn.run(application, host="127.0.0.1", port=port, proxy_headers=False, access_log=False)
