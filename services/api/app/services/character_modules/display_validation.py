from __future__ import annotations

# ruff: noqa: F401,F403,F405
import hashlib
import json
import logging
import math
import mimetypes
import os
import re
import shutil
import stat
import struct
import unicodedata
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from app.models.domain import CharacterPack, CharacterRecipe, DEFAULT_CHARACTER_RECIPE_DATA
from app.services.character_modules.common import *
from app.services.repository import SQLiteRepository


class DisplayModelValidationMixin:
    @classmethod
    def _validate_live2d_archive(cls, files: dict[str, bytes]) -> str:
        files = {
            path: content
            for path, content in files.items()
            if not any(part.casefold() == "__macosx" for part in PurePosixPath(path).parts)
            and not PurePosixPath(path).name.startswith("._")
        }
        model_paths = sorted(
            path for path in files if path.casefold().endswith((".model3.json", ".model.json"))
        )
        if not model_paths:
            moc_paths = sorted(path for path in files if path.casefold().endswith(".moc3"))
            if len(moc_paths) != 1:
                raise ValueError("Live2D archive must contain one model JSON or one MOC3 entrypoint")
            if not files[moc_paths[0]].startswith(b"MOC3"):
                raise ValueError("Live2D MOC3 signature is invalid")
            if not any(
                path.casefold().endswith((".png", ".jpg", ".jpeg", ".webp"))
                for path in files
            ):
                raise ValueError("Live2D MOC3 archive must contain a local texture")
            return moc_paths[0]
        if len(model_paths) != 1:
            raise ValueError("Live2D archive must contain exactly one model JSON entrypoint")

        entrypoint = model_paths[0]
        if len(files[entrypoint]) > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("Live2D model metadata exceeds the size limit")
        model = cls._read_json_object(files[entrypoint], "Live2D model JSON")
        raw_references = model.get("FileReferences", model)
        if not isinstance(raw_references, dict):
            raise ValueError("Live2D model FileReferences must be a JSON object")
        reference_map = {str(key).casefold(): value for key, value in raw_references.items()}
        moc = reference_map.get("moc", reference_map.get("model"))
        textures = reference_map.get("textures")
        if not isinstance(moc, str) or not moc.strip():
            raise ValueError("Live2D model must reference a core MOC asset")
        if (
            not isinstance(textures, list)
            or not textures
            or not all(isinstance(item, str) and item.strip() for item in textures)
        ):
            raise ValueError("Live2D model must reference one or more local textures")
        references = [moc, *textures]
        for key in ("physics", "pose", "displayinfo", "userdata"):
            value = reference_map.get(key)
            if value is None:
                continue
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Live2D model {key} reference must be a string or null")
            references.append(value)

        expressions = reference_map.get("expressions")
        if expressions is not None:
            if not isinstance(expressions, list):
                raise ValueError("Live2D model expressions must be a list")
            for expression in expressions:
                if isinstance(expression, str) and expression.strip():
                    references.append(expression)
                    continue
                if isinstance(expression, dict):
                    expression_map = {str(key).casefold(): value for key, value in expression.items()}
                    expression_file = expression_map.get("file")
                    if isinstance(expression_file, str) and expression_file.strip():
                        references.append(expression_file)
                        continue
                raise ValueError("Live2D model expression must be a path or contain File")

        motions = reference_map.get("motions")
        if motions is not None:
            stack = [motions]
            while stack:
                value = stack.pop()
                if isinstance(value, dict):
                    for key, child in value.items():
                        if str(key).casefold() in {"file", "sound"}:
                            if not isinstance(child, str) or not child.strip():
                                raise ValueError("Live2D motion reference must be a string")
                            references.append(child)
                        else:
                            stack.append(child)
                elif isinstance(value, list):
                    stack.extend(value)

        resolved_references = cls._require_local_archive_references(
            entrypoint,
            references,
            files,
            "Live2D model",
        )
        if not files[resolved_references[0]].startswith(b"MOC3"):
            raise ValueError("Live2D MOC3 signature is invalid")
        return entrypoint

    @classmethod
    def _validate_spine_archive(cls, files: dict[str, bytes]) -> str:
        files = {
            path: content
            for path, content in files.items()
            if not any(part.casefold() == "__macosx" for part in PurePosixPath(path).parts)
            and not PurePosixPath(path).name.startswith("._")
        }
        skeletons = sorted(
            path
            for path in files
            if path.casefold().endswith(".skel")
            or (path.casefold().endswith(".json") and not path.casefold().endswith(".model.json"))
        )
        atlases = sorted(
            path
            for path in files
            if path.casefold().endswith((".atlas", ".atlas.txt"))
        )
        if not skeletons or not atlases:
            raise ValueError("Spine archive must contain a skeleton and atlas pair")
        same_directory_pairs = [
            (skeleton, atlas)
            for skeleton in skeletons
            for atlas in atlases
            if PurePosixPath(skeleton).parent == PurePosixPath(atlas).parent
        ]
        exact_pairs = [
            (skeleton, atlas)
            for skeleton, atlas in same_directory_pairs
            if PurePosixPath(skeleton).with_suffix("")
            == PurePosixPath(atlas.removesuffix(".txt")).with_suffix("")
        ]
        runnable_pairs = exact_pairs or same_directory_pairs
        if len(runnable_pairs) != 1:
            raise ValueError("Spine archive must contain one unambiguous same-directory pair")
        skeleton, atlas = runnable_pairs[0]
        if skeleton.casefold().endswith(".json"):
            if len(files[skeleton]) > CHARACTER_CARD_MAX_BYTES:
                raise ValueError("Spine skeleton metadata exceeds the size limit")
            cls._read_json_object(files[skeleton], "Spine skeleton JSON")
        elif not files[skeleton]:
            raise ValueError("Spine skeleton is empty")
        if len(files[atlas]) > CHARACTER_CARD_MAX_BYTES:
            raise ValueError("Spine atlas metadata exceeds the size limit")
        try:
            lines = files[atlas].decode("utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise ValueError("Spine atlas must be valid UTF-8 text") from exc
        textures = [
            line.strip()
            for line in lines
            if line.strip().casefold().endswith((".png", ".jpg", ".jpeg", ".webp"))
            and ":" not in line
        ]
        if not textures:
            raise ValueError("Spine atlas does not reference a local texture")
        cls._require_local_archive_references(atlas, textures, files, "Spine atlas")
        return skeleton

    @classmethod
    def _require_local_archive_references(
        cls,
        entrypoint: str,
        references: list[str],
        files: dict[str, bytes],
        label: str,
    ) -> list[str]:
        parent_parts = list(PurePosixPath(entrypoint).parent.parts)
        resolved_references: list[str] = []
        for reference in references:
            raw_reference = reference.strip()
            if re.search(r"%(?![0-9a-fA-F]{2})", raw_reference):
                raise ValueError(f"{label} contains an unsafe local reference")
            try:
                decoded_reference = unquote(raw_reference, encoding="utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise ValueError(f"{label} contains an unsafe local reference") from exc
            parsed = urlsplit(decoded_reference)
            if (
                parsed.scheme
                or parsed.netloc
                or parsed.query
                or parsed.fragment
                or decoded_reference.startswith(("//", "/"))
                or "\\" in decoded_reference
            ):
                raise ValueError(f"{label} cannot reference remote resources")
            try:
                stack = list(parent_parts)
                for part in parsed.path.split("/"):
                    if part in {"", "."}:
                        continue
                    if part == "..":
                        if not stack:
                            raise ValueError
                        stack.pop()
                        continue
                    normalized_part = cls._normalize_relative_posix_path(
                        part,
                        traversal_message=f"{label} contains an unsafe local reference",
                    )
                    stack.append(normalized_part)
                if not stack:
                    raise ValueError
                resolved = "/".join(stack)
            except ValueError as exc:
                raise ValueError(f"{label} contains an unsafe local reference") from exc
            if resolved not in files:
                raise ValueError(f"{label} references a missing local asset: {reference}")
            resolved_references.append(resolved)
        return resolved_references

    def _index_character_archive(self, archive: ZipFile) -> dict[str, Any]:
        members: dict[str, Any] = {}
        archive_names: set[str] = set()
        portable_names: set[str] = set()
        total_uncompressed_size = 0
        infos = archive.infolist()
        if len(infos) > _MAX_CHARACTER_ARCHIVE_MEMBERS:
            raise ValueError("Character pack contains too many files")
        for info in infos:
            normalized_name = self._normalize_archive_member_name(info.filename)
            self._validate_archive_member(info, normalized_name)
            if normalized_name in archive_names:
                raise ValueError("Character pack contains duplicate files")
            archive_names.add(normalized_name)
            portable_name = self._portable_path_key(normalized_name)
            if portable_name in portable_names:
                raise ValueError("Character pack contains a portable filename collision")
            portable_names.add(portable_name)
            if info.flag_bits & 0x1:
                raise ValueError("Character pack cannot contain encrypted files")
            total_uncompressed_size += info.file_size
            if total_uncompressed_size > self.repository.settings.max_character_pack_size_bytes:
                raise ValueError("Character pack exceeds the configured size limit")
            if info.is_dir():
                continue
            members[normalized_name] = info
        return members
