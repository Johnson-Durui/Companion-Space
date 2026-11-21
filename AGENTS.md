# AGENTS.md — Companion Space 仓库约定（重塑期）

> 面向在本仓库工作的编码代理。**先读 `docs/rebuild/PLAN.md`，再读 `docs/rebuild/PROGRESS.md`，然后只做当前里程碑（`docs/rebuild/MILESTONES.md`）。** **体验重塑阶段（U0–U7）**：先读 `docs/rebuild/UX-PLAN.md` 与 `docs/rebuild/TASK-UX-UPGRADE.md`，只做所有者点名的那个 U 里程碑；`MILESTONES.md` 只作为通用规则与历史的参考。
> 文件之间有冲突时：`MILESTONES.md`（做什么、何时做）> `docs/rebuild/spec/*`（怎么做）> `PLAN.md` > 本文件之外的任何旧文档。
> 体验重塑阶段的冲突顺序：`TASK-UX-UPGRADE.md` > `spec/experience-design.md` > `spec/design-system.md` > 其余 `spec/*` 中关于界面布局的段落。本文件的防空壳规则、安全与隐私红线、Git 规则，以及其余 `spec/*` 中关于协议、驱动、许可、安全的条款始终有效，任何 U 文件都不能放宽它们。

## 这是什么

Companion Space：本地运行、单用户、开源（Apache-2.0）的"专属 AI 家教"。学生导入自己的教材、课件和真题 → 系统分析成课程地图与考情 → 访谈与诊断 → 个性化计划 → 由学生喜欢的角色用语音和白板进行一对一教学 → 复习与错题闭环。

目标结构：`apps/web`（Vite + React 单页应用）· `services/api`（FastAPI + SQLite，单进程，同时托管前端与素材）· `packages/{avatar-engine,board,api-client}` · `packages/character-tools`（角色支线的后处理工具，开发用）· `libs/prompts/v3` · `assets/avatars` · `content/` · `evals/` · `docs/rebuild/`。目录的权威说明见 `docs/rebuild/spec/architecture-and-data.md` §2。

## 环境与命令（Windows / PowerShell；仓库路径含中文）

```powershell
# 唯一的门：逐条执行，任何一步失败即非零退出
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 [-Frontend] [-Contract]

# 门里的命令（也可单独运行）
.venv\Scripts\python.exe -m ruff check services/api
$env:PYTHONPATH = "services/api"; .venv\Scripts\python.exe -m pytest services/api/tests -q
npm run generate:api:check                      # 改了接口契约：先 npm run generate:api 再提交生成物
.venv\Scripts\python.exe scripts/check_no_fakes.py
npm run typecheck --workspace web               # 前端命令自 M1 起存在；用仓库固定的 npm：npx --yes npm@11.21.2 ci
npm run lint --workspace web
npm run test --workspace web
npm run build --workspace web

# 手动启动后端（只能单 worker；必须先把数据目录指到临时目录）
$env:OBJECT_STORAGE_PATH = "<临时目录>"          # M1 之后改用 COMPANION_DATA_DIR
$env:PYTHONPATH = "services/api"; .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

- PowerShell 5.1 里用 `;` 串联命令只会报告最后一条的退出码——**判断是否通过一律以 `scripts/gate.ps1` 为准**。
- 一律用 `python -m <模块>` 启动工具，不依赖 `.venv\Scripts\*.exe` 垫片（中文路径下不可靠）。
- 本分支不推送，GitHub CI 不会运行；CI 文件的状态一律写"已编写，未在 CI 上运行过"。
- 后端测试必须使用 `services/api/tests/conftest.py` 的 `isolated_settings / client` 夹具（临时目录）。**不得对仓库里的 `storage/` 运行测试、评测或启动服务**；导入 `app.main` 会启动后台线程，脚本里不要随手导入。
- 评测与模拟学生一律使用 `evals/out/data/<运行id>/…` 下的独立数据目录。

## 工作纪律

1. **按里程碑做，到停止点就停**，写好 `PROGRESS.md` 并等待所有者验收。里程碑内自主推进。
2. **一次提交一个关注点**；重构与功能分开；小步提交到本地分支 `rebuild/tutor`。
3. **先核对再动手**：规格里的文件路径、行号、库版本、模型名都是某一天的快照。动手前读实际代码、grep 调用方；引入或升级依赖前查官方文档；把结论写进 `DECISIONS.md`。例外：`MILESTONES.md` 里明确标注"这是许可/风险决定"的事项不因代码现状而改变。
4. **错误不静默**：不得空 `except`、不得吞掉失败、不得静默降级。任何降级都要在界面上让用户看见原因和修复入口。
5. **测试要能失败**：先让新测试红，再让它绿。断言行为与不变量；**不得断言常量、文件哈希、接口清单快照、文案或截图像素**。
6. **删除要删干净**：删一组代码时，把它的导入、路由注册、依赖装配和测试在同一提交里一起处理；删完门必须全绿——若因后面才删的东西而变红，调整分组顺序，不要去修将被删除的测试。历史迁移函数只增不改。
7. **不扩大范围**：`PLAN.md` §6 的"不做"清单与 `MILESTONES.md` 末尾的待议清单，未经所有者批准不得开工。顺手发现的问题记到 `PROGRESS.md`。U 阶段另外适用 `spec/experience-design.md` §10 与 `TASK-UX-UPGRADE.md` 附录 B。
8. **依赖**：许可必须是 MIT/BSD/Apache/MPL/ISC（LGPL 仅可作为未修改的包依赖）；用途、许可、替代方案写入 `DECISIONS.md`；锁定版本。禁止 GPL/AGPL 代码与依赖、Live2D/Cubism、PostgreSQL/Redis/Celery、Electron。字体按"素材与许可"处理，允许 SIL OFL 1.1。
9. **文档**：只维护 `docs/rebuild/PROGRESS.md`、`DECISIONS.md`、`HUMAN-TASKS.md` 与随代码更新的产品文档。**不得创建"发布证据""验收记录"之类的过程文书**；评审用截图输出到 `docs/rebuild/review/`（已忽略，不提交）。

## 防空壳规则（违反任何一条都视为里程碑未完成）

- **产品代码里没有假东西**：不得有 Mock/Fake 供应商、"演示模式"分支、按供应商名或环境变量/请求头/配置切换假实现的入口。测试替身只能放在 `services/api/tests/fakes/` 与前端的 `__tests__/`（或 `apps/web/tests/`），只能被测试导入；测试注入的唯一接缝是构造参数 `create_app(gateway_factory=…)`。
- **唯一允许的非实时路径是"示例课回放"**（M8）：`apps/web/src/features/replay/` 按序播放 `content/sample-course/**/replay.json`，不调用教学引擎；界面明确标注"预生成内容"。
- **没有写死的教学内容**：题目、讲解、提示、反馈、复习卡、小结等面向学生的教学文字，只能来自模型输出、用户资料或 `content/` 内容包。产品代码不得包含针对任何具体学科或主题的分支与文案。
- **课堂上模型不出题、不编例题、不解题**：检查题、例题与解法只能来自教案里已复核的内容。没有复核过答案的题不得用于判分、诊断或更新掌握度。
- **"已掌握"只能来自作答证据的计算**，不能来自模型的口头判断；学生不回应不产生任何证据。
- **评测不可自证**：遵守 `MILESTONES.md` 的"评测防自证"六条；没有 `.env.eval` 就写"未验证"。
- **汇报先写坏消息**：未完成、未验证、已知问题放在最前面；测试数量与截图不是证据。状态只用四种：`进行中` / `代码完成（自动化通过）` / `真实模型实测通过` / `所有者验收通过`。

`scripts/check_no_fakes.py`（M1 起纳入门）检查机器可查的部分：

1. **范围**：`services/api/app/`、`apps/web/src/`、`packages/*/src/`、`libs/prompts/v3/`；排除 `*.test.*` 与 `__tests__/`。
2. **禁用标识符**（按单词边界，大小写不敏感）：`mock`、`fake`、`demo_mode`、`canned`；白名单文件 `scripts/no_fakes_allowlist.txt`（每行：路径 + 理由）。
3. **中文字面量**：`services/api/app/{teaching,learning,analysis,voice}/**.py` 与 `apps/web/src/features/{classroom,learner,plan,review}/**` 中，含 4 个及以上汉字的字符串字面量一律违规。固定文案只能放：后端 `services/api/app/i18n/zh-CN.json`、前端 `apps/web/src/locales/zh-CN.json`、数学读法表 `content/speech/zh-CN.json`（这些文件单条 ≤60 字，且只能是界面提示或带占位符的说明模板，不能是教学内容）。
4. **主题词**：`evals/gold/*/forbidden_terms.txt`（各示例/留出课程特有的主题词）出现在第 1 条的范围或上述文案文件中即违规。
5. **提示词模板里的变量**必须都登记在 `libs/prompts/v3/variables.json`。

## 安全与隐私红线

- 明文 API Key 不落盘、不进日志、不进任何接口响应或导出物；真实 Key 不进测试、夹具与 CI。`.env.eval` 不得提交、不得打印内容。
- 课程之间数据隔离：按课程归属的表都带 `space_id`，查询必须按它过滤。
- 学生资料、学生输入、导入的角色文本都是不可信数据：以数据块注入提示词，不能改变系统规则。
- 原始语音不落盘；日志不记录提示词全文、资料正文、学生原话。
- 服务只监听 `127.0.0.1`；保留 Origin 与 CSRF 校验。
- 模型生成的可执行内容只在沙箱 iframe 中运行；永不对模型文本使用 `eval/exec`。
- 面向学生的输出不得包含成人、暴力、危险内容；角色人设不能覆盖系统层规则。

## 素材与许可

- 代码 Apache-2.0。第三方代码只可复用 MIT/BSD/Apache 许可的，并保留版权声明、登记到 `assets/THIRD_PARTY_NOTICES.md`。
- 3D 模型、动作、音色、字体各有独立许可：只分发许可明确允许再分发的文件；`assets/avatars/LICENSES.md` 逐个登记；许可单测的规则见 `spec/classroom-voice-avatar.md` F.5。
- 不得提交：Mixamo 动画、pixiv 官方 VRMA、任何 Live2D 素材、他人的音色模型、受版权保护的教材或试卷（示例、留出与测试内容必须原创）。
- **不得用代码从零拼出 3D 角色的形体**（旧版 6 个模型的教训）。官方角色只能按 `docs/rebuild/spec/character-pipeline.md` 制作：在 VRoid Studio 里出底模，再用代码对导出的 VRM 做后处理——这条支线是被允许的，不属于"生成模型"。产品本身不得提供基于 VRoid 预设数据的模型编辑/导出功能。

## 桌面操作（Computer Use）

- 只在角色制作支线里使用，且只操作 VRoid Studio 及其文件对话框；规则见 `docs/rebuild/spec/character-pipeline.md` §2、§5。
- 不登录、不购买、不上传、不代所有者接受条款、不改系统设置；遇到登录墙、付费提示或系统弹窗一律停下汇报。
- 桌面操作在前台运行：支线会话与主线会话不同时进行。

## Git 规则

- 本工作区是**链接工作树**：`.git` 是一个文件，版本库元数据在 `E:\Codex\Projects\虚拟形象\Companion-Space\.git`。在本目录执行 `git add / commit / tag / branch` 会写入那里，这是预期行为且被允许。除此之外，不得读取、修改或在其中运行命令：`E:\Codex\Projects\虚拟形象\Companion-Space`（含私有数据的旧检出）及其他工作树。
- 只在分支 `rebuild/tutor` 上工作。**不推送、不改写历史、不删除分支或标签。**
- **禁止**：`git init`、`git clean`、`git stash`、`git reset --hard`、`git checkout -- <路径>`、`git restore <路径>`、`git worktree add/remove/prune`、`git gc`、`git branch -D`、切换到或修改其他分支。需要放弃改动时，用新的提交把它改回去。
- 允许的取消暂存：`git rm --cached -r -- <路径>`、`git reset -q -- <路径>`（不带 `--hard`）。
- 不得删除或移动任何 `storage/` 目录。删除被忽略的构建产物用 `Remove-Item`。

## 已知陷阱

- 后端只支持单个 Uvicorn worker（进程内保存密钥、任务与课堂运行时）。
- 现有许多异步路由直接调用同步 sqlite 仓储；新代码在异步路径上必须 `await asyncio.to_thread(...)` 或放入后台任务，音频帧处理路径上不得读写数据库。
- 数据目录现状是 `./storage`，**相对当前工作目录**（M1 改为相对应用根）。在那之前，任何手动启动都必须显式设置临时数据目录。
- 迁移器：M1 之前，`_initialize` 每次升级都会重跑基础建表脚本——必须按 `spec/architecture-and-data.md` §4.1 先改造再写任何删表/删列迁移；`schema_base.py` 与 `schema_compat.py` 自 v5 起冻结；历史迁移函数只增不改。
- `libs/schemas/default_*_character_recipe.json` 在模块导入时被读取，不要随手清掉。
- 前端固定 `typescript ~5.9`（生成客户端的工具不兼容 TypeScript 7）；`three` 固定在 `@pixiv/three-vrm` 官方测试所用的小版本；`@pixiv/*` 各包版本号保持一致。
- VRM：只写归一化骨骼；0.x 模型先 `rotateVRM0`；`mixer.update` 在 `vrm.update` 之前；情绪表情可能屏蔽口型。
- 主流模型默认开启"思考"：`live` 角色必须按预设关闭，流里的思考内容永不外显、永不朗读。
- 模型名、价格、免费额度变化很快：预设是数据文件，不要把模型名写进代码或测试断言。
- `start.ps1` 必须只含 ASCII 字符（Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当成本地编码）；`.bat` 文件用 CRLF。
