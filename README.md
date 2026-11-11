# Companion Space

[English](README.en.md)

本地优先、单用户的二次元学习搭子。从自己的书房进入学习空间，导入资料、选择伙伴，用文字或语音共学，再把对话整理成复盘与记忆。支持 Windows 本机运行和 Docker 部署；记录保存在本机，接入外部模型时会向你选择的服务发送相应请求。

源码许可证：**Apache License 2.0**。角色模型、动作、语音权重各自还有独立许可，见 [NOTICE](NOTICE) 和 [assets/THIRD_PARTY_NOTICES.md](assets/THIRD_PARTY_NOTICES.md)。

## 它现在能做什么

- 本地 Vault 解锁后，用内置 Mock 或自备 Provider（OpenAI 兼容 / Ollama 等）学习。
- 互动书房支持切换空间、恢复上次会话、资料与伙伴热点、暖灯/暮色和专注计时。
- 沉浸陪伴把角色与对话放在主要位置；Ctrl/⌘+Enter 发送，Esc 返回完整共学布局，语音需主动开启。
- 空间、资料导入、引用式 RAG、会话复盘、确认式记忆和复习项。
- 桌面浏览器是主路径。可选 Capacitor Android / iOS 壳：同一套 Web UI，需受信 HTTPS 和 8 位配对码。
- 共学舞台支持六个原创 VRM 形象的面部情绪、口型、目光和一次性肢体反应；Mori / Yuzu 与六张 2D 卡面仍是完整备用形象。

主流程：`解锁 Vault → Mock 或接入 Provider → 建空间 → 导入资料 → 选/创建角色 → 文字或实时共学 → 板书/演示 → 复盘 → 确认记忆/复习`

## 本轮交付

提供可重新生成的源码交付包、六个原创 VRM、2D 备用形象、启动脚本、使用说明和校验清单。主要验收路径为 Windows 桌面浏览器与本地 Mock；Mock 无需 API Key，使用预设回答，用来体验和验证流程。自由对话需要配置自己的模型服务。

从 [Windows 使用说明](WINDOWS-README.md) 开始，完整验收证据与适用范围见 [2026-11-11 交付记录](docs/release/delivery-20261111.md)。语音界面与续接说明见 [语音服务](docs/voice-service.md) 和 [2026-11-12 语音界面记录](docs/release/voice-interface-20261112.md)。本轮研究 Eciyuan 的房间与聊天交互，采用原创素材实现，设计对应见 [迁移说明](docs/design/eciyuan-adaptation.md)。

[开源更新记录](docs/release/room-and-runtime-20261112.md) 包含新版书房截图、素材来源及运行验证。

移动壳的商店签名与真机验收、真实模型服务和实体麦克风仍需在目标环境验证。六个 VRM 的许可独立于源码许可证，企业商业使用尚未授权，见下方许可表。

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

本地开发（不用 Docker）见 [WINDOWS-README.md](WINDOWS-README.md)。本仓库是 **npm workspace**，用 `npm.cmd` / `npm`，不要用 pnpm。

## 当前仓库布局

```text
.
├── apps/web/          Next.js UI（VRM / 2D、会话、设置）
├── apps/mobile/       Capacitor Android/iOS 壳与安全配对 launcher
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

## 移动端（可选）

手机不能用 `companion.localhost`。需要给宿主机一个手机能访问、系统信任的 HTTPS origin，再把**同一个 origin** 编进壳：

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run check:mobile
npm run typecheck:mobile
npm run build:mobile
npm run cap:sync --workspace @companion-space/mobile
```

在电脑浏览器解锁 Vault，打开 **设置 → 移动设备** 生成 8 位码，5 分钟内在手机输入。刷新凭据只进 Android Keystore / iOS Keychain；access token 不进 URL、localStorage 或日志。详见 [docs/lan-pairing.md](docs/lan-pairing.md) 和 [apps/mobile/README.md](apps/mobile/README.md)。

### Windows 上打 Android 调试包

需要 JDK 21、Android SDK 36、Build Tools 36.0.0。装好后把 SDK 路径写进本机 `apps/mobile/android/local.properties`（已 gitignore，不要提交）：

```properties
sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

用**占位** origin 只验收能否出包；真机配对必须换成手机能访问、系统信任的 HTTPS origin，并重新 `build:mobile` + `cap:sync`。不要把含真实 Tailscale / 局域网 IP 的 `apps/mobile/dist` 提交进 git。

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm.cmd run build:mobile
npm.cmd run cap:sync --workspace @companion-space/mobile
cd apps\mobile\android
.\gradlew.bat :app:assembleDebug
```

调试 APK：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`（debug 签名即可）。这只证明工程能编过，**不等于**已在真机配对成功，也**没有**上架。iPhone 编译仍需 macOS / Xcode。

当前 `infra/caddy/Caddyfile` 对 **所有** `APP_HOST` 使用 `tls internal`。换成公网域名 **不会** 自动拿到公开 ACME 证书；那是以后改 Caddyfile 之后的事。

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

仓库发布的是经过校验的六个 VRM 二进制与哈希；精确的 painted albedo 输入和本地 `.blend` 工作文件不在公开仓库。干净 clone 可以直接运行这些模型，但不承诺从公开源逐字节重建相同哈希。详见 [原创 3D 契约](docs/design/original-companions-3d.md)。

## 验证命令

从仓库根目录：

```bash
npm run typecheck:web
npm run lint:web
npm run check:mobile
npm run typecheck:mobile
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

- [Windows 快速启动](WINDOWS-README.md)
- [部署](docs/deployment.md)
- [移动配对](docs/lan-pairing.md)
- [架构](docs/architecture.md)
- [隐私](docs/privacy-and-data.md)
- [安全模型](docs/security-model.md)
- [素材许可](docs/asset-licensing.md)
- [贡献](CONTRIBUTING.md)

## English

Companion Space is a local-first, single-user anime study companion. Clone, copy `.env.example` to `.env`, and run `docker compose up --build`. Open `https://companion.localhost` and trust the **internal** Caddy CA. The six featured 3D bodies are project-owned original VRM companions; licensed sample VRM files remain optional. Credit Seed-san to VirtualCast, Inc. Mobile and GPU TTS are optional. Do not commit `.env`, `storage/`, or `infra/caddy/data`.
