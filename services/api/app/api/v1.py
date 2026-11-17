from fastapi import APIRouter

from app.api.routes.characters import router as characters_router
from app.api.routes.learning import router as learning_router
from app.api.routes.metrics import router as metrics_router
from app.api.routes.providers import router as providers_router
from app.api.routes.realtime import router as realtime_router
from app.api.routes.sessions import router as sessions_router
from app.api.routes.spaces import router as spaces_router
from app.api.routes.vault_mobile import router as vault_mobile_router


router = APIRouter(prefix="/api/v1", tags=["v1"])
router.include_router(vault_mobile_router)
router.include_router(providers_router)
router.include_router(spaces_router)
router.include_router(characters_router)
router.include_router(sessions_router)
router.include_router(learning_router)
router.include_router(metrics_router)
router.include_router(realtime_router)
