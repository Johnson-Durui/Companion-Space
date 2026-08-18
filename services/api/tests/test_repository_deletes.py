from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.api.deps import get_container
from app.models.domain import MemoryItem, ReviewItem


def test_delete_material_is_scoped_to_its_space(isolated_settings) -> None:
    container = get_container()
    first_space = container.spaces.create_space(name="First", topic="", goal="")
    second_space = container.spaces.create_space(name="Second", topic="", goal="")
    first_material, _ = container.spaces.ingest_note(
        space_id=first_space.id,
        title="First note",
        content="A first-space note that is long enough to become a chunk.",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(first_space.id)[0].id,
        timeout_seconds=2.0,
    )
    second_material, _ = container.spaces.ingest_note(
        space_id=second_space.id,
        title="Second note",
        content="A second-space note that must remain after the scoped delete.",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(second_space.id)[0].id,
        timeout_seconds=2.0,
    )

    deleted = container.repository.delete_material(
        space_id=second_space.id,
        material_id=first_material.id,
    )

    assert deleted is False
    assert container.repository.get_material(first_material.id) is not None
    assert container.repository.get_material(second_material.id) is not None


def test_delete_material_cascades_only_its_chunks_and_job(isolated_settings) -> None:
    container = get_container()
    space = container.spaces.create_space(name="Notes", topic="", goal="")
    material, _ = container.spaces.ingest_note(
        space_id=space.id,
        title="Disposable",
        content="Disposable material content that produces a retrieval chunk.",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(space.id)[0].id,
        timeout_seconds=2.0,
    )

    deleted = container.repository.delete_material(space_id=space.id, material_id=material.id)

    assert deleted is True
    assert container.repository.get_material(material.id) is None
    assert all(chunk.material_id != material.id for chunk in container.repository.list_chunks(space.id))


def test_delete_space_cascades_only_the_target_space(isolated_settings) -> None:
    container = get_container()
    deleted_space = container.spaces.create_space(name="Delete", topic="", goal="")
    kept_space = container.spaces.create_space(name="Keep", topic="", goal="")
    deleted_material, _ = container.spaces.ingest_note(
        space_id=deleted_space.id,
        title="Delete",
        content="This material belongs to the space that will be deleted.",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(deleted_space.id)[0].id,
        timeout_seconds=2.0,
    )
    kept_material, _ = container.spaces.ingest_note(
        space_id=kept_space.id,
        title="Keep",
        content="This material belongs to the space that must remain.",
    )
    container.spaces.wait_for_ingestion(
        container.spaces.list_ingestion_jobs(kept_space.id)[0].id,
        timeout_seconds=2.0,
    )

    deleted = container.repository.delete_space(deleted_space.id)

    assert deleted is True
    assert container.repository.get_space(deleted_space.id) is None
    assert container.repository.get_material(deleted_material.id) is None
    assert container.repository.get_space(kept_space.id) is not None
    assert container.repository.get_material(kept_material.id) is not None


def test_delete_character_removes_only_the_target_character(isolated_settings) -> None:
    container = get_container()
    deleted_character = container.characters.create_character(name="Delete")
    kept_character = container.characters.create_character(name="Keep")

    deleted = container.repository.delete_character(deleted_character.id)

    assert deleted is True
    assert container.repository.get_character(deleted_character.id) is None
    assert container.repository.get_character(kept_character.id) is not None


def test_delete_memory_item_is_scoped_to_its_space(isolated_settings) -> None:
    container = get_container()
    first_space = container.spaces.create_space(name="First", topic="", goal="")
    second_space = container.spaces.create_space(name="Second", topic="", goal="")
    now = datetime.now(timezone.utc)
    memory = MemoryItem(
        id=str(uuid4()),
        space_id=first_space.id,
        content="Keep this memory in its original space.",
        created_at=now,
        updated_at=now,
    )
    container.repository.upsert_memory_item(memory)

    deleted = container.repository.delete_memory_item(
        space_id=second_space.id,
        memory_id=memory.id,
    )

    assert deleted is False
    assert any(item.id == memory.id for item in container.repository.list_memory_items(first_space.id))


def test_delete_review_item_is_scoped_to_its_space(isolated_settings) -> None:
    container = get_container()
    first_space = container.spaces.create_space(name="First", topic="", goal="")
    second_space = container.spaces.create_space(name="Second", topic="", goal="")
    now = datetime.now(timezone.utc)
    review = ReviewItem(
        id=str(uuid4()),
        space_id=first_space.id,
        prompt="Keep this review item.",
        created_at=now,
        updated_at=now,
    )
    container.repository.upsert_review_item(review)

    deleted = container.repository.delete_review_item(
        space_id=second_space.id,
        review_id=review.id,
    )

    assert deleted is False
    assert any(item.id == review.id for item in container.repository.list_review_items(first_space.id))
