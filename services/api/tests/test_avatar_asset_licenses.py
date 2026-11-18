import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from app.services.character_modules.vrm import VrmValidationMixin

_VRM0_REDISTRIBUTABLE = {
    "CC0",
    "CC_BY",
    "CC_BY_NC",
    "CC_BY_SA",
    "CC_BY_NC_SA",
    "CC_BY_ND",
    "CC_BY_NC_ND",
}


def test_distributed_vrm_models_have_redistribution_permission_and_notices() -> None:
    assets = Path(__file__).resolve().parents[3] / "assets" / "avatars"
    notices = (assets / "LICENSES.md").read_text(encoding="utf-8")
    registered = set(re.findall(r"(?m)^\|\s+`(models/[^`]+\.vrm)`\s+\|", notices))
    models = sorted(path for path in assets.rglob("*") if path.suffix.lower() == ".vrm")
    assert models, "No models in the distribution directory"
    assert {path.relative_to(assets).as_posix() for path in models} == registered

    for path in models:
        assert path.name.lower() != "seed-san.vrm", "Seed-san is excluded from distribution"
        document, _ = VrmValidationMixin._parse_glb_json(
            path.read_bytes(),
            error_message=f"{path.name}: invalid VRM",
            allow_unknown_chunks=True,
        )
        extensions = document["extensions"]
        if "VRMC_vrm" in extensions:
            metadata = extensions["VRMC_vrm"]["meta"]
            allowed = metadata.get("allowRedistribution") is True
        else:
            metadata = extensions["VRM"]["meta"]
            license_name = metadata.get("licenseName")
            query = parse_qs(urlsplit(metadata.get("otherPermissionUrl", "")).query)
            allowed = license_name in _VRM0_REDISTRIBUTABLE or (
                license_name == "Other" and query.get("redistribution") == ["allow"]
            )
        assert allowed, f"{path.name}: embedded VRM metadata does not permit redistribution"
