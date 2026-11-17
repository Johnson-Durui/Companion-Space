# 重塑进度

## M0 止血与地基 — 所有者验收通过（2026-11-17）

**待验收与已知问题**

- 所有者验收见下方清单。旧前端已归档，新界面在 M1 恢复。Docker 路径在 M0–M7 暂停使用。
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

## M1 新外壳与模型网关 — 进行中（2026-11-17）

**M1a 内部检查点**

- 本地门通过 ruff、OpenAPI 契约、防空壳和 pytest。集成工作树 301 项通过、0 项失败、2 项因 Windows 符号链接权限跳过。
- v1–v5 逐级迁移至 v6、升级前备份、旧保险箱迁移、零密码和主密码开关、原子写中断、回环/Origin/CSRF、票据及后台任务恢复均有自动化覆盖。
- `evals/smoke_gateway.py` 已运行，缺少 `.env.eval`，按计划记录真实模型指标未验证。独立的零配置 Edge 试听接口实测返回 HTTP 200、34,848 字节 MP3，耗时 2.006 秒。
