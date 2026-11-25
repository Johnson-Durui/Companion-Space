"""The browser harness injects this gateway. Model traffic stays in process."""

import asyncio
import io
import json
from pathlib import Path
import re
import zipfile

from PIL import Image

from app.llm.gateway import LLMGateway
from app.repositories.mixins.common import utcnow
from app.providers.errors import MissingRoleError
from app.services.provider_registry import RoleTestResult
from app.voice.tts.edge import EdgeUnavailableError


def seed_classroom(container, scenario: str, character_id: str = "tutor-chutang"):
    from test_teaching_storage import _seed_plan

    course_id = f"browser-{scenario}-course"
    lesson_id = f"browser-{scenario}-lesson"
    plan_item_id = f"{lesson_id}-item"
    kp_id = f"{lesson_id}-kp"
    bank_id = f"{lesson_id}-question"
    repository = container.repository
    now = utcnow().isoformat()
    with repository.connection() as connection:
        _seed_plan(connection, course_id, plan_item_id)
        connection.execute("UPDATE plan_items SET kp_ids_json = ? WHERE id = ?", (json.dumps([kp_id]), plan_item_id))
        connection.execute(
            """INSERT INTO knowledge_points(id, space_id, name, norm_name, kind, summary, importance,
                                            difficulty, ord, created_at, updated_at)
               VALUES (?, ?, '关系判断', 'relation', 'concept', '关系判断', 'core', 1, 1, ?, ?)""",
            (kp_id, course_id, now, now),
        )
        connection.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES (?, ?, ?, 'generated', 'check', 'choice', '{}', 'verified', ?)""",
            (bank_id, course_id, kp_id, now),
        )
    teacher = container.tutors.resolve_active_character(character_id)
    assert teacher is not None
    plan = {
        "title": "关系判断", "est_minutes": 10,
        "segments": [{
            "id": "seg1", "kp_id": kp_id, "keypoints": ["先确认条件"], "checks": ["q1"],
            "approaches": [{"kind": "visual", "keypoint": "all", "outline": "先写条件"}],
        }],
        "items": {
            "q1": {
                "type": "choice", "kp_id": kp_id, "bank_id": bank_id, "keypoints": [0],
                "stem": "如果条件成立，应选择哪一项？", "answer": "A", "verify": {"status": "verified"},
                "options": [{"key": "A", "text": "按条件推导"}, {"key": "B", "text": "忽略条件"}],
            },
        },
    }
    ready = repository.save_lesson_plan(course_id, plan_item_id, plan=plan)
    lesson = repository.create_or_resume_lesson(
        course_id, plan_item_id, lesson_plan_id=ready["id"],
        state={"stage": "opening"}, character_id=teacher.id,
    )
    with repository.connection() as connection:
        connection.execute("UPDATE lessons SET id = ? WHERE id = ?", (lesson_id, lesson["id"]))
        connection.execute("UPDATE plan_items SET lesson_id = ? WHERE id = ?", (lesson_id, plan_item_id))


def build_media_fixture_tutorpack_bytes() -> bytes:
    """Build a tiny test-only .tutorpack zip with greet_wave, farewell_wave, and 2 expression stills."""
    tiny_webm = (Path(__file__).resolve().parents[1] / "fixtures" / "tiny-loop.webm").read_bytes()

    def _webp(rgb: tuple[int, int, int]) -> bytes:
        buf = io.BytesIO()
        Image.new("RGB", (288, 512), rgb).save(buf, format="WEBP", quality=80)
        return buf.getvalue()

    manifest = {
        "name": "测试媒体助教",
        "aspect_ratio": "9:16",
        "anchor": "anchor.webp",
        "crossfade_ms": 120,
        "canvas": {"width": 288, "height": 512, "fps": 24},
        "clips": {
            "idle_breathe": "clips/idle_breathe.webm",
            "speak_calm": "clips/speak_calm.webm",
            "greet_wave": "clips/greet_wave.webm",
            "farewell_wave": "clips/farewell_wave.webm",
            "react_praise": "clips/react_praise.webm",
            "react_comfort": "clips/react_comfort.webm",
        },
        "clip_meta": {
            "greet_wave": {"duration_ms": 500, "settle_ms": 350},
            "farewell_wave": {"duration_ms": 500, "settle_ms": 350},
            "react_praise": {"duration_ms": 500, "settle_ms": 350},
            "react_comfort": {"duration_ms": 500, "settle_ms": 350},
        },
        "stills": {
            "praise": "stills/praise.webp",
            "caring": "stills/caring.webp",
        },
        "media": {
            "generator": "E2E test fixture",
            "ai_generated": False,
        },
        "license": {
            "author": "E2E Fixture",
            "terms": "Test only",
            "allow_redistribution": False,
        },
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        zf.writestr("anchor.webp", _webp((48, 64, 92)))
        zf.writestr("stills/praise.webp", _webp((64, 128, 96)))
        zf.writestr("stills/caring.webp", _webp((128, 86, 72)))
        for rel in manifest["clips"].values():
            zf.writestr(rel, tiny_webm)
    return archive.getvalue()


def seed_empty_course(container):
    repository = container.repository
    now = utcnow().isoformat()
    with repository.connection() as connection:
        connection.execute(
            """INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at)
               VALUES ('browser-empty-course', '线性代数基础（待上传资料）', '线性代数', '', ?, ?)""",
            (now, now),
        )


def seed_stress_course(container):
    from test_teaching_storage import _seed_plan

    course_id = "browser-stress-course"
    lesson_id = "browser-stress-lesson"
    plan_item_id = f"{lesson_id}-item"
    course_name = "高等数学（上册）极限连续微分中值定理与定积分综合复习冲刺专项训练课程（2026秋季学期）"
    course_goal = "在期末综合大考前系统掌握全部核心定理的严格证明、反例构造与高难度综合计算题型"
    lesson_title = "多元函数微分学、隐函数存在定理与拉格朗日乘数法在约束极值中的综合推导与应用"
    repository = container.repository
    now = utcnow().isoformat()
    unit_titles = [
        "第一章 函数、极限与连续性的严格刻画",
        "第二章 导数、高阶微分与隐函数求导法则",
        "第三章 微分中值定理与泰勒展开的误差估计",
        "第四章 不定积分与定积分换元分部技巧汇总",
        "第五章 反常积分敛散性与定积分几何物理应用",
        "第六章 多元函数偏导数、全微分与条件极值综合",
    ]
    kp_ids: list[str] = []
    with repository.connection() as connection:
        _seed_plan(connection, course_id, plan_item_id)
        brief = {
            "page_count": 128,
            "section_count": 24,
            "knowledge_point_count": 66,
            "item_count": 18,
            "overview": "覆盖高数上册核心概念、定理证明与综合计算，共 6 章 66 个知识点，用于验证长标题、多章节与高密度地图的排版表现。",
            "warnings": [],
        }
        connection.execute(
            "UPDATE study_spaces SET name = ?, goal = ?, brief_json = ? WHERE id = ?",
            (course_name, course_goal, json.dumps(brief, ensure_ascii=False), course_id),
        )
        connection.execute(
            "UPDATE plan_items SET title = ?, est_minutes = 45 WHERE id = ?",
            (lesson_title, plan_item_id),
        )
        ord_no = 0
        for u_idx, u_title in enumerate(unit_titles, start=1):
            unit_id = f"stress-unit-{u_idx}"
            connection.execute(
                "INSERT INTO units(id, space_id, title, ord) VALUES (?, ?, ?, ?)",
                (unit_id, course_id, u_title, u_idx),
            )
            for k_idx in range(1, 12):
                ord_no += 1
                kp_id = f"stress-kp-{ord_no:02d}"
                kp_ids.append(kp_id)
                importance = "core" if k_idx <= 3 else ("important" if k_idx <= 7 else "peripheral")
                difficulty = ((ord_no - 1) % 3) + 1
                name = f"第{u_idx}章核心要点{k_idx:02d}：高阶推导与边界条件讨论（综合应用）"
                summary = f"系统梳理{u_title}中的第 {k_idx} 项关键结论、适用前提与典型反例。"
                formula = r"\lim_{x \to x_0} \frac{f(x) - f(x_0)}{x - x_0} = f'(x_0),\quad R_n(x)=\frac{f^{(n+1)}(\xi)}{(n+1)!}(x-x_0)^{n+1}" if k_idx % 2 == 1 else None
                connection.execute(
                    """INSERT INTO knowledge_points(
                           id, space_id, unit_id, name, norm_name, kind, summary, formula,
                           importance, difficulty, ord, source_refs_json, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, 'theorem', ?, ?, ?, ?, ?, '[]', ?, ?)""",
                    (kp_id, course_id, unit_id, name, f"stress-{ord_no}", summary, formula, importance, difficulty, ord_no, now, now),
                )
                connection.execute(
                    """INSERT INTO kp_exam_stats(
                           kp_id, space_id, n_items, score_share, recency_weight, trend, types_json, novel_json, weight, updated_at
                       ) VALUES (?, ?, ?, ?, 0.8, 'stable', '{}', '[]', ?, ?)""",
                    (kp_id, course_id, (ord_no % 4), round(0.015, 4), round(0.015, 4), now),
                )
        primary_kp = kp_ids[0]
        bank_id = f"{lesson_id}-question"
        connection.execute("UPDATE plan_items SET kp_ids_json = ? WHERE id = ?", (json.dumps([primary_kp]), plan_item_id))
        connection.execute(
            """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, item_json, verify_status, created_at)
               VALUES (?, ?, ?, 'generated', 'check', 'choice', '{}', 'verified', ?)""",
            (bank_id, course_id, primary_kp, now),
        )
    teacher = container.tutors.resolve_active_character("tutor-chutang")
    assert teacher is not None
    plan = {
        "title": lesson_title,
        "est_minutes": 45,
        "segments": [{
            "id": "seg1",
            "kp_id": kp_ids[0],
            "keypoints": ["确认闭区间连续与开区间可导前提并结合单调性判定唯一极值"],
            "checks": ["q1"],
            "approaches": [{"kind": "visual", "keypoint": "all", "outline": "先列条件，再按单调性逐行推导"}],
        }],
        "items": {
            "q1": {
                "type": "choice",
                "kp_id": kp_ids[0],
                "bank_id": f"{lesson_id}-question",
                "keypoints": [0],
                "stem": (
                    "设函数 $f(x)$ 在闭区间 $[a, b]$ 上连续，在开区间 $(a, b)$ 内可导，且满足端点条件 $f(a)=f(b)=0$。\n"
                    "若进一步已知导函数 $f'(x)$ 在 $(a, b)$ 内严格单调递增，并且存在唯一驻点 $c \\in (a, b)$ 使 $f'(c)=0$。\n"
                    "综合上述全部条件，下列关于函数在区间内的符号分布、单调区间与全局极值判定的结论中，哪一项严格成立？"
                ),
                "answer": "A",
                "verify": {"status": "verified"},
                "options": [
                    {"key": "A", "text": "函数在 $(a, c)$ 内严格递减、在 $(c, b)$ 内严格递增，因而在 $x=c$ 处取得唯一全局最小值且 $f(c)<0$"},
                    {"key": "B", "text": "函数在 $(a, c)$ 内严格递增、在 $(c, b)$ 内严格递减，因而在 $x=c$ 处取得唯一全局最大值且 $f(c)>0$"},
                    {"key": "C", "text": "由于端点函数值相等且内部存在唯一驻点，只能推出存在拐点而无法确定该驻点是否为极值点"},
                    {"key": "D", "text": "只要导函数连续递增即可断言函数在闭区间 $[a, b]$ 上恒非负，且最小值必然在两个边界端点同时取到"},
                    {"key": "E", "text": "若不额外假设二阶导数在开区间内有界，则函数可能在驻点邻域发生振荡从而产生多个局部极大值点"},
                    {"key": "F", "text": "当区间长度 $b-a$ 足够大时，中值定理仅保证至少存在一点导数为零，但无法判断 $f(c)$ 与零的大小关系"},
                ],
            },
        },
    }
    ready = repository.save_lesson_plan(course_id, plan_item_id, plan=plan)
    lesson = repository.create_or_resume_lesson(
        course_id, plan_item_id, lesson_plan_id=ready["id"],
        state={"stage": "opening"}, character_id=teacher.id,
    )
    with repository.connection() as connection:
        connection.execute("UPDATE lessons SET id = ? WHERE id = ?", (lesson_id, lesson["id"]))
        connection.execute("UPDATE plan_items SET lesson_id = ? WHERE id = ?", (lesson_id, plan_item_id))


def seed_unprepared_lesson(container):
    """Seed an active lesson plan item with grounded sources and bank items, but no lesson_plan yet."""
    from test_teaching_storage import _seed_plan

    course_id = "browser-unprepared-course"
    plan_item_id = "browser-unprepared-item"
    kp_id = "unprepared-kp"
    material_id = "unprepared-material"
    repository = container.repository
    now = utcnow().isoformat()
    with repository.connection() as connection:
        _seed_plan(connection, course_id, plan_item_id)
        connection.execute(
            "UPDATE study_spaces SET name = '高等数学（待备课演示）', goal = '验证候课与实时备课体验' WHERE id = ?",
            (course_id,),
        )
        connection.execute(
            "UPDATE plan_items SET title = '函数极限与连续性判定', est_minutes = 20, kp_ids_json = ? WHERE id = ?",
            (json.dumps([kp_id]), plan_item_id),
        )
        connection.execute(
            """INSERT INTO materials
               (id, space_id, title, kind, filename, storage_path, chunk_count,
                created_at, updated_at, role, parse_status)
               VALUES (?, ?, '极限教材', 'markdown', 'limit.md', ?, 1, ?, ?, 'textbook', 'parsed')""",
            (material_id, course_id, f"spaces/{course_id}/limit.md", now, now),
        )
        connection.executemany(
            """INSERT INTO material_sections
               (id, material_id, space_id, parent_id, level, title, page_start, page_end, ord)
               VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?)""",
            [
                ("unprepared-sec-1", material_id, course_id, "1.1 函数极限的定义", 1, 1, 1),
                ("unprepared-sec-2", material_id, course_id, "1.2 左右极限与连续性", 2, 2, 2),
            ],
        )
        connection.executemany(
            """INSERT INTO material_pages
               (material_id, page_no, space_id, markdown, source, quality, image_path)
               VALUES (?, ?, ?, ?, 'text', 1.0, NULL)""",
            [
                (
                    material_id,
                    1,
                    course_id,
                    "### 1.1 函数极限的定义\n\n"
                    "设函数 $f(x)$ 在点 $x_0$ 的某一去心邻域内有定义。当 $x$ 无限趋近于 $x_0$ 时，若 $f(x)$ 无限趋近于常数 $A$，"
                    "则称 $A$ 为函数 $f(x)$ 当 $x \\to x_0$ 时的极限。\n\n"
                    "重要判定：函数在一点极限存在的充要条件是左极限与右极限均存在且相等，与该点本身是否有定义无关。",
                ),
                (
                    material_id,
                    2,
                    course_id,
                    "### 1.2 左右极限与连续性\n\n"
                    "若 $\\lim_{x \\to x_0^-} f(x) = \\lim_{x \\to x_0^+} f(x) = f(x_0)$，则称函数 $f(x)$ 在点 $x_0$ 处连续。\n\n"
                    "常见易错点：分段函数在分界点处必须分别检验左极限、右极限与该点函数值。",
                ),
            ],
        )
        connection.execute(
            """INSERT INTO knowledge_points
               (id, space_id, name, norm_name, kind, summary, pitfalls_json, question_types_json,
                importance, difficulty, ord, source_refs_json, status, created_at, updated_at)
               VALUES (?, ?, '函数极限', 'func-limit', 'concept', '左右极限存在且相等时极限存在。', '[]', '["choice"]',
                       'core', 2, 1, ?, 'active', ?, ?)""",
            (kp_id, course_id, json.dumps([{"material_id": material_id, "page_no": 1}]), now, now),
        )
        connection.execute(
            """INSERT INTO chunks
               (id, space_id, material_id, title, locator, content, sparse_terms, dense_vector,
                metadata_json, created_at, section_id, page_no)
               VALUES ('unprepared-chunk-1', ?, ?, '极限教材', '1',
                       '函数在一点极限存在的充要条件是左极限与右极限均存在且相等。',
                       '[]', '{}', '{}', ?, 'sec-1', 1)""",
            (course_id, material_id, now),
        )
        for bank_id, variant_of, stem in (
            ("unprepared-bank-1", None, "函数在某点极限存在的充要条件是什么？"),
            ("unprepared-bank-2", "unprepared-bank-1", "若左极限等于右极限但不等于函数值，该点极限是否存在？"),
            ("unprepared-bank-3", "unprepared-bank-1", "分段函数在分界点左右极限不相等时，极限是否存在？"),
            ("unprepared-bank-ex1", None, "例题：判断分段函数在分界点处的极限。"),
            ("unprepared-bank-ex2", None, "例题：利用左右极限检查连续性。"),
        ):
            connection.execute(
                """INSERT INTO item_bank
                   (id, space_id, kp_id, origin, purpose, type, difficulty, variant_of,
                    item_json, verify_status, reserved, created_at)
                   VALUES (?, ?, ?, 'textbook', 'check', 'choice', 1, ?, ?, 'verified', 0, ?)""",
                (
                    bank_id,
                    course_id,
                    kp_id,
                    variant_of,
                    json.dumps(
                        {
                            "stem": stem,
                            "options": {"A": "左右极限存在且相等", "B": "函数值必须存在"},
                            "answer": "A",
                            "solution": "按极限定义，只需左右极限存在且相等。",
                        },
                        ensure_ascii=False,
                    ),
                    now,
                ),
            )
        # Add 1 due warmup flashcard for this KP so lobby warmup renders
        connection.execute(
            """INSERT INTO review_cards
               (id, space_id, kp_id, kind, front, back, fsrs_json, due_at, state, created_at, updated_at)
               VALUES ('unprepared-warmup-card-1', ?, ?, 'flashcard',
                       '函数在一点处极限存在的充要条件是什么？',
                       '左极限与右极限均存在且相等（与该点函数值无关）。',
                       '{}', '2020-01-01T00:00:00+00:00', 'active', ?, ?)""",
            (course_id, kp_id, now, now),
        )


def seed_u5_loop_course(container):
    """Seed a rich learning-loop course for U5 charts, plan diff, review I14, practice B7, and history B6."""
    from datetime import timedelta

    course_id = "browser-loop-course"
    practice_item_id = "browser-loop-practice-item"
    repository = container.repository
    now_dt = utcnow()
    now = now_dt.isoformat()
    day_1 = (now_dt - timedelta(days=3)).isoformat()
    day_2 = (now_dt - timedelta(days=2)).isoformat()
    day_3 = (now_dt - timedelta(days=1)).isoformat()

    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at)
               VALUES (?, '微积分闭环进阶（U5演示）', '微积分', '期末稳过 85 分', ?, ?)""",
            (course_id, day_1, now),
        )
        conn.execute(
            """INSERT INTO course_enrollment(space_id, enrollment_json, interview_status, placement_status, updated_at)
               VALUES (?, ?, 'done', 'done', ?)""",
            (
                course_id,
                json.dumps(
                    {
                        "goal": "exam",
                        "exam_name": "期末考试",
                        "exam_date": (now_dt + timedelta(days=24)).date().isoformat(),
                        "full_score": 100,
                        "target_score": 85,
                        "weekly_days": [1, 3, 5, 6],
                        "session_minutes": 30,
                    },
                    ensure_ascii=False,
                ),
                now,
            ),
        )
        conn.executemany(
            "INSERT INTO units(id, space_id, title, ord) VALUES (?, ?, ?, ?)",
            [
                ("loop-u1", course_id, "第一章 极限与连续", 1),
                ("loop-u2", course_id, "第二章 导数与中值定理", 2),
            ],
        )
        kps = [
            ("loop-kp-1", "loop-u1", "函数极限定义", "concept", "core", 1, 1, 0.90, "mastered", 4, 0.28, 0.28),
            ("loop-kp-2", "loop-u1", "无穷小等价替换", "method", "core", 2, 2, 0.56, "learning", 2, 0.30, 0.30),
            ("loop-kp-3", "loop-u2", "罗尔与拉格朗日中值定理", "theorem", "core", 3, 3, 0.34, "shaky", 2, 0.26, 0.26),
            ("loop-kp-4", "loop-u2", "泰勒展开误差估计", "formula", "important", 3, 4, 0.15, "unseen", 0, 0.16, 0.16),
        ]
        for kp_id, u_id, name, kind, imp, diff_lv, ord_no, prob, status, ev_cnt, share, weight in kps:
            conn.execute(
                """INSERT INTO knowledge_points
                   (id, space_id, unit_id, name, norm_name, kind, summary, importance, difficulty, ord, source_refs_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)""",
                (kp_id, course_id, u_id, name, kp_id, kind, f"{name}的核心定义与适用边界。", imp, diff_lv, ord_no, day_1, now),
            )
            conn.execute(
                """INSERT INTO kp_exam_stats
                   (kp_id, space_id, n_items, score_share, recency_weight, trend, types_json, novel_json, weight, updated_at)
                   VALUES (?, ?, ?, ?, 0.9, 'rising', ?, '[]', ?, ?)""",
                (kp_id, course_id, 4, share, json.dumps({"选择题": 2, "计算题": 2}, ensure_ascii=False), weight, now),
            )
            conn.execute(
                """INSERT INTO kp_mastery(space_id, kp_id, p, status, evidence_count, inferred, last_evidence_at)
                   VALUES (?, ?, ?, ?, ?, 0, ?)""",
                (course_id, kp_id, prob, status, ev_cnt, now if ev_cnt else None),
            )
        conn.executemany(
            "INSERT INTO kp_edges(space_id, from_kp, to_kp, source) VALUES (?, ?, ?, 'extracted')",
            [
                (course_id, "loop-kp-1", "loop-kp-2"),
                (course_id, "loop-kp-2", "loop-kp-3"),
                (course_id, "loop-kp-3", "loop-kp-4"),
            ],
        )

        # Evidence across multiple days for StudyCalendar, WeeklyMinutes & KP timeline
        conn.executemany(
            """INSERT INTO evidence
               (id, space_id, kp_id, item_ref, source, verdict, item_type, judged_by, via, p_before, p_after, detail_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'choice', 'exact', 'control', ?, ?, ?, ?)""",
            [
                ("loop-ev-1", course_id, "loop-kp-1", "loop-q1", "classroom", "correct", 0.55, 0.78, json.dumps({"answer": "A"}), day_1),
                ("loop-ev-2", course_id, "loop-kp-1", "loop-q1", "review", "correct", 0.78, 0.90, json.dumps({"answer": "A"}), day_2),
                ("loop-ev-3", course_id, "loop-kp-2", "loop-q2", "classroom", "correct", 0.35, 0.56, json.dumps({"answer": "B"}), day_3),
                ("loop-ev-4", course_id, "loop-kp-3", "loop-mistake-q", "practice", "incorrect", 0.52, 0.34, json.dumps({"answer": "A", "gap": "未核对闭区间连续条件"}, ensure_ascii=False), now),
            ],
        )

        # Verified item bank for practice & review
        items_seed = [
            ("loop-q1", "loop-kp-1", "practice", {"stem": "函数在一点处极限存在的充要条件是？", "options": {"A": "左右极限存在且相等", "B": "该点函数值存在"}, "answer": "A", "solution": "按极限定义，左右极限存在且相等即可。"}),
            ("loop-q2", "loop-kp-2", "practice", {"stem": "当 x→0 时，sin(x) 与下列哪一项等价？", "options": {"A": "x²", "B": "x"}, "answer": "B", "solution": "lim(sin x / x) = 1，故 sin x ~ x。"}),
            ("loop-mistake-q", "loop-kp-3", "check", {"stem": "应用罗尔定理前，函数在 [a, b] 上必须满足？", "options": {"A": "仅在开区间有界", "B": "闭区间连续、开区间可导且端点相等"}, "answer": "B", "solution": "罗尔定理要求闭区间连续、开区间可导且 f(a)=f(b)。"}),
        ]
        for bid, kpid, purpose, payload in items_seed:
            conn.execute(
                """INSERT INTO item_bank(id, space_id, kp_id, origin, purpose, type, difficulty, item_json, verify_status, reserved, created_at)
                   VALUES (?, ?, ?, 'generated', ?, 'choice', 2, ?, 'verified', 0, ?)""",
                (bid, course_id, kpid, purpose, json.dumps(payload, ensure_ascii=False), day_1),
            )

        # Plan v1 (superseded) & Plan v2 (active, reason=lesson_finished) -> produces B4b diff!
        conn.execute(
            """INSERT INTO study_plans(id, space_id, version, status, reason, params_json, deferred_json, created_at)
               VALUES ('loop-plan-v1', ?, 1, 'superseded', 'setup', '{}', '[]', ?)""",
            (course_id, day_1),
        )
        conn.executemany(
            """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes, scheduled_date, why_text, status)
               VALUES (?, 'loop-plan-v1', ?, ?, ?, ?, ?, ?, ?, '[]', 'todo')""",
            [
                ("loop-v1-1", course_id, 0, "lesson", "函数极限定义", json.dumps(["loop-kp-1"]), 20, now_dt.date().isoformat()),
                ("loop-v1-2", course_id, 1, "lesson", "无穷小等价替换", json.dumps(["loop-kp-2"]), 25, (now_dt + timedelta(days=2)).date().isoformat()),
                ("loop-v1-3", course_id, 2, "lesson", "罗尔与拉格朗日中值定理", json.dumps(["loop-kp-3"]), 30, (now_dt + timedelta(days=4)).date().isoformat()),
            ],
        )
        conn.execute(
            """INSERT INTO study_plans(id, space_id, version, status, reason, params_json, deferred_json, created_at)
               VALUES ('loop-plan-v2', ?, 2, 'active', 'lesson_finished', ?, ?, ?)""",
            (
                course_id,
                json.dumps({"highlighted_kp_ids": ["loop-kp-3"], "deferred_weight": 0.16, "over_capacity": False}, ensure_ascii=False),
                json.dumps(["loop-kp-4"]),
                now,
            ),
        )
        conn.executemany(
            """INSERT INTO plan_items(id, plan_id, space_id, ord, kind, title, kp_ids_json, est_minutes, scheduled_date, why_text, status)
               VALUES (?, 'loop-plan-v2', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                ("loop-v2-done", course_id, 0, "lesson", "函数极限定义", json.dumps(["loop-kp-1"]), 20, (now_dt - timedelta(days=1)).date().isoformat(), json.dumps([{"kp_id": "loop-kp-1", "weight": 0.28, "mastery": 0.9}]), "done"),
                ("loop-v2-earlier", course_id, 1, "lesson", "罗尔与拉格朗日中值定理", json.dumps(["loop-kp-3"]), 30, now_dt.date().isoformat(), json.dumps([{"kp_id": "loop-kp-3", "weight": 0.26, "mastery": 0.34}]), "todo"),
                ("loop-v2-later", course_id, 2, "lesson", "无穷小等价替换", json.dumps(["loop-kp-2"]), 25, (now_dt + timedelta(days=2)).date().isoformat(), json.dumps([{"kp_id": "loop-kp-2", "weight": 0.30, "mastery": 0.56}]), "todo"),
                (practice_item_id, course_id, 3, "practice", "极限与等价替换限时练习", json.dumps(["loop-kp-1", "loop-kp-2"]), 15, (now_dt + timedelta(days=3)).date().isoformat(), "[]", "todo"),
            ],
        )

        # Completed & abandoned lessons for B6 History + B5 WeeklyMinutes
    lp_done = repository.save_lesson_plan(
        course_id,
        "loop-v2-done",
        plan={"title": "函数极限定义", "est_minutes": 20, "segments": [{"id": "s1", "kp_id": "loop-kp-1", "keypoints": ["左右极限存在", "左右极限相等"], "checks": []}], "items": {}},
    )
    lp_later = repository.save_lesson_plan(
        course_id,
        "loop-v2-later",
        plan={"title": "无穷小等价替换", "est_minutes": 25, "segments": [{"id": "s1", "kp_id": "loop-kp-2", "keypoints": ["常见等价替换", "加减替换条件"], "checks": []}], "items": {}},
    )
    with repository.connection() as conn:
        conn.execute(
            """INSERT INTO lessons(id, space_id, plan_item_id, lesson_plan_id, status, started_at, ended_at, state_json, recap_json)
               VALUES ('loop-lesson-done', ?, 'loop-v2-done', ?, 'done', ?, ?, ?, ?)""",
            (
                course_id,
                lp_done["id"],
                (now_dt - timedelta(days=1, minutes=22)).isoformat(),
                day_3,
                json.dumps({"active_ms": 1_320_000}),
                json.dumps({"summary": "今天把左右极限存在且相等的判定彻底理顺了。\n下次继续推进中值定理。"}, ensure_ascii=False),
            ),
        )
        conn.execute(
            """INSERT INTO lessons(id, space_id, plan_item_id, lesson_plan_id, status, started_at, ended_at, state_json, recap_json)
               VALUES ('loop-lesson-abandoned', ?, 'loop-v2-later', ?, 'abandoned', ?, ?, ?, ?)""",
            (
                course_id,
                lp_later["id"],
                (now_dt - timedelta(days=2, minutes=9)).isoformat(),
                day_2,
                json.dumps({"active_ms": 540_000, "seg_idx": 0, "kp_cursor": 1}),
                json.dumps({"summary": "中途暂停在常见等价无穷小替换。"}, ensure_ascii=False),
            ),
        )

        # Due review cards (1 item card that is also a mistake card + 1 flashcard)
        due_past = "2020-01-01T00:00:00+00:00"
        conn.executemany(
            """INSERT INTO review_cards(id, space_id, kp_id, kind, front, back, item_ref, fsrs_json, due_at, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, 'active', ?, ?)""",
            [
                ("loop-card-item", course_id, "loop-kp-3", "item", "应用罗尔定理前，函数在 [a, b] 上必须满足？", "罗尔定理要求闭区间连续、开区间可导且 f(a)=f(b)。", "loop-mistake-q", due_past, day_3, now),
                ("loop-card-flash", course_id, "loop-kp-2", "flashcard", "当 x→0 时，ln(1+x) 的等价无穷小是什么？", "当 x→0 时，ln(1+x) ~ x。", None, due_past, day_3, now),
            ],
        )

        # Phase 2: seeded verified solve session for /solve
        solve_blueprint = {
            "approach_prompt": "先核对函数在闭区间上的连续性、开区间可导性与端点值，再对 f(x) 求导找驻点。",
            "key_formula": r"f'(\xi) = 3\xi^2 - 3 = 0",
            "hints": {
                "1": r"先验证 $f(0)$ 与 $f(\sqrt{3})$ 是否相等，确认满足罗尔定理前提。",
                "2": r"求出导函数 $f'(x) = 3x^2 - 3$，并筛选落在开区间 $(0, \sqrt{3})$ 内的根。",
            },
            "steps": [
                r"\text{核对前提：}f(x)=x^3-3x\text{ 在 }[0,\sqrt{3}]\text{ 连续，且 }f(0)=f(\sqrt{3})=0",
                r"\text{求导得 }f'(x)=3x^2-3",
                r"\text{令 }f'(\xi)=0\text{ 得 }\xi=\pm 1\text{，结合 }\xi\in(0,\sqrt{3})\text{ 取 }\xi=1",
            ],
            "pitfalls": [r"容易忘记检验端点 $f(a)=f(b)$ 或忘记舍去区间外的负根 $\xi=-1$。"],
            "verified_answer": "1",
            "verify_reason": "Two independent solutions agree.",
        }
        solve_state = {
            "hint_level": 1,
            "revealed": True,
            "solved": False,
            "step_explanations": {},
            "turns": [],
            "mimic_results": {},
        }
        conn.execute(
            """INSERT INTO solve_sessions(
                   id, space_id, source_kind, stem, image_path, mapped_kp_ids_json,
                   verify_status, blueprint_json, state_json, mimic_item_refs_json,
                   status, created_at, updated_at
               ) VALUES ('loop-solve-1', ?, 'text', ?, NULL, ?, 'verified', ?, ?, '[]', 'active', ?, ?)""",
            (
                course_id,
                r"设函数 $f(x) = x^3 - 3x$ 在闭区间 $[0, \sqrt{3}]$ 上满足罗尔定理条件，求满足 $f'(\xi) = 0$ 的中值点 $\xi$。",
                json.dumps(["loop-kp-3"]),
                json.dumps(solve_blueprint, ensure_ascii=False),
                json.dumps(solve_state, ensure_ascii=False),
                day_3,
                now,
            ),
        )

        # Phase 3: seeded L1 trace & grounded L2 memory facts for CourseMemoryCard / GlobalMemoryArchiveCard
        conn.execute(
            """INSERT INTO learning_traces(id, space_id, surface, kp_id, event_type, summary, source_ref_json, created_at)
               VALUES ('loop-trace-1', ?, 'lesson', 'loop-kp-3', 'recap', ?, ?, ?)""",
            (
                course_id,
                "应用罗尔定理前容易跳过闭区间连续与端点相等核对。",
                json.dumps({"kind": "lesson", "id": "loop-lesson-done"}),
                day_3,
            ),
        )
        conn.executemany(
            """INSERT INTO memory_facts(
                   id, space_id, kp_id, kind, statement, evidence_refs_json,
                   status, user_edited, embedding, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)""",
            [
                (
                    "loop-mem-1",
                    course_id,
                    "loop-kp-3",
                    "mistake_habit",
                    "应用罗尔定理前容易跳过闭区间连续与端点相等的核对步骤。",
                    json.dumps([{"kind": "evidence", "id": "loop-ev-4"}, {"kind": "solve", "id": "loop-solve-1"}]),
                    "pinned",
                    day_3,
                    now,
                ),
                (
                    "loop-mem-2",
                    course_id,
                    "loop-kp-2",
                    "explanation_pref",
                    "先看图像直观变化再进公式推导时，理解速度更快。",
                    json.dumps([{"kind": "lesson", "id": "loop-lesson-done"}]),
                    "active",
                    day_3,
                    now,
                ),
            ],
        )

        # Phase 4: seeded block notebook with parameterized interactive plot for /notes
        conn.execute(
            """INSERT INTO course_notes(id, space_id, title, kp_id, created_at, updated_at)
               VALUES ('loop-note-1', ?, '第一章 极限与函数图像精要', 'loop-kp-1', ?, ?)""",
            (course_id, day_3, now),
        )
        plot_note_spec = json.dumps(
            {
                "fn": ["a*x^2+b"],
                "x": [-3, 3],
                "y": [-3, 6],
                "params": [
                    {"name": "a", "label": "开口系数 a", "min": -2, "max": 2, "step": 0.5, "default": 1},
                    {"name": "b", "label": "纵向平移 b", "min": -2, "max": 2, "step": 0.5, "default": 0},
                ],
                "keyframes": [
                    {"label": "默认抛物线", "values": {"a": 1, "b": 0}},
                    {"label": "开口变宽上移", "values": {"a": 0.5, "b": 1}},
                    {"label": "开口向下", "values": {"a": -1, "b": 2}},
                ],
            },
            ensure_ascii=False,
        )
        conn.executemany(
            """INSERT INTO note_blocks(
                   id, note_id, space_id, ord, block_type, title, content, source_ref_json, created_at, updated_at
               ) VALUES (?, 'loop-note-1', ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    "loop-nb-1",
                    course_id,
                    0,
                    "callout",
                    "极限存在判定",
                    "函数在一点处极限存在，要求左极限与右极限均存在且相等，与该点函数值无关。",
                    json.dumps({"kind": "lesson", "lesson_id": "loop-lesson-done", "kp_id": "loop-kp-1"}),
                    day_3,
                    now,
                ),
                (
                    "loop-nb-2",
                    course_id,
                    1,
                    "steps",
                    "罗尔定理三步核对",
                    "f(x)\\text{ 在 }[a,b]\\text{ 连续}\nf(x)\\text{ 在 }(a,b)\\text{ 可导且 }f(a)=f(b)\n\\exists\\,\\xi\\in(a,b)\\text{ 使 }f'(\\xi)=0",
                    json.dumps({"kind": "solve", "solve_session_id": "loop-solve-1", "kp_id": "loop-kp-3"}),
                    day_3,
                    now,
                ),
                (
                    "loop-nb-3",
                    course_id,
                    2,
                    "plot",
                    "二次函数参数探索",
                    plot_note_spec,
                    None,
                    day_3,
                    now,
                ),
            ],
        )


class BrowserHarnessGateway(LLMGateway):
    async def complete_tagged(self, role, prompt_name, variables, *, parse, **options):
        if prompt_name == "analysis/kp_extract":
            raw = """<kp><name>条件关系</name><kind>concept</kind><importance>core</importance>
            <difficulty>2</difficulty><summary>根据已知条件判断结果。</summary>
            <must_know>识别条件</must_know><question_type>choice</question_type><pages>1</pages></kp>
            <kp><name>结果计算</name><kind>skill</kind><importance>important</importance>
            <difficulty>2</difficulty><summary>根据规则完成计算。</summary>
            <must_know>代入规则</must_know><prerequisite>条件关系</prerequisite>
            <question_type>choice</question_type><pages>1</pages></kp>"""
        elif prompt_name == "analysis/kp_reduce":
            keys = sorted(set(re.findall(r'"key":"(c\d+)"', variables["knowledge_candidates"])))
            raw = "".join(f"<merge><member>{key}</member></merge>" for key in keys)
            if len(keys) > 1:
                raw += f"<edge><before>{keys[0]}</before><after>{keys[1]}</after></edge>"
        elif prompt_name == "analysis/exam_segment":
            raw = """<paper><name>阶段测试</name><year>2025</year><full_score>10</full_score></paper>
            <item><no>1</no><type>choice</type><stem>根据材料，正确结果是哪一项？</stem>
            <option><key>A</key><text>不成立</text></option><option><key>B</key><text>成立</text></option>
            <answer>B</answer><score>10</score><difficulty>2</difficulty><pages>1</pages></item>"""
        elif prompt_name == "analysis/item_map":
            raw = "<map><item>i0</item><kp>k0</kp></map>"
        elif prompt_name == "analysis/item_solve":
            raw = "<solve><answer>成立</answer><confidence>high</confidence><valid>true</valid><reason>checked</reason></solve>"
        elif prompt_name == "analysis/item_choice_map":
            raw = "<mapping><choice>B</choice></mapping>"
        elif prompt_name == "analysis/item_equiv":
            raw = "<comparison><equivalent>true</equivalent></comparison>"
        elif prompt_name == "analysis/diagnostic_generate":
            raw = ""
        elif prompt_name == "analysis/kp_faithful":
            raw = "<support>supported</support>"
        elif prompt_name == "live/interview_ask":
            if role not in self.registry.get_roles():
                raise MissingRoleError(provider="fixture", public_detail="Connect this model role first")
            raw = "<question>你想怎么安排接下来的学习？</question>"
        elif prompt_name == "analysis/toc_infer":
            raw = "<none></none>"
        elif prompt_name == "analysis/course_brief":
            raw = "<brief><summary>资料已整理为可核对的知识地图与真题索引。</summary><top_point>条件关系</top_point></brief>"
        elif prompt_name == "analysis/lesson_recap":
            raw = "<recap>本节课复习了如何从条件出发。</recap>"
        elif prompt_name == "analysis/lesson_check_scope":
            raw = '<check_scope>{"requires_target":true,"uses_later":false}</check_scope>'
        elif prompt_name == "analysis/lesson_plan":
            await asyncio.sleep(0.55)
            course_blob = variables.get("course_context", "")
            kp_matches = re.findall(r'"id":"([^"]+)"', course_blob)
            kp_id = kp_matches[0] if kp_matches else "unprepared-kp"
            existing_blob = variables.get("existing_items", "")
            bank_matches = re.findall(r'"bank_id":"([^"]+)"', existing_blob)
            b1 = bank_matches[0] if len(bank_matches) > 0 else "unprepared-bank-1"
            b2 = bank_matches[1] if len(bank_matches) > 1 else b1
            b3 = bank_matches[2] if len(bank_matches) > 2 else b2
            ex1 = bank_matches[3] if len(bank_matches) > 3 else b1
            ex2 = bank_matches[4] if len(bank_matches) > 4 else b2
            plan_obj = {
                "title": "函数极限与连续性判定",
                "est_minutes": 20,
                "objectives": [{"kp_id": kp_id, "text": "掌握函数极限存在判定与连续性检验"}],
                "segments": [{
                    "id": "s1",
                    "kp_id": kp_id,
                    "kind": "concept",
                    "goal": "理解左右极限与连续性",
                    "est_minutes": 18,
                    "keypoints": ["确认左右极限分别存在", "判断左右极限是否相等"],
                    "approaches": [
                        {"kind": kind, "keypoint": "all", "outline": kind}
                        for kind in ("intuition", "example", "visual", "formal")
                    ],
                    "examples": [{"bank_id": ex1}, {"bank_id": ex2}],
                    "misconceptions": [],
                    "checks": ["c1", "c2", "c3"],
                    "backfills": [],
                    "sources": [],
                }],
                "practice": [],
                "wrap": {"summary_points": ["左右极限存在且相等"], "cards": []},
                "items": {
                    "c1": {
                        "bank_id": b1,
                        "keypoints": [0],
                        "fallback_hints": {"1": "想想极限定义关注的是什么位置。", "2": "分别看看左侧和右侧的趋势。"},
                    },
                    "c2": {
                        "bank_id": b2,
                        "keypoints": [0, 1],
                        "fallback_hints": {"1": "把函数值和两侧趋势分开看。", "2": "比较左极限与右极限是否一致。"},
                    },
                    "c3": {
                        "bank_id": b3,
                        "keypoints": [0, 1],
                        "fallback_hints": {"1": "先分别看左右两侧的极限值。", "2": "检查两侧趋势是否指向同一数值。"},
                    },
                },
            }
            raw = f"<lesson_plan>{json.dumps(plan_obj, ensure_ascii=False)}</lesson_plan>"
        elif prompt_name == "analysis/toc_route":
            blob = variables.get("course_context", "")
            pairs = re.findall(r'"material_id":"([^"]+)"[^}]*"page_no":(\d+)', blob)
            routed = [{"material_id": mid, "page_no": int(pno)} for mid, pno in pairs[:2]]
            raw = f"<pages>{json.dumps(routed, ensure_ascii=False)}</pages>"
        elif prompt_name == "analysis/solve_blueprint":
            bp = {
                "approach_prompt": "先确认题目给出的条件与适用定理，再逐步列出关键关系式。",
                "key_formula": r"f'(\xi) = 0",
                "hints": {
                    "1": "先把已知条件写清楚，检查定理的前提是否满足。",
                    "2": "对核心关系式求导或代入已知量，观察端点与区间范围。",
                },
                "steps": [
                    "第一步：整理已知条件并确认定理前提",
                    "第二步：建立核心方程并化简求解",
                    "第三步：检验结果是否落在题目要求范围内",
                ],
                "pitfalls": ["容易漏掉检验前提条件或忘记排除区间外的解。"],
            }
            raw = f"<blueprint>{json.dumps(bp, ensure_ascii=False)}</blueprint>"
        elif prompt_name == "analysis/solve_feedback":
            fb = {"verdict": "partial", "reply": "方向是对的，再结合前提条件把关键一步补全。"}
            raw = f"<feedback>{json.dumps(fb, ensure_ascii=False)}</feedback>"
        elif prompt_name == "analysis/solve_step_detail":
            detail = {
                "summary": "这一步的核心是先把前提条件逐项核对，再代入公式化简。",
                "substeps": ["先列出题目给出的边界条件。", "把已知量代入核心式子完成化简。"],
            }
            raw = f"<detail>{json.dumps(detail, ensure_ascii=False)}</detail>"
        elif prompt_name == "analysis/mimic_items":
            items = [{
                "type": "choice",
                "stem": "若函数在闭区间连续、开区间可导且端点值相等，则区间内必存在导数为零的点，这一结论是否成立？",
                "options": [{"key": "A", "text": "不成立"}, {"key": "B", "text": "成立"}],
                "answer": "B",
                "solution": "满足罗尔定理全部三个条件，结论必然成立。",
                "difficulty": 2,
            }]
            raw = f"<items>{json.dumps(items, ensure_ascii=False)}</items>"
        elif prompt_name == "analysis/memory_distill":
            blob = variables.get("memory_evidence", "")
            ev_ids = re.findall(r'"evidence":\[\{"id":"([^"]+)"', blob)
            lesson_ids = re.findall(r'"lessons":\[\{"id":"([^"]+)"', blob)
            refs = (
                [{"kind": "evidence", "id": ev_ids[0]}]
                if ev_ids
                else ([{"kind": "lesson", "id": lesson_ids[0]}] if lesson_ids else [])
            )
            memories = (
                [{
                    "kind": "mistake_habit",
                    "kp_id": None,
                    "statement": "解题时需要注意先核对定理前提条件再代入计算。",
                    "evidence_refs": refs,
                }]
                if refs
                else []
            )
            raw = f"<memories>{json.dumps(memories, ensure_ascii=False)}</memories>"
        elif prompt_name == "analysis/memory_synthesize":
            blob = variables.get("memory_evidence", "")
            mem_ids = re.findall(r'"id":"([^"]+)"', blob)
            notes = (
                [{
                    "statement": "先核对前提条件并借助图像直观理解，做题更稳。",
                    "source_memory_ids": mem_ids[:2],
                }]
                if mem_ids
                else []
            )
            raw = f"<synthesis>{json.dumps(notes, ensure_ascii=False)}</synthesis>"
        elif prompt_name == "analysis/reader_ask":
            ans = {
                "explanation": "这段原文强调：函数在一点的极限只取决于该点左右两侧的变化趋势，不要求函数在该点本身有定义。",
                "key_takeaway": "极限看左右趋近，不看该点取值",
                "block_type": "callout",
                "block_content": "判定一点处极限是否存在，只需检查左极限与右极限是否同时存在且相等。",
            }
            raw = f"<answer>{json.dumps(ans, ensure_ascii=False)}</answer>"
        elif prompt_name == "analysis/note_suggest":
            sugs = [{
                "reason": "补充极限存在与函数连续性的易混边界",
                "block_type": "callout",
                "title": "易错对比：极限存在 vs 连续",
                "content": "极限存在只要求左右极限相等；连续还额外要求该点有定义且极限等于函数值。",
            }]
            raw = f"<suggestions>{json.dumps(sugs, ensure_ascii=False)}</suggestions>"
        else:
            raise AssertionError(f"Unexpected tagged prompt: {prompt_name}")
        return parse(raw)

    async def stream_text(self, role, system, messages, **options):
        prompt = str(messages[-1].content)
        if "recent_board" in prompt and "多元函数微分学" in prompt:
            steps = "\n".join([
                r"\mathcal{L}(x, y, z, \lambda) = f(x, y, z) + \lambda \, g(x, y, z)",
                r"\frac{\partial \mathcal{L}}{\partial x} = f_x(x, y, z) + \lambda g_x(x, y, z) = 0",
                r"\frac{\partial \mathcal{L}}{\partial y} = f_y(x, y, z) + \lambda g_y(x, y, z) = 0",
                r"\frac{\partial \mathcal{L}}{\partial z} = f_z(x, y, z) + \lambda g_z(x, y, z) = 0",
                r"g(x, y, z) = x^2 + 2y^2 + 3z^2 - 1 = 0",
                r"\nabla f(x_0, y_0, z_0) = -\lambda \, \nabla g(x_0, y_0, z_0)",
                r"\det \begin{pmatrix} 0 & g_x & g_y \\ g_x & \mathcal{L}_{xx} & \mathcal{L}_{xy} \\ g_y & \mathcal{L}_{yx} & \mathcal{L}_{yy} \end{pmatrix} < 0",
                r"f(x) = f(x_0) + f'(x_0)(x-x_0) + \frac{f''(x_0)}{2!}(x-x_0)^2 + \cdots + \frac{f^{(n)}(x_0)}{n!}(x-x_0)^n + R_n(x)",
                r"R_n(x) = \frac{f^{(n+1)}(\xi)}{(n+1)!}(x - x_0)^{n+1},\quad \xi \in (x_0, x)",
                r"\int_a^b f(x)\,g'(x)\,dx = \Big[f(x)g(x)\Big]_a^b - \int_a^b f'(x)\,g(x)\,dx",
                r"f(b) - f(a) = f'(\xi)(b - a),\quad \xi \in (a, b)",
                r"\frac{f(b) - f(a)}{g(b) - g(a)} = \frac{f'(\xi)}{g'(\xi)},\quad g'(\xi) \neq 0",
                r"\forall x \in (a, c): f'(x) < f'(c) = 0 \implies f(x) \text{ 严格递减}",
                r"\forall x \in (c, b): f'(x) > f'(c) = 0 \implies f(x) \text{ 严格递增}",
                r"f(c) < f(a) = 0 \quad \text{且} \quad f(c) < f(b) = 0",
                r"\lim_{h \to 0} \frac{f(x_0 + h) - 2f(x_0) + f(x_0 - h)}{h^2} = f''(x_0)",
                r"\sum_{k=1}^{n} \frac{1}{k(k+1)} = 1 - \frac{1}{n+1} \xrightarrow{n \to \infty} 1",
                r"\iint_D \left(\frac{\partial Q}{\partial x} - \frac{\partial P}{\partial y}\right) dx\,dy = \oint_{\partial D} P\,dx + Q\,dy",
                r"\iiint_\Omega \nabla \cdot \mathbf{F}\,dV = \iint_{\partial \Omega} \mathbf{F} \cdot \mathbf{n}\,dS",
                r"\| \mathbf{u} + \mathbf{v} \|^2 + \| \mathbf{u} - \mathbf{v} \|^2 = 2(\| \mathbf{u} \|^2 + \| \mathbf{v} \|^2)",
                r"\det(A - \lambda I) = 0 \implies \operatorname{tr}(A) = \sum_{i=1}^n \lambda_i",
                r"\text{结论：先核对前提条件，再结合单调性与边界取值完成全局极值判定。}",
            ])
            yield (
                f'<board id="b-stress-steps" type="steps" title="完整推导步骤与长公式检验（22 行）">{steps}</board>'
                '<board id="b-stress-note" type="text" title="约束条件与边界核对说明">'
                '在验证闭区间连续性与开区间可导性之后，结合导函数严格单调递增推出驻点左侧导数为负、右侧导数为正，从而严格确定唯一全局最小值。'
                '</board>'
                '<say emotion="focused">先看推导步骤。</say>'
            )
            return
        if "recent_board" in prompt and "browser-avatar" in prompt:
            yield (
                '<cue gesture="explain" emotion="focused"/>'
                '<say emotion="focused">先确认已知条件。</say>'
                '<pause ms="1200"/>'
                '<board id="b-text" type="text">先确认已知条件。</board>'
                '<point target="b-text"/>'
            )
            return
        if "recent_board" in prompt:
            yield (
                "<board id=b-text type=text>先确认已知条件。\n再检查边界取值。</board>"
                "<board id=b-steps type=steps title='三步推导示例'>y = x^2 + 1\ny' = 2x\ny'(1) = 2</board>"
                "<mark target=b-steps.1 style=underline color=accent/>"
                "<mark target=b-steps.2 style=box color=warn/>"
                "<mark target=b-steps.3 style=color color=ok/>"
                "<point target=b-steps.2/>"
                "<board id=b-math type=math>x^2+1</board>"
                "<board id=b-table type=table>| x | y |\n|---|---|\n| 1 | 2 |</board>"
                '<board id=b-plot type=plot>{"fn":["a*x^2","x+1"],"x":[-2,2],"points":[[1,1]],"holes":[[0,0]],"labels":[{"at":[1,1],"text":"交点"}],"params":[{"name":"a","label":"系数 a","min":0.5,"max":2,"step":0.5,"default":1}],"keyframes":[{"label":"默认抛物线","values":{"a":1}},{"label":"陡峭抛物线","values":{"a":2}}]}</board>'
                "<board id=b-diagram type=diagram>flowchart TD\nA --&gt;</board>"
                "<say>开始吧。</say>"
            )
            return
        if role not in self.registry.get_roles():
            raise MissingRoleError(provider="fixture", public_detail="Connect this model role first")
        if role == "vision":
            assert any(part["type"] == "image" for part in messages[-1].content)
            yield "公式："
            yield "$x^2+1=0$"
        else:
            yield "测试连接"
            yield "已响应。"

    async def discover_models(self, connection_id):
        return ["fixture-live", "fixture-vision"]

    async def test_connection(self, connection_id):
        return [
            RoleTestResult(role=role, ok=True, latency_ms=1, code="ok", message="Fixture response")
            for role, assignment in self.registry.get_roles().items() if assignment.connection_id == connection_id
        ]

    async def preview_voice(self, text, voice, rate=1, pitch=0):
        raise EdgeUnavailableError("Fixture online voice unavailable")
