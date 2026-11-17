from fastapi import APIRouter

from app.api.routes.characters import router as characters_router


router = APIRouter(prefix="/api/v1", tags=["v1"])
router.include_router(characters_router)
