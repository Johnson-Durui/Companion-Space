"""The browser harness injects this gateway. Model traffic stays in process."""

import json
import re

from app.llm.gateway import LLMGateway
from app.repositories.mixins.common import utcnow
from app.providers.errors import MissingRoleError
from app.services.provider_registry import RoleTestResult
from app.voice.tts.edge import EdgeUnavailableError


def seed_classroom(container, scenario: str):
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
    teacher = container.tutors.resolve_active_character("tutor-chutang")
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


def seed_empty_course(container):
    repository = container.repository
    now = utcnow().isoformat()
    with repository.connection() as connection:
        connection.execute(
            """INSERT INTO study_spaces(id, name, topic, goal, created_at, updated_at)
               VALUES ('browser-empty-course', '线性代数基础（待上传资料）', '线性代数', NULL, ?, ?)""",
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
            "keypoints": ["确认闭区间连续与开区间可导前提", "结合二阶导数符号判定唯一极值点", "核对边界端点处的取值比较"],
            "checks": ["q1"],
            "approaches": [{"kind": "visual", "keypoint": "all", "outline": "先列条件，再按单调性逐行推导"}],
        }],
        "items": {
            "q1": {
                "type": "choice",
                "kp_id": kp_ids[0],
                "bank_id": f"{lesson_id}-question",
                "keypoints": [0, 1],
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
                '<say emotion="focused">我们先一起把完整的推导步骤和边界条件理清，再来看下面的综合判定题。</say>'
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
                "<board id=b-text type=text>先确认已知条件。</board>"
                "<board id=b-math type=math>x^2+1</board>"
                "<board id=b-table type=table>| x | y |\n|---|---|\n| 1 | 2 |</board>"
                '<board id=b-plot type=plot>{"fn":["x^2"],"x":[-2,2],"points":[[1,1]]}</board>'
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
