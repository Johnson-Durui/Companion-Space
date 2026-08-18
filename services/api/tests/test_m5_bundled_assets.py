from __future__ import annotations

import hashlib
import json

from app.services.characters import CharacterService
from app.services.repository import SQLiteRepository


EXPECTED_MODELS = {
    "Mira.vrm": {
        "sha256": "e82bed2eef81d81118df47c01ab502bd8432d06c97bf316a50af392211c52c79",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "Kite.vrm": {
        "sha256": "a9bd96ee9002ba46dc46025d1d2f3ff0919b6251f570abf973a040964198bdda",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "Cael.vrm": {
        "sha256": "a6d92d890bf2fa5000329ba57ba32c3c7d04986caf64a2dcf3d4b26559b254ca",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "Lyra.vrm": {
        "sha256": "e873fa0072d08a9fc78a5f71bdd4ded9db1ab295d27b9bca077591ce1b3b7bbf",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "VRM1_Constraint_Twist_Sample.vrm": {
        "sha256": "12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "Seed-san.vrm": {
        "sha256": "624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23",
        "spec_version": "1.0",
        "redistribution_allowed": "yes",
        "attribution_required": "yes",
    },
    "Sendagaya-Shino.vrm": {
        "sha256": "f11b2648e7e588ae171ad1c32e465f84e5b130b1d1789e3a3702946c0981d2a9",
        "spec_version": "0.x",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
    "Sakurada-Fumiriya.vrm": {
        "sha256": "a36e91b81518c59f6da0e3f34a176b79090a8c68cc6bd5fe03c1560744b283f3",
        "spec_version": "0.x",
        "redistribution_allowed": "yes",
        "attribution_required": "no",
    },
}

EXPECTED_MOTIONS = {
    "companion-idle.vrma": "0ed3bb51dfe023eb650bc20e9810ab6299845133a461c5bd8e753e5aab31b59e",
    "companion-listening.vrma": "a34c126931f50efd85eb4df9d9bc0fbac2f77dc8f4fe0c27ee1a841b20aa4633",
    "companion-thinking.vrma": "29e8ebf58dc841ba03136aa4a3f8a6eaba0d0298d34a3cd139115201ef4bbe90",
    "companion-speaking.vrma": "d9a441a5bef4f6527172a75b258493d30e8a99923284f8ed741ca2af2a49b7bb",
}


def test_bundled_vrm_assets_match_manifest_metadata_and_notices(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    service = CharacterService(repository)
    repo_root = isolated_settings.repo_root
    model_root = repo_root / "apps" / "web" / "public" / "assets" / "characters" / "models"
    manifest = json.loads((model_root / "manifest.json").read_text(encoding="utf-8"))
    manifest_by_filename = {item["file"]: item for item in manifest["models"]}
    notices = (repo_root / "assets" / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")

    assert set(manifest_by_filename) == set(EXPECTED_MODELS)

    for filename, expected in EXPECTED_MODELS.items():
        model_bytes = (model_root / filename).read_bytes()
        parsed_meta = service._parse_vrm_bytes(model_bytes)
        model_manifest = manifest_by_filename[filename]

        assert hashlib.sha256(model_bytes).hexdigest() == expected["sha256"]
        assert parsed_meta["spec_version"] == expected["spec_version"]
        assert parsed_meta["redistribution_allowed"] == expected["redistribution_allowed"]
        assert parsed_meta["attribution_required"] == expected["attribution_required"]
        assert model_manifest["sha256"] == expected["sha256"]
        assert model_manifest["redistribution_allowed"] is True
        assert filename in notices
        assert expected["sha256"] in notices


def test_bundled_vrma_assets_are_valid_project_owned_cc0_loops(isolated_settings) -> None:
    repository = SQLiteRepository(isolated_settings)
    service = CharacterService(repository)
    repo_root = isolated_settings.repo_root
    motion_root = repo_root / "apps" / "web" / "public" / "assets" / "characters" / "motions"
    manifest = json.loads((motion_root / "manifest.json").read_text(encoding="utf-8"))
    manifest_by_filename = {item["file"]: item for item in manifest["motions"]}
    notices = (repo_root / "assets" / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")

    assert set(manifest_by_filename) == set(EXPECTED_MOTIONS)
    assert (repo_root / manifest["generator"]).is_file()
    assert (motion_root / manifest["license_path"]).is_file()

    for filename, expected_sha256 in EXPECTED_MOTIONS.items():
        motion_bytes = (motion_root / filename).read_bytes()
        service._validate_vrma_bytes(motion_bytes)
        motion_manifest = manifest_by_filename[filename]

        assert hashlib.sha256(motion_bytes).hexdigest() == expected_sha256
        assert motion_manifest["sha256"] == expected_sha256
        assert motion_manifest["format"] == "VRMC_vrm_animation 1.0"
        assert motion_manifest["license"] == "CC0 1.0 Universal"
        assert motion_manifest["in_place"] is True
        assert motion_manifest["redistribution_allowed"] is True
        assert filename in notices
        assert expected_sha256 in notices
