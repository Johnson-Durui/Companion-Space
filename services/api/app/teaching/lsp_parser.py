from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

_NAME = r"say|board_param|board|mark|point|cue|pause|ask"
_TAG_START = re.compile(rf"</?(?:{_NAME})(?=[\s/>])")
_TAG = re.compile(rf"""<(?P<end>/)?(?P<name>{_NAME})(?=[\s/>])(?P<attrs>(?:[^<>"'“‘]|"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’)*)>""")
_ATTR = re.compile(r"""([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s>]+))""")
_SENTENCES = re.compile(r"(?<=[。！？；…])")


@dataclass(frozen=True)
class LspEvent:
    type: str
    data: dict[str, Any]


def split_speech(content: str) -> Iterator[str]:
    for sentence in _SENTENCES.split(content.strip()):
        if not sentence.strip():
            continue
        parts = re.split(r"(?<=[，、,])", sentence) if len(sentence) > 28 else [sentence]
        yield from (part.strip() for part in parts if part.strip())


class LspParser:
    """Parse complete operations as chunks arrive and preserve literal block contents."""

    def __init__(self, existing_ids: Iterable[str] = ()) -> None:
        self._buffer = ""
        self._outside: list[str] = []
        self._active: tuple[str, dict[str, str]] | None = None
        self._saw_tag = False
        self._seen_ids = set(existing_ids)
        self._aliases: dict[str, str] = {}
        self._next_id = 1
        self.stray_ask = 0
        self.stray_text = 0

    def feed(self, chunk: str) -> list[LspEvent]:
        self._buffer += chunk
        events: list[LspEvent] = []
        while self._buffer:
            if self._active:
                name, attrs = self._active
                close = f"</{name}>"
                end = self._buffer.find(close)
                if end < 0:
                    break
                events.extend(self._emit(name, attrs, self._buffer[:end]))
                self._buffer = self._buffer[end + len(close):]
                self._active = None
                continue

            candidate = _TAG_START.search(self._buffer)
            if candidate is None:
                break
            tag = _TAG.match(self._buffer, candidate.start())
            if tag is None:
                break
            self._outside.append(self._buffer[:tag.start()])
            self._buffer = self._buffer[tag.end():]
            name = tag["name"]
            if tag["end"]:
                continue
            if name == "ask":
                self.stray_ask += 1
            else:
                self._saw_tag = True
            raw_attrs = tag["attrs"].strip()
            empty = raw_attrs.endswith("/")
            attrs = {
                attr[1]: next(value for value in attr.groups()[1:] if value is not None)
                for attr in _ATTR.finditer(raw_attrs.removesuffix("/") if empty else raw_attrs)
            }
            is_block = name in {"say", "board", "ask"} and attrs.get("op") != "clear"
            if is_block and not empty:
                self._active = (name, attrs)
            else:
                events.extend(self._emit(name, attrs, ""))
        return events

    def finish(self) -> list[LspEvent]:
        if self._active:
            name, attrs = self._active
            events = list(self._emit(name, attrs, self._buffer))
        else:
            self._outside.append(self._buffer)
            events = []
        outside = "".join(self._outside).strip()
        self.stray_text += len(outside) if self._saw_tag else 0
        self._buffer = ""
        self._outside.clear()
        self._active = None
        if not self._saw_tag:
            events.extend(self._emit("say", {}, outside))
        return events

    def _new_id(self) -> str:
        while f"b{self._next_id}" in self._seen_ids:
            self._next_id += 1
        return f"b{self._next_id}"

    def _emit(self, name: str, attrs: dict[str, str], content: str) -> Iterator[LspEvent]:
        if name == "ask":
            return
        if name == "say":
            for text in split_speech(content):
                yield LspEvent("say", {"text": text, "emotion": attrs.get("emotion", "neutral")})
            return

        data = dict(attrs)
        if name == "board":
            op = attrs.get("op", "add")
            data["op"] = op
            if op == "add":
                requested = attrs.get("id")
                block_id = requested if requested and requested not in self._seen_ids else self._new_id()
                if requested:
                    self._aliases[requested] = block_id
                self._seen_ids.add(block_id)
                data["id"] = block_id
                data.setdefault("type", "text")
            if op != "clear":
                data["content"] = content.strip()
        if "target" in attrs:
            block_id, separator, line = attrs["target"].partition(".")
            data["target"] = self._aliases.get(block_id, block_id) + separator + line
        yield LspEvent(name, data)
