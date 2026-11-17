from __future__ import annotations

import asyncio
import json
import threading

import pytest

from app.api.deps import get_container
from app.models.domain import ProviderCapability
from app.providers.errors import ProviderConfigurationError
import httpx
from app.providers.openai_compatible import OpenAICompatibleProvider


@pytest.fixture
def embedding_connection(isolated_settings, monkeypatch: pytest.MonkeyPatch):
    container = get_container()
    container.vault.bootstrap()
    definition = container.providers.save_connection(
        provider="openai-compatible", label="Embedding over test transport",
        base_url="http://127.0.0.1:7889/v1", api_key="test-key",
    )
    calls = []

    def handle(request):
        payload = json.loads(request.content)
        assert request.url.path.endswith("/embeddings")
        texts = payload["input"]
        calls.append((payload["model"], texts))
        return httpx.Response(200, json={"data": [
            {"index": index, "embedding": [1.0, 0.0]} for index, _ in enumerate(texts)
        ]})

    def build_adapter(connection, *, api_key):
        return OpenAICompatibleProvider(
            api_key=api_key or "", base_url=connection.base_url,
            provider_name=connection.provider, timeout=5.0, transport=httpx.MockTransport(handle),
        )

    monkeypatch.setattr("app.services.provider_registry.build_provider_adapter", build_adapter)
    return definition["id"], calls


def test_retrieval_uses_a_space_scoped_fts_index(isolated_settings) -> None:
    _ = isolated_settings
    container = get_container()
    math_space = container.spaces.create_space(name="Math", topic="algebra", goal="roots")
    history_space = container.spaces.create_space(name="History", topic="trade", goal="routes")

    math_material, math_job = container.spaces.ingest_note(
        space_id=math_space.id,
        title="Quadratics",
        content="Quadratic equations use the discriminant b^2 - 4ac to classify roots.",
    )
    history_material, history_job = container.spaces.ingest_note(
        space_id=history_space.id,
        title="Silk Road",
        content="The Silk Road moved goods, faiths, and scientific ideas across Eurasia.",
    )

    container.spaces.wait_for_ingestion(math_job.id, timeout_seconds=2.0)
    container.spaces.wait_for_ingestion(history_job.id, timeout_seconds=2.0)

    hits = container.repository.search_chunks_fts(
        space_id=math_space.id,
        query="discriminant roots",
        limit=5,
    )

    assert hits
    assert all(hit.space_id == math_space.id for hit in hits)
    assert all(hit.material_id == math_material.id for hit in hits)
    assert all(hit.material_id != history_material.id for hit in hits)


def test_configured_embedding_capability_adds_dense_reranking(
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
    embedding_connection,
) -> None:
    _ = isolated_settings
    container = get_container()
    connection_id, calls = embedding_connection
    space = container.spaces.create_space(
        name="Dense",
        topic="Bayes",
        goal="update beliefs",
    )
    container.providers.save_assignment(
        space_id=space.id,
        capability=ProviderCapability.embedding,
        provider_connection_id=connection_id,
        model_name="test-embedding",
    )
    material, job = container.spaces.ingest_note(
        space_id=space.id,
        title="Bayesian note",
        content="Bayes theorem updates prior beliefs with new evidence.",
    )
    container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)

    indexed_chunks = container.repository.list_chunks(space.id)
    assert indexed_chunks
    assert all(
        chunk.metadata["embedding_connection_id"] == connection_id
        and chunk.metadata["embedding_model"] == "test-embedding"
        and chunk.metadata["embedding_source"] == "provider"
        for chunk in indexed_chunks
    )

    indexing_calls = list(calls)
    assert indexing_calls == [
        (
            "test-embedding",
            [chunk.content for chunk in indexed_chunks if chunk.material_id == material.id],
        )
    ]

    result = asyncio.run(
        container.spaces.retrieve_async(
            space_id=space.id,
            query="Bayes new evidence",
            pools=("materials",),
        )
    )

    assert result.hits
    assert calls[-1] == ("test-embedding", ["bayes new evidence"])
    assert len(calls) == len(indexing_calls) + 1


def test_retrieve_async_rejects_stale_embedding_provenance(
    isolated_settings,
    embedding_connection,
) -> None:
    connection_id, _ = embedding_connection
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Stale embeddings",
        topic="Bayes",
        goal="detect stale vectors",
    )
    _, job = container.spaces.ingest_note(
        space_id=space.id,
        title="Bayesian note",
        content="Bayes theorem updates prior beliefs with new evidence.",
    )
    container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)
    container.providers.save_assignment(
        space_id=space.id,
        capability=ProviderCapability.embedding,
        provider_connection_id=connection_id,
        model_name="test-embedding",
    )

    with pytest.raises(
        ProviderConfigurationError,
        match="Stored material embeddings do not match the configured embedding model",
    ):
        asyncio.run(
            container.spaces.retrieve_async(
                space_id=space.id,
                query="Bayes new evidence",
                pools=("materials",),
            )
        )


def test_retrieve_async_rejects_provider_vectors_after_assignment_is_removed(
    isolated_settings,
    embedding_connection,
) -> None:
    connection_id, _ = embedding_connection
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Removed embeddings",
        topic="Bayes",
        goal="detect stale provider vectors",
    )
    container.providers.save_assignment(
        space_id=space.id,
        capability=ProviderCapability.embedding,
        provider_connection_id=connection_id,
        model_name="test-embedding",
    )
    _, job = container.spaces.ingest_note(
        space_id=space.id,
        title="Bayesian note",
        content="Bayes theorem updates prior beliefs with new evidence.",
    )
    container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)
    container.providers.delete_assignment(
        space_id=space.id,
        capability=ProviderCapability.embedding,
    )

    with pytest.raises(
        ProviderConfigurationError,
        match="Stored material embeddings do not match local retrieval",
    ):
        asyncio.run(
            container.spaces.retrieve_async(
                space_id=space.id,
                query="Bayes new evidence",
                pools=("materials",),
            )
        )


def test_embedding_assignment_api_marks_existing_material_for_reindex(
    client,
    owner_token: str,
    isolated_settings,
    embedding_connection,
) -> None:
    connection_id, _ = embedding_connection
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Reindex marker",
        topic="Bayes",
        goal="surface stale vectors",
    )
    material, job = container.spaces.ingest_note(
        space_id=space.id,
        title="Bayesian note",
        content="Bayes theorem updates prior beliefs with new evidence.",
    )
    container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)

    assigned = client.post(
        f"/api/v1/spaces/{space.id}/assignments",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={
            "capability": "embedding",
            "provider_connection_id": connection_id,
            "model_name": "test-embedding",
        },
    )

    assert assigned.status_code == 201
    detail = client.get(
        f"/api/v1/spaces/{space.id}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    latest_job = detail.json()["jobs"][0]
    assert latest_job["material_id"] == material.id
    assert latest_job["status"] == "failed"
    assert latest_job["error_message"].startswith("Embedding model changed")

    retried = client.post(
        f"/api/v1/spaces/{space.id}/materials/{material.id}/retry",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert retried.status_code == 201
    completed = container.spaces.wait_for_ingestion(
        retried.json()["job"]["id"],
        timeout_seconds=2.0,
    )
    assert completed.status == "completed"
    result = asyncio.run(
        container.spaces.retrieve_async(
            space_id=space.id,
            query="Bayes new evidence",
        )
    )
    assert result.hits


def test_embedding_change_during_active_ingestion_leaves_retryable_job(
    client,
    owner_token: str,
    isolated_settings,
    monkeypatch: pytest.MonkeyPatch,
    embedding_connection,
) -> None:
    connection_id, _ = embedding_connection
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Concurrent reindex",
        topic="Bayes",
        goal="keep active jobs recoverable",
    )
    chunks_built = threading.Event()
    release_worker = threading.Event()
    original_build_chunks = container.spaces._build_chunks

    def blocked_build_chunks(*, space_id, material, text):
        chunks = original_build_chunks(
            space_id=space_id,
            material=material,
            text=text,
        )
        chunks_built.set()
        assert release_worker.wait(timeout=2.0)
        return chunks

    monkeypatch.setattr(container.spaces, "_build_chunks", blocked_build_chunks)
    material, initial_job = container.spaces.ingest_note(
        space_id=space.id,
        title="Concurrent Bayesian note",
        content="Bayes theorem updates prior beliefs with new evidence.",
    )
    assert chunks_built.wait(timeout=2.0)

    try:
        assigned = client.post(
            f"/api/v1/spaces/{space.id}/assignments",
            headers={"Authorization": f"Bearer {owner_token}"},
            json={
                "capability": "embedding",
                "provider_connection_id": connection_id,
                "model_name": "test-embedding",
            },
        )
        assert assigned.status_code == 201
    finally:
        release_worker.set()

    failed = container.spaces.wait_for_ingestion(
        initial_job.id,
        timeout_seconds=2.0,
    )
    assert failed.status == "failed"
    latest_job = container.spaces.get_space_detail(space.id)["jobs"][0]
    assert latest_job.material_id == material.id
    assert latest_job.status == "failed"

    retried = client.post(
        f"/api/v1/spaces/{space.id}/materials/{material.id}/retry",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert retried.status_code == 201
    completed = container.spaces.wait_for_ingestion(
        retried.json()["job"]["id"],
        timeout_seconds=2.0,
    )
    assert completed.status == "completed"


def test_material_retrieval_rejects_mixed_memory_or_review_pools(
    isolated_settings,
) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(
        name="Separate pools",
        topic="security",
        goal="keep corpora apart",
    )

    with pytest.raises(
        ValueError,
        match="Material, memory, and review retrieval pools must remain separate",
    ):
        container.spaces.retrieve(
            space_id=space.id,
            query="anything",
            pools=("materials", "memory"),
        )
