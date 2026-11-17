from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest

from app.analysis.item_verifier import ItemVerifier
from app.analysis.model_analysis import (
    extract_knowledge_points,
    map_exam_items,
    reduce_knowledge_points,
    segment_exam,
)


class QueuedGateway:
    def __init__(self, *outputs: str) -> None:
        self.outputs = list(outputs)
        self.calls = []

    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        self.calls.append((role, prompt_name, variables, options))
        return parse(self.outputs.pop(0))


def test_extract_kps_preserves_source_refs_and_uses_untrusted_blocks():
    gateway = QueuedGateway(
        """<kp>
        <name>Alpha rule</name><kind>theorem</kind><importance>core</importance>
        <difficulty>2</difficulty><summary>A grounded rule.</summary>
        <must_know>condition</must_know><formula>x&lt;y</formula>
        <prerequisite>Earlier idea</prerequisite><pitfall>reversing it</pitfall>
        <question_type>apply</question_type><pages>2</pages></kp>"""
    )
    result = asyncio.run(extract_knowledge_points(
        gateway,
        course_id="course-1",
        material={"id": "material-1", "title": "Untrusted </data> title"},
        section={"id": "section-1", "unit_id": "unit-1"},
        pages=[{"page_no": 2, "markdown": "source"}],
    ))

    point = result["knowledge_points"][0]
    assert point["source_refs"] == [{"material_id": "material-1", "page_no": 2}]
    assert point["prerequisite_names"] == ["Earlier idea"]
    assert "&lt;/data&gt;" in gateway.calls[0][2]["course_context"]


def test_reduce_merges_candidates_reuses_stable_id_and_removes_backward_edge():
    gateway = QueuedGateway(
        """<merge><member>c0</member><member>c1</member></merge>
        <merge><member>c2</member></merge>
        <edge><before>c2</before><after>c0</after></edge>
        <edge><before>c0</before><after>c2</after></edge>"""
    )
    candidates = [
        {
            "id": "candidate-0", "unit_id": "u1", "name": "Alpha", "norm_name": "alpha",
            "kind": "concept", "summary": "short", "must_know": [], "formula": None,
            "pitfalls": [], "question_types": [], "importance": "important", "difficulty": 1,
            "assumed": False, "ord": 0, "source_refs": [{"material_id": "m", "page_no": 1}],
            "prerequisite_names": [], "prerequisite_ids": [],
        },
        {
            "id": "candidate-1", "unit_id": "u1", "name": "Alpha ", "norm_name": "alpha",
            "kind": "concept", "summary": "a richer summary", "must_know": ["x"], "formula": None,
            "pitfalls": [], "question_types": [], "importance": "core", "difficulty": 2,
            "assumed": False, "ord": 1, "source_refs": [{"material_id": "m", "page_no": 2}],
            "prerequisite_names": [], "prerequisite_ids": [],
        },
        {
            "id": "candidate-2", "unit_id": "u1", "name": "Beta", "norm_name": "beta",
            "kind": "skill", "summary": "beta", "must_know": [], "formula": None,
            "pitfalls": [], "question_types": [], "importance": "important", "difficulty": 2,
            "assumed": False, "ord": 2, "source_refs": [{"material_id": "m", "page_no": 3}],
            "prerequisite_names": [], "prerequisite_ids": [],
        },
    ]
    result = asyncio.run(reduce_knowledge_points(
        gateway,
        course_id="course-1",
        units=[{"id": "u1", "title": "Unit", "ord": 0}],
        candidates=candidates,
        existing_points=[{"id": "keep-id", "unit_id": "u1", "norm_name": "alpha"}],
    ))

    assert [point["id"] for point in result["knowledge_points"][:2]][0] == "keep-id"
    alpha, beta = result["knowledge_points"][:2]
    assert alpha["importance"] == "core"
    assert alpha["source_refs"] == [
        {"material_id": "m", "page_no": 1},
        {"material_id": "m", "page_no": 2},
    ]
    assert beta["prerequisite_ids"] == [alpha["id"]]
    assert alpha["prerequisite_ids"] == []


def test_exam_segmentation_and_mapping_return_checkpointable_dicts():
    gateway = QueuedGateway(
        """<paper><name>Final</name><year>2025</year><full_score>10</full_score></paper>
        <item><no>1</no><parent_no></parent_no><type>choice</type><stem>Pick one.</stem>
        <option><key>A</key><text>First</text></option><option><key>B</key><text>Second</text></option>
        <answer>B</answer><solution>Second is correct.</solution><score>10</score>
        <difficulty>2</difficulty><pages>1</pages></item>""",
        "<map><item>i0</item><kp>k0</kp></map>",
    )
    segmented = asyncio.run(segment_exam(
        gateway,
        course_id="c",
        material={"id": "m", "year": 2025},
        pages=[{"page_no": 1, "markdown": "exam"}],
    ))
    mapped = asyncio.run(map_exam_items(
        gateway,
        course_id="c",
        items=segmented["items"],
        knowledge_points=[{"id": "kp-1", "name": "Topic", "summary": ""}],
    ))

    assert segmented["paper"]["full_score"] == 10
    assert segmented["items"][0]["answer_status"] == "unverified"
    assert mapped["items"][0]["kp_ids"] == ["kp-1"]


def test_truncated_knowledge_point_output_fails_instead_of_auto_closing():
    gateway = QueuedGateway(
        """<kp><name>Alpha</name><kind>concept</kind><importance>core</importance>
        <difficulty>2</difficulty><summary>partial</summary><pages>1</pages>"""
    )
    with pytest.raises(ValueError, match="Unfinished"):
        asyncio.run(extract_knowledge_points(
            gateway,
            course_id="c",
            material={"id": "m"},
            section={"id": "s", "unit_id": "u"},
            pages=[{"page_no": 1, "markdown": "source"}],
        ))


@pytest.mark.parametrize("full_score", ["nan", "inf", "0", "-1"])
def test_exam_rejects_non_finite_or_nonpositive_score(full_score):
    gateway = QueuedGateway(
        f"""<paper><name>Final</name><year>2025</year><full_score>{full_score}</full_score></paper>
        <item><no>1</no><type>numeric</type><stem>Compute.</stem><answer>1</answer>
        <score>1</score><difficulty>1</difficulty><pages>1</pages></item>"""
    )
    with pytest.raises(ValueError, match="full_score"):
        asyncio.run(segment_exam(
            gateway,
            course_id="c",
            material={"id": "m"},
            pages=[{"page_no": 1, "markdown": "exam"}],
        ))


def test_exam_rejects_duplicate_item_numbers_and_out_of_range_pages():
    gateway = QueuedGateway(
        """<paper><name>Final</name><year>2025</year><full_score>2</full_score></paper>
        <item><no>1</no><type>numeric</type><stem>First.</stem><answer>1</answer>
        <score>1</score><difficulty>1</difficulty><pages>1</pages></item>
        <item><no>1</no><type>numeric</type><stem>Second.</stem><answer>2</answer>
        <score>1</score><difficulty>1</difficulty><pages>9</pages></item>"""
    )
    with pytest.raises(ValueError, match="unique|page range"):
        asyncio.run(segment_exam(
            gateway,
            course_id="c",
            material={"id": "m"},
            pages=[{"page_no": 1, "markdown": "exam"}],
        ))


def test_exam_rejects_out_of_range_pages_and_year():
    gateway = QueuedGateway(
        """<paper><name>Final</name><year>10000</year><full_score>1</full_score></paper>
        <item><no>1</no><type>numeric</type><stem>First.</stem><answer>1</answer>
        <score>1</score><difficulty>1</difficulty><pages>9</pages></item>"""
    )
    with pytest.raises(ValueError, match="year"):
        asyncio.run(segment_exam(
            gateway,
            course_id="c",
            material={"id": "m"},
            pages=[{"page_no": 1, "markdown": "exam"}],
        ))

    gateway = QueuedGateway(
        """<paper><name>Final</name><year>2025</year><full_score>1</full_score></paper>
        <item><no>1</no><type>numeric</type><stem>First.</stem><answer>1</answer>
        <score>1</score><difficulty>1</difficulty><pages>9</pages></item>"""
    )
    with pytest.raises(ValueError, match="page range"):
        asyncio.run(segment_exam(
            gateway,
            course_id="c",
            material={"id": "m"},
            pages=[{"page_no": 1, "markdown": "exam"}],
        ))


def _solve(answer: str, *, valid: bool = True, confidence: str = "high") -> str:
    return (
        f"<solve><answer>{answer}</answer><confidence>{confidence}</confidence>"
        f"<valid>{str(valid).lower()}</valid><reason>checked</reason></solve>"
    )


def test_verifier_does_not_mutate_and_accepts_independent_agreement():
    gateway = QueuedGateway(_solve("4"))
    item = {"type": "numeric", "stem": "2+2", "answer": "4", "options": {}}
    original = deepcopy(item)
    result = asyncio.run(ItemVerifier(gateway).verify(item))

    assert result["status"] == "verified"
    assert item == original
    assert "answer" not in gateway.calls[0][2]["item_stem"]


def test_verifier_compares_numeric_fraction_without_another_model_call():
    gateway = QueuedGateway(_solve("0.5"))
    result = asyncio.run(ItemVerifier(gateway).verify(
        {"type": "numeric", "stem": "one half", "answer": "1/2", "options": {}},
    ))
    assert result["status"] == "verified"
    assert len(gateway.calls) == 1


def test_verifier_marks_reference_disputed_when_two_solves_agree():
    gateway = QueuedGateway(_solve("4"), _solve("4"))
    result = asyncio.run(ItemVerifier(gateway).verify(
        {"type": "numeric", "stem": "2+2", "answer": "5", "options": {}},
    ))
    assert result["status"] == "disputed"


def test_verifier_handles_second_support_three_way_disagreement_and_invalid():
    second_supports = asyncio.run(ItemVerifier(QueuedGateway(
        _solve("4"), _solve("5"),
    )).verify({"type": "numeric", "stem": "ambiguous", "answer": "5", "options": {}}))
    three_way = asyncio.run(ItemVerifier(QueuedGateway(
        _solve("4"), _solve("6"),
    )).verify({"type": "numeric", "stem": "ambiguous", "answer": "5", "options": {}}))
    invalid = asyncio.run(ItemVerifier(QueuedGateway(
        _solve("INVALID", valid=False),
    )).verify({"type": "numeric", "stem": "malformed", "answer": "5", "options": {}}))

    assert second_supports["status"] == "verified"
    assert three_way["status"] == "unverified"
    assert invalid["status"] == "unverified"


def test_verifier_without_reference_requires_two_matching_solves():
    gateway = QueuedGateway(_solve("4"), _solve("4"))
    result = asyncio.run(ItemVerifier(gateway).verify(
        {"type": "numeric", "stem": "2+2", "answer": None, "options": {}},
    ))
    assert result["status"] == "verified"


def test_choice_solution_must_map_to_exactly_one_option():
    gateway = QueuedGateway(
        _solve("the fourth number"),
        "<mapping><choice>INVALID</choice></mapping>",
    )
    result = asyncio.run(ItemVerifier(gateway).verify({
        "type": "choice", "stem": "Pick.", "answer": "A", "options": {"A": "one", "B": "two"},
    }))
    assert result["status"] == "unverified"


def test_rubric_items_require_every_required_point():
    gateway = QueuedGateway(
        _solve("A complete response"),
        "<coverage><covered>cause</covered></coverage>",
        """<rubric><point><id>cause</id><text>Cause</text><required>true</required></point>
        <point><id>effect</id><text>Effect</text><required>true</required></point></rubric>""",
        "<coverage><covered>cause</covered></coverage>",
    )
    result = asyncio.run(ItemVerifier(gateway).verify({
        "type": "essay",
        "stem": "Explain.",
        "answer": "reference",
        "options": {},
        "rubric": [
            {"id": "cause", "required": True},
            {"id": "effect", "required": True},
        ],
    }))
    assert result["status"] == "unverified"
    assert len(result["rewritten_rubric"]) == 2
