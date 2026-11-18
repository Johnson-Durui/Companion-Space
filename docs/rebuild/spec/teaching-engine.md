# 规格 · 教学引擎（Teaching Engine）

> 本文件是重塑的心脏。产品"像不像一对一老师"，90% 由这里决定。
> 核心原则一句话：**教学策略由代码决定（可测试），讲解表达由模型生成（有人味）**。
> 旧实现的两个极端都要避免：① 写死剧本（旧 `pedagogical_orchestrator.py`）；② 放任模型自由聊天（旧 `companion` 对话）。
> 本文件是 Move、事件、标签的唯一权威定义；其他文件与此不一致时以这里为准。

## 1. 设计目标

| 目标 | 可验证的表现 |
| --- | --- |
| 老师主导节奏 | 一段讲完自动进入下一段；每讲完一个要点必有一次理解检查 |
| 不懂可以一遍一遍讲，每遍都不一样 | 同一要点连续 3 次"没听懂"，3 次重讲的讲法两两不同、且不同于第一次讲解 |
| 先引导，不直接给答案 | 答错后走提示阶梯：点拨 → 缩小范围 → 示范解法；前两级不得泄漏答案 |
| 但绝不把学生卡死 | 随时可以要提示、可以"看答案"（该题不计掌握证据，随后必须跟一道同类题）。依据：只问不答的辅导产品会被学生弃用 |
| 发现前置漏洞会回补 | 开场小问答错、连续困惑、或错选项指向前置时，插入一次回补再回到原位置 |
| 题目答案必须可靠 | 检查题、例题、练习题全部在备课阶段完成独立复核；课堂上模型不临场出题、不临场解题 |
| 讲解与板书同步 | 模型输出"说话 + 板书操作"的单一有序流，前端按序执行 |
| 随时可打断、可离开 | 学生开口/点击即停；学生不回应时最多提醒一次然后暂停，**沉默永不记为"不会"** |
| 全程可恢复、可回放 | 每个事件落库；刷新或断线后从断点继续，不重复记证据 |

## 2. 术语

课程 Course（旧"学习空间"）· 知识点 KP · 一节课 Lesson · 教案 LessonPlan · 环节 Segment（围绕一个 KP）· 要点 Keypoint（环节内 2–3 条）· 节拍 Beat（老师一次连续输出，对应一个 Move）· 教学动作 Move · 提问 Ask（等待学生回应的点）· 课堂流协议 LSP。

## 3. 生命周期

```
prepare（备课，analysis 模型，后台任务）  生成教案 → 逐题/逐例复核 → 存库
run（上课，live 模型，实时）              事件 → Director.decide() → Realizer 生成 LSP 流 → 前端时间线执行
finish（收尾）                            结算证据 → 课后小结 → 复习卡/错题 → 重排计划 → 预备下一节
```

计划生成或重排后，自动为接下来两节课排队备课。学生点"开始上课"时教案未就绪 → 显示备课进度；备课失败 → 显示原因与重试，**不得无教案开讲**。

## 4. 教案 LessonPlan

### 4.1 结构（存 `lesson_plans.plan_json`）

```jsonc
{
  "title": "…", "est_minutes": 28,
  "objectives": [{"kp_id": "kp_0012", "text": "学完能做到……（可观察的行为）"}],
  "segments": [{
    "id": "s1", "kp_id": "kp_0012", "kind": "concept",        // concept | method | worked_example
    "goal": "…", "est_minutes": 9,
    "keypoints": ["…", "…"],                                   // 2–3 条
    "approaches": [                                            // 讲法提纲，不是逐字稿
      {"kind": "intuition", "keypoint": "all", "outline": "…"},
      {"kind": "example",   "keypoint": 0,     "outline": "…"},
      {"kind": "visual",    "keypoint": 0,     "outline": "…", "board": {"type": "plot", "spec": {}}},
      {"kind": "formal",    "keypoint": "all", "outline": "…"},
      {"kind": "analogy",   "keypoint": 1,     "outline": "…"},
      {"kind": "contrast",  "keypoint": "all", "outline": "…"}
    ],                                                         // 每个要点可用的讲法（自身 + all）≥ 4 种 kind
    "examples": [{"id": "e1", "keypoint": 0, "stem": "…", "steps": ["…"], "answer": "…", "verify": {"status": "verified"}}],   // ≥2，已复核
    "misconceptions": ["…"],
    "checks": ["c1", "c2", "c3", "c4"],
    "backfills": [{"kp_id": "kp_0007", "summary": "3 句以内的补讲提纲", "check": "b1"}],   // 掌握度 <0.6 的直接前置，按掌握度升序最多 2 个
    "sources": [{"material_id": "m1", "page_start": 12, "page_end": 13}]
  }],
  "practice": ["x1", "x2"],
  "wrap": {"summary_points": ["…"], "cards": [{"front": "…", "back": "…", "kp_id": "kp_0012"}]},
  "items": {                                                   // 本课全部题目；**这一段永远不下发给前端**
    "c1": {
      "bank_id": "ib_…",                                       // 题目的唯一身份（item_bank.id），证据与复习卡都引用它
      "type": "choice", "kp_id": "kp_0012", "keypoints": [0], "difficulty": 1, "variant_of": null,
      "stem": "…", "stem_spoken": "适合朗读的题干（不含选项）",
      "options": [{"key": "A", "text": "…"}],
      "answer": "B", "solution": "…",
      "distractors": {"A": {"text": "对应的常见错误", "prereq_kp": null}},   // prereq_kp 只能取自本环节的前置 id 列表
      "rubric": null,                                          // explain/steps 题：{"points":[{"required":true,"key":"关键词","text":"…"}],"model_answer":"…"}
      "fallback_hints": {"1": "…", "2": "…"},
      "forbidden": {"terms": [], "patterns": []},              // 由代码在备课时生成，见 §6.3
      "origin": {"kind": "generated"},                         // 或 {"kind":"exam","exam_item_id":"…"} / {"kind":"textbook","material_id":"…","page":15}
      "verify": {"status": "verified"}
    }
  }
}
```

题型：`choice` 单选 · `multi` 多选 · `numeric` 数值（带 `tolerance`）· `short` 短答（带 `accepted` 列表，精确匹配判分）· `explain` 论述/解释（按 rubric 给分点判分）· `steps` 分步求解（按 rubric）。前四种是**客观题**。

### 4.2 备课流程（`LessonPlanner.prepare(plan_item_id)`）

1. **取材**：目标 KP 的卡片与来源片段（`retrieve_for_kp`）、题库中这些 KP 及其直接前置的已复核题（`item_bank`，不含模考保留卷）、学习者状态（掌握度、未解决的迷思、讲法有效性、上节课小结）。
2. **生成教案**（模板 `analysis/lesson_plan`）并解析。真题只能**按 id 引用**（`<check ref="exam:…"/>`），题干、选项、答案由代码从题库取，模型不得重打；改编过的题一律算生成题。
3. **复核**：教案中的每道新题、每个例题都交给 `ItemVerifier`（唯一定义在 `course-analysis.md` §S6b）。只有 `verified` 的才保留；复核通过的新题写入 `item_bank`。
4. **数量下限**（不满足则补题一次，仍不满足则该课"备课失败"）：每个环节 `verified` 检查题数 ≥ 要点数 + 1，其中每个要点至少 1 道"只依赖到该要点为止的内容"的题、至少 2 道同构变式（`variant_of`）、至少 1 道客观题；KP 的常见考法含论述/简答时至少 1 道 rubric 题；例题 ≥ 2。
5. **由代码补全**：每道题的 `forbidden`（§6.3）；用同一个泄漏校验器检查 `fallback_hints`，泄漏则重生成一次，仍泄漏则丢弃该题。
6. 存库（教案、所用模型、token、复核统计），并预生成 `OPEN` 的首句以降低开课延迟。

`LessonPlanner.more_items(kp_id, n)`：课中题目不够时的后台补题（同样要复核）。**任何时候都不允许 live 模型临场出题、临场编例题或临场解题。**

## 5. 导演 Director（纯代码，无 LLM）

`Director.decide(state, event, learner, plan) -> Decision`，`Decision = {move, args, ask, state_patch}`。
- 必须是**纯函数**且是**全函数**：任何（state, event）组合都返回合法 Decision 或明确的"无动作"。放在 `app/teaching/director.py`。
- `ask ∈ null | {kind:"item", item_id, purpose} | {kind:"open"|"summary"|"ack", purpose}`：**是否提问、问什么由 Director 决定**，模型不输出提问标签（§6.2）。

### 5.1 课堂状态 LessonState（存 `lessons.state_json`）

```jsonc
{
  "stage": "opening",                 // opening | teaching | practice | wrap | done（暂停记在 lessons.status=paused）
  "seg_idx": 0, "kp_cursor": 0,        // 当前环节；本环节已讲完的要点数
  "explains_since_check": 0,
  "approaches_used": [], "examples_used": [],
  "active_ask": null,                  // {"kind","purpose","item_id","asked_seq","nudged":false}
  "item": null,                        // 当前题的阶梯状态：{"id","hint_level":0,"attempts":0,"first_verdict":null,"evidence_deferred":false}
  "items_done": {},                    // item_id -> correct | partial | incorrect | revealed | skipped
  "seg_clean_streak": 0,               // 本环节"首答、无提示、答对"的不同题目数
  "probed_seg": false, "skip_used": false, "predicted_kp": false,
  "confusion_streak": 0, "offtopic_streak": 0, "unclear_streak": 0, "failed_items": 0,
  "backfilled": [], "backfill": null,  // 本课已回补的前置；进行中的回补 {"kp_id","return":{"seg_idx","kp_cursor","item_id"}}
  "pending_beat": null,                // 讲解类 Move 尚未提交的效果
  "queued": [],                        // 待执行的 Decision；RESUME 至多 1 个且放队首
  "wrap_pending": false,
  "pace": "normal", "style_id": "guided",
  "active_ms": 0, "seg_active_ms": 0,  // 只累计"有 Beat 在播或有 Ask 在等、且未暂停"的时间
  "heard": {"gen": 0, "seq": 0}
}
```

**字段提交与清零**（实现与测试都以此表为准）：

| 时机 | 动作 |
| --- | --- |
| `EXPLAIN / EXAMPLE / REEXPLAIN / REPEAT` 决策时 | 只写 `pending_beat`，不改计数 |
| 该 Beat 的 `beat_done` | 提交：`explains_since_check += 1`；`approaches_used += kind`（REPEAT 除外）；`examples_used += id`（EXAMPLE）；`kp_cursor += 1`（仅 EXPLAIN） |
| 该 Beat 被打断 | 学生已听到的 `say` 字数 < 70% → 丢弃 `pending_beat`；≥ 70% → 照常提交 |
| 该 Beat 被长度校验截断 | 已放行字数 ≥ 上限的 70% → 视为讲完并提交；否则同一要点补讲 1 拍（"接着讲完，最多 2 句"），补讲后无条件提交 |
| 发出 `CHECK` | `explains_since_check = 0` |
| 任意题首答答对 | `confusion_streak = 0`；`failed_items = 0` |
| 进入新要点 | `approaches_used = []`；`confusion_streak = 0`；`predicted_kp = false` |
| 进入新环节 | `kp_cursor = 0`；`seg_clean_streak = 0`；`explains_since_check = 0`；`seg_active_ms = 0`；`approaches_used = []`；`examples_used = []`；`confusion_streak = 0`；`probed_seg = false`；`skip_used = false` |
| 任意作答或提问 | `offtopic_streak = 0`；`unclear_streak = 0` |

### 5.2 事件

`lesson_start` · `lesson_resume`（重连/刷新/从暂停恢复）· `beat_done` · `student_answer{item_id, value, via}` · `ask_reply{purpose, …}`（对 open/summary/ack 类提问的回应）· `student_utterance{understanding}` · `quick_action{kind}` · `interrupt{gen, heard_seq}` · `silence` · `time_up` · `control{pause|resume|end}`。

- `quick_action.kind`：`confused | example | hint | show_answer | repeat | skip | slower | faster | style:<id> | break | continue | locate:<块或行id>`。
- **意图归一化**（课堂运行时在调用 Director 之前完成）：理解器的意图 `request_example→example`、`request_hint→hint`、`request_answer→show_answer`、`request_repeat→repeat`、`request_slower/faster→slower/faster`、`request_style→style:<id>`、`request_break→break`、`ack→continue`、`confusion→confused`、`skip_claim→skip`、`stop→control.pause`；`answer` 且当前有题目类提问 → `student_answer`，否则按 `question` 处理。
- `silence`、`time_up` 由**服务端课堂运行时**计时并发出（§5.8）。

### 5.3 教学动作 Move

| Move | 作用 | Ask |
| --- | --- | --- |
| `OPEN` | 问候、一句话回顾上节、今天学什么与为什么值得学 | 有前置小问 → item(prereq)；否则无 |
| `PREDICT` | 讲之前请学生先猜一猜（仅 `guided` 风格、掌握度 ≥0.4 时） | open(predict)，不判分 |
| `EXPLAIN` | 用选定讲法讲当前要点，≤3–4 句 + 板书 | 无 |
| `EXAMPLE` | 板书演示一道**教案里已复核的**例题 | 无 |
| `CHECK` | 一句过渡话；系统随后朗读题干并出示作答控件 | item(check) |
| `PROBE` | 答对但可能是蒙的：请学生说说为什么 | open(probe) |
| `FEEDBACK_CORRECT` | 具体指出哪一步想对了 | 无 |
| `FEEDBACK_PARTIAL` | 肯定对的部分，指出一个缺口，请学生补全 | item（同一题） |
| `HINT` | 提示阶梯第 1/2 级 | item（同一题） |
| `SHOW_SOLUTION` | 在板书上完整示范这道题 | 无 |
| `REEXPLAIN` | 换一种没用过的讲法、更小的步子重讲当前要点 | 无 |
| `REPEAT` | 放慢、沿用同样的例子把刚才那段再讲一遍 | 无 |
| `BACKFILL` | 补讲一个前置知识点（教案里备好的） | 课中 → item(backfill)；开场 → 无 |
| `ANSWER_QUESTION` | 回答学生的提问（基于资料） | 无 |
| `RESUME` | 一句话接回原进度 | 沿用被恢复的提问 |
| `ADJUST` | 一句话确认语速/风格已切换，或说明"这部分还是过一遍" | 无 |
| `VERIFY_SKIP` | "那我考你一道，过了就跳过" | item(verify_skip) |
| `STUDENT_SUMMARY` | 请学生用自己的话总结本环节 | summary |
| `TRANSITION` | 小结上一环节、引出下一环节（或练习/下课） | 无 |
| `PRACTICE_ITEM` | 出示练习题（真题优先） | item(practice) |
| `CLARIFY` | 没听清学生的话，确认一下 | 沿用原提问 |
| `NUDGE` | 学生没回应：温和问一句要不要提示 | 沿用原提问 |
| `BREAK` | 连续受挫或学生要休息 | ack（三个按钮：继续 / 换道简单的 / 今天到这） |
| `WRAP` | 回顾要点、如实说哪里还不稳、预告下节 | 无 |

### 5.4 决策规则（自上而下匹配，命中即止；G 为全局，任何 stage 都适用）

```
G0  lesson_resume            → 不调用模型：补发缺失事件；有 active_ask → 重发该提问并重置沉默计时；否则按 beat_done 处理
G1  time_up 或 control.end    → 有题目类 active_ask：置 wrap_pending，等该题结案（最多 120 秒）；否则 WRAP
G2  interrupt                → 不选 Move：记录 heard，按 §5.1 处理 pending_beat；8 秒内没有任何学生输入 → 运行时补发 beat_done
G3  student_answer 的 item_id 不是当前题或该题已结案 → 忽略并回 judge{stale:true}（幂等，不计尝试次数）
G4  slower / faster / style  → 更新 pace 或 style；ADJUST；有 active_ask 则把 RESUME 放入队首
G5  break                    → BREAK
G6  show_answer              → 有题目类提问：SHOW_SOLUTION（该题记 revealed；若尚无首答则写 verdict=revealed 的证据，不改变掌握度）；
                               failed_items += 1；有同构变式则把它的 CHECK 入队。无题目类提问：按 G9
G7  hint                     → 有题目类提问且 hint_level < 2：hint_level += 1，HINT(level)（不写证据、不计尝试）；
                               hint_level 已是 2：RESUME（指令：再提示就是答案了，鼓励再试一次或点"看答案"）；无题目类提问：按 G8
G8  confused                 → practice 阶段有题目类提问：按 G7；其余见 T1
G9  example                  → 本环节还有未用过的已复核例题：EXAMPLE；否则 REEXPLAIN（下一种讲法）；有 active_ask 则 RESUME 入队首
G10 repeat                   → REPEAT；有 active_ask 则 RESUME 入队首
G11 locate:<id>              → REEXPLAIN（下一种未用讲法；指令"从这一行讲起，拆成更小的两三步"）
G12 skip                     → teaching 且 skip_used=false 且本环节有未用的已复核客观题：VERIFY_SKIP（取难度最高的）；
                               practice：当前题记 skipped，进下一题；其余：ADJUST
G13 提问（intent=question）  → ANSWER_QUESTION；RESUME 入队首（队列里 RESUME 至多 1 个）
G14 闲聊/跑题                → offtopic_streak += 1；< 3：RESUME（指令里先用一句话友好回应）；≥ 3：不调用模型，界面显示固定提示，重发当前提问或按 beat_done 继续
G15 没听清（intent=unclear 或理解器输出解析失败）→ unclear_streak += 1；< 2：CLARIFY；≥ 2：界面提示"可以直接点选项或打字"，重发原提问
G16 silence（有 active_ask）  → nudged=false：NUDGE，nudged=true；已提醒过：暂停课堂（lessons.status=paused），不写证据
G17 beat_done 且 queued 非空且无 active_ask → 弹出执行（弹出的是 RESUME 而已无可恢复内容 → 丢弃，继续匹配）

opening
O1  lesson_start             → OPEN；本课首个环节有 backfills 时，取其中掌握度最低的前置的小题作为前置小问
O2  前置小问作答              → 答对：FEEDBACK_CORRECT，stage=teaching；答错/不会：BACKFILL（开场形态：补讲 + 示范该小题，不再追问），stage=teaching
O3  beat_done 且无提问        → stage=teaching，继续匹配 T 规则

teaching（环节 s，要点 k）
T0  刚进入环节且该 KP 掌握度 ≥ 0.70 且 skip_used=false 且有未用的已复核客观题 → VERIFY_SKIP
T1  confused：confusion_streak += 1
      a) confusion_streak == 3 且本环节 backfills 里有未回补过的前置 → BACKFILL（课中形态），该前置记入 backfilled
      b) 否则 → REEXPLAIN（当前要点可用讲法中，按"讲法有效性排序"取第一个未用过的；全部用过 → 清空 approaches_used，指令追加"步子再小一半 + 一个全新的例子"）
      有 active_ask 时保留该提问，本拍结束后 RESUME
      （前端：第 2 次重讲后在白板上显示不打断的提示"点一下从哪一行没跟上"，点击即 locate）
T5  student_answer / ask_reply → 见 §5.5、§5.6
T7  beat_done 且无 active_ask，按顺序：
      ① seg_idx 越界                        → 有练习题：stage=practice（P1）；否则 stage=wrap（W1）
      ② explains_since_check ≥ 1 且存在可用检查题 → CHECK（选题见 §5.7）
      ③ 还有未讲要点                         → style 允许且掌握度 ≥0.4 且 predicted_kp=false：PREDICT；否则 EXPLAIN（下一要点）
      ④ 环节达标（seg_clean_streak ≥ 2）     → 每两个环节一次 STUDENT_SUMMARY，否则 TRANSITION；seg_idx += 1
      ⑤ 未达标且存在可用检查题                → CHECK
      ⑥ 未达标且题目用尽，或 seg_active_ms > 2 × 该环节 est_minutes → 该 KP 标记"需要再练"，TRANSITION；seg_idx += 1

practice
P1  进入 / 上一题结案         → 还有练习题：PRACTICE_ITEM（该题 hint_level 从 1 起算）；否则 stage=wrap
P2  student_answer           → §5.5

wrap
W1  进入                     → WRAP；播完后 stage=done，触发 finish()

D0（兜底，必须存在）未匹配的组合 → 有 active_ask：RESUME（重述该提问）；否则按 beat_done 处理；计数 director_unmatched
```

### 5.5 题目作答后的分支

记 `verdict ∈ {correct, partial, incorrect, dont_know}`；`attempts += 1`；首次作答时 `item.first_verdict = verdict`。证据与掌握度的写法见 `learner-model-and-planning.md` §2（**每道题的一次出示只有首答做贝叶斯更新**）。

```
verify_skip（单次作答，无提示阶梯）
   correct → 写证据(source=skip_verify)；本环节剩余要点记为跳过，环节状态 passed_by_skip；FEEDBACK_CORRECT，随后 TRANSITION
   其他    → 写证据；skip_used=true；ADJUST（"还差一点，我们还是过一遍"），继续正常教学

prereq / backfill（单次作答，无提示阶梯；证据记在前置 KP 上）
   课中 backfill：correct → FEEDBACK_CORRECT；其他 → SHOW_SOLUTION（不排变式）。
   然后 RESUME 回到 backfill.return：原先有待答题 → 出它的同构变式；没有变式 → 重出原题并把 hint_level 记为 1。清空 backfill。
   回补题也没答对 → 课后为该前置追加一节补课，并在 WRAP 里如实说明；本课不再回补它。

check / practice（提示阶梯）
   correct：
      首答且 hint_level=0：
         题型是 choice/multi、该 KP 掌握度 <0.6、probed_seg=false → 暂不写证据（evidence_deferred），probed_seg=true，PROBE
         否则 → 写证据；seg_clean_streak += 1；FEEDBACK_CORRECT
      其他（带过提示或重试后答对）→ 写证据（折扣规则见学习者模型）；不计 streak；FEEDBACK_CORRECT
      题目结案；wrap_pending 则 WRAP
   partial：FEEDBACK_PARTIAL（同一题再答）；同一题第 2 次 partial 按 incorrect 处理
   incorrect / dont_know：
      首答 → 写证据；seg_clean_streak = 0；记录迷思
      所选错误选项的 prereq_kp 掌握度 <0.6、未回补过、教案备有它的 backfill → BACKFILL（课中形态，return 指向本题）
      否则走阶梯：next = hint_level + 1（dont_know 时取 max(hint_level + 1, 2)）
         next ≤ 2 → hint_level = next；HINT(level)
         next ≥ 3 → SHOW_SOLUTION；该题记 revealed；failed_items += 1；有同构变式则 CHECK 入队
   SHOW_SOLUTION 播完后：failed_items ≥ 2 → 下一动作固定为 BREAK；BREAK 之后的下一道题固定取难度 1
```

### 5.6 非题目类提问的回应

| 提问 | 回应后的处理 | 写证据 |
| --- | --- | --- |
| `PROBE` | 理解器对照该题 `solution` 判理由 `sound / unsound / none`。sound → 原题按 correct 写证据，`seg_clean_streak += 1`，FEEDBACK_CORRECT；其余 → 原题按 partial 写证据（不改变掌握度），用"补理由"形态的反馈把道理讲清（模板 `feedback_reason`：允许使用 solution、不再追问），同构变式入队 | 推迟到此刻 |
| `PREDICT` | 不判分；下一拍 EXPLAIN 的指令带上学生的猜测 | 否 |
| `STUDENT_SUMMARY` | 理解器以本环节要点为评分点；有遗漏则在随后的 TRANSITION 指令里补上遗漏点 | 否 |
| `NUDGE` 之后 | 学生作答 → 正常判分；要提示 → G7；困惑 → G8；其余 → 重发原提问 | — |
| `BREAK` 的三个按钮 | 继续 → RESUME；换道简单的 → 下一题取难度 1（无题则 EXAMPLE）；今天到这 → G1 | 否 |
| `CLARIFY` 之后 | 把学生的新回答当作对原提问的回应重新处理 | — |
| 没有提问时收到学生输入 | 走理解器：提问 → G13；困惑 → G8；其他 → G14 | 否 |

### 5.7 选题、达标与保护

- **选题**：只能选"所考要点 ⊆ 已讲要点"且未用过的已复核题，难度升序；掌握度 ≥0.6 时难度 2 优先；重问一律用同构变式。没有可用题 → 触发 `more_items`（后台），当拍按 T7 继续往下匹配。
- **环节达标**：`seg_clean_streak ≥ 2`（两道不同的题，首答、无提示、答对）。环节达标不等于知识点"已掌握"（后者还要隔天复习确认，见学习者模型）。
- **不困住学生**：题目用尽或环节用时超过预估 2 倍 → 标记"需要再练"并继续往下；计划会自动补一节针对性的课，WRAP 里如实告知。
- **受挫保护**：见 §5.5 的 `failed_items` 规则；提示阶梯本身不被打断。
- **讲课风格**只改变措辞与两个参数：`predict_before_explain`（仅 `guided` 为真）与首选讲法偏置（见学习者模型 §8）。检查频率、阶梯、达标标准不随风格改变。

### 5.8 计时（服务端课堂运行时负责）

- `active_ms`：只累计有 Beat 在播或有提问在等、且未暂停、标签页可见的时间。
- **沉默阈值**（从提问出示且老师说完算起；控件内有输入、聚焦或麦克风有声都重置）：choice/multi 30 秒；numeric/short 60 秒；steps/explain 90 秒；open/summary/ack 30 秒。
- 没有提问时，标签页隐藏或连续 3 个 Beat 没有任何学生输入事件 → 暂停。
- `time_up`：`active_ms ≥ max(session_minutes, 教案 est_minutes) × 1.25` 时发出一次。
- 课堂未完成就结束：`lessons.carry_over_json = {seg_idx, kp_cursor}`；重排计划时把未完成的 KP 生成新的计划项，教案从未完成处开始备。

## 6. 表达生成 Realizer（LLM，live 角色）

`Realizer.run(decision, ctx) -> AsyncIterator[LspEvent]`

### 6.1 提示词布局（越靠后越易变，利于前缀缓存）

1. 系统层（静态）：身份与底线、LSP 输出格式、口语与板书规则、安全规则。
2. 角色层（半静态）：人设卡、当前讲课风格的规则。
3. 课程层（每环节变）：环节教案切片（目标、要点、当前讲法提纲、易错点、来源摘录——都作为不可信数据块）、学习者摘要。
4. 现场层（每 Beat 变）：字数预算与下一个块编号、白板快照（最近 ≤15 个块：`id | 类型 | 一行摘要`）、最近 6 轮对话（被打断的发言只保留学生实际听到的部分；语音转写的学生发言标注"语音，可能不准"）、本次动作指令。
5. **题目私有数据块** `item_private`（题干、标准答案、solution、错因）只在 `HINT / FEEDBACK_* / SHOW_SOLUTION / PROBE 的讲评` 时注入；`EXPLAIN / CHECK / PRACTICE_ITEM` 等不注入答案。

模板位置：`libs/prompts/v3/live/system.md`、`live/context.md`、`live/moves/<move>.md`、`live/understand.md`；内容见 `prompts.md`。

### 6.2 输出硬约束

- **模型只输出 `say / board / mark / point / cue / pause` 六种标签，永远不输出提问标签。** 提问由代码在 Beat 末尾按 `Decision.ask` 追加为 `ask` 事件；模型输出里若出现 `<ask…>` 一律丢弃并计数 `lsp_stray_ask`。需要学生回应的 Move，其模板要求"最后一句必须是请学生作答的话"。
- `CHECK / PRACTICE_ITEM / VERIFY_SKIP`：模型只说一句过渡话，**不复述题干与选项**；代码随后追加 `say(题目的 stem_spoken)` 与 `ask` 事件（题干与选项由控件显示）。
- 一个 Beat 的 `<say>` 总字数上限：slow 90 / normal 140 / fast 200；一个 `<say>` 一句话，≤45 字。
- `<say>` 里不许出现 LaTeX、Markdown 符号、代码；公式用中文读出来，公式本体写在白板上。
- 先写板书再说对应的话。
- 不得声称"已保存/已记住"；不得编造出处；不得自拟例题或自行求解（例题与解法只能来自教案）。

### 6.3 生成后校验器（纯代码，`app/teaching/validators.py`）

| 校验 | 规则 | 失败处理 |
| --- | --- | --- |
| 答案泄漏 | 对 `HINT(1/2) / FEEDBACK_PARTIAL / PROBE / NUDGE / RESUME / CLARIFY` 的 `say` 与本拍新增板书，按该题 `forbidden` 检查 | 丢弃本次输出，加强约束重试 1 次；仍失败用 `fallback_hints[level]`（非 HINT 的 Move 用一句通用引导语，来自界面文案文件） |
| 口语净化 | `<say>` 中的 `$…$`、`\cmd`、`**`、`#`、反引号 | 按数学读法表转成口语（`app/teaching/speech_text.py`，读法表是数据文件）；转不了就删去该片段 |
| 长度 | 超过字数上限 | 在句子边界截断，按 §5.1 的截断规则处理 |
| 板书引用 | `target` 指向不存在的块 | 丢弃该操作，计数 `lsp_invalid_ops` |

`forbidden` 的生成规则（备课时由代码生成，可单测）：
- `choice/multi`：`patterns` = `(选|答案(是|为)?|应该?是|就是|正确的是)\s*{正确选项字母}(?![A-Za-z])`；`terms` = 正确选项的文本（规范化后长度 ≥3 且不是题干的子串）。不单独匹配字母。
- `numeric`：答案及其等价写法按整数字 token 匹配 `(?<![\d.]){v}(?![\d.])`；该 token 已出现在题干或白板快照里则不算；一位数答案只有紧跟在"等于/是/为/得/="之后才算。
- `short`：`accepted` 各项（长度 ≥2，整词）。
- `explain/steps`：rubric 每个给分点的 `key`（未出现在题干里的）。

需要保密的 Move 很短，校验采用"先缓冲整拍再放行"（可接受约 1 秒延迟）；其余 Move 以句为单位边生成边放行。

## 7. 学生输入理解器（Understanding）

- **控件作答**：不调用模型，直接按教案判分。
- **语音/文字回答客观题**：理解器只负责抽取作答值；前端把它预填进作答控件并显示"你的答案：B · 2 秒后提交 · 改"，倒计时结束后按控件作答提交。抽不出值 → `unclear`。**语音识别的结果不直接判分。**
- **语音/文字回答 rubric 题或开放提问**：理解器（模板 `live/understand`）输出：

```
<intent>answer|question|confusion|request_example|request_hint|request_answer|request_repeat|request_slower|request_faster|request_style|request_break|skip_claim|ack|chitchat|off_topic|stop|unclear</intent>
<value>客观题的作答值（没有则空）</value>
<style_id>guided|direct|analogy|exam|rigorous（request_style 时）</style_id>
<verdict>correct|partial|incorrect|dont_know|na</verdict>
<hits>命中的给分点序号，逗号分隔</hits>
<reason>sound|unsound|none|na</reason>
<right>学生说对的部分（partial 时必填）</right>
<gap>缺的是什么（partial 时必填）</gap>
<misconception>从教案的易错点里选最贴近的，或一句话描述；没有则空</misconception>
<evidence>学生原话中支持判断的片段</evidence>
```

- 判分口径（提示词与代码一致）：rubric 的必需给分点全部命中才是 `correct`；命中一部分或"意思对但不严谨"是 `partial`；拿不准判 `partial`；表示不会是 `dont_know`。
- 丢弃而不处理的输入：转写为空、少于 2 个字、或与老师上一句 `say` 的字符重合率 >80%（多半是外放回声）。
- 理解器输出解析失败 → `unclear`。

## 8. 课堂流协议 LSP

### 8.1 模型输出语法

选择标签而非 JSON：板书含大量 LaTeX，JSON 转义会被便宜模型写坏（`\frac` 的 `\f`、`\theta` 的 `\t` 会被静默解析成控制字符）。

```
<say emotion="neutral|warm|cheerful|curious|focused|playful|concerned">一句口语</say>
<board op="add" id="b3" type="title|text|math|list|table|code|diagram|plot|image|callout|steps" variant="definition|theorem|warning|tip|example" title="…">内容</board>
<board op="append" target="b3">追加的一行/一步</board>
<board op="update" target="b3">替换后的内容</board>
<board op="clear"/>                         翻新的一页，旧页保留在历史里
<mark target="b3 或 b3.2" style="underline|box|color" color="accent|ok|warn"/>
<point target="b3"/>                        激光笔；形象看向并指向白板
<cue gesture="nod|wave|think|point_board|cheer|shrug|write"/>   <cue look="board|student"/>
<pause ms="400"/>
```

内容约定：`text/list/callout` 为 Markdown（行内公式 `$…$`）；`math` 为 KaTeX 可渲染的 LaTeX，多行推导每行一步，可用 `b3.1`、`b3.2` 寻址；`steps` 每行一步；`table` 为 Markdown 表格；`diagram` 为 Mermaid；`plot` 与 `image` 的内容是一行 JSON 规格（规格内不含 LaTeX）：

```
plot : {"fn":["sin(x)/x"],"x":[-10,10],"y":[-0.5,1.5],"points":[[0,1]],"holes":[[0,1]],"labels":[{"at":[0,1],"text":"x→0"}]}
image: {"material_id":"m1","page":12}        展示学生自己资料的原页（可带 "bbox":[x0,y0,x1,y1]）
```

### 8.2 增量解析规则（`app/teaching/lsp_parser.py`）

- 逐字符喂入，任意切分位置的结果必须与一次性解析一致（性质测试）。
- **只有 `<` 后紧跟（可选 `/`）白名单标签名 `say|board|mark|point|cue|pause`，且其后是空白、`>` 或 `/` 时才识别为标签；其余 `<` 一律是字面字符**（数学里的 `0<|x-a|<\delta`、`a<b` 很常见）。
- `<board …>` 的内容一直读到字面的 `</board>` 为止，其间不识别任何标签；`<say>` 同理。
- 属性值接受直引号、全角引号与无引号；缺失取默认值；流结束时未闭合的标签自动闭合。
- 白名单以外的标签与标签外的文字一律丢弃并计数 `lsp_stray_text`（开头的客套话、代码围栏都属于此类）。唯一例外：整段输出没有任何合法标签 → 全文作为一个 `say` 走口语净化。
- `id` 重复 → 服务端改名并在本次生成内重映射后续 `target`；未给 `id` → 服务端生成。
- `<say>` 内再按中文标点（。！？；…）切句供 TTS 分段；逗号仅在片段超过 28 字时切。
- 模糊测试必须包含：`0<|x-a|<\delta`、`f(x)<g(x)`、"当 x<1 时"、`<br>`、全角引号属性、代码围栏、开头客套话、被截断的标签。

### 8.3 服务端 → 前端事件（WebSocket JSON；二进制帧只承载音频）

信封：`{"v":1,"lesson_id":"…","gen":17,"seq":203,"type":"…","data":{…}}`。`gen` 每次新的生成 +1；`seq` 全局单调。

| type | data | 说明 |
| --- | --- | --- |
| `beat.start` | `{move, ask_after}` | 前端切换形象状态 |
| `say` | `{seg, text, emotion}` | 字幕；音频稍后以同 `seg` 到达 |
| `audio` | `{seg, format, sample_rate, last}` + 二进制帧 | 流式语音分片（见语音规格） |
| `say.timing` | `{seg, marks:[{t_ms, char_index}]}` | 可选：字边界，用于口型 |
| `board` | `{op, id|target, type, variant, title, content|spec}` | 板书操作 |
| `mark` / `point` | `{target, style, color}` | 标注 / 激光笔 |
| `cue` | `{gesture|look|emotion}` | 形象提示 |
| `ask` | `{kind, purpose, item_id?, widget?, buttons?}` | `widget` 为作答控件定义（**不含答案**） |
| `beat.end` | `{ask}` | 本 Beat 事件发完 |
| `beat.cancelled` | `{gen, reason}` | 被打断或被取代 |
| `judge` | `{item_id, verdict, stale?, correct_answer?}` | 判分结果；`correct_answer` 仅在示范解法后下发 |
| `state` | `{stage, seg_idx, segments:[{title,status}], paused, mastery:[{kp_id,p,delta}]}` | 进度与掌握度 |
| `prep` | `{status, progress, message}` | 备课/补题进度 |
| `error` | `{code, message, recoverable}` | 可见错误，不静默 |

### 8.4 前端 → 服务端

`student.text{text}` · `student.answer{item_id, value, via}` · `student.reply{purpose, value}`（ack 按钮、总结文本等）· `student.quick{kind}` · `student.interrupt{gen, heard_seq}` · `student.activity`（控件内输入/聚焦，用于重置沉默计时，节流发送）· `playback.done{gen}` · `lesson.control{pause|resume|end}` · 麦克风音频帧。

### 8.5 前端时间线执行器（`features/classroom/timeline.ts`）

- 按 `seq` 排序、**严格串行**执行：`say` 占用其音频时长（无语音时按字数估算：中文约 150 ms/字、英文约 240 ms/词，最少 1.5 秒，按语速档位缩放）；`board / cue / pause / ask` 依次完成；`mark / point` 发出即走，与下一句讲解同时呈现。
- 一个 Beat 播完且没有提问 → 发 `playback.done`，服务端据此产生 `beat_done`（间隔 300–500 ms；设置里可改为"每段讲完等我点继续"）。
- **打断**：学生开口（VAD）/点击打断/发送文字 → 立即停止音频、清空同 `gen` 的未执行项、发送 `student.interrupt`。服务端取消该 `gen` 的生成与合成并下发 `beat.cancelled`；之后迟到的同 `gen` 事件一律丢弃。
- 断线重连：重连后拉取缺失事件重建白板，发 `lesson.control{resume}`。

## 9. 白板模型

- 白板 = 有序的"页"，每页是有序的块：`{id, type, variant, title, content|spec, lines[], marks[]}`。状态全部来自事件回放：`applyBoardEvent(board, event)` 是纯函数（可单测、可回放、可导出）；服务端也维护一份，用于给 Realizer 提供白板快照与断点恢复。
- 首发块类型：`title, text, math, list, table, code, callout, steps, diagram, plot, image, question`。`question` 块由 `ask` 事件创建，不由模型创建。
- 渲染失败：显示原文 + "渲染失败"角标，计数 `lsp_render_errors`；`diagram` 失败先自动修复一次。
- 后置：`geometry`、沙箱小组件 `widget`。

## 10. 收尾 finish()

1. 结算证据与掌握状态。
2. **课后小结**（analysis 模型，模板 `analysis/lesson_recap`）：输入是事件日志的结构化摘要；只许写输入里有的事实。
3. 复习卡：教案 `wrap.cards`；答错/看过答案的题进**错题本**并生成题卡；**每个达标的 KP 另生成 1 张题卡**（一道未出示过的已复核题或变式，首次到期 1–3 天）——"已掌握"需要它在隔天被答对来确认。
4. 记录讲法有效性：某讲法之后的第一道检查题首答无提示答对 → 该讲法 `success + 1`。
5. 触发重排计划，并后台备下一节课。

## 11. 一段完整示例（节选）

`EXPLAIN(要点 0，讲法 example)` → 模型输出：

```
<board op="add" id="b1" type="title">极限：无限靠近，但不必到达</board>
<say emotion="warm">我们先不看定义，先看一个具体的函数。</say>
<board op="add" id="b2" type="math">f(x)=\dfrac{x^2-1}{x-1}</board>
<say>注意，x 等于 1 的时候分母是零，这个函数在 1 这一点没有定义。</say>
<board op="add" id="b3" type="table">| x | 0.9 | 0.99 | 1.01 | 1.1 |
|---|---|---|---|---|
| f(x) | 1.9 | 1.99 | 2.01 | 2.1 |</board>
<cue look="board"/>
<say>可是你看，x 从两边越靠近 1，f(x) 就越靠近 2。</say>
<mark target="b3" style="box"/>
```

`beat_done` → T7② → `CHECK(c1)`，模型只输出一句过渡：

```
<cue look="student"/>
<say emotion="curious">那我问你一个小问题。</say>
```

代码随后追加：`say(c1 的 stem_spoken)` 与 `ask{kind:"item", purpose:"check", item_id:"c1", widget:{…}}`。

学生选 A（错）→ 首答写证据 → 阶梯第 1 级 `HINT(1)`，模型输出（经泄漏校验）：

```
<say emotion="warm">这个想法很常见，我们回头看一眼表格。</say>
<point target="b3"/>
<say>表格里有没有哪一列，x 正好等于 1？你再想想。</say>
```

代码追加：`ask`（同一题）。

## 12. 必须具备的自动化测试

- `test_director_total.py`：对 `stage × 事件类型 × active_ask.purpose(含无)` 的全笛卡尔积断言 `decide()` 返回合法 Decision（不抛异常、不返回未定义 Move）。
- `test_director_rules.py`：§5.4–§5.6 每条规则至少一个用例（≥80 条），并覆盖这些轨迹：全对的学生；连错三次；连续五次没听懂；每题都点看答案；始终不回应；反复跑题；讲到一半被打断后说了句含糊的话；有待答题时刷新；没在提问时作答。
- `test_state_commit.py`：§5.1 提交/清零表的每一行。
- `test_lsp_parser.py`：固定样例 + 随机切分性质测试 + §8.2 列出的全部畸形输入。
- `test_validators.py`：各题型 `forbidden` 的生成与匹配（各 ≥10 例，含"答案数字出现在题干里不算泄漏"）、口语净化、长度截断。
- `test_board_reducer`（前端）：事件回放得到确定的白板；行寻址；清页与历史。
- `test_lesson_resume.py`：在三种断点恢复——Beat 流到一半（该 Beat 视为未发生，重新生成）、提问等待中、示范解法后队列非空——断言不重复写证据、提问控件重新出现、`hint_level/attempts` 不变。
- `test_runtime_timers.py`：沉默阈值按题型生效、活动重置计时、提醒一次后暂停且不写证据、`time_up` 等待待答题结案。
- 真实模型评测见 `MILESTONES.md` M4。
