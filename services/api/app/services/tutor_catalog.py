from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from pydantic import BaseModel, Field, StringConstraints

from app.services.character_modules.common import _existing_io_file, _windows_io_path
from app.services.character_modules.paths import CharacterPathMixin
from app.services.character_modules.vrm import VrmValidationMixin
from app.services.repository import SQLiteRepository


type StyleId = Literal["guided", "direct", "analogy", "exam", "rigorous"]
ShortLine = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
_VRM_ASSET = "model.vrm"
_EXPRESSIONS = {"aa", "ih", "ou", "ee", "oh", "blink", "happy", "sad", "relaxed"}
_LEGACY_EXPRESSIONS = dict(zip(("a", "i", "u", "e", "o", "joy", "sorrow", "fun"),
                                ("aa", "ih", "ou", "ee", "oh", "happy", "sad", "relaxed"), strict=True))


class ModelMetadata(BaseModel):
    authors: list[str]
    spec_version: str
    license_url: str | None
    other_license_url: str | None
    redistribution_allowed: bool
    missing_expressions: list[str]


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
    model_metadata: ModelMetadata | None = None


class TutorUpdate(BaseModel):
    name: ShortLine
    relationship: str = Field(max_length=160)
    traits: list[ShortLine] = Field(max_length=8)
    catchphrases: list[ShortLine] = Field(max_length=8)
    address_user_as: str = Field(max_length=160)
    default_style_id: StyleId


def _safe_license_url(value: str) -> str | None:
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    return value if url.scheme in {"https", "http"} and url.hostname and not (url.username or url.password) else None


def _inspect_model(data: bytes) -> tuple[dict, ModelMetadata]:
    document, _ = VrmValidationMixin._parse_glb_json(
        data, error_message="This file is not a valid binary VRM.", allow_unknown_chunks=False,
    )
    for collection, accepted in (("images", ("data:image/",)), ("buffers", ("data:application/",))):
        resources = document.get(collection, [])
        if not isinstance(resources, list) or any(not isinstance(resource, dict) for resource in resources):
            raise ValueError("The VRM contains invalid asset references.")
        for resource in resources:
            uri = resource.get("uri")
            if uri is not None and (not isinstance(uri, str) or not uri.startswith(accepted)):
                raise ValueError("The VRM must embed its images and buffers in the file.")
    extensions = document.get("extensions")
    if not isinstance(extensions, dict):
        raise ValueError("VRM metadata is missing.")
    vrm1 = isinstance(extensions.get("VRMC_vrm"), dict)
    definition = extensions.get("VRMC_vrm" if vrm1 else "VRM")
    if not isinstance(definition, dict) or not isinstance(definition.get("meta"), dict):
        raise ValueError("VRM metadata is missing.")
    humanoid = definition.get("humanoid")
    bones = humanoid.get("humanBones") if isinstance(humanoid, dict) else None
    if vrm1:
        if not isinstance(bones, dict):
            raise ValueError("The model is missing a VRM 1.0 humanoid rig.")
        bone_nodes = {name: bone.get("node") for name, bone in bones.items() if isinstance(bone, dict)}
        expressions = definition.get("expressions")
        presets = expressions.get("preset") if isinstance(expressions, dict) else None
        present = {name for name, obj in presets.items() if isinstance(obj, dict)} if isinstance(presets, dict) else set()
        meta = VrmValidationMixin._normalize_vrm1_meta(definition["meta"], definition.get("specVersion"))
    else:
        if not isinstance(bones, list):
            raise ValueError("The model is missing a VRM 0.x humanoid rig.")
        bone_nodes = {bone.get("bone"): bone.get("node") for bone in bones if isinstance(bone, dict) and isinstance(bone.get("bone"), str)}
        shapes = definition.get("blendShapeMaster")
        groups = (shapes.get("blendShapeGroups") or []) if isinstance(shapes, dict) else []
        present = set()
        for group in groups:
            if isinstance(group, dict) and isinstance(group.get("presetName"), str):
                name = group["presetName"].lower()
                present.add(_LEGACY_EXPRESSIONS.get(name, name))
        meta = VrmValidationMixin._normalize_vrm0_meta(definition["meta"])
    nodes = document.get("nodes")
    core = {"hips", "spine", "head"}
    core.update(f"{side}{bone}" for side in ("left", "right") for bone in ("UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot"))
    if not isinstance(nodes, list) or not document.get("meshes") or any(
        type(bone_nodes.get(name)) is not int or not 0 <= bone_nodes[name] < len(nodes) for name in core
    ):
        raise ValueError("The model is missing required bones or mesh data.")
    return meta, ModelMetadata(
        authors=meta["authors"], spec_version=meta["spec_version"], license_url=_safe_license_url(meta["license_url"]),
        other_license_url=_safe_license_url(meta["other_license_url"]), redistribution_allowed=meta["redistribution_allowed"] == "yes",
        missing_expressions=sorted(_EXPRESSIONS - present),
    )


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

    def import_model(self, filename: str, data: bytes) -> Character:
        if Path(filename).suffix.lower() != ".vrm" or not data or len(data) > self.repository.settings.max_character_pack_size_bytes:
            raise ValueError("Choose a .vrm file within the configured size limit.")
        meta, metadata = _inspect_model(data)
        identifier = f"tutor-{uuid4().hex}"
        name = (meta["name"] or "Imported teacher")[:160]
        character = Character(
            id=identifier, name=name, appearance=Appearance(kind="vrm", src=f"/api/v2/characters/{identifier}/model"),
            voice=Voice(voice_id="zh-CN-XiaoxiaoNeural"),
            persona=Persona(relationship="", traits=[], catchphrases=[], address_user_as=""),
            default_style_id="guided", model_metadata=metadata,
            license=meta["license_name"] or ("VRM Public License 1.0" if metadata.spec_version == "1.0" else "Unknown"),
        )
        directory = _windows_io_path(CharacterPathMixin._contained_child(self.repository.settings.characters_root, identifier))
        directory.mkdir(parents=True, exist_ok=False)
        model = directory / _VRM_ASSET
        now = datetime.now(timezone.utc).isoformat()
        try:
            model.write_bytes(data)
            with self.repository.connection() as conn:
                conn.execute(
                    """INSERT INTO character_packs
                    (id, name, description, recipe_json, asset_manifest_json, created_at, updated_at)
                    VALUES (?, ?, '', ?, '{}', ?, ?)""",
                    (identifier, name, character.model_dump_json(), now, now),
                )
        except Exception:
            model.unlink(missing_ok=True)
            directory.rmdir()
            raise
        return character

    def update_character(self, identifier: str, payload: TutorUpdate) -> Character | None:
        with self.repository.connection() as conn:
            row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", (identifier,)).fetchone()
            if row is None:
                return None
            recipe = json.loads(row["recipe_json"])
            if recipe.get("schema_version") != 2:
                return None
            recipe.update(name=payload.name, default_style_id=payload.default_style_id,
                          persona=payload.model_dump(include={"relationship", "traits", "catchphrases", "address_user_as"}))
            character = Character.model_validate(recipe)
            conn.execute("UPDATE character_packs SET name = ?, recipe_json = ?, updated_at = ? WHERE id = ?",
                         (character.name, character.model_dump_json(), datetime.now(timezone.utc).isoformat(), identifier))
        return character

    def model_file(self, identifier: str) -> Path | None:
        character = self.get_character(identifier)
        if character is None or character.model_metadata is None:
            return None
        location = CharacterPathMixin._contained_child(self.repository.settings.characters_root, f"{identifier}/{_VRM_ASSET}")
        return _existing_io_file(location)
