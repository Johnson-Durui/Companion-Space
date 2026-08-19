# Companion Space

**简体中文** | [English](README.en.md)

Companion Space 是一款本地优先的二次元陪伴学习应用。你可以为不同主题创建独立空间，导入自己的资料，与虚拟角色进行文字或实时语音交流，并在会话后整理复盘、记忆和复习内容。

项目默认运行在你自己的电脑上。资料和凭据保存在本地；如果接入 OpenAI 兼容服务、Ollama 等外部 Provider，相关请求会按照你的配置发送给对应服务。

## 核心能力

- **独立学习空间**：按课程、项目或兴趣组织资料、角色和对话记录。
- **资料问答与引用**：导入资料后进行检索增强对话，并保留答案引用。
- **文字与实时语音**：支持连续对话、语音播放和插话打断。
- **虚拟角色演出**：支持浏览器本地 VRM 3D 角色，以及 2D 备用形象、口型、情绪、目光和动作反馈。
- **可替换的 AI 服务**：内置 Mock 便于直接体验，也可接入 OpenAI 兼容接口、Ollama 等 Provider；长期记忆需要用户确认后才会写入。

<details>
<summary>当前版本范围</summary>

当前最完整的使用路径是桌面浏览器配合本机 Docker 和 Mock 或自备 Provider。Android 与 iOS 客户端目前是连接同一服务的测试壳，需要受信任的 HTTPS 和设备配对，尚未作为商店成品发布。本项目暂不包含 WebRTC、MuseTalk、LivePortrait 或真人 talking-head 视频能力。

</details>

源码采用 **Apache License 2.0**。角色模型、动作、语音权重和示例素材可能适用各自的许可要求，详见 [NOTICE](NOTICE) 和 [第三方素材说明](assets/THIRD_PARTY_NOTICES.md)。

## 快速开始

需要 Docker Desktop（或兼容的 Docker Engine）和 Docker Compose v2。先 **不要** 打开 `neural-tts` profile。

```bash
git clone https://github.com/Johnson-Durui/Companion-Space.git
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

## 项目结构

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

卡面插画与四主角 3D 均为本项目原创。Sendagaya Shino / Seed-san / Sakurada Fumiriya / Constraint Twist 仍作为许可样本保留。Mori / Yuzu 的 2D atlas 是本项目资源。不要从 CyberVerse（GPL-3.0）拷代码进来。

四个原创 VRM 允许再分发和修改且无需署名，但其内嵌权限不授权企业商业使用，并禁止过度暴力/性、政治/宗教、反社会或仇恨用途；不得剥离内嵌元数据。完整字段见模型 `manifest.json` 与 [第三方/素材声明](assets/THIRD_PARTY_NOTICES.md)。

仓库发布的是经过校验的四个 VRM 二进制与哈希；精确的 painted albedo 输入和本地 `.blend` 工作文件不在公开仓库。干净 clone 可以直接运行这些模型，但不承诺从公开源逐字节重建相同哈希。详见 [原创 3D 契约](docs/design/original-companions-3d.md)。

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
