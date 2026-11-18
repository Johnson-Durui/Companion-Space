from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis.documents import ParsedPage
from app.analysis.structure import MaterialSection


@dataclass(frozen=True, slots=True)
class IndexChunk:
    section_id: str
    page_no: int
    content: str


def chunk_document(
    pages: tuple[ParsedPage, ...],
    sections: tuple[MaterialSection, ...],
    *,
    target_min: int = 500,
    target_max: int = 800,
    overlap: int = 80,
) -> tuple[IndexChunk, ...]:
    if not 0 <= overlap < target_min <= target_max:
        raise ValueError("Chunk limits must satisfy 0 <= overlap < target_min <= target_max")
    if not pages or not sections:
        return ()

    parent_ids = {section.parent_id for section in sections if section.parent_id}
    leaves = [section for section in sections if section.id not in parent_ids]
    chunks: list[IndexChunk] = []
    for section in leaves:
        section_pages = [
            page
            for page in pages
            if section.page_start <= page.page_no <= section.page_end and page.markdown
        ]
        if not section_pages:
            continue
        text, offsets = _join_pages(section_pages)
        for start, end in _chunk_ranges(
            text,
            target_min=target_min,
            target_max=target_max,
            overlap=overlap,
        ):
            chunks.append(
                IndexChunk(
                    section_id=section.id,
                    page_no=_page_for_offset(offsets, start),
                    content=text[start:end],
                )
            )
    return tuple(chunks)


def pack_embedding(values: list[float]) -> bytes:
    array = np.asarray(values, dtype="<f4")
    if array.ndim != 1 or not np.isfinite(array).all():
        raise ValueError("Embedding must be a finite one-dimensional vector")
    return array.tobytes()


def unpack_embedding(data: bytes) -> np.ndarray:
    if len(data) % 4:
        raise ValueError("Embedding BLOB length must be divisible by four")
    return np.frombuffer(data, dtype="<f4")


def cosine_similarity(left: bytes, right: bytes) -> float:
    left_vector = unpack_embedding(left)
    right_vector = unpack_embedding(right)
    if left_vector.shape != right_vector.shape:
        raise ValueError("Embedding dimensions do not match")
    denominator = float(np.linalg.norm(left_vector) * np.linalg.norm(right_vector))
    if denominator == 0:
        return 0.0
    return float(np.dot(left_vector, right_vector) / denominator)


def _join_pages(pages: list[ParsedPage]) -> tuple[str, list[tuple[int, int]]]:
    parts: list[str] = []
    offsets: list[tuple[int, int]] = []
    length = 0
    for page in pages:
        separator = "\n\n" if parts else ""
        parts.append(separator)
        length += len(separator)
        offsets.append((length, page.page_no))
        parts.append(page.markdown)
        length += len(page.markdown)
    return "".join(parts), offsets


def _chunk_ranges(
    text: str,
    *,
    target_min: int,
    target_max: int,
    overlap: int,
) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < len(text):
        hard_end = min(start + target_max, len(text))
        end = hard_end
        if hard_end < len(text):
            search_start = start + target_min
            for delimiter in ("\n\n", "\n", "。", ". ", "；", "; "):
                boundary = text.rfind(delimiter, search_start, hard_end)
                if boundary >= search_start:
                    end = boundary + len(delimiter)
                    break
        ranges.append((start, end))
        if end == len(text):
            break
        start = end - overlap
    return ranges


def _page_for_offset(offsets: list[tuple[int, int]], offset: int) -> int:
    page_no = offsets[0][1]
    for page_offset, candidate in offsets:
        if page_offset > offset:
            break
        page_no = candidate
    return page_no
