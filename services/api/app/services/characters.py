from __future__ import annotations

# ruff: noqa: F401

# Re-exported for existing API routes and tests.
from app.services.character_modules.common import CHARACTER_CARD_MAX_BYTES
from app.services.character_modules.persona import TutorPersona, build_tutor_persona
from app.services.character_modules.crud import CharacterCrudMixin
from app.services.character_modules.asset_lifecycle import CharacterAssetLifecycleMixin
from app.services.character_modules.motions import CharacterMotionMixin
from app.services.character_modules.card_import import CharacterCardImportMixin
from app.services.character_modules.pack_import import CharacterPackImportMixin
from app.services.character_modules.airi import AiriImportMixin
from app.services.character_modules.display_validation import DisplayModelValidationMixin
from app.services.character_modules.archives import CharacterArchiveMixin
from app.services.character_modules.licenses import CharacterLicenseMixin
from app.services.character_modules.paths import CharacterPathMixin
from app.services.character_modules.vrm import VrmValidationMixin
from app.services.character_modules.vrma import VrmaValidationMixin


class CharacterService(
    CharacterCrudMixin,
    CharacterAssetLifecycleMixin,
    CharacterMotionMixin,
    CharacterCardImportMixin,
    CharacterPackImportMixin,
    AiriImportMixin,
    DisplayModelValidationMixin,
    CharacterArchiveMixin,
    CharacterLicenseMixin,
    CharacterPathMixin,
    VrmValidationMixin,
    VrmaValidationMixin,
):
    """Compatibility façade composed from focused character-domain mixins."""

    def tutor_persona(self, character_id: str) -> TutorPersona:
        return build_tutor_persona(self.require_character(character_id))
