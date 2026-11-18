from __future__ import annotations

import re
import warnings
from dataclasses import dataclass, field

_NAME = r"[A-Za-z_][A-Za-z0-9_-]*"
_VALUE = r"[A-Za-z0-9_.:/+-]+"
_ATTRIBUTE = re.compile(rf"""({_NAME})\s*=\s*(?:"({_VALUE})"|'({_VALUE})'|({_VALUE}))""")
_ATTRIBUTES = rf"""(?:\s+(?:{_NAME})\s*=\s*(?:"{_VALUE}"|'{_VALUE}'|{_VALUE}))*"""
_TAG = re.compile(rf"<(?P<close>/)?(?P<name>{_NAME})(?P<attrs>{_ATTRIBUTES})\s*(?P<empty>/)?>")
_FENCE = re.compile(r"\A\s*\x60\x60\x60[A-Za-z0-9_-]*[ \t]*\r?\n(.*)\r?\n[ \t]*\x60\x60\x60\s*\Z", re.DOTALL)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    text: str = ""
    children: list[Node] = field(default_factory=list)

    def one(self, tag: str) -> Node:
        values = self.many(tag)
        if len(values) != 1:
            raise ValueError(f"Expected one <{tag}> in <{self.tag}>, got {len(values)}.")
        return values[0]

    def many(self, tag: str) -> list[Node]:
        return [child for child in self.children if child.tag == tag]

    def attr(self, name: str, *, required: bool = True) -> str | None:
        value = self.attrs.get(name)
        if value is None and required:
            raise ValueError(f"Attribute {name} is required on <{self.tag}>.")
        return value


def strip_fence(text: str) -> str:
    fenced = _FENCE.fullmatch(text)
    return fenced[1] if fenced else text


def parse_blocks(text: str) -> list[Node]:
    source = strip_fence(text)
    roots: list[Node] = []
    stack: list[Node] = []
    cursor = 0
    for marker in _TAG.finditer(source):
        tag = marker["name"]
        if marker["close"]:
            matching = next((i for i in range(len(stack) - 1, -1, -1) if stack[i].tag == tag), None)
            if matching is None or marker["attrs"] or marker["empty"]:
                continue
            stack[-1].text += source[cursor:marker.start()]
            if matching != len(stack) - 1:
                warnings.warn(f"Closed unfinished tags before </{tag}>.", stacklevel=2)
            del stack[matching:]
        else:
            # A compact comparison such as x<y>0 is text when it has no attributes.
            if (
                not marker["attrs"] and not marker["empty"]
                and marker.start() > 0 and marker.end() < len(source)
                and source[marker.start() - 1].isalnum() and source[marker.end()].isalnum()
                and f"</{tag}>" not in source[marker.end():]
            ):
                continue
            attrs: dict[str, str] = {}
            for attr in _ATTRIBUTE.finditer(marker["attrs"]):
                if attr[1] in attrs:
                    raise ValueError(f"Attribute {attr[1]} occurs more than once on <{tag}>.")
                attrs[attr[1]] = attr[2] or attr[3] or attr[4]
            node = Node(tag=tag, attrs=attrs)
            if stack:
                stack[-1].text += source[cursor:marker.start()]
                stack[-1].children.append(node)
            else:
                roots.append(node)
            if not marker["empty"]:
                stack.append(node)
        cursor = marker.end()

    if stack:
        stack[-1].text += source[cursor:]
        warnings.warn("Closed unfinished tags at end of response.", stacklevel=2)
    return roots
