from __future__ import annotations

from datetime import datetime, timezone

from app.models.domain import CharacterPack, CharacterRecipe
from app.services.character_modules.persona import build_tutor_persona


def test_tutor_persona_is_deterministic_and_excludes_asset_manifest() -> None:
    now = datetime.now(timezone.utc)
    character = CharacterPack(
        id="tutor-1",
        name="Mira",
        description="A patient mathematics tutor.",
        recipe=CharacterRecipe(
            personality="steady",
            warmth=82,
            initiative=61,
            humor=24,
            challenge=67,
            voice_provider="local",
            voice_model="qwen3-tts",
            voice_id="mira",
            speaking_rate=0.95,
        ),
        asset_manifest={"private_marker": "must-not-enter-prompt"},
        created_at=now,
        updated_at=now,
    )

    first = build_tutor_persona(character)
    second = build_tutor_persona(character)

    assert first == second
    assert first.character_id == character.id
    assert "A patient mathematics tutor." in first.system_prompt
    assert "warmth=82" in first.teaching_style
    assert "must-not-enter-prompt" not in first.system_prompt
    assert first.voice_id == "mira"
