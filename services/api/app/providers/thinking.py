import re

_MARKERS = ("<think>", "</think>")
_PATTERN = re.compile(r"</?think>", re.IGNORECASE)


class ThinkingFilter:
    """Separates in-band reasoning, including tags split across transport chunks."""

    def __init__(self) -> None:
        self._pending = ""
        self._depth = 0

    def feed(self, text: str) -> tuple[str, str]:
        buffer = self._pending + text
        visible: list[str] = []
        reasoning: list[str] = []
        start = 0
        for marker in _PATTERN.finditer(buffer):
            (reasoning if self._depth else visible).append(buffer[start:marker.start()])
            if marker.group().lower() == _MARKERS[0]:
                self._depth += 1
            elif self._depth:
                self._depth -= 1
            start = marker.end()

        tail = buffer[start:]
        hold = max(
            (length for length in range(1, min(len(tail), 7) + 1)
             if any(marker.startswith(tail[-length:].lower()) for marker in _MARKERS)),
            default=0,
        )
        self._pending = tail[-hold:] if hold else ""
        (reasoning if self._depth else visible).append(tail[:-hold] if hold else tail)
        return "".join(visible), "".join(reasoning)

    def finish(self) -> tuple[str, str]:
        if self._depth:
            return "", self._pending
        return self._pending, ""
