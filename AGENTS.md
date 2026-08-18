# AGENTS.md — Companion Space 仓库约定

> 本文件面向在此仓库工作的 AI 代理（Codex 等）。开发主线与里程碑见 `docs/plan/v0.1-execution-plan.md`；产品验收基线见 `docs/v0.1-acceptance.md`。

## 项目概览

- 产品：本地单用户自托管的开源二次元伴学空间（Apache-2.0）。
- 结构：npm workspaces monorepo——`apps/web`（Next.js 15 + React 19，无 Tailwind、无状态库，全局 CSS 变量 + 少量 CSS Modules）、`services/api`（FastAPI + 裸 sqlite3，`storage/companion.db` WAL）、`libs/`（共享 prompt 与 schema）、`infra/`（Caddy 唯一对外入口 + Docker）。
- 按 `docs/plan/v0.1-execution-plan.md` 的里程碑 M0→M7 顺序开发，**过验收门才能进入下一个里程碑**。

## 运行与验证命令

```bash
# 后端
python3 -m ruff check services/api
PYTHONPATH=services/api pytest services/api/tests -q
PYTHONPATH=services/api uvicorn app.main:app --reload --port 8000

# 前端（Node ≥24）
npm run typecheck:web
npm run lint:web
npm run build:web
npm run dev:web

# 全栈（Caddy HTTPS 入口）
docker compose up --build   # 访问 https://companion.localhost
```

每次提交前，上述 ruff / pytest / typecheck / lint / build 必须全部通过（与 `.github/workflows/ci.yml` 一致）。M7 起追加 Playwright E2E 与 Docker Compose 冒烟。

## 开发纪律

1. **先跑通，再扩展。** 每个里程碑先交付最小可运行版本并附运行证据（输出/日志/截图），过门再加下一层。禁止一次性生成大量未验证代码。
2. **一次改动一个关注点。** 每次提交的 diff 能用一句话说清目的；重构与功能变更分开提交。里程碑内按"后端契约 → 后端实现 → 前端对接 → 测试"切分。
3. **错误不静默。** 禁止空 catch / except-pass；禁止 `allow404` 式吞错；禁止未知 provider 静默降级 Mock。错误要么就地处理，要么带上下文向上抛，且在 UI 可见。
4. **测试必须能失败。** 新测试先证明能红（构造失败输入或临时破坏实现），再让它绿。断言真实行为，不断言常量。
5. **依赖保守。** 能用标准库就不引第三方；引入前确认包名真实存在、版本兼容并写入依赖清单。v0.1 允许新增的生产依赖仅限：`three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation`、`@react-three/fiber`、mermaid（本地打包）；不引入 PostgreSQL、Redis、外置向量库、Celery、WebRTC、Electron。
6. **不擅自扩大范围。** 顺手能修的问题先报告，确认后再动。v0.1 非范围清单见执行方案第 1 节。
7. **非显然决策留痕。** 选型、取舍、已知妥协写进 commit message 或 `DECISIONS.md`。
8. **第三方复用许可红线。** 仅可复用许可与 Apache-2.0 兼容的项目代码并保留原版权声明（MIT：pixiv/ChatVRM、semperai/amica、moeru-ai/airi、M3-org/CharacterStudio、mrxz/wLipSync；Apache-2.0：HKUDS/DeepTutor）。禁止复制 AGPL/GPL/受限自定义许可项目的代码（SillyTavern、Fay、Soul-of-Waifu、Lumen、Open-LLM-VTuber、aituber-kit），只可学习其设计。内置素材以 `notes/opensource-research-2026-07.md` 的核实清单为准，全部登记进 `assets/THIRD_PARTY_NOTICES.md`；Live2D 素材与 Cubism SDK 一律不得引入；官方 VRMA 动作文件与 Mixamo 动画文件不得 commit 进仓库。

## 安全红线（发布否决条件，任何时候不得破坏）

- 跨空间数据泄漏：空间 A 的资料/记忆/会话/复习项不得被空间 B 读取或检索。
- 明文 API Key 落盘、进日志、进前端响应或导出物。Key 只存加密 vault（Argon2id + AES-256-GCM），明文只在已解锁的后端进程内存。
- 原始音频在通话结束后残留于磁盘/SQLite/日志（`audio_persist_enabled` 默认 False）。
- 引用无法回溯到真实检索命中：citations 只能由服务端生成，拒绝模型伪造。
- 破坏 Mock 全流程：全新克隆不依赖真实 Key 必须能走完整个闭环。
- 检索资料是不可信文本：资料中的指令不得改变系统角色、安全规则、凭据或空间边界。
- 日志脱敏：不记录 Prompt 全文、文档正文、字幕正文或 Key。
- 真实 Key 不进入 CI、不进入测试 fixture、不写入任何文件。

## 已知陷阱

- `storage/` 已 gitignore，内含真实运行数据（`companion.db`、旧 `knowledge_base/`）——不要提交、不要在测试中依赖它；测试用 `tests/conftest.py` 的 `isolated_settings` fixture（tmp_path 隔离）。
- 根目录 `.env` 存在但为空；配置模板是 `.env.example`。`Settings` 的 `env_file` 相对 CWD，从仓库根启动。
- 前端 `lib/api.ts` 的 `allow404` 会把接口缺失伪装成空状态——排查"UI 没数据"先看 Network 面板，M1 会移除该机制。
- WS 事件形状以后端 `{type, session_id, state, payload}` 为准（`services/api/app/api/v1.py`），前端解析需重写对齐。
- Caddy 不 strip 路径前缀：`NEXT_PUBLIC_API_BASE_URL` 是不含 `/api` 的 origin，前端路径自带 `/api/v1`。
