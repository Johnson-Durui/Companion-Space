from app.llm.gateway import LLMGateway


class LessonTestGateway(LLMGateway):
    def __init__(self, registry):
        super().__init__(registry)
        self.prompts = []

    async def stream_text(self, role, system, messages, **options):
        self.prompts.append(messages[0].content)
        yield "<board type=text>From the source</board><say>Think "
        yield "about the rule.</say>"

    async def complete_tagged(self, role, template, variables, *, parse, **options):
        assert role == "analysis" and template == "analysis/lesson_recap"
        assert "Think about the rule" in variables["course_context"]
        assert '"verdict": "correct"' in variables["course_context"]
        return parse("<recap>The learner answered the check correctly.</recap>")
