import re
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError


def clean_text(raw_text: str) -> str:
    text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class DocumentParser:
    def __init__(
        self,
        *,
        max_pdf_pages: int = 500,
        max_extracted_text_chars: int = 2_000_000,
    ) -> None:
        self.max_pdf_pages = max_pdf_pages
        self.max_extracted_text_chars = max_extracted_text_chars

    def parse(self, path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in {".md", ".txt"}:
            text = clean_text(path.read_text(encoding="utf-8"))
            self._ensure_text_limit(text)
            return text
        if suffix == ".pdf":
            return self._parse_pdf(path)
        raise ValueError(f"Unsupported document type: {suffix}")

    def _parse_pdf(self, path: Path) -> str:
        try:
            reader = PdfReader(str(path), strict=False)
            if reader.is_encrypted:
                raise ValueError("Encrypted PDFs are not supported")
            page_count = len(reader.pages)
        except (OSError, PdfReadError) as exc:
            raise ValueError("PDF file is damaged or unsupported") from exc
        if page_count > self.max_pdf_pages:
            raise ValueError(f"PDF exceeds {self.max_pdf_pages} page limit")
        pages = []
        total_chars = 0
        for index, page in enumerate(reader.pages, start=1):
            text = clean_text(page.extract_text() or "")
            if text:
                total_chars += len(text)
                if total_chars > self.max_extracted_text_chars:
                    raise ValueError("Material extracted text exceeds safety limit")
                pages.append(f"[Page {index}]\n{text}")
        if not pages:
            raise ValueError("PDF did not yield extractable text. OCR support is not enabled yet.")
        return "\n\n".join(pages)

    def _ensure_text_limit(self, text: str) -> None:
        if len(text) > self.max_extracted_text_chars:
            raise ValueError("Material extracted text exceeds safety limit")
