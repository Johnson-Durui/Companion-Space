# Companion Space v2 互动课堂升级

升级分支为 `refactor/teaching-v2`，基于已验证发布版本 `4177484`。以 Cursor 的 **Companion Space Refactor Plan** 为依据。

## 启动

在 v2 工作区执行以下命令。端口 3125 和 8125 可与旧版并行使用。

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/api/requirements-dev.txt
npx.cmd --yes npm@11.21.2 ci
.\START-LOCAL-WINDOWS.ps1 -Production -WebPort 3125 -ApiPort 8125
```

访问 `http://127.0.0.1:3125/spaces`。解锁保险箱后，建立一个主题为「二分查找」的学习空间，可选添加一篇讲解搜索区间的笔记。进入互动课堂后，可更改查找目标、逐步执行、点击数组或图谱节点提问、尝试随堂测验，再确认闪卡并评分。内置 Mock 支持此流程。

## 数据与兼容

SQLite 迁移由现有版本迁移器执行。升级到 schema 5 时增加会话 TTS 快照列及课堂、闪卡表。迁移使用事务并检查版本。对原工作区的数据库以只读连接取得 SQLite 快照，迁移测试从 schema 3 升到 5。六张业务表的记录数量匹配，完整性和外键检查均通过。

新工作区默认使用自己的 `storage`。要带入历史资料和凭据，可用完整备份恢复到独立目录，再以 `OBJECT_STORAGE_PATH` 指定该副本。Vault 主密码沿用备份所属的原密码。

浏览器授权使用 HttpOnly 加密 Cookie。现有 Bearer 客户端和部分 v0.1 路径仍可工作。Capacitor 工程及其发布任务已从 v2 移除，Web 保留窄屏布局。三个主工作区从导航进入，资料、模型、保险箱和复盘深链接仍可直接访问。

## 改动位置

| 阶段 | 交付 |
| --- | --- |
| M1 | 领域仓储、加密浏览器会话、OpenAPI 生成客户端、原生控件和语义化 CSS |
| M2 | 常驻 3:7 课堂、KaTeX、可改参推演、图谱追问、测验、导师视线与 2D/3D 切换 |
| M3 | 教学编排器、模型与 Mock 路由、板书上下文追问、WebSocket 和语音采播 |
| M4 | 服务端引用校验、资料切片、课后提炼、FSRS 确认与评分、Windows 及 Playwright 验证 |

生成客户端前应先安装 API 依赖。修改 FastAPI 契约后执行 `npm run generate:api`。CI 使用 `npm run generate:api -- --check` 检查生成结果。

## 验收结果

- Pytest 通过 574 项，跳过 3 项。Ruff、TypeScript 类型检查、ESLint、Next.js 生产构建及 OpenAPI 契约检查通过。
- 生产构建的 Playwright 课堂、响应式外壳及窄屏用例通过 16 项。课堂用例覆盖 Cookie 刷新恢复、导师 2D/3D 切换、KaTeX、改参重跑、节点追问、测验纠偏、原文引用、闪卡确认与评分。
- 实时专项验证覆盖视线、角色渲染降级、字幕、打断、会话握手及按住说话提交。六个原创 VRM 的加载、面部表情和口型检查通过。
- Windows 启动脚本的四项测试通过。使用该脚本实际启动了隔离端口的生产 Web 和 API。Docker Compose 配置检查通过。

蓝图的 Alembic 项改为沿用 SQLite 事务版本迁移。三个主工作区已经收敛，兼容页面和接口仍计入现有 17 个页面与 82 项 HTTP 操作。源码总量、前端最大单文件和实时模块行数仍高于蓝图指标。完整旧版 Playwright 长流程未跑完。Docker 容器、真实外部模型和实体麦克风需要对应环境的现场验证。
