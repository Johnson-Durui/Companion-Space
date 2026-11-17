from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import ServiceContainer, get_container, require_owner
from app.core.errors import ResourceNotFoundError
from app.learning.profiles import CourseEnrollment, EnrollmentSettings, LearnerProfile

router = APIRouter(dependencies=[Depends(require_owner)])
Container = Annotated[ServiceContainer, Depends(get_container)]


@router.get("/learner/profile")
def get_learner_profile(container: Container) -> LearnerProfile:
    return LearnerProfile.model_validate(container.repository.get_learner_profile() or {})


@router.put("/learner/profile")
def put_learner_profile(payload: LearnerProfile, container: Container) -> LearnerProfile:
    container.repository.upsert_learner_profile(payload.model_dump(mode="json"))
    return payload


@router.get("/courses/{course_id}/enrollment")
def get_course_enrollment(course_id: str, container: Container) -> CourseEnrollment:
    enrollment = container.repository.get_course_enrollment(course_id)
    if enrollment is None:
        raise ResourceNotFoundError("Course not found")
    return CourseEnrollment.model_validate({**enrollment, "course_id": course_id})


@router.put("/courses/{course_id}/enrollment")
def put_course_enrollment(course_id: str, payload: EnrollmentSettings, container: Container) -> CourseEnrollment:
    enrollment = container.repository.upsert_course_enrollment(course_id, payload.model_dump(mode="json"))
    if enrollment is None:
        raise ResourceNotFoundError("Course not found")
    return CourseEnrollment.model_validate({**enrollment, "course_id": course_id})
