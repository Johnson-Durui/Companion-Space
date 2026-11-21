# Codex 任务单：角色子系统纯视频重塑（V1 → V3）

> **任务定位**：在 `Companion-Space-v2`（1.0 RC 基础上）执行角色子系统重塑——**彻底去 3D VRM、落地微信视频通话样式框 `<TutorVideoBox>`、强化线上一对一双轨演出与 150ms 抢断微动作、建立二次元 `.tutorpack` 角色包工具链、并开放本地 GPU Sidecar 实时视频协议与参考模板**。
> **权威规格**：先通读 [`spec/tutor-video-avatar.md`](spec/tutor-video-avatar.md)。本文档决定“做什么、按什么顺序做、什么时候停下”；`spec/tutor-video-avatar.md` 决定“怎么做”。
> **执行原则**：严格分 **3 个独立会话（V1 → V2 → V3）**顺序推进。每个里程碑到达**停止点**必须停下、更新 `docs/rebuild/PROGRESS.md`、小步提交到本地 `rebuild/tutor`（**不推送**），向所有者汇报（先说没做完/没验证/已知问题），等所有者验收通过后再开下一个里程碑。

---

## 一、直接发给 Codex 的开工口令

在 `E:\Codex\Projects\虚拟形象\Companion-Space-v2` 目录启动 Codex，并确保允许其写入链接工作树元数据目录 `E:\Codex\Projects\虚拟形象\Companion-Space\.git`。

### 会话 1：执行 V1（微信视频框 + 双缓冲循环引擎 + 150ms 抢断微动作 + 去 3D VRM）

```text
请执行角色子系统的纯视频重塑任务单，本次只做里程碑 V1。

请按以下顺序开始：
1. 先读根目录 AGENTS.md、docs/rebuild/PROGRESS.md、docs/rebuild/DECISIONS.md、
   docs/rebuild/TASK-VIDEO-AVATAR.md（全文）与 docs/rebuild/spec/tutor-video-avatar.md（全文）。
2. 先做第 0 节环境与 Git 基线核对：运行 git rev-parse --git-common-dir、git branch --show-current、
   git status --short。
   - 本工作区是 git 链接工作树，版本库数据在 E:\Codex\Projects\虚拟形象\Companion-Space\.git，允许写入那里，
     但禁止读写 E:\Codex\Projects\虚拟形象\Companion-Space 中的其他文件。
   - 任何时候禁止运行会丢弃改动的 git 命令（git clean / stash / reset --hard / checkout -- / restore），
     不得切换分支，不得推送远端，不得删除或移动 storage/。
   - 如果开工前 git status 显示已有 1.0 RC 遗留的未提交改动，先停下向我汇报变更摘要，确认是否先打一个基线提交，再开始 V1。
3. 只做 V1，不得提前做 V2 或 V3。开工前先 grep 实际代码中的调用方，发现规格与实际代码不一致时，
   以实际代码为事实、以规格意图为目标，并记录到 docs/rebuild/DECISIONS.md。
4. 严守 scripts/check_no_fakes.py 与 Apache-2.0 红线：
   - 产品源码中禁止出现 mock/fake/demo_mode/canned（含注释）；
   - classroom/teaching 等受检目录源码中字符串字面量不得含 4 个及以上汉字，中文文案全部进 locales/zh-CN.json（单条 ≤60 字符）；
   - 严禁引入任何 GPL/AGPL 代码或用脚本画色块冒充二次元老师成品视频。
5. 做到 V1 停止点停下，跑通 powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract，
   按模板更新 docs/rebuild/PROGRESS.md、小步提交，并先汇报未完成/未验证/已知问题。
```

### 会话 2：执行 V2（二次元 `.tutorpack` 生态 + 单图即用导入 + 打包 CLI + ComfyUI 二次元 1→8 模板）

```text
继续执行角色子系统纯视频重塑任务单，本次只做里程碑 V2（V1 已通过验收）。

先读 AGENTS.md、docs/rebuild/PROGRESS.md、docs/rebuild/TASK-VIDEO-AVATAR.md 的通用规则与 V2 小节，
以及 docs/rebuild/spec/tutor-video-avatar.md §2、§6、§9。
按 V2 任务清单顺序实施，严守安全边界（防 Zip-Slip、魔数校验、不可信文本隔离）与 check_no_fakes.py 门禁，
禁止用代码伪造二次元老师成品短片。
做到 V2 停止点停下，跑通 scripts/gate.ps1 -Frontend -Contract，更新 docs/rebuild/PROGRESS.md 并汇报。
```

### 会话 3：执行 V3（开放 `TutorVideo Sidecar Protocol v1` + 本地 GPU 二次元参考模板 + 设置页与云端熔断预留）

```text
继续执行角色子系统纯视频重塑任务单，本次只做里程碑 V3（V2 已通过验收）。

先读 AGENTS.md、docs/rebuild/PROGRESS.md、docs/rebuild/TASK-VIDEO-AVATAR.md 的通用规则与 V3 小节，
以及 docs/rebuild/spec/tutor-video-avatar.md §5、§7、§9。
本次核心是交付 Apache-2.0 协议层、本地 GPU Sidecar 开源参考模板（sidecars/local-gpu-avatar/）、
后端回环代理与设置页，以及 1 秒自动降级与云端计费/沉默 30s 挂起熔断框架。
严禁引入 GPL/AGPL 代码或把 GPU 依赖写进主应用 requirements.txt。
做到 V3 停止点停下，跑通 scripts/gate.ps1 -Frontend -Contract 与 sidecar 独立测试，更新 docs/rebuild/PROGRESS.md 并汇报。
```

### 验收不通过时的返工口令

```text
V<n> 验收未通过：<第几条>，现象是 <你看到的现象>。请先复现并定位根因，再最小改动修复；修复后重跑 scripts/gate.ps1 -Frontend -Contract 与对应验证，更新 docs/rebuild/PROGRESS.md 后再汇报。
```

---

## 二、第 0 节：通用纪律与开工前核对

1. **基线检查（必做）**：
   - 运行 `git rev-parse --git-common-dir`、`git branch --show-current`（应为 `rebuild/tutor`）、`git status --short`。
   - 若工作区已有未提交的历史改动（例如 M6–M8 集成收尾改动），**先停下请所有者确认是否先提交基线快照**，再动 V1 代码。
2. **唯一总门禁（每个里程碑结束必过）**：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract
   ```
   任何 OpenAPI 模型/路由变更后必须先执行 `npm run generate:api` 并提交更新后的 `packages/api-client/`。
3. **机械检查避坑（见 `scripts/check_no_fakes.py`）**：
   - 产品源码（`services/api/app`、`apps/web/src`、`libs/prompts/v3`、`packages/*/src`）中绝不出现 `\b(?:mock|fake|demo_mode|canned)\b`（不区分大小写，注释里也不行；测试目录除外）。
   - `apps/web/src/features/{classroom,learner,plan,review}` 的 TS/TSX 与 `services/api/app/{teaching,learning,analysis,voice}` 的 Python 中，字符串字面量不得包含 `>= 4` 个汉字。所有新增中文文案统一放进 `apps/web/src/locales/zh-CN.json`（每条 `<= 60` 字符）或 `services/api/app/i18n/zh-CN.json`。
4. **Workspace 边界**：
   - 根目录 `package.json` 定义 `"workspaces": ["apps/web", "packages/*"]`。纯 Python 工具与 Sidecar 放在 `tools/tutorpack/` 和 `sidecars/local-gpu-avatar/`，**不要放进 `packages/`**，以免破坏 npm workspaces 解析或污染便携包。
5. **汇报模板**（写入 `docs/rebuild/PROGRESS.md`）：
   - 必须先写 `**待完成与待验证**`（明确列出未验证项与已知局限），再写 `**已落地**` 与 `**本地验证**`；状态只使用：`进行中` / `代码完成（自动化通过）` / `所有者验收通过`。

---

## 三、里程碑 V1：微信视频框 + 循环短片引擎 + 150ms 抢断微动作 + 彻底去 3D VRM

**目标**：彻底告别 3D VRM 与 WebGL 负担，用极轻量的纯视频框 `<TutorVideoBox>` 替代课堂与预览区的 3D 舞台，实现线上一对一 6 大教学姿态、双 `<video>` 180ms 交叉淡化循环播放引擎、150ms 副轨抢断微动作与客观题秒判反馈，保持所有现有课堂/语音/学习闭环测试全绿。

**参考规格**：`docs/rebuild/spec/tutor-video-avatar.md` §1–§5、§8、§9。

### 任务清单（按顺序执行，小步提交）

1. **V1.1 登记决策与归档 3D VRM 资产**
   - 在 `docs/rebuild/DECISIONS.md` 追加本次决策（去 3D VRM、转纯视频微信通话框、二次元优先、本地 GPU Sidecar 优先，取代旧决策 #15/#16/#17/#27 与支线 C）。
   - 在 `docs/rebuild/spec/character-pipeline.md` 顶部标注已被 `spec/tutor-video-avatar.md` 取代。
   - 将 `assets/avatars/models/*.vrm` 与 `content/characters/{7-constraint,8-shino,9-fumiriya}.json` 移入 `assets-archive/retired-vrm/`（保留历史记录，退出运行时）。
   - 更新 `assets/avatars/LICENSES.md`、`assets/THIRD_PARTY_NOTICES.md`（移除已归档 VRM 及 `wlipsync`/`three-vrm-lip-sync` 条目）与 `scripts/build-portable.ps1`（同步更新 `PORTABLE-ASSET-STATUS.md` 文案，不再提及 3 个 VRM 模型）。

2. **V1.2 后端角色模型升级至 `schema_version = 3` 并兼容旧库**
   - 改动：`services/api/app/services/tutor_catalog.py`、`content/characters/{1-mira,2-kite,3-cael,4-lyra,5-nova,6-echo}.json`、`services/api/app/api/routes/tutors.py`、`services/api/app/api/routes/lessons.py`。
   - 为 `Character` 新增 `video_avatar`（`aspect_ratio`、`preferred_tier`、`anchor_image`、`loop_pack`、`local_sidecar`、`cloud_live`）与 `pack_metadata`；`appearance.kind` 收敛为 `Literal["portrait", "video_pack"]`。
   - 实现 `_normalize_recipe`：透明兼容读取旧 SQLite 中 `schema_version == 2` 的立绘角色；在 `list_characters()` 中自动隐藏已退役的 `vrm` 记录（不删表行、不删 `storage/`）；当 `default_character_id` 或 `lesson.character_id` 指向已退役 VRM 角色时，确定性回退至可用内置二次元老师（优先 `tutor-echo` → `tutor-nova`）。
   - 支持内置二次元老师在 `assets/avatars/packs/<id>/` 存在合法短片包时自动绑定 `loop_pack` 路径（不覆盖用户手动修改的 `persona`/`voice`/`default_style_id`）。
   - 移除 `tutors.py` 中的 `.vrm` 校验与 `/model` 路由（先 grep 清理所有调用方与旧测试），运行 `npm run generate:api` 更新 OpenAPI 客户端。

3. **V1.3 后端客观题秒判 `judge.preview` 与 `recent_avatar_action` 闭环**
   - 改动：`services/api/app/teaching/runtime.py`、`services/api/app/teaching/live.py`。
   - 在 `LessonRuntime.step` 新增可选回调 `on_judge: Callable[[str], Awaitable[None]] | None = None`：当客观题完成确定性 `grade_objective()` 后、进入 `Realizer.run()` 前立即触发。
   - 在 `LiveLesson._step` 中通过该回调发送非落库 WS 事件 `{"v": 1, "lesson_id": ..., "gen": preview_gen, "seq": 0, "type": "judge.preview", "data": {"verdict": verdict}}`（绝不携带答案或解析，不改变落库事件流与掌握度逻辑）。
   - 在 `LiveLesson` 接受 `student.quick` / `student.answer` 可选白名单字段 `recent_avatar_action`，透传至 `Realizer` 的 `context` 数据块（不改动 `libs/prompts/v3/variables.json` 校验规则，或若需提示词说明则同步登记）。

4. **V1.4 彻底剥离前端 3D 依赖并重写 `packages/avatar-engine`**
   - 改动：`packages/avatar-engine/package.json`（删除 `three`、`@types/three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation`、`@react-three/fiber`、`three-vrm-lip-sync`、`wlipsync`）并更新根 `package-lock.json`。
   - 删除 3D 源码文件（`vrm-stage.tsx`、`vrm-recipe.ts`、`vrm-appearance.ts`、`vrm-speech-controller.ts`、`viseme.ts`、`audio-lip-sync.ts`、`pet-registry.ts`）。
   - 精简 `apps/web/src/audio/speech-output.ts`：去除 `wlipsync` / `VisemeWeights`，保留轻量 RMS `onLevel`，并新增按需启用的 `onSpeechChunk`（24kHz mono `pcm_s16le` 重采样输出，无监听方时零开销）。
   - 在 `packages/avatar-engine/src/` 实现：
     - `types.ts`：`ITutorVideoDriver`、`TutorPose`、`InstantAction`、`ClipSlot`、`VideoDriverCapabilities` 等；
     - `choreographer.ts`：`AvatarChoreographer` 纯状态机（6 大姿态、讲课节拍 A/B 交替、副轨 150ms 抢断映射、`gen` 过期屏障、15 秒无交互切换 `idle_companion` 且不发任何学习证据）；
     - `static-driver.ts`：Tier 0 `StaticPortraitDriver`（单图 + `--speech-level` 音频能量光环 + 姿态微动效 + `prefers-reduced-motion` 适配）；
     - `loop-pack-driver.ts`：Tier 1 `LoopPackVideoDriver`（双 `<video>` A/B 180ms 交叉淡化、单次短片播完回主轨、缺片自动回退、≤300ms `interrupt(gen)` 收回至 `listen_nod`）；
     - `video-box.tsx`：`<TutorVideoBox>` React 容器组件（统一承接驱动实例、状态胶囊、档位小标、底部可折叠字幕、语音能量指示）。

5. **V1.5 接入课堂、欢迎页、角色预览与微信视频框样式**
   - 改动：`apps/web/src/features/classroom/{classroom.tsx,use-classroom.ts,lesson-state.ts,classroom.css}`（删除 `classroom-avatar.tsx`）、`apps/web/src/features/characters/teacher-preview.tsx`、`apps/web/src/features/onboarding/welcome.tsx`、`apps/web/src/locales/zh-CN.json`。
   - 课堂页接入 `<TutorVideoBox>` 与 `AvatarChoreographer`：
     - 快捷按钮（`confused` / `hint` / `example` / `show_answer` / `repeat` / `slower` / `break` / `locate:*`）点击瞬间（0ms）触发对应副轨 `InstantAction`；
     - 收到 `judge.preview`（以及落库 `judge` 去重）立刻触发 `praise_thumbs_up` / `gentle_encourage`；
     - 麦克风按住说话 / 免提打断 / 点“打断”时调用 `interrupt(gen)` 与 `listening_empathy`；
     - `ask` 等待超过 15 秒自动切 `idle_companion`，聚焦输入框或按键立刻恢复 `listening_empathy`。
   - 微信视频通话框响应式样式：桌面左侧 35% 圆角竖屏框；手机端顶部紧凑窗，滚动白板出视口时提供页内 `position: sticky` 右上角小窗（点按展开，无桌面独立悬浮窗）。
   - 欢迎页 `welcome.tsx` 移除 “3D 示例老师” 分组，统一以二次元视频框风格展示老师名册（优先展示 Apache-2.0 的**沐音**与**星澜**）。

### V1 自动化验收门
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 全绿。
- 后端单测覆盖：
  - `schema_version == 2` 旧库立绘角色透明升级；
  - 旧库 `default_character_id` / `lesson.character_id` 指向已退役 VRM 时确定性回退不崩溃；
  - 客观题提交时 `judge.preview` 在 LLM `Realizer` 输出前即下发，且不泄漏答案、不改掌握度不变量；
  - 资产许可单测通过（无未登记资产、无退役 VRM 残留在活跃目录）。
- 前端单测（Vitest）覆盖：
  - `AvatarChoreographer` 全部 6 姿态转换、A/B 讲解短片交替、过期 `gen` 丢弃、15 秒静默切换 `idle_companion` 与交互唤醒、副轨抢断与 `interrupt(gen)` 复位；
  - `LoopPackVideoDriver` A/B 槽位交叉淡化逻辑、缺片回退到 `idle_breathe` / `anchor_image`、单次短片 `ended` 自动回主轨；
  - `apps/web/dist` 构建产物中不再包含 `three` / `three-vrm` / `wlipsync`。
- **目视截图留档**（保存到 `docs/rebuild/review/V1/`）：桌面端微信视频框（待机、讲解、指向白板、答对反应、答错安抚）、欢迎页选老师、手机端窄屏视频框。

### V1 所有者验收清单
- [ ] 打开课堂，左侧是类似微信视频通话的竖屏视频框，右侧是我的课件/白板，没有任何 3D 僵硬模型或 WebGL 报错。
- [ ] 点「没听懂」「给点提示」或提交客观题后，不等老师声音出来，视频框在瞬间就有安抚/思考/鼓励的视觉反应。
- [ ] 老师讲话时我打断说话，声音与动作立刻同步收回为倾听态。
- [ ] 做题发呆超过 15 秒，老师切到安静陪伴态，我一打字立刻抬头接回。
- [ ] 欢迎页与角色库展示干净，旧版数据库升级打开无报错。

**→ V1 停止点**：更新 `docs/rebuild/PROGRESS.md`，小步提交到本地 `rebuild/tutor`，向所有者汇报并等待验收。

---

## 四、里程碑 V2：二次元 `.tutorpack` 生态 + 单图即用导入 + 打包 CLI + ComfyUI 二次元 1→8 模板

**目标**：让用户和开源社区能“拖进 1 张喜欢的二次元图片立刻上课”，也能按开源模板免费生成 8 段首尾帧锚定二次元短片、打包成 `.tutorpack` 一键导入，立刻获得 60fps 流畅丰富的线上一对一教学动作。

**参考规格**：`docs/rebuild/spec/tutor-video-avatar.md` §2、§6、§9。

### 任务清单（按顺序执行，小步提交）

1. **V2.1 后端 `.tutorpack` 解析、校验与安全存储服务**
   - 新增：`services/api/app/services/tutorpack.py`；改动：`services/api/app/services/tutor_catalog.py`、`services/api/app/api/routes/tutors.py`。
   - 升级 `POST /api/v2/characters/import` 支持两类上传：
     - **单图导入**（`.png` / `.jpg` / `.jpeg` / `.webp`，≤ 10 MiB）：Pillow 校验真实格式与尺寸，清 EXIF 转存 `anchor.webp`，立即返回 Tier 0 角色；
     - **`.tutorpack` / `.zip` 导入**（≤ 100 MiB，解压总量 ≤ 150 MiB，最多 32 文件）：严格校验 Zip-Slip、路径穿越、Windows 保留名、可执行后缀、符号链接、`manifest.json` 规范、图片头与 WebM/MP4 魔数、单短片 ≤ 15 MiB。
   - 新增 `GET /api/v2/characters/{character_id}/assets/{asset_path:path}`（鉴权、路径封闭校验、支持 HTTP `Range` 请求的 `FileResponse`、`X-Content-Type-Options: nosniff`）。
   - 新增 `DELETE /api/v2/characters/{character_id}`（仅允许删用户导入角色，禁止删内置角色，删除当前默认老师时自动切回内置老师）。
   - 更新 OpenAPI：`npm run generate:api`。

2. **V2.2 角色库界面重塑与单图/角色包预览（`/characters`）**
   - 改动：`apps/web/src/features/characters/{library.tsx,teacher-preview.tsx}`、`apps/web/src/locales/zh-CN.json`。
   - 拖放/选择上传框支持 `.tutorpack`、`.zip`、`.png`、`.jpg`、`.webp`（移除 `.vrm` 提示与校验）。
   - 角色详情卡片展示：
     - 微信视频框实时预览（`<TutorVideoBox>`），附**一键姿态试演按钮条**（待机 / 倾听 / 思考 / 讲解 / 指白板 / 答对点赞 / 答错安抚），让用户导入后当场检验 8 段短片切换是否丝滑；
     - 8 槽位完整度清单（已提供哪些短片、哪些将自动回退）；
     - 许可与作者信息展示（`author`、`terms`、`allow_redistribution`）；
     - 删除自定义角色按钮（带确认）；
     - **「导出 8 段二次元短片提示词」**按钮（下载可直接用于 ComfyUI / 视频生成模型的该角色定制提示词文本）。

3. **V2.3 开源二次元制片工具链与 ComfyUI 模板（`tools/tutorpack/`）**
   - 新增目录 `tools/tutorpack/`（Apache-2.0，纯 Python 标准库 + Pillow，不写入 npm workspace）：
     - `tools/tutorpack/cli.py`：实现 `validate`、`pack`、`scaffold` 三个子命令；
     - `tools/tutorpack/prompts/anime-8-clips.zh-CN.md`：二次元 / 2.5D 专用 8 段首尾帧锚定分镜提示词（含正/负向提示词、空背景无路人防穿帮指南、右侧白板指向镜像说明、分辨率 576×1024 / 720×1280 与 24fps WebM/VP9 转码参数）；
     - `tools/tutorpack/comfyui/anime_tutor_loop_workflow.json` 与 `tools/tutorpack/README.md`：面向 8G–16G 显存（RTX 5060 / 5060Ti 等）的 ComfyUI 首尾帧锚定 I2V 免费工作流模板与图文步骤说明。
   - **再次强调红线**：不要用代码合成假视频放进 `assets/avatars/packs/`；随仓内置的**沐音**与**星澜**在所有者亲自生成并验收 8 段二次元短片前，保持干净的 Tier 0 高清二次元立绘运行，一旦所有者用 `tools/tutorpack/cli.py` 把验收后的短片放入 `assets/avatars/packs/tutor-echo/` 或 `tutor-nova/`，系统无需改代码即自动切换为 Tier 1！

### V2 自动化验收门
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 全绿。
- 后端安全与功能测试（在临时目录构造合法与恶意测试包）：
  - 单图 PNG/WebP 导入 → 清除 EXIF → 列表可见 → 资产可访问 → 可删除；
  - 完整 8 片段与部分片段 `.tutorpack` 导入 → HTTP `Range` 请求返回 206 → 缺片优雅降级；
  - 安全拒绝测试：Zip-Slip（`../evil`）、反斜杠路径、Windows 保留名（`CON.webm`）、可执行文件（`.exe`/`.ps1`）、伪造扩展名（文本改名 `.webm`）、超限解压炸弹、删除内置老师 → 全部明确拒绝（400/403/413）。
- `tools/tutorpack/cli.py` 单元测试覆盖 `scaffold` → `validate` → `pack` → 后端 `import_tutor` 全链路闭环。

### V2 所有者验收清单
- [ ] 在角色库随便拖入一张二次元图片，3 秒内就能设成老师并进课堂上课。
- [ ] 在角色库点「导出 8 段二次元短片提示词」，下载的提示词清晰、可直接用于生成动画。
- [ ] 用 `tools/tutorpack/cli.py pack` 打包一套测试 `.tutorpack` 导入角色库，点姿态试演按钮能看到 180ms 丝滑过渡，且无黑屏闪帧。
- [ ] 删除自己导入的角色后不会影响内置老师，若删的是默认老师会自动切回可用老师。

**→ V2 停止点**：更新 `docs/rebuild/PROGRESS.md`，小步提交到本地 `rebuild/tutor`，向所有者汇报并等待验收。

---

## 五、里程碑 V3：开放 `TutorVideo Sidecar Protocol v1` + 本地 GPU 二次元参考模板 + 设置页与云端熔断预留

**目标**：把开源视频数字人接口彻底标准化留给使用者——交付可直接启动联调的本地 GPU Sidecar Apache-2.0 协议栈与参考服务模板，在设置页提供本地 Sidecar 接入与一键测试，并预留云端 BYOK 槽与实时计费/沉默 30s 省钱挂起熔断器；任何 Sidecar 断开都能 1 秒内无崩溃回落到 Tier 1/0。

**参考规格**：`docs/rebuild/spec/tutor-video-avatar.md` §5、§7、§9。

### 任务清单（按顺序执行，小步提交）

1. **V3.1 后端 Sidecar 协议代理、回环安全策略与设置接口**
   - 新增：`services/api/app/avatar/{protocol.py,sidecar_client.py,settings.py}` 与 `services/api/app/api/routes/avatar_drivers.py`（注册进 `app/api/v2.py`）。
   - 配置存 `app_settings["avatar_driver_settings"]`（无需改数据库表）：
     - 本地 Sidecar 列表（默认强制回环 `127.0.0.1` / `localhost` / `::1`，勾选 `allow_lan` 后才允许 `is_local_endpoint` 私有网段，一律禁公网/凭据 URL/重定向）；
     - 预留云端实时视频设置（`connection_id`、`model`、`idle_suspend_sec=30`、`max_session_minutes=10`、`max_session_cost_cny=20.0`）。
   - 实现端点：
     - `GET / PUT /api/v2/avatar-drivers/settings`
     - `POST /api/v2/avatar-drivers/sidecars/test`（探测 `/v1/avatar/capabilities` 并返回协议版本、驱动名、传输模式、GPU 信息与耗时）
     - `POST /api/v2/avatar-drivers/sidecar/sessions`（后端读取目标角色的 `anchor_image` 字节并 Base64 转发，不向外部暴露磁盘绝对路径）
     - `WS /api/v2/avatar-drivers/sidecar/sessions/{session_id}/stream`（复用到现有 `authorize_websocket` 票据与 Origin 校验，双向透传 JSON 控制帧与 `TSVA`/`TSVF` 二进制帧）
     - `DELETE /api/v2/avatar-drivers/sidecar/sessions/{session_id}`
   - 更新 OpenAPI：`npm run generate:api`。

2. **V3.2 本地 GPU 二次元 Sidecar 开源脚手架与参考模板（`sidecars/local-gpu-avatar/`）**
   - 新增独立 Python 项目 `sidecars/local-gpu-avatar/`（**100% Apache-2.0**，独立 `pyproject.toml`、`requirements.txt`、`README.md`，绝不把 GPU 依赖加入主服务 `services/api/requirements.txt`）：
     - `protocol.py`：`TutorVideo Sidecar Protocol v1` 模型 + `TSVA`（音频上行）/ `TSVF`（视频帧下行）编解码；
     - `adapter_base.py`：`BaseAvatarRenderer` 抽象基类（含 `load_anchor`、`on_audio_pcm`、`on_pose`、`on_instant_action`、`on_interrupt`、`render_frame`、`close`）；
     - `server.py`：FastAPI + Uvicorn 服务（默认 `127.0.0.1:8090`），完整实现 4 个标准端点、25fps 帧率节流、按 `gen` 丢弃过期音频与实时打断清理、断开自动释放资源；
     - `adapters/anime_2d_reference.py`：无独显也可立即联调协议的纯 Pillow 二次元动态基线渲染器（基于单图 `anchor_image` 输出 25fps WebP 实时帧，响应 24kHz PCM 能量与姿态/抢断动作；README 中诚实标注其为协议联调基线，不冒充神经口型模型）；
     - `adapters/gpu_bridge_template.py` + `README.md`：面向本机 RTX GPU（如 RTX 5060 8GB / 5060Ti 16GB）的**开源本地模型对接模板与文档**，给出接入用户自装 MuseTalk（4–6G 显存轻量口型）/ LivePortrait / LiveAct / FlashHead 推理进程的清晰代码骨架、显存对照表与独立环境安装步骤（严禁包含任何 GPL 代码或权重下载脚本）。

3. **V3.3 前端 `LocalSidecarVideoDriver`、自动 1 秒降级与 `LiveCostGuard` 熔断器**
   - 在 `packages/avatar-engine/src/` 新增：
     - `sidecar-driver.ts`：`LocalSidecarVideoDriver`（支持 `webrtc` SDP 协商 + `ws_frames` `createImageBitmap` 零拷贝渲染；把 `SpeechOutput` 产出的 24kHz PCM `TSVA` 帧与控制指令实时送入 Sidecar；心跳超时或断开时在 **≤1000ms** 内发出 `degraded`）；
     - `cost-guard.ts`：`LiveCostGuard`（纯逻辑可测：活跃计时、预算/时长上限熔断、沉默超过 `idle_suspend_sec=30s` 自动挂起释放流并在学生交互时唤醒）；
     - `driver-manager.ts`：统一编排降级链 `cloud_live → local_sidecar → loop_pack → static`，降级时原地切回同角色低档驱动，保证声音与白板零中断。
   - 改动：`apps/web/src/features/classroom/{classroom.tsx,use-classroom.ts}` 将 `SpeechOutput.onSpeechChunk` 与当前老师所选驱动档位接入 `VideoDriverManager`，在 `<TutorVideoBox>` 顶部显示当前实际运行档位与降级提示（以及 Tier 3 激活时的实时计时/预算胶囊与一键切回免费档按钮）。

4. **V3.4 设置页新增「视频形象」板块（`#avatar`）**
   - 改动：`apps/web/src/features/settings/settings.tsx`、新增 `apps/web/src/features/settings/avatar-settings.tsx`、`apps/web/src/locales/zh-CN.json`。
   - 用户可在「设置 → 视频形象」中：
     - 添加/编辑/启用本地 Sidecar 地址（默认提示 `http://127.0.0.1:8090`），点击「测试连接」实时回显驱动名、支持传输方式、最大帧率与延迟；
     - 为单个角色在角色库或设置页选择期望档位（自动降级 / 静态 / 短片包 / 本地实时流 / 预留云端实时流）；
     - 配置云端熔断默认阈值（沉默挂起秒数、单课时长与预算上限，提示需搭配兼容云端适配器使用）。

### V3 自动化验收门
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 全绿。
- `sidecars/local-gpu-avatar/` 独立 pytest 全绿（测试 4 个协议端点、`TSVA`/`TSVF` 帧编解码、`interrupt(gen)` 丢弃旧帧、会话关闭释放资源）。
- 端到端真实回环集成测试（使用真实启动的 `sidecars/local-gpu-avatar` 参考服务，不造假）：
  - Companion Space 后端 `/api/v2/avatar-drivers/sidecars/test` 成功探测 `capabilities`；
  - 创建会话 → 推 `TSVA` 音频与 `instant_action` → 收到 `TSVF` WebP 帧 → `DELETE` 正常关闭；
  - 安全拒绝测试：非回环公网地址（`http://example.com`）、内嵌凭据 URL（`http://user:pass@127.0.0.1:8090`）一律被拒；
  - 断连降级测试（Vitest）：模拟 Sidecar WS 意外关闭 → `VideoDriverManager` 在 ≤1000ms 内切回 `loop_pack` / `static` 并输出明确原因；
  - `LiveCostGuard` 单测：沉默 30s 自动挂起、交互唤醒、达到时长/金额上限自动触发熔断释放。

### V3 所有者验收清单
- [ ] 启动 `sidecars/local-gpu-avatar` 参考服务（`uvicorn server:app --host 127.0.0.1 --port 8090`），在「设置 → 视频形象」点测试连通通过。
- [ ] 进课堂上课，微信视频框左下/左上角显示「本地实时」，老师随声音与动作实时响应。
- [ ] 上课中途强行 `Ctrl+C` 关掉 Sidecar 进程：1 秒内视频框无崩溃平滑切回短片包/立绘并给出清晰提示，老师的语音和白板完全不断线。
- [ ] 阅读 `sidecars/local-gpu-avatar/adapters/gpu_bridge_template.py` 与 `README.md`：按文档能清楚看到如何把自己的本地二次元推理模型（如 MuseTalk / LiveAct）接进来。

**→ V3 停止点**：更新 `docs/rebuild/PROGRESS.md` 与 `README.md` / `README.en.md`（同步角色能力说明与开放协议链接），小步提交到本地 `rebuild/tutor`，向所有者汇报。

---

## 六、附录：所有者（人工）配套清单（与 Codex 分工）

以下两项涉及视觉审美定稿与本机 GPU 推理权重，按仓库纪律**由你本人完成，不让 Codex 用代码伪造**：

1. **制作内置二次元老师的 8 段循环短片包（可在 V2 完成后随时进行）**：
   - 使用仓库内已确认 Apache-2.0 的两张二次元立绘：`assets/avatars/portraits/echo.png`（沐音）与 `assets/avatars/portraits/nova.png`（星澜）。
   - 用 V2 交付的 `tools/tutorpack/prompts/anime-8-clips.zh-CN.md` 与 `tools/tutorpack/comfyui/anime_tutor_loop_workflow.json`，在你本机显卡（或你偏好的图生视频工具）跑出 8 段首尾帧锚定短片并亲自挑出无崩坏的成片。
   - 运行 `python tools/tutorpack/cli.py validate <目录>` 校验通过后，放入 `assets/avatars/packs/tutor-echo/`（或直接 `pack` 成 `.tutorpack` 从网页导入），并在 `assets/avatars/LICENSES.md` 登记生成工具与许可说明。
2. **可选：在你的 RTX GPU 上挂载真实开源神经口型/全身模型（V3 完成后）**：
   - 参照 `sidecars/local-gpu-avatar/README.md` 在独立虚拟环境安装你想试用的模型（例如 4–6G 显存可跑的 MuseTalk，或 12G+ 显存的 LiveAct/FlashHead），填好 `gpu_bridge_template.py` 中的推理回调即可直接接入 Companion Space 的微信视频框。
3. **历史遗留待确认**：
   - 仓库中 `mira / kite / cael / lyra` 四张旧立绘的再分发许可仍待你发布前确认（与原 `HUMAN-TASKS.md` 一致）；公开打包便携版时 `scripts/build-portable.ps1` 会继续只打包许可完全清晰的 `echo` 与 `nova`。
