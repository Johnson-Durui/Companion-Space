# 规格 · 目标架构、数据模型、接口与工程约定

> 结论先行：**保留底座，重建产品**。底座（模型供应商层、SQLite 迁移器、密钥加密、音频采集/播放、WebSocket 票据鉴权、VRM 加载与取景）是真实可用的；产品（资料理解、学习者模型、计划、教学引擎、课堂界面、首次体验）几乎不存在，需要新建。
> §9"现有代码处置表"来自 2026-11-16 的逐文件审计与评审核对；文件名与行号是当时的快照，**动手前用 grep 再确认调用方**。
> 本文件是表名、列名、迁移版本与目录布局的唯一权威定义。

## 1. 目标形态

```
浏览器（单页应用，Vite 构建的静态文件）
   │  HTTP  /api/v2/*          REST + SSE（分析进度）
   │  WS    /api/v2/lessons/{id}/live      课堂流（LSP 事件 + 双向音频）
   ▼
单个 Python 进程（FastAPI / Uvicorn，仅监听 127.0.0.1，一个端口，同时托管前端静态文件与素材）
   ├─ analysis/   资料理解流水线（后台任务）
   ├─ learning/   学习者模型 · 访谈 · 诊断 · 计划 · 复习
   ├─ teaching/   备课 · 导演 · 表达生成 · LSP · 校验器 · 课堂运行时
   ├─ voice/      TTS / STT 适配器 · 分句
   ├─ llm/        模型网关（角色路由、预设、标签块解析、缓存、用量）
   ├─ providers/  供应商适配器（沿用并扩展）
   └─ repositories/  SQLite（沿用迁移器，新增表）
数据目录：SQLite 数据库 · 资料原文件与页面图像 · 用户导入的角色资产 · 加密的密钥文件
外部：用户自己选择的模型服务（聊天/分析/视觉/嵌入/语音）
```

硬性工程目标：
- **一条命令（或双击 `start.bat`）启动、零密码、一个端口**。终端用户运行时不需要 Node、Docker、Caddy、证书。
- Docker 保留为可选部署方式（M8 更新），不是主路径；**M0–M7 期间 Docker 路径不可用是预期状态**。
- 只支持单个 Uvicorn worker。
- Windows 11 为第一验收平台；路径可含中文与空格。

## 2. 仓库布局（目标）

```
apps/web/                  新前端：Vite + React + TypeScript（M1 新建）
legacy/                    旧 Next.js 前端、旧 E2E、旧启动脚本——只读参考，不进 workspace/门禁，M8 删除
packages/avatar-engine/    保留并在 M6 重构为分层动画引擎
packages/board/            白板：块注册表 + 纯 reducer（M3 先做作答控件，M4 补齐；取代 packages/lesson-board）
packages/api-client/       OpenAPI 生成的类型化客户端（沿用）
packages/character-tools/  角色制作支线的后处理工具（开发用，不属于产品；见 character-pipeline.md）
services/api/app/
  api/v2/                  新路由
  api/routes/              旧 v1 路由：其 v2 替代品落地的同一里程碑删除（见 §9.3）
  llm/  analysis/  learning/  teaching/  voice/      新模块（见各规格）
  i18n/zh-CN.json          后端面向学生的固定文案与带占位符的说明模板（如"为什么先学它"）
  providers/  repositories/  services/               沿用并按 §9 处置
services/api/tests/        后端测试；测试替身只放 services/api/tests/fakes/
services/tts/              可选的本地神经语音 sidecar（保留，默认关闭）
tests/e2e/                 M1 重建的最小 Playwright 工程（截图脚本与薄冒烟）；其测试服务器在 services/api/tests/e2e_server.py
libs/prompts/v3/           新提示词
assets/avatars/            随仓库分发的角色素材（models/ portraits/ backgrounds/ previews/ recipes/）+ LICENSES.md；由后端以 /static/avatars 提供
assets-archive/            下线但不删除的素材（脚本生成的 VRM、动作、宠物精灵图及其生成脚本）
assets-src/                角色制作支线的工作目录（VRoid 工程文件、候选、中间贴图）；已忽略，不提交
content/characters/        默认老师的人设与默认音色（内容包，JSON）
content/speech/            数学读法表等朗读数据
content/sample-course/     原创示例课程（教材、试卷；M8 加入预生成的回放）
content/eval-holdout/      评测留出课程（在提示词冻结之后编写）
evals/                     真实模型评测（脚本、金标、评测提示词）；输出在 evals/out/（已忽略）
scripts/                   gate.ps1（本地门）、check_no_fakes.py、generate-api-client.mjs 等
docs/rebuild/              本计划、PROGRESS.md、DECISIONS.md、HUMAN-TASKS.md
docs/archive/              旧文档归档（不再维护）
```

## 3. 命名约定：课程 = 现有"学习空间"

- 数据库表 `study_spaces` **不改名**；在 v2 接口与所有新代码中统一称 **course**。
- **数据库列一律叫 `space_id`、`item_ref`；接口与 JSON 字段叫 `course_id`。** 各规格里写的 `courses.*` 指 `study_spaces.*`。
- "课程隔离"红线不变：所有按课程归属的表都带 `space_id`，查询必须按它过滤。

## 4. 数据模型（新增迁移 v6–v9：M1、M2、M3、M4 各一个）

### 4.1 迁移器的改造（M1，随 v6 一起做，先于任何表结构变化）

现状：`repositories/mixins/infrastructure.py` 的 `_initialize` 在版本不是最新时，**每次升级**都会先执行 `BASE_SCHEMA_SQL` 和 `ensure_legacy_schema`，再跑迁移。后果：被迁移删除的表/列会在下一次升级时被基础脚本重新建出来，甚至因为列不存在而启动失败。必须先改：

1. `_initialize`：仅当 `user_version < 5`（全新库或很旧的库）时执行 `BASE_SCHEMA_SQL` 与 `ensure_legacy_schema`；`user_version ≥ 5` 时只执行待跑的迁移。
2. `schema_base.py` 与 `schema_compat.py` 自此冻结为"v5 基线"，永不再改；v6 起的一切建表、删表、删列、索引、FTS 重建都只写在迁移函数里。历史迁移函数（v1→v5）只增不改。
3. 对已有数据库（`1 ≤ user_version < 最新`）执行迁移之前，先做 `PRAGMA wal_checkpoint(TRUNCATE)` 并把数据库文件复制为 `companion.db.v<旧版本>.bak`（已存在则不覆盖）；复制失败则中止启动并给出可见错误。
4. 测试：全新建库；从 v5 样本库**逐级**升级（每级重新打开数据库）到最新；两者的 `sqlite_master` 一致；升级后再次打开，结构不变；备份文件存在。

通用规则：实体与关系用关系表，JSON 列只存值对象与单行运行态；所有带 `space_id` 的表外键 `ON DELETE CASCADE` 并建索引。

### 4.2 表结构

```sql
-- ========== v6（M1）：清理 + 基础设施 ==========
DROP TABLE IF EXISTS pairing_challenges;  DROP TABLE IF EXISTS trusted_devices;  DROP TABLE IF EXISTS local_metric_events;
DROP TABLE IF EXISTS classroom_states;    DROP TABLE IF EXISTS classroom_flashcards;      -- v2 课堂从未发布，无需搬迁数据
DROP INDEX IF EXISTS idx_owner_sessions_device_id;
ALTER TABLE owner_sessions    DROP COLUMN device_id;
ALTER TABLE owner_preferences DROP COLUMN adult_relationships_enabled;
ALTER TABLE owner_preferences DROP COLUMN adult_age_confirmed_at;
ALTER TABLE model_assignments DROP COLUMN is_bootstrap_default;
CREATE TABLE jobs         (id TEXT PRIMARY KEY, space_id TEXT, material_id TEXT, kind TEXT NOT NULL, stage TEXT, status TEXT NOT NULL,
                           progress REAL NOT NULL DEFAULT 0, detail TEXT, payload_json TEXT, tokens_in INTEGER NOT NULL DEFAULT 0,
                           tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE llm_cache    (key TEXT PRIMARY KEY, model TEXT NOT NULL, response TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT NOT NULL);
CREATE TABLE llm_usage    (day TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL,
                           tokens_out INTEGER NOT NULL, PRIMARY KEY (day, role, model));
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);   -- 全局模型角色分配、默认老师、界面偏好
-- M1 期间旧的资料入库路径继续使用 ingestion_jobs，不做双写。

-- ========== v7（M2）：资料理解 ==========
ALTER TABLE study_spaces ADD COLUMN brief_json TEXT;
ALTER TABLE study_spaces ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'none';      -- none|running|ready|failed|stale
ALTER TABLE materials    ADD COLUMN role TEXT NOT NULL DEFAULT 'textbook';              -- textbook|slides|notes|exam|exercise|syllabus
ALTER TABLE materials    ADD COLUMN meta_json TEXT;                                      -- {year, exam_name, has_answers, page_count, scanned_pages}
ALTER TABLE materials    ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'pending';       -- pending|parsed|needs_vision|failed
ALTER TABLE chunks       ADD COLUMN section_id TEXT;
ALTER TABLE chunks       ADD COLUMN page_no INTEGER;
ALTER TABLE chunks       ADD COLUMN embedding BLOB;                                      -- 归一化 float32；配套列 embedding_model TEXT
ALTER TABLE chunks       ADD COLUMN embedding_model TEXT;
CREATE TABLE material_pages   (material_id TEXT NOT NULL, page_no INTEGER NOT NULL, space_id TEXT NOT NULL, markdown TEXT NOT NULL,
                               source TEXT NOT NULL, quality REAL NOT NULL DEFAULT 1, image_path TEXT, PRIMARY KEY (material_id, page_no));
CREATE TABLE material_sections(id TEXT PRIMARY KEY, material_id TEXT NOT NULL, space_id TEXT NOT NULL, parent_id TEXT, level INTEGER NOT NULL,
                               title TEXT NOT NULL, page_start INTEGER, page_end INTEGER, ord INTEGER NOT NULL);
CREATE TABLE units            (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER NOT NULL);
CREATE TABLE knowledge_points (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, unit_id TEXT, name TEXT NOT NULL, norm_name TEXT NOT NULL,
                               kind TEXT NOT NULL, summary TEXT NOT NULL, must_know_json TEXT, formula TEXT, pitfalls_json TEXT, question_types_json TEXT,
                               importance TEXT NOT NULL, difficulty INTEGER NOT NULL, assumed INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL,
                               source_refs_json TEXT, locked_fields_json TEXT, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
                               created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE kp_edges         (space_id TEXT NOT NULL, from_kp TEXT NOT NULL, to_kp TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (from_kp, to_kp));
CREATE TABLE exam_papers      (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, material_id TEXT NOT NULL, name TEXT, year INTEGER, term TEXT,
                               full_score REAL, reserved_for_mock INTEGER NOT NULL DEFAULT 0);
CREATE TABLE exam_items       (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, paper_id TEXT, material_id TEXT NOT NULL, parent_item_id TEXT, no TEXT,
                               type TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT, answer TEXT, solution TEXT, score REAL, difficulty INTEGER,
                               answer_status TEXT NOT NULL, page_refs_json TEXT, created_at TEXT NOT NULL);
                               -- answer_status: official_verified | official_disputed | solved_verified | unverified
CREATE TABLE item_kp          (item_id TEXT NOT NULL, kp_id TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY (item_id, kp_id));
CREATE TABLE kp_exam_stats    (kp_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, n_items INTEGER, score_share REAL, recency_weight REAL, trend TEXT,
                               types_json TEXT, novel_json TEXT, weight REAL NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE item_bank        (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT NOT NULL, origin TEXT NOT NULL, exam_item_id TEXT,
                               purpose TEXT NOT NULL, type TEXT NOT NULL, difficulty INTEGER, variant_of TEXT, item_json TEXT NOT NULL,
                               verify_status TEXT NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                               -- 可判分题目的唯一身份；origin: exam|textbook|generated；purpose: diagnostic|check|practice|backfill；verify_status: verified|disputed|unverified
-- 入库任务：把 ingestion_jobs 中未完成的行以 kind='parse' 写入 jobs，然后 DROP TABLE ingestion_jobs（连同其索引）；同一提交删除对应模型与仓储方法。
-- 全文检索：DROP TRIGGER IF EXISTS（旧的三个 chunks_fts 触发器）；DROP TABLE IF EXISTS chunks_fts；
--          新建 tokenize='trigram' 的 chunks_fts 与新触发器并全量回填。

-- ========== v8（M3）：学习者与计划 ==========
CREATE TABLE learner_profile  (id INTEGER PRIMARY KEY CHECK (id = 1), profile_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE course_enrollment(space_id TEXT PRIMARY KEY, enrollment_json TEXT NOT NULL, interview_status TEXT NOT NULL DEFAULT 'todo',
                               placement_status TEXT NOT NULL DEFAULT 'todo', updated_at TEXT NOT NULL);
CREATE TABLE kp_mastery       (space_id TEXT NOT NULL, kp_id TEXT NOT NULL, p REAL NOT NULL, status TEXT NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0,
                               clean_correct_count INTEGER NOT NULL DEFAULT 0, clean_days INTEGER NOT NULL DEFAULT 0, last_clean_day TEXT,
                               objective_clean INTEGER NOT NULL DEFAULT 0, inferred INTEGER NOT NULL DEFAULT 0,
                               taught_at TEXT, last_evidence_at TEXT, PRIMARY KEY (space_id, kp_id));
CREATE TABLE evidence         (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT NOT NULL, lesson_id TEXT, item_ref TEXT, source TEXT NOT NULL,
                               verdict TEXT NOT NULL, hint_level INTEGER NOT NULL DEFAULT 0, item_type TEXT, n_options INTEGER, judged_by TEXT, via TEXT,
                               retry INTEGER NOT NULL DEFAULT 0, p_before REAL NOT NULL, p_after REAL NOT NULL, detail_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE misconceptions   (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT NOT NULL, text TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
                               first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE approach_stats   (kind TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0);
CREATE TABLE study_plans      (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
                               params_json TEXT, deferred_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE plan_items       (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, space_id TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL,   -- lesson|practice|mock
                               title TEXT NOT NULL, kp_ids_json TEXT NOT NULL, est_minutes INTEGER NOT NULL, scheduled_date TEXT, why_text TEXT,
                               pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'todo', lesson_id TEXT);

-- ========== v9（M4；复习界面在 M7）：课堂与复习 ==========
CREATE TABLE lesson_plans     (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, plan_item_id TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT,
                               model TEXT, verify_stats_json TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE lessons          (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, plan_item_id TEXT, lesson_plan_id TEXT, character_id TEXT,
                               status TEXT NOT NULL, state_json TEXT NOT NULL, board_json TEXT, recap_json TEXT, carry_over_json TEXT,
                               started_at TEXT NOT NULL, ended_at TEXT);              -- status: active|paused|done|abandoned
CREATE TABLE lesson_events    (lesson_id TEXT NOT NULL, seq INTEGER NOT NULL, gen INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
                               t_ms INTEGER NOT NULL, PRIMARY KEY (lesson_id, seq));
CREATE TABLE review_cards     (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kp_id TEXT, kind TEXT NOT NULL, front TEXT, back TEXT, item_ref TEXT,
                               fsrs_json TEXT, due_at TEXT, state TEXT NOT NULL, source_lesson_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- 数据搬迁：review_items → review_cards（kind='flashcard'），随后 DROP TABLE review_items。
```

旧表去留：`study_spaces, materials, chunks, character_packs, provider_connections, model_assignments, owner_sessions, owner_preferences, realtime_tickets` 保留；`sessions, turns, memory_items` 自 M1 起只读保留（M8 提供"导出旧对话为 Markdown"后评估删除）。

## 5. 接口面（v2，摘要）

所有接口挂 `/api/v2`；响应模型一律用 Pydantic `response_model`；改了契约就执行 `npm run generate:api` 并提交生成物。

```
会话与设置   POST /session/bootstrap · GET/PUT /settings · GET /usage
模型         GET /providers/presets · POST/GET/PATCH/DELETE /providers/connections
            POST /providers/connections/{id}/test（对每个已分配的角色各发一次最小真实请求）· GET/PUT /settings/model-roles
角色（M1）   GET /characters · PUT /settings/default-character · POST /tts/preview
角色（M6）   POST /characters（导入 VRM）· PATCH/DELETE /characters/{id}
课程与资料   见 course-analysis.md §5
学习者       GET/PUT /learner/profile · GET /courses/{id}/enrollment · POST /courses/{id}/interview/turn
            POST /courses/{id}/placement/start · /placement/answer · GET /placement/result
计划         GET /courses/{id}/plan · POST /courses/{id}/plan/replan · PATCH /plan-items/{id}（置顶/顺延）· POST /plan-items/{id}/skip-quiz
课堂         POST /plan-items/{id}/lesson（创建或恢复）· GET /lessons/{id} · POST /lessons/{id}/live-ticket · WS /lessons/{id}/live
            POST /lessons/{id}/end · GET /lessons/{id}/recap · GET /lessons/{id}/events?after=seq
复习与错题   GET /review/queue · POST /review/cards/{id}/rate · GET /courses/{id}/mistakes
```

WS 鉴权沿用"一次性票据 + Origin 校验"的现有实现（M1 抽成独立模块），票据改为绑定 `lesson_id`。

## 6. 模型网关与供应商层

详见 `llm-gateway.md`。**产品代码中不存在任何 Mock 供应商，也不存在按环境变量、请求头或配置切换假实现的入口。** 测试注入的唯一接缝：`create_app(gateway_factory=…)` 的构造参数，由测试代码（含 `services/api/tests/e2e_server.py`）传入测试替身。

## 7. 密钥与本地会话（零密码默认）

现状：必须先设主密码；API 进程每次重启都要重新输入；`vault.json` 非原子写入。目标：

1. **信封加密**：随机生成 32 字节数据密钥 DEK；供应商 Key 用 DEK 以 AES-256-GCM 加密存 `vault.json`（沿用现有格式并加 `version` 字段）。
2. **DEK 的存放**（按顺序尝试）：操作系统凭据库（Python `keyring`）→ 不可用时落到数据目录下仅当前用户可读的 `key.bin`，并在设置页明确提示"密钥文件与数据在同一位置，安全性较低"。
3. **可选主密码**（设置 → 安全）：开启后 DEK 改由 Argon2id 派生密钥包裹，并从系统凭据库移除；此时启动需要解锁。删除 PBKDF2 静默降级分支。
4. **写入原子化**：临时文件 + `os.replace`，写前保留一份 `.bak`。
5. **旧数据迁移**：检测到旧格式 `vault.json` → 首次启动提示"输入一次旧主密码完成迁移"，可跳过（跳过则需重新录入 Key）。
6. **本地会话**：服务只监听 `127.0.0.1`。`POST /api/v2/session/bootstrap` 对来自回环地址的请求直接签发 HttpOnly + SameSite=Strict 的会话 Cookie（密钥由 DEK 派生，进程重启后仍有效）；保留 CSRF 头与 Origin 校验。开启主密码时返回"需要解锁"。Docker 部署必须设置访问口令环境变量，首次访问输入一次（M8）。
7. 不变的红线：明文 Key 不落盘、不进日志、不进任何响应；测试与门禁不使用真实 Key。

## 8. 运行、并发与任务

- **数据目录**：现状是 `object_storage_path = "./storage"`，**相对当前工作目录**——M1 改为相对应用根并支持 `COMPANION_DATA_DIR` 覆盖。在那之前，任何手动启动服务都必须先把 `OBJECT_STORAGE_PATH` 指到临时目录，**不得对仓库里的 `storage/` 启动服务**。
- **评测与模拟学生一律使用独立数据目录**：`evals/*.py` 与课堂命令行的模拟模式把数据目录设为 `evals/out/data/<运行id>/<人设>/`（每个人设一个全新库）；解析出的数据目录等于默认数据目录时直接报错退出。
- **启动**：`start.bat`（双击入口；内容为纯 ASCII、CRLF，调用 `powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1`）与 `start.ps1` / `start.sh`：检查 Python ≥ 3.12 → 建虚拟环境（有 `uv` 用 `uv`）→ 安装依赖（`-Mirror cn` 切换国内镜像）→ 缺 `apps/web/dist` 则构建（需要 Node；发行包自带）→ 用 `python -m uvicorn …` 启动 → 打开浏览器。`start.ps1` 必须能在 Windows PowerShell 5.1 下运行：文件只含 ASCII 字符（中文提示由 Python 输出）。
- **并发**：异步路由里不得直接调用同步 sqlite 仓储或阻塞式模型调用——统一 `await asyncio.to_thread(...)` 或放入任务；音频帧处理路径上不得读写数据库。
- **统一后台任务** `JobRunner`（合并现有"入库线程"与"复盘任务"两套机制）：`jobs` 表持久化、启动恢复、全局并发信号量、进度回调 → SSE。任务种类：`parse, structure, index, kp_extract, kp_reduce, exam_extract, item_verify, exam_stats, diag_pool, brief, lesson_prepare, more_items, recap, replan`。
- **错误**：类型化异常 → 统一错误响应 `{code, message, detail?}`；删除按异常文本子串匹配状态码的做法；前端按 `code` 分支。
- **日志**：结构化；不记录提示词全文、资料正文、学生原话、Key。
- **固定文案**：后端面向学生的固定句子与模板放 `services/api/app/i18n/zh-CN.json`，前端放 `apps/web/src/locales/zh-CN.json`，数学读法表放 `content/speech/zh-CN.json`；代码里不写中文句子（防空壳扫描会检查）。

## 9. 现有代码处置表

"A" = `services/api/app`。**每一组删除都要先 grep 调用方，把相关的导入、路由注册、依赖装配与测试在同一提交里一起改掉；删完该组后端门必须全绿——若因后面才删的东西而变红，调整分组顺序，不要去修将被删除的测试。**

### 9.1 保留（可小改）

| 模块 | 说明 |
| --- | --- |
| `A/repositories/migrations.py`、`mixins/infrastructure.py` | 迁移器与建库事务；按 §4.1 改造，新增 v6–v9 |
| `A/repositories/mixins/{course,rag_read,rag_write,providers,sessions,turns,rows,common,owner_sessions}.py` | 中心表访问 |
| `A/repositories/mixins/metrics_tickets.py` 中的 realtime 票据方法 | **只删其中的指标方法**；文件与类改名为 `tickets.py` / `TicketMixin` |
| `A/services/vault.py`（去掉移动端段落）、`browser_session.py`、`A/api/deps.py` 的 owner 依赖 | 按 §7 改造 |
| `A/providers/{errors,sse,factory}.py`、`openai_compatible.py`、`anthropic_provider.py`、`gemini_provider.py`、`elevenlabs_provider.py`、`local_neural_tts.py` | 接口按 `llm-gateway.md` 扩展 |
| `A/services/provider_registry.py`（连接 CRUD、分配、解析） | 去掉 Mock 引导、加预设与全局默认 |
| `A/services/material_storage.py`、`spaces.py` 中的上传校验/路径安全/入库任务骨架 | M2 把 `spaces.py`（984 行）拆为课程 CRUD / 入库 / 检索 |
| `A/services/character_modules/{crud,vrm,paths,vrma,common}.py`、`motions.py` 与 `asset_lifecycle.py` 中"上传单个 VRM"路径、`licenses.py` | 角色 = 形象 + 声音 + 人设 + 默认讲法；`vrma.py`、`common.py` 到 M6 再定去留 |
| `A/api/routes/realtime.py` 的票据/Origin 鉴权段、`A/services/realtime.py` 的 generation 守卫 | M1 抽成独立模块并补单测，供 `/lessons/{id}/live` 使用 |
| `libs/schemas/default_character_recipe.json`、`default_nova_character_recipe.json` | `A/models/domain.py` 在导入时读取，**不要随手清掉** |
| 旧前端里值得移植的零件（M0 后位于 `legacy/web-next/`）：`components/realtime/realtime-audio-capture.ts`、`realtime-audio.ts`、`realtime-transport.ts`、`lib/api/transport.ts`、`lib/runtime-config.ts`、`components/ui.tsx`、`app/styles/foundation.css` 的色板；`packages/lesson-board/math.tsx` 与 Mermaid 渲染 | 移植到新前端 |
| `packages/avatar-engine`：加载/释放、包围盒与相机取景、表情能力探测、`teaching-cue.ts`、`vrm-speech-controller.ts` 的发布订阅模式 | M6 重构 |
| 素材：3 个示例 VRM（`VRM1_Constraint_Twist_Sample`、`Sendagaya-Shino`、`Sakurada-Fumiriya`）、6 张角色立绘（`art/roster/*.png`）、房间背景（`room/observatory*.webp`） | M0 移入 `assets/avatars/` |
| 测试：`services/api/tests/conftest.py` 的 `isolated_settings / client` 夹具；隔离、密钥不外泄、迁移、Cookie-CSRF、供应商适配器、入库加固相关用例 | |
| `services/tts/`、`START-NEURAL-TTS-HOST.ps1`、`docker-compose.neural-host.yml`、`BACKUP-WINDOWS.ps1` | 原样保留；改动 `services/tts/` 时才跑它自己的测试 |

### 9.2 重写（在对应里程碑用新实现取代）

| 模块 | 原因 | 何时 |
| --- | --- | --- |
| `A/providers/base.py` 的 LLM 接口 | 只有纯文本、无参数、无图片、无重试；Anthropic 输出写死 1024 token | M1 |
| `A/rag/parser.py`、切块与检索（`spaces.py` 内）、全文检索设置 | 仅支持 md/txt/文字 PDF；**超过 1400 字的单块被截断丢内容**；`unicode61` 分词使中文只能匹配块首；重排器是恒等函数 | M2 |
| 实时回合流程与前端实时 Hook | 整段回复生成完才做**一次** TTS；无分句、无线上回合编号、无重连 | 后端旧流程 M1 删除；新流水线 M5 |
| `packages/avatar-engine/src/vrm-stage.tsx` 的动画/手势/口型部分、`viseme.ts` | 手臂被常量强制张开；口型是与语音无关的 5 形循环 | M6 |
| 前端全部页面与课堂界面 | 现为"管理后台"形态；主流程页面不存在 | M1–M7 |

### 9.3 删除

| 何时 | 模块 | 说明 |
| --- | --- | --- |
| **M0** | 钉常量的测试：`tests/test_api_route_contract.py` 与其快照、`test_m5_bundled_assets.py`、`test_m2_config_surface.py` 中钉常量的用例、断言 Mock 文案或 `dataset` 遥测的用例 | **最先删**（否则后面每一组都会让门变红） |
| **M0** | 写死的课堂与演示：`A/services/{pedagogical_orchestrator,classroom_curriculum,classroom_repository,demos}.py`、`A/models/classroom.py`、`A/api/routes/classroom.py`、`A/services/character_modules/persona.py`、`libs/schemas/lesson_script.schema.json` 及其测试 | 空壳本体；两张 classroom 表留到 v6 删除 |
| **M0** | 移动端残留：`routes/vault_mobile.py` 的移动路由、`vault.py` 的配对段、`mixins/pairing.py`、`mixins/trusted_devices.py`、`require_local_owner`、`MOBILE_APP_ORIGINS`、相关测试 | **不得改动历史迁移函数**（它们会建那两张表）；`device_id` 字段先停用，列在 v6 删除 |
| **M0** | `A/services/legacy_import.py` 与两条路由、`knowledge_base_*` 配置、相关测试 | 无界面调用 |
| **M0** | 指标子系统：`A/services/metrics.py`、`routes/metrics.py`、每请求写库的中间件、`test_local_metrics.py`；mixin 里只删指标方法 | |
| **M0** | Live2D/Spine 桥与多余的角色导入导出：`character_modules/{airi,display_validation,pack_import,archives,card_import}.py` 及对应路由与测试；`services/characters.py` 的基类列表相应收缩 | |
| **M0** | 成人关系偏好：路由、模型字段、`vault.py` 与 `asset_lifecycle.py` 中的相关逻辑、相关测试（**只删代码，列在 v6 删除**） | 用户含未成年人 |
| **M0** | 死语音层：`providers/{voice_factory,tts_elevenlabs,tts_mock,stt_mock,stt_faster_whisper,tts_base,stt_base}.py`、`models/voice.py`；`services/worker/` | 先从仍要保留的测试里摘掉对它们的引用 |
| **M0** | 无读取方的配置：`app_display_name, default_character_style, memory_write_enabled, citation_required`；BGE 相关默认值 | |
| **M0**（归档） | 旧前端 `apps/web` → `legacy/web-next`；旧 E2E、Playwright 配置、旧启动脚本与相关脚本 → `legacy/` | 详见 `MILESTONES.md` M0 |
| **M0**（下线不删） | 6 个脚本生成的 VRM、4 个脚本生成的 VRMA、Mori/Yuzu 精灵图及其生成/修复/校验脚本 → `assets-archive/`；`Seed-san.vrm` 移出分发 | 是否彻底删除由所有者决定 |
| **M0**（归档） | 过程文书与描述旧产品的文档 → `docs/archive/` | 清单见 `MILESTONES.md` M0 |
| **M1** | `A/providers/pinned_http.py` 与强制追加 `/v1` 的逻辑 | 阻断本地/局域网端点，破坏智谱（`/api/paas/v4`）与方舟（`/api/v3`） |
| **M1** | `A/providers/mock_provider.py`（改造成测试替身移入 `tests/fakes/`）、各处 `provider == "mock"` 分支、Mock 引导分配、`is_bootstrap_default` 机制 | 空壳的根源 |
| **M1** | 旧对话栈：v1 的 sessions / turns / learning / realtime 回合路由、`A/services/companion*.py`、`streaming_json.py`、`prompt_loader.py` 的旧拼装、旧 `libs/prompts/*.md` 及其测试 | **删除而不是移植到新接口**；`sessions / turns / memory_items` 表只读保留 |
| **M1** | v1 的 vault / providers 路由 | 被 v2 设置接口取代 |
| **M2** | v1 的 spaces / materials 路由、`ingestion_jobs` 表与模型 | 被 v2 课程与资料接口取代 |
| **M6** | v1 的 characters 路由、`packages/avatar-engine` 中被重构取代的代码 | |
| **M8** | `legacy/` 整个目录、根目录旧 `docker-compose.yml` 的多服务编排、其余残留 | |

## 10. 依赖策略（取代旧的"白名单"）

- 新增依赖必须：许可为 MIT/BSD/Apache/MPL/ISC（LGPL 仅限未修改的包依赖）；在 `DECISIONS.md` 记录用途、许可、替代方案；锁定版本；先查官方文档确认当前版本与用法。
- 预期新增：后端 `python-pptx`、`python-docx`、`pypdfium2`、`Pillow`、`keyring`、`edge-tts`、`numpy`、`json-repair`；可选扩展 `rapidocr`、`sherpa-onnx`、`sympy`。前端 `vite`、`react-router`、`@tanstack/react-query`、`zustand`、`tailwindcss`、`katex`、`mermaid`、`react-markdown` + `remark-math` + `rehype-katex`、`function-plot`、`mathjs`、`vitest`；语音与形象阶段 `@ricky0123/vad-web`、`wlipsync`。角色支线的工具：`sharp`、`three`、`@pixiv/three-vrm`、Playwright（**不要用会丢弃未注册扩展的通用 glTF 库整体读写 VRM**）。
- 仍然禁止：Live2D/Cubism、GPL/AGPL 代码或依赖（含 PyMuPDF）、PostgreSQL/Redis/Celery、Electron。

## 11. 安全（与单机单用户相称）

保留：Key 静态加密；回环监听 + Origin/CSRF；上传路径约束与类型校验；资料与学生输入作为不可信数据块注入；模型生成的可交互内容只在沙箱 iframe 中运行；日志脱敏；课程间数据隔离。
放弃：DNS 钉扎式 SSRF 防护、设备配对、每请求指标落库。
新增：角色卡不能覆盖系统层；面向学生的输出过滤成人/危险内容；学生流露自伤念头时的固定应对。
