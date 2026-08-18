from app.services.prompt_loader import PromptLoader


def test_prompt_loader_uses_companion_language(isolated_settings) -> None:
    prompt = PromptLoader(isolated_settings).compose_system_prompt()
    assert "anime study companion" in prompt or "伴学" in prompt
    assert "Return JSON only" in prompt
