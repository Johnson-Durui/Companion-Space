from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.learning.memory import (
    build_compact_memory_summary,
    recall_course_memories,
    recall_global_memory_notes,
    record_trace,
)
from app.llm.gateway import LLMGateway
from app.main import create_app
from app.models.domain import StudySpace


def _seed_course(repository, *, space_id: str, suffix: str) -> dict[str, str]:
    now = datetime.now(timezone.utc).isoformat()
    repository.upsert_space(
        StudySpace(
            id=space_id,
            name=f"Course {suffix}",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    kp_id = f"kp-{suffix}"
    ev_id = f"ev-{suffix}"
    mis_id = f"mis-{suffix}"
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO knowledge_points(
                   id, space_id, name, norm_name, kind, summary, importance, difficulty,
                   ord, source_refs_json, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, 'concept', 'Summary', 'core', 2, 0, '[]', 'active', ?, ?)""",
            (kp_id, space_id, f"Topic {suffix}", f"topic {suffix}", now, now),
        )
        conn.execute(
            """INSERT INTO evidence(
                   id, space_id, kp_id, source, verdict, hint_level, item_type,
                   judged_by, via, p_before, p_after, detail_json, created_at
               ) VALUES (?, ?, ?, 'practice', 'incorrect', 0, 'choice', 'exact', 'control', 0.4, 0.25, '{}', ?)""",
            (ev_id, space_id, kp_id, now),
        )
        conn.execute(
            """INSERT INTO misconceptions(
                   id, space_id, kp_id, text, count, first_seen_at, last_seen_at
               ) VALUES (?, ?, ?, 'Sign flip error', 2, ?, ?)""",
            (mis_id, space_id, kp_id, now, now),
        )
    trace_id = record_trace(
        repository,
        space_id=space_id,
        surface="solve",
        event_type="locate_stuck",
        summary="Stuck on sign change during transposition",
        source_ref={"kind": "solve", "id": f"solve-{suffix}"},
        kp_id=kp_id,
    )
    return {"kp_id": kp_id, "ev_id": ev_id, "mis_id": mis_id, "trace_id": trace_id}


def _auth_client(isolated_settings, gateway_factory):
    app = create_app(settings=isolated_settings, gateway_factory=gateway_factory)
    client = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 51000))
    boot = client.post("/api/v2/session/bootstrap", headers={"Origin": "http://127.0.0.1:8000"})
    assert boot.status_code == 200
    csrf = client.cookies.get("companion_csrf", "")
    client.headers.update({"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": csrf})
    container = app.dependency_overrides[get_container]()
    return client, container


class _MemoryGateway(LLMGateway):
    def __init__(self, registry, *, distill_items: list[dict], synthesis_items: list[dict] | None = None) -> None:
        super().__init__(registry)
        self.distill_items = distill_items
        self.synthesis_items = synthesis_items or []

    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        if prompt_name == "analysis/memory_distill":
            payload = json.dumps(self.distill_items, ensure_ascii=False)
            return parse(f"<memories>{payload}</memories>")
        if prompt_name == "analysis/memory_synthesize":
            payload = json.dumps(self.synthesis_items, ensure_ascii=False)
            return parse(f"<synthesis>{payload}</synthesis>")
        raise AssertionError(f"Unexpected prompt: {prompt_name}")


def test_memory_distill_grounds_evidence_and_respects_dismiss_and_pin(isolated_settings) -> None:
    holder: dict[str, _MemoryGateway] = {}

    def make_gateway(registry):
        gw = _MemoryGateway(registry, distill_items=[])
        holder["gw"] = gw
        return gw

    client, container = _auth_client(isolated_settings, make_gateway)
    ids_a = _seed_course(container.repository, space_id="course-mem-a", suffix="a")
    ids_b = _seed_course(container.repository, space_id="course-mem-b", suffix="b")

    # Feed 1 grounded fact, 1 hallucinated-ref fact, and 1 cross-course-ref fact
    holder["gw"].distill_items = [
        {
            "kind": "mistake_habit",
            "kp_id": ids_a["kp_id"],
            "statement": "移项时容易忘记变号，适合先圈出负号再化简。",
            "evidence_refs": [
                {"kind": "evidence", "id": ids_a["ev_id"]},
                {"kind": "trace", "id": ids_a["trace_id"]},
            ],
        },
        {
            "kind": "bottleneck_kp",
            "kp_id": ids_a["kp_id"],
            "statement": "这条没有真实证据，必须被丢弃。",
            "evidence_refs": [{"kind": "evidence", "id": "fabricated-ev-999"}],
        },
        {
            "kind": "exam_focus",
            "kp_id": ids_b["kp_id"],
            "statement": "这条跨课引用了 B 课证据，必须被丢弃。",
            "evidence_refs": [{"kind": "evidence", "id": ids_b["ev_id"]}],
        },
    ]

    refreshed = client.post("/api/v2/courses/course-mem-a/memories/refresh")
    assert refreshed.status_code == 200
    facts = refreshed.json()
    assert len(facts) == 1
    fact = facts[0]
    assert fact["kp_id"] == ids_a["kp_id"]
    assert fact["kp_name"] == "Topic a"
    assert len(fact["evidence_refs"]) == 2
    assert fact["evidence_refs"][0]["href"] == "/courses/course-mem-a/progress"

    # Cross-course PATCH must fail with 404 memory_not_found
    wrong_course = client.patch(
        f"/api/v2/courses/course-mem-b/memories/{fact['id']}",
        json={"status": "pinned"},
    )
    assert wrong_course.status_code == 404
    assert wrong_course.json()["code"] == "memory_not_found"

    # Edit and pin in owning course
    edited = client.patch(
        f"/api/v2/courses/course-mem-a/memories/{fact['id']}",
        json={"statement": "移项前先标出正负号", "status": "pinned"},
    )
    assert edited.status_code == 200
    assert edited.json()["user_edited"] is True
    assert edited.json()["status"] == "pinned"

    recalled = recall_course_memories(container.repository, space_id="course-mem-a", kp_id=ids_a["kp_id"])
    assert len(recalled) == 1
    assert recalled[0]["statement"] == "移项前先标出正负号"

    summary = build_compact_memory_summary(container.repository, space_id="course-mem-a", kp_id=ids_a["kp_id"])
    assert summary == ["移项前先标出正负号"]
    assert sum(len(s) for s in summary) <= 150

    # Dismissing immediately removes it from listing, recall, and prompt injection
    dismissed = client.patch(
        f"/api/v2/courses/course-mem-a/memories/{fact['id']}",
        json={"status": "dismissed"},
    )
    assert dismissed.status_code == 200
    assert dismissed.json()["status"] == "dismissed"

    listed = client.get("/api/v2/courses/course-mem-a/memories")
    assert listed.status_code == 200
    assert listed.json() == []
    assert recall_course_memories(container.repository, space_id="course-mem-a") == []
    assert build_compact_memory_summary(container.repository, space_id="course-mem-a") == []


def test_memory_archive_cross_course_synthesis_and_user_control(isolated_settings) -> None:
    holder: dict[str, _MemoryGateway] = {}

    def make_gateway(registry):
        gw = _MemoryGateway(registry, distill_items=[], synthesis_items=[])
        holder["gw"] = gw
        return gw

    client, container = _auth_client(isolated_settings, make_gateway)
    ids_a = _seed_course(container.repository, space_id="course-syn-a", suffix="sa")

    holder["gw"].distill_items = [
        {
            "kind": "explanation_pref",
            "kp_id": ids_a["kp_id"],
            "statement": "先看直观例子再推公式更容易听懂。",
            "evidence_refs": [{"kind": "evidence", "id": ids_a["ev_id"]}],
        }
    ]
    res = client.post("/api/v2/courses/course-syn-a/memories/refresh")
    assert res.status_code == 200
    fact_id = res.json()[0]["id"]

    holder["gw"].synthesis_items = [
        {
            "statement": "多门课都偏好先看直观例子再看抽象公式。",
            "source_memory_ids": [fact_id],
        },
        {
            "statement": "无来源记忆的编造结论，必须丢弃。",
            "source_memory_ids": ["mem_nonexistent"],
        },
    ]

    archive_res = client.post("/api/v2/learner/memory-archive/refresh")
    assert archive_res.status_code == 200
    archive = archive_res.json()
    assert len(archive["synthesis_notes"]) == 1
    note = archive["synthesis_notes"][0]
    assert note["source_memory_ids"] == [fact_id]
    assert recall_global_memory_notes(container.repository) == ["多门课都偏好先看直观例子再看抽象公式。"]

    # Edit and dismiss global synthesis note
    patched = client.patch(
        f"/api/v2/learner/memory-archive/{note['id']}",
        json={"statement": "更喜欢先看生活例子再记公式", "status": "pinned"},
    )
    assert patched.status_code == 200
    assert patched.json()["synthesis_notes"][0]["user_edited"] is True
    assert recall_global_memory_notes(container.repository) == ["更喜欢先看生活例子再记公式"]

    forgotten = client.patch(
        f"/api/v2/learner/memory-archive/{note['id']}",
        json={"status": "dismissed"},
    )
    assert forgotten.status_code == 200
    assert forgotten.json()["synthesis_notes"] == []
    assert recall_global_memory_notes(container.repository) == []
