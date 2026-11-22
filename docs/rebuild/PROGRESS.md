# 重塑进度

## M0 止血与地基 — 所有者验收通过（2026-11-17）

**待验收与已知问题**

- 所有者已确认 M0 验收通过。旧前端已归档，新界面在 M1 恢复。Docker 路径在 M0–M7 暂停使用。
- 防空壳扫描在 M0 独立运行，报告 36 处旧 Mock 引用，其中 5 处在冻结的历史兼容代码。M1 接入门禁。旧角色引擎仍含归档模型的预设地址，安排在 M6 处理。
- GitHub CI 配置已编写，未在 CI 上运行过。真实模型评测从后续里程碑开始，M0 无模型请求或 token 用量。
- MIRA、KITE、CAEL、LYRA 四张立绘保留原件，逐项作者和再分发许可待发布前确认，已登记到 [待处理](HUMAN-TASKS.md)。

**本地验收**

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Contract` 通过。ruff 通过，pytest 404 项通过、0 项失败、2 项跳过（Windows 环境无法创建测试所需的符号链接）。OpenAPI 生成契约一致。
- 使用临时数据目录启动 Uvicorn，`GET /healthz` 返回 HTTP 200 和 `{"ok":true}`。确认在临时目录生成 SQLite 库，验证后关闭服务。
- 素材许可测试通过。Git 确认 29 个素材与其元数据文件按原字节移动。防空壳脚本的隔离通过与拒绝场景均已验证。
- SQLite 的历史迁移、基础建表、兼容与维护文件经 Git 比较完全一致。保留的 HTTP 操作 ID 与开工基线一致。工作只提交到本地 `rebuild/tutor`。

**清理前后**

| 指标 | 开工基线 | M0 结束 |
| --- | ---: | ---: |
| 后端 Python 源码行数 | 19,665 | 14,308 |
| 后端 Python 测试行数 | 20,143 | 14,261 |
| OpenAPI HTTP 操作数（含 `/healthz`） | 83 | 62 |
| `docs/` 活跃文件数（排除 `docs/archive/`） | 72 | 25 |

已归档旧 Next.js 前端、E2E、旧启动脚本和旧文档。已移除写死的互动课堂和演示、移动端配对和成人偏好、旧知识库导入、本地指标、Live2D/Spine 桥与 ZIP/JSON 角色包导入导出、旧语音层和未用设置。保留单 VRM 导入、动作管理、浏览器认证及实时票据。详细取舍见 [DECISIONS.md](DECISIONS.md)。

**所有者验收清单**

- [ ] 查看 `git log --oneline -20` 和 `git status`，确认 `c72370f` 上的 `pre-rebuild-20261116` 标签及干净工作树。
- [ ] 核对上表及 [根目录新约定](../../AGENTS.md)。
- [ ] 核对 [归档资产](../../assets-archive/README.md) 与 [保留资产](../../assets/avatars/LICENSES.md)。归档包含 6 个旧 VRM、4 个 VRMA、Mori 与 Yuzu、单独隔离的 Seed-san。保留 3 个示例 VRM、6 张立绘及 2 张背景。

**开工基线**

- `527c81de6fe47fdaf155f5fca1ef590f4a2d4ef7`，`rebuild/tutor`。工作树与索引写入检查通过。桌面项目目录联接到 E 盘工作树。
- Python 3.14.10、Node v24.14.0、本机 npm 11.9.0。锁文件用计划指定的 npm 11.21.2 重建。
- ruff 与 OpenAPI 契约通过。pytest 574 项通过、0 项失败、3 项跳过。测试在可访问本机回环的执行环境运行，数据目录指向临时路径。

## M1 新外壳与模型网关 — 真实模型实测通过（2026-11-17）

**未验证与已知限制**

- 所有者验收待执行。全新数据目录免密码。已有旧保险箱时，界面会引导进行一次旧密码迁移或选择跳过。GitHub CI 配置已编写，未在 CI 上运行过。
- M1 的 3D 示例使用明确标注的占位，3D 预览安排在 M6。POSIX 启动脚本已通过语法检查，启动实测使用 Windows。

**最终本地门**

- `scripts/gate.ps1 -Frontend -Contract` 全部通过。ruff、OpenAPI 生成契约和防空壳扫描通过。pytest 301 项通过、0 项失败、2 项跳过，跳过原因仍为 Windows 符号链接权限。迁移、凭据库路径和受保护密钥文件、会话、网关和任务等均有回归覆盖。
- 前端类型检查、lint、Vitest 3 项和 Vite 生产构建通过。Playwright 1 项完整流程通过，覆盖单进程免密码启动、选择老师后刷新、试听降级、模型配置和逐角色测试、流式文字与图片诊断、删连接后绑定剩余连接。浏览器自动化通过应用工厂注入测试网关。
- Windows 启动脚本在临时数据目录实测通过 `/healthz` 与 SPA 深链接检查。占用端口时提前退出，未初始化数据库。PowerShell 和批处理文件通过 ASCII 检查。
- 已目视核对 1440×900 桌面及 390×844 手机界面。截图位于本地 `docs/rebuild/review/M1/`，包括欢迎、设置和桌面试聊页。

**真实冒烟**

| 项目 | 结果 | 实测值或原因 |
| --- | --- | --- |
| 流式对话首 token | 实测通过 | GPT-6 Luna，1,804 毫秒，输入 21、输出 11 token |
| LaTeX 标签块往返 | 实测通过 | GPT-6 Luna，2,497 毫秒，输入 74、输出 34 token |
| 含公式页面的图像转写 | 实测通过 | GPT-6 Luna，4,410 毫秒，输入 263、输出 176 token |
| 单条嵌入 | 实测通过 | text-embedding-3-small，1,536 维，1,695 毫秒 |
| 默认语音接口 | 实测通过 | 在线 Edge，MP3 14,976 字节，2,288 毫秒 |

**变化**

| 指标 | M0 结束 | M1 结束 |
| --- | ---: | ---: |
| 后端 Python 源码行数 | 14,308 | 12,096 |
| 后端 Python 测试行数 | 14,261 | 7,989 |
| OpenAPI HTTP 操作数（含 `/healthz`） | 62 | 51 |

替换了旧对话、角色绑定引导、流式回合、固定 JSON 提示词栈以及 DNS 钉扎层。v1 留下 28 项资料、课程与角色操作，v2 增加 22 项本地登录、模型网关和设置相关操作。默认老师 9 位，含 6 位立绘和 3 位 3D 示例。工作只提交到本地 `rebuild/tutor`。

**所有者验收清单**

- [ ] 双击 `start.bat`，确认默认浏览器自动打开；全新数据目录全程免密码。
- [ ] 在设置里选预设、粘贴 Key、测试连接，查看已分配角色的独立结果。
- [ ] 在试聊中确认模型边生成边显示，然后上传一张带公式的教材照片核对转写。
- [ ] 从欢迎页选一位老师并试听，确认选择保存。
- [ ] 停服务后重新启动，确认配置和 Key 可继续使用。
- [ ] 核对数据目录中的凭据载荷保持密文，搜索结果里没有明文 Key。

**M1a 内部检查点**

- 本地门通过 ruff、OpenAPI 契约、防空壳和 pytest。集成工作树 301 项通过、0 项失败、2 项因 Windows 符号链接权限跳过。
- v1–v5 逐级迁移至 v6、升级前备份、旧保险箱迁移、零密码和主密码开关、原子写中断、回环/Origin/CSRF、票据及后台任务恢复均有自动化覆盖。
- `evals/smoke_gateway.py` 已运行，缺少 `.env.eval`，按计划记录真实模型指标未验证。独立的零配置 Edge 试听接口实测返回 HTTP 200、34,848 字节 MP3，耗时 2.006 秒。

## M2 资料理解 — 进行中（2026-11-17）

**待完成与待验证**

- 工作区缺少 `.env.eval`。示例集和运动学留出集的真实模型指标、实际 token 用量、正式模型的缓存重跑及图片转写待验证。留出集未运行。真实资料的所有者验收待执行。
- 无原生目录时，使用各页前 200 字分批推断章节。摘要按原页抽检并报告支持率。长试卷按重叠窗口切题，第二遍从原卷提取参考答案。知识点按单元及相似候选分批归并。相关自动化覆盖原页编号、参考答案回贴及失败可见性。真实长试卷及完整规模资料待达标。
- GPT-6 Luna 已跑通原创教材摘录和一题选项试卷的资料分析。首轮完整样例在复核阶段遇到 OpenAI 官方接口拒绝隐式 `temperature=0.2`，已修复该默认参数并启动正式复测。生成题的输出或复核格式失败会丢弃该题并提示缺口。
- 完整实测第二轮见 `evals/out/m2-sample-20261117-235023.json`。概率样例的知识点召回 50%、额外点 78.05%、边召回 8.33%、答案准确 41.67%、映射召回 8.33%，缓存复跑仍有模型消耗。离线逐题核对确认答案低分主要来自 `\(...\)` 包装和正确长答案的释义差异；规范化修复后旧输出答案准确率为 100%。知识点低分来自 41 个过细候选未在同一批次归并，映射还会丢弃模型选出的词法前八名以外考点。
- 现已让 64 个以内的同单元候选全局归并，由模型给出有出处的课程级规范名称；保留已有知识点标识，映射不再用词法候选表二次丢弃模型选择。历史样例第 2 题的选项映射格式失败改为严格 `unverified`，不会进入可判分题库，并在课程简报显示 `item_verification_incomplete`；原失败题的 Luna 单题复测已验证为 C。评测报告在每门样例、参考答案复核及用量阶段原子落盘，中断结果不再丢失，格式失败不计入准确率分母且整份结果标为未验证。
- 第三轮完整样例和复核器结果已落盘到 `evals/out/m2-sample-20261117T155620631786Z.json`。按冻结金标，历史和概率样例的知识点召回分别为 12.5% 和 20%，额外点比例为 94.44% 和 85.71%，前置边召回均为 0%，答案准确率均为 100%，题目映射召回分别为 12.5% 和 4.17%。两门均有题目尚未复核，缓存复跑仍消耗模型调用。独立复核器测满 30 题，错误参考发现率 100%，正确参考误报 0%。知识点归并提示词随后改用简洁标准名，并按可独立教学的概念归并；这版提示词的后续实测被联网自动审批阻断，审批理由涉及向 OpenAI 发送仓库原创样例与复核器合成题。留出集继续保留到样例和缓存门均通过后。
- 本轮离线解析重新核对两门原创课的全部 16 页，原文和显式页码均匹配。记录见 `evals/out/m2-parse-20261117T161853974918Z.json`。
- GitHub CI 配置已编写，未在 CI 上运行过。

**本地验收**

- `scripts/gate.ps1 -Frontend -Contract` 通过。ruff、OpenAPI 契约、防空壳、前端类型检查、lint 和构建通过。后端 299 项通过，2 项因 Windows 符号链接权限跳过。前端 Vitest 6 项通过。
- Playwright 通过 M1 和 M2 两条流程。M2 覆盖新建课程、上传及修正资料类型、分析进度、课程地图、出处、关联真题和知识点修订。浏览器使用本机 Chrome 与隔离数据目录，通过应用构造参数注入测试网关。已目视核对桌面及 390px 手机界面。
- Windows 启动冒烟通过。断点测试让简报阶段失败，重启后重试同一任务。已完成的知识点抽取和归并各执行一次。
- M2a 核对了概率教材 9 页、历史教材 3 页及四套各 1 页的试卷，共 16 页。规范化正文与原文件逐页核对一致。测试覆盖扫描页标记、文档格式、受保护图片路径、中文检索和课程隔离。
- 本轮 M2、评测持久化及课堂计划回归测试 34 项通过；完整后端门 435 项通过、2 项跳过。修复题型规范化后，题库读取会先带入数据库中的题型再做校验，课堂计划的负向验证门保持通过。Ruff 与防空壳扫描通过。

**代码与评测基线**

- 上线 v2 课程与资料接口。v7 升级前备份，继承旧资料路径及未完成入库任务，重建 trigram 索引。支持 PDF、PPTX、DOCX、Markdown、纯文本、图片和粘贴文本。
- 分析任务记录阶段与 token，支持断点和阶段重试。课程地图带原页引用、前置关系、分值占比和频次。保留试卷原答案，通过复核的题才可进入可判分题库。
- 原创示例材料及金标在 `cb91519` 先提交。提示词在 `5a8dd7a` 冻结，随后提交独立留出集 `fda5260`。`evals/analysis_eval.py --parse-only` 已运行，默认真实评测与 `--holdout` 均返回缺少配置。

**所有者验收**

- 双击 `start.bat`，从「课程」新建课程。导入自己的一章教材和两至三套真题，建议包含一份扫描件。核对资料角色、进度恢复、原页引用、试卷题数与答案，并对照熟悉的考点检查频次与分值占比。
- 模型评测配置见 [待处理](HUMAN-TASKS.md)。

## M3 认识学生与个性化计划 — 代码完成（自动化通过）（2026-11-17）

**待完成与待验证**

- 显式冻结的 30 条原创口语回答用 GPT-6 Luna 实测，41/47 个预期槽位正确（87.23%，门槛 90%）。结果在 `evals/out/interview-luna-v2.json`。新一轮尚无有效模型结果。所有者仍需用自己的课程验收访谈、诊断和计划取舍。
- `packages/board` 已接替旧 `packages/lesson-board`；诊断和课堂共用其渲染基础，单选、多选和数值作答路径已有自动化覆盖。

**已实现**

- 从「课程」进入一门课，打开「学习设置」。个人偏好全局共用。学习目标、考试日期和分数、每周学习日、单次时长与自评水平按课程保存。
- SQLite 在 v7 升 v8 前备份。新增八张学习者与计划表，课程归属和计划项一致性由数据库约束校验。
- 加入掌握度先验、作答概率更新和达标判定，并核对规格中的八组数值。获得三级提示后作答和查看答案均不改变掌握度。
- 六组访谈由当前老师角色改写问题，支持自由回答槽位抽取、抽取失败后的设置芯片回退、随时跳过，并按老师当前音色、语速和音高朗读。30 条原创金标覆盖六个主题。
- 起点诊断只读取已复核的客观题，支持不会、停止、确定性选题、先修传播、证据落库、推测标记和结构化结论。计划实现权重封顶与归一化、前置闭包、拓扑排序、装箱、练习/模考、排期、事实理由和取舍。
- 计划支持置顶、顺延、取消固定、已复核小测跳过和版本化重排。重排保留固定及已开始/完成项，低于 1.10 的相邻优先级变化不扰动旧顺序。`build_plan`、`stabilize_plan`、`persist_plan(on_plan_ready)` 作为 M4/M7 的稳定接点。
- 新课堂按“计划指定风格 → 学生明确选择 → 当前老师默认风格”取初始讲法；老师默认值的后续编辑只影响新课堂，恢复中的课堂继续使用已保存状态。

**本地验证**

- 本轮完整后端 443 项通过，2 项因 Windows 符号链接权限跳过；Ruff 通过。M3 聚焦用例覆盖访谈顺序、诊断、证据、计划、跳过小测、固定/重排稳定性、回调和老师默认风格。
- Windows 启动冒烟通过。临时数据目录启动后，健康检查和 SPA 深链接均返回 HTTP 200。
- 前端 lint 与 19 项 Vitest 通过。共享 OpenAPI 客户端等待主集成者统一再生成；再生成前，新增的回放路由使类型检查/生产构建报告契约陈旧，不归因于 M3 运行逻辑。防空壳扫描当前仅被另一实现中的保留“模考”字段标识拦截，M3 的窄化允许项已通过。

## M4 教学引擎（文字课堂） — 进行中（2026-11-17）

**待完成与待验证**

- 真实整课冒烟已完成。正式评测仍缺独立评分模型、历史课已复核教案和 20 例准备清单。`evals/tutor_eval.py --validate-manifest` 可离线检查两门课、各两节和五种人设的完整矩阵，并只读验证课例数据库。样例与留出分开报告。空轨迹、未完成课堂或未覆盖提示不得通过已实现的检查。重讲、示范与变式、主动验证、沉默、格式占比和讲法等仍有未覆盖指标，完整门继续标为未验证。
- 独立评分输入已补上课堂白板、标记、已复核的教学示例和题目，以及结构化判分证据。每个质量分维度都要求返回判分依据。该协议本轮用离线测试核对，仍待独立模型实跑。
- M3 个性化排期和版本化重排已经接入。计划生成通过持久化 `lesson_prepare` 后台任务预备后续两节课；下课在证据与小结耐久提交后同步重排，再排队预备新的后续两节。完整迷思闭环仍待接入。
- 文字引擎整拍保存后才交给命令行显示。直播推送、生成中的实时打断和 M4b 浏览器课堂待实现。教学策略用例覆盖了主要轨迹，完整规格验收还未走完。

**已落地**

- SQLite v9 迁移保留旧复习卡的来源会话。教案与新复核题一次保存，课堂事件、状态、判分证据和掌握度一次提交。开课后使用绑定的教案版本，重新分析课程资料时可按原教案继续作答。
- 备课使用课程资料和已复核题库。生成题与例题经过独立复核，检查题、变式、讲法和防泄漏校验均通过后才保存教案。
- 课堂处理开讲、检查、提示阶梯、示范解法、换讲法、前置回补和沉默暂停。模型输出经过增量解析和板书校验，客观题由代码判分，论述题按给分点判分。结课从事件和作答记录生成小结，并写入错题和可用的确认题卡。
- 在仓库根设置 PYTHONPATH 为 services/api 后，可用 .venv/Scripts/python.exe -m app.teaching.cli --prepare PLAN_ITEM 备课并打开，或用 --lesson LESSON_ID 恢复已有课堂。CLI --help 列出参数。
- CLI 支持 `--student sim:strong|weak|confused|guesser|answer_seeker`，并强制数据目录位于 `evals/out/data/<运行>/<人设>`。`evals/tutor_eval.py` 用 `SIM_MODEL` 驱动学生、拒绝与被评老师同指纹的独立评分模型，保存完整事件，并计算不变量、提示泄漏、五项质量阈值、强弱学生拍数、猜题者掌握状态和前置回补；无 `.env.eval` 时明确返回未验证。
- 课堂记录每次讲解采用的讲法。第一道检查题的首次无提示作答会更新 `approach_stats`，Director 按 `(success+1)/(n+2)` 使用历史效果选择未用讲法。

**本地验证**

- 本轮后端完整测试 430 项通过、2 项跳过；Ruff 与防空壳扫描通过。前端类型检查、lint、22 项 Vitest 和生产构建通过。OpenAPI 客户端需在全部并行路由合入后统一再生成。
- `evals/tutor_eval.py` 在缺少 `.env.eval` 时返回“未验证”，未把自动化或模拟结果冒充真实模型成绩。独立评分、泄漏判定和数值阈值代码已有单测，正式 20 节课堂清单仍待运行。
- scripts/gate.ps1 -Frontend -Contract 全部通过。后端 383 项通过、2 项因 Windows 符号链接权限跳过。ruff、OpenAPI 契约、防空壳、前端类型检查、lint、6 项 Vitest 和生产构建均通过。
- 隔离课堂用例验证了首拍前暂停仍会开讲、未确认的讲解可重播、待答题恢复时不重新生成、两次沉默只提醒一次并暂停、重试使用折扣证据、重复提交已结案题不产生证据。题库替换后仍按绑定教案判分，下课小结和错题卡同步保存。

**GPT-6 Luna 冒烟**

- OpenAI 官方模型列表和一次短对话返回 HTTP 200。项目的原流式请求因 max_tokens 返回 HTTP 400，改用 max_completion_tokens 后，真实流式网关和基础数值题复核通过。
- 使用临时编写的合成算术资料和隔离数据库。首次备课因要点讲法数量不足被拒。补充明确的四种讲法结构以及失败反馈后，复测进入题目复核，遇到模型输出格式错误。已让这类错误使用原有的一次备课重试。
- 备课现在允许独立的新基础题，并将题库 ID 统一成教案内的变式引用。提示词明确所有题都必须带两级保底提示。最新复测通过流式网关与基础题复核，备课仍因部分要点缺少只依赖已讲内容的检查题而拒绝，未进入上课环节。该轮记录了 2 次分析、26 次复核、1 次实时模型调用。
- 修复后的完整本地门通过。后端 386 项通过、2 项跳过，契约检查、防空壳、前端类型检查、lint、6 项测试和构建均通过。

**逐要点备课修复与整课复测**

- 备课按检查题最早可出题的进度独立复核内容依赖。拒绝超出已讲范围或实际未考目标要点的候选题，并对缺口定向补题。补题仍需通过内容依赖复核、独立解题和提示泄漏检查。课堂讲完新要点时优先出覆盖该要点的合格题。同类变式也受已讲范围和教案允许的检查题集合约束。
- GPT-6 Luna 使用一节合成算术课从备课自然走到结课。备课约 65 秒，课堂驱动约 24 秒。教案包含 2 个要点、5 道已复核检查题和 2 道已复核例题。第 1 个要点讲完后，新题只依赖要点 1。第 2 个要点讲完后，新题依赖已讲的要点 1 和 2。
- 在隔离数据库核对课堂和计划项状态均为 done。实际出题 3 道，记录 1 次提示、4 条作答证据、2 张复习卡和 91 条连续编号的课堂事件。课后小结已保存。运行 ID 为 fd6d10b20e9e4c2b96d252ea0e6a4dd9。此轮覆盖单节合成课，正式多课程评测与独立评分仍待完成。
- 最终完整本地门通过。后端 397 项通过、2 项跳过。Ruff、OpenAPI 契约、防空壳、前端类型检查、Lint、6 项 Vitest 和生产构建均通过。

## M5 开口说话 — 进行中（2026-11-17）

**待完成与待验证**

- 缺少 `.env.eval` 和隔离的真实语音课堂输入。真实麦克风到转写、佩戴耳机上完整节课及四项延迟指标待验收。延迟脚本支持输出各场景至少 20 次的中位数与第 90 百分位。脚本中的停播延迟是客户端机械测量，实际听感需要现场复核。
- 首个可安全朗读的分句和白板事件在整拍提交前下发。前端与后端对齐生成编号，打断回到已听位置。可预测的下一拍已接入预生成。音色设置按教学拍读取，拍内已预取的分句使用该拍的设置。
- Sherpa 离线识别首次下载前展示许可，校验上游压缩包的 SHA-256 后安装。Windows 实测加载通过，一段上游中文录音能转写，有一处同音字误识。ElevenLabs、本地神经语音和 GPT-SoVITS 尚需真实服务验收。

**首批实现**

- 在课程地图选知识点，点「开始或继续这节课」。先复用原有备课与题目复核，再进入浏览器课堂。浏览器使用单次票据和 Origin 校验连接实时课堂，恢复时按事件编号补齐记录。
- 字幕、板书和作答控件按同一时间线执行。分句语音采用有序预取和带生成编号的 PCM 或 MP3 帧。打断时本地先停，再取消该拍的合成，并按学生已听到的位置恢复板书。教师语音不可用时可切到浏览器朗读或字幕。
- 支持按住说话、使用本机资源的 Silero 免提、连续帧与预滚。音频只保存在内存，过滤过短输入、静音、空转写和疑似回声。语音和文字识别出的客观题答案先预填，等学生确认后才判分。
- 设置的「语音」支持默认和每位老师的引擎、音色、语速与试听，以及麦克风电平和转写回显。课堂进入后台时暂停并释放麦克风。

**本地验证**

- 真实 Edge MP3 冒烟返回 37 个音频块、共 26,496 字节。只发送了一句独立测试文案。
- 本地门覆盖分句、回退、过期音频、打断、票据和事件补齐。后端 423 项通过，2 项因 Windows 符号链接权限跳过。前端 17 项通过，包含停止采集后才获得麦克风权限的释放回归。Ruff、OpenAPI 契约、防空壳、类型检查、Lint 和生产构建通过。
- Chrome 端到端 4 项通过。M5 用隔离数据验证了白板、刷新恢复、作答、判分和结课小结。桌面与 390 px 移动画面存放在本地 `docs/rebuild/review/M5/`。

## M6 老师在场 — 代码完成（自动化通过）（2026-11-17）

- 真实 GPU 帧率、所有者的观感和自带模型验收待核对。4 张旧立绘再分发许可等待确认，已从便携和容器构建中排除。原创 VRoid 支线按所有者验收独立推进。
- 已接入课堂和欢迎页的 3D 渲染、教学事件驱动的视线和作答反应、AudioWorklet `wlipsync` 实测口型及音量降级。角色库可导入本地 VRM、查看作者和许可、编辑人设与风格，并直达每位老师的语音设置。V1 角色 HTTP 路由已撤下。
- 运行时只写归一化骨骼，0.x 先翻转；已删除测试用 `dataset` 遥测和 VRMA 手臂轨道剥离。首帧前收臂，后台暂停；WebGL 上下文未恢复或持续低帧率会切换到本机截取的许可继承 2D 图。
- 类型检查、Lint、27 项前端测试和生产构建通过。Chrome 渲染 3 位自带 VRM、导入角色、移动布局、待机和 WebGL 丢失后的 2D 回退，并采集讲解、指向、答对和答错的实际场景。截图位于 `docs/rebuild/review/M6/`。初次目视检查发现指向和答错安慰动作比较细微，留待所有者核对动态观感。

## M7 学习闭环 — 代码完成（自动化通过）（2026-11-17）

- 完整的翌日学习体验、课堂内真人讲评和最终联调待验证。
- 已接入 FSRS、自评、题卡复做、错题筛选与隔日归档、课前热身、练习及限时模考、掌握度与时间和分值趋势、手动调整与版本重排。课程首页用一次批量读取展示今日可学或继续的课堂、到期复习数，以及有依据时的剩余天数和预计已保住分值。
- 旧对话自动化验证了所属课程隔离、仅授权访问及导出前后原记录不变。课堂回放复用实时白板的纯函数，打断后导出的笔记保留已播放内容。
- 今日课程汇总 API 的 6 项定向后端测试、前端 27 项测试、类型检查、Lint 和构建通过；Chrome 验证了课程首页的活动课堂继续入口，截图为 `docs/rebuild/review/M7/courses-today.png`。真实翌日回流与完整讲评仍属于所有者联调验收，不据此标记通过。

## M8 首次体验与发布 — 代码完成（自动化通过）（2026-11-18）

- 干净 Windows 或新系统用户的首课计时、公开发布与演示视频仍待所有者验收。单服务 Docker Compose 的配置通过。本机无可连接的 Docker 引擎，容器运行未验证。
- 原创概率摘录已用 GPT-6 Luna 分析、备课和自然结课。`content/sample-course/probability-basics/replay.json` 包含 83 条连续事件及一道单选的 A/B/C/D 四个真实反馈分支，保留课后小结和已复核教案。Chrome 在无 Key 环境回放、作答并到达课后小结，未产生 WebSocket 或业务写请求。
- 使用固定 Python 3.14.10 Windows 嵌入运行时重建便携包。已在新的隔离目录解压并从包内运行时启动，`/healthz`、欢迎页和数据库隔离检查通过。便携 ZIP 核验了校验和、目录内真实回放、说明文件与截图，并检查四张许可待核的历史立绘未入包。
- 本机同一 Windows 用户下实速计时，使用全新解压目录、数据目录和 Chrome 上下文，并禁止浏览器访问非回环地址。开始解压至首句 30.4 秒，至结课小结 78.0 秒。通过单选反馈和后续预录问题的继续动作。记录见 `evals/out/portable-first-course-r2.log`。
- 候选包 `outputs/rc1-20261118/Companion-Space-1.0.0-rc.1-windows-x64.zip`，105,870,155 字节，SHA-256 `f8ffc8fd4ad3b9918dfa0d3bab6fe72bf80006590f2f0352f5ba20f807c5c94a`。
- `Test-Path legacy` 返回 False。版本号为 `1.0.0-rc.1`，提供中英文启动和旧数据使用说明。

### 2026-11-18 集成复核

- 在 E 盘隔离短路径重新生成 OpenAPI。`scripts/gate.ps1 -Frontend -Contract` 最终通过，后端 443 项通过、2 项因 Windows 符号链接权限跳过，前端 27 项通过。Ruff、契约、防空壳、类型检查、Lint 和生产构建通过，记录见 `evals/out/final-gate-r2-20261118.log`。另核对包内 393 个应用、构建和内容文件与当前工作区逐文件一致。
- M8 回放测试每轮推进虚拟时钟后，React 才为下一条事件挂计时器。延长测试推进次数后真实 83 条事件到达小结。M4b、M5、M7 浏览器流程分别使用独立课例，M7 验证从课程首页打开未完课堂。
- Chrome 全套 10 项通过，记录见 `evals/out/final-chrome-r3-20261118.log`。调整截图等待动画展开后，M6 聚焦 3 项重新通过，记录见 `evals/out/final-chrome-m6-20261118.log`。
- M1 的真实连通和读图已实测。M2 样例质量、M3 访谈阈值、M4 独立评分、M5 现场语音、M6 视觉与许可、M7 所有者学习体验及 M8 干净环境和发布条件按各里程碑单独记录。

## 角色模块纯视频框重塑（V1 → V2 → V3） — 代码完成（自动化通过）（2026-11-19）

**待完成与待验证**

- **二次元角色美术素材与 8 段循环短片待生成**：当前内置 `tutor-echo`（沐音）与 `tutor-nova`（星澜）已具备 Apache-2.0 核验立绘（Tier 0 静态呼吸 + 语音动态光晕），但尚未合入正式批准的 8 段二次元 `.webm` 循环短片（Tier 1）。禁止使用色块或占位视频充当内置角色包；请通过 `tools/tutorpack/` 提示词/工作流或外部生图生视频工具生成素材后直接从 `/characters` 导入。
- **真实显卡模型联调与桌面视觉验收待执行**：`sidecars/local-gpu-avatar` 已提供 Apache-2.0 协议参考模板（`anime_2d_reference` 与 `gpu_bridge_template`），通过 ASGI 自动化测试验证了全链路协议；真实 RTX 显卡上的开源驱动（如 LivePortrait / Ditto / MuseTalk）挂载、真实帧率及浏览器桌面/手机端实机视觉验收留待所有者执行。
- **Tier 3 云端实时驱动仅预留护栏与设置位**：`LiveCostGuard`（30 秒静音自动挂起、单节时长与费用上限熔断）及设置页 `#avatar` 护栏表单已就绪，尚未接入任何特定付费云厂商实时视频 API。
- MIRA、KITE、CAEL、LYRA 四张历史立绘的公开发布许可仍待所有者核验，便携构建继续仅保留已核验立绘。

**已落地（V1 → V2 → V3）**

- **V1 3D VRM 退场与微信视频通话风格 `<TutorVideoBox>`**：
  - 将 3 个旧 VRM 模型与 `7-constraint`/`8-shino`/`9-fumiriya` 归档至 `assets-archive/retired-vrm/`，移除 `three` / `@pixiv/three-vrm` / `@react-three/*` / `wlipsync` 共 37 个前端 3D 依赖；生产包 `apps/web/dist` 经检索零 3D/VRM/wlipsync 残留，`classroom` 块降至 `29.92 kB`。
  - 重写 `packages/avatar-engine`（`types.ts`、`choreographer.ts`、`static-driver.ts`、`loop-pack-driver.ts`、`cost-guard.ts`、`sidecar-driver.ts`、`driver-manager.ts`、`video-box.tsx`），实现 9:16 竖屏纯视频框、双 `<video>` 180ms 交叉淡入淡出、缺槽回退链、15 秒静音自动进入安静陪伴、打断瞬间归位及 `prefers-reduced-motion` 降级。
  - 后端角色目录升级至 `schema_version = 3`（透明兼容旧 v2 读取、屏蔽已退场 VRM 但不删库、`resolve_active_character` 按 `tutor-echo → tutor-nova` 确定性回退），支持单张 PNG/JPG/WebP 秒建老师与 `.tutorpack`/`.zip` 安全校验导入（拦截 Zip-Slip、符号链接、Windows 保留名、可执行文件与伪造魔数）及 Range 206 流式访问。
- **V2 150ms 即时微动作反馈与二次元 `.tutorpack` 工具链**：
  - 课堂客观题提交后在模型生成前先下发 `judge.preview` 帧，配合快捷按钮本地即时触发点赞/鼓励/托腮/指白板，并透传 `recent_avatar_action` 避免语言重复。
  - `SpeechOutput` 移除 `wlipsync`，新增 24kHz PCM16 重采样回调 `onSpeechChunk`，为本地实时驱动预留低延迟音频输入。
  - 新增纯 Python CLI `tools/tutorpack/cli.py`（`scaffold` / `validate` / `pack`）、8 段二次元提示词模板与 ComfyUI 首尾帧锁定工作流模板；`/characters` 支持导出提示词与动作试演。
- **V3 本地 GPU Sidecar 协议代理、参考模板与 `#avatar` 设置页**：
  - 后端新增 `services/api/app/avatar/` 与 `/api/v2/avatar-drivers/*` 路由（设置持久化、回环优先 + 显式私网白名单校验、驱动探活、会话代理与 `TSVA`/`TSVF` 双向 WebSocket 桥接）。
  - 新增完全独立、Apache-2.0 许可的 `sidecars/local-gpu-avatar/` 模板工程（不污染主后端依赖，含 4 端点服务、`BaseAvatarRenderer` 抽象、2D 协议参考渲染器与本地 GPU 桥接骨架）。
  - 前端接入 `createSidecarConnector()` 到课堂 `<TutorVideoBox>` 与角色预览，新增「设置 → 视频形象（`#avatar`）」面板管理本地 Sidecar、测试连接与配置云端护栏，并在角色编辑器支持按角色绑定本地驱动。

**本地验证**

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 全绿：
  - Ruff 通过；后端 Pytest **451 通过、0 失败、2 跳过**（含 `test_tutor_catalog.py`、`test_avatar_drivers.py` 与 `test_avatar_asset_licenses.py`）。
  - OpenAPI 契约检查（`npm run generate:api:check`）与防空壳/中文文案长度扫描（`scripts/check_no_fakes.py`）通过。
  - 前端 `tsc --noEmit`、`eslint`（React 19 规则）、Vitest **7 文件 32 项通过**、`vite build` 922ms 通过。
- 独立 Sidecar 测试 `.venv\Scripts\python.exe -m pytest sidecars/local-gpu-avatar/tests -q`：**2 通过**；`ruff check tools/tutorpack sidecars/local-gpu-avatar` 全绿。
- 生产构建产物 `apps/web/dist/assets/*.js` 零 `three-vrm`/`wlipsync`/`VRMLoaderPlugin` 引用。

### 2026-11-20 六位原创二次元老师锚图上线与专属视频提示词

- 已将所有者原创的六位 9:16 竖屏二次元老师（`雪川`、`沈砚`、`岚玥`、`初棠`、`青衡`、`澜音`）1080×1920 WebP 锚点图合入 `assets/avatars/portraits/` 与 `content/characters/`，并逐一登记 SHA-256 与 Apache-2.0 许可至 `assets/avatars/LICENSES.md` 和 `assets/THIRD_PARTY_NOTICES.md`；旧六张立绘（含原四张许可待核历史立绘）归档至 `assets-archive/retired-portraits/`，便携包构建脚本现可完整分发全部六位内置老师。
- 强化 `<TutorVideoBox>` 顶部状态栏与底部字幕条深色保护渐变（`classroom.css`），提升雪川、岚玥等亮色系角色的字幕可读性；`resolve_active_character` 回退序升级为六位新内置角色，旧数据库中的 `tutor-echo` / `tutor-mira` / 退役 VRM 均无缝确定性回退至 `tutor-chutang`。
- 在 `tools/tutorpack/prompts/characters/` 与 `outputs/数字人角色锚图-20261119/六位角色-8段视频专属提示词/` 交付 6 份中英双语、针对龙角/竹簪/发卡/曝光/肤色防穿模定制的 8 段图生视频提示词，同步接入 `/characters` 页面的「导出 8 段二次元短片提示词」按钮。

### 2026-11-21 六位内置老师全套 8/8 Tier 1 动态短片包与声音克隆干声上线

- 接收所有者本地 MiniMax H3-Base（`H3-Base-FL2VA`）生成的 24 条分段视频（`480×864 @ 24fps`，含 6 条 32 kHz 棚录人声），逐帧抽检全部 6 位老师画面无穿模后，按锚点加权相似度自动定位最佳切点并加入 6 帧余弦锚点柔化过渡，批量转码为 **48 段无声 VP9 `.webm`（总计 48.88 MB，全员 8/8 槽位完整）**，安装至 `assets/avatars/packs/tutor-{xuechuan,shenyan,lanyue,chutang,qingheng,lanyin}/`（均通过 `tools/tutorpack/cli.py validate` 校验，并导出 6 个便携 `.tutorpack` 至 `outputs/`）。
- 同步从 6 位老师的 `partA-seg2` 原生 32 kHz 立体声音轨裁切静音并峰值归一化至 `-1.5 dBFS`，生成 6 份 6.7–7.2 秒无 BGM 纯干声参考 WAV（`assets/avatars/voices/*-ref-24k.wav` 及 `outputs/.../六位老师声音克隆参考音/` 32 kHz 版）与 `voices_manifest.json`，可直接接入 GPT-SoVITS / CosyVoice / FishSpeech / Qwen3-TTS 替换 Edge 语音。
- 全部 54 个新增视频/锚图文件与 6 个声音参考文件均已在 `assets/avatars/LICENSES.md` 与 `assets/THIRD_PARTY_NOTICES.md` 登记为项目原创 Apache-2.0 资产；后端目录启动即自动发现并默认启用 Tier 1 `loop_pack`。

## 体验重塑

### 体验重塑 U0 — 代码完成（自动化通过）（2026-11-22）

**怎么验收**

- 前端生产产物 `apps/web/dist` 已在最后一次代码改动后通过完整门禁重新构建（771ms），启动后直接看到最新界面。
- 启动方式：
  - 使用日常真实数据：双击 `start.bat`。
  - 使用全新隔离数据（不触碰真实数据）：运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-review.ps1`。
- U0 所有者验收清单（共 7 项）与离线截图对照（全部位于 `docs/rebuild/review/U0/`）：
  1. 课上故意答错、再点「没听懂」均不做点赞，而是安抚动作：**需要真实 AI 服务**；离线先看 `62-lesson-verdict-incorrect.png`（答错安抚）与 `61-lesson-confused-comfort.png`（没听懂安抚）。
  2. 第一次进入新课，老师画面不再写「已暂停」而是「等你上课」：**无需 AI 服务**；另见 `45-lesson-prestart.png`。
  3. 新建空课展开「学习设置」并跳过访谈，摸底显示「读完资料后开放」；上传资料分析完成后摸底题出现：前半**无需 AI 服务**（见 `42-empty-course-placement-wait.png`），后半分析完成出现摸底题**需要真实 AI 服务**。
  4. 无计划课程在课程列表显示「尚未生成学习计划」，不再显示「今天的计划已完成」：**无需 AI 服务**；另见 `05-courses-list.png`。
  5. 浏览器标签页显示临时品牌图标（`apps/web/public/favicon.svg`），课程 / 老师 / 设置各页标签页标题各不相同：**无需 AI 服务**。
  6. 地址栏输入不存在路径，显示「这一页不存在」并提供「回到课程列表」按钮：**无需 AI 服务**；另见 `73-not-found-404.png`。
  7. 画不出来的图提示为中文「这张图没画出来」：**无需 AI 服务**；直接查看 `60-board-blocks-full.png`。
- 压力内容与手机视口对照截图（供核对观感五问）：`05-courses-list.png`（3+ 门课 + 空课 + 41 字课程名）、`40-stress-course-map.png` / `41-stress-course-map-full.png`（66 知识点地图）、`43-stress-lesson-question.png` / `44-stress-lesson-question-full.png`（37 字课题 + 22 行长公式白板 + 三行题干 + 6 个长选项）、`74-m-welcome.png` 至 `86-m-lesson-question-full.png`（390×844 手机宽度）。

**待完成与待验证**

- **所有者手工验收与真实模型核验未做**：清单第 1 条（真实 AI 课堂答错/没听懂）与第 3 条后半（真实资料分析完成后摸底开放）、其余手工点检项以及观感五问仍待所有者验收确认；确认通过前不启动 U1。
- **设计系统规格 §12（25 条完成定义）逐项核对（U0 仅止血不换肤）**：
  - 本里程碑已达标或推进：第 15 条（补齐了此前被吞掉的错误态与重连死胡同）、第 16 条部分（五处后端路由 + 视频降级 + 白板失败改为错误码与中文文案，尚缺统一「发生了什么+怎么做+可展开详情」错误组件）、第 20 条（修复首次未开课、思考姿态、答后讲评期状态标签与动作覆盖错误）、第 24 条部分（补齐每路由标题、切页聚焦 `<h1>` 与滚回顶部）。
  - 尚未达标（按计划归属 U1–U7）：第 1–5 条（按下缩放、延迟加载指示、同形骨架、按钮转圈、toast → U1）、第 6–9 条（动效 token 与减少动态效果按组件降级 → U1/U2a）、第 10–14 条（新间距/圆角/六档字阶/等宽数字/40px 目标/单主按钮 → U1–U3）、第 17–19 条（自定义确认框/下拉/进度条/音频条、学生词表术语清理 → U1/U7）、第 21–23 条（字幕两行限制、片段预取无黑帧、提示音 → U2a/U2b/U6）、第 25 条（八组老师主题色与对比度单测 → U1）。

**已落地**

- **入口与约定（任务 1）**：向根目录 `AGENTS.md` 追加四段 U 阶段约定原文，并在 `PROGRESS.md` 开设「体验重塑」章节；首次先行单独提交了计划书、规格与参考样张（`f814f14`）。
- **工具与压力内容夹具（任务 2）**：新增纯 ASCII 启动脚本 `scripts/start-review.ps1`、原生下拉封装 `tests/e2e/helpers.ts`、自举夹具服务（端口 8732）与失败非零退出的巡览脚本 `tests/e2e/ui-tour.mjs` 及 `npm run review:tour`；在 `services/api/tests/fakes/e2e.py` 与 `e2e_server.py` 登记空课程、66 知识点压力课程、22 行长公式+6 长选项压力课及独立不变量课堂场景。
- **E2E 定位迁移与体验不变量（任务 3–4）**：`tests/e2e/m1–m8` 全部移除 CSS 类定位器与旧类不存在断言，改用角色/名称、`data-testid`、`data-*` 状态属性及 `helpers.ts` 的 `pick`；新增 `tests/e2e/ux-invariants.spec.ts` 覆盖 I1、I2（全 18 个路由含空课与压力课）及 I9 前半（答错、我不会、没听懂、给点提示）。
- **形象与状态止血（任务 5）**：`feedback_reaction` 不再覆写为表扬片段（`choreographer.ts` / `loop-pack-driver.ts`，托腮保持循环记入 `DECISIONS.md`）；`lesson-state.ts` 新增纯函数 `resolveClassroomDisplay` 与 `isSubmissionLocked`，修复首次进课显示「等你上课」、思考时不播讲话姿态、提交/判题后不回显「等你回答」、仅在新 `ask` 到达时清空 `judge`、以及收到错误事件后立即解锁题目表单。
- **样式清理与自定义属性检查（任务 6）**：定义 `--surface-soft` 与 `--panel`，删除经 grep 核实无引用的旧类与 `packages/board/board.module.css` 死规则，合并重复的窄屏媒体块；新增前端单测 `apps/web/tests/styles-tokens.test.ts`（I4 第一部分）。
- **英文与原文残留清理（任务 7 / B10 U0 部分）**：白板失败与原页图替代文本改为中文（同步更新 `m4b.spec.ts`）；新增 `apps/web/src/features/plan/item-kind.ts` 集中计划项类型判断与本地化标题；视频降级原因改为 `VideoDriverDegradedCode` 错误码映射；访谈、摸底、练习讲评、模型连接与角色导入五处后端补齐错误码（`CodedValueError`）并由前端 `zh-CN.json` 映射。
- **吞掉的错误、死胡同与无计划文案（任务 8–9）**：练习保存失败改为就近 `<Problem onRetry>` 可重试；资料修改、分析重试、跳过访谈、结束摸底、计划调整与课程仪表盘错误全部可见；课程地图区分「尚未生成」与「请求失败」；课堂断线后「继续课堂」按钮恢复可点击并重连清零计数，且沿用上次语音/文字方式；后端 `CourseDashboard` 新增 `has_plan` 字段，无计划课程显示「尚未生成学习计划」。
- **摸底不被永久跳过（任务 10 / B3）**：资料未读完或无诊断题时返回 `status="unavailable"` + `unavailable_reason`，不再持久化为 `skipped`，兼容唤醒历史 `skipped` 记录并新增 `POST /api/v2/courses/{course_id}/placement/restart`；资料分析完成自动失效摸底缓存；未读完资料显示「读完资料后开放」。
- **按钮语义、文档层与数据新鲜度（任务 11–13）**：禁用按钮光标改为 `not-allowed`，进行中按钮增加 `aria-busy` 与 `progress` 光标；新增临时品牌图标 `apps/web/public/favicon.svg`、全路由独立 `document.title`、切页滚顶并聚焦 `<h1>`、404 页、保留顶栏导航的路由级 `ErrorBoundary` 与子页父导航高亮；React Query 对非 4xx 查询默认重试 1 次（修改不重试）；课堂收到小结时使课程、计划与进度缓存失效。

**本地验证**

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 全绿：
  - Ruff 检查通过；后端 Pytest **453 通过、0 失败、2 跳过**（Windows 符号链接权限跳过；含新增 B3 测试与仪表盘 `has_plan` 回归，并放宽了 `test_m5_live.py` 预备下一拍轮询上限以消除 Windows 0.55s 偶发超时）。
  - OpenAPI 契约检查（`npm run generate:api:check`）与防空壳/中文文案扫描（`scripts/check_no_fakes.py`）通过。
  - 前端 `tsc --noEmit`、`eslint`、Vitest **8 文件 36 项通过**（含新增动作-片段对应、判定清空、出错解锁与自定义属性检查）、`vite build`（771ms）通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**13 项全部通过**（`m1`–`m8` 迁移后全绿，`ux-invariants.spec.ts` I1 / I2 / I9 前半全绿）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U0`：**40 步通过、0 失败**，产出 86 张截图至 `docs/rebuild/review/U0/`，并已人工抽检关键截图与压力内容截图。

### 体验重塑 U1 — 代码完成（自动化通过）（2026-11-22）

**待完成与待验证**

- **所有者视觉与字体拍板未做**：组件陈列页（`npm run review:gallery -- --serve`）的「打包字体 / 系统字体」二选一（默认决定 D1）、版式样板确认、八组老师主题色观感以及 U1 观感五问仍待所有者在自己的显示器上确认。
- **按计划留待 U2a–U7 的条目**：课堂一屏视频通话布局与控制坞（U2a）、候课与韧性（U2b）、今天页与五步准备旅程（U3）、老师画廊与 6 音色（U4）、手写 SVG 图表与闭环可视化（U5）、白板逐行书写与手机通话布局（U6）、设置分区与默认界面术语清理及删除 `legacy` 层（U7）。

**已落地**

- **依赖核对与字体自托管（任务 1、4）**：锁定 `@base-ui/react@1.9.0`（MIT）、`lucide-react@1.77.0`（ISC）、`clsx@2.1.1`（MIT）、`@fontsource-variable/geist@5.3.0`（OFL-1.1）与 `@fontsource-variable/noto-sans-sc@5.3.1`（OFL-1.1）；React 保持 `19.2.9`；编写 `scripts/generate-fonts-css.mjs` 生成并提交 `apps/web/src/styles/fonts.css`（`font-display: fallback`）及空闲预取 `prefetch-fonts.ts`；将两份 OFL-1.1 许可全文放入 `assets/fonts/LICENSES/`、登记至 `assets/THIRD_PARTY_NOTICES.md` 并接入 `scripts/build-portable.ps1`；记录所有决策与 Tailwind v4 token-to-utility 命名规范至 `DECISIONS.md`。
- **样式层序、完整 Token 与全站换肤（任务 2、3、10）**：建立 `@layer theme, base, legacy, components, utilities;` 层序，实现 `theme.css`（书桌、舞台、书桌纸面与舞台纸面全套语义 token 与状态色、八组老师主题色、六档字阶、圆角/阴影/动效/层级/断点）与 `base.css`（元素默认、过渡期原生表单统一样式、路由淡入及各组件独立 `prefers-reduced-motion` 降级）；将全部 6 个既有全局 CSS 文件包入 `@layer legacy`、消除 `!important`、移除 `--serif` 与不存在的 `650`/`750` 字重。
- **老师主题色与后端缺省合并（任务 9 / B8 U1）**：`Character` 与 `TutorUpdate` 增加 `theme` 字段，为六位内置老师设置专属主题色并在读取时对旧安装做无覆盖缺省合并（同步补后端测试与 OpenAPI 契约）；前端 `useTutorThemeSync` 同步根节点主题变量；`tutor-themes.test.ts` 覆盖全部 8 组主题及 4 套表面的 WCAG 对比度（≥ 4.5:1 / ≥ 3:1）与 6 位内置老师两两 OKLab 区分度（≥ 0.07）。
- **图标与品牌资产（任务 5）**：新建 `apps/web/src/ui/icons.tsx` 统一导出描边图标、`BrandMark` SVG 与无障碍 `DifficultyDots`；更新 `favicon.svg`、生成 180×180 `apple-touch-icon.png` 并对齐 `theme-color`；全站替换所有字符图标（`✦ ▷ → ↗ ＋ ✓ ●○ + − /`）。
- **组件库与陈列页（任务 6）**：在 `apps/web/src/ui/` 落地全部 23 个 U1 基础组件并配套 `ui-components.test.tsx` 行为单测；在 `apps/web/tests/ui-gallery/`（不进生产构建）搭建包含对比开关（字体/主题色/三表面）、全部组件状态与七类版式样板的组件陈列页，新增 `npm run review:gallery`。
- **书桌外壳与全站反馈替换（任务 7、8）**：新建 `apps/web/src/shell/AppShell.tsx`（品牌 SVG、带图标的「课程 / 老师 / 设置」导航、「只在本机运行」状态点、手机端底部标签栏、路由淡入），移除顶栏「试聊」并在设置页顶部提供入口；全站 5 处 `window.confirm` 全部替换为 `ConfirmDialog`（默认聚焦安全按钮），`.form-success` 替换为就近确认 + `toast.success`，pending 文案三元表达式替换为 `<Button pending>`，`Loading`/`Problem` 底层切换为延迟 `DelayedSkeleton` 与 `ErrorState`。
- **机器检查与不变量（任务 11、12）**：`styles-tokens.test.ts` 新增 I4 第二部分（十六进制颜色只减不增遗留白名单、禁止 `transition: all` / `!important`、层序校验）；`ux-invariants.spec.ts` 新增 I3（无原生弹窗）与 I5（保存触发可自动消失的 `role="status"` toast）；同步更新 `m1`、`m5` 与 `ui-tour.mjs`。

**本地验证**

- `scripts/gate.ps1 -Frontend -Contract` 全绿：Ruff clean、Pytest **454 通过 / 2 跳过**、`generate:api:check` 与 `check_no_fakes.py` 通过、`tsc` / `eslint` 通过、Vitest **10 文件 52 项通过**、`vite build` 886ms 通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**15 / 15 全部通过**（含 I1–I5、I9）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U1`：**40 步通过、0 失败、87 张截图**输出至 `docs/rebuild/review/U1/`；`npm run review:gallery -- U1` 输出 7 张陈列页与字体对比截图至 `docs/rebuild/review/U1/gallery/`，并已人工抽检视觉效果（同时顺手修复了深色舞台下 `--accent-strong` / `--accent-soft` 的对比度适配）。

### 体验重塑 U2a — 代码完成（自动化通过）（2026-11-22）

**待完成与待验证**

- **真实 AI 课堂与真实麦克风验收未做**：U2a 所有者验收清单第 4–9 条（用真实资料上完整一节有长选项题的课、按住麦克风/免提说话与音量响应、真实换讲法）及课堂纸面亮度拍板（暗一档防夜间刺眼）与 U2a 观感五问仍待所有者核对。
- **按计划留待 U2b / U6 的课堂条目**：候课面板、备课等待与接通过渡（U2b）、顶栏要点进度与已上时长（U2b）、片段空闲预取与解码首帧后再切换（U2b）、无上限指数退避重连与接管（U2b）、示例课与回放接入舞台（U2b）、多步推导逐行显现/标记三样式/清板分页/对话记录完整抽屉/手机双模式通话布局/提示音（U6）。

**已落地**

- **课堂外壳与一屏零滚动（任务 1、10）**：新增 `apps/web/src/shell/StageShell.tsx` 与 `stage-shell.css`（`100dvh` 三行网格：48px 顶栏 / 左右双列主区 / 76px 控制坞，容器查询覆盖 1280×585–1440×900 与超矮视口自动角窗、390×844 手机单列竖屏视频与底部控制坞）；将 `/lessons/:lessonId` 移出 `AppShell`（不再渲染站点导航）；结课后过渡至浅色专注容器 `RecapView`（允许纵向滚动）。
- **显式相位状态机与思考姿态（任务 2、3）**：新建纯函数 `lessonPhase()` 与 `resolvePhasePose()`（`apps/web/src/features/classroom/lesson-phase.ts`），16 个显式相位覆盖 `loading` 至 `failed`、`judging` 20 秒超时保护、`audioSpeaking`/`audioBuffering` 分离、以及 30 秒切标签页自动恢复/暂停规则；在 `packages/avatar-engine` 新增 `"thinking"` 姿态、`phaseToTutorPose()` 统一编排映射（替代孤立 `reduceChoreographer`）、循环短片档语音光环、以及向本地实时驱动发送姿态时把 `"thinking"` 映射到协议既有取值；`TutorVideoBox` 改用 `useLayoutEffect` 同步姿态与片段属性，消除思考相位下短时残留讲话片段的竞态；将 `video-box.css` 从 `classroom.css` 迁出并把 `classroom.css` 移出十六进制遗留白名单。
- **舞台叠层、文字上课与音量链路（任务 4、5、8）**：`TutorVideoBox` 叠层精简为左上状态标识（含声波条/转圈/三点跳动）与底部两行限宽字幕，档位与延迟收进顶栏「画质与性能」浮层，降级原因改为 toast 提示；文字上课左侧下方新增「老师刚才说的」只读滚动记录与「等一下 / 下一句」节奏控制；`SpeechOutput` 在 `AnalyserNode` 之后增加 `GainNode` 支持实时音量调节与静音（驱动形象的语音电平取自增益前），并记住每节课的字幕开关与音量。
- **白板、作答托盘与控制坞（任务 6、7、8、9）**：新增 `ChoiceCard` / `ChoiceCardGroup`、`Slider`、`LevelMeter` 三个组件；`packages/board` 渲染失败改为中文「这张图没画出来」+ 折叠「查看原始内容」；实现 `BoardPanel`（开场封面、自动跟随 + `ResizeObserver` 托盘伸缩重跟、手动上滚暂停与「回到最新」未读计数、阶段与换讲法/回补分节线、已作答卡片、纸面表格样式）、`AnswerTray`（三段固定布局、`min(60%, 100%-160px)` 高度上限、选项卡片七态、A–H/1–9 快捷键与回车提交、预填提示、20 秒判题超时解锁、看答案规则提示）与 `ControlDock`（单行三组、≥ 44×44 目标、容器查询折叠芯片、固定占位打断、按住/空格说话脉动外环、讲法与快慢浮层、应用内下课/离开确认框）。
- **测试与巡览（任务 11、12）**：补齐 `lesson-phase.test.ts`、`board-follow.test.ts`、`audio.test.ts`（音量/静音）、`board.test.tsx`、`ui-components.test.tsx` 单测；更新 `m4b`、`m5`、`ui-tour.mjs`（新增 1280×720 压力课长白板与 6 长选项截图）；`ux-invariants.spec.ts` 新增 **I6、I7、I8、I9（U2a）、I10**。

**本地验证**

- `scripts/gate.ps1 -Frontend -Contract` 全绿：Ruff clean、Pytest **454 通过 / 2 跳过**、`generate:api:check` 与 `check_no_fakes.py` 通过、`tsc` / `eslint` 通过、Vitest **12 文件 63 项通过**、`vite build` 通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**18 / 18 全部通过**（含 I1–I3、I5–I10）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U2a`：**40 步通过、0 失败、88 张截图**输出至 `docs/rebuild/review/U2a/`；实测 1440×900、1280×720 压力课与 390×844 手机课全部活动相位均无页面滚动条；人工抽检桌面与手机截图并修复了顶栏右对齐、带图标徽标折行与手机控制坞 `hidden`/`inline-flex` 优先级冲突。

### 体验重塑 U2b — 代码完成（自动化通过）（2026-11-22）

**待完成与待验证**

- **真实 AI 备课与真进程重启实测未做**：U2b 所有者验收清单第 2–5 条（用真实 AI 备第三节或按知识点开课、真实关掉 `start.bat` 命令行窗口 5 秒后重启并观察自动续接或重新解锁）以及联网环境下示例课走在线老师语音的听感与 U2b 观感五问仍待所有者在真实环境核对。
- **按计划留待 U3–U7 的条目**：课堂外统一老师语音接口 B13 替换示例课试听通路（U3）、课后小结 B2 重做（U3）、今天页与五步准备旅程（U3）、老师画廊与 6 音色（U4）、手写 SVG 图表与复习闭环（U5）、白板逐行书写与手机通话布局（U6）、设置分区与全站术语清理（U7）。

**已落地**

- **候课与备课后端（任务 1 / B12）**：先补齐 `services/api/tests/test_u2b_lobby_resilience.py` 测试，新增 `POST /api/v2/courses/{course_id}/point-plan-items`、`POST /api/v2/plan-items/{plan_item_id}/prepare`（幂等且不返回百分比）与 `GET /api/v2/plan-items/{plan_item_id}/prepare-status` 三个接口；扩展 `locate_teachable_plan_item` 覆盖生效计划与按知识点临时计划；既有 `POST /courses/{course_id}/lessons` 与 `POST /plan-items/{plan_item_id}/lesson` 保持原语义并在备课冲突时返回结构化 `409 lesson_preparing`；夹具新增「尚未备好的课」（`browser-unprepared-item`）与热身闪卡。
- **课堂视图与接管后端（任务 2、5 / B1、B14、B10 U2）**：`LessonView` 新增只读字段 `est_minutes`、`outline`、`progress`、`style_id`、`active_ms`，实时状态事件补充 `kp_cursor` 与 `style_id`；WebSocket `/api/v2/lessons/{lesson_id}/live?takeover=1` 支持接管旧连接（以 `4409 taken_over` 关闭旧端，不带参数返回 `4409 other_tab`）；课堂内全部错误统一走结构化错误码与中文文案映射；修复 Python 3.14 / AnyIO 下 `LiveLesson.run()` 清理分支的 `CancelledError` 传播问题；核实并测试了后端进程重启在无主密码与有主密码两种模式下的课堂恢复路径（写入 `DECISIONS.md`）。
- **候课面板、开场封面与接通过渡（任务 1–3）**：新增 `/plan-items/:itemId/lesson` 候课路由与 `LessonLobby`（大号老师视频框、课题与预计时长、要点列表、无百分比已等待计时、可跳过且≤5张的嵌入式热身复习卡、声音试听、无语音识别提示及新标签页去设置、回车开课、340ms 接通过渡、重排后条目失效自动回退）；全站所有「开始上课」及按知识点开课入口统一改走候课路由，旧 `?plan=` 地址自动重定向；白板开场页接入真实课题与要点列表，课堂顶栏接入分段要点进度、`要点 k/N` 与实时已上时长，讲法菜单同步后端 `style_id`。
- **片段空闲预取与无黑帧切换（任务 4）**：`LoopPackVideoDriver` 实现空闲批量预取与新片段解码首帧（`loadeddata`/`canplay`）后再淡入切换，保留过期 `gen` 指令丢弃；`avatar-runtime.test.ts` 补齐 9 项单测覆盖。
- **断线重连与接管交互（任务 5）**：课堂采用无上限指数退避重连（上限 15 秒）+ 舞台遮罩 + 「立即重试」，重连前自动探测 `bootstrap` 区分无密码自动续接与主密码锁定（显示「去解锁」），并支持双标签页「在这里继续」接管与「已在别处继续」提示。
- **示例课与课程回放迁入舞台外壳（任务 6）**：新增 `ReplayStage` 与纯函数时间轴 `replay-timeline.ts`，`/sample-lesson` 与 `/lessons/:lessonId/history` 共用 `StageShell` 与 `<TutorVideoBox>`（回放事件驱动姿态、按 `mm:ss / mm:ss` 拖动进度、倍速、字幕开关、下载白板）；示例课顶栏常驻「预生成内容 · 可离线回放」，交互分支改用 `ChoiceCardGroup`，按 D11 逐句试听合成并在离线时标注「浏览器朗读」。
- **测试与巡览（任务 7、8）**：更新 `m8.spec.ts`（符合 I11）、`ux-invariants.spec.ts`（新增 **I11**、候课备课到就绪与 WS 服务端主动断线无刷新重连恢复 E2E 用例）与 `ui-tour.mjs`（新增候课备课中/就绪截图）。

**本地验证**

- `scripts/gate.ps1 -Frontend -Contract` 全绿：Ruff clean、Pytest **460 通过 / 2 跳过**（含新增 6 项 U2b B1/B12/B14/重启恢复测试）、`generate:api:check` 与 `check_no_fakes.py` 通过、`tsc` / `eslint` 通过、Vitest **12 文件 65 项通过**、`vite build` 通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**21 / 21 全部通过**（含 I1–I3、I5–I11、候课备课流与 WS 无刷新重连恢复）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U2b`：**41 步通过、0 失败、90 张截图**输出至 `docs/rebuild/review/U2b/`；人工抽检候课（备课中/就绪）、课堂顶栏要点进度、历史回放与示例课截图，并顺手修复了候课备课中视频左上角状态徽标文案过长截断的问题。

### 体验重塑 U3 — 代码完成（自动化通过）（2026-11-22）

**待完成与待验证**

- **真实 AI 资料阅读、访谈、摸底与结课实测未做**：U3 所有者验收清单第 2、5–8、11 条（使用真实 AI 密钥走完新用户四步引导 → 拖资料自动读 → 访谈/摸底/计划揭示 → 真实上一节课并核对课后小结与今天页刷新）、填框计数统计以及 U3 观感五问与截图评审（`docs/rebuild/review/U3/`）仍待所有者核对。
- **按计划留待 U4–U7 的条目**：老师画廊与 6 位内置老师互异音色/个性化问候/全站老师在场（U4）、今天页「这一周」与进度/地图/计划差异/复习答后反馈/练习重做（U5）、白板逐行书写/对话记录抽屉/手机通话布局/提示音（U6）、设置分区与全站术语清理及删除 `legacy` 层（U7）。

**已落地**

- **后端 B9 / B15-仪表盘 / B4a / B2 / B13**：
  - 新增 `services/api/app/learning/journey.py` 与 `GET /api/v2/courses/{course_id}/journey`，返回五步状态、`next_step`、`all_done`、`exam_passed` 等并内嵌至 `CourseDashboard`；设置接口新增 `onboarding_completed_at`（已有课程自动视为已完成引导）。
  - `CourseDashboard` 补充 `target_score`、`exam_name`、`exam_date`、`today_practice`（`kind != 'lesson'`）、`today_lesson_why`、`lesson_index`、`lesson_total`，保留 `today_lesson` 既有语义。
  - `create_plan` 与 `rebuild_course_plan` 均持久化 `deferred_weight`、`over_capacity`、`capacity_minutes`，读取计划时补齐知识点名、重点标记与前置标记（旧计划缺键返回 `None`）。
  - `finish_lesson` 写入 `review_cards_created`；新增只读 `GET /api/v2/lessons/{lesson_id}/recap-summary` 汇总统计、掌握度课前→课后变化、下一节、计划变动与中途放弃标记。
  - 新增 `POST /api/v2/voice/speak` 并把 `/api/v2/voice/preview`、`/api/v2/tts/preview` 统一到同一课堂语音核心（B13）；预设补齐 `key_guide` 拿密钥指引。
- **前端外壳、新原语与就绪向导**：
  - 新增 `FocusShell`；`AppShell` 导航升级为「今天 / 课程 / 老师 / 设置」，标志指向 `/`，右上状态点接入 `useReadiness` 五项就绪态；新增 `Stepper`、`FileDropzone`、`Tabs`/`RouteTabs`、`SecretInput`、`Checkbox`、`Combobox`，并提升浮层层级至 `--z-popover: 45` 修复对话框内下拉遮挡；`Card` 与 `Badge` 补全移动端截断保护防止超长课程名撑破 390px 视口。
  - 实现四步 `ConnectWizard` / `ConnectWizardDialog`（筛选 → 拿密钥指引 + 粘贴密钥 → 逐项测试 + 取消 → 就绪总览），并接入引导第 3 步、今天页、课程准备与课程中枢；设置页新增 `#me` 学习者画像表单。
- **全主线界面与课后小结**：
  - 新建 `/` 今天页（首次检查清单模式 + 主动学习模式 + 其他课程）、4 步首次引导 `/welcome`（称呼规则 D3 与泛称代词兜底）、过渡期 `/tutors`、卡片化 `/courses`（新建/改名/删除 B11）、7 标签 `CourseHubLayout`（今日四态、课程设置对话框、资料管理与真题区、地图 D5 降级入口）、5 步 `CourseSetupPage`（无 AI 可先传资料、4 大阶段阅读进度与耗时估算、6 主题结构化访谈与已知项确认 E8 + 离线固定问句、资料未读完锁定摸底、计划揭示页）、基础版 `PlanPage`（按周分组、权重与掌握度双横条 + §7.1 理由句、置顶/顺延、暂缓区）以及 B2 `RecapView`（统计、掌握变化与「再讲一遍」、计划变动提示、中途放弃分支与白板下载）。
- **测试、巡览与目视打磨**：
  - 新增 `test_u3_journey_and_speech.py` 与 `u3-journey.test.ts`，扩充 `ui-components.test.tsx` 覆盖 6 个新原语；按新结构更新 `m1`、`m2`、`m3`、`m5`、`m7`、`m8` 与 `ui-tour.mjs`，在 `ux-invariants.spec.ts` 新增 **I12、I13**。
  - 人工抽检 `docs/rebuild/review/U3/` 桌面与手机截图后，修复了访谈选项卡隐藏英文键圆标（`ChoiceCard showKey={false}`）、`FocusShell` 顶部五步标签不截断、访谈视频去技术浮标、以及首页称呼泛称「你」兜底四处观感细节。

**本地验证**

- `scripts/gate.ps1 -Frontend -Contract` 全绿：Ruff clean、Pytest **464 通过 / 2 跳过**、`generate:api:check` 与 `check_no_fakes.py` 通过、`tsc` / `eslint` 通过、Vitest **13 文件 75 项通过**、`vite build`（1.20s）通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**23 / 23 全部通过**（含 I1–I3、I5–I13）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U3`：**39 步通过、0 失败、92 张截图**输出至 `docs/rebuild/review/U3/`。

### 体验重塑 U4 — 代码完成（自动化通过）（2026-11-22）

**待完成与待验证**

- **在线 Edge 语音逐一试听与所有者观感验收未做**：U4 所有者验收清单第 1–8 条中涉及真实在线试听 6 位内置老师互异音色、画廊悬停/选中编排的真实动感、修改音色后进课堂对比听感以及 U4 观感五问与截图评审（`docs/rebuild/review/U4/`）仍待所有者核对。
- **按计划留待 U5–U7 的条目**：手写 SVG 图表、计划变化清单、地图两视图、进度方格图、复习答后反馈、练习一题一屏与课程记录时间线（U5）；白板逐行书写、对话记录完整抽屉、提示音与手机双模式通话布局（U6）；设置分区、术语巡览清零、删除 `legacy` 层与发布材料（U7）。

**已落地**

- **后端角色资料与恢复默认（B8 U4）**：
  - 六份内置角色清单（`content/characters/{1..6}-*.json`）按任务单附录 A 补齐一词气质 `tagline`、问候语 `greeting` 与短场合台词 `lines`（早/午/晚/候课/空态），并将澜音默认音色改为 `zh-TW-HsiaoChenNeural` 实现六位老师两两互异。
  - `services/api/app/services/tutor_catalog.py` 扩展 `Character` 与 `TutorUpdate`（支持完整局部更新、`voice` 更新及 `_edited_fields` 追踪，未传 `preferred_tier` 时保留 `_tier_explicit`），对旧数据库安装执行无覆盖缺省合并；新增 `POST /api/v2/characters/{character_id}/reset` 恢复内置角色默认并清理 `voice_settings.characters` 覆写；新增 4 项后端单测 `services/api/tests/test_u4_tutors.py`（断言六位音色两两互异、局部更新保留档位、旧安装合并与恢复默认）并重新生成 OpenAPI 契约。
- **同屏单视频协调器（I16）**：新增 `packages/avatar-engine/src/video-coordinator.ts` 接入 `LoopPackVideoDriver`（含 `IntersectionObserver` 离屏暂停与 `visibilitychange` 后台暂停）与画廊悬停循环预览；在 `apps/web/tests/avatar-runtime.test.ts` 新增单视频抢占单测。
- **老师画廊、三标签详情页与三步导入向导**：
  - 按 `tutors.html` 落地 `/tutors` 画廊（`TutorShowcase` 展示区 + 选中编排：问候 → 讲解与 B13 台词朗读 → 点赞 → 待机 + 「TA 会这样教你」+ 三动作试演 + 「就选 {name}」问候回应；`TutorRoster` 7 列同排竖卡、各自老师主题色描边与色点、悬停待机循环与拖放「＋ 导入角色」卡）；首次引导第 1 步复用同一套展示组件。
  - 落地 `/tutors/:tutorId` 三标签页（`认识 TA`、`调整人设` [芯片标签输入、10 组精选 Edge 中文音色 + 试听 + 语速滑杆、自定义 8 色主题色板、不提交 `preferred_tier` 的局部更新、内置 `恢复默认` 与自定义 `删除角色` 确认框]、`形象与素材（高级）` [形象效果、8 槽短片完整度、本地驱动、导出 8 段提示词与许可信息]），以及三步 `ImportTutorWizardDialog` 导入向导；`/characters` 重定向至 `/tutors`，移除过渡页 `tutors-legacy.tsx` 与旧 `characters/library.tsx`。
- **全站老师在场（E1）与目视打磨**：
  - `AppShell` 顶栏新增当前老师小卡（直达 `/tutors`）；今天页、课程列表、课程中枢、复习页、记录页、404 页接入老师第一人称问候与带立绘的空状态；解锁页 `UnlockSession` 改为脱离站点导航的 `FocusShell` 专注壳 + 老师立绘 + `SecretInput`。
  - 人工抽检 `docs/rebuild/review/U4/` 后，修复了 `theme.css` 混用 `px`/`rem` 导致 `lg:grid-cols-7` 未生效的问题（统一改为等价 `rem`），修复 `Tabs` 选中态属性与下划线、`Chip` 内联图标折行以及 `TutorDetail` 应用当前查看老师的主题色与按钮不折行。
- **测试与巡览**：更新 `m1`、`m6` 与 `ui-tour.mjs`（覆盖画廊选中、点赞试演、详情人设与素材标签）；在 `ux-invariants.spec.ts` 新增 **I16**（同屏含悬停预览同时播放 `<video>` ≤ 1）并将路由表 `/characters` 更新为 `/tutors/tutor-chutang`。

**本地验证**

- `scripts/gate.ps1 -Frontend -Contract` 全绿：Ruff clean、Pytest **468 通过 / 2 跳过**、`generate:api:check` 与 `check_no_fakes.py` 通过、`tsc` / `eslint` 通过、Vitest **13 文件 76 项通过**、`vite build`（1.12s）通过。
- `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e`：**24 / 24 全部通过**（含 I1–I3、I5–I13、I16）。
- `PLAYWRIGHT_CHANNEL=msedge npm run review:tour -- U4`：**39 步通过、0 失败、92 张截图**输出至 `docs/rebuild/review/U4/`，已人工抽检画廊、详情页、今天页、404 与手机端截图。
