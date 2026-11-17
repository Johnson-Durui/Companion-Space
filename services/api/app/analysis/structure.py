from __future__ import annotations

import re
from dataclasses import dataclass, replace
from uuid import NAMESPACE_URL, uuid5

from app.analysis.documents import DocumentBookmark, ParsedPage


HEADING = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")


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
) -> tuple[MaterialSection, ...]:
    if not pages:
        return ()
    entries = (
        [(item.level, item.title, item.page_no) for item in bookmarks]
        if bookmarks
        else _heading_entries(pages)
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
    return _materialize_sections(material_id, entries, pages[-1].page_no)


def _heading_entries(pages: tuple[ParsedPage, ...]) -> list[tuple[int, str, int]]:
    entries: list[tuple[int, str, int]] = []
    for page in pages:
        entries.extend(
            (len(match.group(1)), match.group(2).strip(), page.page_no)
            for match in HEADING.finditer(page.markdown)
        )
    return entries


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
