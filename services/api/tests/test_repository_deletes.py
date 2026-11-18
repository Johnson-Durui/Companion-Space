from __future__ import annotations


from app.api.deps import get_container


def test_delete_character_removes_only_the_target_character(isolated_settings) -> None:
    container = get_container()
    deleted_character = container.characters.create_character(name="Delete")
    kept_character = container.characters.create_character(name="Keep")

    deleted = container.repository.delete_character(deleted_character.id)

    assert deleted is True
    assert container.repository.get_character(deleted_character.id) is None
    assert container.repository.get_character(kept_character.id) is not None
