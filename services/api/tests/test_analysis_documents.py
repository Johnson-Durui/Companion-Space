from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from PIL import Image
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.analysis.documents import DocumentParser, ParsedPage, decode_text_bytes, validate_upload
from app.analysis.indexing import (
    chunk_document,
    cosine_similarity,
    pack_embedding,
    unpack_embedding,
)
from app.analysis.structure import build_sections


def _text_pdf_bytes() -> bytes:
    buffer = BytesIO()
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): writer._add_object(font)}
            )
        }
    )
    content = DecodedStreamObject()
    content.set_data(
        b"BT /F1 12 Tf 72 720 Td "
        b"(A sufficiently long text layer stays available and renders its original page.) Tj ET"
    )
    page[NameObject("/Contents")] = writer._add_object(content)
    writer.write(buffer)
    return buffer.getvalue()


def _blank_pdf_bytes() -> bytes:
    buffer = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=500)
    writer.write(buffer)
    return buffer.getvalue()


def _png_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (40, 30), "navy").save(buffer, format="PNG")
    return buffer.getvalue()


def test_pdf_parser_keeps_text_and_marks_scan_for_vision(tmp_path: Path) -> None:
    parser = DocumentParser()
    text_pdf = tmp_path / "text.pdf"
    text_pdf.write_bytes(_text_pdf_bytes())
    parsed = parser.parse(text_pdf, page_image_dir=tmp_path / "text-pages")

    assert "sufficiently long" in parsed.pages[0].markdown
    assert parsed.pages[0].quality > 0
    image_path = Path(parsed.pages[0].image_path or "")
    with Image.open(image_path) as image:
        assert max(image.size) <= 1600

    scan_pdf = tmp_path / "scan.pdf"
    scan_pdf.write_bytes(_blank_pdf_bytes())
    scanned = parser.parse(scan_pdf, page_image_dir=tmp_path / "scan-pages")

    assert scanned.needs_vision_pages == (1,)
    assert Path(scanned.pages[0].image_path or "").is_file()


def test_pptx_and_docx_preserve_supported_structure(tmp_path: Path) -> None:
    image_path = tmp_path / "figure.png"
    image_path.write_bytes(_png_bytes())

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = "Slide title"
    slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text = (
        "Body text that is long enough to avoid a visual-only classification."
    )
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1)).table
    table.cell(0, 0).text = "A"
    table.cell(0, 1).text = "B"
    table.cell(1, 0).text = "1"
    table.cell(1, 1).text = "2"
    slide.shapes.add_picture(str(image_path), Inches(1), Inches(4))
    notes_frame = slide.notes_slide.notes_text_frame
    assert notes_frame is not None
    notes_frame.text = "Speaker note"
    pptx_path = tmp_path / "deck.pptx"
    presentation.save(pptx_path)

    parsed_pptx = DocumentParser().parse(
        pptx_path,
        page_image_dir=tmp_path / "deck-pages",
    )
    markdown = parsed_pptx.pages[0].markdown
    assert "# Slide title" in markdown
    assert "| A | B |" in markdown
    assert "Speaker note" in markdown
    assert Path(parsed_pptx.pages[0].image_path or "").is_file()

    document = Document()
    document.add_heading("Chapter", level=1)
    document.add_paragraph("Paragraph content")
    docx_table = document.add_table(rows=2, cols=2)
    docx_table.cell(0, 0).text = "Key"
    docx_table.cell(0, 1).text = "Value"
    docx_path = tmp_path / "chapter.docx"
    document.save(docx_path)

    parsed_docx = DocumentParser().parse(
        docx_path,
        page_image_dir=tmp_path / "docx-pages",
    )
    assert "# Chapter" in parsed_docx.pages[0].markdown
    assert "Paragraph content" in parsed_docx.pages[0].markdown
    assert "| Key | Value |" in parsed_docx.pages[0].markdown


@pytest.mark.parametrize("encoding", ["gbk", "gb18030"])
def test_text_decoding_accepts_common_chinese_encodings(encoding: str) -> None:
    assert decode_text_bytes("中文资料内容".encode(encoding)) == "中文资料内容"


def test_upload_validation_checks_signatures_and_paths() -> None:
    sample, page_count = validate_upload(
        "page.png",
        _png_bytes(),
        1_000_000,
        5,
    )
    assert sample == ""
    assert page_count == 1
    with pytest.raises(ValueError, match="does not match"):
        validate_upload(
            "page.jpg",
            _png_bytes(),
            1_000_000,
            5,
        )
    with pytest.raises(ValueError, match="safe base name"):
        validate_upload(
            "../page.png",
            _png_bytes(),
            1_000_000,
            5,
        )


def test_image_parser_creates_bounded_protected_jpeg(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    with Image.new("RGBA", (2400, 1800), (0, 0, 128, 128)) as image:
        image.save(source, format="PNG")

    pages_dir = tmp_path / "protected-pages"
    parsed = DocumentParser().parse(source, page_image_dir=pages_dir)

    page = parsed.pages[0]
    normalized = Path(page.image_path or "")
    assert normalized == (pages_dir / "page-0001.jpg").resolve()
    assert page.needs_vision
    with Image.open(normalized) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        assert max(image.size) <= 1600


def test_sample_markdown_page_markers_preserve_every_character(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    parser = DocumentParser()
    samples = (
        (root / "content/sample-course/probability-basics/textbook.md", 9),
        (root / "content/sample-course/history-1911/textbook.md", 3),
    )
    for path, expected_pages in samples:
        original = path.read_text(encoding="utf-8")
        parsed = parser.parse(path, page_image_dir=tmp_path / path.parent.name)
        assert len(parsed.pages) == expected_pages
        assert "".join(page.markdown for page in parsed.pages) == original


def test_sections_are_stable_and_chunks_do_not_drop_long_content() -> None:
    pages = (
        ParsedPage(1, "# Root\n\n## Leaf\n\n" + "甲" * 1900, "text", 1),
    )
    first = build_sections("material", pages)
    second = build_sections("material", pages)
    assert first == second
    assert first[1].parent_id == first[0].id

    chunks = chunk_document(pages, first)
    assert all(len(chunk.content) <= 800 for chunk in chunks)
    reconstructed = chunks[0].content + "".join(chunk.content[80:] for chunk in chunks[1:])
    assert reconstructed == pages[0].markdown

    vector = pack_embedding([3.0, 4.0])
    assert unpack_embedding(vector).tolist() == pytest.approx([3.0, 4.0])
    assert cosine_similarity(vector, vector) == pytest.approx(1.0)


def test_section_fallback_groups_eight_pages() -> None:
    pages = tuple(ParsedPage(index, "plain text", "text", 1) for index in range(1, 10))
    sections = build_sections("material", pages)

    assert [(section.page_start, section.page_end) for section in sections] == [(1, 8), (9, 9)]
