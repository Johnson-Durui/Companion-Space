from __future__ import annotations

import asyncio
from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.api.deps import get_container
from app.rag.parser import DocumentParser


def _create_pdf_bytes(page_count: int) -> bytes:
    buffer = BytesIO()
    writer = PdfWriter()
    for _ in range(page_count):
        writer.add_blank_page(width=300, height=300)
    writer.write(buffer)
    return buffer.getvalue()


def _create_text_pdf_bytes() -> bytes:
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
        b"(Bayes theorem updates beliefs when new evidence arrives.) Tj ET"
    )
    page[NameObject("/Contents")] = writer._add_object(content)
    writer.write(buffer)
    return buffer.getvalue()


def _create_space(client, owner_token: str) -> str:
    response = client.post(
        "/api/v1/spaces",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"name": "M3 Space", "topic": "docs", "goal": "index docs"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_note_ingestion_is_queued_then_completed_by_background_worker(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    _ = isolated_settings
    space_id = _create_space(client, owner_token)

    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/note",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={
            "title": "Queue me",
            "content": "A note that should be indexed by the background worker, not inline.",
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["job"]["status"] == "queued"
    assert payload["material"]["chunk_count"] == 0

    completed = get_container().spaces.wait_for_ingestion(payload["job"]["id"], timeout_seconds=2.0)

    assert completed.status == "completed"
    assert get_container().repository.get_material(payload["material"]["id"]).chunk_count >= 1


def test_failed_ingestion_can_retry_without_creating_a_new_material(
    client,
    owner_token: str,
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_settings
    container = get_container()
    calls = {"count": 0}

    def flaky_parse(_path):
        calls["count"] += 1
        if calls["count"] == 1:
            raise ValueError("boom on first pass")
        return "Recovered note content after retry."

    monkeypatch.setattr(container.spaces.parser, "parse", flaky_parse)
    space_id = _create_space(client, owner_token)

    created = client.post(
        f"/api/v1/spaces/{space_id}/materials/note",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"title": "Retry note", "content": "Trigger a retriable parsing failure."},
    )

    assert created.status_code == 201
    created_payload = created.json()
    failed = container.spaces.wait_for_ingestion(created_payload["job"]["id"], timeout_seconds=2.0)
    assert failed.status == "failed"
    assert failed.error_message == "Unable to index this material"
    assert "boom" not in failed.error_message

    retried = client.post(
        f"/api/v1/spaces/{space_id}/materials/{created_payload['material']['id']}/retry",
        headers={"Authorization": f"Bearer {owner_token}"},
    )

    assert retried.status_code == 201
    retried_payload = retried.json()
    assert retried_payload["material"]["id"] == created_payload["material"]["id"]
    assert retried_payload["job"]["id"] != created_payload["job"]["id"]
    assert retried_payload["job"]["status"] == "queued"

    completed = container.spaces.wait_for_ingestion(retried_payload["job"]["id"], timeout_seconds=2.0)
    assert completed.status == "completed"


def test_space_detail_exposes_ingestion_jobs(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    _ = isolated_settings
    container = get_container()
    space_id = _create_space(client, owner_token)

    created = client.post(
        f"/api/v1/spaces/{space_id}/materials/note",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"title": "Job detail", "content": "Expose ingestion jobs in space detail."},
    )
    assert created.status_code == 201
    job_id = created.json()["job"]["id"]
    container.spaces.wait_for_ingestion(job_id, timeout_seconds=2.0)

    detail = client.get(
        f"/api/v1/spaces/{space_id}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )

    assert detail.status_code == 200
    payload = detail.json()
    assert payload["jobs"]
    assert payload["jobs"][0]["id"] == job_id
    assert payload["jobs"][0]["material_id"] == created.json()["material"]["id"]


def test_upload_rejects_pdf_signature_spoof(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    _ = isolated_settings
    space_id = _create_space(client, owner_token)

    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/upload",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "x-filename": "fake.pdf",
        },
        content=b"this is not a real pdf",
    )

    assert response.status_code == 400
    assert "signature" in response.json()["detail"].lower()


def test_upload_rejects_pdf_over_page_limit(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    _ = isolated_settings
    space_id = _create_space(client, owner_token)

    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/upload",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "x-filename": "too-many-pages.pdf",
        },
        content=_create_pdf_bytes(501),
    )

    assert response.status_code == 400
    assert "500" in response.json()["detail"]


def test_valid_pdf_runs_async_index_retrieval_and_server_citation_chain(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    _ = isolated_settings
    container = get_container()
    space_id = _create_space(client, owner_token)

    uploaded = client.post(
        f"/api/v1/spaces/{space_id}/materials/upload",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "x-filename": "bayes.pdf",
        },
        content=_create_text_pdf_bytes(),
    )

    assert uploaded.status_code == 201
    payload = uploaded.json()
    assert payload["job"]["status"] == "queued"
    assert "storage_path" not in payload["material"]
    completed = container.spaces.wait_for_ingestion(
        payload["job"]["id"],
        timeout_seconds=2.0,
    )
    assert completed.status == "completed"

    retrieval = container.spaces.retrieve(
        space_id=space_id,
        query="Bayes theorem new evidence",
    )
    assert retrieval.hits
    assert retrieval.hits[0].chunk.material_id == payload["material"]["id"]

    session = container.companion.create_session(
        space_id=space_id,
        character_pack_id=None,
    )
    turn = asyncio.run(
        container.companion.submit_text_turn(
            session_id=session.id,
            text="What does Bayes theorem do with new evidence?",
        )
    )
    assert turn.citations
    assert {citation.material_id for citation in turn.citations} == {
        payload["material"]["id"]
    }

    detail = client.get(
        f"/api/v1/spaces/{space_id}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert detail.status_code == 200
    assert "storage_path" not in detail.json()["materials"][0]


@pytest.mark.parametrize(
    ("filename", "content", "message"),
    [
        ("../escape.md", b"safe-looking text", "base name"),
        ("payload.md", b"\x7fELF\x02\x01binary", "executable"),
        ("payload.txt", b"PK\x03\x04archive", "archive"),
        ("payload.md", b"\x00\x01binary", "binary"),
    ],
)
def test_upload_rejects_unsafe_names_and_disguised_binary_files(
    client,
    owner_token: str,
    isolated_settings,
    filename: str,
    content: bytes,
    message: str,
) -> None:
    _ = isolated_settings
    space_id = _create_space(client, owner_token)

    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/upload",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "x-filename": filename,
        },
        content=content,
    )

    assert response.status_code == 400
    assert message in response.json()["detail"].lower()
    assert get_container().repository.list_materials(space_id) == []


def test_upload_stream_enforces_configured_size_before_persisting(
    client,
    owner_token: str,
    isolated_settings,
) -> None:
    isolated_settings.max_document_size_bytes = 8
    space_id = _create_space(client, owner_token)

    response = client.post(
        f"/api/v1/spaces/{space_id}/materials/upload",
        headers={
            "Authorization": f"Bearer {owner_token}",
            "x-filename": "oversized.txt",
        },
        content=b"123456789",
    )

    assert response.status_code == 400
    assert "50 mib" in response.json()["detail"].lower()
    assert get_container().repository.list_materials(space_id) == []


def test_parser_rejects_extracted_text_over_safety_limit(tmp_path) -> None:
    document = tmp_path / "oversized.txt"
    document.write_text("bounded parser output", encoding="utf-8")

    parser = DocumentParser(max_extracted_text_chars=8)

    with pytest.raises(ValueError, match="safety limit"):
        parser.parse(document)


def test_pdf_parser_rejects_extracted_text_over_safety_limit(tmp_path) -> None:
    document = tmp_path / "oversized.pdf"
    document.write_bytes(_create_text_pdf_bytes())

    parser = DocumentParser(max_extracted_text_chars=16)

    with pytest.raises(ValueError, match="safety limit"):
        parser.parse(document)
