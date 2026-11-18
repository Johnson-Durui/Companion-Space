"""Course-material parsing, structure detection, and indexing primitives."""

from app.analysis.documents import (
    DocumentParser,
    ParsedDocument,
    ParsedPage,
    decode_text_bytes,
    validate_upload,
)
from app.analysis.indexing import IndexChunk, chunk_document
from app.analysis.retrieval import RetrievedChunk, retrieve_for_kp
from app.analysis.structure import MaterialSection, build_sections

__all__ = [
    "DocumentParser",
    "IndexChunk",
    "MaterialSection",
    "ParsedDocument",
    "ParsedPage",
    "RetrievedChunk",
    "build_sections",
    "chunk_document",
    "decode_text_bytes",
    "retrieve_for_kp",
    "validate_upload",
]
