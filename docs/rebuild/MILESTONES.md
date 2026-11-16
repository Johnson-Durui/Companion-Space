# 里程碑：任务、验收门与停止点

> 顺序执行。每个里程碑结束于一个**停止点**：更新 `PROGRESS.md`、提交、向所有者汇报（先说没做完/没验证/已知问题），然后**等待所有者验收**，不得自行进入下一个里程碑。
> 里程碑内部自主推进；标注"内部检查点"的地方只需在 `PROGRESS.md` 记录结果，不必等所有者。
> **预期状态**：M0–M3 期间产品不能用于学习（旧版保存在标签 `pre-rebuild-20261116`）；M4 起每个里程碑结束时都是可用的产品。
> 文件之间有冲突时：本文件（做什么、何时做）> `spec/*`（怎么做）> `PLAN.md`；表与列名以 `spec/architecture-and-data.md` §4 为准，Move/事件/标签以 `spec/teaching-engine.md` 为准。

## 通用规则

### 开工与收工

- **开工**：读 `AGENTS.md`、`docs/rebuild/PROGRESS.md`、本文件对应小节及其引用的规格。规格里的文件名、行号、库版本、模型名都是某一天的快照：动手前读实际代码、grep 调用方、查官方文档；发现规格与代码矛盾，以代码为事实、以规格的意图为目标，记入 `DECISIONS.md`。
- **提交**：小步提交，一次一个关注点。只提交到本地分支 `rebuild/tutor`，**不推送**。
- **需要人决定或提供的东西**：记入 `HUMAN-TASKS.md` 的"待处理"，继续做不受阻的部分。

### Git（重要：本工作区是链接工作树）

- 本目录的 `.git` 是一个文件，版本库元数据在 `E:\Codex\Projects\虚拟形象\Companion-Space\.git`。在本目录执行 `git add / commit / tag / branch` 会写入那里——**这是预期行为且被允许**。每次会话开头先运行 `git rev-parse --git-common-dir` 与 `git status`；若报权限或锁错误，停下汇报（所有者需要给该 `.git` 目录写权限），**不要** `git init`、不要把文件复制到别处另起仓库。
- 除了上述由 git 自己写入的元数据，不得读取、修改或在其中运行命令：`E:\Codex\Projects\虚拟形象\Companion-Space`（含私有数据的旧检出）及其他工作树。
- **禁止**：`git clean`、`git stash`、`git reset --hard`、`git checkout -- <路径>`、`git restore <路径>`（丢弃改动）、`git worktree add/remove/prune`、`git gc`、`git branch -D`、切换到或修改其他分支、改写历史、推送。
- **允许的取消暂存**：`git rm --cached -r -- <路径>` 或 `git reset -q -- <路径>`（不带 `--hard`）。误暂存了不该提交的文件时，先把规则补进 `.gitignore`，再用它们取消暂存。
- 删除被 `.gitignore` 忽略的构建产物用 `Remove-Item`，这不属于 `git clean`。

### 本地门（唯一的门）

本分支不推送，**GitHub CI 在重塑期间不会运行**；`.github/workflows/` 只是把同一套命令搬上 CI，状态一律写"已编写，未在 CI 上运行过"。

M0 新建 `scripts/gate.ps1`：按顺序执行下列命令，任何一步失败即以非零码退出（每步后检查 `$LASTEXITCODE`）。每次提交前运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1`（可带 `-Frontend`、`-Contract` 开关）。

```
后端（始终）    .venv\Scripts\python.exe -m ruff check services/api
               $env:PYTHONPATH="services/api"; .venv\Scripts\python.exe -m pytest services/api/tests -q
契约（M0 起，改了路由时）  npm run generate:api:check        （M0 新增的 npm 脚本：node scripts/generate-api-client.mjs --check）
防空壳（M1 起）  .venv\Scripts\python.exe scripts/check_no_fakes.py
前端（M1 起）   npm run typecheck --workspace web；npm run lint --workspace web；npm run test --workspace web；npm run build --workspace web
```

手动启动后端做冒烟时，**必须先把数据目录指到临时目录**（M1 之前：`$env:OBJECT_STORAGE_PATH = <临时目录>`），不得对仓库里的 `storage/` 启动服务。

### 真实模型评测

- 密钥从仓库根的 `.env.eval` 读取（已被 `.env.*` 规则忽略；不得提交、不得打印）：
  `EVAL_BASE_URL / EVAL_API_KEY / EVAL_MODEL_LIVE / EVAL_MODEL_ANALYSIS / EVAL_MODEL_VISION / EVAL_EXTRA_BODY_LIVE / EVAL_EXTRA_BODY_ANALYSIS`，以及可选的第二连接 `EVAL2_BASE_URL / EVAL2_API_KEY` 与 `EVAL_MODEL_EMBEDDING / EVAL_MODEL_STT / EVAL_MODEL_JUDGE`（模型名加后缀 `@2` 表示走第二连接）。
- 任何一项缺失 → 依赖它的评测项单独写"未验证（缺 <变量名>）"，不影响其他项。整个文件不存在 → 评测全部"未验证"，里程碑状态最高只能是"代码完成（自动化通过）"。**不得用测试替身的结果冒充真实模型评测。**
- 评测与模拟学生一律使用独立数据目录 `evals/out/data/<运行id>/<人设>/`；解析出的数据目录等于默认数据目录时直接报错退出。

### 评测防自证（写评测的和被评测的是同一个代理，所以必须有这些约束）

1. **金标先于实现**：`evals/gold/**` 与示例课程内容先单独提交，之后才写对应的提示词与流水线；此后改金标须在 `PROGRESS.md` 逐条写明理由。
2. **留出集**：每类评测另备一门"提示词冻结提交"之后才编写的留出课程（`content/eval-holdout/<名称>/`，学科不同于两门示例课程），只跑一次；同时报告示例集与留出集的成绩。留出集低于阈值超过 10 个百分点即未通过，**不得据它调提示词后重报同一留出集**（要重测就再写一门新的）。
3. **不变量由代码计算**：一律从 `lesson_events / evidence` 等落库数据计算，不由模型判断。
4. **独立评分模型**：质量分与泄漏判定使用 `EVAL_MODEL_JUDGE`，它必须与被评的模型不同（不同厂商或不同代）；相同或缺失时这些分数标"自评，不计入达标"。
5. **阈值纪律**：不达标就迭代提示词/策略/实现并记录每一轮；不得改阈值、删用例或对特定样例做特殊处理。确需调整，写明理由交所有者批准。
6. 所有者用自己资料做的实测是最终的门，任何评测成绩都不能替代它。

### 停止点汇报模板（写入 `PROGRESS.md` 并在对话里复述）

```
## M<n> <名称> — <状态>            日期
未完成 / 未验证 / 已知问题：……（必须放最前；没有就写"无"并说明依据）
本地门：ruff / pytest（通过数/失败数）/ 契约 / 防空壳 / 前端各项
真实模型评测：各指标的实测值 vs 阈值（示例集与留出集分列）；所用模型；token 用量
代码变化：新增/删除行数、接口数量变化、删除了哪些模块
请所有者验证：按本节"所有者验收清单"逐条
需要所有者处理：……（同步进 HUMAN-TASKS.md）
```

状态只用四种：`进行中` / `代码完成（自动化通过）` / `真实模型实测通过` / `所有者验收通过`。

---

## M0 止血与地基

**目标**：保住现有成果；清掉死代码、空壳与过程文书；换掉仓库约定。后端行为不变（除被删除的功能）；旧前端归档后不再可运行，**M0 结束到 M1 结束之间没有可运行的界面是预期状态**。本里程碑不改数据库结构、不新增迁移。

**任务（按此顺序）**

1. **环境确认**：当前目录应为 `E:\Codex\Projects\虚拟形象\Companion-Space-v2`，分支 `rebuild/tutor`，工作区干净。运行 `git rev-parse --git-common-dir`、`git status`、`git tag -l "pre-rebuild*"` 与 `git update-index --refresh` 确认（git 可写、标签存在）。**若实际情况不是这样（不在该分支、工作区不干净、标签不存在），停下汇报，不要自行处理。** 新建 `docs/rebuild/PROGRESS.md`，记录 HEAD、Python 与 Node 版本。
2. **快照提交——已于 2026-11-17 完成，无需再做**：提交 `c72370f`（分支 `refactor/teaching-v2`，标签 `pre-rebuild-20261116`）原样保存了重塑前全部未提交的 v2 改动（287 个文件：新增 112、修改 69、删除 106——删除的是 `apps/mobile/`）；`rebuild/tutor` 自它切出，其上的第一个提交加入了本方案。需要查看重塑前的任何文件时，用 `git show pre-rebuild-20261116:<路径>`。
3. **行尾与忽略规则**（单独提交 `chore: normalize line endings`）：`.gitattributes` 改为 `* text=auto eol=lf`，加 `*.bat text eol=crlf`、`*.cmd text eol=crlf`，以及二进制规则（`*.vrm *.vrma *.glb *.png *.jpg *.jpeg *.gif *.webp *.ico *.woff2 *.ttf *.otf *.onnx *.wasm *.pdf *.pptx *.docx *.mp3 *.wav *.ogg *.zip *.db binary`）；执行 `git add --renormalize .`。`.gitignore` 增加 `evals/out/`、`docs/rebuild/review/`；确认 `.env.eval` 已被忽略（`git check-ignore -v .env.eval`）。
4. **基线**：运行 ruff 与 pytest，如实记录通过与失败数（不要引用旧文档里的数字）。基线失败项只记录，不修。新建 `scripts/gate.ps1` 与 npm 脚本 `generate:api:check`。
5. **替换约定**：旧 `AGENTS.md` 移到 `docs/archive/AGENTS.v0.1.md`；把 `docs/rebuild/AGENTS.new.md` 复制为根目录 `AGENTS.md`。新建 `docs/rebuild/DECISIONS.md`，把 `KICKOFF.md` §2 的"已定决策"与"定位"抄入作为起始内容。
6. **先删钉常量的测试**（否则后面每一步都会让门变红）：见 `spec/architecture-and-data.md` §9.3 第一行。之后的规则：**每个分组提交后后端门必须全绿；若因后面才删的东西而变红，调整分组顺序，不要去修将被删除的测试。**
7. **整理要保留的素材**（在移动旧前端之前做，路径还是 `apps/web/public/assets/...`）：
   - 保留并移入 `assets/avatars/`：`models/{VRM1_Constraint_Twist_Sample,Sendagaya-Shino,Sakurada-Fumiriya}.vrm` → `assets/avatars/models/`；`art/roster/*.png`（6 张）→ `assets/avatars/portraits/`；`room/observatory*.webp` → `assets/avatars/backgrounds/`。新建 `assets/avatars/LICENSES.md`（内容要点见 `spec/classroom-voice-avatar.md` F.5）。
   - 下线并移入 `assets-archive/`（附 README 说明原因）：`models/{Mira,Kite,Cael,Lyra,Nova,Echo}.vrm` 与 `models/manifest.json`；`motions/` 下 4 个 `.vrma` 及其清单与许可文件；`pets/{mori,yuzu}/`；以及 `scripts/` 里生成/修复/校验这些素材的脚本（含 `scripts/blender/`）。
   - `Seed-san.vrm`：移入 `assets-archive/not-for-distribution/`（原因见 F.5；这是许可风险决定，不适用"以实际代码为准"）。
   - 同一提交更新 `assets/THIRD_PARTY_NOTICES.md` 里的全部路径，删去 Seed-san 与已下线素材的小节及哈希行。
8. **归档旧前端与旧脚本**：
   - 先运行 `git status --short --ignored apps/web`，确认被忽略的只有 `.next*` 构建目录与 `tsconfig.tsbuildinfo`（合计约 3 GB），用 `Remove-Item -Recurse -Force` 删除它们；然后 `git mv apps/web legacy/web-next`、`git mv tests/e2e legacy/e2e`。若 `git mv` 报权限错误，停下汇报，不要改用复制。
   - 同一提交：根 `package.json` 的 workspaces 改为 `["packages/*"]`，删除全部 `*:web`、`test:bootstrap`、`test:e2e*`、`test:windows-startup`、`test:pet-assets`、`test:original-vrm*`、`test:vrm-*`、`test:runtime-config`、`repair:*` 脚本，保留 `generate:api` 与新增的 `generate:api:check`；运行 `npx --yes npm@11.21.2 install --package-lock-only` 重建并提交 `package-lock.json`。
   - 用 `git mv` 移入 `legacy/`：`playwright.config.ts`、`playwright.soak.config.ts`、`START-WINDOWS.ps1`、`START-LOCAL-WINDOWS.ps1`、`SET-DOCKER-MEMORY-WINDOWS.ps1`、`WINDOWS-README.md`，以及 `scripts/` 中只服务于旧前端/旧发布流程的脚本（`run-realtime-check.mjs`、`start-local-windows.test.mjs`、`check-runtime-config.mjs`、`realtime-*.test.mjs`、`avatar-teaching-cue.test.mjs`、`vrm-*.test.mjs`、`windows-smoke.ps1`、`docker-smoke.sh`、`package_delivery*.py` 等，以 grep 为准）。
   - `docker-compose*.yml`、`infra/`、`.dockerignore` 原地保留，在 `PROGRESS.md` 记"M0–M7 期间 Docker 路径不可用"。
9. **删除死代码与空壳**（`spec/architecture-and-data.md` §9.3 中标注 **M0** 的各行，逐组提交；§9.3 中标注 M1 及以后的条目**本里程碑不得动**）。每组先 grep 调用方，把导入、路由注册、依赖装配与测试在同一提交里一起改。删除了路由的分组，在同一提交里运行 `npm run generate:api` 并提交更新后的 `packages/api-client/schema.d.ts`。
10. **文档归档**（移入 `docs/archive/`）：`docs/release/`、`docs/plan/`（三份旧计划）、`docs/v0.1-acceptance.md`、`docs/evaluation-plan.md`、`docs/lan-pairing.md`、`docs/licensed-avatar-runtime-bridge.md`、`docs/design/`、`docs/research/`、`docs/vision-and-roadmap.md`、`docs/architecture.md`、`docs/architecture-and-windows-handoff.zh-CN.md`、`docs/deployment.md`、`docs/persona-guide.md`、`docs/ingestion-guide.md`、`docs/voice-service.md`、`notes/`、`sample_data/`。保留并在 M8 重写：`docs/privacy-and-data.md`、`docs/security-model.md`、`docs/safety-policy.md`、`docs/asset-licensing.md`、`CONTRIBUTING.md`、`README.md`、`README.en.md`（后两者顶部加一行"正在重塑为 v1.0，见 docs/rebuild/PLAN.md"）。
11. **CI 文件**：`backend` 作业保留；`windows-smoke` 精简为只做 Windows 上的 ruff + pytest 并改名 `backend-windows`；删除 `frontend`、`e2e`、`docker-smoke`、`tts-sidecar` 作业；`dependency-audit` 去掉 npm 部分直到 M1。状态写"已编写，未在 CI 上运行过"。
12. 新建 `scripts/check_no_fakes.py`（规则见 `AGENTS.md`；M1 起纳入门，M0 结束时允许它对尚未删除的 Mock 报错）。

**自动化验收**：`scripts/gate.ps1`（后端 + 契约）全绿；用临时数据目录启动 `python -m uvicorn app.main:app` 后 `/healthz` 正常；`git status` 干净。

**所有者验收清单**
- [ ] `git log --oneline -20` 能看到快照提交与标签 `pre-rebuild-20261116`；`git status` 干净。
- [ ] `PROGRESS.md` 里有删除前后对比：后端代码行数、测试行数、HTTP 接口数、文档文件数。
- [ ] `assets-archive/` 里能找到被下线的模型与素材（没有丢）；`assets/avatars/` 里是保留的 3 个模型、6 张立绘和背景。

**停止点**。**不做**：任何新功能；修旧前端；任何数据库结构变化。

---

## M1 新外壳与模型网关

**目标**：一条命令启动、零密码、连上真实模型。结束时是一个"空但真"的新应用：能选老师、选预设、填 Key、流式对话、识别图片、试听语音。

规格：`spec/llm-gateway.md`、`spec/architecture-and-data.md` §4.1、§7、§8、§9.3（M1 各行）、`spec/classroom-voice-avatar.md` A、F.5。

### M1a 后端

1. **迁移器改造与 v6**（`architecture-and-data.md` §4.1、§4.2）：先改 `_initialize` 与迁移前备份，再写 v6（删死表与死列、建四张新表），版本号提到 6；逐级升级测试。
2. **抽出要保留的鉴权**：把 `api/routes/realtime.py` 的票据/Origin 鉴权段与 `services/realtime.py` 的 generation 守卫抽成独立模块并补单测。
3. **删除旧对话栈**（§9.3 的 M1 行）：v1 的 sessions / turns / learning / realtime 回合路由、`services/companion*.py`、`streaming_json.py`、旧提示词拼装与旧 `libs/prompts/*.md` 及其测试——**删除，不要移植到新接口**；`sessions / turns / memory_items` 表与只读仓储保留。
4. **供应商层改造**：新接口（多模态消息、`max_tokens / temperature / extra_body / timeout`、思考内容与 `finish_reason`）；删除 `pinned_http.py`（先处理它在各适配器、注册表和测试里的导入）与强制 `/v1`，换成 `url_policy`；重试与取消；Anthropic、Gemini 适配器补齐图片与参数。
5. **移除 Mock**：`mock_provider.py` 改造成新接口的测试替身，移入 `services/api/tests/fakes/`；删除产品代码里所有按供应商名判断 Mock 的分支、Mock 引导分配与相关数据修补；新建课程不再自动绑定任何模型。测试只能通过构造函数/依赖覆盖注入替身（`create_app(gateway_factory=…)`）。
6. **预设与角色**：`presets.json`、`GET /providers/presets`、全局角色分配（`app_settings`）、`vision` 与 `checker` 角色、"获取模型列表"、逐角色的真实连接测试。
7. **网关**：`app/llm/{gateway,tagged,json_guard,cache,usage}.py` 及其测试。
8. **统一后台任务** `JobRunner` + SSE 进度助手（旧入库路径继续用 `ingestion_jobs`，不双写）。
9. **零密码密钥与本地会话**（§7）；数据目录改为相对应用根并支持 `COMPANION_DATA_DIR`；重写 `.env.example`（本地非 Docker）。
10. **角色数据**：角色结构（`spec/classroom-voice-avatar.md` F.5，`schema_version = 2`）、`GET /api/v2/characters`、默认老师设置。默认老师的人设与默认音色以内容包提供：`content/characters/<id>.json`，首次启动导入。
11. **默认语音试听**：`voice/tts/edge.py`（零配置默认）+ `POST /api/v2/tts/preview`，失败即回退并给出可见提示。
12. `scripts/check_no_fakes.py` 纳入门并全绿；`evals/smoke_gateway.py`。

**内部检查点 M1a**：本地门（后端 + 契约 + 防空壳）全绿；有密钥则跑 `evals/smoke_gateway.py` 并记录。

### M1b 前端与启动

13. **新前端骨架** `apps/web`（Vite / React / TypeScript / React Router / TanStack Query / Zustand / Tailwind）：应用外壳、设计令牌（迁移旧色板）、错误边界、类型化接口客户端、界面文案文件。页面：欢迎（老师卡片 + 试听；6 位立绘老师用 `assets/avatars/portraits/`，3 位 3D 老师在 M6 之前显示"3D 预览将在后续版本提供"的占位，不得用别的角色的立绘顶替；**"看示例课"入口在 M8 之前不显示**）、设置（模型连接：预设/Key/测试/角色分配；语音；安全；数据；用量）、设置里的"试聊"诊断页（流式对话 + 上传一张图识别）。
14. **单进程托管**：FastAPI 托管 `apps/web/dist`（SPA 回退）与 `/static/avatars` → `assets/avatars`；Vite 开发代理。
15. **启动脚本**：`start.bat`（双击入口）、`start.ps1`、`start.sh`（要求见架构规格 §8）；临时版 README 快速开始。
16. **最小 Playwright 工程** `tests/e2e/`（截图脚本，之后各里程碑的薄冒烟也放这里）与测试服务器 `services/api/tests/e2e_server.py`（在测试目录里用 `create_app(gateway_factory=…)` 注入替身）；截图输出到 `docs/rebuild/review/`（已忽略，不提交）。
17. 前端门纳入 `scripts/gate.ps1 -Frontend`；更新 CI 文件（前端作业、Windows 冒烟）。

**自动化验收**：`spec/llm-gateway.md` §8 全部；迁移（逐级升级、备份）；密钥（凭据库可用/不可用、主密码开/关、旧保险箱迁移、写入中断不丢数据——凭据库用替身）；会话引导只对回环地址生效；静态托管与回退；防空壳扫描；`start.ps1` 只含 ASCII 的检查。

**真实模型冒烟**（`evals/smoke_gateway.py`）：流式对话首 token 延迟；带 LaTeX 的标签块往返无损；一张含公式的页面图像转写；嵌入一条；默认语音合成一句。逐项记录成功/失败/未验证与耗时。

**所有者验收清单**
- [ ] 双击 `start.bat`，浏览器自动打开，**全程没有密码页**。
- [ ] 在设置里选一个预设、粘贴 Key、点测试：每个角色的测试结果逐项显示。
- [ ] "试聊"里模型流式回答；上传一张带公式的教材照片能转写出公式。
- [ ] 欢迎页能选老师并听到试听语音。
- [ ] 关掉程序再启动：不需要重新输入任何东西，Key 仍在。
- [ ] 数据目录里的密钥文件是密文；仓库里搜不到明文 Key。

**停止点**。**不做**：课程/资料/课堂相关的任何界面。

---

## M2 资料理解

**目标**：文件进来，课程地图、考情和已复核的题库出去。规格：`spec/course-analysis.md`。

### M2a 解析、索引与评测素材

1. **先提交评测素材**（防自证规则 1）：
   - `content/sample-course/probability-basics/`：原创 Markdown 教材"概率入门"（古典概型、条件概率、全概率公式等，约 8–10 页）+ 三套带答案与分值的原创试卷（标为连续三个年份）；
   - `content/sample-course/history-1911/`：原创文科短章（约 3 页）+ 一套含选择题与论述题的试卷（用来防止实现偏向理科）；
   - 金标 `evals/gold/<课程>/`：`expected_kps.json`（应被抽出的知识点，含别名与 `acceptable_extra`）、`expected_edges.json`（关键前置关系）、`expected_items.json`（题数与每题答案）、`item_kp.json`（每题应映射的知识点）、`forbidden_terms.txt`（该课特有、≥3 字的主题词 ≥15 个，不收通用词）；
   - `evals/gold/verifier/items.json`：30 道已知答案的题，其中 10 道的参考答案被故意改错（并标注）。
   - **金标只放在 `evals/`，产品代码不得读取。**
2. v7 迁移与对应仓储；`spaces.py` 拆分为课程 CRUD / 入库 / 检索；v2 课程与资料接口取代 v1（删除 v1 的 spaces / materials 路由与 `ingestion_jobs`）。
3. 解析器（S1）：文字 PDF（**修掉"超长块被截断"的缺陷——任何内容都不得被静默丢弃**）、页面渲染、PPTX、DOCX、图片、MD/TXT（自动识别 GBK/GB18030）；视觉转写路径；"扫描页需要视觉模型"的显式提示。
4. 结构（S2）、切块与索引（S3）：trigram 全文检索 + 短查询 `LIKE` 回退；向量以 float32 BLOB 存储、numpy 余弦检索（嵌入可选）；`retrieve_for_kp`。
5. 界面：新建课程与导入向导、资料列表、分析进度页（先接解析与索引阶段）。

**内部检查点 M2a**：解析与检索的自动化测试；对两门示例课程跑解析，记录每页文本是否完整。

### M2b 知识点、题目与考情

6. 知识点抽取（S4）、归并建图（S5）、题目抽取与映射（S6）、**`ItemVerifier` 与题库（S6b）**、考情统计（S7）、诊断题池（S7b）、课程简报（S8）。
7. 任务编排：预估与确认、进度 SSE、缓存、断点续跑、失败可重试、增量加入新资料。
8. 界面：课程地图页（知识点抽屉、出处原页查看、真题浏览、修订）、分析进度页补全。
9. 提示词冻结提交后，编写留出课程 `content/eval-holdout/<名称>/`（第三个学科，例如一章高中物理）及其金标，只跑一次。

**自动化验收**：`spec/course-analysis.md` §6 全部。

**真实模型评测**（`evals/analysis_eval.py`；示例集与留出集分列）

| 指标 | 计算方式 | 阈值 |
| --- | --- | --- |
| 知识点召回 | 金标中被找到的比例（规范化名称 + 别名匹配） | ≥ 85% |
| 多余知识点比例 | 未匹配金标（含别名与 `acceptable_extra`）的抽取数 / 抽取总数 | ≤ 30% |
| 前置关系图 | 无环；`expected_edges.json` 命中比例 | 无环；≥ 70% |
| 切题与答案回贴 | 题数与 `expected_items.json` 完全一致；答案贴对比例 | 一致；≥ 95% |
| 题目 → 知识点映射 | 与 `item_kp.json` 至少一个知识点相同的比例 | ≥ 80% |
| 考情统计 | 在金标映射下与手算一致（纯代码） | 完全一致 |
| 复核器 | 改错的 10 道参考答案中被判为非 `verified` 的比例；20 道正确答案被误判的比例 | ≥ 90%；≤ 15% |
| 重跑 | 第二次全部命中缓存 | token 为 0 |

**所有者验收清单**（用你自己的一章教材 + 两到三套真题，建议其中一份是扫描件或照片）
- [ ] 导入时每个文件的角色识别基本正确，可以改。
- [ ] 分析过程能看到进度和已用 token；中途关掉程序再打开能接着跑。
- [ ] 课程地图里的知识点你认可（不离谱、不太碎、不太粗）；点开能看到出处页原图。
- [ ] 真题被切成一道道题，答案对得上；每道题挂在合理的知识点上；有争议的题被标了出来。
- [ ] "常考"的知识点和你的直觉相符。
- [ ] 扫描页要么被正确转写，要么被明确提示"需要视觉模型"。

**停止点**。

---

## M3 认识学生与个性化计划

**目标**：访谈 + 起点诊断 + 带理由的计划。规格：`spec/learner-model-and-planning.md`。

**任务**
1. v8 迁移与仓储；`app/learning/{mastery,interview,placement,planner,approach_stats}.py`。
2. 学习者画像与课程报名接口；访谈状态机（6 组问题、槽位抽取、芯片回退、可跳过）。
3. 诊断：选题、传播、停止条件。作答控件 `question`（单选/多选/数值）**在本里程碑实现**于新建的 `packages/board`（含单测），M4 在同一个包里补齐其余块。旧的 `packages/lesson-board` 中值得保留的零件（公式渲染 `math.tsx` 等）移入新包后，删除旧包。
4. 计划：权重、选集、拓扑排序、装箱、练习/模考插入、排期、取舍说明、置顶/顺延、"我会了"小测（`POST /plan-items/{id}/skip-quiz`）、重排与版本。
5. 界面：访谈与诊断页（老师立绘 + 语音朗读问题，可关）、"你的起点图"、计划时间线、课程首页（今天的课、进度）。本里程碑结束时计划里的课还不能点开上课——如实显示"课堂功能在下一个里程碑"，不得放置假入口；也不为备课排队任何任务（只在 Planner 完成处留一个回调 `on_plan_ready(plan_id)`，M4 接上）。

**自动化验收**：`spec/learner-model-and-planning.md` §10 中标为本里程碑的全部测试。

**真实模型评测**：访谈槽位抽取——30 条人工编写的口语化回答（先提交到 `evals/gold/interview/`），准确率 ≥ 90%。

**所有者验收清单**
- [ ] 访谈像在聊天，3 分钟内结束，随时能跳过。
- [ ] 诊断题不超过 12 道，"不会"按钮好用，结束后的起点图和你的自我感觉大体一致；推测出来的部分有标注。
- [ ] 计划的顺序讲得通：先修在前；又常考又薄弱的排前面；每节课的"为什么先学它"是事实。
- [ ] 把考试日期改近一半：计划会重排，并明确告诉你放弃了哪些内容、占多少分值。

**停止点**。

---

## M4 教学引擎（文字课堂）

**目标**：真正的一对一课——先不带语音和 3D，把"教"做对。这是整个重塑里最大、最重要的里程碑。规格：`spec/teaching-engine.md`、`spec/prompts.md`。

### M4a 引擎（无界面，命令行可跑）

1. v9 迁移与仓储。
2. `LessonPlanner`（备课、`more_items`）+ 教案解析 + 数量下限校验；复用 M2 的 `ItemVerifier` 与题库；接上 `on_plan_ready`（计划生成或重排后自动为接下来两节课排队备课）。
3. `Director`（纯函数、全函数）与 `LessonState`；字段提交/清零表。
4. `Realizer`、提示词文件（`libs/prompts/v3/`）、变量来源表与其检查、五种讲课风格、角色卡渲染。
5. LSP 增量解析器、校验器（`forbidden` 生成与泄漏校验、口语净化、长度、板书引用）、`speech_text` 数学读法转换。
6. 学生输入理解器；判分；证据写入与掌握度更新；迷思记录；讲法有效性统计。
7. 课堂运行时：事件落库、生成编号与取消、计时（沉默、`time_up`、活动时间）、暂停与恢复、断点恢复；`finish()`（小结、卡片、错题、确认题卡、重排、预备下一节）。
8. 命令行工具 `python -m app.teaching.cli --lesson <id> [--student sim:<人设>|human]`（模拟模式强制使用独立数据目录）。
9. 评测工具 `evals/tutor_eval.py` 与评测提示词（`evals/prompts/`）：五种模拟学生 × 两门示例课程各两节课；输出不变量检查表、评分表与完整课堂记录（存 `evals/out/`）。

**内部检查点 M4a**：引擎的自动化测试全绿；评测达标后再做界面。

### M4b 课堂界面

10. WebSocket `/api/v2/lessons/{id}/live`（票据与 Origin 校验；文本模式无音频帧）；断线重连与事件补齐。
11. `packages/board` 补齐首发块类型与 `applyBoardEvent`。
12. 课堂页：舞台（本阶段显示立绘 + 字幕 + 状态点）、白板、输入条与快捷动作（没听懂 / 举个例子 / 给点提示 / 看答案 / ⋯）、环节进度、讲法切换、备课页、暂停页、下课页；时间线执行器（文本模式按字数计时）；客观题的"语音/文字答案预填 + 倒计时提交"。
13. 课程首页的"开始/继续上课"；课后小结页；课堂记录回看。
14. 提示词冻结后，用留出课程（M2 的那门）跑一次模拟学生评测。

**自动化验收**：`spec/teaching-engine.md` §12 全部；前端 `applyBoardEvent` 与时间线执行器的单测；一条薄的 Playwright 冒烟（通过 `e2e_server` 注入替身：进入课堂 → 看到板书出现 → 作答 → 收到反馈 → 下课页）。

**真实模型评测阈值**（全部课堂汇总；不变量由代码从落库数据计算）

| 类别 | 指标 | 阈值 |
| --- | --- | --- |
| 不变量（必须 100%） | 用于判分的题目均为已复核题；课堂中没有模型自拟的例题 | 100% |
| | 同一要点内第 1–3 次重讲的讲法两两不同，且不同于该要点首次讲解的讲法（其中至多 1 次被前置回补取代） | 100% |
| | 完整示范只出现在：学生请求看答案之后，或同一题已给过第 2 级提示且再次未答对之后 | 100% |
| | 看答案/示范解法之后，同环节会再出一道同类题（有变式时） | 100% |
| | "我会了"的验证题答对后该环节不再讲解；答错后继续讲 | 100% |
| | 由 `beat_done` 触发的纯讲解不连续超过 2 拍（学生主动要求的重讲不计） | 100% |
| | 学生不回应时不产生任何证据；提醒一次后课堂暂停 | 100% |
| 泄漏 | 评分模型独立判定"只看这段提示能否直接确定答案"的次数（提示 1/2 级） | 0 |
| | 保底提示使用率（模型生成的提示被校验器拦下的比例） | ≤ 20%（并报告拦截率） |
| 适应性 | "strong"人设的总拍数少于"weak"人设 | 少 ≥ 25% |
| | "guesser"人设没有任何知识点被判为已掌握或"待确认" | 0 例 |
| | 在教案含回补内容的课上，"weak"人设触发回补 | ≥ 1 次/课 |
| 格式 | 非法板书操作占比；标签外文字占比；白板渲染失败块占比 | 各 < 2% |
| 文科 | `history-1911` 每节课至少 1 道 rubric 题被作答并判分 | 100% |
| 质量（评分模型 1–5 分，取均值；评分模型必须不同于被评模型） | 内容正确性 ≥ 4.5；清晰度 ≥ 4.0；针对性 ≥ 4.0；语气 ≥ 4.0；检查题考到理解而非复述 ≥ 4.0 | |
| 风格 | 每种风格声明的可计算特征的符合率 | 报告，≥ 80% |
| 成本 | 一节 25 分钟课的 token 用量与估算费用 | 记录，不设阈值 |

**所有者验收清单**（用你自己的课程，文字模式，上一节完整的课）
- [ ] 老师主动开讲，说清今天学什么、为什么值得学。
- [ ] 每讲一小段就问我一个问题；白板随讲解逐步出现，公式渲染正确。
- [ ] 故意答错：第一次只给方向，第二次给更具体的提示，第三次才完整示范，然后换一道同类题。
- [ ] 同一个地方连续三次点"没听懂"：三次讲法明显不同。
- [ ] 点"给点提示"：给了提示但没泄漏答案；点"看答案"：立刻给解法，随后再考我一道类似的。
- [ ] 中途插一个问题：老师回答后能接回原来的进度。
- [ ] 换一种讲课风格：下一段的讲法确实变了。
- [ ] 故意不回应：老师提醒一次，之后课堂暂停等我，回来能继续。
- [ ] 中途刷新页面：课堂从原处继续。
- [ ] 下课小结说的都是这节课真实发生的事；掌握度变化合理；复习卡已生成。
- [ ] 读一遍 `evals/out/` 里的两份模拟课堂记录：没有讲错的内容。

**停止点**。到这里产品已经是一个可用的"文字版一对一家教"。

---

## M5 开口说话

**目标**：分句流式语音、单一时间线、可打断、能听懂学生说话。规格：`spec/classroom-voice-avatar.md` E。

**任务**
1. 服务端分句与合成队列（并行预取、按序下发）、二进制帧头、取消语义。
2. TTS 引擎与回退链：`edge`（默认）、`openai_compat`、`elevenlabs`、`local_neural`、`gpt_sovits`、`browser`；每角色音色配置。
3. 前端 `audio/`：移植采集与帧器（加低通）、重构播放队列为 `SpeechOutput`（片段、时钟、口型信号输出、按 `gen` 停止）；时间线执行器的音频模式；字幕同步。
4. STT：`openai_compat`（默认）与可选的 `local_sherpa` 扩展（首次使用时下载模型并展示许可）；按住说话；免提 VAD（自托管资源）；预滚与连续上传；回声与过短转写的丢弃规则。
5. 打断：本地即停、上报已听到的位置、服务端取消；外放回声的自动保护。
6. 可预测时预生成下一拍；重连恢复；标签页隐藏时暂停。
7. 设置里的语音页：引擎与音色选择、试听、麦克风测试（电平 + 一句话识别回显）。
8. 开发用延迟浮层（仅本地显示，不落库）与测量脚本 `evals/latency_probe.py`（驱动一节固定课堂，记录四项延迟的中位数与 90 分位）。

**自动化验收**：分句器（中英文标点、长逗号句）；时间线顺序不变量（性质测试：任意到达顺序下执行顺序 = `seq` 顺序，过期 `gen` 的帧与事件被丢弃）；打断后无残留播放；引擎回退链（用替身引擎模拟 403/超时）；STT 空结果与回声丢弃。

**真实测量**（所有者机器 + 推荐预设 + 默认语音，各场景 ≥ 20 次）：对照 `classroom-voice-avatar.md` E.5 的四项目标，未达标的写明瓶颈在哪一段（理解 / 首句生成 / 合成 / 播放）。

**所有者验收清单**（戴耳机）
- [ ] 全程语音上完一节课；老师是一句一句说出来的，不是等很久再一口气说完。
- [ ] 老师说到哪里，白板写到哪里。
- [ ] 我一开口（或按下说话键），老师立刻停；我说完他接着回应。
- [ ] 口头回答选择题时，答案被预填到控件里让我确认；识别不准时老师会问一句而不是直接判错。
- [ ] 让默认语音失效（如断网）：界面明确提示并退到下一种方式，课还能继续。
- [ ] 换一个音色，下一句就生效。

**停止点**。

---

## M6 老师"在场"

**目标**：自然的待机、口型、眼神、手势与指向白板；角色库与 VRM 导入。规格：`spec/classroom-voice-avatar.md` F。

**任务**
1. 引擎重构：模块拆分（加载/取景/姿态/手势/视线/表情/口型）、`TutorAvatar` 组件与命令式接口；移除常量手臂姿态、轨道剥离、时钟口型、`dataset` 遥测。
2. 基础姿态与待机程序动画；眨眼与眼球微动；视线控制器。
3. 手势片段（自编关键帧数据）与队列；讲解节拍；指向白板；作答反应。
4. 口型：先音量驱动，再接入 `wlipsync`；说话时的表情权重上限。
5. 时间线接线：`cue / point / say.emotion / judge` → 形象命令。
6. 性能与降级：像素比上限、隐藏暂停、上下文丢失恢复、低帧率回退；2D 分层立绘回退与离屏渲染脚本。
7. 角色库页面、VRM 导入（校验、许可展示、自动取景、缺失表情报告）、音色与人设编辑、默认讲课风格；欢迎页的 3D 老师换成真实预览；删除 v1 的 characters 路由。
8. 资产：`assets/avatars/LICENSES.md` 定稿、许可单测（规则见 F.5）；可选的贴图压缩脚本。

**自动化验收**：姿态数学（VRM 0.x 与 1.0 的归一化骨骼各一例）；手势队列与混合权重；口型映射（合成音频输入）；许可单测；回退路由。视觉效果不做断言——用截图脚本把以下画面存到 `docs/rebuild/review/M6/` 供目视：待机、讲解、指向白板、答对反应、答错安慰、三位 3D 老师、2D 回退、手机布局。

**所有者验收清单**
- [ ] 老师不再是张开双臂的站桩姿势；待机时有呼吸和小动作，不僵硬也不鬼畜。
- [ ] 说话时嘴在动且大体跟得上声音；会眨眼；讲解时看我，写板书时瞥向白板并抬手指。
- [ ] 答对/答错时表情和动作有区别。
- [ ] 帧率流畅（≥30）；把窗口切到后台再回来不黑屏。
- [ ] 导入一个我自己的 VRM：能显示、能取景、能说话；显示了作者与许可。
- [ ] 强制关闭 WebGL：自动换成立绘模式，课照常上。

**停止点**。

---

## M7 学习闭环

**目标**：复习、错题本、练习与模考、进度、计划随表现调整。

**任务**
1. 复习：到期队列、翻面自评、题卡重做、FSRS 排程、每节课开头 ≤5 分钟热身（进入课堂前的独立小环节，由老师口头引导）。
2. 错题本：筛选、当时的错误答案与错因、隔天净对两次后归档。
3. 练习课与模考：计划里的 `practice / mock` 项——限时作答、交卷后由老师逐题讲评（复用课堂引擎的 `SHOW_SOLUTION / REEXPLAIN / CHECK`）；"待确认"知识点的确认题。
4. 进度页：掌握度地图、已学时长、"已保住的分值"估算、趋势。
5. 重排体验："计划为什么变了"的可读记录；手动调整。
6. 课堂记录回放（按事件重放白板与字幕）；白板导出为 Markdown 笔记。
7. 老师的跨课记忆：开场引用上次小结与未解决的迷思（数据来自 `evidence / misconceptions / recap`，不是自由文本记忆）。
8. 旧对话数据的"导出为 Markdown"。

**自动化验收**：FSRS 往返与到期计算；闪卡自评不写证据；题卡结果对掌握度的影响（含隔天确认转为已掌握）；错题入库与归档；模考计分；重排稳定性；回放得到与原课一致的白板。

**所有者验收清单**
- [ ] 第二天打开：首页告诉我今天的课和到期复习；上课前先复习了昨天的内容。
- [ ] 昨天"今天学会了，待复习确认"的知识点，今天答对确认题后变成"已掌握"。
- [ ] 昨天答错的题出现在错题本里，并在之后被再次考到。
- [ ] 做一次练习/模考，交卷后老师逐题讲评。
- [ ] 进度页能看懂，数字和我的感受相符。

**停止点**。

---

## M8 首次体验与发布

**目标**：一个陌生人在干净的 Windows 电脑上，10 分钟内上到第一节课。

**任务**
1. 首次引导打磨：欢迎三步、空状态、每个失败都有"怎么修"的指引；模型连接页的"零成本方案"向导。
2. **示例课回放**（全项目唯一允许的非实时路径）：用真实模型为 `content/sample-course/` 生成课程地图、教案与一节完整课堂的事件流，存为 `replay.json` 并提交（标注生成所用模型与日期）。`apps/web/src/features/replay/` 只按 `seq` 播放它，不调用 Director/Realizer。"可作答"的定义：录制时用真实 Realizer 为每道检查题的每个选项各生成一次反馈，存入 `replay.json` 的分支，回放时播完所选分支回到主线；自由提问处提示"连接模型后可用"。欢迎页此时才显示"看示例课"。
3. 清理：删除 `legacy/`（删后用 `Test-Path legacy` 确认）、残余 v1 代码、无用脚本；`README.md / README.en.md` 重写（如实描述能力与限制、三条命令快速开始、截图、零成本配置指引、素材许可表）；更新 `docs/`（架构、隐私与数据、安全模型、素材许可）。
4. Windows 便携包脚本 `scripts/build-portable.ps1`：内置 Python 运行时 + 依赖 + 预构建前端的目录式压缩包（不做单文件自解压），附 `start.bat`；说明未签名程序的 SmartScreen 提示。配套 `scripts/smoke-portable.ps1`：在全新临时目录解压、启动并通过 `/healthz`。
5. Docker：把 compose 简化为单服务（可选部署方式），文档说明访问口令的设置。
6. 老用户迁移说明：数据不动、旧对话只读可导出、旧主密码保险箱的迁移步骤、下线功能清单。
7. `CHANGELOG.md`、版本号 `1.0.0-rc.1`、`assets/THIRD_PARTY_NOTICES.md` 全量核对。

**自动化验收**：本地门全绿；示例课回放的 Playwright 冒烟；`scripts/smoke-portable.ps1` 通过。

**所有者验收清单**
- [ ] 找一台没装过任何东西的 Windows 电脑（或新建一个系统用户），只看 README：10 分钟内上到第一节课。
- [ ] 不填任何 Key 也能看完一节示例课。
- [ ] README 里的每一句能力描述都是真的。
- [ ] 录制演示视频、决定何时推送与发布（见 `HUMAN-TASKS.md`）。

**停止点**：v1.0 候选完成。

---

## v1.0 之后的待议清单（未经所有者批准不得开工）

联网检索考纲/考情（需要可信度设计与引用）；几何/可交互小组件白板块；数学公式输入与拍照作答；离线 OCR 与本地 STT/TTS 的一键安装；英文界面；课堂导出为视频；多门课统筹排期；桌面安装包；角色包分享。
