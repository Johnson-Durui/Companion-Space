# 规格 · 老师素材扩展（片段目录、播放规则、素材约定、入库工具）

> 版本：2026-11-22（已合入一轮评审）。入库后的位置：`docs/rebuild/spec/tutor-media.md`。配套任务单：`docs/rebuild/TASK-TUTOR-MEDIA.md`。
> 与 `spec/tutor-video-avatar.md` 的关系：那份规格里关于驱动接口、四档降级、Sidecar 协议、安全校验的条款继续有效；本规格只扩展"片段有哪些、什么时候播哪一段、素材长什么样、怎么入库"。
> 与体验重塑（U 阶段）的关系：课堂相位机由 U2a 建立，本规格不改它。**老师画面上播哪个片段，以本规格 §4 为准，覆盖体验规格 §5.6.2 相位表的"形象"一列**；该表的其余各列、以及"一次性动作播放哪个片段只由动作本身决定"这条规则继续有效。
> 文中的文件、函数名是 2026-11-22 的快照（当时 U2a 正在改这些文件），动手前读实际代码核对；有出入时以代码为事实、以本规格的意图为目标，取舍写进 `DECISIONS.md`。

## 0. 目的与边界

**目的**：让老师在每个环节都有自己的动作，并且不重复得让人出戏——更多的片段、同类片段轮换、待机会自己变化、一次性动作播完整、静态档也有表情。

**边界**：不改教学引擎、判分、提示词模板；不改对外的 Sidecar 协议；不做实时口型；不做换装；不在产品里提供"生成素材"的功能；产品包不新增依赖（工具用到的外部程序不随产品分发）。

## 1. 现状事实（动手前重新核对）

**写死 8 个片段名的位置**（`grep -E "idle_breathe|react_comfort"`）：`packages/avatar-engine/src/{types,choreographer,loop-pack-driver,driver-manager}.ts`、`apps/web/src/features/characters/video-config.ts`、`apps/web/src/locales/zh-CN.json`、`apps/web/tests/avatar-runtime.test.ts`、`tests/e2e/ux-invariants.spec.ts`、`services/api/app/services/{tutor_catalog,tutorpack}.py`、`services/api/tests/test_tutor_catalog.py`、`tools/tutorpack/cli.py`、`tools/tutorpack/comfyui/anime_tutor_loop_workflow.json`、`tools/tutorpack/README.md`、`tools/tutorpack/prompts/**`、`README.en.md`，以及六个 `assets/avatars/packs/tutor-*/manifest.json`。由接口契约生成的客户端里**没有**这些名字。

**播放**：循环靠 `video.loop`（接缝完全取决于文件本身）；一次性片段在 `ended` 或固定 4000 毫秒计时器先到者结束（超过 4 秒会被截断）；片段之间按清单里的 `crossfade_ms` 做透明度交叉淡化（默认 180，后端接受 0–600）；每个槽位只有一个文件，没有轮换；问候动作播的是讲话片段，道别动作播的是待机片段。驱动接口 `ITutorVideoDriver` 由静态、循环短片、本地实时、云端四个驱动共用，只有 `setPose`（7 个取值）和 `triggerInstantAction`（8 个取值）。

**清单**：角色包清单的 `schema_version` 目前接受 1 和 3。

**素材**（实测）：48 段，全部 VP9 profile 0、480×864、24 帧每秒、每秒一个关键帧、无音轨；2.79–5.25 秒；合计 45.95 MiB，平均约 2 Mbit/s（编码参数是 CRF 26 加 `-g 24`，偏浪费）。画面几何是"1080×1920 的立绘等比缩到 480×854，上下各补 5 像素"。每段结尾有约 6 帧向起始画面的叠化。相对缩小后的立绘，片段软 10–17%、平均色差 4–7 级（0–255）。

**实测到的内容缺陷**：待机片段有 4 位老师张嘴或露齿约 1–1.5 秒；倾听片段有 3 位老师几乎不动；讲话片段嘴型大、露齿笑、手势大；指白板的转头幅度远大于要求。

**导入限制**（`services/api/app/services/tutorpack.py`）：压缩包最多 32 个文件、单段 15 MiB、压缩包 100 MiB、解压后 150 MiB。

## 2. 片段目录（单一来源）

目录是**数据**：放在一个模块或数据文件里，前端类型、驱动的回退链、后端校验、命令行工具、测试都从它派生，不再各写一份。旧的 8 个名字保持不变。

| 组 | 片段 | 类型 | 包里没有这一段时 |
| --- | --- | --- | --- |
| idle | `idle_breathe` | 循环 | `listen_nod` → `speak_explain_a` |
| idle | `idle_glance` | 循环（插入） | 不插入 |
| idle | `idle_fidget` | 循环（插入） | 不插入 |
| listen | `listen_nod` | 循环 | `idle_breathe` |
| listen | `listen_tilt` | 循环 | `listen_nod` |
| wait | `wait_gentle` | 循环 | `listen_nod` → `idle_breathe` |
| think | `think_gaze` | 循环 | `think_chin` → `idle_breathe` |
| think | `think_chin` | 循环 | `think_gaze` → `idle_breathe` |
| prepare | `prepare_notes` | 循环 | `think_gaze` → `think_chin` → `idle_breathe` |
| review | `read_answer` | 循环 | `listen_nod` → `idle_breathe` |
| speak | `speak_calm` | 循环 | `speak_explain_a` → `speak_explain_b` → `idle_breathe` |
| speak | `speak_explain_a` | 循环 | `speak_calm` → `speak_explain_b` → `idle_breathe` |
| speak | `speak_explain_b` | 循环 | `speak_explain_a` → `speak_calm` → `idle_breathe` |
| speak | `speak_board` | 循环 | `board_point` 播一次，然后回 speak 组 → `speak_explain_a` |
| board | `board_point` | 一次性 | `speak_explain_a` → `idle_breathe`（与现在一致） |
| board | `board_glance` | 一次性 | 不播（保持当前片段） |
| greet | `greet_wave` | 一次性 | 不播（保持当前片段） |
| farewell | `farewell_wave` | 一次性 | 不播（保持当前片段） |
| praise | `react_praise` | 一次性 | `react_clap` → `speak_explain_a` → `idle_breathe` |
| praise | `react_clap` | 一次性 | `react_praise` |
| praise | `react_surprise` | 一次性 | `react_praise` |
| comfort | `react_comfort` | 一次性 | `listen_nod` → `idle_breathe` |
| comfort | `react_encourage` | 一次性 | `react_comfort` |
| celebrate | `react_celebrate` | 一次性 | `react_clap` → `react_praise` |
| hint | `hint_finger` | 一次性 | 不播，直接进 think 组 |
| ack | `nod_yes` | 一次性 | 不播（保持当前片段） |
| intro | `intro_voice` | 一次性，**允许带音轨** | 见 §4.8 |

规则：

1. **组内轮换和待机插入只在包里实际存在的片段之间进行。** 上表的回退只在"这个情境要的片段一个都不存在"时使用。
2. **一次性情境不回退到循环类片段**（否则会出现"安静地播一遍讲话片段"这种新毛病）：表里写"不播"的就是保持当前片段。`react_praise`、`react_comfort`、`board_point` 三个旧槽位的回退保持现状不变。
3. **只有旧 8 段的包必须和改造前表现一样**：同一段事件序列下，产生的片段序列与改造前相同（I18）。
4. 导入时遇到目录里没有的片段名，仍然拒绝（保持现有的严格校验）。
5. 片段的显示名（"试演"页用）放文案文件，键由片段名派生。

## 3. 清单的扩展

**不新增版本号。** 下面三项是现有清单上的可选字段，`schema_version` 继续接受现有取值；没有这些字段的清单行为不变。

```json
{
  "canvas": { "width": 576, "height": 1024, "fps": 24 },
  "clips": { "idle_breathe": "clips/idle_breathe.webm", "greet_wave": "clips/greet_wave.webm" },
  "clip_meta": { "greet_wave": { "settle_ms": 3200 } },
  "stills": { "cheerful": "stills/cheerful.webp", "caring": "stills/caring.webp" },
  "media": { "generator": "…", "ai_generated": true }
}
```

- `clips` 的形状不变，只是允许的片段名变多。
- `canvas` 可选；有的话，包内所有片段都必须是这个尺寸和帧率（校验）。
- `clip_meta` 可选，由入库工具写入：`settle_ms` 是一次性片段里"动作已经回落"的时间点（见 §4.4）；缺省等于片长。
- `stills` 可选，键只能是：`cheerful`、`caring`、`curious`、`focused`、`playful`、`thinking`、`praise`（中性表情就是 `anchor`）。
- `media` 可选，只补充"由什么生成"；**条款与能否再分发仍以现有的 `license` 字段为准**，两者冲突时以 `license` 为准。
- `crossfade_ms`：导入校验仍接受 0–600，不收紧。
- 后端角色资料里的 `video_avatar.loop_pack` 同步扩展；接口契约变了要重新生成客户端并提交生成物。
- 压缩包文件数上限从 32 提到 96（27 段 + 7 张表情图 + 锚点 + 清单，留出三段式的余量）；其余大小上限不变。

## 4. 播放规则

### 4.0 类型与接口放在哪一层

- 新增类型 `Situation`（表 4.1 里的"持续情境"行）与 `OneShotKind`（表 4.1 里的"一次性"行）。
- 新增纯函数 `phaseToSituation(phase, ctx)`，接在课堂相位函数之后；`ctx` 由课堂状态钩子给出（是否在出声、这一句是否带板书事件、是否处于"安静陪你"、输入框最近是否有输入、当前句子的序号）。
- `ITutorVideoDriver` 增加 `setSituation(situation, sentenceSeq, gen)` 与 `triggerOneShot(kind, gen)`。循环短片驱动实现本节全部规则。
- `TutorPose` / `InstantAction` 保留，作为由它们派生的兼容层：静态、本地实时、云端三个驱动继续只收旧取值，**对外协议不变**。降级表：

| 新取值 | 发给旧接口的取值 |
| --- | --- |
| wait、review | `listening_empathy` |
| prepare | `thinking` |
| ack | `empathy_nod` |
| hint | `think_chin` |
| encourage | `gentle_encourage` |
| celebrate | `praise_clap` |
| surprise | `praise_thumbs_up` |
| board_glance | 不发送 |

### 4.1 情境 → 片段

"组"表示在组内选择（见 4.3）。相位名见体验规格 §5.6.2。

**持续情境**

| 相位与条件 | 播什么 |
| --- | --- |
| `loading` | 静态立绘 |
| `preparing` | `prepare_notes` |
| `lobby`、`connecting` | 待机调度（4.2） |
| `thinking`、`buffering` | think 组 |
| `speaking` | speak 组，**每句开始时选一次**：这一句带指向或书写板书的事件 → `speak_board`；否则在包里存在的 `speak_calm`、`speak_explain_a`、`speak_explain_b` 中按权重 2:1:1 选，且不与上一句相同；每一轮讲话的第一句用 `speak_calm`。不做语义判断 |
| `listening` | listen 组 |
| `awaiting` 或 `thinking`，且输入框最近 2 秒有输入 | listen 组（状态钩子给出"正在输入"标志，相位机不变） |
| `awaiting`（其余时候） | `wait_gentle`；15 秒无操作后改为待机调度（"安静陪你"） |
| `judging` | `read_answer` |
| `ending`（道别播完之后）、小结页 | `idle_breathe` |
| `paused` | `idle_breathe`，不插入，画面变暗（与 U2a 一致） |
| `reconnecting`、`failed` | 停在当前帧 |

**一次性**

| 事件 | 播什么 |
| --- | --- |
| 学生点了开始（接通过渡） | `greet_wave` |
| 判定为对 | praise 组；同一节课里连续第三次答对时优先 `react_surprise` |
| 判定为错、部分对、不会 | `react_comfort` |
| 学生点了"没听懂 / 讲慢点 / 再讲一遍" | `react_comfort`（沿用 U0 的修复） |
| 学生在答错后选择再试一次 | `react_encourage` |
| 学生点了"给点提示 / 举个例子" | `hint_finger`，然后进 think 组 |
| 学生发来一句不是作答的话 | `nod_yes` |
| 白板出现新内容，且老师此刻**没在出声** | `board_glance` |
| 指向板书，且老师此刻**没在出声** | `board_point` |
| 确认下课 | `farewell_wave` |
| 课后小结第一次出现 | `react_celebrate` |

老师正在出声时，板书的指向或书写只影响 speak 组的选择（下一句用 `speak_board`），不触发一次性片段。
"连续第三次答对"只是前端为了选动作做的计数，不上报、不写入任何学习数据。

### 4.2 待机调度

- 基础片段是 `idle_breathe`。调度中的循环片段以"不自动循环"的方式播放，在每一轮播完（`ended`）时决定：重播，还是插入。
- 包里有 `idle_glance` 时，每隔 12–20 秒（随机）插入一次；有 `idle_fidget` 时，每隔 45–75 秒插入一次。插入的片段播完一遍就回到 `idle_breathe`。两次插入之间至少隔一轮完整的 `idle_breathe`。
- 两段都没有时不插入，行为与现在相同。
- 相位一变立刻退出调度。
- 随机数来源可注入（测试用固定序列）。
- 小尺寸场景（顶栏、今天页、空状态）不跑调度：只在进入视口或悬停时播 `idle_breathe`，沿用"同屏最多一个在播放的老师视频"的规定。

### 4.3 组内选择

- 只在包里实际存在的片段之间选（§2 规则 1）；只有一条就播那一条。
- speak 组：按 4.1 的规则每句选一次，不在一句话中间换片段。
- listen、think 组：每次进入情境选一次；停留超过两轮后，在当前这一轮播完时换成组里的另一条。
- praise 组：不连续两次用同一条。

### 4.4 一次性片段

- 时长取媒体元数据；结束信号是 `ended`；保险计时器等于"时长 + 400 毫秒"。**取消固定的 4000 毫秒**。
- 新的一次性动作、打断、暂停、重连：立即替换正在播的一次性片段。
- **讲话开始时不立即替换反应片段**：继续播到该片段的 `settle_ms`（动作已经回落的时间点），但从讲话开始算起最多再等 1500 毫秒，然后换成讲话片段。老师的声音和字幕不等它。
- 播完后回到"当前相位此刻应该播的片段"，不是回到触发前的那一段。

### 4.5 交叉淡化与预取

- 交叉淡化仍取清单里的 `crossfade_ms`。
- 预取分两级：进入课堂立即取 idle、listen、wait、speak、think 五组；空闲时再取其余。新片段解码出首帧之前，旧片段继续播（U2b 已有此规定）。

### 4.6 静态档与"减少动态效果"

没有短片、或系统要求减少动态效果时，仍然只显示静态图，但按情境换表情图，200 毫秒淡化；没有对应的图就用 `anchor`。当前显示的是哪一张，写在元素的 `data-still` 上（测试用）。

| 情境 | 表情图 |
| --- | --- |
| 答对、课后小结 | `praise`（没有则 `cheerful`） |
| 答错、没听懂 | `caring` |
| 等学生回答 | `curious` |
| 看答案、备课 | `focused` |
| 在想 | `thinking` |
| 给提示 | `playful` |
| 其余 | `anchor` |

**课堂之外**的位置（今天页的问候、空状态、出错提示、解锁页、404、课后小结页）也用这些表情图；哪个位置用哪张做成一张数据表，不散落在组件里。这些位置由 U3、U4 建立：UM-1 只做课堂内的换图；课堂之外的在这些页面落地时接入（U4 的"老师无处不在"任务取图时查这张表）。执行 UM-1 时如果某个位置已经存在，就一并接上。

### 4.7 进入—保持—退出（三段式，最后做，可以不做）

为了让老师能"一直托着腮""一直低头备课"，允许一个名字带三段：`<名字>_in`（坐姿 → 姿势，一次性）、`<名字>_hold`（姿势 → 姿势，循环）、`<名字>_out`（姿势 → 坐姿，一次性）。进入该状态时播 `_in` 再循环 `_hold`；离开时先播 `_out` 再切到下一个片段，**但老师的声音不等 `_out`**。三段缺任何一段就整体不用，回退到同组的普通片段。首批名字：`think_hold`、`prepare_hold`、`board_hold`。UM-1 只在目录里预留这些名字。

### 4.8 `intro_voice`

这是唯一带音轨的片段，音色来自生成模型，与课堂的语音合成不是同一个声音。体验规格要求自我介绍"用 TA 自己的声音"且与课堂一致，所以**默认不使用它**：老师页的展示编排仍按 U4（问候片段 + 讲话片段 + 课堂那套语音）。只有同时满足下面三条才播放 `intro_voice`：所有者在 `DECISIONS.md` 里明确启用；这位老师的名字、口头禅、音色都还是内置默认值；包里有这一段。

## 5. 素材约定

| 项目 | 约定 | 对谁判定 |
| --- | --- | --- |
| 画布 | 一个包内统一。首选 576×1024；允许 480×864。24 帧每秒 | 全部 |
| 编码 | VP9 profile 0，`yuv420p`，无音轨（`intro_voice` 例外：Opus 单声道） | 全部 |
| 关键帧 | 只在开头放一个（片段总是从头播）；不要每秒一个 | 全部 |
| 体积 | 单段不超过 1.2 MB；一位老师的全部片段不超过 14 MB | 全部 |
| 时长 | 循环 4–9 秒；一次性 2–8.5 秒 | **只判新入库的片段** |
| 起止 | 每段都从"正面坐姿"（下称基准帧）开始、回到基准帧结束。基准帧是立绘按画布尺寸精确缩放得到的图（素材包 `hub/`） | 只判新入库的片段 |
| 循环接缝 | 末帧与首帧的平均绝对差不超过 3.0，48 像素分块的最大值不超过 6.0（0–255 标度） | 只判新入库的片段 |
| 与基准帧的差 | 颜色校正之后，首帧、末帧相对基准帧的平均绝对差不超过 5.0 | 只判新入库的片段 |
| 表情图 | 1080×1920 WebP；与立绘配准（量法见下）；背景像素取自立绘 | 全部 |

**旧 8 段**（现有的 48 个文件，以及任何没有经过 `ingest` 的片段）：只判定"全部"那几行；时长、起止、接缝、与基准帧的差**只报告、不判定**——它们的实测值达不到这些门槛（例如有的循环只有 2.8 秒），要等新片段替换。

**一次性片段的裁剪**：生成出来的一次性片段是"动作 + 回到坐姿后的静止"。入库时可以裁掉首尾多余的静止（按与基准帧的相似度找边界），但动作前后各保留至少 6 帧静止；`settle_ms` 取动作回落到基准帧附近的时间点。

**表情图配准的量法**：在每位老师数据里的头部框内，对边缘图做相位相关，估计的平移不超过 ±9 像素（1920 高，即 0.5%）。裁切（头像 1:1、卡片 3:4 等）从立绘和表情图裁出，裁切框按每位老师的眼线、下巴、发顶位置计算，写成数据。

编码参考（在这台机器的 FFmpeg 7.1 上测过同类片段）：

```text
-an -c:v libvpx-vp9 -crf 32 -b:v 0 -g 240 -row-mt 1 -deadline good -cpu-used 1 -pix_fmt yuv420p
```

实测参考：同一段 3.25 秒的 480×864 片段，CRF 34、单关键帧约 161 KB；改成每秒一个关键帧体积增加 48%。

**旧片段的几何**：现有 480×864 的片段带上下各 5 像素的补边。在被新片段替换之前，入库工具要把它们裁掉补边、缩放到新画布，否则新旧片段切换时人物大小会差约 1.2%。

**命名**

- 原始成片（批量脚本自动命名）：`<编号>-<拼音>__<片段>__s<种子>__<宽>x<高>[-full-st<步数>]__p<提示词版本>.mp4`
- 原始图片：`<编号>-<拼音>__<任务名>__v<序号>.png`
- 入库后：`clips/<片段>.webm`、`stills/<表情>.webp`

## 6. 入库工具（`tools/tutorpack/`）

外部程序：FFmpeg 与 ffprobe 的路径由环境变量给出（建议 `TUTORPACK_FFMPEG`、`TUTORPACK_FFPROBE`），不随仓库和产品分发；找不到时给出说明怎么设置的报错，不静默跳过。这是许可决定：它们是外部工具，不链接、不分发。

素材包里所有者挑中的文件在两个位置：视频 `02-视频提示词/回传/<编号-拼音>/选中/`，图片 `01-图片提示词/回传/<编号-拼音>/选中/`。工具用 `--pack <素材包目录>` 接收路径。

| 命令 | 做什么 |
| --- | --- |
| `ingest` | 读取 `选中/` 里的成片：统一几何 → 去掉音轨（`intro_voice` 转成 Opus）→ 以基准帧为准做逐通道颜色校正（首末帧估计，片内线性过渡，中间格式用 16 位）→ 一次性片段裁掉多余的静止并算出 `settle_ms` → 检查起止与接缝，只有超过阈值时才在两端各做不超过 4 帧的过渡并在报告里写明 → 按第 5 节编码 → 写入角色包目录并更新清单 |
| `sheet` | 为每位老师出对照图（每段取首、25%、50%、75%、末五帧）和首末差异图，放到 `docs/rebuild/review/UM/`，供所有者看 |
| `validate` | 在现有检查之外，用 ffprobe 检查第 5 节的每一项，并按"对谁判定"一列区分判定与只报告；ffprobe 不可用时明确列出"未检查的项目" |
| `stills` | 表情图与立绘配准、从立绘合成背景、导出 WebP、按数据裁出头像与卡片 |
| `legacy-fix` | 把旧 480×864 片段裁掉补边、缩放到新画布并按第 5 节重新编码（一次性使用） |

工具需要的 Python 依赖如果超出现有的 Pillow，只能作为工具的开发依赖，许可按仓库规则核对并写入 `DECISIONS.md`。

**收编脚本**：素材包里的 `generate-prompts.mjs`（提示词生成）与 `run-h3-batch.mjs`（批量排队）收进 `tools/tutorpack/`，替换旧的 8 段提示词文档与"导出提示词"功能；角色数据（外观锁定句、动作气质、问候与道别的写法）从脚本里移到角色数据文件。收编后，素材包里的两个副本改成一行转调 `tools/tutorpack/` 里的脚本；`jobs.json`、`hub/`、`runs/`、`回传/` 和几个 `.cmd` 留在 `outputs/`，不进版本库。

## 7. 许可与登记

**事实**

- 短片与 6 条声音参考由本机的 MiniMax H3-Base 开源权重生成。《MiniMax H3 Community License Agreement》（2026-08-02）：适用地域排除欧盟、英国、韩国、美国；不得在适用地域外使用、复制、修改、分发或展示生成内容（第 V.4 条）；不得用生成内容改进其他 AI 模型（第 V.3 条）；公开传播须清楚标明机器生成（附件 A 第 12 条）；MiniMax 不主张对生成内容的权利（第 VI.4 条）。
- 立绘与表情图由 OpenAI 的图片生成制作。OpenAI 的条款把输出的权利让与用户；不得声称输出是人工创作。
- `AGENTS.md` "素材与许可"：只分发许可明确允许再分发的文件。

**要求**

1. **登记写真实来源**：`assets/avatars/LICENSES.md`、`assets/THIRD_PARTY_NOTICES.md`，以及六个内置角色包 `manifest.json` 里的 `license`（`terms` 与 `allow_redistribution`）。H3 生成的文件不再登记为 Apache-2.0、不再标"允许再分发"，改为写明"由 MiniMax H3 生成，适用其社区许可（含地域限制）"——除非所有者在 `DECISIONS.md` 里另有书面决定。
2. **现有的 48 段短片与 6 条声音参考**：所有者在 `DECISIONS.md` 写明选择之前，**只改登记、不改分发**，并在 `PROGRESS.md` 最前面写明"现有短片的分发与 AGENTS.md'素材与许可'冲突，待所有者决定"。所有者选"分开放"时，用 `git rm --cached` 把它们移出版本库，改由数据目录发现；新入库的短片在决定之前不进入公开发布的包。
3. **可分开**：内置目录能从数据目录发现角色包；发布脚本支持"带短片"和"不带短片"两种打包；不带短片时内置老师走静态档。
4. **标明 AI 生成**：README，以及老师页"形象与素材"里的"许可与作者"处，写明老师的图片与短片由 AI 生成、由什么生成。
5. 声音参考文件不用于训练或微调其他语音模型。
6. 许可测试（现有 `test_avatar_asset_licenses.py`）改为检查：每个素材文件都有登记；登记了生成工具；**生成工具带地域限制的文件，`allow_redistribution` 不为真**。不检查条款文字的具体取值。

## 8. 可自动检查的不变量（编号接体验规格 §9）

| 编号 | 不变量 | 类型 | 何时 |
| --- | --- | --- | --- |
| I17 | 目录单一来源：一份包含全部目录名的清单，能被后端导入、被命令行 `validate` 接受、被驱动解析；多一个目录外的名字，后端和命令行都拒绝 | 后端测试 + 命令行测试 + 驱动单测 | UM-1 |
| I18 | 只有旧 8 段的包：同一段事件序列下，改造前后产生相同的片段序列（`data-clip`） | 驱动单测（事件序列夹具，改造前先录下序列） | UM-1 |
| I19 | 没有新指令时，5 秒的一次性片段在第 4.2 秒仍在播，并在 5.4 秒前回到相位对应的片段 | 驱动单测（假时钟、假 video） | UM-1 |
| I19b | 答对后 0.3 秒开始出声：在"`settle_ms` 与出声后 1.5 秒两者较早者"之前，`data-clip` 仍属于 praise 组 | 驱动单测 | UM-1 |
| I20 | 包里有 `idle_breathe` 与 `idle_glance` 时，60 秒的待机里两者都出现过，且两次插入之间隔着一轮完整的 `idle_breathe`；只有 `idle_breathe` 时不插入 | 驱动单测（固定随机序列，假 video 触发 `ended`） | UM-1 |
| I21 | 包里有对应片段时：开始后第一个片段属于 greet 组；确认下课后属于 farewell 组 | 端到端（测试角色包带这两段） | UM-1 |
| I22a | 内置角色包：清单里的每个文件都存在、片段名都在目录里、体积不超限 | 后端测试（随门禁） | UM-1 |
| I22b | 内置角色包的片段满足第 5 节其余各项 | `validate` 手动运行，输出贴进 `PROGRESS.md`；没运行就写"未检查" | UM-1、UM-2 |
| I23 | 课堂内的静态档按情境换图：答对后 `data-still` 是 `praise` 或 `cheerful`；答错后是 `caring`（包里有这些图时） | 端到端（测试角色包带两张表情图） | UM-1 |

测试夹具需要的短片用工具生成的纯色或渐变小视频即可，放在测试目录；不得把它们当作内置角色包。

## 9. 不做清单

实时口型与逐句情绪识别；换装与节日皮肤；新增角色；在产品里调用生成模型；改 Sidecar 协议；把 FFmpeg 打进产品包；为素材引入 Git LFS；用 H3 生成的人声训练或微调语音模型。
