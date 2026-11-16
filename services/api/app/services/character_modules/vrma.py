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


class VrmaValidationMixin:
    def _validate_vrma_bytes(self, data: bytes) -> None:
        document, binary = self._parse_glb_json(
            data,
            error_message="Invalid VRMA signature",
            allow_unknown_chunks=False,
        )
        asset = document.get("asset")
        if not isinstance(asset, dict) or asset.get("version") != "2.0":
            raise ValueError("Invalid VRMA signature")
        extensions_used = document.get("extensionsUsed")
        if not isinstance(extensions_used, list) or "VRMC_vrm_animation" not in extensions_used:
            raise ValueError("VRMA must declare VRMC_vrm_animation in extensionsUsed")
        extensions = document.get("extensions")
        if not isinstance(extensions, dict) or not isinstance(extensions.get("VRMC_vrm_animation"), dict):
            raise ValueError("VRMA is missing the VRMC_vrm_animation extension")
        extension = extensions["VRMC_vrm_animation"]
        if extension.get("specVersion") != "1.0":
            raise ValueError("VRMA specVersion must be 1.0")
        if {"expressions", "lookAt"}.intersection(extension):
            raise ValueError("Companion Space VRMA assets must be body-only")
        if _VRMA_RENDERING_PAYLOAD_KEYS.intersection(document):
            raise ValueError("VRMA cannot contain rendering payload")
        nodes = document.get("nodes")
        humanoid = extension.get("humanoid")
        human_bones = humanoid.get("humanBones") if isinstance(humanoid, dict) else None
        if not isinstance(nodes, list) or not isinstance(human_bones, dict):
            raise ValueError("VRMA humanoid mapping is missing")
        missing_bones = _VRMA_REQUIRED_HUMAN_BONES.difference(human_bones)
        if missing_bones:
            raise ValueError("VRMA humanoid mapping is missing required bones")
        humanoid_node_indexes: set[int] = set()
        human_bone_node_indexes: list[int] = []
        for bone in human_bones.values():
            node_index = bone.get("node") if isinstance(bone, dict) else None
            if type(node_index) is not int or not 0 <= node_index < len(nodes):
                raise ValueError("VRMA humanoid mapping contains an invalid node")
            humanoid_node_indexes.add(node_index)
            human_bone_node_indexes.append(node_index)
        if len(human_bone_node_indexes) != len(humanoid_node_indexes):
            raise ValueError("VRMA human bones must use unique nodes")
        if any(
            isinstance(node, dict) and {"camera", "mesh", "skin", "weights"}.intersection(node)
            for node in nodes
        ):
            raise ValueError("VRMA cannot contain rendering payload")

        buffers = document.get("buffers")
        buffer_views = document.get("bufferViews")
        accessors = document.get("accessors")
        if (
            not isinstance(buffers, list)
            or len(buffers) != 1
            or not isinstance(buffer_views, list)
            or not isinstance(accessors, list)
        ):
            raise ValueError("VRMA must contain one embedded animation buffer")
        buffer = buffers[0]
        buffer_length = buffer.get("byteLength") if isinstance(buffer, dict) else None
        if (
            type(buffer_length) is not int
            or buffer_length <= 0
            or "uri" in buffer
        ):
            raise ValueError("VRMA must contain one embedded animation buffer")
        if binary is None:
            raise ValueError("VRMA must contain exactly one BIN chunk")
        if not buffer_length <= len(binary) <= buffer_length + 3:
            raise ValueError("VRMA BIN padding must be between zero and three bytes")
        for view in buffer_views:
            if not isinstance(view, dict) or view.get("buffer") != 0:
                raise ValueError("VRMA contains an invalid buffer view")
            offset = view.get("byteOffset", 0)
            length = view.get("byteLength")
            if (
                type(offset) is not int
                or type(length) is not int
                or offset < 0
                or length <= 0
                or offset + length > buffer_length
            ):
                raise ValueError("VRMA contains an invalid buffer view")

        animations = document.get("animations")
        if not isinstance(animations, list) or not animations:
            raise ValueError("VRMA must contain a playable rotation animation")
        playable_tracks = 0
        channel_targets: set[tuple[int, str]] = set()
        accessor_cache: dict[tuple[int, str], list[tuple[float, ...]]] = {}
        for animation in animations:
            channels = animation.get("channels") if isinstance(animation, dict) else None
            samplers = animation.get("samplers") if isinstance(animation, dict) else None
            if not isinstance(channels, list) or not channels or not isinstance(samplers, list):
                raise ValueError("VRMA must contain a playable rotation animation")
            for channel in channels:
                target = channel.get("target") if isinstance(channel, dict) else None
                sampler_index = channel.get("sampler") if isinstance(channel, dict) else None
                if (
                    not isinstance(target, dict)
                    or target.get("path") != "rotation"
                    or type(sampler_index) is not int
                    or not 0 <= sampler_index < len(samplers)
                ):
                    raise ValueError("Companion Space VRMA assets only support in-place rotation channels")
                node_index = target.get("node")
                if type(node_index) is not int or node_index not in humanoid_node_indexes:
                    raise ValueError("VRMA rotation channels must target declared humanoid bones")
                target_key = (node_index, "rotation")
                if target_key in channel_targets:
                    raise ValueError("VRMA contains a duplicate channel target")
                channel_targets.add(target_key)
                sampler = samplers[sampler_index]
                input_index = sampler.get("input") if isinstance(sampler, dict) else None
                output_index = sampler.get("output") if isinstance(sampler, dict) else None
                interpolation = sampler.get("interpolation", "LINEAR") if isinstance(sampler, dict) else None
                if (
                    type(input_index) is not int
                    or type(output_index) is not int
                    or not 0 <= input_index < len(accessors)
                    or not 0 <= output_index < len(accessors)
                    or interpolation not in {"LINEAR", "STEP", "CUBICSPLINE"}
                ):
                    raise ValueError("VRMA contains an invalid animation sampler")
                input_accessor = accessors[input_index]
                output_accessor = accessors[output_index]
                input_count = input_accessor.get("count") if isinstance(input_accessor, dict) else None
                output_count = output_accessor.get("count") if isinstance(output_accessor, dict) else None
                count_factor = 3 if interpolation == "CUBICSPLINE" else 1
                if type(input_count) is not int or type(output_count) is not int:
                    raise ValueError("VRMA contains an invalid animation accessor")
                if input_count <= 0 or output_count <= 0:
                    raise ValueError("VRMA accessor bounds are invalid")
                if input_count > _VRMA_MAX_KEYFRAMES:
                    raise ValueError("VRMA animation exceeds the keyframe limit")
                if output_count != input_count * count_factor:
                    if interpolation == "CUBICSPLINE":
                        raise ValueError("VRMA CUBICSPLINE output count must be three times input count")
                    raise ValueError("VRMA animation input and output counts must match")
                input_key = (input_index, "SCALAR")
                if input_key not in accessor_cache:
                    accessor_cache[input_key] = self._read_vrma_accessor(
                        input_accessor,
                        buffer_views,
                        binary,
                        accessor_type="SCALAR",
                        max_count=_VRMA_MAX_KEYFRAMES,
                    )
                input_values = accessor_cache[input_key]
                output_key = (output_index, "VEC4")
                if output_key not in accessor_cache:
                    accessor_cache[output_key] = self._read_vrma_accessor(
                        output_accessor,
                        buffer_views,
                        binary,
                        accessor_type="VEC4",
                        max_count=_VRMA_MAX_KEYFRAMES * count_factor,
                    )
                output_values = accessor_cache[output_key]
                times = [value[0] for value in input_values]
                if not all(math.isfinite(value) for value in times):
                    raise ValueError("VRMA animation input times must be finite")
                if any(current <= previous for previous, current in zip(times, times[1:])):
                    raise ValueError("VRMA animation input times must be strictly increasing")
                if not all(math.isfinite(component) for value in output_values for component in value):
                    raise ValueError("VRMA animation output must contain finite quaternions")
                key_quaternions = output_values[1::3] if interpolation == "CUBICSPLINE" else output_values
                norms = [math.sqrt(sum(component * component for component in value)) for value in key_quaternions]
                if any(norm <= 1e-8 for norm in norms):
                    raise ValueError("VRMA animation output must contain non-zero quaternions")
                if any(not 0.98 <= norm <= 1.02 for norm in norms):
                    raise ValueError("VRMA animation output must contain unit quaternions")
                playable_tracks += 1
        if playable_tracks == 0:
            raise ValueError("VRMA must contain a playable rotation animation")

    @staticmethod
    def _read_vrma_accessor(
        accessor: object,
        buffer_views: list[object],
        binary: bytes,
        *,
        accessor_type: str,
        max_count: int,
    ) -> list[tuple[float, ...]]:
        if (
            not isinstance(accessor, dict)
            or accessor.get("componentType") != 5126
            or accessor.get("type") != accessor_type
            or "sparse" in accessor
        ):
            raise ValueError("VRMA contains an invalid animation accessor")
        view_index = accessor.get("bufferView")
        if type(view_index) is not int or not 0 <= view_index < len(buffer_views):
            raise ValueError("VRMA contains an invalid animation accessor")
        view = buffer_views[view_index]
        if not isinstance(view, dict):
            raise ValueError("VRMA contains an invalid animation accessor")
        offset = accessor.get("byteOffset", 0)
        count = accessor.get("count")
        if (
            type(offset) is not int
            or offset < 0
            or offset % 4 != 0
            or type(count) is not int
            or count <= 0
        ):
            raise ValueError("VRMA accessor bounds are invalid")
        if count > max_count:
            raise ValueError("VRMA animation exceeds the keyframe limit")
        component_count = 1 if accessor_type == "SCALAR" else 4
        element_size = component_count * 4
        stride = view.get("byteStride", element_size)
        if type(stride) is not int or stride < element_size or stride > 252 or stride % 4 != 0:
            raise ValueError("VRMA accessor stride is invalid")
        view_length = view["byteLength"]
        span = offset + (count - 1) * stride + element_size
        start = view.get("byteOffset", 0) + offset
        if start % 4 != 0 or span > view_length:
            raise ValueError("VRMA accessor span exceeds its buffer view")
        format_string = "<f" if component_count == 1 else "<4f"
        try:
            return [struct.unpack_from(format_string, binary, start + index * stride) for index in range(count)]
        except struct.error as exc:
            raise ValueError("VRMA accessor span exceeds its buffer view") from exc

    @classmethod
    def _validate_vrma_motion_references(
        cls,
        recipe: CharacterRecipe,
        manifest: dict[str, Any],
        asset_files: dict[str, bytes],
    ) -> None:
        declared_paths = manifest.get("asset_paths")
        declared = (
            {path for path in declared_paths if isinstance(path, str)}
            if isinstance(declared_paths, list)
            else set()
        )
        for motion_path in recipe.motions.values():
            if motion_path in _BUILT_IN_VRMA_URLS:
                continue
            if not motion_path.lower().endswith(".vrma"):
                continue
            try:
                normalized = cls._normalize_relative_posix_path(
                    motion_path,
                    traversal_message="Character recipe VRMA motion path is unsafe",
                )
            except ValueError as exc:
                raise ValueError("Character recipe VRMA motion path is unsafe") from exc
            if ":" in PurePosixPath(normalized).parts[0]:
                raise ValueError("Character recipe VRMA motion path is unsafe")
            if normalized not in declared:
                raise ValueError("Character recipe VRMA motion path must be listed in asset_paths")
            if normalized not in asset_files:
                raise ValueError("Character recipe VRMA motion asset is missing")
