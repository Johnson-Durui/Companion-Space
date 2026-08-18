from __future__ import annotations

import re
from pathlib import PurePosixPath, PureWindowsPath

from app.models.domain import Material


MATERIAL_STORAGE_PATH_ERROR = (
    "Material storage path is outside the requested study space"
)
SUPPORTED_MATERIAL_SUFFIXES = frozenset({".md", ".pdf", ".txt"})


def build_material_storage_key(
    *,
    space_id: str,
    material_id: str,
    filename: str,
) -> str:
    _validate_component(space_id)
    _validate_component(material_id)
    _validate_filename(filename)
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in SUPPORTED_MATERIAL_SUFFIXES:
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)
    return PurePosixPath(
        "spaces",
        space_id,
        "materials",
        f"{material_id}{suffix}",
    ).as_posix()


def canonical_material_storage_key(material: Material) -> str:
    expected = build_material_storage_key(
        space_id=material.space_id,
        material_id=material.id,
        filename=material.filename,
    )
    if material.storage_path != expected:
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)
    return expected


def canonicalize_legacy_material_storage_key(material: Material) -> str:
    expected = build_material_storage_key(
        space_id=material.space_id,
        material_id=material.id,
        filename=material.filename,
    )
    raw = material.storage_path
    if raw == expected:
        return expected
    if not raw or "\x00" in raw or any(
        ord(character) < 32 or ord(character) == 127 for character in raw
    ):
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)

    raw_segments = re.split(r"[\\/]", raw)
    if any(segment in {".", ".."} for segment in raw_segments):
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)

    normalized = raw.replace("\\", "/")
    if not (
        PurePosixPath(normalized).is_absolute()
        or PureWindowsPath(raw).is_absolute()
    ):
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)

    legacy_parts = PurePosixPath(normalized).parts
    expected_parts = PurePosixPath(expected).parts
    if len(legacy_parts) < len(expected_parts) or tuple(
        legacy_parts[-len(expected_parts) :]
    ) != expected_parts:
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)
    return expected


def _validate_component(value: str) -> None:
    if (
        not value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or "\x00" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)


def _validate_filename(filename: str) -> None:
    if (
        not filename
        or filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in filename
        )
    ):
        raise ValueError(MATERIAL_STORAGE_PATH_ERROR)
