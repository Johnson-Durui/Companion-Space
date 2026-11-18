from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MaterialRole = Literal["textbook", "slides", "notes", "exam", "exercise", "syllabus"]
Importance = Literal["core", "important", "peripheral"]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CourseInput(RequestModel):
    name: str = Field(min_length=1, max_length=120)
    goal: str = Field(default="", max_length=2000)


class Course(BaseModel):
    id: str
    name: str
    goal: str
    brief: dict | None = None


class MaterialMetadata(RequestModel):
    role: MaterialRole | None = None
    year: int | None = Field(default=None, ge=1, le=9999)
    exam_name: str | None = Field(default=None, max_length=120)
    has_answers: bool | None = None


class NoteInput(MaterialMetadata):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1)


class CourseMaterial(BaseModel):
    id: str
    filename: str
    title: str
    role: MaterialRole
    year: int | None = None
    exam_name: str | None = None
    has_answers: bool | None = None
    page_count: int = 0
    scanned_pages: int = 0
    parse_status: Literal["pending", "parsed", "needs_vision", "failed"]
    error: str | None = None


class PageData(BaseModel):
    markdown: str
    source: str
    quality: float
    has_image: bool


class SourceRef(BaseModel):
    material_id: str
    page_no: int


class ExamStats(BaseModel):
    n_items: int
    score_share: float
    recency_weight: float
    trend: str
    types: dict[str, int]
    novel_flags: list[str]
    weight: float


class KnowledgePoint(BaseModel):
    id: str
    name: str
    summary: str
    importance: Importance
    difficulty: int
    kind: str
    formula: str | None = None
    source_refs: list[SourceRef] = Field(default_factory=list)
    prerequisite_ids: list[str] = Field(default_factory=list)
    assumed: bool = False
    stats: ExamStats | None = None


class CourseUnit(BaseModel):
    id: str
    title: str
    knowledge_points: list[KnowledgePoint]


class CourseMap(BaseModel):
    units: list[CourseUnit]
    brief: dict | None
    warnings: list[str]
    has_exams: bool


class PointUpdate(RequestModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    importance: Importance | None = None
    prerequisite_ids: list[str] | None = Field(default=None, max_length=200)
    merge_into: str | None = None
    deleted: bool = False


class ExamItem(BaseModel):
    id: str
    no: str
    type: str
    stem: str
    options: dict[str, str]
    answer: str | None = None
    solution: str | None = None
    score: float | None = None
    answer_status: str
    page_refs: list[SourceRef]
    kp_ids: list[str]
    exam_name: str | None = None
    year: int | None = None
