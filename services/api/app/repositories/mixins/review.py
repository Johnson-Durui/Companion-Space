from __future__ import annotations

import json


def _card(row) -> dict:
    result = dict(row)
    value = result.pop("fsrs_json")
    result["fsrs"] = json.loads(value) if value else None
    return result


class ReviewMixin:
    """Small persistence surface for due review cards and the mistake book."""

    def review_card(self, card_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM review_cards WHERE id = ?", (card_id,)).fetchone()
        return _card(row) if row else None

    def due_review_cards(
        self, space_id: str, *, due_at: str, limit: int = 20, plan_item_id: str | None = None,
    ) -> list[dict]:
        priority: set[str] = set()
        with self.connection() as conn:
            if plan_item_id:
                item = conn.execute(
                    "SELECT kp_ids_json FROM plan_items WHERE id = ? AND space_id = ?",
                    (plan_item_id, space_id),
                ).fetchone()
                if item:
                    targets = set(json.loads(item["kp_ids_json"]))
                    priority = targets | {
                        row["from_kp"] for row in conn.execute(
                            "SELECT from_kp FROM kp_edges WHERE space_id = ? AND to_kp IN (%s)"
                            % ",".join("?" for _ in targets),
                            (space_id, *targets),
                        )
                    } if targets else set()
            rows = conn.execute(
                """SELECT * FROM review_cards
                   WHERE space_id = ? AND state != 'archived' AND COALESCE(due_at, '') <= ?
                   ORDER BY due_at, created_at LIMIT 200""",
                (space_id, due_at),
            ).fetchall()
        cards = [_card(row) for row in rows]
        if priority:
            cards.sort(key=lambda card: (card["kp_id"] not in priority, card["due_at"] or ""))
        return cards[:limit]

    def mistake_cards(
        self, space_id: str, *, kp_id: str | None = None, since: str | None = None,
        archived: bool = False,
    ) -> list[dict]:
        clauses = ["c.space_id = ?", "c.kind = 'item'", (
            "EXISTS (SELECT 1 FROM evidence e WHERE e.space_id = c.space_id AND e.item_ref = c.item_ref "
            "AND e.verdict IN ('incorrect', 'dont_know', 'revealed'))"
        )]
        params: list[object] = [space_id]
        if archived:
            clauses.append("c.state = ?")
            params.append("archived")
        else:
            clauses.append("c.state != 'archived'")
        if kp_id:
            clauses.append("c.kp_id = ?")
            params.append(kp_id)
        if since:
            clauses.append("c.updated_at >= ?")
            params.append(since)
        with self.connection() as conn:
            rows = conn.execute(
                f"""SELECT c.*, k.name AS kp_name FROM review_cards c
                    LEFT JOIN knowledge_points k ON k.id = c.kp_id AND k.space_id = c.space_id
                    WHERE {' AND '.join(clauses)} ORDER BY c.updated_at DESC""",
                params,
            ).fetchall()
            result = []
            for row in rows:
                card = _card(row)
                evidence = conn.execute(
                    """SELECT verdict, detail_json, created_at FROM evidence
                       WHERE space_id = ? AND item_ref = ? AND verdict IN ('incorrect', 'dont_know', 'revealed')
                       ORDER BY created_at LIMIT 1""",
                    (space_id, card["item_ref"]),
                ).fetchone()
                card["original_mistake"] = {
                    "verdict": evidence["verdict"],
                    "detail": json.loads(evidence["detail_json"] or "{}"),
                    "created_at": evidence["created_at"],
                } if evidence else None
                result.append(card)
        return result
