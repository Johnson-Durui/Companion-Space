"""Run the M1 provider smoke with PYTHONPATH=services/api from this checkout."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import aclosing
import json
from pathlib import Path
import re
import secrets
from time import perf_counter
from uuid import uuid4

from dotenv import dotenv_values

from app.core.config import Settings
from app.llm.gateway import LLMGateway
from app.llm.presets import RoleAssignment
from app.llm.tagged import parse_blocks
from app.llm.usage import list_usage
from app.providers.base import Message
from app.providers.errors import ProviderError, provider_error_payload
from app.services.provider_registry import ProviderRegistryService
from app.services.repository import SQLiteRepository
from app.services.vault import VaultService
from app.voice.tts.edge import DEFAULT_VOICE, preview_audio

ROOT = Path(__file__).resolve().parents[1]
FORMULA = r"\frac{\theta}{\sqrt{x}}+\beta"
CHECKS = ("stream", "tagged_latex", "image_transcription", "embedding", "default_voice")
ROLES = {"stream": "live", "tagged_latex": "analysis", "image_transcription": "vision", "embedding": "embedding"}


async def latency(gateway: LLMGateway):
    start = perf_counter()
    stream = gateway.stream_text(
        "live", "Reply in one brief sentence.", [Message(role="user", content="Can you read this?")], max_tokens=80,
    )
    first = None
    async with aclosing(stream):
        async for piece in stream:
            if piece and first is None:
                first = round((perf_counter() - start) * 1000)
    if first is None:
        raise ValueError("No visible token")
    return {"first_token_ms": first}


async def latex(gateway: LLMGateway):
    def parse(text: str) -> str:
        formulas = [node.text.strip() for node in parse_blocks(text) if node.tag == "formula"]
        if formulas != [FORMULA]:
            raise ValueError("The formula did not survive the tag round trip.")
        return formulas[0]

    await gateway.complete_tagged("analysis", "tagged_roundtrip", {"formula": FORMULA}, parse=parse, cache=False)
    return {}


async def image(gateway: LLMGateway):
    text = await gateway.transcribe_page((ROOT / "evals/fixtures/m1-vision.png").read_bytes(), mime="image/png")
    comparable = re.sub(r"[\s{}]", "", text).replace("²", "^2")
    if "x^2+1=0" not in comparable:
        raise ValueError("The page formula was not transcribed correctly.")
    return {}


async def embedding(gateway: LLMGateway):
    result = await gateway.embed(["Companion Space connection check"])
    if len(result.shape) != 2 or result.shape[0] != 1 or result.shape[1] < 1:
        raise ValueError("Expected one nonempty embedding")
    return {"dimensions": result.shape[1]}


async def voice(_):
    data = await preview_audio("你好，这是语音试听。", DEFAULT_VOICE)
    return {"bytes": len(data), "engine": "edge"}


async def evaluate(config: Path | Mapping[str, str | None]) -> int:
    env = dotenv_values(config, encoding="utf-8", interpolate=False) if isinstance(config, Path) else config
    output_root = (ROOT / "evals/out/data").resolve()
    data_dir = (output_root / uuid4().hex / "m1").resolve()
    if not data_dir.is_relative_to(output_root) or data_dir.is_relative_to((ROOT / "storage").resolve()):
        raise RuntimeError("Evaluation must use an isolated data directory.")
    settings = Settings(COMPANION_DATA_DIR=str(data_dir), _env_file=None)
    repository = SQLiteRepository(settings)
    vault = VaultService(settings, repository)
    vault.initialize(secrets.token_urlsafe(24))
    registry = ProviderRegistryService(repository, vault)
    gateway = LLMGateway(registry)
    actions = {"stream": latency, "tagged_latex": latex, "image_transcription": image,
               "embedding": embedding, "default_voice": voice}
    connections: dict[str, str] = {}
    assigned: dict[str, RoleAssignment] = {}
    results = {}

    try:
        for name, action in actions.items():
            role = ROLES.get(name)
            start = perf_counter()
            model = None
            try:
                if role is not None:
                    model_variable = f"EVAL_MODEL_{role.upper()}"
                    model = env.get(model_variable) or ""
                    second = model.endswith("@2")
                    prefix = "EVAL2" if second else "EVAL"
                    base_variable, key_variable = f"{prefix}_BASE_URL", f"{prefix}_API_KEY"
                    missing = [variable for variable in (model_variable, base_variable, key_variable) if not env.get(variable)]
                    if missing:
                        results[name] = {"status": "unverified", "missing": missing}
                        continue
                    if prefix not in connections:
                        connection = await asyncio.to_thread(
                            registry.save_connection,
                            provider="openai-compatible", label=f"Smoke {prefix}",
                            base_url=env[base_variable], api_key=env[key_variable],
                        )
                        connections[prefix] = connection["id"]
                    model = model.removesuffix("@2")
                    params = json.loads(env.get(f"EVAL_EXTRA_BODY_{role.upper()}") or "{}")
                    binding = RoleAssignment(connection_id=connections[prefix], model=model, params=params)
                    candidate = {**assigned, role: binding}
                    await asyncio.to_thread(registry.set_roles, candidate)
                    assigned = candidate
                evidence = await action(gateway)
                results[name] = {"status": "passed", **evidence}
            except (ProviderError, ValueError, RuntimeError, OSError) as exc:
                code = provider_error_payload(exc)["code"] if isinstance(exc, ProviderError) else type(exc).__name__
                results[name] = {"status": "failed", "code": code}
            results[name]["elapsed_ms"] = round((perf_counter() - start) * 1000)
            if model:
                results[name]["model"] = model
    finally:
        await registry.aclose()
    output = {"checks": results, "usage": [row.model_dump() for row in list_usage(repository)]}
    print(json.dumps(output, indent=2, ensure_ascii=False))
    return int(any(result["status"] == "failed" for result in results.values()))


if __name__ == "__main__":
    env_file = ROOT / ".env.eval"
    if not env_file.is_file():
        report = {name: {"status": "unverified", "missing": [".env.eval"]} for name in CHECKS}
        print(json.dumps(report, indent=2))
    else:
        raise SystemExit(asyncio.run(evaluate(env_file)))
