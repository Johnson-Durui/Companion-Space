from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from json import JSONDecodeError
from pathlib import Path
from typing import Any
from uuid import UUID

from app.core.config import Settings
from app.models.domain import Material
from app.services.spaces import StudySpaceService


SUPPORTED_SUFFIXES = {".md", ".pdf", ".txt"}


class LegacyKnowledgeImportError(ValueError):
    """Raised when legacy knowledge metadata or source files are unsafe."""


@dataclass(frozen=True, slots=True)
class LegacyKnowledgeCandidate:
    document_id: str
    filename: str
    title: str
    source_type: str
    chunk_count: int
    importable: bool
    issue: str | None = None


@dataclass(frozen=True, slots=True)
class LegacyKnowledgeImportResult:
    document_id: str
    space_id: str
    material_id: str
    filename: str
    title: str
    kind: str
    chunk_count: int
    status: str
    already_imported: bool


@dataclass(frozen=True, slots=True)
class _LegacyDocument:
    document_id: str
    filename: str
    title: str
    source_type: str
    chunk_count: int
    suffix: str


class LegacyKnowledgeImporter:
    """Read legacy global knowledge and copy selected documents into a space."""

    def __init__(self, settings: Settings, spaces: StudySpaceService) -> None:
        self._settings = settings
        self._spaces = spaces

    def list_candidates(self) -> list[LegacyKnowledgeCandidate]:
        candidates: list[LegacyKnowledgeCandidate] = []
        for document in self._load_documents():
            _, issue = self._resolve_source(document)
            candidates.append(
                LegacyKnowledgeCandidate(
                    document_id=document.document_id,
                    filename=document.filename,
                    title=document.title,
                    source_type=document.source_type,
                    chunk_count=document.chunk_count,
                    importable=issue is None,
                    issue=issue,
                )
            )
        return candidates

    def import_document(self, *, space_id: str, document_id: str) -> LegacyKnowledgeImportResult:
        self._spaces.require_space(space_id)
        selected_id = self._validate_document_id(document_id)
        document = next(
            (item for item in self._load_documents() if item.document_id == selected_id),
            None,
        )
        if document is None:
            raise LegacyKnowledgeImportError("Legacy document was not found")

        source_path, issue = self._resolve_source(document)
        if issue == "source_outside_legacy_root":
            raise LegacyKnowledgeImportError(
                "Legacy document source must remain inside the legacy knowledge base"
            )
        if issue == "source_missing" or source_path is None:
            raise LegacyKnowledgeImportError("Legacy document source is missing")

        try:
            data = source_path.read_bytes()
        except OSError as exc:
            raise LegacyKnowledgeImportError("Legacy document source could not be read") from exc

        source_digest = hashlib.sha256(data).hexdigest()
        existing = self._find_existing_import(
            space_id=space_id,
            document=document,
            source_digest=source_digest,
        )
        if existing is not None:
            return self._result_from_material(
                document=document,
                material=existing,
                status="already_imported",
                already_imported=True,
            )

        material, job = self._spaces.ingest_bytes(
            space_id=space_id,
            filename=document.filename,
            data=data,
            title=document.title,
        )
        return self._result_from_material(
            document=document,
            material=material,
            status=job.status,
            already_imported=False,
        )

    def _load_documents(self) -> list[_LegacyDocument]:
        legacy_root = self._settings.knowledge_base_root.resolve()
        registry_path = self._settings.knowledge_base_registry_path
        if not registry_path.exists():
            return []

        try:
            resolved_registry = registry_path.resolve(strict=True)
        except OSError as exc:
            raise LegacyKnowledgeImportError("Legacy knowledge registry could not be read") from exc
        if not resolved_registry.is_relative_to(legacy_root):
            raise LegacyKnowledgeImportError(
                "Legacy knowledge registry must remain inside the legacy knowledge base"
            )

        try:
            payload = json.loads(resolved_registry.read_text(encoding="utf-8"))
        except (JSONDecodeError, OSError, UnicodeError) as exc:
            raise LegacyKnowledgeImportError("Legacy knowledge registry is invalid") from exc
        if not isinstance(payload, list):
            raise LegacyKnowledgeImportError("Legacy knowledge registry must contain a list")

        documents: list[_LegacyDocument] = []
        seen_ids: set[str] = set()
        for item in payload:
            document = self._parse_document(item)
            if document.document_id in seen_ids:
                raise LegacyKnowledgeImportError("Legacy knowledge registry contains duplicate document IDs")
            seen_ids.add(document.document_id)
            documents.append(document)
        return documents

    def _parse_document(self, item: Any) -> _LegacyDocument:
        if not isinstance(item, dict):
            raise LegacyKnowledgeImportError("Legacy knowledge registry contains an invalid document")

        document_id = self._validate_document_id(item.get("id"))
        filename = self._required_string(item, "filename")
        if filename != Path(filename).name or "/" in filename or "\\" in filename:
            raise LegacyKnowledgeImportError("Legacy document filename must be a base name")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED_SUFFIXES:
            raise LegacyKnowledgeImportError("Legacy document type is not supported")

        title = self._required_string(item, "title")
        source_type = self._required_string(item, "source_type")
        chunk_count = item.get("chunk_count")
        if isinstance(chunk_count, bool) or not isinstance(chunk_count, int) or chunk_count < 0:
            raise LegacyKnowledgeImportError("Legacy document chunk count is invalid")
        return _LegacyDocument(
            document_id=document_id,
            filename=filename,
            title=title,
            source_type=source_type,
            chunk_count=chunk_count,
            suffix=suffix,
        )

    def _resolve_source(self, document: _LegacyDocument) -> tuple[Path | None, str | None]:
        documents_root = self._settings.knowledge_base_documents_dir.resolve()
        source_path = (
            self._settings.knowledge_base_documents_dir
            / f"{document.document_id}{document.suffix}"
        )
        try:
            resolved_source = source_path.resolve()
        except (OSError, RuntimeError):
            return None, "source_missing"
        if not resolved_source.is_relative_to(documents_root):
            return None, "source_outside_legacy_root"
        if not resolved_source.is_file():
            return None, "source_missing"
        return resolved_source, None

    def _find_existing_import(
        self,
        *,
        space_id: str,
        document: _LegacyDocument,
        source_digest: str,
    ) -> Material | None:
        for material in self._spaces.list_materials(space_id):
            if material.filename != document.filename or material.title != document.title:
                continue
            try:
                material_path = self._spaces.resolve_material_path(material)
            except (OSError, RuntimeError, ValueError):
                continue
            if not material_path.is_file():
                continue
            if self._digest_file(material_path) == source_digest:
                return material
        return None

    @staticmethod
    def _validate_document_id(value: Any) -> str:
        if not isinstance(value, str):
            raise LegacyKnowledgeImportError("Legacy document ID must be a valid UUID")
        try:
            parsed = UUID(value)
        except (ValueError, AttributeError) as exc:
            raise LegacyKnowledgeImportError("Legacy document ID must be a valid UUID") from exc
        canonical = str(parsed)
        if value != canonical:
            raise LegacyKnowledgeImportError("Legacy document ID must be a valid UUID")
        return canonical

    @staticmethod
    def _required_string(item: dict[str, Any], key: str) -> str:
        value = item.get(key)
        if not isinstance(value, str) or not value.strip():
            raise LegacyKnowledgeImportError(f"Legacy document {key} is invalid")
        return value

    @staticmethod
    def _digest_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @staticmethod
    def _result_from_material(
        *,
        document: _LegacyDocument,
        material: Material,
        status: str,
        already_imported: bool,
    ) -> LegacyKnowledgeImportResult:
        return LegacyKnowledgeImportResult(
            document_id=document.document_id,
            space_id=material.space_id,
            material_id=material.id,
            filename=material.filename,
            title=material.title,
            kind=material.kind.value,
            chunk_count=material.chunk_count,
            status=status,
            already_imported=already_imported,
        )
