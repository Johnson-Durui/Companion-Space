"""The browser harness injects this gateway. Model traffic stays in process."""

from app.llm.gateway import LLMGateway
from app.providers.errors import MissingRoleError
from app.services.provider_registry import RoleTestResult
from app.voice.tts.edge import EdgeUnavailableError


class BrowserHarnessGateway(LLMGateway):
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
