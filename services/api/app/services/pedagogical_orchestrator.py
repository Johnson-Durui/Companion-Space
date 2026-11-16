from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fsrs import Card, Rating, Scheduler

from app.models.classroom import (
    ClassroomEventRequest,
    ClassroomFeedback,
    ClassroomSnapshot,
    FlashcardRecord,
    TutorState,
)
from app.models.domain import Citation, LessonScript
from app.services.classroom_repository import ClassroomRepository
from app.services.classroom_curriculum import (
    advance_sandbox,
    build_board_actions,
    sandbox_at_last,
    update_sandbox_parameters,
)
from app.services.companion import CompanionService
from app.services.demos import DemoService
from app.services.repository import SQLiteRepository
from app.services.spaces import StudySpaceService

_PHASES = ("concept", "sandbox", "diagram", "quiz", "review")
_CORRECT_ANSWER_ID = "b"


class ClassroomNotStartedError(ValueError):
    pass


class PedagogicalOrchestrator:
    def __init__(
        self,
        repository: SQLiteRepository,
        spaces: StudySpaceService,
        companion: CompanionService,
        demos: DemoService,
    ) -> None:
        self.repository = repository
        self.spaces = spaces
        self.companion = companion
        self.demos = demos
        self.store = ClassroomRepository(repository)
        self.scheduler = Scheduler(enable_fuzzing=False)

    def get(self, session_id: str) -> ClassroomSnapshot:
        self.companion.get_session(session_id)
        snapshot = self.store.get_snapshot(session_id)
        if snapshot is None:
            raise ClassroomNotStartedError("Classroom has not started")
        return snapshot

    async def start(self, *, session_id: str, topic: str) -> ClassroomSnapshot:
        session = self.companion.get_session(session_id)
        normalized_topic = " ".join(topic.split())
        demo = await self.demos.create_demo(
            session_id=session_id,
            topic=normalized_topic,
        )
        script = LessonScript.model_validate(demo["script"])
        citations = self._validated_citations(
            session.space_id,
            [Citation.model_validate(item) for item in demo["citations"]],
        )
        citation_ids = [item.chunk_id for item in citations]
        now = datetime.now(timezone.utc)
        snapshot = ClassroomSnapshot(
            session_id=session.id,
            space_id=session.space_id,
            topic=normalized_topic,
            phase="concept",
            active_action_id="concept",
            board_actions=build_board_actions(normalized_topic, citation_ids, script),
            citations=citations,
            tutor=TutorState(
                narration=script.steps[0].narration,
                gaze_target="concept",
            ),
            feedback=ClassroomFeedback(
                kind="instruction",
                message="从概念讲义开始，点击下一步进入可交互推演。",
            ),
            updated_at=now,
        )
        return self.store.save_snapshot(snapshot)

    async def handle_event(self, *, session_id: str, event: ClassroomEventRequest) -> ClassroomSnapshot:
        snapshot = self.get(session_id)
        now = datetime.now(timezone.utc)
        update: dict[str, object] = {"updated_at": now}
        tutor = snapshot.tutor.model_copy(update={"interrupted": False})

        if event.type == "advance":
            actions = snapshot.board_actions
            if snapshot.phase == "quiz" and (
                snapshot.feedback is None or snapshot.feedback.kind != "correct"
            ):
                phase = "quiz"
            elif snapshot.phase == "sandbox" and not sandbox_at_last(actions):
                phase = "sandbox"
                actions = advance_sandbox(actions)
            else:
                index = min(_PHASES.index(snapshot.phase) + 1, len(_PHASES) - 1)
                phase = _PHASES[index]
            active_id = {
                "concept": "concept",
                "sandbox": "sandbox",
                "diagram": "diagram",
                "quiz": "quiz",
                "review": "focus",
            }[phase]
            update.update(
                phase=phase,
                active_action_id=active_id,
                board_actions=actions,
                tutor=tutor.model_copy(
                    update={
                        "gaze_target": active_id,
                        "narration": self._phase_narration(phase),
                    }
                ),
                feedback=ClassroomFeedback(kind="instruction", message=self._phase_narration(phase)),
            )
        elif event.type == "quiz_answer":
            if snapshot.phase != "quiz":
                raise ValueError("Quiz answers are accepted only during the quiz phase")
            correct = event.answer_id == _CORRECT_ANSWER_ID
            update.update(
                phase="review" if correct else "quiz",
                active_action_id="focus" if correct else "quiz",
                tutor=tutor.model_copy(
                    update={
                        "emotion": "cheerful" if correct else "concerned",
                        "gaze_target": "focus" if correct else "quiz",
                        "narration": (
                            "回答正确。把刚才的不变量存成复习卡，之后按记忆强度安排复习。"
                            if correct
                            else "先别急着记答案。回到每一步仍然成立的条件，再检查边界变化。"
                        ),
                    }
                ),
                feedback=ClassroomFeedback(
                    kind="correct" if correct else "correction",
                    correct=correct,
                    message=(
                        "正确。关键在于每一步都保持搜索区间的不变量。"
                        if correct
                        else "这个选项会破坏边界不变量。请观察指针收缩后目标是否仍在区间内。"
                    ),
                ),
            )
        elif event.type == "interrupt":
            update.update(
                tutor=tutor.model_copy(
                    update={
                        "interrupted": True,
                        "emotion": "curious",
                        "narration": "已暂停当前讲解。你可以直接提问，原进度会保留。",
                    }
                ),
                feedback=ClassroomFeedback(
                    kind="interrupted",
                    message="讲解已暂停，课堂状态已保存。",
                ),
            )
        elif event.type == "update_parameters":
            actions = update_sandbox_parameters(snapshot.board_actions, event.parameters)
            update.update(
                phase="sandbox",
                active_action_id="sandbox",
                board_actions=actions,
                tutor=tutor.model_copy(
                    update={
                        "emotion": "focused",
                        "gaze_target": "sandbox",
                        "narration": "参数已更新，推演已从第 0 步重新开始。",
                    }
                ),
                feedback=ClassroomFeedback(
                    kind="instruction",
                    message="参数已更新，推演已重置。",
                ),
            )
        else:
            question = event.question or f"请解释 {event.action_id}"
            action = next(
                (
                    item
                    for item in snapshot.board_actions
                    if item.id == (event.action_id or snapshot.active_action_id)
                ),
                None,
            )
            if action is None:
                raise ValueError("Board action not found")
            reply = await self.companion.submit_text_turn(
                session_id=session_id,
                text=(
                    f"课堂主题：{snapshot.topic}\n"
                    f"当前板书：{action.title}\n"
                    f"当前板书数据：{action.payload.model_dump_json()}\n"
                    f"学生问题：{question}"
                ),
            )
            reply_citations = self._validated_citations(snapshot.space_id, reply.citations)
            update.update(
                citations=self._merge_citations(snapshot.citations, reply_citations),
                tutor=tutor.model_copy(
                    update={
                        "emotion": reply.emotion,
                        "gaze_target": event.action_id or snapshot.active_action_id,
                        "narration": reply.spoken_text,
                    }
                ),
                feedback=ClassroomFeedback(
                    kind="answer",
                    message="问题已绑定到当前板书步骤。实时导师会沿用同一课堂会话继续回答。",
                ),
            )

        return self.store.save_snapshot(snapshot.model_copy(update=update))

    def propose_flashcards(self, session_id: str) -> list[FlashcardRecord]:
        snapshot = self.get(session_id)
        if snapshot.phase != "review":
            return []
        citations = self._validated_citations(snapshot.space_id, snapshot.citations)
        existing = self.store.list_flashcards(space_id=snapshot.space_id, status=None)
        existing_for_session = [item for item in existing if item.source_session_id == session_id]
        if existing_for_session:
            return existing_for_session
        now = datetime.now(timezone.utc)
        cards = [
            FlashcardRecord(
                id=str(uuid4()),
                space_id=snapshot.space_id,
                source_session_id=session_id,
                prompt=f"{snapshot.topic} 的核心不变量是什么？",
                answer="每次推演后，仍待检查的目标必须完整保留在当前有效区间或状态集合中。",
                status="proposed",
                citations=citations,
                created_at=now,
                updated_at=now,
            ),
            FlashcardRecord(
                id=str(uuid4()),
                space_id=snapshot.space_id,
                source_session_id=session_id,
                prompt=f"如何验证 {snapshot.topic} 的单步推演没有越界？",
                answer="逐步核对输入、活动边界、状态变化和终止条件，并用反例检查边界值。",
                status="proposed",
                citations=citations,
                created_at=now,
                updated_at=now,
            ),
        ]
        for card in cards:
            self.store.upsert_flashcard(card, fsrs_card_json=None)
        return cards

    def confirm_flashcard(self, *, space_id: str, card_id: str) -> FlashcardRecord:
        stored = self.store.get_flashcard(space_id=space_id, card_id=card_id)
        if stored is None:
            raise ValueError("Flashcard not found")
        card, fsrs_json = stored
        if fsrs_json:
            return card
        now = datetime.now(timezone.utc)
        fsrs_card = Card(card_id=UUID(card.id).int, due=now)
        active = card.model_copy(update={"status": "active", "due_at": now, "updated_at": now})
        fsrs_state = json.dumps({"card": json.loads(fsrs_card.to_json()), "reps": 0, "lapses": 0})
        return self.store.upsert_flashcard(active, fsrs_card_json=fsrs_state)

    def rate_flashcard(self, *, space_id: str, card_id: str, rating: int) -> FlashcardRecord:
        stored = self.store.get_flashcard(space_id=space_id, card_id=card_id)
        if stored is None:
            raise ValueError("Flashcard not found")
        card, fsrs_json = stored
        if card.status != "active" or not fsrs_json:
            raise ValueError("Flashcard must be confirmed before rating")
        now = datetime.now(timezone.utc)
        state = json.loads(fsrs_json)
        scheduled, _ = self.scheduler.review_card(
            card=Card.from_json(json.dumps(state["card"])),
            rating=Rating(rating),
            review_datetime=now,
        )
        next_reps = int(state.get("reps", 0)) + 1
        next_lapses = int(state.get("lapses", 0)) + (1 if rating == Rating.Again else 0)
        updated = card.model_copy(
            update={
                "due_at": scheduled.due,
                "stability": scheduled.stability,
                "difficulty": scheduled.difficulty,
                "reps": next_reps,
                "lapses": next_lapses,
                "updated_at": now,
            }
        )
        next_state = json.dumps(
            {
                "card": json.loads(scheduled.to_json()),
                "reps": next_reps,
                "lapses": next_lapses,
            }
        )
        return self.store.upsert_flashcard(updated, fsrs_card_json=next_state)

    @staticmethod
    def _phase_narration(phase: str) -> str:
        return {
            "concept": "先确认概念和符号。",
            "sandbox": "逐步执行并观察活动边界如何变化。",
            "diagram": "点击关系节点，把局部变化放回整体流程。",
            "quiz": "现在做一次随堂检验。",
            "review": "把关键不变量整理成可复习的记忆卡。",
        }[phase]

    def _validated_citations(self, space_id: str, citations: list[Citation]) -> list[Citation]:
        chunks = {chunk.id: chunk for chunk in self.repository.list_chunks(space_id)}
        validated: list[Citation] = []
        for citation in citations:
            chunk = chunks.get(citation.chunk_id)
            if chunk is None:
                raise RuntimeError("Citation is outside the classroom study space")
            if (
                citation.material_id != chunk.material_id
                or citation.locator != chunk.locator
                or citation.title != chunk.title
            ):
                raise RuntimeError("Citation metadata does not match the retrieved chunk")
            validated.append(citation)
        return validated

    @staticmethod
    def _merge_citations(*groups: list[Citation]) -> list[Citation]:
        merged: dict[str, Citation] = {}
        for group in groups:
            for citation in group:
                merged[citation.chunk_id] = citation
        return list(merged.values())[:3]

