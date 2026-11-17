"""The browser harness injects this gateway. Model traffic stays in process."""

import re

from app.llm.gateway import LLMGateway
from app.providers.errors import MissingRoleError
from app.services.provider_registry import RoleTestResult
from app.voice.tts.edge import EdgeUnavailableError


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
        elif prompt_name == "analysis/course_brief":
            raw = "<brief><summary>资料已整理为可核对的知识地图与真题索引。</summary><top_point>条件关系</top_point></brief>"
        else:
            raise AssertionError(f"Unexpected tagged prompt: {prompt_name}")
        return parse(raw)

    async def stream_text(self, role, system, messages, **options):
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
