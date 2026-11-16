from __future__ import annotations

from dataclasses import dataclass

from app.models.domain import CharacterPack


@dataclass(frozen=True)
class TutorPersona:
    character_id: str
    name: str
    teaching_style: str
    system_prompt: str
    voice_provider: str
    voice_model: str
    voice_id: str
    speaking_rate: float


def build_tutor_persona(character: CharacterPack) -> TutorPersona:
    recipe = character.recipe
    teaching_style = (
        f"personality={recipe.personality}; warmth={recipe.warmth}; "
        f"initiative={recipe.initiative}; humor={recipe.humor}; "
        f"challenge={recipe.challenge}"
    )
    description = character.description.strip()
    prompt_parts = [
        f"You are {character.name}, a focused virtual tutor.",
        f"Use this teaching profile: {teaching_style}.",
        "Explain with verifiable steps, ask short checkpoint questions, and cite retrieved sources.",
    ]
    if description:
        prompt_parts.insert(1, description)
    return TutorPersona(
        character_id=character.id,
        name=character.name,
        teaching_style=teaching_style,
        system_prompt=" ".join(prompt_parts),
        voice_provider=recipe.voice_provider,
        voice_model=recipe.voice_model,
        voice_id=recipe.voice_id,
        speaking_rate=recipe.speaking_rate,
    )
