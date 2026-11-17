from fastapi import APIRouter

from app.api.local_session import router as session_router
from app.api.routes.diagnostics import router as diagnostics_router
from app.api.routes.model_connections import router as models_router
from app.api.routes.settings_v2 import router as settings_router

router = APIRouter(prefix="/api/v2", tags=["v2"])
router.include_router(session_router)
router.include_router(models_router)
router.include_router(settings_router)
router.include_router(diagnostics_router)
