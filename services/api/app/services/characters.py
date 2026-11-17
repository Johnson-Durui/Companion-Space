from __future__ import annotations

# ruff: noqa: F401

# Re-exported for existing API routes and tests.
from app.services.character_modules.crud import CharacterCrudMixin
from app.services.character_modules.asset_lifecycle import CharacterAssetLifecycleMixin
from app.services.character_modules.motions import CharacterMotionMixin
from app.services.character_modules.licenses import CharacterLicenseMixin
from app.services.character_modules.paths import CharacterPathMixin
from app.services.character_modules.vrm import VrmValidationMixin
from app.services.character_modules.vrma import VrmaValidationMixin


class CharacterService(
    CharacterCrudMixin,
    CharacterAssetLifecycleMixin,
    CharacterMotionMixin,
    CharacterLicenseMixin,
    CharacterPathMixin,
    VrmValidationMixin,
    VrmaValidationMixin,
):
    """Compatibility façade composed from focused character-domain mixins."""
