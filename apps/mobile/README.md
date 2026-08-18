# Companion Space Mobile

## Release metadata synchronization

`release.json` is the source of truth for the mobile app ID, marketing version, and build number. After editing it, synchronize the mobile package metadata, root lockfile workspace entry, and all Debug/Release iOS project settings:

```powershell
npm run release:sync --workspace @companion-space/mobile
npm run release:sync:check --workspace @companion-space/mobile
```

The command is idempotent and fails without writing when the expected iOS or lockfile structure is missing or duplicated. Do not edit those generated version fields separately.

Capacitor 8 移动壳：本地 launcher 验证受信 Companion Server，使用一次性挑战完成设备配对，然后进入服务器托管的现有 Web UI。核心与平台包锁定 8.5.0；官方插件分别锁定其当前可安装的 8.x 版本。它不会在 URL 中携带 token，也不会关闭 TLS 校验。

## 当前安全边界

- 构建必须显式设置 `COMPANION_MOBILE_TRUSTED_ORIGINS`，且生产构建只接受其中精确批准的 HTTPS origin；不存在隐式默认地址。
- `allowNavigation` 只包含这些 origin 的明确 hostname，不使用 `*`。
- 仅当构建时设置 `COMPANION_MOBILE_ALLOW_HTTP_LOCALHOST=1`，launcher 才接受 `localhost`、`127.0.0.1` 或 `::1` 的 HTTP；Capacitor 原生配置仍保持 `cleartext: false`，因此这只用于浏览器诊断，不代表 Android 任意明文网络支持。
- 当前阶段没有通用 LAN 配对、证书置备或任意自签名证书旁路。要连接局域网服务器，必须先为其配置移动设备信任的 HTTPS 证书，并把精确 origin 写入构建配置。
- 非敏感服务器 origin 使用 `Preferences`（浏览器预览退回 `localStorage`）。刷新凭据绝不使用这两者：Android 由 Keystore AES-GCM 加密后保存，iOS 使用 Keychain `AfterFirstUnlockThisDeviceOnly`。
- 短期 access token 只留在原生插件内存，通过 `CompanionAuth` 原生桥注入受信远端 Web 文档，不经过 URL、Preferences 或 localStorage。
- access token 过期或服务端拒绝时，远端页面只清除短期内存状态并返回本地 launcher；launcher 自动轮换 refresh token。只有刷新明确返回 401 时才删除长期凭据并要求重新配对。
- Web 在 access token 到期前 30 秒调用原生 `refreshAccessToken`；Android/iOS 在原生网络栈中读取安全存储、固定请求同一受信 origin 的刷新端点并原子保存轮换后的 refresh token，远端 JavaScript 从不接触 refresh token。401 才解除配对；423、网络和 5xx 保留长期凭据供重试。
- API CORS 必须允许 `https://app.companion.local`（Android）和 `capacitor://app.companion.local`（iOS）。

## 构建与生成原生项目

安装工作区依赖后执行：

```powershell
npm run check --workspace @companion-space/mobile
npm run build --workspace @companion-space/mobile
npm run cap:add:ios --workspace @companion-space/mobile
npm run cap:add:android --workspace @companion-space/mobile
npm run cap:sync --workspace @companion-space/mobile
```

构建指定生产服务器：

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run build --workspace @companion-space/mobile
npm run cap:sync --workspace @companion-space/mobile
```

`ios/` 与 `android/` 已生成。Android 可在 Windows/Linux 构建；iOS 签名归档仍需 macOS、Xcode 与 Apple 签名凭据。

`release.json` 是 Android 与 iOS 的统一发布版本源：`marketingVersion`
同时驱动 Android `versionName`、iOS `MARKETING_VERSION` 与移动 workspace
版本；`buildNumber` 同时驱动 Android `versionCode` 与 iOS
`CURRENT_PROJECT_VERSION`。每次商店上传前把 `lastPublishedBuildNumber`
更新为商店中最近一次成功上传的值，再把 `buildNumber` 设为更大的新值，
运行 `npm run release:sync --workspace @companion-space/mobile`；不要分别手改
原生工程。门禁会拒绝倒退、重复或超过 Google Play 上限的 build number。

## 打开、安装与产物

Android 可用 Android Studio 打开 `apps/mobile/android`，或运行：

```powershell
cd apps/mobile/android
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`；Release APK
位于 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，未签名版本
仅用于构建验收。Google Play 发布需配置签名并生成 AAB。

iOS 在 macOS 上打开 `apps/mobile/ios/App/App.xcodeproj`，选择 `App` scheme 后在
模拟器或已配置签名的真机运行。命令行无签名模拟器构建与 CI 使用相同命令：

```bash
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

TestFlight / App Store 归档需要 Apple 开发者团队、证书和 provisioning profile。

CI 在 macOS 26 / Xcode 26 运行同一工程的 `AppTests`，并上传 unsigned
Release Simulator `.app`。本地 macOS 可用下列命令运行测试；先用
`xcrun simctl list devices available` 选择一个可用 iPhone simulator：

```bash
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  CODE_SIGNING_ALLOWED=NO test
```

## iPhone 个人直装（不经过 App Store）

这条路径只用于把 Debug 版安装到你自己的 iPhone，不需要 App Store 或
TestFlight。需要一台能运行 Xcode 26 的 Mac、一个 Apple Account，以及手机可访问并
信任证书的 Companion Space HTTPS 地址。`https://companion.localhost` 只指向当前设备，
不能作为手机服务器地址。

在 Mac 的仓库根目录运行：

```bash
npm ci
export COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.your-real-domain.cn'
npm run ios:device
```

该命令会构建移动启动器、只同步 iOS 原生工程，并打开 Xcode。随后：

1. 在 Xcode > Settings > Accounts 登录 Apple Account。
2. 选择 `App` target > Signing & Capabilities，保持 `Automatically manage signing`，
   Team 选择你的 Personal Team 或付费开发者团队。
   如果 `space.companion.mobile` 已被其他 Apple 团队占用，只在本机 Xcode 将
   Bundle Identifier 改成你的唯一反域名标识；不要提交该个人签名改动，也不要为此
   修改统一的 `release.json`。
3. 用数据线连接并信任 iPhone，把运行目标切换到该 iPhone，然后点击 Run。
4. 如果手机提示，前往“设置 > 隐私与安全性 > 开发者模式”，开启并按提示重启确认。
5. 首次打开 App，输入构建时批准的同一 HTTPS 地址、设备名，以及桌面端
   “设置 > 移动设备”生成的 8 位配对码。

免费 Personal Team 安装的 provisioning profile 只有 7 天有效期，到期后需重新连接
Mac 并再次 Run。仓库不会保存 Apple 账号、证书或 provisioning profile。

## iOS 正式发布包

正式 iOS 门禁只在 macOS 26 / Xcode 26 或更新版本运行。它会拒绝占位
origin，使用 `generic/platform=iOS` 归档、`app-store-connect` 导出方式和
App Store Connect API key 自动签名。运行前，Git 工作区必须完全干净，
包括没有未跟踪文件；门禁把产物绑定到当前 commit。ASC `.p8` 文件和发布
输出目录都必须使用仓库外的绝对路径。

导出后，门禁只接受本次生成的唯一 IPA，并解包复核 bundle ID、营销版本、
build number、签名标识、Apple team、隐私清单和内置生产 runtime origin，
最后写入包含 commit 与 SHA-256 的 `release-evidence.json`：

```bash
export COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.your-domain.cn'
export COMPANION_IOS_TEAM_ID='ABCDE12345'
export COMPANION_IOS_ASC_KEY_PATH='/secure/AuthKey_XXXXXXXXXX.p8'
export COMPANION_IOS_ASC_KEY_ID='XXXXXXXXXX'
export COMPANION_IOS_ASC_ISSUER_ID='00000000-0000-4000-8000-000000000000'
export COMPANION_IOS_OUTPUT_DIR='/absolute/path/to/companion-ios-release'
npm run ios:release:check --workspace @companion-space/mobile
npm run ios:release --workspace @companion-space/mobile
```

`ios:release:check` 和 `ios:release` 都需要 macOS；Windows 上只能运行
`ios:release:self-test` 验证输入契约。本仓库尚未在 Windows 主机上运行真实
iOS 归档、签名或 IPA 导出。IPA 导出成功仍不等于 App Store
接受：还必须由有权限的操作者上传 App Store Connect，等待 Apple 处理并
完成 TestFlight/商店隐私与合规信息。API key、证书和 provisioning profile
不得写入仓库，发布输出也不得落在仓库中。

## Android 正式发布包

`assembleRelease` 在没有签名凭据时仍可用于构建验收，并会明确输出 unsigned 提示；这种 APK/AAB 不能发布。正式发布使用下面的门禁命令，它会拒绝 `example.*`、`.test`、`.invalid`、`localhost` 等占位服务器地址，且仅在四项签名变量完整、keystore 文件真实存在时生成签名 AAB。Git 工作区必须完全干净（包括未跟踪文件），产物证据会绑定当前 commit；keystore 必须使用仓库外的绝对路径：

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.your-domain.cn'
$env:COMPANION_ANDROID_KEYSTORE_FILE='D:\secure\companion-release.jks'
$env:COMPANION_ANDROID_KEYSTORE_PASSWORD='<store password>'
$env:COMPANION_ANDROID_KEY_ALIAS='companion-release'
$env:COMPANION_ANDROID_KEY_PASSWORD='<key password>'
npm run android:release:check --workspace @companion-space/mobile
npm run android:release --workspace @companion-space/mobile
```

成功产物位于 `android/app/build/outputs/bundle/release/app-release.aab`。发布脚本会用 JDK 的 `jarsigner` 严格验证 AAB 签名、用 `keytool` 读取签名证书，并在同目录写入包含 commit、版本、origin 与 SHA-256 的 `release-evidence.json`。签名值也可用同名 Gradle properties（推荐放在用户级 `~/.gradle/gradle.properties`，不要写入仓库）；环境变量存在时优先于同名 Gradle property。发布门禁命令本身只读取环境变量，以免脚本解析或复制用户级密码文件。仓库不会生成、保存或提交 keystore。

## 生产发布前仍需完成

仓库内的构建、门禁和自测不能替代以下外部发布条件：真实且设备可访问的
生产 HTTPS origin、发行方长期保存的 Android/iOS 签名凭据、Google Play 与
App Store Connect 上传权限、目标 Android/iPhone 实体机验收，以及公开可访问
并与商店披露一致的隐私政策 URL。缺少其中任何一项，都不能把移动端标记为
已完成商店发布。
