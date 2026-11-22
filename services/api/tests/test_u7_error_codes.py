"""B10 finish verification: every user-facing API error carries a structured error code."""

from __future__ import annotations

import ast
from pathlib import Path

from fastapi.testclient import TestClient


def _headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


def _is_structured_detail_dict(node: ast.AST) -> bool:
    if isinstance(node, ast.Dict):
        keys = {
            key.value
            for key in node.keys
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
        return {"code", "message"} <= keys
    return False


def test_every_api_http_exception_provides_structured_code_and_message() -> None:
    api_root = Path(__file__).resolve().parents[1] / "app" / "api"
    violations: list[str] = []

    for path in sorted(api_root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
            if name != "HTTPException":
                continue

            detail_node: ast.AST | None = None
            for kw in node.keywords:
                if kw.arg == "detail":
                    detail_node = kw.value
                    break
            if detail_node is None and len(node.args) >= 2:
                detail_node = node.args[1]

            if detail_node is None or not _is_structured_detail_dict(detail_node):
                rel = path.relative_to(api_root.parents[2]).as_posix()
                violations.append(f"{rel}:{node.lineno}")

    assert violations == [], f"Found HTTPException without structured {{code, message}}: {violations}"


def test_user_facing_error_responses_always_include_code(client: TestClient, owner_token: str) -> None:
    headers = _headers(owner_token)

    # Missing course
    resp = client.get("/api/v2/courses/does-not-exist/map", headers=headers)
    assert resp.status_code == 404
    body = resp.json()
    assert isinstance(body.get("code"), str) and body["code"]
    assert isinstance(body.get("message"), str) and body["message"]

    # Create empty course & start analysis without materials
    created = client.post(
        "/api/v2/courses",
        json={"name": "错误码测试课程", "goal": "测试"},
        headers=headers,
    )
    assert created.status_code == 201
    course_id = created.json()["id"]

    no_mat = client.post(
        f"/api/v2/courses/{course_id}/analysis/start",
        json={"estimate_only": False, "confirmed": True},
        headers=headers,
    )
    assert no_mat.status_code == 400
    assert no_mat.json()["code"] == "material_required"

    # Invalid provider connection ID
    missing_conn = client.patch(
        "/api/v2/providers/connections/nonexistent",
        json={"label": "updated"},
        headers=headers,
    )
    assert missing_conn.status_code == 404
    assert missing_conn.json()["code"] == "provider_connection_not_found"

    missing_models = client.get("/api/v2/providers/connections/nonexistent/models", headers=headers)
    assert missing_models.status_code >= 400
    assert isinstance(missing_models.json().get("code"), str) and missing_models.json()["code"]

    # Invalid image encoding in diagnostics chat
    bad_img = client.post(
        "/api/v2/diagnostics/chat",
        json={"message": "check", "image": {"mime": "image/png", "data_b64": "not-valid-base64!!!"}},
        headers=headers,
    )
    assert bad_img.status_code == 400
    assert bad_img.json()["code"] == "invalid_image"

    # Missing teacher in default character update
    missing_char = client.put(
        "/api/v2/settings/default-character",
        json={"character_id": "nonexistent-tutor"},
        headers=headers,
    )
    assert missing_char.status_code == 404
    assert missing_char.json()["code"] == "character_not_found"
