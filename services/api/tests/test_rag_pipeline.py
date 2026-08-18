from app.api.deps import get_container


NOTE_A = """
# Algebra Warmup

Quadratic equations can be solved by factoring or by the quadratic formula.
The discriminant b^2 - 4ac determines the number of real roots.
""".strip()

NOTE_B = """
# History Notes

The Silk Road linked trade networks across Asia, Central Asia, and Europe.
It moved goods, religions, and scientific ideas.
""".strip()


def test_space_scoped_retrieval_keeps_materials_isolated(isolated_settings) -> None:
    _ = isolated_settings
    container = get_container()
    space_a = container.spaces.create_space(name="Math", topic="algebra", goal="understand quadratics")
    space_b = container.spaces.create_space(name="History", topic="trade", goal="review Silk Road")

    _, math_job = container.spaces.ingest_note(space_id=space_a.id, title="Quadratics", content=NOTE_A)
    _, history_job = container.spaces.ingest_note(space_id=space_b.id, title="Silk Road", content=NOTE_B)
    container.spaces.wait_for_ingestion(math_job.id, timeout_seconds=2.0)
    container.spaces.wait_for_ingestion(history_job.id, timeout_seconds=2.0)

    math_result = container.spaces.retrieve(space_id=space_a.id, query="discriminant real roots")
    history_result = container.spaces.retrieve(space_id=space_b.id, query="Silk Road scientific ideas")

    assert math_result.hits
    assert "quadratic" in math_result.hits[0].chunk.content.lower()
    assert history_result.hits
    assert "silk road" in history_result.hits[0].chunk.content.lower()
    assert all(hit.chunk.space_id == space_a.id for hit in math_result.hits)
    assert all(hit.chunk.space_id == space_b.id for hit in history_result.hits)


def test_ingest_note_creates_sqlite_material_and_chunks(isolated_settings) -> None:
    _ = isolated_settings
    container = get_container()
    space = container.spaces.create_space(name="Notes", topic="general", goal="collect snippets")
    material, job = container.spaces.ingest_note(space_id=space.id, title="Daily Note", content=NOTE_A)
    completed = container.spaces.wait_for_ingestion(job.id, timeout_seconds=2.0)
    stored_material = container.repository.get_material(material.id)

    assert job.status == "queued"
    assert completed.status == "completed"
    assert stored_material is not None
    assert stored_material.chunk_count >= 1
    assert container.repository.list_materials(space.id)[0].id == material.id
    assert container.repository.list_chunks(space.id)
