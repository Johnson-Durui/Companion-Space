from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from app.services.repository import SQLiteRepository


class Appearance(BaseModel):
    kind: Literal["vrm", "portrait"]
    src: str
    framing: dict[str, str | float] = Field(default_factory=dict)


class Voice(BaseModel):
    engine: str = "edge"
    voice_id: str
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: int = Field(default=0, ge=-100, le=100)


class Persona(BaseModel):
    relationship: str
    traits: list[str]
    catchphrases: list[str]
    address_user_as: str


class Character(BaseModel):
    id: str
    name: str
    schema_version: Literal[2] = 2
    appearance: Appearance
    voice: Voice
    persona: Persona
    default_style_id: str
    license: str


class TutorCatalog:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository

    def seed(self) -> None:
        root = self.repository.settings.repo_root
        characters = [
            Character.model_validate_json(path.read_text(encoding="utf-8"))
            for path in sorted((root / "content/characters").glob("*.json"))
        ]
        now = datetime.now(timezone.utc).isoformat()
        with self.repository.connection() as conn:
            conn.executemany(
                """
                INSERT INTO character_packs
                    (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                VALUES (?, ?, '', ?, '{}', ?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                [(character.id, character.name, character.model_dump_json(), now, now) for character in characters],
            )

    def list_characters(self) -> list[Character]:
        with self.repository.connection() as conn:
            rows = conn.execute("SELECT recipe_json FROM character_packs ORDER BY rowid").fetchall()
        recipes = (json.loads(row["recipe_json"]) for row in rows)
        return [Character.model_validate(recipe) for recipe in recipes if recipe.get("schema_version") == 2]

    def get_character(self, character_id: str) -> Character | None:
        with self.repository.connection() as conn:
            row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", (character_id,)).fetchone()
        if row is None:
            return None
        recipe = json.loads(row["recipe_json"])
        return Character.model_validate(recipe) if recipe.get("schema_version") == 2 else None
