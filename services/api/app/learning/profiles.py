from __future__ import annotations

from datetime import date
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.learning.mastery import SelfLevel

type LearnerLevel = Literal["junior", "senior", "undergrad", "postgrad_exam", "self_study"]
type Approach = Literal["example", "intuition", "visual", "formal", "analogy", "contrast"]
type Weekday = Annotated[int, Field(strict=True, ge=1, le=7)]


class LearnerProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    nickname: str = Field(default="", max_length=80)
    level: LearnerLevel = "self_study"
    pace: Literal["slow", "normal", "fast"] = "normal"
    encouragement: Literal["more", "normal", "direct"] = "normal"
    preferred_style_id: Literal["guided", "direct", "analogy", "exam", "rigorous"] = "guided"
    interests: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=12)
    approach_order: list[Approach] = Field(
        default_factory=lambda: ["example", "intuition", "visual", "formal", "analogy", "contrast"],
        max_length=6,
    )

    @model_validator(mode="after")
    def validate_approaches(self) -> Self:
        if len(set(self.approach_order)) != len(self.approach_order):
            raise ValueError("List each teaching approach at most once.")
        return self


class EnrollmentSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    goal_type: Literal["exam", "homework", "interest"] = "interest"
    exam_name: str = Field(default="", max_length=120)
    exam_date: date | None = None
    target_score: float | None = Field(default=None, strict=True, ge=0, allow_inf_nan=False)
    full_score: float = Field(default=100, strict=True, gt=0, allow_inf_nan=False)
    weekly_days: list[Weekday] = Field(default_factory=lambda: list(range(1, 8)), max_length=7)
    session_minutes: int = Field(default=30, strict=True, gt=0, le=1440)
    self_level: SelfLevel = "never"
    hard_units: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list)
    teacher_hints: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_settings(self) -> Self:
        if len(set(self.weekly_days)) != len(self.weekly_days):
            raise ValueError("List each weekday at most once.")
        if self.target_score is not None and self.target_score > self.full_score:
            raise ValueError("The target score cannot exceed the full score.")
        return self


class CourseEnrollment(EnrollmentSettings):
    course_id: str
    interview_status: Literal["todo", "active", "done", "skipped"] = "todo"
    placement_status: Literal["todo", "active", "done", "skipped"] = "todo"
