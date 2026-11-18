from pathlib import Path

from app.core.config import Settings


BUSINESS_SECRET_FIELDS = {
    "anthropic_api_key",
    "elevenlabs_api_key",
}


def test_business_api_keys_are_not_settings_fields() -> None:
    assert BUSINESS_SECRET_FIELDS.isdisjoint(Settings.model_fields)


def test_business_api_keys_are_not_documented_as_environment_configuration() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    example = (repo_root / ".env.example").read_text(encoding="utf-8")

    assert "ANTHROPIC_API_KEY" not in example
    assert "ELEVENLABS_API_KEY" not in example
