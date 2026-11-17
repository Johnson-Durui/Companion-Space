from __future__ import annotations


from app.api.deps import get_container


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
