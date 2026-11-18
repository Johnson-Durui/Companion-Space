"""Measure real-model slot extraction against the original interview fixture."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from pathlib import Path

from dotenv import dotenv_values

from app.api.deps import build_container
from app.learning.interview import allowed_fields, extract_slots
from app.providers.errors import ProviderError
from evals.analysis_eval import ROOT, configure, settings_for_run
from evals.record_sample import _live_settings


async def evaluate(env: dict) -> dict:
    required = ("EVAL_BASE_URL", "EVAL_API_KEY", "EVAL_MODEL_LIVE")
    missing = [key for key in required if not env.get(key)]
    if missing:
        return {"status": "unverified", "missing": missing}
    cases = json.loads((ROOT / "evals/gold/interview/cases.json").read_text(encoding="utf-8"))
    scopes = {"course_units": [
        {"id": "probability", "title": "概率"}, {"id": "functions", "title": "函数"},
        {"id": "u3", "title": "第三章"}, {"id": "u5", "title": "第五章"},
    ]}
    container = build_container(settings_for_run())
    concurrency = asyncio.Semaphore(4)
    by_topic = defaultdict(lambda: {"correct": 0, "expected": 0, "errors": 0, "extra": 0})
    failures: list[dict] = []

    async def one(index: int, case: dict) -> None:
        topic, expected = case["topic"], case["expected"]
        score = by_topic[topic]
        score["expected"] += len(expected)
        try:
            async with concurrency:
                actual = await extract_slots(container.gateway, topic=topic, text=case["text"],
                                             context={"allowed_fields": allowed_fields(topic), **scopes})
        except (ValueError, ProviderError) as exc:
            score["errors"] += 1
            failures.append({"case": index, "topic": topic, "error": type(exc).__name__})
            return
        mismatches = {
            key: {"expected": value, "actual": actual.get(key)}
            for key, value in expected.items() if actual.get(key) != value
        }
        score["correct"] += len(expected) - len(mismatches)
        score["extra"] += len(actual.keys() - expected.keys())
        if mismatches or actual.keys() - expected.keys():
            failures.append({
                "case": index, "topic": topic, "text": case["text"],
                "mismatches": mismatches,
                "extra": {key: actual[key] for key in actual.keys() - expected.keys()},
            })

    try:
        container.vault.bootstrap()
        configure(container, {"EVAL_MODEL_ANALYSIS": env["EVAL_MODEL_LIVE"], **env})
        model = _live_settings(container, env)
        await asyncio.gather(*(one(index, case) for index, case in enumerate(cases, 1)))
    finally:
        await container.aclose()
    expected = sum(score["expected"] for score in by_topic.values())
    correct = sum(score["correct"] for score in by_topic.values())
    errors = sum(score["errors"] for score in by_topic.values())
    accuracy = correct / max(1, expected)
    return {"status": "passed" if accuracy >= 0.90 and not errors else "failed", "model": model,
            "cases": len(cases), "slot_accuracy": accuracy, "by_topic": dict(by_topic),
            "failures": sorted(failures, key=lambda failure: failure["case"])}


def main() -> int:
    path: Path = ROOT / ".env.eval"
    env = dotenv_values(path, encoding="utf-8", interpolate=False) if path.is_file() else {}
    report = asyncio.run(evaluate(env))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(report["status"] == "failed")


if __name__ == "__main__":
    raise SystemExit(main())
