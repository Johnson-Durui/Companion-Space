from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SerializeAsAny, model_validator

from app.models.domain import Citation, CompanionEmotion

BoardActionKindV2 = Literal[
    "concept_sheet",
    "step_sandbox",
    "interactive_diagram",
    "checkpoint_quiz",
    "laser_focus",
]
ClassroomPhase = Literal["concept", "sandbox", "diagram", "quiz", "review"]
ClassroomEventType = Literal[
    "advance",
    "ask",
    "quiz_answer",
    "interrupt",
    "update_parameters",
]
FeedbackKind = Literal["instruction", "answer", "correct", "correction", "interrupted"]
FlashcardStatus = Literal["proposed", "active"]


class ConceptSection(BaseModel):
    heading: str
    markdown: str
    formula: str | None = None


class ConceptSheetPayload(BaseModel):
    sections: list[ConceptSection]


class SandboxStep(BaseModel):
    label: str
    values: dict[str, str | int | float]
    active_line: int = Field(ge=1)


class StepSandboxPayload(BaseModel):
    code: str
    parameters: dict[str, str | int | float] = Field(default_factory=dict)
    editable_parameters: list[str] = Field(default_factory=list)
    steps: list[SandboxStep] = Field(min_length=1)
    current_step: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_current_step(self) -> "StepSandboxPayload":
        if self.current_step >= len(self.steps):
            raise ValueError("current_step must identify an existing step")
        return self


class DiagramNode(BaseModel):
    id: str
    label: str
    question: str


class DiagramEdge(BaseModel):
    from_id: str
    to_id: str
    label: str | None = None


class InteractiveDiagramPayload(BaseModel):
    mermaid: str
    nodes: list[DiagramNode]
    edges: list[DiagramEdge] = Field(default_factory=list)


class QuizOption(BaseModel):
    id: str
    label: str


class CheckpointQuizPayload(BaseModel):
    question: str
    options: list[QuizOption] = Field(min_length=2)


class LaserFocusPayload(BaseModel):
    target_action_id: str
    target: str


class BoardActionV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: BoardActionKindV2
    title: str = Field(min_length=1, max_length=160)
    payload: SerializeAsAny[
        ConceptSheetPayload
        | StepSandboxPayload
        | InteractiveDiagramPayload
        | CheckpointQuizPayload
        | LaserFocusPayload
    ]
    citation_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_payload_kind(self) -> "BoardActionV2":
        expected = {
            "concept_sheet": ConceptSheetPayload,
            "step_sandbox": StepSandboxPayload,
            "interactive_diagram": InteractiveDiagramPayload,
            "checkpoint_quiz": CheckpointQuizPayload,
            "laser_focus": LaserFocusPayload,
        }[self.kind]
        if not isinstance(self.payload, expected):
            raise ValueError(f"{self.kind} requires {expected.__name__}")
        return self


class TutorState(BaseModel):
    emotion: CompanionEmotion = "focused"
    gaze_target: str = "board"
    narration: str = ""
    interrupted: bool = False


class ClassroomFeedback(BaseModel):
    kind: FeedbackKind
    message: str
    correct: bool | None = None


class ClassroomSnapshot(BaseModel):
    session_id: str
    space_id: str
    topic: str
    phase: ClassroomPhase
    active_action_id: str
    board_actions: list[BoardActionV2]
    citations: list[Citation] = Field(default_factory=list)
    tutor: TutorState
    feedback: ClassroomFeedback | None = None
    updated_at: datetime


class ClassroomStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1, max_length=240)


class ClassroomEventRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: ClassroomEventType
    action_id: str | None = None
    question: str | None = Field(default=None, max_length=600)
    answer_id: str | None = Field(default=None, max_length=80)
    parameters: dict[str, str | int | float] = Field(default_factory=dict, max_length=12)

    @model_validator(mode="after")
    def validate_event_fields(self) -> "ClassroomEventRequest":
        if self.type == "quiz_answer" and not self.answer_id:
            raise ValueError("quiz_answer requires answer_id")
        if self.type == "ask" and not (self.question or self.action_id):
            raise ValueError("ask requires question or action_id")
        if self.type == "update_parameters" and not self.parameters:
            raise ValueError("update_parameters requires parameters")
        return self


class FlashcardRecord(BaseModel):
    id: str
    space_id: str
    source_session_id: str
    prompt: str
    answer: str
    status: FlashcardStatus
    due_at: datetime | None = None
    stability: float | None = None
    difficulty: float | None = None
    reps: int = 0
    lapses: int = 0
    citations: list[Citation] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class FlashcardListResponse(BaseModel):
    items: list[FlashcardRecord]


class FlashcardRatingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rating: Literal[1, 2, 3, 4]
