# 规格 · 学习者模型、入学访谈、起点诊断与个性化计划

> 对应愿景里的三句话："针对用户的特点（可以向他提问）""形成个性化教学方案""教学过程中不断调整"。
> 原则：**全部用透明、可单测的公式和算法**，不让大模型"凭感觉"决定谁掌握了什么、先学什么。模型只负责提问措辞、解释措辞和文字说明。
> 命名：数据库列叫 `space_id`、`item_ref`；接口与 JSON 字段叫 `course_id`。

## 1. 学习者画像

全局一份（单用户）+ 每门课一份报名信息。

```jsonc
// learner_profile（全局）
{ "nickname": "小林", "level": "undergrad",            // junior | senior | undergrad | postgrad_exam | self_study
  "pace": "normal",                                    // slow | normal | fast
  "encouragement": "normal",                           // more | normal | direct
  "preferred_style_id": "guided",                      // 见 §8
  "interests": ["篮球", "游戏"],                         // 仅用于举例取材
  "approach_order": ["example","intuition","visual","formal","analogy","contrast"],
  "notes": [{"at": "2026-11-20", "text": "对符号推导容易跳步，分步写出来效果好", "evidence_ids": ["…"]}] }

// course_enrollment（每门课）
{ "goal_type": "exam",                                 // exam | homework | interest
  "exam_name": "…", "exam_date": "2026-12-20", "target_score": 85, "full_score": 100,
  "weekly_days": [1,2,3,4,5,6,7], "session_minutes": 30,
  "self_level": "attended_but_lost",                   // never | attended_but_lost | basic | strong
  "hard_units": ["u3", "u5"], "teacher_hints": "老师说第三章必考" }
```

明确**不做**"学习风格测试（视觉型/听觉型）"——没有证据支持按它分配教学方式。偏好只作为初始默认值，之后由真实作答数据修正（§7）。

## 2. 掌握度模型

### 2.1 数据

- `kp_mastery(space_id, kp_id)`：`p`（学生此刻能独立用对该知识点的概率）、`status`、`evidence_count`、`clean_correct_count`（首答、无提示、答对的不同题目数）、`clean_days`（出现过这种"净对"的不同日历日数）、`objective_clean`（净对中是否至少一次来自客观判分）、`inferred`（数值是否只是诊断传播的推测）、`taught_at`、`last_evidence_at`。
- `evidence`：每次作答一条，永不删除。字段：`space_id, kp_id, lesson_id, item_ref(=item_bank.id), source, verdict, hint_level, item_type, n_options, judged_by, via, retry, p_before, p_after, created_at`。
  - `source ∈ diagnostic | lesson_check | probe | practice | skip_verify | backfill | review`
  - `verdict ∈ correct | partial | incorrect | dont_know | revealed`
  - `judged_by ∈ exact`（控件作答按答案精确判分）`| model`（理解器按 rubric 判分）

### 2.2 更新规则（`app/learning/mastery.py`，纯函数）

**一道题的一次出示，只有首答做贝叶斯更新。**

```
g（猜对率）：judged_by=model → 0.25（模型判分偏宽，证据打折）
            否则 choice = 1/n_options（缺省 0.25）；multi = 0.10；numeric = short = 0.05
s（失误率）：p ≥ 0.85 → 0.25（熟手答错更可能是失误）；否则 judged_by=model → 0.15；其余 0.10
w（提示折扣）：作答前已获得的最高提示级别 0/1/2/3 → 1.0 / 0.6 / 0.3 / 0

首答 correct ：post = p(1-s) / ( p(1-s) + (1-p)g )；p1 = p + w·(post - p)
               课内来源（lesson_check / probe / practice / skip_verify / backfill）再做学习转移：p2 = p1 + (1 - p1)·(0.12·w)
               diagnostic 与 review 不做学习转移：p2 = p1
首答 incorrect：p2 = p·s / ( p·s + (1-p)(1-g) )          （不做学习转移——答错永远不会让 p 上升）
首答 dont_know：同 incorrect 但取 g = 0
partial / revealed：p2 = p（照常写证据，p_after = p_before）
review 且首答 incorrect / dont_know：再取 p2 = min(p2, p × 0.75)

同一题的重试（首答之后）：答对 → p ← p + (1 - p)·0.04（仅课内来源；证据 retry=true，不计净对）；答错 → 只写证据，p 不变
"看答案"或示范解法之后出的同构变式题：首答按 hint_level = 1 计（w = 0.6，不计净对）
最后裁剪到 [0.02, 0.98]
```

必须写进单测的数值（保留 4 位小数）：

| # | 初始 p | 证据 | 结果 p |
| --- | --- | --- | --- |
| 1 | 0.15 | 课堂检查，4 选 1，首答答对，无提示 | 0.4619 |
| 2 | 0.50 | 课堂检查，数值题，首答答错 | 0.0952 |
| 3 | 0.60 | 课堂检查，数值题，先要了 2 级提示后首答答对 | 0.7198 |
| 4 | 0.90 | 课堂检查，数值题，首答答错（s=0.25） | 0.7031 |
| 5 | 0.90 | 复习，数值题，首答答错 | 0.6750 |
| 6 | 0.20 | 课堂 rubric 题（模型判分），首答答对 | 0.5243 |
| 7 | 0.50 | 数值题首答答错后，重试答对 | 0.1314 |
| 8 | 0.056 | 4 选 1 首答答错 | 0.0200（裁剪下限；**不得高于初始值**） |

推导（供核对）：#1 post=0.135/0.3475=0.3885，p2=0.3885+0.6115×0.12；#2 0.05/0.525；#3 post=0.54/0.56=0.9643，p1=0.6+0.3×0.3643=0.7093，p2=0.7093+0.2907×0.036；#4 0.225/0.32；#5 min(0.7031, 0.675)；#6 post=0.17/0.37=0.4595，p2=0.4595+0.5405×0.12；#7 0.0952+0.9048×0.04。

必须成立并写成测试的性质：答对不降、答错不升；提示 3 级与 `partial/revealed` 不改变 p；同一题连错三次只有一次贝叶斯更新；从先验 0.08–0.20 出发，连续净对 4 选 1 需要 3 次、数值题需要 2 次才到 p ≥ 0.85；随机猜对两道 4 选 1 只会到约 0.68–0.83。

### 2.3 状态判定

```
unseen   ：没有证据且未被教过
learning ：有证据或已教，p < 0.50
shaky    ：0.50 ≤ p < 0.85；或 p ≥ 0.85 但尚不满足 mastered 的全部条件
mastered ：p ≥ 0.85 且 clean_correct_count ≥ 2 且 clean_days ≥ 2 且 objective_clean = true
           （该 KP 没有任何客观题时豁免最后一条，并在界面标注"由老师评阅"）
```

- `p ≥ 0.85`、净对 ≥ 2 但只发生在同一天：界面显示"今天学会了，待复习确认"（仍属 shaky）。计划不再为它排新课；课后自动生成的题卡在 1–3 天后到期，答对即转为 mastered。
- `inferred = true`（只来自诊断传播）的数值在界面显示"推测"，不显示任何掌握状态。
- 任何地方向学生展示"已掌握"都必须来自这个判定，不得由模型口头宣布。

### 2.4 初始先验

未诊断时按自报水平：`never` 0.08，`attended_but_lost` 0.20，`basic` 0.50，`strong` 0.70；学生标为"最头疼"的单元再 ×0.7。

## 3. 入学访谈（Interview）

由老师角色以对话形式进行（文字/语音均可），每问配快捷芯片 + 自由输入。**问题固定为下面 6 组**；模型只做两件事：把问题说得像这个角色（模板 `live/interview_ask`）、把自由回答抽取成结构（模板 `live/interview_slot`，抽取失败就让学生点芯片）。全程 ≤3 分钟，可随时"跳过，用默认值"。

| # | 要弄清的事 | 芯片示例 | 写入字段 |
| --- | --- | --- | --- |
| 1 | 怎么称呼、现在什么阶段 | 高中 / 大学 / 考研 / 自学 | nickname, level |
| 2 | 学这门课为了什么；有考试的话哪天考、目标多少分 | 期末考试 / 写作业 / 纯兴趣；日期选择器 | goal_type, exam_name, exam_date, target_score |
| 3 | 每周哪几天能学、每次多久 | 15 / 30 / 45 分钟；工作日 / 每天 | weekly_days, session_minutes |
| 4 | 现在的感觉 | 完全没学 / 上过课但跟不上 / 基本会但做题不稳 / 想冲高分 | self_level |
| 5 | 哪几章最头疼（列出课程地图的单元供点选）；老师有没有划重点 | 单元芯片；文本框 | hard_units, teacher_hints |
| 6 | 喜欢怎么被教 | 多举例子 / 一步步推导 / 先给结论 / 边做题边讲；语速；多鼓励 / 直接点 | preferred_style_id, approach_order, pace, encouragement |

`teacher_hints` 由 analysis 模型映射到 KP（模板 `analysis/hints_to_kp`，输出 KP id + 引用的原话），命中的 KP 在计划权重里 ×1.5。

## 4. 起点诊断（Placement）

目的：用尽量少的题，找出哪些已经会、哪些不稳、哪些没学。

- **题源**：只用**已复核的客观题**（choice / multi / numeric），来自题库中 `purpose=diagnostic` 的题（由课程分析的 S7b 准备，不含模考保留卷）。每个 KP 最多出 1 题。
- **流程**：≤12 题、≤8 分钟；每题有醒目的"不会，跳过"按钮；过程中不讲解，只给一句轻反馈；结束后出"起点图"。
- **选题**（`app/learning/placement.py`，确定性）：

```
W(k)    = w_k + 0.5 × Σ w_d            （d 为 k 的直接后继；w 为 §5.1 的考试权重）
info(k) = ( W(k) / max_j W(j) ) × 4 × p_k × (1 - p_k)          （归一化到 0–1）
每步选 info 最大的 KP（并列按教材顺序，再按 kp_id）；"同一单元不连续出两题"只在别的单元还有候选时生效
```

- **作答后传播**（只在诊断阶段；被传播的 KP 记 `inferred = true`）：
  - 答错/不会且更新后 p < 0.30：其直接后继中尚无证据的 KP，`p ← p × 0.6`；
  - 答对且（题型是 numeric，或更新后 p ≥ 0.85）：其直接前置中尚无证据的 KP，`p ← max(p, 0.70)`。
- **停止**：已答 ≥6 题且剩余候选的最大 info < 0.15；或 12 题；或 8 分钟；或学生点"够了"；或候选耗尽（允许少于 6 题）。
- 题池为空（没有任何已复核的客观题）→ `placement_status = "skipped"`，起点图标注"按你的自述估计"，**不得用未复核的题凑数**。
- **产出**：起点图（单元 × 状态色块，推测值单独标注）+ 三句话结论（模板 `live/placement_summary`，输入是代码算出的事实）。

## 5. 个性化计划（Planner）

`app/learning/planner.py`：`plan(inputs, today) -> Plan`，确定性（`today` 是显式参数）；模型只用来给每节课起标题（模板 `analysis/plan_titles`）。

### 5.1 输入量

**考试权重 w_k**（全课程归一化到和为 1）：

```
r(卷)   = exp( -0.35 × (Y_max - 该卷年份) )      Y_max = 本课程试卷的最大年份；缺年份按 Y_max - 3
share_k(卷) = 该卷中 KP k 分得的分值 / 卷面满分    一题挂多个 KP 时分值均摊；缺分值时每题等权
E_k     = Σ_卷 r·share_k(卷) / Σ_卷 r
Ê_k     = E_k / Σ_j E_j
Î_k     = prior_k / Σ_j prior_j                  prior：core 1.0 / important 0.6 / peripheral 0.3
w_k     = 0.7·Ê_k + 0.3·Î_k                      没有任何真题时 w_k = Î_k
```

课程分析的 S7 算到这一步并存入 `kp_exam_stats.weight`。计划时再做：命中考纲或 `teacher_hints` 的 KP ×1.5（只乘一次）→ 封顶为均值的 6 倍（只做一次）→ 重新归一化。

- `gap_k = 1 - p_k`。
- `m_k`（预计分钟）= `base(kind) × diff_mult × (0.5 + gap_k)`；`base`：concept 10、theorem 12、formula 8、method 15、skill 15、fact 5、未知种类 10（并记警告）；`diff_mult`：难度 1/2/3 → 0.8/1.0/1.3。
- **不进新课的 KP**：`mastered`；`p ≥ 0.85`（待确认，在最近一次练习里放 1 道确认题，答错再排课）；`assumed = true` 的外部前置（只作为课中回补的候选）。
- **容量 C**：`today` 到考试日前一天、按 `weekly_days` 数出的学习次数 N × `session_minutes` × 0.65（其余留给开头的复习热身、练习与模考）。考试日期 ≤ `today` 或一个学习日都没有 → 不设容量上限，并提示学生修改日期；没有截止日期 → 不设上限。

### 5.2 算法

```
1. 价值 v_k = w_k × gap_k。
2. 选集（带前置闭包的贪心）：候选 k 的成本 = m_k + 其尚未入选的未掌握前置的分钟数之和。
   循环：在"成本 ≤ 剩余容量"的候选里取 v/成本 最大者（并列按教材顺序，再按 kp_id），连同前置闭包入选；没有放得下的就停止。
   一个都放不下 → 入选 v/成本 最大的那一个闭包，标记 over_capacity = true，界面明说。
   未入选的进入 deferred，并统计其合计权重。
3. 排序：在入选集合上做 Kahn 拓扑排序；就绪集合内的优先级 = 0.6 × 入选先后名次 + 0.4 × 教材顺序名次，并列按 kp_id。
4. 装箱：每节课的新课时长上限 L = session_minutes × 0.65。按顺序放入：当前课为空，或放入后不超过 L 且已有 KP 数 < 3 → 放入；否则另起一节。
   单个 KP 的 m_k 超过 L 时独占一节课。
5. 插入：每 4 节新课后插 1 次 practice（题目取自最近 4 节课的 KP 的已复核题；没有可用题则不插）；
   存在模考保留卷（见课程分析 S6）时，在时间线约 80% 处插 mock。
6. 排期：按 weekly_days 把各项依次落到 today 之后的日期；若末尾超过考试日，从末尾把新课移入 deferred 直到不超。
7. 每节课的"为什么先学它"由代码按模板生成（文案模板放在界面文案文件里），例如"近 5 年考了 4 次，约占 8 分 · 你现在掌握约 20%"。
```

- 没有任何未掌握的 KP → 计划只含练习、模考与复习。
- 时间不够时必须明说取舍："按现在的时间，我会先保住约 78% 分值的考点；这些内容暂时放弃：…（合计约 22%）。想全学完，每次需要 45 分钟或每周多学 2 天。"
- 学生可以把某节课置顶/顺延（记为 `pinned`，重排时保留），或对某节课点"我会了"：对该课每个 KP 各取 1 道已复核的客观题组成小测（证据来源 `skip_verify`）；全部首答答对 → 该计划项标记 `skipped`；任一 KP 没有可用题 → 按钮置灰并说明原因。

### 5.3 重排（replan）

- 触发：每节课结束、诊断结束、截止日期/时间预算变化、新增资料或真题分析完成。
- 稳定性：已完成和 `pinned` 的项不动；未开始且未置顶的相邻两项，只有当新顺序中二者 `v/成本` 之比 > 1.10 时才交换。
- 每次重排生成新 `plan_version`，记录一句变化原因，供学生查看"计划为什么变了"。
- 上一节课没上完（`carry_over_json`）→ 未完成的 KP 生成新的计划项，排在下一节。

## 6. 复习与错题本

- 依赖现有 `fsrs`（py-fsrs，MIT）。表 `review_cards`：`kind ∈ {flashcard, item}`、`kp_id`、`front/back` 或 `item_ref`、`fsrs_json`、`due_at`、`state`。
- 卡片来源：课后 `wrap.cards`（flashcard）；课堂/练习中答错或看过答案的题（item，同时进入错题本）；每个达标 KP 的 1 张确认题卡（item）。
- 每日队列：到期卡按 due 排序，默认上限 20；每次上课开头先做 ≤5 分钟热身（最多 5 张，优先与本课前置相关的卡）。
- 评分：`flashcard` 由学生自评 Again/Hard/Good/Easy，**只更新该卡的 FSRS 状态，不写证据、不改掌握度**；`item` 卡按作答自动映射（错=Again，带提示对=Hard，净对=Good），并写 `evidence(source=review)` 按 §2.2 更新掌握度。
- 错题本：按 KP/时间筛选，显示当时的错误答案与错因；同一题隔天净对 2 次后归档。

## 7. 讲法有效性学习

- 表 `approach_stats(kind, n, success)`：某讲法之后的第一道检查题首答无提示答对记 success。
- 排序分 = `(success + 1) / (n + 2)`；并列按 `approach_order`。
- Director 选讲法：当前要点可用的讲法中，先按风格的首选偏置（§8），再按排序分，取第一个未用过的。

## 8. 讲课风格与角色（两者正交）

- **角色**决定"怎么说话"：称呼、口吻、口头禅、情绪表达、声音、形象。
- **讲课风格**决定"怎么教"，学生可在课堂上随时切换。风格只改变**措辞**与 Director 的**两个参数**，不改变 Move 的契约、检查频率、提示阶梯和达标标准。规则文本放 `libs/prompts/v3/styles/<id>.md`，每个文件另声明 1–2 条**可由课堂事件计算**的特征，供评测报告符合率。

| id | 名称 | 措辞规则要点 | predict_before_explain | 首选讲法偏置 | 可计算特征（示例） |
| --- | --- | --- | --- | --- | --- |
| `guided` | 循循善诱（默认） | 讲解中用设问引出下一句，设问后立刻自己回答，不停下来等学生 | 是 | 无 | 每个 EXPLAIN 至少 1 个设问句 |
| `direct` | 直截了当 | 先给结论再给理由；句子短；不用反问 | 否 | 无 | 平均句长 ≤30 字 |
| `analogy` | 生活类比 | 新概念先给贴近学生兴趣的类比，再回到严格表述 | 否 | analogy | 每个要点的首次讲解用 analogy 讲法 |
| `exam` | 应试提分 | 强调题型套路、得分点、常见陷阱；多用真题 | 否 | example | 检查题优先取自真题 |
| `rigorous` | 严谨推导 | 每一步写出依据；符号规范 | 否 | formal | 每个 EXPLAIN 的白板推导 ≥2 行 |

- `predict_before_explain`：为真且当前 KP 掌握度 ≥0.4 时，讲新要点前先请学生猜一猜（`PREDICT`，不判分）。掌握度 <0.4 不预测——对新手一味反问只会增加挫败，这就是"新手保护"。

## 9. 给生成模型的"学习者摘要"

由代码拼装（≤150 字），每个 Beat 注入：称呼、阶段、目标与剩余天数、本课相关的 3 个最弱前置及其掌握度、未解决的迷思、风格/语速/鼓励偏好、兴趣。不要把整份画像原样塞给模型。

## 10. 必须具备的测试

- `test_mastery.py`：§2.2 的 8 组数值与全部性质；状态判定（含"同一天不能 mastered"、"无客观净对不能 mastered"、推测值不显示状态）。
- `test_placement.py`：选题确定性；归一化后的停止条件在 5 / 30 / 400 个 KP 的课程上都合理（不是固定 6 题就停）；传播规则与 `inferred`；题池为空时跳过；"不会"路径。
- `test_planner.py`：权重公式（手算小例）；任何输出都满足前置顺序且不超容量；一个都放不下时的 `over_capacity`；考试日期已过；全部已掌握；`pinned` 保留；同输入同输出；deferred 权重统计；稳定性阈值；`assumed` 的 KP 不被排课。
- `test_interview.py`：6 个槽位的抽取成功/失败/跳过路径与默认值。
- 复习相关测试的归属：卡片生成与错题入库随课堂（M4）；队列、评分与遗忘随复习界面（M7）。
