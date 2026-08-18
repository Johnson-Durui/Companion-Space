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


def test_requirements_only_keep_dependencies_used_by_the_m2_runtime() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    requirements = (
        repo_root / "services" / "api" / "requirements.txt"
    ).read_text(encoding="utf-8")

    assert "sqlalchemy" not in requirements
    assert "alembic" not in requirements
    assert "python-multipart" not in requirements
    assert "pytest" not in requirements
    assert "ruff" not in requirements
    assert "httpx==0.28.1" in requirements.splitlines()
    assert "httpcore==1.0.9" in requirements.splitlines()
    assert "google-genai" in requirements


def test_development_requirements_extend_the_runtime_manifest() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    requirements = (
        repo_root / "services" / "api" / "requirements-dev.txt"
    ).read_text(encoding="utf-8")

    assert "-r requirements.txt" in requirements.splitlines()
    assert "pytest==9.1.1" in requirements.splitlines()
    assert "ruff==0.12.1" in requirements.splitlines()
