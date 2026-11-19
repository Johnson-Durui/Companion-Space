from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from uuid import NAMESPACE_URL, uuid5

from app.analysis.documents import DocumentBookmark, ParsedPage
from app.llm.gateway import LLMGateway
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks


HEADING = re.compile(r"(?m)^(#{1,6})[ \t]+([^\r\n]+?)[ \t]*\r?$")
SETEXT_HEADING = re.compile(r"(?m)^([^#\s][^\r\n]{0,119})\r?\n(=+|-+)[ \t]*\r?$")


@dataclass(frozen=True, slots=True)
class MaterialSection:
    id: str
    material_id: str
    parent_id: str | None
    level: int
    title: str
    page_start: int
    page_end: int
    ord: int


def build_sections(
    material_id: str,
    pages: tuple[ParsedPage, ...],
    bookmarks: tuple[DocumentBookmark, ...] = (),
    *,
    inferred: list[tuple[int, str, int]] | None = None,
) -> tuple[MaterialSection, ...]:
    if not pages:
        return ()
    entries = (
        [(item.level, item.title, item.page_no) for item in bookmarks]
        if bookmarks
        else heading_entries(pages) or list(inferred or [])
    )
    if not entries:
        entries = [
            (
                1,
                f"Pages {pages[index].page_no}-{pages[min(index + 7, len(pages) - 1)].page_no}",
                pages[index].page_no,
            )
            for index in range(0, len(pages), 8)
        ]
    if entries[0][2] > pages[0].page_no:
        entries.insert(0, (1, f"Pages {pages[0].page_no}-{entries[0][2] - 1}", pages[0].page_no))
    return _materialize_sections(material_id, entries, pages[-1].page_no)


def heading_entries(pages: tuple[ParsedPage, ...]) -> list[tuple[int, str, int]]:
    entries: list[tuple[int, str, int]] = []
    for page in pages:
        page_entries = [
            (match.start(), len(match.group(1)), match.group(2).strip())
            for match in HEADING.finditer(page.markdown)
        ]
        page_entries.extend(
            (match.start(), 1 if match.group(2).startswith("=") else 2, match.group(1).strip())
            for match in SETEXT_HEADING.finditer(page.markdown)
        )
        entries.extend((level, title, page.page_no) for _, level, title in sorted(page_entries))
    return entries


def _parse_inferred_headings(raw: str, valid_pages: set[int]) -> list[tuple[int, str, int]]:
    nodes = [node for node in parse_blocks(raw) if node.tag == "section"]
    if raw.count("<section>") != len(nodes) or raw.count("</section>") != len(nodes):
        raise ValueError("Invalid inferred section format.")
    result = []
    last_page = min(valid_pages) - 1
    last_level = 0
    for node in nodes:
        fields = [node.many(tag) for tag in ("level", "title", "page")]
        if any(len(field) != 1 for field in fields):
            raise ValueError("Expected a level, title, and page for each section.")
        raw_level, name, raw_page = (field[0].text.strip() for field in fields)
        level, page = int(raw_level), int(raw_page)
        if not (1 <= level <= min(3, last_level + 1) and page in valid_pages and page > last_page and 0 < len(name) <= 120):
            raise ValueError("Inferred headings must follow source pages and a valid hierarchy.")
        last_level, last_page = level, page
        result.append((level, name, page))
    return result


async def infer_headings(gateway: LLMGateway, pages: tuple[ParsedPage, ...]) -> list[tuple[int, str, int]]:
    inferred = []
    for offset in range(0, len(pages), 80):
        excerpt = [{"page": page.page_no, "opening": page.markdown[:200]} for page in pages[offset:offset + 80]]
        valid = {entry["page"] for entry in excerpt}
        entries = await gateway.complete_tagged(
            "analysis", "analysis/toc_infer",
            {"page_content": data_block("page_openings", json.dumps(excerpt, ensure_ascii=False))},
            parse=lambda raw: _parse_inferred_headings(raw, valid), cache=True, max_tokens=4096,
        )
        inferred.extend(entries)
    return inferred


def _materialize_sections(
    material_id: str,
    entries: list[tuple[int, str, int]],
    final_page: int,
) -> tuple[MaterialSection, ...]:
    sections: list[MaterialSection] = []
    ancestor_ids: dict[int, str] = {}
    for order, (level, title, page_start) in enumerate(entries):
        section_id = str(
            uuid5(NAMESPACE_URL, f"{material_id}:{order}:{level}:{title}:{page_start}")
        )
        parent_id = next(
            (
                ancestor_ids[parent_level]
                for parent_level in range(level - 1, 0, -1)
                if parent_level in ancestor_ids
            ),
            None,
        )
        sections.append(
            MaterialSection(
                id=section_id,
                material_id=material_id,
                parent_id=parent_id,
                level=level,
                title=title,
                page_start=page_start,
                page_end=final_page,
                ord=order,
            )
        )
        ancestor_ids[level] = section_id
        ancestor_ids = {key: value for key, value in ancestor_ids.items() if key <= level}

    for index, section in enumerate(sections):
        following = next(
            (
                candidate
                for candidate in sections[index + 1 :]
                if candidate.level <= section.level
            ),
            None,
        )
        if following is not None:
            sections[index] = replace(
                section,
                page_end=max(section.page_start, following.page_start - 1),
            )
    return tuple(sections)
