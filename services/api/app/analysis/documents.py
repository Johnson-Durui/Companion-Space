from __future__ import annotations

import re
import warnings
import zipfile
from dataclasses import dataclass
from io import BytesIO
from math import ceil
from pathlib import Path
from typing import Literal

import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.services.material_storage import SUPPORTED_MATERIAL_SUFFIXES


PageSource = Literal["text", "vision", "ocr", "pasted"]
PAGE_MARKER = re.compile(r"(?m)^<!--\s*page:\s*(\d+)\s*-->[^\S\r\n]*(?:\r?\n)?")
MARKDOWN_HEADING = re.compile(r"(?m)^#{1,6}\s+")
MAX_ARCHIVE_MEMBERS = 10_000


@dataclass(frozen=True, slots=True)
class ParsedPage:
    page_no: int
    markdown: str
    source: PageSource
    quality: float
    image_path: str | None = None

    @property
    def needs_vision(self) -> bool:
        return self.quality == 0


@dataclass(frozen=True, slots=True)
class DocumentBookmark:
    title: str
    page_no: int
    level: int


@dataclass(frozen=True, slots=True)
class ParsedDocument:
    pages: tuple[ParsedPage, ...]
    bookmarks: tuple[DocumentBookmark, ...] = ()

    @property
    def needs_vision_pages(self) -> tuple[int, ...]:
        return tuple(page.page_no for page in self.pages if page.needs_vision)


def decode_text_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        _validate_text_content(text)
        return text
    raise ValueError("Text material encoding is not supported")


def validate_upload(
    filename: str,
    data: bytes,
    file_limit: int,
    max_pdf_pages: int,
) -> tuple[str, int]:
    _validate_filename(filename)
    if not data:
        raise ValueError("Material file is empty")
    if len(data) > file_limit:
        raise ValueError("Document exceeds configured size limit")

    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_MATERIAL_SUFFIXES:
        raise ValueError("Document type is not supported")
    if suffix == ".pdf":
        return _validate_pdf(data, max_pdf_pages=max_pdf_pages)
    elif suffix in {".pptx", ".docx"}:
        _validate_office_archive(data, suffix=suffix, max_size=file_limit)
        return _office_upload_sample(data, suffix=suffix)
    elif suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        _validate_image(data, expected_suffix=suffix)
        return "", 1
    text = decode_text_bytes(data)
    pages = _split_virtual_pages(text)
    return text[:500], max(1, len(pages))


class DocumentParser:
    def __init__(
        self,
        *,
        max_pdf_pages: int = 500,
        max_extracted_text_chars: int = 2_000_000,
    ) -> None:
        self.max_pdf_pages = max_pdf_pages
        self.max_extracted_text_chars = max_extracted_text_chars

    def parse(
        self,
        path: Path,
        *,
        page_image_dir: Path,
        filename: str | None = None,
    ) -> ParsedDocument:
        suffix = Path(filename or path.name).suffix.lower()
        page_image_dir.mkdir(parents=True, exist_ok=True)
        if suffix == ".pdf":
            return self._parse_pdf(path, page_image_dir)
        if suffix == ".pptx":
            return self._parse_pptx(path, page_image_dir)
        if suffix == ".docx":
            return self._parse_docx(path)
        if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
            image_path = page_image_dir / "page-0001.jpg"
            _normalize_image(path, image_path)
            return ParsedDocument(
                pages=(
                    ParsedPage(
                        page_no=1,
                        markdown="",
                        source="text",
                        quality=0,
                        image_path=str(image_path.resolve()),
                    ),
                )
            )
        if suffix in {".md", ".txt"}:
            text = decode_text_bytes(path.read_bytes())
            self._ensure_text_limit(text)
            return ParsedDocument(pages=tuple(_split_virtual_pages(text)))
        raise ValueError(f"Unsupported document type: {suffix}")

    def _parse_pdf(self, path: Path, page_image_dir: Path) -> ParsedDocument:
        try:
            reader = PdfReader(str(path), strict=False)
            if reader.is_encrypted:
                raise ValueError("Encrypted PDFs are not supported")
            page_count = len(reader.pages)
        except (OSError, PdfReadError) as exc:
            raise ValueError("PDF file is damaged or unsupported") from exc
        if page_count > self.max_pdf_pages:
            raise ValueError(f"PDF exceeds {self.max_pdf_pages} page limit")

        markdown_pages = [
            _normalize_extracted_text(page.extract_text() or "") for page in reader.pages
        ]
        self._ensure_text_limit("".join(markdown_pages))

        parsed_pages: list[ParsedPage] = []
        with pdfium.PdfDocument(path) as document:
            if len(document) != page_count:
                raise ValueError("PDF render page count does not match text layer")
            for index, markdown in enumerate(markdown_pages):
                image_path = page_image_dir / f"page-{index + 1:04d}.jpg"
                _render_pdf_page(document[index], image_path)
                quality = _text_quality(markdown)
                parsed_pages.append(
                    ParsedPage(
                        page_no=index + 1,
                        markdown=markdown,
                        source="text",
                        quality=quality,
                        image_path=str(image_path.resolve()),
                    )
                )
        return ParsedDocument(
            pages=tuple(parsed_pages),
            bookmarks=tuple(_read_pdf_bookmarks(reader)),
        )

    def _parse_pptx(self, path: Path, page_image_dir: Path) -> ParsedDocument:
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        presentation = Presentation(path)
        pages: list[ParsedPage] = []
        total_chars = 0
        for page_no, slide in enumerate(presentation.slides, start=1):
            blocks: list[str] = []
            image_candidates: list[tuple[int, Path]] = []
            title_shape = slide.shapes.title
            for shape_index, shape in enumerate(slide.shapes, start=1):
                if shape.has_text_frame:
                    text = "\n".join(
                        paragraph.text.strip()
                        for paragraph in shape.text_frame.paragraphs
                        if paragraph.text.strip()
                    )
                    if text:
                        is_title = title_shape is not None and shape.shape_id == title_shape.shape_id
                        blocks.append(f"# {text}" if is_title else text)
                if shape.has_table:
                    blocks.append(_table_to_markdown(shape.table.rows))
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    image_path = page_image_dir / (
                        f"page-{page_no:04d}-image-{shape_index:02d}.jpg"
                    )
                    _normalize_image_bytes(shape.image.blob, image_path)
                    image_candidates.append((int(shape.width) * int(shape.height), image_path))
            if slide.has_notes_slide:
                notes_frame = slide.notes_slide.notes_text_frame
                if notes_frame is not None:
                    notes = notes_frame.text.strip()
                    if notes:
                        blocks.append(f"## Notes\n\n{notes}")
            markdown = "\n\n".join(blocks)
            total_chars += len(markdown)
            image_path = max(image_candidates, default=(0, None))[1]
            pages.append(
                ParsedPage(
                    page_no=page_no,
                    markdown=markdown,
                    source="text",
                    quality=_text_quality(markdown),
                    image_path=str(image_path.resolve()) if image_path else None,
                )
            )
        self._ensure_text_limit_by_count(total_chars)
        return ParsedDocument(pages=tuple(pages))

    def _parse_docx(self, path: Path) -> ParsedDocument:
        from docx import Document
        from docx.table import Table

        document = Document(path)
        blocks: list[str] = []
        for item in document.iter_inner_content():
            if isinstance(item, Table):
                blocks.append(_table_to_markdown(item.rows))
                continue
            text = item.text
            if not text:
                continue
            style_name = item.style.name if item.style is not None else ""
            match = re.fullmatch(r"Heading\s+([1-6])", style_name)
            blocks.append(f"{'#' * int(match.group(1))} {text}" if match else text)
        markdown = "\n\n".join(blocks)
        self._ensure_text_limit(markdown)
        return ParsedDocument(pages=tuple(_split_virtual_pages(markdown)))

    def _ensure_text_limit(self, text: str) -> None:
        self._ensure_text_limit_by_count(len(text))

    def _ensure_text_limit_by_count(self, count: int) -> None:
        if count > self.max_extracted_text_chars:
            raise ValueError("Material extracted text exceeds safety limit")


def _validate_filename(filename: str) -> None:
    if (
        not filename
        or len(filename) > 255
        or Path(filename).name != filename
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
        or any(ord(character) < 32 or ord(character) == 127 for character in filename)
    ):
        raise ValueError("Material filename must be a safe base name")


def _validate_pdf(data: bytes, *, max_pdf_pages: int) -> tuple[str, int]:
    if not data.startswith(b"%PDF-"):
        raise ValueError("PDF signature does not match the file extension")
    try:
        reader = PdfReader(BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDFs are not supported")
        page_count = len(reader.pages)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("PDF file is damaged or unsupported") from exc
    if page_count > max_pdf_pages:
        raise ValueError(f"PDF exceeds {max_pdf_pages} page limit")
    first_page = _normalize_extracted_text(reader.pages[0].extract_text() or "")
    return first_page[:500], page_count


def _validate_office_archive(data: bytes, *, suffix: str, max_size: int) -> None:
    expected_member = "ppt/presentation.xml" if suffix == ".pptx" else "word/document.xml"
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            members = archive.infolist()
            names = {member.filename for member in members}
            if expected_member not in names or "[Content_Types].xml" not in names:
                raise ValueError("Office document content does not match its extension")
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ValueError("Office document contains too many files")
            if any(_unsafe_archive_name(member.filename) for member in members):
                raise ValueError("Office document contains an unsafe path")
            if sum(member.file_size for member in members) > max_size * 8:
                raise ValueError("Office document expands beyond the safety limit")
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("Office document is damaged or unsupported") from exc


def _unsafe_archive_name(name: str) -> bool:
    path = Path(name.replace("\\", "/"))
    return path.is_absolute() or ".." in path.parts or "\x00" in name


def _validate_image(data: bytes, *, expected_suffix: str) -> None:
    expected_formats = {
        ".jpeg": "JPEG",
        ".jpg": "JPEG",
        ".png": "PNG",
        ".webp": "WEBP",
    }
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format != expected_formats[expected_suffix]:
                    raise ValueError("Image content does not match its extension")
                image.verify()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("Image dimensions exceed the safety limit") from exc
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Image is damaged or unsupported") from exc


def _office_upload_sample(data: bytes, *, suffix: str) -> tuple[str, int]:
    if suffix == ".pptx":
        from pptx import Presentation

        presentation = Presentation(BytesIO(data))
        first_slide = presentation.slides[0] if presentation.slides else None
        texts = (
            [shape.text for shape in first_slide.shapes if shape.has_text_frame and shape.text]
            if first_slide is not None
            else []
        )
        return "\n".join(texts)[:500], len(presentation.slides)

    from docx import Document
    from docx.table import Table

    document = Document(BytesIO(data))
    sample_blocks: list[str] = []
    sample_length = 0
    text_length = 0
    for item in document.iter_inner_content():
        text = (
            "\n".join(cell.text for row in item.rows for cell in row.cells)
            if isinstance(item, Table)
            else item.text
        )
        if text:
            text_length += len(text)
            if sample_length < 500:
                sample_blocks.append(text)
                sample_length += len(text)
    return "\n".join(sample_blocks)[:500], max(1, ceil(max(text_length, 1) / 6_000))


def _validate_text_content(text: str) -> None:
    if not text.strip():
        raise ValueError("Text material is empty")
    if "\x00" in text:
        raise ValueError("Text material contains binary data")
    control_count = sum(
        ord(character) < 32 and character not in {"\n", "\r", "\t"}
        for character in text
    )
    if control_count > max(2, len(text) // 100):
        raise ValueError("Text material contains binary data")


def _normalize_extracted_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _text_quality(text: str, *, minimum_chars: int = 50) -> float:
    if not text.strip():
        return 0
    effective = sum(
        character.isalnum() or "\u4e00" <= character <= "\u9fff" for character in text
    )
    if effective < minimum_chars:
        return 0
    non_space = [character for character in text if not character.isspace()]
    corrupt = sum(character == "\ufffd" or ord(character) < 32 for character in non_space)
    corrupt_ratio = corrupt / max(len(non_space), 1)
    if corrupt_ratio > 0.3:
        return 0
    return round(max(0.01, 1 - corrupt_ratio), 4)


def _render_pdf_page(page, path: Path) -> None:
    longest_side = max(page.get_width(), page.get_height())
    scale = 1600 / longest_side if longest_side else 1
    bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
    try:
        image = bitmap.to_pil().convert("RGB")
        image.save(path, format="JPEG", quality=85, optimize=True)
    finally:
        bitmap.close()


def _normalize_image(source: Path, destination: Path) -> None:
    with Image.open(source) as raw_image:
        _save_normalized_image(raw_image, destination)


def _normalize_image_bytes(data: bytes, destination: Path) -> None:
    with Image.open(BytesIO(data)) as raw_image:
        _save_normalized_image(raw_image, destination)


def _save_normalized_image(raw_image: Image.Image, destination: Path) -> None:
    image = ImageOps.exif_transpose(raw_image)
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    if image.mode not in {"RGB", "L"}:
        background = Image.new("RGB", image.size, "white")
        if "A" in image.getbands():
            background.paste(image, mask=image.getchannel("A"))
        else:
            background.paste(image)
        image = background
    elif image.mode == "L":
        image = image.convert("RGB")
    image.save(destination, format="JPEG", quality=85, optimize=True)


def _read_pdf_bookmarks(reader: PdfReader) -> list[DocumentBookmark]:
    bookmarks: list[DocumentBookmark] = []

    def visit(items, level: int) -> None:
        for item in items:
            if isinstance(item, list):
                visit(item, level + 1)
                continue
            try:
                page_no = reader.get_destination_page_number(item) + 1
            except Exception:
                continue
            title = str(getattr(item, "title", "")).strip()
            if title:
                bookmarks.append(DocumentBookmark(title=title, page_no=page_no, level=level))

    visit(reader.outline, 1)
    return bookmarks


def _split_virtual_pages(text: str, *, target_chars: int = 6_000) -> list[ParsedPage]:
    markers = list(PAGE_MARKER.finditer(text))
    if markers:
        pages: list[ParsedPage] = []
        for index, marker in enumerate(markers):
            start = 0 if index == 0 else marker.start()
            end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
            page_no = int(marker.group(1))
            markdown = text[start:end]
            pages.append(
                ParsedPage(
                    page_no,
                    markdown,
                    "text",
                    _text_quality(markdown, minimum_chars=0),
                )
            )
        return pages

    starts = [0]
    for match in MARKDOWN_HEADING.finditer(text):
        if match.start() and match.start() - starts[-1] >= target_chars // 2:
            starts.append(match.start())
    starts = _add_fixed_page_starts(text, starts, target_chars)
    return [
        ParsedPage(
            page_no=index + 1,
            markdown=text[start:end],
            source="text",
            quality=_text_quality(text[start:end], minimum_chars=0),
        )
        for index, (start, end) in enumerate(zip(starts, [*starts[1:], len(text)]))
        if end > start
    ]


def _add_fixed_page_starts(text: str, starts: list[int], target_chars: int) -> list[int]:
    result: list[int] = []
    boundaries = [*starts, len(text)]
    for start, end in zip(boundaries, boundaries[1:]):
        cursor = start
        result.append(cursor)
        while end - cursor > target_chars:
            split = text.rfind("\n\n", cursor + target_chars // 2, cursor + target_chars)
            if split <= cursor:
                split = cursor + target_chars
            cursor = split
            result.append(cursor)
    return sorted(set(result))


def _table_to_markdown(rows) -> str:
    values = [[cell.text.strip().replace("\n", "<br>") for cell in row.cells] for row in rows]
    if not values:
        return ""
    width = max(len(row) for row in values)
    padded = [row + [""] * (width - len(row)) for row in values]
    lines = ["| " + " | ".join(row) + " |" for row in padded]
    lines.insert(1, "| " + " | ".join("---" for _ in range(width)) + " |")
    return "\n".join(lines)
