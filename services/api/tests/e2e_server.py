"""Dedicated single-process browser fixture. Use only from the test runner."""

from contextlib import suppress
import os
from tempfile import TemporaryDirectory

import keyring
from keyring.backends.fail import Keyring
import uvicorn

from app.core.config import Settings
from app.api.deps import get_container
from app.main import create_app
from fakes.e2e import (
    BrowserHarnessGateway,
    build_media_fixture_tutorpack_bytes,
    seed_classroom,
    seed_empty_course,
    seed_stress_course,
    seed_u5_loop_course,
    seed_unprepared_lesson,
)


if __name__ == "__main__":
    keyring.set_keyring(Keyring())
    with TemporaryDirectory(prefix="companion-browser-test-") as directory:
        port = int(os.environ.get("E2E_API_PORT", "8731"))
        origin = f"http://127.0.0.1:{port}"
        settings = Settings(COMPANION_DATA_DIR=directory, app_base_url=origin, api_base_url=origin, _env_file=None)
        application = create_app(gateway_factory=BrowserHarnessGateway, settings=settings)
        container = application.dependency_overrides[get_container]()
        fixture_seq = {"n": 0}

        @application.post("/__test__/disconnect-lesson/{lesson_id}", include_in_schema=False)
        async def _disconnect_lesson(lesson_id: str) -> dict[str, bool]:
            ws = container.live_lessons.get(lesson_id)
            if ws is None:
                return {"closed": False}
            with suppress(Exception):
                await ws.close(code=1011, reason="simulated_drop")
            return {"closed": True}

        @application.post("/__test__/seed-media-fixture-lesson", include_in_schema=False)
        async def _seed_media_fixture_lesson() -> dict[str, str]:
            fixture_seq["n"] += 1
            idx = fixture_seq["n"]
            character = container.tutors.import_upload("media-fixture.tutorpack", build_media_fixture_tutorpack_bytes())
            scenario = f"avatar-media-fixture-{idx}"
            seed_classroom(container, scenario, character_id=character.id)
            return {
                "character_id": character.id,
                "lesson_id": f"browser-{scenario}-lesson",
            }

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
            "avatar-inv-reconnect",
        ):
            seed_classroom(container, scenario)
        for scenario in (
            "avatar-media-builtin",
            "avatar-reduced-correct",
            "avatar-reduced-incorrect",
        ):
            seed_classroom(container, scenario, character_id="tutor-xuechuan")
        seed_stress_course(container)
        seed_empty_course(container)
        seed_unprepared_lesson(container)
        seed_u5_loop_course(container)
        uvicorn.run(application, host="127.0.0.1", port=port, proxy_headers=False, access_log=False)
