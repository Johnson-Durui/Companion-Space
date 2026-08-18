from __future__ import annotations

import re


_SIMPLE_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}


class JSONTextFieldStream:
    """Incrementally decode one JSON string field without exposing its envelope."""

    def __init__(self, field_name: str) -> None:
        escaped_name = re.escape(field_name)
        self._opening = re.compile(rf'"{escaped_name}"\s*:\s*"')
        self._prefix = ""
        self._pending = ""
        self._started = False
        self._ended = False
        self._pending_high_surrogate: int | None = None

    def feed(self, chunk: str) -> str:
        if not chunk or self._ended:
            return ""
        if not self._started:
            self._prefix += chunk
            match = self._opening.search(self._prefix)
            if match is None:
                return ""
            self._started = True
            self._pending = self._prefix[match.end() :]
            self._prefix = ""
        else:
            self._pending += chunk

        decoded: list[str] = []
        cursor = 0
        while cursor < len(self._pending):
            character = self._pending[cursor]
            if character == '"':
                self._ended = True
                cursor += 1
                break
            if character != "\\":
                self._append_codepoint(decoded, ord(character))
                cursor += 1
                continue

            if cursor + 1 >= len(self._pending):
                break
            escape = self._pending[cursor + 1]
            if escape == "u":
                if cursor + 6 > len(self._pending):
                    break
                digits = self._pending[cursor + 2 : cursor + 6]
                if not re.fullmatch(r"[0-9A-Fa-f]{4}", digits):
                    self._append_codepoint(decoded, ord("\ufffd"))
                    cursor += 2
                    continue
                self._append_codepoint(decoded, int(digits, 16))
                cursor += 6
                continue

            mapped = _SIMPLE_ESCAPES.get(escape)
            if mapped is None:
                mapped = "\ufffd"
            for value in mapped:
                self._append_codepoint(decoded, ord(value))
            cursor += 2

        self._pending = self._pending[cursor:]
        if self._ended and self._pending_high_surrogate is not None:
            decoded.append("\ufffd")
            self._pending_high_surrogate = None
        return "".join(decoded)

    def _append_codepoint(self, target: list[str], codepoint: int) -> None:
        pending = self._pending_high_surrogate
        if 0xD800 <= codepoint <= 0xDBFF:
            if pending is not None:
                target.append("\ufffd")
            self._pending_high_surrogate = codepoint
            return
        if 0xDC00 <= codepoint <= 0xDFFF:
            if pending is None:
                target.append("\ufffd")
                return
            combined = (
                0x10000
                + ((pending - 0xD800) << 10)
                + (codepoint - 0xDC00)
            )
            target.append(chr(combined))
            self._pending_high_surrogate = None
            return
        if pending is not None:
            target.append("\ufffd")
            self._pending_high_surrogate = None
        target.append(chr(codepoint))
