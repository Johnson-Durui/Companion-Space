import json
import re
from pathlib import Path

_ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4", ".wav"}
_REGION_RESTRICTED_GENERATORS = ("minimax h3",)


def _parse_license_rows(text: str) -> dict[str, tuple[str, str, str]]:
    rows: dict[str, tuple[str, str, str]] = {}
    for line in text.splitlines():
        m = re.match(r"^\|\s+`([^`]+)`\s+\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$", line)
        if m:
            rows[m.group(1)] = (m.group(2), m.group(3), m.group(4))
    return rows


def test_active_avatar_assets_exclude_retired_vrm_and_have_license_entries() -> None:
    assets = Path(__file__).resolve().parents[3] / "assets" / "avatars"
    notices = (assets / "LICENSES.md").read_text(encoding="utf-8")
    vrm_models = sorted(path for path in assets.rglob("*") if path.suffix.lower() == ".vrm")
    assert vrm_models == [], f"Retired VRM models must not live in active assets/avatars: {vrm_models}"

    rows = _parse_license_rows(notices)
    active_files = {
        path.relative_to(assets).as_posix()
        for path in assets.rglob("*")
        if path.is_file() and path.suffix.lower() in _ASSET_SUFFIXES
    }
    assert active_files, "Expected built-in avatar assets under assets/avatars"
    assert active_files <= rows.keys(), f"Unregistered avatar assets: {sorted(active_files - rows.keys())}"

    for rel in sorted(active_files):
        generator, _source, redist_col = rows[rel]
        assert generator.strip(), f"Missing generator registration for {rel}"
        lowered_gen = generator.lower()
        if any(token in lowered_gen for token in _REGION_RESTRICTED_GENERATORS):
            assert "allow_redistribution: false" in redist_col.lower(), (
                f"Region-restricted generator asset {rel} must not set allow_redistribution to true"
            )

    # Built-in pack manifests using regionally restricted video generators must have allow_redistribution = False.
    for manifest_file in sorted((assets / "packs").glob("tutor-*/manifest.json")):
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        media = manifest.get("media") or {}
        gen_text = " ".join(
            str(media.get(k) or "") for k in ("generator", "video_generator", "image_generator")
        ).lower()
        assert gen_text.strip(), f"{manifest_file} must record media generator info"
        if any(token in gen_text for token in _REGION_RESTRICTED_GENERATORS):
            lic = manifest.get("license") or {}
            assert lic.get("allow_redistribution") is False, (
                f"{manifest_file}: MiniMax H3 pack must have allow_redistribution=false"
            )
