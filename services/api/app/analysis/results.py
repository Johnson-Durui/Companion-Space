from __future__ import annotations

import json
from collections import defaultdict
from graphlib import CycleError, TopologicalSorter
from uuid import NAMESPACE_URL, uuid5

from app.analysis.course_data import CourseData, dumps
from app.analysis.exam_stats import exam_statistics
from app.analysis.models import CourseMap, CourseUnit, ExamItem, KnowledgePoint, PointUpdate
from app.core.errors import ResourceNotFoundError
from app.repositories.mixins.common import _to_db, utcnow


def _point_rows(conn, space_id: str) -> list[dict]:
    records = []
    edges = defaultdict(list)
    for row in conn.execute(
        "SELECT from_kp, to_kp FROM kp_edges WHERE space_id = ? ORDER BY from_kp", (space_id,),
    ):
        edges[row["to_kp"]].append(row["from_kp"])
    for row in conn.execute(
        "SELECT * FROM knowledge_points WHERE space_id = ? ORDER BY ord, id", (space_id,),
    ):
        point = dict(row)
        for field in ("must_know", "pitfalls", "question_types", "source_refs", "locked_fields"):
            point[field] = json.loads(point.pop(f"{field}_json") or "[]")
        point["prerequisite_ids"] = edges[point["id"]]
        records.append(point)
    return records


def _item_rows(conn, space_id: str) -> list[dict]:
    links = defaultdict(list)
    for row in conn.execute(
        """SELECT l.item_id, l.kp_id FROM item_kp l JOIN exam_items i ON i.id = l.item_id
           JOIN knowledge_points k ON k.id = l.kp_id AND k.space_id = i.space_id
           WHERE i.space_id = ? AND k.status = 'active' ORDER BY l.kp_id""", (space_id,),
    ):
        links[row["item_id"]].append(row["kp_id"])
    records = []
    for row in conn.execute(
        """SELECT i.*, p.name AS exam_name, p.year FROM exam_items i
           LEFT JOIN exam_papers p ON p.id = i.paper_id AND p.space_id = i.space_id
           WHERE i.space_id = ? ORDER BY p.year DESC, i.rowid""", (space_id,),
    ):
        item = dict(row)
        item["options"] = json.loads(item.pop("options_json") or "{}")
        item["page_refs"] = json.loads(item.pop("page_refs_json") or "[]")
        item["kp_ids"] = links[item["id"]]
        records.append(item)
    return records


def _stats(conn, space_id: str, points: list[dict], papers: list[dict], items: list[dict]) -> None:
    results = exam_statistics(points, papers, items)
    conn.execute("DELETE FROM kp_exam_stats WHERE space_id = ?", (space_id,))
    now = _to_db(utcnow())
    conn.executemany(
        """INSERT INTO kp_exam_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(key, space_id, item["n_items"], item["score_share"], item["recency_weight"], item["trend"],
          dumps(item["types"]), dumps(item["novel_flags"]), item["weight"], now) for key, item in results.items()],
    )


def _redirect(point_id: str, records: dict[str, dict]) -> str | None:
    visited = set()
    while point_id and point_id not in visited and point_id in records:
        point = records[point_id]
        if point.get("status", "active") == "active":
            return point_id
        visited.add(point_id)
        point_id = point.get("merged_into")
    return None


def _union_refs(*groups: list[dict]) -> list[dict]:
    return list({
        (ref["material_id"], ref["page_no"]): ref for group in groups for ref in group
    }.values())


def _set_edges(conn, space_id: str, points: dict[str, dict]) -> None:
    active = {key: row for key, row in points.items() if row["status"] == "active"}
    graph = {}
    for key, point in active.items():
        graph[key] = sorted({
            target for pred in point["prerequisite_ids"]
            if (target := _redirect(pred, points)) and target != key
        })
    try:
        list(TopologicalSorter(graph).static_order())
    except CycleError:
        raise ValueError("The prerequisite relationships would form a cycle.") from None
    conn.execute("DELETE FROM kp_edges WHERE space_id = ?", (space_id,))
    conn.executemany(
        "INSERT INTO kp_edges VALUES (?, ?, ?, ?)",
        [(space_id, pred, key, "owner" if "prerequisite_ids" in active[key]["locked_fields"] else "analysis")
         for key, deps in graph.items() for pred in deps],
    )


class CourseResults:
    def __init__(self, data: CourseData) -> None:
        self.data = data
        self.repository = data.repository

    def points(self, space_id: str) -> list[dict]:
        with self.repository.connection() as conn:
            return _point_rows(conn, space_id)

    def course_map(self, space_id: str) -> CourseMap:
        course = self.data.course(space_id)
        with self.repository.connection() as conn:
            conn.execute("BEGIN")
            point_rows = _point_rows(conn, space_id)
            unit_rows = conn.execute(
                "SELECT id, title FROM units WHERE space_id = ? ORDER BY ord, id", (space_id,),
            ).fetchall()
            stats = {}
            for row in conn.execute("SELECT * FROM kp_exam_stats WHERE space_id = ?", (space_id,)):
                stats[row["kp_id"]] = {
                    **dict(row), "types": json.loads(row["types_json"]), "novel_flags": json.loads(row["novel_json"]),
                }
            has_exams = bool(conn.execute("SELECT 1 FROM exam_papers WHERE space_id = ? LIMIT 1", (space_id,)).fetchone())
        by_unit = defaultdict(list)
        for point in point_rows:
            if point["status"] == "active":
                by_unit[point["unit_id"]].append(KnowledgePoint(**point, stats=stats.get(point["id"])))
        units = [
            CourseUnit(id=row["id"], title=row["title"], knowledge_points=by_unit[row["id"]])
            for row in unit_rows if by_unit[row["id"]]
        ]
        if by_unit[None]:
            units.append(CourseUnit(id="external", title="", knowledge_points=by_unit[None]))
        warnings = (course.brief or {}).get("warnings", [])
        return CourseMap(units=units, brief=course.brief, warnings=warnings, has_exams=has_exams)

    def exam_items(self, space_id: str, *, kp_id: str | None, unmapped: bool) -> list[ExamItem]:
        self.data.course(space_id)
        with self.repository.connection() as conn:
            records = _item_rows(conn, space_id)
        return [
            ExamItem.model_validate(item) for item in records
            if (kp_id is None or kp_id in item["kp_ids"]) and (not unmapped or not item["kp_ids"])
        ]

    def revise_point(self, space_id: str, point_id: str, input: PointUpdate) -> KnowledgePoint:
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            points = {row["id"]: row for row in _point_rows(conn, space_id)}
            point = points.get(point_id)
            if not point or point["status"] != "active":
                raise ResourceNotFoundError("Knowledge point not found")
            changes = input.model_dump(exclude_unset=True, exclude_none=True, exclude={"merge_into", "deleted"})
            if input.merge_into and input.deleted:
                raise ValueError("Choose either merge or delete.")
            if input.prerequisite_ids is not None and any(
                pred == point_id or pred not in points or points[pred]["status"] != "active"
                for pred in input.prerequisite_ids
            ):
                raise ValueError("Select prerequisites from other active points in the same course.")
            point.update(changes)
            point["locked_fields"] = sorted(set(point["locked_fields"]) | changes.keys())
            if input.merge_into:
                target = points.get(input.merge_into)
                if not target or target["status"] != "active" or target["id"] == point_id:
                    raise ResourceNotFoundError("Merge target not found")
                target["source_refs"] = _union_refs(target["source_refs"], point["source_refs"])
                conn.execute(
                    "UPDATE knowledge_points SET source_refs_json = ? WHERE space_id = ? AND id = ?",
                    (dumps(target["source_refs"]), space_id, target["id"]),
                )
                conn.execute(
                    """INSERT OR IGNORE INTO item_kp SELECT l.item_id, ?, l.confidence FROM item_kp l
                       JOIN exam_items i ON i.id = l.item_id WHERE i.space_id = ? AND l.kp_id = ?""",
                    (target["id"], space_id, point_id),
                )
                conn.execute(
                    "UPDATE item_bank SET kp_id = ? WHERE space_id = ? AND kp_id = ?",
                    (target["id"], space_id, point_id),
                )
                target["prerequisite_ids"] = sorted(set(target["prerequisite_ids"]) | set(point["prerequisite_ids"]))
                target["locked_fields"] = sorted(set(target["locked_fields"]) | {"prerequisite_ids"})
                conn.execute(
                    "UPDATE knowledge_points SET locked_fields_json = ? WHERE space_id = ? AND id = ?",
                    (dumps(target["locked_fields"]), space_id, target["id"]),
                )
                point.update(status="merged", merged_into=target["id"])
            elif input.deleted:
                point["status"] = "deleted"
                conn.execute("DELETE FROM item_bank WHERE space_id = ? AND kp_id = ?", (space_id, point_id))
            if point["status"] != "active":
                conn.execute(
                    """DELETE FROM item_kp WHERE kp_id = ? AND item_id IN
                       (SELECT id FROM exam_items WHERE space_id = ?)""", (point_id, space_id),
                )
            conn.execute(
                """UPDATE knowledge_points SET name = ?, importance = ?, locked_fields_json = ?,
                   status = ?, merged_into = ?, updated_at = ? WHERE space_id = ? AND id = ?""",
                (point["name"], point["importance"], dumps(point["locked_fields"]), point["status"],
                 point["merged_into"], _to_db(utcnow()), space_id, point_id),
            )
            _set_edges(conn, space_id, points)
            papers = [dict(row) for row in conn.execute("SELECT * FROM exam_papers WHERE space_id = ?", (space_id,))]
            _stats(conn, space_id, [p for p in points.values() if p["status"] == "active"], papers, _item_rows(conn, space_id))
        return KnowledgePoint.model_validate(point)

    def prepare_points(self, space_id: str, candidates: list[dict]) -> list[dict]:
        existing = {p["id"]: p for p in self.points(space_id)}
        reconciled = {}
        for new in candidates:
            point_id = new["id"]
            old = existing.get(point_id)
            if old and old["status"] in {"deleted", "merged"}:
                continue
            locked = old["locked_fields"] if old else []
            point = {**new, "locked_fields": locked, "status": "active", "merged_into": None}
            point.update({field: old[field] for field in locked})
            reconciled[point_id] = point
        for point_id, old in existing.items():
            if point_id not in reconciled:
                if old["status"] != "active":
                    reconciled[point_id] = old
                else:
                    reconciled[point_id] = {**old, "status": "active" if old["locked_fields"] else "archived"}
            if old["status"] == "merged" and old["merged_into"] in reconciled:
                target = reconciled[old["merged_into"]]
                target["source_refs"] = _union_refs(target["source_refs"], old["source_refs"])
        return list(reconciled.values())

    def save_analysis(
        self, space_id: str, units: list[dict], points: list[dict], papers: list[dict],
        items: list[dict], bank: list[dict], brief: dict,
    ) -> None:
        now = _to_db(utcnow())
        point_map = {point["id"]: point for point in points}
        active_points = [point for point in points if point["status"] == "active"]
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                """INSERT INTO units(id, space_id, title, ord) VALUES (?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET title = excluded.title, ord = excluded.ord
                   WHERE units.space_id = excluded.space_id""",
                [(unit["id"], space_id, unit["title"], unit["ord"]) for unit in units],
            )
            for p in points:
                conn.execute(
                    """INSERT INTO knowledge_points(
                        id, space_id, unit_id, name, norm_name, kind, summary, must_know_json, formula,
                        pitfalls_json, question_types_json, importance, difficulty, assumed, ord,
                        source_refs_json, locked_fields_json, status, merged_into, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET unit_id = excluded.unit_id, name = excluded.name,
                         norm_name = excluded.norm_name, kind = excluded.kind, summary = excluded.summary,
                         must_know_json = excluded.must_know_json, formula = excluded.formula,
                         pitfalls_json = excluded.pitfalls_json, question_types_json = excluded.question_types_json,
                         importance = excluded.importance, difficulty = excluded.difficulty, assumed = excluded.assumed,
                         ord = excluded.ord, source_refs_json = excluded.source_refs_json,
                         locked_fields_json = excluded.locked_fields_json, status = excluded.status,
                         merged_into = excluded.merged_into, updated_at = excluded.updated_at
                       WHERE knowledge_points.space_id = excluded.space_id""",
                    (p["id"], space_id, p.get("unit_id"), p["name"], p["norm_name"], p["kind"], p["summary"],
                     dumps(p.get("must_know", [])), p.get("formula"), dumps(p.get("pitfalls", [])),
                     dumps(p.get("question_types", [])), p["importance"], p["difficulty"], bool(p.get("assumed")),
                     p.get("ord", 0), dumps(p["source_refs"]), dumps(p["locked_fields"]), p["status"],
                     p["merged_into"], p.get("created_at", now), now),
                )
            _set_edges(conn, space_id, point_map)
            conn.execute("DELETE FROM item_bank WHERE space_id = ?", (space_id,))
            conn.execute("DELETE FROM exam_items WHERE space_id = ?", (space_id,))
            conn.execute("DELETE FROM exam_papers WHERE space_id = ?", (space_id,))
            conn.executemany(
                """INSERT INTO exam_papers(id, space_id, material_id, name, year, full_score, reserved_for_mock)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [(p["id"], space_id, p["material_id"], p["name"], p["year"], p.get("full_score"),
                  bool(p.get("reserved_for_mock"))) for p in papers],
            )
            for item in items:
                conn.execute(
                    """INSERT INTO exam_items(id, space_id, paper_id, material_id, no, type, stem,
                          options_json, answer, solution, score, difficulty, answer_status, page_refs_json, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (item["id"], space_id, item.get("paper_id"), item["material_id"], item["no"], item["type"],
                     item["stem"], dumps(item["options"]), item.get("answer"), item.get("solution"), item.get("score"),
                     item.get("difficulty"), item["answer_status"], dumps(item["page_refs"]), now),
                )
                item["kp_ids"] = sorted({
                    target for kp in item["kp_ids"] if (target := _redirect(kp, point_map))
                })
                conn.executemany(
                    "INSERT INTO item_kp VALUES (?, ?, ?)",
                    [(item["id"], kp, item.get("kp_confidence", {}).get(kp, "medium")) for kp in item["kp_ids"]],
                )
            conn.executemany(
                "UPDATE exam_items SET parent_item_id = ? WHERE space_id = ? AND id = ?",
                [(i["parent_item_id"], space_id, i["id"]) for i in items if i.get("parent_item_id")],
            )
            for entry in bank:
                kp_id = _redirect(entry["kp_id"], point_map)
                if not kp_id or entry["verify_status"] != "verified":
                    continue
                conn.execute(
                    """INSERT INTO item_bank(id, space_id, kp_id, origin, exam_item_id, purpose, type, difficulty,
                        item_json, verify_status, reserved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid5(NAMESPACE_URL, f"{space_id}:{entry['id']}")), space_id, kp_id, entry["origin"],
                     entry.get("exam_item_id"), entry["purpose"], entry["type"], entry.get("difficulty"),
                     dumps(entry["item"]), entry["verify_status"], bool(entry.get("reserved")), now),
                )
            _stats(conn, space_id, active_points, papers, items)
            conn.execute(
                "UPDATE study_spaces SET brief_json = ?, updated_at = ? WHERE id = ?", (dumps(brief), now, space_id),
            )
