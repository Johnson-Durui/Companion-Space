"""Run isolated M2 course parsing and real-model evaluation from the repository root."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from fractions import Fraction
from graphlib import CycleError, TopologicalSorter
from pathlib import Path
from uuid import uuid4

from dotenv import dotenv_values

from app.analysis.documents import PAGE_MARKER, decode_text_bytes, validate_upload
from app.analysis.item_verifier import ItemVerifier
from app.analysis.model_analysis import normalize_name
from app.analysis.models import CourseInput, MaterialMetadata
from app.analysis.results import CourseResults
from app.api.deps import build_container
from app.core.config import Settings
from app.llm.presets import RoleAssignment
from app.llm.usage import list_usage
from app.services.jobs import TERMINAL_STATUSES, get_job

ROOT = Path(__file__).resolve().parents[1]
GOLD = ROOT / "evals/gold"
OUTPUT = ROOT / "evals/out"
SAMPLES = ROOT / "content/sample-course"
HOLDOUTS = ROOT / "content/eval-holdout"
MINIMUMS = {"kp_recall": 0.85, "edge_recall": 0.70, "answer_accuracy": 0.95, "item_map_recall": 0.80}
MAXIMUMS = {"extra_kp_ratio": 0.30}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def comparable(text: str) -> str:
    return re.sub(r"\s+", "", PAGE_MARKER.sub("", text))


def answer_key(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).strip().casefold()
    text = re.sub(r"^\\(?:\(|\[)|\\(?:\)|\])$", "", text.strip())
    text = re.sub(r"\\(?:d?frac|tfrac)\s*\{([^}]+)\}\s*\{([^}]+)\}", r"\1/\2", text)
    text = re.sub(r"[\s$，,；;：:]", "", text)
    if re.fullmatch(r"[+-]?\d+(?:\.\d+)?(?:/[+-]?\d+)?", text):
        try:
            return str(Fraction(text))
        except (ValueError, ZeroDivisionError):
            return text
    return text.rstrip("。.")


def answers_match(expected: str, actual: str) -> bool:
    expected_key, actual_key = answer_key(expected), answer_key(actual)
    if expected_key == actual_key:
        return True
    if len(expected_key) >= 4 and expected_key in actual_key:
        return True
    if len(expected_key) < 8 or len(actual_key) < 8:
        return False
    expected_bigrams = {expected_key[index:index + 2] for index in range(len(expected_key) - 1)}
    actual_bigrams = {actual_key[index:index + 2] for index in range(len(actual_key) - 1)}
    return len(expected_bigrams & actual_bigrams) / len(expected_bigrams) >= 0.5


def score(course_dir: Path, points: list[dict], items: list[dict], filenames: dict[str, str]) -> dict:
    directory = GOLD / course_dir.name
    expected = read_json(directory / "expected_kps.json")["knowledge_points"]
    allowed = {normalize_name(name) for row in expected for name in row.get("acceptable_extra", [])}
    aliases = {
        normalize_name(name): row["id"]
        for row in expected for name in (row["name"], *row.get("aliases", []))
    }
    match = {point["id"]: aliases.get(normalize_name(point["name"])) for point in points}
    recalled = len(set(match.values()) - {None})
    extra = sum(not match[point["id"]] and normalize_name(point["name"]) not in allowed for point in points)
    actual_edges = {
        (match.get(parent), match.get(point["id"]))
        for point in points for parent in point["prerequisite_ids"]
    }
    gold_edges = read_json(directory / "expected_edges.json")["edges"]
    edge_hits = sum((edge["prerequisite"], edge["dependent"]) in actual_edges for edge in gold_edges)
    try:
        list(TopologicalSorter({p["id"]: set(p["prerequisite_ids"]) for p in points}).static_order())
        acyclic = True
    except CycleError:
        acyclic = False

    papers = read_json(directory / "expected_items.json")["papers"]
    mappings = read_json(directory / "item_kp.json")["mappings"]
    expected_items = {(paper["paper_id"], row["no"]): row for paper in papers for row in paper["items"]}
    actual_items = {(filenames[item["material_id"]], item["no"]): item for item in items}
    matching = [(gold, actual_items.get(key)) for key, gold in expected_items.items()]
    checked_answers = [(gold, actual) for gold, actual in matching if gold.get("answer")]
    answer_hits = sum(
        actual is not None and answers_match(gold["answer"], actual.get("answer") or "")
        for gold, actual in checked_answers
    )
    item_hits = sum(
        actual is not None and bool(set(mappings[gold["id"]]) & {match.get(kp) for kp in actual["kp_ids"]})
        for gold, actual in matching if gold["id"] in mappings
    )
    metrics = {
        "kp_recall": recalled / len(expected),
        "extra_kp_ratio": extra / max(1, len(points)),
        "edge_recall": edge_hits / max(1, len(gold_edges)),
        "acyclic": acyclic,
        "item_count_matches": len(items) == len(expected_items) and actual_items.keys() == expected_items.keys(),
        "answer_accuracy": answer_hits / max(1, len(checked_answers)),
        "item_map_recall": item_hits / max(1, len(mappings)),
    }
    metrics["passes_thresholds"] = (
        acyclic and metrics["item_count_matches"]
        and all(metrics[name] >= minimum for name, minimum in MINIMUMS.items())
        and all(metrics[name] <= maximum for name, maximum in MAXIMUMS.items())
    )
    return metrics


def settings_for_run() -> Settings:
    output_data = (OUTPUT / "data").resolve()
    directory = (output_data / uuid4().hex / "m2").resolve()
    if not directory.is_relative_to(output_data) or directory.is_relative_to((ROOT / "storage").resolve()):
        raise RuntimeError("Evaluation must use an isolated data directory.")
    return Settings(COMPANION_DATA_DIR=str(directory), _env_file=None)


def configure(container, env: dict) -> dict[str, str]:
    connections = {}
    assigned = {}
    for role in ("analysis", "checker", "vision", "embedding"):
        model = env.get(f"EVAL_MODEL_{role.upper()}") or ""
        if not model:
            continue
        prefix = "EVAL2" if model.endswith("@2") else "EVAL"
        if not (env.get(f"{prefix}_BASE_URL") and env.get(f"{prefix}_API_KEY")):
            raise ValueError(f"Incomplete {prefix} connection configuration.")
        if prefix not in connections:
            connection = container.providers.save_connection(
                provider="openai-compatible", label=prefix,
                base_url=env[f"{prefix}_BASE_URL"], api_key=env[f"{prefix}_API_KEY"],
            )
            connections[prefix] = connection["id"]
        assigned[role] = RoleAssignment(
            connection_id=connections[prefix], model=model.removesuffix("@2"),
            params=json.loads(env.get(f"EVAL_EXTRA_BODY_{role.upper()}") or "{}"),
        )
    if "analysis" not in assigned:
        raise ValueError("Configure EVAL_MODEL_ANALYSIS before starting evaluation.")
    container.providers.set_roles(assigned)
    return {role: binding.model for role, binding in assigned.items()}


async def run_course(container, directory: Path, *, parse_only: bool) -> dict:
    data = container.analysis.data
    course = data.create_course(CourseInput(name=directory.name))
    expected = read_json(GOLD / directory.name / "expected_items.json")["papers"]
    years = {p["paper_id"]: p["year"] for p in expected}
    originals = {}
    names = {}
    for path in sorted(directory.glob("*.md")):
        raw = path.read_bytes()
        sample, count = validate_upload(
            path.name, raw, container.settings.max_document_size_bytes, container.settings.max_pdf_pages,
        )
        exam = path.stem in years
        metadata = MaterialMetadata(
            role="exam" if exam else "textbook", year=years.get(path.stem), has_answers=exam,
        )
        material, = data.store_uploads(course.id, [(path.name, raw, metadata, sample, count)])
        originals[material.id] = decode_text_bytes(raw)
        names[material.id] = path.stem

    async def process():
        job = await container.jobs.submit("parse", space_id=course.id, payload={"parse_only": parse_only})
        while True:
            current = await asyncio.to_thread(get_job, container.repository, job.id)
            if current.status in TERMINAL_STATUSES:
                return current
            await asyncio.sleep(0.2)

    result = await process()
    if result.status == "failed":
        return {"status": "failed", "stage": result.stage, "error": result.error}
    evidence = {}
    for material_id, original in originals.items():
        parsed = data.pages(course.id, material_id)
        expected_pages = list(PAGE_MARKER.finditer(original))
        boundaries = [0, *(marker.start() for marker in expected_pages[1:]), len(original)]
        expected_by_page = [original[start:end] for start, end in zip(boundaries, boundaries[1:])]
        evidence[names[material_id]] = {
            "pages": len(parsed),
            "complete": comparable(original) == comparable("".join(page["markdown"] for page in parsed)),
            "explicit_pages_complete": (
                not expected_pages or len(parsed) == len(expected_by_page)
                and all(comparable(ref) == comparable(page["markdown"]) for ref, page in zip(expected_by_page, parsed))
            ),
        }
    if parse_only:
        passed = all(item["complete"] and item["explicit_pages_complete"] for item in evidence.values())
        return {"status": "passed" if passed else "failed", "extracted_pages": evidence}
    results = CourseResults(data)
    points = [point for point in results.points(course.id) if point["status"] == "active"]
    with container.repository.connection() as conn:
        from app.analysis.results import _item_rows
        items = _item_rows(conn, course.id)
    metrics = score(directory, points, items, names)
    course_map = results.course_map(course.id)
    metrics["answer_verification_counts"] = dict(Counter(item["answer_status"] for item in items))
    calls_before = sum(row.calls for row in list_usage(container.repository))
    if directory.parent == SAMPLES:
        rerun = await process()
        calls_after = sum(row.calls for row in list_usage(container.repository))
        metrics["rerun_cache_only"] = (
            rerun.status == "completed" and rerun.tokens_in == rerun.tokens_out == 0 and calls_before == calls_after
        )
    verification_complete = "item_verification_incomplete" not in course_map.warnings
    thresholds_pass = metrics["passes_thresholds"] and metrics.get("rerun_cache_only", True)
    return {
        "status": "passed" if thresholds_pass and verification_complete else "failed" if verification_complete else "unverified",
        "metrics": metrics, "input_tokens": result.tokens_in, "output_tokens": result.tokens_out,
        "warnings": course_map.warnings,
    }


async def verify_reference_answers(container) -> dict:
    items = read_json(GOLD / "verifier/items.json")["items"]
    verifier = ItemVerifier(container.gateway)
    flagged = false_alarms = 0
    measured_wrong = measured_correct = 0
    warnings = []
    for item in items:
        result = await verifier.verify({**item, "answer": item["reference_answer"]})
        if result.get("warnings"):
            warnings.append({"item_id": item["id"], "warnings": result["warnings"]})
            continue
        if item["reference_is_intentionally_wrong"]:
            measured_wrong += 1
            flagged += result["status"] != "verified"
        else:
            measured_correct += 1
            false_alarms += result["status"] != "verified"
    detection = flagged / max(1, measured_wrong)
    false_alarm_rate = false_alarms / max(1, measured_correct)
    complete = measured_wrong + measured_correct == len(items)
    return {
        "status": (
            "passed" if complete and detection >= 0.90 and false_alarm_rate <= 0.15
            else "failed" if complete else "unverified"
        ),
        "wrong_reference_detection": detection, "correct_reference_false_alarm_rate": false_alarm_rate,
        "measured": measured_wrong + measured_correct, "expected": len(items), "warnings": warnings,
    }


def persist_report(
    report: dict, *, holdout: bool, parse_only: bool, path: Path | None = None,
) -> Path:
    mode = "holdout" if holdout else "parse" if parse_only else "sample"
    if path is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = OUTPUT / f"m2-{mode}-{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    report["report_file"] = str(path.relative_to(ROOT))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return path


async def evaluate(*, parse_only: bool, holdout: bool, env: dict) -> dict:
    container = build_container(settings_for_run())
    report = {}
    try:
        if not parse_only:
            # Isolated vault; credentials are only passed through the normal encrypted connection API.
            import secrets

            container.vault.initialize(secrets.token_urlsafe(24))
            report["models"] = configure(container, env)
        await container.jobs.start()
        directory = HOLDOUTS if holdout else SAMPLES
        report["holdout" if holdout else "samples"] = {}
        group = report["holdout" if holdout else "samples"]
        report_path = persist_report(report, holdout=holdout, parse_only=parse_only)
        for course in sorted(path for path in directory.iterdir() if path.is_dir()):
            if holdout:
                lock = OUTPUT / f"holdout-{course.name}.attempted"
                with lock.open("x", encoding="utf-8") as stream:
                    stream.write(container.settings.storage_root.name + "\n")
            group[course.name] = await run_course(container, course, parse_only=parse_only)
            persist_report(report, holdout=holdout, parse_only=parse_only, path=report_path)
        if not holdout and not parse_only:
            report["verifier"] = await verify_reference_answers(container)
            persist_report(report, holdout=holdout, parse_only=parse_only, path=report_path)
        report["usage"] = [row.model_dump() for row in list_usage(container.repository)]
        persist_report(report, holdout=holdout, parse_only=parse_only, path=report_path)
    finally:
        await container.aclose()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--parse-only", action="store_true", help="Check sample pages without model credentials.")
    mode.add_argument("--holdout", action="store_true", help="Run the frozen held-out course exactly once.")
    args = parser.parse_args()
    env_path = ROOT / ".env.eval"
    if not args.parse_only and not env_path.is_file():
        print(json.dumps({"status": "unverified", "missing": ".env.eval"}))
        return 0
    env = dotenv_values(env_path, encoding="utf-8", interpolate=False) if env_path.is_file() else {}
    report = asyncio.run(evaluate(parse_only=args.parse_only, holdout=args.holdout, env=env))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    group = report.get("holdout") or report.get("samples") or {}
    return int(any(item["status"] != "passed" for item in group.values())
               or ("verifier" in report and report["verifier"].get("status") != "passed"))


if __name__ == "__main__":
    raise SystemExit(main())
