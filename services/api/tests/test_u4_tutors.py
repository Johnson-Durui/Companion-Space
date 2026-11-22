from __future__ import annotations

import json
from io import BytesIO

from app.api.deps import get_container
from fastapi.testclient import TestClient
from PIL import Image


def _sample_png() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (320, 480), (120, 160, 210)).save(buf, format="PNG")
    return buf.getvalue()


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def test_builtin_tutors_have_distinct_voices_and_u4_metadata(client: TestClient, owner_token: str) -> None:
    resp = client.get("/api/v2/characters", headers=_headers(owner_token))
    assert resp.status_code == 200
    characters = resp.json()
    builtins = [c for c in characters if c.get("pack_metadata", {}).get("source_kind") == "builtin"]
    assert len(builtins) == 6

    # B8 requirement: assert pairwise distinctness of voices (not hardcoded voice IDs)
    voice_ids = [c["voice"]["voice_id"] for c in builtins]
    assert len(set(voice_ids)) == len(builtins), f"Expected 6 distinct built-in voices, got: {voice_ids}"

    for c in builtins:
        assert isinstance(c.get("tagline"), str) and c["tagline"].strip()
        assert isinstance(c.get("greeting"), str) and c["greeting"].strip()
        assert isinstance(c.get("lines"), dict)
        assert c.get("theme") and c["theme"] != "default"


def test_partial_update_preserves_omitted_fields_and_tier_explicit(client: TestClient, owner_token: str) -> None:
    headers = _headers(owner_token)
    container = get_container()
    before = client.get("/api/v2/characters", headers=headers).json()
    chutang = next(c for c in before if c["id"] == "tutor-chutang")

    # Partial update changing ONLY name & tagline must NOT alter persona, style, or mark _tier_explicit
    resp = client.put(
        "/api/v2/characters/tutor-chutang",
        headers=headers,
        json={"name": "初棠·改", "tagline": "温柔细致"},
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["name"] == "初棠·改"
    assert updated["tagline"] == "温柔细致"
    assert updated["greeting"] == chutang["greeting"]
    assert updated["default_style_id"] == chutang["default_style_id"]
    assert updated["persona"]["catchphrases"] == chutang["persona"]["catchphrases"]
    assert updated["video_avatar"]["preferred_tier"] == chutang["video_avatar"]["preferred_tier"]

    with container.repository.connection() as conn:
        row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", ("tutor-chutang",)).fetchone()
    raw = json.loads(row["recipe_json"])
    assert not raw.get("_tier_explicit"), "Editing name/tagline must not mark preferred_tier as explicit"
    assert "name" in raw.get("_edited_fields", [])
    assert "tagline" in raw.get("_edited_fields", [])


def test_non_overwriting_default_merge_on_legacy_builtin_row(client: TestClient, owner_token: str) -> None:
    headers = _headers(owner_token)
    container = get_container()
    # Simulate an existing DB install from U1/U3 before U4 fields existed, where user edited catchphrases
    with container.repository.connection() as conn:
        row = conn.execute("SELECT recipe_json FROM character_packs WHERE id = ?", ("tutor-lanyin",)).fetchone()
        legacy = json.loads(row["recipe_json"])
        legacy.pop("tagline", None)
        legacy.pop("greeting", None)
        legacy.pop("lines", None)
        legacy["voice"]["voice_id"] = "zh-CN-XiaoxiaoNeural"  # old duplicate voice from pre-U4
        legacy["persona"]["catchphrases"] = ["用户自定义的口头禅"]
        legacy["_edited_fields"] = ["catchphrases"]
        conn.execute(
            "UPDATE character_packs SET recipe_json = ? WHERE id = ?",
            (json.dumps(legacy), "tutor-lanyin"),
        )

    merged = client.get("/api/v2/characters", headers=headers).json()
    lanyin = next(c for c in merged if c["id"] == "tutor-lanyin")
    chutang = next(c for c in merged if c["id"] == "tutor-chutang")

    # Missing U4 defaults filled from manifest
    assert lanyin["tagline"] == "敏锐干练"
    assert lanyin["greeting"].strip() != ""
    # Unedited duplicate voice upgraded so all built-ins stay pairwise distinct
    assert lanyin["voice"]["voice_id"] != chutang["voice"]["voice_id"]
    # User-edited field MUST NOT be overwritten
    assert lanyin["persona"]["catchphrases"] == ["用户自定义的口头禅"]


def test_reset_builtin_tutor_restores_defaults_and_rejects_custom(client: TestClient, owner_token: str) -> None:
    headers = _headers(owner_token)
    original = next(c for c in client.get("/api/v2/characters", headers=headers).json() if c["id"] == "tutor-xuechuan")

    # Edit persona, greeting, tagline, and voice
    edit = client.put(
        "/api/v2/characters/tutor-xuechuan",
        headers=headers,
        json={
            "name": "雪川自定义",
            "tagline": "自定义气质",
            "greeting": "自定义问候",
            "catchphrases": ["自定义口头禅"],
            "voice": {"engine": "edge", "voice_id": "zh-CN-XiaoxiaoNeural", "rate": 1.2, "pitch": 0},
        },
    )
    assert edit.status_code == 200
    assert edit.json()["name"] == "雪川自定义"
    assert edit.json()["voice"]["rate"] == 1.2

    # Also store a voice_settings override for tutor-xuechuan
    vs = client.get("/api/v2/voice/settings", headers=headers).json()
    client.put(
        "/api/v2/voice/settings",
        headers=headers,
        json={
            "default": vs.get("default"),
            "characters": {
                **(vs.get("characters") or {}),
                "tutor-xuechuan": {"engine": "edge", "voice_id": "zh-CN-XiaoyiNeural", "rate": 1.3, "pitch": 0},
            },
        },
    )

    # Reset built-in tutor
    reset = client.post("/api/v2/characters/tutor-xuechuan/reset", headers=headers)
    assert reset.status_code == 200
    restored = reset.json()
    assert restored["name"] == original["name"]
    assert restored["tagline"] == original["tagline"]
    assert restored["greeting"] == original["greeting"]
    assert restored["persona"]["catchphrases"] == original["persona"]["catchphrases"]
    assert restored["voice"]["voice_id"] == original["voice"]["voice_id"]
    assert restored["voice"]["rate"] == original["voice"]["rate"]

    # Per-character voice override should also be cleared
    vs_after = client.get("/api/v2/voice/settings", headers=headers).json()
    assert "tutor-xuechuan" not in (vs_after.get("characters") or {})

    # Custom imported tutor cannot be reset (returns coded 400)
    imp = client.post(
        "/api/v2/characters/import",
        content=_sample_png(),
        headers={**headers, "X-Filename": "custom.png"},
    )
    assert imp.status_code == 201
    custom_id = imp.json()["id"]
    bad_reset = client.post(f"/api/v2/characters/{custom_id}/reset", headers=headers)
    assert bad_reset.status_code == 400
    assert bad_reset.json().get("code") == "tutor_reset_builtin_only"

    # Unknown tutor returns coded 404
    missing = client.post("/api/v2/characters/does-not-exist/reset", headers=headers)
    assert missing.status_code == 404
    assert missing.json().get("code") == "tutor_not_found"
