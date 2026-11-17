from __future__ import annotations

from collections import Counter, defaultdict
from math import exp
from statistics import mean

_PRIOR = {"core": 1.0, "important": 0.6, "peripheral": 0.3}


def exam_statistics(points: list[dict], papers: list[dict], items: list[dict]) -> dict[str, dict]:
    """Compute course-relative weights from mappings and actual exam papers."""
    if not points:
        return {}
    active = {point["id"]: point for point in points}
    by_paper = defaultdict(list)
    parent_ids = {item.get("parent_item_id") for item in items}
    for item in items:
        if item.get("paper_id") and item["id"] not in parent_ids:
            by_paper[item["paper_id"]].append(item)
    papers = [paper for paper in papers if by_paper[paper["id"]]]
    years = sorted({paper["year"] for paper in papers if paper["year"] is not None})
    latest = years[-1] if years else 0
    shares = defaultdict(dict)
    recency = Counter()
    kinds = defaultdict(Counter)
    known_kinds = defaultdict(lambda: defaultdict(set))
    paper_weights = {}
    for paper in papers:
        paper_id = paper["id"]
        year = paper["year"]
        effective_year = latest - 3 if year is None and years else (year or latest)
        paper_weights[paper_id] = exp(-0.35 * (latest - effective_year))
        questions = by_paper[paper_id]
        has_scores = all(item.get("score") is not None for item in questions)
        denominator = (paper.get("full_score") or sum(item["score"] for item in questions)) if has_scores else 0
        for item in questions:
            links = set(item["kp_ids"]) & active.keys()
            if not links:
                continue
            fraction = item["score"] / denominator if denominator else 1 / len(questions)
            for kp_id in links:
                shares[kp_id][paper_id] = shares[kp_id].get(paper_id, 0) + fraction / len(links)
                recency[kp_id] += paper_weights[paper_id]
                kinds[kp_id][item["type"]] += 1
                if year is not None:
                    known_kinds[kp_id][year].add(item["type"])

    weighted = {
        kp_id: sum(share * paper_weights[paper_id] for paper_id, share in shares[kp_id].items())
        for kp_id in active
    }
    total_weighted = sum(weighted.values())
    priors = {kp_id: _PRIOR[point["importance"]] for kp_id, point in active.items()}
    total_prior = sum(priors.values())
    result = {}
    for kp_id in active:
        prior = priors[kp_id] / total_prior
        weight = 0.7 * weighted[kp_id] / total_weighted + 0.3 * prior if total_weighted else prior
        trend = "unknown"
        if len(years) >= 3:
            by_year = [
                mean(shares[kp_id].get(paper["id"], 0) for paper in papers if paper["year"] == year)
                for year in years
            ]
            midpoint = mean(years)
            slope = sum((year - midpoint) * value for year, value in zip(years, by_year, strict=True))
            slope /= sum((year - midpoint) ** 2 for year in years)
            trend = "rising" if slope > 0.005 else "falling" if slope < -0.005 else "stable"
        earlier = set().union(*(known_kinds[kp_id][year] for year in years[:-1]))
        result[kp_id] = {
            "n_items": sum(kinds[kp_id].values()),
            "score_share": sum(shares[kp_id].values()) / len(papers) if papers else 0.0,
            "recency_weight": recency[kp_id],
            "trend": trend,
            "types": dict(kinds[kp_id]),
            "novel_flags": sorted(known_kinds[kp_id][latest] - earlier) if len(years) > 1 else [],
            "weight": weight,
        }
    return result
