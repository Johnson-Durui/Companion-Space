import re
from pathlib import Path

_ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4"}


def test_active_avatar_assets_exclude_retired_vrm_and_have_license_entries() -> None:
    assets = Path(__file__).resolve().parents[3] / "assets" / "avatars"
    notices = (assets / "LICENSES.md").read_text(encoding="utf-8")
    vrm_models = sorted(path for path in assets.rglob("*") if path.suffix.lower() == ".vrm")
    assert vrm_models == [], f"Retired VRM models must not live in active assets/avatars: {vrm_models}"

    registered = set(re.findall(r"(?m)^\|\s+`([^`]+)`\s+\|", notices))
    active_files = {
        path.relative_to(assets).as_posix()
        for path in assets.rglob("*")
        if path.is_file() and path.suffix.lower() in _ASSET_SUFFIXES
    }
    assert active_files, "Expected built-in avatar assets under assets/avatars"
    assert active_files <= registered, f"Unregistered avatar assets: {sorted(active_files - registered)}"
