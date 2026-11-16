# 规格 · 资料理解：从文件到"课程地图 + 考情"

> 对应愿景："用户把要学的知识导入，AI 自动分析"以及"老师不看考题趋势、把力气花在不考的地方"。
> 旧实现只做了"切块 + 检索"，没有任何对资料本身的理解。本规格定义完整的分析流水线。

## 1. 产物总览

一门课分析完成后，数据库里应当有：

| 产物 | 表 | 用途 |
| --- | --- | --- |
| 逐页规范化文本（Markdown + LaTeX） | `material_pages` | 一切后续分析的输入；课堂上"展示原页" |
| 章节树 | `material_sections` | 课程结构、连贯排课 |
| 检索索引 | 现有 chunks / FTS / 向量 | 课堂答疑取材、引用 |
| 单元与知识点（含前置关系） | `units`, `knowledge_points`, `kp_edges` | 课程地图、诊断、计划、教案 |
| 题目（真题/习题，映射到知识点） | `exam_papers`, `exam_items`, `item_kp` | 考情统计、模考 |
| 可判分题库（已复核） | `item_bank` | 诊断题、课堂检查题、练习、复习题卡——**所有判分都只认这里的题** |
| 考情统计 | `kp_exam_stats` | 计划权重、"为什么先学它" |
| 课程简报 | `study_spaces.brief_json` | 课程首页 |

所有阶段：**幂等、可断点续跑、有进度事件、有 token 记账**。
命名：数据库表与列以 `architecture-and-data.md` §4 为准（课程表是 `study_spaces`，列是 `space_id`）；接口与 JSON 里叫 `course_id`。

## 2. 资料角色

导入时每个文件带一个角色（按文件名+首页内容自动猜，用户可改）：

`textbook` 教材/讲义 · `slides` 课件 · `notes` 笔记 · `exam` 真题/试卷（附加：年份、考试名称、是否含答案） · `exercise` 习题/作业 · `syllabus` 考纲/老师划的重点

- `textbook/slides/notes` → 走知识点抽取；`exam/exercise` → 走题目抽取；`syllabus` → 只用于调整知识点重要度（映射到 KP 后权重 ×1.5）。
- 支持格式（首批）：PDF（文字版与扫描版）、PPTX、DOCX、Markdown、TXT、图片（PNG/JPG/WEBP）、粘贴文本。

## 3. 流水线

```
S1 解析 → S2 结构 → S3 切块与索引 → S4 知识点抽取(map) → S5 归并与建图(reduce)
        └→ S6 题目抽取与映射 → S6b 答案复核并入题库 → S7 考情统计 → S7b 诊断题池 → S8 课程简报
```

### S1 解析为"逐页规范文本"

`material_pages(material_id, page_no, markdown, source, quality, image_path)`，`source ∈ {text, vision, ocr, pasted}`。

| 输入 | 做法 | 依赖（许可） |
| --- | --- | --- |
| PDF 文字层 | 沿用现有 pypdf 逐页抽取；计算"有效字符数/乱码率" | pypdf（BSD） |
| PDF 页面图像 | 渲染为 ≤1600px 的 JPEG，存 `storage/courses/<id>/pages/`，供视觉转写与课堂展示原页 | pypdfium2（Apache-2.0/BSD-3） |
| 扫描页/公式密集页 | 判定：有效字符 < 50 或乱码率 > 30% 或数学符号丢失明显 → 标记 `needs_vision`，走视觉转写 | — |
| PPTX | 每页：标题、正文、备注、表格 → Markdown；内嵌图片导出（文字少的页送视觉转写） | python-pptx（MIT） |
| DOCX | 标题层级、段落、表格 → Markdown | python-docx（MIT） |
| 图片 | 直接视觉转写 | — |
| MD/TXT/粘贴 | 原样，按标题或固定长度分"虚拟页" | — |

- **视觉转写**（`vision` 角色模型）：提示词见 `prompts.md` 的 `page_transcribe`——"忠实转写为 Markdown；公式用 LaTeX；表格用 Markdown 表格；插图写成 `![图：一句话描述]`；不得添加原文没有的内容"。并发 3；按图像哈希缓存。
- **没有可用视觉模型时**：扫描页保留图像、`quality=0`，UI 明确提示"有 N 页是扫描件，需要连接支持图片的模型才能读取"，**不得静默跳过**，也不得用乱码文本继续分析。
- 可选离线 OCR（RapidOCR/ONNX，Apache-2.0）作为后置里程碑的扩展包，不进首发依赖。
- 禁止引入 AGPL/GPL 解析库（PyMuPDF、MinerU 等）到依赖；用户自己装了可通过"外部解析器命令"扩展点调用（后置）。

### S2 结构

`material_sections(id, material_id, parent_id, level, title, page_start, page_end, ord)`。来源优先级：PDF 书签 → Markdown 标题（视觉转写/DOCX/PPTX 标题）→ analysis 模型根据"每页前 200 字"推断目录 → 兜底每 8 页一个伪章节。

### S3 切块与索引

- 按章节内段落切块：目标 500–800 中文字符，重叠 80；每块带 `material_id, section_id, page_no`。
- FTS5 改用 `trigram` 分词（中文可用）；向量：若已配置 `embedding` 角色则调用，否则仅用 FTS（旧的本地"哈希向量"只在没有任何嵌入模型时作为兜底，UI 标注"检索质量：基础"）。
- 新增 `retrieve_for_kp(kp_id, k)`：先取该 KP 的 `source_refs` 对应块，再用 KP 名称+摘要做混合检索补足。

### S4 知识点抽取（map）

- 单位：叶子章节；超过约 6000 字的章节按段落切成多个窗口。每个窗口调用一次 analysis 模型，输出标签块（模板 `kp_extract`）：

```
<kp name="夹逼定理" kind="theorem" importance="core" difficulty="2">
<summary>若 g≤f≤h 且 g、h 极限同为 L，则 f 的极限为 L。</summary>
<must_know>
- 条件：两侧函数极限存在且相等
- 用法：对难求的函数做上下放缩
</must_know>
<formula>$$g(x)\le f(x)\le h(x),\ \lim g=\lim h=L \Rightarrow \lim f=L$$</formula>
<prereq>函数极限的定义；不等式放缩</prereq>
<pitfall>- 只放缩了一侧
- 两侧极限不相等仍套用</pitfall>
<question_types>求极限（放缩）；证明</question_types>
<pages>12-13</pages>
</kp>
```

- `kind ∈ {concept, theorem, formula, method, skill, fact}`；`importance ∈ {core, important, peripheral}`；`difficulty ∈ {1,2,3}`。
- 粒度准则（写入提示词）：一个知识点 = 能用一道题检验的最小可教单元；每个窗口 3–10 个；不为趣闻/历史背景建点（除非会考）。
- 资料文本以"不可信数据块"注入（见 `llm-gateway.md` §6）。

### S5 归并与建图（reduce）

1. **去重**：名称规范化（全半角、大小写、去标点空白）后相同 → 合并；有嵌入时余弦 ≥ 0.90 → 合并；0.80–0.90 或"同名不同章"的可疑对，分批让模型判定"是否同一知识点"。合并保留：来源并集、最完整摘要、最高重要度。
2. **前置关系**：把 `prereq` 文本解析到已有 KP（名称/向量匹配）；再按单元让模型在"仅限给定 id 列表"内补全缺失的前置边。无法解析且被 ≥2 个 KP 引用的前置 → 建一个 `assumed=true` 的外部前置 KP（如"高中三角函数"，无来源页，教学时注明"这部分不在你的资料里"）。
3. **去环**：保证是 DAG——出现环时删除"指向教材中更靠后知识点"的那条边。
4. **单元**：顶层章节 = 单元；KP 的教材顺序 = 首个来源页。
5. **规模自检**：KP 总数异常（每百页 < 10 或 > 200）给出警告；随机抽 5 个 KP 做"摘要是否被来源页支持"的忠实度抽检（模板 `analysis/kp_faithful`），结果作为"分析质量"显示，偏低时建议换更强的 analysis 模型。

稳定性：KP 的 `id` 一旦生成不随重分析变化（按规范化名称 + 单元匹配回旧 id）；用户手工编辑过的字段标记 `locked`，重分析不覆盖。

### S6 题目抽取与映射

- **切题**（模板 `exam_segment`）：逐页/跨页把试卷切成题目，输出：

```
<item no="3" type="choice" score="5">
<stem>求 $\lim_{x\to 0}\dfrac{\sin 3x}{x}$</stem>
<option key="A">0</option><option key="B">1</option><option key="C">3</option><option key="D">不存在</option>
<answer>C</answer>
<solution>…（原卷若有解析则抄录，没有则留空）</solution>
<figure page="2"/>
</item>
```

- 答案常在卷尾：第二遍按题号把 `<answer no="3">C</answer>` 贴回。大题的小问拆成 `sub` 子项。
- **映射到知识点**（模板 `item_map`）：每题先用检索取 8 个候选 KP（名称+摘要），再让模型选 1–3 个并给出把握度；选不出 → `unmapped`（在课程地图里单列"未归类题目"，提示用户可能缺教材章节）。
- **题型映射**（试卷题型 → 引擎题型）：`choice→choice`，`multi→multi`，`numeric→numeric`，`blank→short`（`accepted` = 官方答案 + 经等价判定确认的 1–3 个等价写法），`short→short`，`proof→steps`，`essay→explain`。`steps/explain` 需要 rubric：有官方解析时由 analysis 模型从解析提炼给分点；没有解析的只用于"一起分析"，不进题库。
- **模考保留卷**在本阶段结束时确定：完整真题 ≥3 套时，把年份最新的一套标记 `reserved_for_mock = 1`，否则不保留（计划不插模考，并提示"再上传一套真题即可安排模考"）。保留卷的题只参与考情统计与模考，不进诊断、教案与练习。
- 表：`exam_papers`、`exam_items`、`item_kp`（见架构规格 §4）。

### S6b 答案复核并入题库（`ItemVerifier`，全项目唯一定义；备课时复核新题也用它）

`verify(item) → verified | disputed | unverified`

1. **独立求解**（模板 `analysis/item_solve`，使用 `checker` 角色：未单独配置时回落到 `analysis` 模型并使用不同的温度）：只给题干；选择题先**不给选项**求解一次，再把结果映射到选项——映射不到或映射到两个以上选项 → 该题 `unverified`。
2. **比较**（模板 `analysis/item_equiv`；数值题先按容差直接比较；表达式可选用 SymPy 数值代入，见网关规格 §7）：
   - 有参考答案（官方或出题时给出的）：求解结果与参考答案等价、`confidence=high`、不是 `INVALID`、且参考解答的最终结论与参考答案等价 → `verified`。
   - 不一致 → 再独立求解一次：与参考答案一致 → `verified`；与第一次求解一致 → `disputed`；三者互不相同 → `unverified`。
   - 没有参考答案：两次独立求解一致 → 以其为答案，`verified`；否则 `unverified`。
   - **任何情况下都不改写题目原有的答案。**
3. **rubric 题**（`explain/steps`）：checker 只看题干作答，再用模板 `analysis/rubric_cover` 判断每个必需给分点是否被覆盖；全覆盖 → `verified`；否则让出题方重写 rubric 一次，仍不通过 → 丢弃。
4. **结果的用途**：只有 `verified` 可用于判分、诊断与掌握度；`disputed` 只可在课堂上"一起分析"并注明"这道题的答案有争议"；生成题不是 `verified` 就丢弃并补题。
5. **入库**：每道 `verified` 的题写入 `item_bank`（`origin ∈ exam | textbook | generated`，真题带 `exam_item_id`）。`item_bank.id` 是题目的唯一身份：教案里的题带 `bank_id`，证据与复习卡的 `item_ref` 都存它。
6. 取值统一：`exam_items.answer_status ∈ official_verified | official_disputed | solved_verified | unverified`；`item_bank.verify_status` 与教案 `items[].verify.status ∈ verified | disputed | unverified`。

### S7 考情统计（纯代码）

对每个 KP 计算并存入 `kp_exam_stats`：

```
n_items            出现题数
score_share        平均每卷分值占比 = mean_over_papers( 该 KP 分得的分值 / 卷面满分 )，一题多 KP 时分值均摊；缺分值时每题等权
recency_weight     Σ_items exp(-0.35 × (Y_max - 题目年份))        Y_max = 本课程试卷的最大年份；年份缺失按 Y_max - 3（不使用"当前年"，保证结果不随日期变化）
trend              至少 3 个不同年份时，对"年份→当年分值占比"做最小二乘，斜率 > +0.5 个百分点/年 = rising，< -0.5 = falling，否则 stable
types              题型分布
novel_flags        "新考法"标记：最近一年出现、而此前年份从未出现过的（KP, 题型）组合
weight             考试权重 w_k（公式见 learner-model-and-planning.md §5.1；这里存"乘老师重点之前"的值）
```

没有真题时界面明示"当前按教材重要度估计，上传真题会更准"。

### S7b 诊断题池（任务种类 `diag_pool`）

为权重最高的 ≤30 个 KP 各准备 1–2 道**已复核的客观题**（choice / multi / numeric，难度 2 优先）：先从 `item_bank` 里取真题（不含模考保留卷），不足再生成并经 S6b 复核；写入 `item_bank`（`purpose = diagnostic`）。

### S8 课程简报

`study_spaces.brief_json`：页数/章节数/知识点数/题目数、预计总学时、分值最高的 10 个知识点、"占分很低可以后放"的清单、一段 150 字内的课程概述（模型生成）。

## 4. 任务编排

- 任务使用统一的 `jobs` 表与 `JobRunner`（架构规格 §4、§8），`kind ∈ parse | structure | index | kp_extract | kp_reduce | exam_extract | item_verify | exam_stats | diag_pool | brief`；**不另建任务表**。启动时恢复未完成任务。
- LLM 调用统一经 `LLMGateway.complete_tagged(..., cache=True)`，缓存键 = `sha256(模型名 + 渲染后的提示词)`，表 `llm_cache`。重跑不重复花钱。
- 并发：全局信号量（默认 4）；429/超时退避重试（网关负责）。
- **预估与确认**：开始分析前按"页数 × 经验 token 系数"估算 token 量（若预设里有价格则换算成金额），超过 30 万 token 时让用户确认；过程中实时显示已用量。
- 进度事件：`GET /api/v2/courses/{id}/analysis/events`（SSE），事件含阶段、百分比、可读文案（"正在读第 3 章 · 已发现 42 个知识点 · 已分析 2/5 套真题"）。
- 增量：新增资料只跑它自己的 S1–S4/S6，再做一次 S5/S7（归并进现有地图，id 稳定），然后触发重排计划。
- 失败可见：任何阶段失败都要在 UI 显示原因与"重试该阶段"，不允许静默生成空地图。

## 5. 课程地图界面需要的后端接口（摘要）

```
POST /api/v2/courses                               创建课程（名称、目标可后填）
POST /api/v2/courses/{id}/materials                上传（multipart，多文件，带 role/year/name）
GET  /api/v2/courses/{id}/materials                列表（含解析状态、扫描页数量）
POST /api/v2/courses/{id}/analysis/start           开始/继续分析（返回预估）
GET  /api/v2/courses/{id}/analysis/events          SSE 进度
GET  /api/v2/courses/{id}/map                      单元 → 知识点（含权重、考情、掌握度、前置）
PATCH /api/v2/courses/{id}/kps/{kp_id}             用户修订（改名、重要度、前置、合并、删除）
GET  /api/v2/courses/{id}/exam-items?kp_id=…       题目浏览
GET  /api/v2/materials/{id}/pages/{n}/image        原页图像（课堂 image 块使用）
```

## 6. 必须具备的测试

- 解析：文字 PDF / 扫描 PDF（无视觉模型时的显式提示）/ PPTX / DOCX / 图片 各一份小样本（测试夹具自己生成，不提交受版权保护的材料）。
- 标签块解析：`kp_extract`、`exam_segment` 的正常、缺字段、嵌套 LaTeX、被截断输出。
- 归并：同名合并、近义合并（用假嵌入）、前置解析、去环后仍是 DAG、id 稳定性、`locked` 字段不被覆盖。
- 考情统计：手工构造 3 年 × 2 套卷的数据，核对 `score_share / recency_weight / trend / novel_flags / weight`；结果不随系统日期变化。
- 复核器（用测试替身 LLM）：一致、不一致后第二次支持参考答案、不一致后第二次支持 checker（disputed）、三者互异、无参考答案两次一致/不一致、选择题无法映射到选项、`INVALID`、rubric 全覆盖/缺必需点——各一条路径；断言从不改写原答案；断言只有 `verified` 入题库。
- 模考保留卷：1 套、2 套、3 套真题三种情况；保留卷的题不出现在诊断题池。
- 任务：阶段中断后重启续跑；缓存命中不再调用模型；失败阶段可单独重试。
- 真实模型评测（有密钥时）：对仓库自带的原创示例教材章节跑完整流水线，人工核对清单见 `MILESTONES.md` M2。
