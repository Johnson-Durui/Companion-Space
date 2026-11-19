"""The browser harness injects this gateway. Model traffic stays in process."""

import json
import re

from app.llm.gateway import LLMGateway
from app.repositories.mixins.common import utcnow
from app.providers.errors import MissingRoleError
from app.services.provider_registry import RoleTestResult
from app.voice.tts.edge import EdgeUnavailableError


def seed_classroom(container, scenario: str):
    from test_teaching_storage import _seed_plan

    course_id = f"browser-{scenario}-course"
    lesson_id = f"browser-{scenario}-lesson"
    plan_item_id = f"{lesson_id}-item"
    kp_id = f"{lesson_id}-kp"
    bank_id = f"{lesson_id}-question"
    repository = container.repository
    now = utcnow().isoformat()
    with repository.connection() as connection:
        _seed_plan(connection, course_id, plan_item_id)
        connection.execute("UPDATE plan_items SET kp_ids_json = ? WHERE id = ?", (json.dumps([kp_id]), plan_item_id))
        connection.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, created_at, updated_at)
               VALUES (?, ?, '关系判断', 'relation', 'concept', '关系判断', 'core', 1, 1, ?, ?)""",
            (kp_id, course_id, now, now),
        )
        connection.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES (?, ?, ?, 'generated', 'check', 'choice', '{}', 'verified', ?)""",
            (bank_id, course_id, kp_id, now),
        )
    appearance = "vrm" if scenario.startswith("avatar") else "portrait"
    teacher = next(character for character in container.tutors.list_characters() if character.appearance.kind == appearance)
    plan = {
        "title": "关系判断", "est_minutes": 10,
        "segments": [{
            "id": "seg1", "kp_id": kp_id, "keypoints": ["先确认条件"], "checks": ["q1"],
            "approaches": [{"kind": "visual", "keypoint": "all", "outline": "先写条件"}],
        }],
        "items": {
            "q1": {
                "type": "choice", "kp_id": kp_id, "bank_id": bank_id, "keypoints": [0],
                "stem": "如果条件成立，应选择哪一项？", "answer": "A", "verify": {"status": "verified"},
                "options": [{"key": "A", "text": "按条件推导"}, {"key": "B", "text": "忽略条件"}],
            },
        },
    }
    ready = repository.save_lesson_plan(course_id, plan_item_id, plan=plan)
    lesson = repository.create_or_resume_lesson(
        course_id, plan_item_id, lesson_plan_id=ready["id"],
        state={"stage": "opening"}, character_id=teacher.id,
    )
    with repository.connection() as connection:
        connection.execute("UPDATE lessons SET id = ? WHERE id = ?", (lesson_id, lesson["id"]))
        connection.execute("UPDATE plan_items SET lesson_id = ? WHERE id = ?", (lesson_id, plan_item_id))


class BrowserHarnessGateway(LLMGateway):
    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        if prompt_name == "analysis/kp_extract":
            raw = """<kp><name>条件关系</name><kind>concept</kind><importance>core</importance>
            <difficulty>2</difficulty><summary>根据已知条件判断结果。</summary>
            <must_know>识别条件</must_know><question_type>choice</question_type><pages>1</pages></kp>
            <kp><name>结果计算</name><kind>skill</kind><importance>important</importance>
            <difficulty>2</difficulty><summary>根据规则完成计算。</summary>
            <must_know>代入规则</must_know><prerequisite>条件关系</prerequisite>
            <question_type>choice</question_type><pages>1</pages></kp>"""
        elif prompt_name == "analysis/kp_reduce":
            keys = sorted(set(re.findall(r'"key":"(c\d+)"', variables["knowledge_candidates"])))
            raw = "".join(f"<merge><member>{key}</member></merge>" for key in keys)
            if len(keys) > 1:
                raw += f"<edge><before>{keys[0]}</before><after>{keys[1]}</after></edge>"
        elif prompt_name == "analysis/exam_segment":
            raw = """<paper><name>阶段测试</name><year>2025</year><full_score>10</full_score></paper>
            <item><no>1</no><type>choice</type><stem>根据材料，正确结果是哪一项？</stem>
            <option><key>A</key><text>不成立</text></option><option><key>B</key><text>成立</text></option>
            <answer>B</answer><score>10</score><difficulty>2</difficulty><pages>1</pages></item>"""
        elif prompt_name == "analysis/item_map":
            raw = "<map><item>i0</item><kp>k0</kp></map>"
        elif prompt_name == "analysis/item_solve":
            raw = "<solve><answer>成立</answer><confidence>high</confidence><valid>true</valid><reason>checked</reason></solve>"
        elif prompt_name == "analysis/item_choice_map":
            raw = "<mapping><choice>B</choice></mapping>"
        elif prompt_name == "analysis/item_equiv":
            raw = "<comparison><equivalent>true</equivalent></comparison>"
        elif prompt_name == "analysis/diagnostic_generate":
            raw = ""
        elif prompt_name == "analysis/kp_faithful":
            raw = "<support>supported</support>"
        elif prompt_name == "live/interview_ask":
            if role not in self.registry.get_roles():
                raise MissingRoleError(provider="fixture", public_detail="Connect this model role first")
            raw = "<question>你想怎么安排接下来的学习？</question>"
        elif prompt_name == "analysis/toc_infer":
            raw = "<none></none>"
        elif prompt_name == "analysis/course_brief":
            raw = "<brief><summary>资料已整理为可核对的知识地图与真题索引。</summary><top_point>条件关系</top_point></brief>"
        elif prompt_name == "analysis/lesson_recap":
            raw = "<recap>本节课复习了如何从条件出发。</recap>"
        else:
            raise AssertionError(f"Unexpected tagged prompt: {prompt_name}")
        return parse(raw)

    async def stream_text(self, role, system, messages, **options):
        prompt = str(messages[-1].content)
        if "recent_board" in prompt and "browser-avatar" in prompt:
            yield (
                '<cue gesture="explain" emotion="focused"/>'
                '<say emotion="focused">先确认已知条件。</say>'
                '<pause ms="1200"/>'
                '<board id="b-text" type="text">先确认已知条件。</board>'
                '<point target="b-text"/>'
            )
            return
        if "recent_board" in prompt:
            yield (
                "<board id=b-text type=text>先确认已知条件。</board>"
                "<board id=b-math type=math>x^2+1</board>"
                "<board id=b-table type=table>| x | y |\n|---|---|\n| 1 | 2 |</board>"
                '<board id=b-plot type=plot>{"fn":["x^2"],"x":[-2,2],"points":[[1,1]]}</board>'
                "<board id=b-diagram type=diagram>flowchart TD\nA --&gt;</board>"
                "<say>开始吧。</say>"
            )
            return
        if role not in self.registry.get_roles():
            raise MissingRoleError(provider="fixture", public_detail="Connect this model role first")
        if role == "vision":
            assert any(part["type"] == "image" for part in messages[-1].content)
            yield "公式："
            yield "$x^2+1=0$"
        else:
            yield "测试连接"
            yield "已响应。"

    async def discover_models(self, connection_id):
        return ["fixture-live", "fixture-vision"]

    async def test_connection(self, connection_id):
        return [
            RoleTestResult(role=role, ok=True, latency_ms=1, code="ok", message="Fixture response")
            for role, assignment in self.registry.get_roles().items() if assignment.connection_id == connection_id
        ]

    async def preview_voice(self, text, voice, rate=1, pitch=0):
        raise EdgeUnavailableError("Fixture online voice unavailable")
