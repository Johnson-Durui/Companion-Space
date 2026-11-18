from __future__ import annotations

import asyncio
import json
from contextlib import aclosing

import numpy as np
import pytest

from app.llm.errors import LLMOutputError
from app.llm.gateway import LLMGateway
from app.llm.json_guard import loads_lenient
from app.llm.presets import RoleAssignment, list_presets
from app.llm.prompts import data_block
from app.llm.tagged import parse_blocks
from app.llm.usage import list_usage
from app.providers.base import Message, StreamChunk, Usage
from app.providers.errors import MissingRoleError, provider_error_code
from app.services import provider_registry
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService
from fakes.fake_llm import Script, ScriptedProvider


@pytest.fixture
def model_registry(isolated_settings):
    repository = SQLiteRepository(isolated_settings)
    vault = VaultService(isolated_settings, repository)
    vault.bootstrap()
    return ProviderRegistryService(repository, vault)


def setup_gateway(model_registry, monkeypatch, adapter, *, preset="bigmodel"):
    monkeypatch.setattr(provider_registry, "build_provider_adapter", lambda *_args, **_kwargs: adapter)
    model_registry.save_connection(preset_id=preset, api_key="isolated-unit-test-secret")
    return LLMGateway(model_registry)


def test_presets_are_valid_and_second_connection_fills_only_vacant_roles(model_registry):
    presets = list_presets()
    assert all(preset.models.get("live") or preset.manual_live for preset in presets)
    assert len({preset.id for preset in presets}) == len(presets)
    first = model_registry.save_connection(preset_id="bigmodel", api_key="isolated-key-a")
    second = model_registry.save_connection(preset_id="siliconflow", api_key="isolated-key-b")
    roles = model_registry.get_roles()
    assert roles["live"].connection_id == first["id"]
    assert roles["vision"].connection_id == first["id"]
    assert roles["embedding"].connection_id == second["id"]
    assert roles["stt"].connection_id == second["id"]
    assert "isolated-key-a" not in json.dumps(first, default=str)
    assert "isolated-key-b" not in json.dumps(second, default=str)
    model_registry.delete_connection(first["id"])
    after = model_registry.get_roles()
    assert "live" not in after
    assert after["embedding"].connection_id == second["id"]


def test_no_unconfigured_provider_is_synthesized(model_registry):
    gateway = LLMGateway(model_registry)
    with pytest.raises(MissingRoleError) as error:
        asyncio.run(gateway.complete_text("live", "sys", [Message(role="user", content="hello")]))
    assert provider_error_code(error.value) == "model_role_missing"
    assert model_registry.list_connections() == []


def test_registry_probes_every_configured_role_with_actual_adapter_methods(model_registry, monkeypatch):
    provider = ScriptedProvider(*(
        Script((StreamChunk(text="Red.", finish_reason="stop"),))
        for _ in range(4)
    ))
    setup_gateway(model_registry, monkeypatch, provider, preset="siliconflow")
    connection = model_registry.list_connections()[0]["id"]
    roles = model_registry.get_roles()
    roles["tts"] = RoleAssignment(connection_id=connection, model="selected-tts", params={"voice_id": "chosen"})
    roles["vision"] = RoleAssignment(connection_id=connection, model="selected-vision")
    roles["checker"] = RoleAssignment(connection_id=connection, model="selected-checker")
    model_registry.set_roles(roles)

    results = asyncio.run(model_registry.test_connection(connection))
    assert {result.role for result in results if result.ok} == set(roles)
    assert provider.embeds and provider.transcriptions and provider.utterances
    assert next(result for result in results if result.role == "stt").message
    assert provider.utterances[0][1] == "chosen"
    sent = next(call for call in provider.calls if call.model == "selected-vision")
    assert isinstance(sent.messages[0].content, list)
    assert sent.messages[0].content[0]["image_b64"].startswith("iVBOR")


def valid_copy(text):
    return parse_blocks(text)[0].one("formula").text


def test_tagged_repair_caches_valid_result_and_updates_usage(model_registry, monkeypatch):
    latex = r"\frac{a}{b} < \sqrt{x}"
    provider = ScriptedProvider(
        Script((StreamChunk(text="<answer>invalid</answer>", usage=Usage(input_tokens=3, output_tokens=4)),)),
        Script((StreamChunk(
            text=f"<answer><formula>{latex}</formula></answer>",
            reasoning="unpublished", usage=Usage(input_tokens=5, output_tokens=6),
        ),), contains=("Expected one <formula>", "Return only the complete corrected result.")),
    )
    gateway = setup_gateway(model_registry, monkeypatch, provider)

    async def exercise():
        for _ in range(2):
            result = await gateway.complete_tagged(
                "analysis", "tagged_roundtrip", {"formula": data_block("formula", latex)},
                parse=valid_copy,
            )
            assert result == latex

    asyncio.run(exercise())
    assert len(provider.calls) == 2
    usage = list_usage(model_registry.repository)
    assert [(row.calls, row.tokens_in, row.tokens_out) for row in usage] == [(2, 8, 10)]
    with model_registry.repository.connection() as conn:
        response = conn.execute("SELECT response FROM llm_cache").fetchone()[0]
    assert latex in response
    assert "unpublished" not in response and "invalid" not in response


def test_truncation_raises_for_chat_and_increases_tagged_retry_budget(model_registry, monkeypatch):
    truncated = StreamChunk(text="<formula>", finish_reason="length")
    provider = ScriptedProvider(
        Script((truncated,)),
        Script((truncated,)),
        Script((StreamChunk(text="<answer><formula>good</formula></answer>"),)),
    )
    gateway = setup_gateway(model_registry, monkeypatch, provider)

    async def exercise():
        with pytest.raises(LLMOutputError) as error:
            await gateway.complete_text("live", "sys", [Message(role="user", content="hello")])
        assert provider_error_code(error.value) == "provider_output_truncated"
        result = await gateway.complete_tagged(
            "analysis", "tagged_roundtrip", {"formula": "good"}, parse=valid_copy, max_tokens=128,
        )
        assert result == "good"

    asyncio.run(exercise())
    assert [request.max_tokens for request in provider.calls[1:]] == [128, 256]


def test_live_bypasses_analysis_limit_and_other_calls_wait(model_registry, monkeypatch):
    class BlockingProvider(ScriptedProvider):
        def __init__(self):
            super().__init__()
            self.admitted = set()
            self.release = asyncio.Event()
            self.entered = asyncio.Event()

        async def _stream_once(self, request):
            self.admitted.add(request.messages[0].content)
            self.entered.set()
            if request.messages[0].content != "live":
                await self.release.wait()
            yield StreamChunk(text="answer")

    async def exercise():
        provider = BlockingProvider()
        gateway = setup_gateway(model_registry, monkeypatch, provider)
        gateway.set_concurrency(1)

        def complete(role, message):
            return gateway.complete_text(role, "system", [Message(role="user", content=message)])

        first = asyncio.create_task(complete("analysis", "first"))
        await asyncio.wait_for(provider.entered.wait(), timeout=2)
        queued = asyncio.create_task(complete("analysis", "queued"))
        try:
            await asyncio.wait_for(complete("live", "live"), timeout=2)
            assert provider.admitted == {"first", "live"}
        finally:
            provider.release.set()
            await asyncio.gather(first, queued)
        assert provider.admitted == {"first", "live", "queued"}

    asyncio.run(exercise())


def test_gateway_cancel_event_closes_stream_and_releases_analysis_slot(model_registry, monkeypatch):
    entered = asyncio.Event()
    closed = asyncio.Event()

    class CancellableProvider(ScriptedProvider):
        async def _stream_once(self, request):
            if request.messages[0].content == "blocked":
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    closed.set()
            yield StreamChunk(text="ok")

    gateway = setup_gateway(model_registry, monkeypatch, CancellableProvider())
    gateway.set_concurrency(1)

    async def exercise():
        cancel = asyncio.Event()

        async def blocked():
            async with aclosing(gateway.stream_text(
                "analysis", "sys", [Message(role="user", content="blocked")], cancel=cancel,
            )) as stream:
                return [chunk async for chunk in stream]

        task = asyncio.create_task(blocked())
        await asyncio.wait_for(entered.wait(), timeout=2)
        cancel.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        assert closed.is_set()
        answer = await asyncio.wait_for(
            gateway.complete_text("analysis", "sys", [Message(role="user", content="next")]), timeout=2,
        )
        assert answer.text == "ok"

    asyncio.run(exercise())


def test_vision_and_embedding_use_real_role_bindings_and_batching(model_registry, monkeypatch):
    provider = ScriptedProvider(Script((StreamChunk(text=r"\frac{1}{2}"),)))
    gateway = setup_gateway(model_registry, monkeypatch, provider)
    model_registry.save_connection(preset_id="siliconflow", api_key="isolated-key-b")
    inputs = ["a" * size for size in range(1, 68)]

    async def exercise():
        transcription = await gateway.transcribe_page(b"image bytes", mime="image/png")
        embedded = await gateway.embed(inputs)
        return transcription, embedded

    transcription, embedded = asyncio.run(exercise())
    assert transcription == r"\frac{1}{2}"
    assert [text for batch in provider.embeds for text in batch] == inputs
    assert len(provider.embeds) > 1
    assert isinstance(embedded, np.ndarray) and embedded.shape == (len(inputs), 2)
    assert np.array_equal(embedded[:, 0], np.arange(1, len(inputs) + 1))


def test_tagged_blocks_keep_math_nested_fields_and_report_unfinished():
    latex = r"\frac{a}{b} < x > \sqrt{y}"
    source = f'preface <item key="q-1"><stem>{latex}</stem><option/>tail</item>'
    node = parse_blocks(source)[0]
    assert node.attr("key") == "q-1"
    assert node.text == "tail"
    assert node.one("stem").text == latex
    assert len(node.many("option")) == 1
    with pytest.raises(ValueError, match="missing"):
        node.attr("missing")
    with pytest.raises(ValueError, match="Expected one"):
        node.one("answer")
    with pytest.warns(UserWarning, match="unfinished"):
        unfinished = parse_blocks("<item><stem>partial")
    assert unfinished[0].one("stem").text == "partial"
    assert "x<y>0" == parse_blocks("<stem>x<y>0</stem>")[0].text
    assert data_block("doc", "</data> <data name='x'>").count("</data>") == 1


@pytest.mark.parametrize("raw, expected", [
    (r'{"formula":"\frac{a}{b}\sqrt{x}"}', {"formula": r"\frac{a}{b}\sqrt{x}"}),
    (r'{"formula":"\\alpha", "mark":"\u003c"}', {"formula": r"\alpha", "mark": "<"}),
    ('{"value": 1,}', {"value": 1}),
])
def test_json_guard_repairs_latex_ambiguity_and_invalid_json(raw, expected):
    assert loads_lenient(raw) == expected


@pytest.mark.parametrize("raw", [r'{"text":"\u0009"}', r'{"text":"\f"}', '{"text":"literal\nescape"}'])
def test_json_guard_rejects_control_characters(raw):
    with pytest.raises(LLMOutputError, match="control"):
        loads_lenient(raw)



def test_explicit_local_compatible_endpoints_can_be_saved_without_keys(model_registry):
    local = model_registry.save_connection(preset_id="custom", base_url="http://192.168.4.12:8282/api/v3/")
    assert local["base_url"] == "http://192.168.4.12:8282/api/v3"
    assert model_registry.vault.get_provider_secret(local["id"]) is None
    with pytest.raises(ValueError, match="API key"):
        model_registry.save_connection(preset_id="custom", base_url="https://vendor.example/api/v3")
    with pytest.raises(ValueError, match="API key"):
        model_registry.update_connection(local["id"], base_url="https://vendor.example/api/v3")
    assert model_registry.get_connection(local["id"])["base_url"] == local["base_url"]


def test_vision_probe_requires_correct_visible_color(model_registry, monkeypatch):
    provider = ScriptedProvider(Script((StreamChunk(text="Unknown", reasoning="red"),)))
    setup_gateway(model_registry, monkeypatch, provider)
    connection = model_registry.list_connections()[0]["id"]
    model_registry.set_roles({"vision": model_registry.get_roles()["vision"]})
    result = asyncio.run(model_registry.test_connection(connection))[0]
    assert not result.ok
    assert result.role == "vision"
    assert result.code == "provider_protocol_error"
