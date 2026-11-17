from fastapi import APIRouter

from app.api.routes.characters import router as characters_router
from app.api.routes.spaces import router as spaces_router


router = APIRouter(prefix="/api/v1", tags=["v1"])
router.include_router(spaces_router)
router.include_router(characters_router)
