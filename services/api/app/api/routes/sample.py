from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from app.core.config import Settings, get_settings
from app.core.errors import ResourceNotFoundError

router = APIRouter()
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.get("/sample-lesson", include_in_schema=False)
def sample_lesson(settings: AppSettings) -> FileResponse:
    replay = settings.repo_root / "content/sample-course/probability-basics/replay.json"
    if not replay.is_file():
        raise ResourceNotFoundError("The sample recording is not included in this build.")
    return FileResponse(replay, media_type="application/json", headers={"Cache-Control": "no-cache"})
