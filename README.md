# Companion Space v2

> 正在重塑为 v1.0，见[重塑总纲](docs/rebuild/PLAN.md)。

[English](README.en.md)

本地优先、单用户的二次元学习搭子。从自己的书房进入学习空间，导入资料、选择伙伴，用文字或语音共学，再把对话整理成复盘与记忆。支持 Windows 本机运行和 Docker 部署；记录保存在本机，接入外部模型时会向你选择的服务发送相应请求。

源码许可证：**Apache License 2.0**。角色模型、动作、语音权重各自还有独立许可，见 [NOTICE](NOTICE) 和 [assets/THIRD_PARTY_NOTICES.md](assets/THIRD_PARTY_NOTICES.md)。

## 从哪里开始

- **星轨书房**管理学习空间、PDF / 笔记和模型服务。
- **互动课堂**左侧是导师，右侧常驻黑板。支持公式、单步推演、修改输入、图谱追问和随堂测验。
- **记忆复盘**显示课堂提炼的候选闪卡。确认后进入 FSRS 排程，复习时可查看资料出处。

本机 Vault 解锁后，浏览器刷新可继续当前课堂。试用内置 Mock 无需 API Key，在新空间输入「二分查找」即可体验完整流程。连接自己的模型服务后，课堂会使用当前空间绑定的模型生成讲义和回答。

### Windows 本机启动

安装 Node.js 24 和 Python 3.12 或 3.13，在解压后的项目根目录运行一次：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/api/requirements.txt
npx.cmd --yes npm@11.21.2 ci
.\START-LOCAL-WINDOWS.ps1 -Production
```

使用 Python 3.13 时将第一行改为 `py -3.13`。之后运行最后一行，浏览器访问 `http://127.0.0.1:3000`；保持终端开启，Ctrl+C 停止本次启动的服务。开发时省略 `-Production`。无需安装 Bash。

安装使用固定的 npm 11.21.2，避免旧 npm 对 workspace 安全补丁覆盖处理不完整。该命令不会替换系统的全局 npm，首次执行需要联网。

## 第三方：一步启动

需要 Docker Desktop（或兼容的 Docker Engine）和 Docker Compose v2。先 **不要** 打开 `neural-tts` profile。

```bash
git clone https://github.com/Johnson-Durui/Companion-Space.git Companion-Space
cd Companion-Space
cp .env.example .env
docker compose up --build
```

首次启动后：

- 打开 `https://companion.localhost`
- 按浏览器提示信任 Caddy 本地 CA（`tls internal`，**不是** 公网 Let's Encrypt）
- 先走 Mock：Vault → 空间 → 资料 → 角色 → 共学

健康检查：Caddy 起来后访问 `https://companion.localhost/healthz`。`api` 与 `web` 容器带 healthcheck；Caddy 会等它们 healthy。

可选神经语音（NVIDIA GPU，首次约 2.5 GB 权重）只有在你明确打开 profile 后才会构建：

```dotenv
COMPOSE_PROFILES=neural-tts
BUILTIN_NEURAL_TTS_ENABLED=true
```

不要把真实的 `.env`、`storage/`、`infra/caddy/data`、私钥、token 或数据库提交进 git。

### Windows

仓库根目录有 `START-WINDOWS.ps1`：适合把 WSL/Docker 内存帽打到 14 GB 的 16 GB 主机。别的机器可以：

```powershell
Copy-Item .env.example .env
docker compose up --build
```

或 `.\START-WINDOWS.ps1 -SkipWslMemoryCheck`。Docker 没开时用 `.\START-LOCAL-WINDOWS.ps1`，浏览器打开 `http://127.0.0.1:3000`。备份只用仓库内脚本，默认写到 `backups/`（已 gitignore）：

```powershell
.\BACKUP-WINDOWS.ps1
```

不要在 API 运行时直接复制 `companion.db`、WAL/SHM 或整个 `storage/`。更换 API 镜像前先跑备份。

本地开发（不用 Docker）见 [WINDOWS-README.md](legacy/WINDOWS-README.md)。本仓库是 **npm workspace**，用 `npm.cmd` / `npm`，不要用 pnpm。

## 当前仓库布局

```text
.
├── packages/          角色引擎、互动黑板和 OpenAPI 客户端
├── apps/web/          Next.js UI（VRM / 2D、会话、设置）
├── services/api/      FastAPI
├── services/tts/      可选 Qwen3-TTS sidecar
├── infra/caddy/       唯一 HTTPS 入口（当前 Caddyfile 对所有 APP_HOST 使用 tls internal）
├── docker-compose.yml
├── .env.example
├── LICENSE
├── NOTICE
└── assets/THIRD_PARTY_NOTICES.md
```

Web 默认用**同源相对地址**构建：

```dotenv
NEXT_PUBLIC_API_BASE_URL=/
NEXT_PUBLIC_REALTIME_WS_URL=/api/v1/sessions/:sessionId/realtime
```

这样手机用 IP、电脑用 `companion.localhost`，只要反代同源，都不需要为每个主机名重编一套前端。改了这些构建期变量必须重建 `web` 镜像，只重启容器不够。

## 角色与许可（请读）

| 产品角色 | 当前 3D | 许可摘要 |
| --- | --- | --- |
| 澄羽 MIRA | `Mira.vrm` 原创定制 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |
| 曜柚 KITE | `Kite.vrm` 原创定制 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |
| 凛序 CAEL | `Cael.vrm` 原创定制 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |
| 弦灯 LYRA | `Lyra.vrm` 原创定制 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |
| 星澜 NOVA | `Nova.vrm` original-vrm 原型 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |
| 沐音 ECHO | `Echo.vrm` original-vrm 原型 | 嵌入 VRM 权限：个人商业可用；企业商业未授权 |

卡面插画与六个原创 3D 形象均为本项目原创。Sendagaya Shino / Seed-san / Sakurada Fumiriya / Constraint Twist 仍作为许可样本保留。Mori / Yuzu 的 2D atlas 是本项目资源。不要从 CyberVerse（GPL-3.0）拷代码进来。

六个原创 VRM 允许再分发和修改且无需署名，但其内嵌权限不授权企业商业使用，并禁止过度暴力/性、政治/宗教、反社会或仇恨用途；不得剥离内嵌元数据。完整字段见模型 `manifest.json` 与 [第三方/素材声明](assets/THIRD_PARTY_NOTICES.md)。其中 MIRA/KITE/CAEL/LYRA 是 painted-blender 级模型，NOVA/ECHO 是同一运行时契约下的 original-vrm 原型模型。

仓库发布的是经过校验的六个 VRM 二进制与哈希；精确的 painted albedo 输入和本地 `.blend` 工作文件不在公开仓库。干净 clone 可以直接运行这些模型，但不承诺从公开源逐字节重建相同哈希。详见 [原创 3D 契约](docs/archive/design/original-companions-3d.md)。

## 验证命令

从仓库根目录：

```bash
npm run typecheck:web
npm run lint:web
npm run test:original-vrm
npm run test:runtime-config
npm run test:pet-assets
```

API（需要本机 Python 依赖）：

```bash
python3 -m ruff check services/api
PYTHONPATH=services/api python3 -m pytest services/api/tests -q
```

不要并发跑两个 Next production build，也不要在正在跑的 `next start` 旁边覆盖 `.next`。

## 文档

- [Windows 快速启动](legacy/WINDOWS-README.md)
- [部署](docs/archive/deployment.md)
- [移动配对](docs/archive/lan-pairing.md)
- [架构](docs/archive/architecture.md)
- [隐私](docs/privacy-and-data.md)
- [安全模型](docs/security-model.md)
- [素材许可](docs/asset-licensing.md)
- [贡献](CONTRIBUTING.md)

## English

Companion Space is a local-first, single-user anime study companion. Clone, copy `.env.example` to `.env`, and run `docker compose up --build`. Open `https://companion.localhost` and trust the **internal** Caddy CA. The six featured 3D bodies are project-owned original VRM companions; licensed sample VRM files remain optional. Credit Seed-san to VirtualCast, Inc. Mobile and GPU TTS are optional. Do not commit `.env`, `storage/`, or `infra/caddy/data`.
