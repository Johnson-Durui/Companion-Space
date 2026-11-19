from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from evals import analysis_eval


class _Verifier:
    decisions: dict[str, dict] = {}

    def __init__(self, _gateway) -> None:
        pass

    async def verify(self, item: dict) -> dict:
        return self.decisions[item["id"]]


def test_verifier_report_does_not_grade_provider_format_failures(monkeypatch):
    items = [
        {"id": "correct", "reference_answer": "A", "reference_is_intentionally_wrong": False},
        {"id": "wrong", "reference_answer": "B", "reference_is_intentionally_wrong": True},
        {"id": "format", "reference_answer": "C", "reference_is_intentionally_wrong": True},
    ]
    _Verifier.decisions = {
        "correct": {"status": "verified"},
        "wrong": {"status": "disputed"},
        "format": {"status": "unverified", "warnings": ["provider_output_invalid"]},
    }
    monkeypatch.setattr(analysis_eval, "ItemVerifier", _Verifier)
    monkeypatch.setattr(analysis_eval, "read_json", lambda _path: {"items": items})

    report = asyncio.run(analysis_eval.verify_reference_answers(SimpleNamespace(gateway=object())))

    assert report["status"] == "unverified"
    assert report["measured"] == 2
    assert report["wrong_reference_detection"] == 1
    assert report["correct_reference_false_alarm_rate"] == 0
    assert report["warnings"] == [{"item_id": "format", "warnings": ["provider_output_invalid"]}]


def test_persist_report_is_atomic_and_records_its_path(tmp_path, monkeypatch):
    monkeypatch.setattr(analysis_eval, "ROOT", tmp_path)
    monkeypatch.setattr(analysis_eval, "OUTPUT", tmp_path / "evals" / "out")
    report = {"samples": {}}

    path = analysis_eval.persist_report(report, holdout=False, parse_only=False)

    assert path.is_file()
    assert not path.with_suffix(".tmp").exists()
    assert json.loads(path.read_text(encoding="utf-8"))["report_file"] == report["report_file"]

    report["samples"]["course"] = {"status": "failed"}
    same_path = analysis_eval.persist_report(
        report, holdout=False, parse_only=False, path=path,
    )
    assert same_path == path
    assert json.loads(path.read_text(encoding="utf-8"))["samples"]["course"]["status"] == "failed"


def test_answer_matching_normalizes_latex_and_accepts_supported_paraphrase():
    assert analysis_eval.answers_match("0.75", r"\(0.75\)")
    assert analysis_eval.answers_match("1-(1-p)^n", r"补事件更简单；概率为 \(1-(1-p)^n\)。")
    assert analysis_eval.answers_match(
        "互斥描述不能同时发生，独立描述概率不受另一事件影响",
        "互斥指不能同时发生；独立指一事件是否发生不改变另一事件的概率。",
    )
    assert not analysis_eval.answers_match("0.75", r"\(0.25\)")
