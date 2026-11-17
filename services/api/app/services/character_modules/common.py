from __future__ import annotations

# ruff: noqa: F401

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
from threading import RLock
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from app.models.domain import CharacterPack, CharacterRecipe, DEFAULT_CHARACTER_RECIPE_DATA
from app.services.repository import SQLiteRepository

logger = logging.getLogger(__name__)


def _windows_io_path(path: Path) -> Path:
    """Prefix Windows paths so nested VRMA files can exceed MAX_PATH."""
    if os.name != "nt":
        return path
    text = os.fspath(path)
    if text.startswith("\\\\?\\") or text.startswith("\\\\.\\"):
        return path
    resolved = os.path.abspath(text)
    if resolved.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + resolved.removeprefix("\\\\"))
    return Path("\\\\?\\" + resolved)


def _existing_io_file(path: Path) -> Path | None:
    io_path = _windows_io_path(path)
    if io_path.is_file():
        return io_path
    if path.is_file():
        return path
    return None


# ponytail: one local owner and one uvicorn worker only; use a process-shared lock before adding workers.
_AVATAR_LIFECYCLE_LOCK = RLock()
_CREDENTIAL_KEY_PARTS = ("api_key", "apikey", "credential", "password", "secret", "token")
_ADULT_RELATIONSHIP_PATTERN = re.compile(
    r"\b(?:lover|romantic(?:\s+partner)?|girlfriend|boyfriend|spouse|husband|wife)\b",
    re.IGNORECASE,
)
_ADULT_RELATIONSHIP_TERMS = (
    "恋人",
    "情侣",
    "男友",
    "女友",
    "爱人",
    "伴侣",
    "亲密关系",
    "浪漫关系",
)
_REDISTRIBUTION_ALLOWED = {"1", "allowed", "true", "yes"}
_EXECUTABLE_SUFFIXES = {
    ".app",
    ".bat",
    ".bin",
    ".cmd",
    ".com",
    ".cpl",
    ".csh",
    ".dll",
    ".dylib",
    ".exe",
    ".jar",
    ".js",
    ".mjs",
    ".cjs",
    ".ksh",
    ".msi",
    ".ps1",
    ".py",
    ".rb",
    ".run",
    ".scr",
    ".sh",
    ".so",
}
_VRM0_NO_MODIFICATION_LICENSES = {
    "CC_BY_ND",
    "CC_BY_NC_ND",
    "Redistribution_Prohibited",
}
_VRMA_REQUIRED_HUMAN_BONES = frozenset(
    {
        "hips",
        "spine",
        "head",
        "leftUpperLeg",
        "leftLowerLeg",
        "leftFoot",
        "rightUpperLeg",
        "rightLowerLeg",
        "rightFoot",
        "leftUpperArm",
        "leftLowerArm",
        "leftHand",
        "rightUpperArm",
        "rightLowerArm",
        "rightHand",
    }
)
_VRMA_RENDERING_PAYLOAD_KEYS = frozenset(
    {"cameras", "images", "materials", "meshes", "samplers", "skins", "textures"}
)
_VRMA_MAX_KEYFRAMES = 100_000
_BUILT_IN_VRMA_URLS = frozenset(
    f"/assets/characters/motions/companion-{state}.vrma"
    for state in ("idle", "listening", "thinking", "speaking")
)
_MANAGED_MOTION_STATES = frozenset({"idle", "listening", "thinking", "speaking"})
_CREDENTIAL_VALUE_PATTERNS = (
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|credential)\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(?:authorization|bearer)\b\s*[:=]?\s+[a-z0-9._\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{12,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"),
)
_WINDOWS_RESERVED_PATH_NAMES = frozenset(
    {"aux", "con", "nul", "prn"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)
_WINDOWS_INVALID_PATH_CHARACTERS = frozenset('<>:"|?*')
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_UNICODE_SURROGATES = re.compile(r"[\ud800-\udfff]")
def _parse_vroid_hub_permissions(meta: dict[str, Any]) -> dict[str, str]:
    for raw_url in (meta.get("otherPermissionUrl"), meta.get("otherLicenseUrl")):
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        parsed = urlsplit(raw_url)
        if parsed.scheme != "https" or parsed.hostname != "hub.vroid.com":
            continue
        query = {
            key: values[-1].strip().lower()
            for key, values in parse_qs(parsed.query, keep_blank_values=False).items()
            if values
        }
        return {
            "redistribution_allowed": (
                "yes" if query.get("redistribution") == "allow" else "no"
            ),
            "modification_allowed": (
                "yes" if query.get("modification") == "allow" else "no"
            ),
            "attribution_required": (
                "no" if query.get("credit") == "unnecessary" else "yes"
            ),
        }
    return {}


__all__ = [
    name
    for name in globals()
    if (name.startswith("_") and not name.startswith("__"))
    or name == "logger"
]
