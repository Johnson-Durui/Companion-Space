from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.main import app
from app.models.domain import ModelAssignment, ProviderCapability
from app.providers.base import LLMProvider, ProviderStreamChunk
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from app.services.provider_registry import (
    BUILTIN_MOCK_ANALYSIS_MODEL,
    BUILTIN_MOCK_CONNECTION_ID,
    BUILTIN_MOCK_MODEL,
    BUILTIN_MOCK_STT_MODEL,
    BUILTIN_MOCK_TTS_MODEL,
)


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_space(client: TestClient, owner_token: str, name: str = "M2 runtime") -> dict:
    response = client.post(
        "/api/v1/spaces",
        headers=_auth_headers(owner_token),
        json={"name": name, "topic": "math", "goal": "finish runtime coverage"},
    )
    assert response.status_code == 201
    return response.json()


def _create_session(client: TestClient, owner_token: str, space_id: str) -> dict:
    response = client.post(
        "/api/v1/sessions",
        headers=_auth_headers(owner_token),
        json={"space_id": space_id},
    )
    assert response.status_code == 201
    return response.json()


def _safe_client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def _iter_storage_files(storage_root: Path) -> list[Path]:
    return [path for path in storage_root.rglob("*") if path.is_file()]


def _assert_storage_omits_text(storage_root: Path, *forbidden_values: str) -> None:
    for forbidden_value in forbidden_values:
        needle = forbidden_value.encode("utf-8")
        for path in _iter_storage_files(storage_root):
            if needle in path.read_bytes():
                raise AssertionError("provider secret was persisted to storage")


def test_new_space_persists_explicit_builtin_mock_realtime_assignments(
    client: TestClient,
    owner_token: str,
) -> None:
    space = _create_space(client, owner_token, name="Builtin assignment")

    assignments = client.get(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=_auth_headers(owner_token),
    )

    assert assignments.status_code == 200
    assert {
        (
            item["space_id"],
            item["capability"],
            item["provider_connection_id"],
            item["model_name"],
        )
        for item in assignments.json()
    } == {
        (
            space["id"],
            "chat_llm",
            BUILTIN_MOCK_CONNECTION_ID,
            BUILTIN_MOCK_MODEL,
        ),
        (
            space["id"],
            "analysis_llm",
            BUILTIN_MOCK_CONNECTION_ID,
            BUILTIN_MOCK_ANALYSIS_MODEL,
        ),
        (
            space["id"],
            "stt",
            BUILTIN_MOCK_CONNECTION_ID,
            BUILTIN_MOCK_STT_MODEL,
        ),
        (
            space["id"],
            "tts",
            BUILTIN_MOCK_CONNECTION_ID,
            BUILTIN_MOCK_TTS_MODEL,
        ),
    }


def test_stream_turn_endpoint_emits_multiple_mock_deltas_before_final_ndjson(
    client: TestClient,
    owner_token: str,
) -> None:
    space = _create_space(client, owner_token, name="Stream endpoint")
    session = _create_session(client, owner_token, space["id"])

    with client.stream(
        "POST",
        f"/api/v1/sessions/{session['id']}/turns/stream",
        headers=_auth_headers(owner_token),
        json={"text": "给我一个很短的复习计划"},
    ) as response:
        assert response.status_code == 200
        lines = [json.loads(line) for line in response.iter_lines() if line]

    assert len(lines) >= 3
    assert [item["type"] for item in lines[:-1]] == ["llm.delta"] * (len(lines) - 1)
    assert lines[-1]["type"] == "llm.final"
    assert all(item["session_id"] == session["id"] for item in lines)
    assert "".join(item["payload"]["text"] for item in lines[:-1]).strip()


def test_missing_chat_assignment_returns_an_error_instead_of_silent_mock_fallback(
    client: TestClient,
    owner_token: str,
) -> None:
    space = _create_space(client, owner_token, name="Missing assignment")
    removed = client.delete(
        f"/api/v1/spaces/{space['id']}/assignments/chat_llm",
        headers=_auth_headers(owner_token),
    )
    assert removed.status_code == 204
    session = _create_session(client, owner_token, space["id"])

    response = client.post(
        f"/api/v1/sessions/{session['id']}/turns",
        headers=_auth_headers(owner_token),
        json={"text": "现在开始吧"},
    )

    assert response.status_code in {400, 404, 409, 424}
    detail = response.json()["detail"].lower()
    assert "assignment" in detail or "provider" in detail

    transcript = client.get(
        f"/api/v1/sessions/{session['id']}",
        headers=_auth_headers(owner_token),
    )
    assert transcript.status_code == 200
    assert [turn["role"] for turn in transcript.json()["turns"]] == ["user"]


def test_runtime_capability_mismatch_does_not_silently_use_mock_response(
    client: TestClient,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    space = _create_space(client, owner_token, name="Runtime mismatch")
    voice_connection = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "elevenlabs",
            "label": "Voice only",
            "api_key": "m2-test-elevenlabs-key",
        },
    ).json()
    now = datetime.now(timezone.utc)
    container = get_container()
    container.repository.upsert_model_assignment(
        ModelAssignment(
            id=str(uuid4()),
            space_id=space["id"],
            capability=ProviderCapability.chat_llm,
            provider_connection_id=voice_connection["id"],
            model_name="eleven_turbo_v2",
            created_at=now,
            updated_at=now,
        )
    )
    session = _create_session(client, owner_token, space["id"])

    response = client.post(
        f"/api/v1/sessions/{session['id']}/turns",
        headers=headers,
        json={"text": "解释一下刚才的知识点"},
    )

    assert response.status_code in {400, 404, 409, 424}
    assert "mock" not in response.text.lower()


@pytest.mark.parametrize(
    ("exc", "expected_status"),
    [
        (
            ProviderAuthenticationError(
                provider="anthropic",
                public_detail="invalid API key",
                upstream_status=401,
            ),
            424,
        ),
        (
            ProviderRateLimitError(
                provider="anthropic",
                public_detail="rate limit",
                upstream_status=429,
                retry_after=3.0,
            ),
            429,
        ),
        (
            ProviderTimeoutError(
                provider="anthropic",
                public_detail="timed out",
            ),
            504,
        ),
    ],
)
def test_provider_failures_are_safely_mapped_to_http_errors(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
    exc,
    expected_status: int,
) -> None:
    _ = client
    local_client = _safe_client()
    space = _create_space(local_client, owner_token, name="Safe mapping")
    session = _create_session(local_client, owner_token, space["id"])
    leaked_key = "sk-live-m2-should-never-appear"

    async def fail_submit_text_turn(*, session_id: str, text: str):
        _ = session_id
        _ = text
        raise exc

    monkeypatch.setattr(get_container().companion, "submit_text_turn", fail_submit_text_turn)

    response = local_client.post(
        f"/api/v1/sessions/{session['id']}/turns",
        headers=_auth_headers(owner_token),
        json={"text": f"不要泄露 {leaked_key}"},
    )

    assert response.status_code == expected_status
    assert leaked_key not in response.text
    assert "anthropic" in response.text.lower() or "provider" in response.text.lower()
    if isinstance(exc, ProviderTimeoutError):
        metric_events = local_client.get(
            "/api/v1/metrics/local/events?limit=20",
            headers=_auth_headers(owner_token),
        )
        assert metric_events.status_code == 200
        timeout_event = next(
            item
            for item in metric_events.json()["items"]
            if item["event"] == "model_timeout"
        )
        assert timeout_event["payload"] == {
            "capability": "chat_llm",
            "provider_kind": "anthropic",
            "code": "provider_timeout",
        }


def test_locked_vault_blocks_real_provider_usage_without_echoing_api_key(
    client: TestClient,
    owner_token: str,
) -> None:
    headers = _auth_headers(owner_token)
    api_key = "sk-ant-m2-hidden"
    connection = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "Anthropic runtime",
            "api_key": api_key,
        },
    )
    assert connection.status_code == 201

    locked = client.post("/api/v1/vault/lock", headers=headers)
    assert locked.status_code == 200

    blocked = client.post(
        f"/api/v1/providers/connections/{connection.json()['id']}/test",
        headers=headers,
    )

    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Vault is locked"
    assert api_key not in blocked.text


def test_provider_connection_create_response_never_echoes_plaintext_api_key(
    client: TestClient,
    owner_token: str,
) -> None:
    api_key = "sk-runtime-visibility-check"

    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "anthropic",
            "label": "No key echo",
            "api_key": api_key,
        },
    )

    assert response.status_code == 201
    assert api_key not in response.text

    listed = client.get(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
    )
    assert listed.status_code == 200
    assert api_key not in listed.text


def test_provider_secret_rotation_and_deletion_never_write_plaintext_to_storage(
    client: TestClient,
    owner_token: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    storage_root = get_container().settings.storage_root
    probe = storage_root / "provider-secret-probe.txt"
    probe_secret = "probe-secret-that-response-assertions-would-miss"
    probe.write_text(probe_secret, encoding="utf-8")
    assert probe_secret not in client.get(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
    ).text
    with pytest.raises(AssertionError, match="persisted to storage"):
        _assert_storage_omits_text(storage_root, probe_secret)
    probe.unlink()

    headers = _auth_headers(owner_token)
    first_secret = "sk-storage-first-canary-9ea9f5a7"
    rotated_secret = "sk-storage-rotated-canary-554287c1"
    created = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "anthropic",
            "label": "Storage scan",
            "api_key": first_secret,
        },
    )
    assert created.status_code == 201
    connection_id = created.json()["id"]
    _assert_storage_omits_text(storage_root, first_secret)

    updated = client.patch(
        f"/api/v1/providers/connections/{connection_id}",
        headers=headers,
        json={"label": "Storage scan rotated", "api_key": rotated_secret},
    )
    assert updated.status_code == 200
    _assert_storage_omits_text(storage_root, first_secret, rotated_secret)

    deleted = client.delete(
        f"/api/v1/providers/connections/{connection_id}",
        headers=headers,
    )
    assert deleted.status_code == 204
    _assert_storage_omits_text(storage_root, first_secret, rotated_secret)
    assert first_secret not in caplog.text
    assert rotated_secret not in caplog.text


def test_validation_error_never_echoes_rejected_api_key(
    client: TestClient,
    owner_token: str,
) -> None:
    rejected_key = "sensitive-" + ("x" * 500)
    response = client.post(
        "/api/v1/providers/connections",
        headers=_auth_headers(owner_token),
        json={
            "provider": "anthropic",
            "label": "Rejected key",
            "api_key": rejected_key,
        },
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert rejected_key not in response.text


def test_locking_vault_aborts_an_active_provider_stream(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = _create_space(client, owner_token, name="Lock active stream")
    headers = _auth_headers(owner_token)
    connection = client.post(
        "/api/v1/providers/connections",
        headers=headers,
        json={
            "provider": "openai-compatible",
            "label": "Epoch-guarded provider",
            "api_key": "stream-epoch-test-key",
        },
    )
    assert connection.status_code == 201
    assignment = client.post(
        f"/api/v1/spaces/{space['id']}/assignments",
        headers=headers,
        json={
            "capability": "chat_llm",
            "provider_connection_id": connection.json()["id"],
            "model_name": "epoch-test-model",
        },
    )
    assert assignment.status_code == 201
    session = _create_session(client, owner_token, space["id"])
    container = get_container()

    class BlockingProvider(LLMProvider):
        name = "blocking"

        async def generate_reply_stream(self, **kwargs):
            _ = kwargs
            yield ProviderStreamChunk(
                text='{"display_text":"partial',
            )
            started.set()
            await release.wait()
            yield ProviderStreamChunk(
                text=' complete","spoken_text":"complete","emotion":"warm","suggested_actions":[]}',
            )

    async def scenario() -> None:
        nonlocal_events: list[str] = []

        async def consume() -> None:
            with pytest.raises(
                ProviderAuthenticationError,
                match="Vault was locked",
            ):
                async for event in container.companion.stream_text_turn(
                    session_id=session["id"],
                    text="start a long reply",
                ):
                    nonlocal_events.append(event.type)

        pending = asyncio.create_task(consume())
        await started.wait()
        container.vault.lock()
        release.set()
        await pending
        assert nonlocal_events == ["llm.delta"]

    started = asyncio.Event()
    release = asyncio.Event()
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: BlockingProvider(),
    )
    asyncio.run(scenario())

    stored = container.companion.get_session(session["id"])
    assert stored.state.value == "error"
    assert [
        turn.role.value
        for turn in container.repository.list_turns(session["id"])
    ] == ["user"]


def test_same_session_rejects_a_concurrent_turn(
    client: TestClient,
    owner_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    space = _create_space(client, owner_token, name="Concurrent turn")
    session = _create_session(client, owner_token, space["id"])
    container = get_container()

    class BlockingProvider(LLMProvider):
        name = "blocking"

        async def generate_reply_stream(self, **kwargs):
            _ = kwargs
            started.set()
            await release.wait()
            yield ProviderStreamChunk(
                text=json.dumps(
                    {
                        "display_text": "done",
                        "spoken_text": "done",
                        "emotion": "warm",
                        "suggested_actions": [],
                    }
                ),
            )

    async def scenario() -> None:
        start_gate = asyncio.Event()

        async def attempt(text: str) -> str:
            await start_gate.wait()
            try:
                await container.companion.submit_text_turn(
                    session_id=session["id"],
                    text=text,
                )
            except ValueError as exc:
                assert "already has an active turn" in str(exc)
                return "rejected"
            return "completed"

        first = asyncio.create_task(attempt("first"))
        second = asyncio.create_task(attempt("second"))
        start_gate.set()
        await started.wait()
        release.set()
        results = sorted(await asyncio.gather(first, second))
        assert results == ["completed", "rejected"]

    started = asyncio.Event()
    release = asyncio.Event()
    monkeypatch.setattr(
        "app.services.provider_registry.build_provider_adapter",
        lambda connection, api_key: BlockingProvider(),
    )
    asyncio.run(scenario())

    turns = container.repository.list_turns(session["id"])
    user_turns = [turn.display_text for turn in turns if turn.role.value == "user"]
    assistant_turns = [turn.display_text for turn in turns if turn.role.value == "assistant"]
    assert len(user_turns) == 1
    assert user_turns[0] in {"first", "second"}
    assert assistant_turns == ["done\n\n未使用空间资料。"]
