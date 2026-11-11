# Companion Space Windows 快速启动

完整产品、架构、安全边界、故障回退和接手顺序见：

[`docs/architecture-and-windows-handoff.zh-CN.md`](docs/architecture-and-windows-handoff.zh-CN.md)

## 本机交付版：先用 Mock 体验

需要 Windows 10/11、Node.js 24、Python 3.12 或 3.13，以及支持 WebGL 的浏览器。把交付包解压到可写目录，例如 `E:\Codex\Companion-Space`，在项目根目录打开 PowerShell。

首次安装依赖需要联网：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/api/requirements.txt
npx.cmd --yes npm@11.21.2 ci
```

如果安装的是 Python 3.13，使用 `py -3.13`；也可用已安装 Python 的完整路径。启动脚本优先读取项目 `.venv`，支持用 `COMPANION_PYTHON` 指向另一个已装依赖的 Python，无需修改脚本。

请保留上面固定的 npm 版本：npm 11.18 之前存在 workspace 安全补丁覆盖缺陷。`npx` 只运行 npm 11.21.2，不替换系统的全局 npm；日常 `npm.cmd run` 命令不受影响。

日常启动：

```powershell
.\START-LOCAL-WINDOWS.ps1 -Production
```

脚本构建生产前端，准备好后访问 `http://127.0.0.1:3000`。保留该窗口，Ctrl+C 停止本次启动的服务。省略 `-Production` 可进入开发模式。若系统阻止本地脚本执行，可仅对当前终端运行 `Set-ExecutionPolicy -Scope Process Bypass` 后重试。

首次体验约五分钟：

1. 打开「本地保险箱」，设置主密码。刷新浏览器后需重新解锁，请自行保管密码。
2. 进入「今日 → 进入我的书房」，创建或选择学习空间。默认 Mock 无需 API Key。
3. 从资料书架导入 `sample_data` 中的示例，或添加自己的笔记。
4. 选择伙伴，进入沉浸共学。输入文字并发送；语音只在主动启用后请求麦克风。`Ctrl+Enter` 发送，`Esc` 退出沉浸。
5. 回到书房可恢复所选空间的上次会话；从「复盘」整理摘要、确认记忆和复习项。

Mock 使用预设内容验证流程；需要自由回答时，在「声音与模型」中配置自己的模型，再到空间设置中分配。书房的专注倒计时离页后重置。

接语音服务可直接打开「声音与模型 → 语音接口配置」：填写地址、保存连接、测试并试听，再绑定学习空间。本地 Qwen 默认地址为 `http://127.0.0.1:8001`，模型为 `qwen3-tts-0.6b-customvoice`，声线可先用 `Serena`；保存自定义连接无需修改 `.env`，但模型服务必须先启动。在线服务还需填写其 API Key。具体步骤与可调用的语音 API 见 [语音服务接入](docs/voice-service.md)。

### 常见情况

- 提示找不到 Python：先完成 `.venv` 创建与依赖安装，避免使用 Windows Store 的占位 `python.exe`。
- 提示端口占用：先检查原服务；脚本不强行停止占用进程。可加 `-ApiPort 8400 -WebPort 3400` 使用另一组端口。
- 角色加载慢：等待资源加载；也可在形象设置中选择 2D。首次资源下载和编译时间不代表后续响应速度。
- 刷新后提示解锁：访问令牌只保存在当前页面内存，这是正常行为；重新解锁后回书房恢复会话。
- 停止窗口后页面不可用：本机服务已停止，重新运行启动命令。

交付内容和本轮实测范围见 [交付记录](docs/release/delivery-20261111.md)。源码包不包含 Node/Python、依赖目录、用户数据库或 API Key。

## Docker 方式

1. 安装 Windows 11 + Docker Desktop，并启用 WSL2 后端。
2. 把项目完整解压到可写、非 OneDrive 路径，例如 `E:\Codex\Companion-Space`。
3. 启动 Docker Desktop，等待引擎状态为 Running。
4. 在项目根目录打开 PowerShell：

   在 `.env` 同时设置 `COMPOSE_PROFILES=neural-tts` 与
   `BUILTIN_NEURAL_TTS_ENABLED=true` 后，`neural-tts` 才会启动；首次启动会下载约
   2.5 GB 模型到独立 Docker volume。
   可在 `.env` 设置 `TTS_MODEL_CACHE_PATH` 为你自己的缓存目录（例如
   `./qwen3-tts-cache`），让大缓存不进入 `storage/` 正式备份。当前 Compose
   profile 仅支持 Docker Desktop WSL2 + NVIDIA GPU；无兼容 GPU 时请保持关闭。
   输出语音是 AI 合成内容，不支持声纹克隆、参考音频或自由指令。普通视频和音频资产不会打包进发布物。
   启动脚本默认要求 `.wslconfig` 内存帽 ≤ 14 GB。其它机器可用
   `.\START-WINDOWS.ps1 -SkipWslMemoryCheck`，或直接 `docker compose up --build`。

   首次启动前先执行 `.\SET-DOCKER-MEMORY-WINDOWS.ps1`，再执行 `wsl --shutdown`
   并重启 Docker Desktop。它把整个 WSL/Docker VM 限制为 14 GB，比 16 GB 主机容量
   低 12.5%。四个运行服务的硬上限合计为 11.9375 GiB（API 5 GiB、神经语音 6 GiB、
   Web 768 MiB、Caddy 192 MiB），在 VM 内给 Linux 内核、Docker Engine 与稳态开销
   留约 2 GiB。启动脚本还会串行构建镜像，避免多个镜像构建峰值叠加；BuildKit
   同样由 14 GB 的 WSL 总上限约束，而不是依赖不受支持的单次构建内存参数。
   Qwen 模型、精度、固定声线、情绪映射和回答模型配置均未改变。可以用
   `docker stats` 观察实际占用；不要盲目继续压低 TTS 上限，否则可能从“稍慢”变成
   容器 OOM 重启。所有服务上限都可在 `.env` 通过 `*_MEMORY_LIMIT` 调整。

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\START-WINDOWS.ps1
   ```

5. 构建完成后打开 `https://companion.localhost`。

第一次启动后，可在管理员 PowerShell 信任 Caddy 本地 CA：

```powershell
certutil -addstore -f Root ".\infra\caddy\data\caddy\pki\authorities\local\root.crt"
```

完全退出并重开浏览器。先用 Mock 验证 Vault→空间→资料→角色→通话→引用→复盘闭环，再接真实 Provider。

## 不用 Docker 的本机路径

Docker Desktop 没开、或不想重建容器时，在仓库根目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\START-LOCAL-WINDOWS.ps1
```

然后打开 `http://127.0.0.1:3000`。脚本会把前端指到本机 API（`127.0.0.1:8000`），而不是 Docker 用的同源 `/`。**已经健康的 API / TTS 会直接复用，不会停 8001。** 若 3000 在监听但页面超时，只停挂死的 Next.js 再重跑，不要杀 API/TTS。四主角是 painted-blender 原创，不是许可样本。先走 Mock：Vault → 空间 → 资料 → 澄羽/曜柚/凛序/弦灯 → 文字共学。localhost 上的麦克风实时语音可用；局域网 IP 需要 HTTPS。

本仓库是 npm workspace，用 `npm.cmd`，不要用 pnpm。

## Android / iOS 移动端

手机不能使用 `companion.localhost`，因为 `.localhost` 在手机上指向手机
自己。请先给宿主机配置一个手机可访问且系统信任的 HTTPS 域名，并在
`.env` 把 `APP_HOST` 改为该域名。当前 Caddyfile 对所有主机名都使用内部 CA
（`tls internal`），**不会**因为换成公共域名就自动拿到 Let's Encrypt 证书。
本地域名或 IP 使用内部 CA 时，需要在每台手机上安装并信任该 CA。

构建移动壳：

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run check:mobile
npm run typecheck:mobile
npm run build:mobile
npm run cap:sync --workspace @companion-space/mobile
```

Android 需要 Node 24、JDK 21、Android SDK 36 / Build Tools 36.0.0；生成的
工程位于 `apps/mobile/android`。iOS 工程位于 `apps/mobile/ios`，但必须在
macOS + Xcode 26 以上环境编译；签名和 TestFlight 还需要你自己的 Apple
凭据。

使用时先在电脑浏览器解锁 Vault，进入 **设置 → 移动设备** 生成一次性
8 位配对码，再在手机 App 输入服务器地址、8 位配对码和设备名。
长期刷新凭据只保存在 Android Keystore / iOS Keychain；访问凭据不进入
URL、localStorage 或 Preferences。丢失手机后应立即在同一页面撤销设备。
完整网络、证书和令牌生命周期见 `docs/lan-pairing.md`。

移动端首次配对只需输入电脑端“设置 → 移动设备”生成的 8 位码、受信 HTTPS
地址和设备名称。每次只保留一个 5 分钟有效的配对码；生成新码会让旧码立即失效。
数据库只保存由 Vault 密钥生成的 HMAC 校验值，不保存明文或可离线穷举的普通哈希。

Android 可用 Android Studio 打开 `apps/mobile/android`，或在该目录运行
`.\gradlew.bat :app:assembleDebug :app:assembleRelease`。调试 APK 位于
`app/build/outputs/apk/debug/app-debug.apk`，可用
`adb install -r app/build/outputs/apk/debug/app-debug.apk` 安装。Release APK 默认未签名，
商店发布需另行配置签名并生成 AAB。iOS 请在 macOS 上打开
`apps/mobile/ios/App/App.xcodeproj`，选择模拟器或已配置签名的真机运行。

Android 正式 AAB 必须配置真实 HTTPS 地址和四项签名变量后运行：

```powershell
npm run android:release:check --workspace @companion-space/mobile
npm run android:release --workspace @companion-space/mobile
```

CI 会额外生成明确标记为 unsigned 的 Android AAB，并在 macOS runner
构建 Debug/Release iOS Simulator App、运行 `AppTests`。正式上架仍需要
你自己的 Google Play / Apple Developer 签名凭据。

## 本地神经语音怎么切

推荐通过「语音接口配置」新建并绑定自己的本地连接，见 [语音服务接入](docs/voice-service.md)。下面是使用 `.env` 中 `BUILTIN_NEURAL_TTS_ENABLED=true` 注册的内置连接时的行为。

sidecar 在 `http://127.0.0.1:8001/healthz` 返回 `status=ready` 后：

1. 新空间会自动把 TTS 能力位绑到 `builtin-neural-tts` / `qwen3-tts-0.6b-customvoice`。
2. 四主角配方默认已是「本地神经语音」。
3. **旧 Mock 空间不会被改写。** 解锁后打开该空间 → **默认模型分配** → TTS 选 **Built-in Neural TTS**，模型填 `qwen3-tts-0.6b-customvoice`。
4. 不解锁 Vault 也可以看状态：设置页「本地神经语音」，或 `GET /api/v1/tts/sidecar`。

不要重建 Docker `neural-tts` 镜像来验证这条路径；本机 sidecar 或已在跑的容器即可。

## 数据与密码

- `storage/` 包含本地 SQLite、学习数据、导入资产和加密 Vault；不要随意删除。
- API Key 不以明文存放，但迁移包仍是私有数据，只能交给你控制的电脑。
- 换机后仍需原 Vault 主密码。忘记密码只能重置凭据并重新录入 Key，学习空间会保留。
- 不要在 API 运行时直接复制 `storage/` 或 `companion.db`。
- API 重启会自动恢复 SQLite 中 `pending/running` 的复盘任务；若 Vault 尚未解锁，真实 Provider 任务会保持 `pending`，解锁后继续。不要同时启动多个 API 实例。

## 备份与恢复

默认命令会短暂停止 API，完成 WAL checkpoint、SQLite 一致性快照、Vault/资料/角色资产复制和 SHA-256 校验；Web 与 Caddy 保持运行，原来正在运行的 API 会自动恢复：

```powershell
.\BACKUP-WINDOWS.ps1
```

只需要不间断地保存 SQLite 时，可显式创建在线数据库快照：

```powershell
.\BACKUP-WINDOWS.ps1 -OnlineDatabaseOnly
```

在线快照不包含 `vault.json`、资料或角色资产，不能当作完整应用备份。只有脚本最终输出的不以 `.partial` 结尾的目录才是已发布备份；失败时保留的 partial 目录仅供诊断。

恢复必须离线进行：先 `docker compose stop api`，校验完整备份的 `backup-manifest.json`，把当前 `storage/` 改名保留为 rollback，再把备份中的完整 `storage/` 复制回项目根。确认 `/healthz`、Vault、资料和角色均正常后，才考虑清理旧目录；不要直接覆盖或删除当前数据。

## 常用命令

```powershell
docker compose ps
docker compose logs --tail 200
docker compose down
.\BACKUP-WINDOWS.ps1
```

若启动失败，先运行：

```powershell
docker info
docker compose config --quiet
curl.exe -k https://companion.localhost/healthz
```

完整排障表在架构接手手册第 15 节。
