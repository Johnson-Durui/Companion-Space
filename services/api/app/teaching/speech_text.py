from __future__ import annotations

import json
import re
from functools import cache

from app.core.config import APP_ROOT

_FORMULA = re.compile(r"\$\$(.*?)\$\$|\$([^$\n]+)\$|\\\((.*?)\\\)|\\\[(.*?)\\\]", re.DOTALL)
_COMMAND = re.compile(r"\\[A-Za-z]+")
_MATH_TOKEN = re.compile(r"\\[A-Za-z]+|[+=<>-]")
_CODE = re.compile(r"\x60{3}.*?\x60{3}|\x60[^\x60]*\x60", re.DOTALL)
_TAG = re.compile(r"</?[A-Za-z][^<>]*>")
_PRINTABLE_MATH = re.compile(r"[A-Za-z0-9\u3400-\u9fff.,()\s]+")


@cache
def speech_terms() -> dict:
    return json.loads((APP_ROOT / "content" / "speech" / "zh-CN.json").read_text(encoding="utf-8"))


def _read_formula(source: str) -> str:
    spoken = _MATH_TOKEN.sub(lambda match: speech_terms().get(match[0], match[0]), source)
    return spoken if _PRINTABLE_MATH.fullmatch(spoken) else ""


def clean_speech(text: str) -> str:
    text = _CODE.sub("", text)
    text = _FORMULA.sub(lambda match: _read_formula(next(part for part in match.groups() if part is not None)), text)
    text = _TAG.sub("", text)
    text = _COMMAND.sub(lambda match: speech_terms().get(match[0], ""), text)
    text = re.sub(r"[*#_\x60$]", "", text)
    return " ".join(text.split())
