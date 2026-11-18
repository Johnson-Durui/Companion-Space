from fastapi import APIRouter

from app.api.local_session import router as session_router
from app.api.routes.courses import router as course_router
from app.api.routes.diagnostics import router as diagnostics_router
from app.api.routes.history import router as history_router
from app.api.routes.learner import router as learner_router
from app.api.routes.lessons import router as lessons_router
from app.api.routes.review import router as review_router
from app.api.routes.practice import router as practice_router
from app.api.routes.progress import router as progress_router
from app.api.routes.model_connections import router as models_router
from app.api.routes.sample import router as sample_router
from app.api.routes.settings_v2 import router as settings_router
from app.api.routes.tutors import router as tutor_router
from app.api.routes.voice import router as voice_router

router = APIRouter(prefix="/api/v2", tags=["v2"])
router.include_router(session_router)
router.include_router(sample_router)
router.include_router(models_router)
router.include_router(settings_router)
router.include_router(tutor_router)
router.include_router(diagnostics_router)
router.include_router(course_router)
router.include_router(history_router)
router.include_router(learner_router)
router.include_router(lessons_router)
router.include_router(review_router)
router.include_router(practice_router)
router.include_router(progress_router)
router.include_router(voice_router)
