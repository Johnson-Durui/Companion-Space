import json
import struct

from app.core.config import APP_ROOT


def test_vrm_teacher_import_private_asset_and_persona_update(client, owner_token):
    payload = (APP_ROOT / "assets/avatars/models/VRM1_Constraint_Twist_Sample.vrm").read_bytes()
    headers = {"Authorization": f"Bearer {owner_token}", "X-Filename": "teacher.vrm"}
    imported = client.post("/api/v2/characters/import", headers=headers, content=payload)
    assert imported.status_code == 201, imported.json()
    character = imported.json()
    source = character["appearance"]["src"]
    assert character["model_metadata"]["authors"]
    assert character["model_metadata"]["redistribution_allowed"]
    assert client.get(source).status_code == 401
    response = client.get(source, headers=headers)
    assert response.content == payload
    assert response.headers["content-type"] == "model/gltf-binary"

    edit = {
        "name": "Teacher A", "relationship": "A patient tutor", "traits": ["Patient"],
        "catchphrases": [], "address_user_as": "Learner", "default_style_id": "rigorous",
    }
    result = client.put(f"/api/v2/characters/{character['id']}", headers=headers, json=edit)
    assert result.status_code == 200, result.json()
    assert result.json()["persona"]["traits"] == edit["traits"]
    assert result.json()["default_style_id"] == "rigorous"
    assert result.json()["model_metadata"] == character["model_metadata"]
    listed = client.get("/api/v2/characters", headers=headers).json()
    assert any(item["id"] == character["id"] and item["name"] == edit["name"] for item in listed)


def test_vrm_teacher_import_rejects_external_resources(client, owner_token):
    body = json.dumps({"images": [{"uri": "https://example.invalid/external.png"}]}).encode()
    body += b" " * (-len(body) % 4)
    glb = struct.pack("<4sIII4s", b"glTF", 2, len(body) + 20, len(body), b"JSON") + body
    headers = {"Authorization": f"Bearer {owner_token}", "X-Filename": "external.vrm"}
    result = client.post("/api/v2/characters/import", headers=headers, content=glb)
    assert result.status_code == 400
