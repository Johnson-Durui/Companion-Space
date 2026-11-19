from __future__ import annotations

import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.learning.profiles import EnrollmentSettings, LearnerProfile
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks


InterviewTopic = Literal["identity", "goal", "schedule", "starting_point", "hard_parts", "teaching"]
TOPICS: tuple[InterviewTopic, ...] = (
    "identity", "goal", "schedule", "starting_point", "hard_parts", "teaching",
)


class InterviewAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: InterviewTopic
    values: dict[str, object] = Field(default_factory=dict)
    text: str = Field(default="", max_length=2000)
    skipped: bool = False


def next_topic(completed: list[str]) -> InterviewTopic | None:
    done = set(completed)
    return next((topic for topic in TOPICS if topic not in done), None)


def merge_answer(state: dict, answer: InterviewAnswer) -> dict:
    completed = list(dict.fromkeys([*state.get("completed", []), answer.topic]))
    answers = {**state.get("answers", {}), answer.topic: answer.values}
    return {"completed": completed, "answers": answers, "current": next_topic(completed)}


_FIELDS = {
    "identity": {"nickname", "level"},
    "goal": {"goal_type", "exam_name", "exam_date", "target_score"},
    "schedule": {"weekly_days", "session_minutes"},
    "starting_point": {"self_level"},
    "hard_parts": {"hard_units", "teacher_hints"},
    "teaching": {"preferred_style_id", "approach_order", "pace", "encouragement"},
}
_PROFILE_SCHEMA = LearnerProfile.model_json_schema()
_ENROLLMENT_SCHEMA = EnrollmentSettings.model_json_schema()
_FIELD_SCHEMA = {**_PROFILE_SCHEMA["properties"], **_ENROLLMENT_SCHEMA["properties"]}
_FIELD_DEFINITIONS = {**_PROFILE_SCHEMA.get("$defs", {}), **_ENROLLMENT_SCHEMA.get("$defs", {})}


def allowed_fields(topic: InterviewTopic) -> list[str]:
    return sorted(_FIELDS[topic])


def _single_text(raw: str, tag: str) -> str:
    nodes = [node for node in parse_blocks(raw) if node.tag == tag]
    if len(nodes) != 1 or nodes[0].children:
        raise ValueError(f"Expected one <{tag}> text block.")
    return nodes[0].text.strip()


def parse_slots(raw: str, topic: InterviewTopic) -> dict[str, object]:
    value = json.loads(_single_text(raw, "slots"))
    if not isinstance(value, dict) or not set(value).issubset(_FIELDS[topic]):
        raise ValueError("Interview slot output contains unsupported fields.")
    return value


async def render_question(gateway, *, topic: InterviewTopic, tutor: dict, context: dict) -> str:
    return await gateway.complete_tagged(
        "live", "live/interview_ask",
        {
            "tutor_context": data_block("tutor", json.dumps(tutor, ensure_ascii=False)),
            "interview_context": data_block("interview", json.dumps({"topic": topic, **context}, ensure_ascii=False)),
        },
        parse=lambda raw: _single_text(raw, "question"), cache=False, max_tokens=180,
    )


async def extract_slots(gateway, *, topic: InterviewTopic, text: str, context: dict) -> dict[str, object]:
    scope = {"topic": topic, "today": date.today().isoformat(), "$defs": _FIELD_DEFINITIONS, "fields": {
        field: _FIELD_SCHEMA[field] for field in allowed_fields(topic)
    }, **context}
    return await gateway.complete_tagged(
        "live", "live/interview_slot",
        {
            "learner_answer": data_block("answer", text),
            "interview_context": data_block("interview", json.dumps(scope, ensure_ascii=False)),
        },
        parse=lambda raw: parse_slots(raw, topic), cache=False, max_tokens=300,
    )


async def map_teacher_hints(gateway, *, text: str, points: list[dict]) -> set[str]:
    if not text.strip() or not points:
        return set()

    def parse(raw: str) -> set[str]:
        allowed = {point["id"] for point in points}
        result = {node.text.strip() for node in parse_blocks(raw) if node.tag == "kp"}
        if not result.issubset(allowed):
            raise ValueError("Teacher hints mapped outside this course.")
        return result

    return await gateway.complete_tagged(
        "analysis", "analysis/hints_to_kp",
        {
            "teacher_hints": data_block("hints", text),
            "knowledge_candidates": data_block("knowledge_points", json.dumps([
                {"id": point["id"], "name": point["name"], "summary": point.get("summary", "")}
                for point in points
            ], ensure_ascii=False)),
        },
        parse=parse, cache=True, max_tokens=500,
    )
