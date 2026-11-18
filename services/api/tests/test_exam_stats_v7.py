from math import exp

import pytest

from app.analysis.course_analysis import reserve_latest_paper
from app.analysis.exam_stats import exam_statistics


def test_exam_score_and_recency_use_course_years_and_split_by_mapping():
    papers = [
        {"id": f"{year}-{letter}", "year": year, "full_score": 20}
        for year in (2021, 2022, 2023) for letter in ("a", "b")
    ]
    points = [{"id": "p", "importance": "core"}, {"id": "q", "importance": "important"}]
    items = []
    for paper in papers:
        common = {"paper_id": paper["id"], "score": 10}
        items.extend([
            {**common, "id": f"{paper['id']}-1", "kp_ids": ["p", "q"], "type": "choice"},
            {**common, "id": f"{paper['id']}-2",
             "kp_ids": ["p"] if paper["year"] == 2023 else ["q"],
             "type": "numeric" if paper["year"] == 2023 else "choice"},
        ])
    result = exam_statistics(points, papers, items)
    first, second = result["p"], result["q"]
    assert first["score_share"] == pytest.approx((4 * 0.25 + 2 * 0.75) / 6)
    assert first["recency_weight"] == pytest.approx(2 * exp(-0.70) + 2 * exp(-0.35) + 4)
    assert first["n_items"] == 8
    assert first["trend"] == "rising"
    assert second["trend"] == "falling"
    assert first["novel_flags"] == ["numeric"]
    expected = (0.25 * exp(-0.70) + 0.25 * exp(-0.35) + 0.75) / (exp(-0.70) + exp(-0.35) + 1)
    assert first["weight"] == pytest.approx(0.7 * expected + 0.3 * (1 / 1.6))
    assert first["weight"] + second["weight"] == pytest.approx(1.0)


@pytest.mark.parametrize("count", [1, 2, 3])
def test_complete_exam_reservation_requires_three_papers(count):
    papers = [{"id": str(year), "year": year} for year in range(2021, 2021 + count)]
    reserved = reserve_latest_paper(papers)
    assert reserved == ({"2023"} if count == 3 else set())
    assert {p["id"] for p in papers if p["reserved_for_mock"]} == reserved
