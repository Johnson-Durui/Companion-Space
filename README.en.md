# Companion Space

[简体中文](README.md) | **English**

Companion Space is a local-first anime-style companion and study app. Create separate spaces for different topics, import your own materials, chat with virtual characters through text or real-time voice, and organize reviews, memories, and study content after each session.

The project runs on your own computer by default. Materials and credentials are stored locally. If you connect an external provider such as an OpenAI-compatible service or Ollama, requests are sent to that service according to your configuration.

## Core Features

- **Independent learning spaces:** Organize materials, characters, and conversation history by course, project, or interest.
- **Grounded Q&A with citations:** Import materials for retrieval-augmented conversations while retaining citations in answers.
- **Text and real-time voice:** Supports continuous conversations, speech playback, and barge-in interruption.
- **Virtual character performance:** Supports browser-local VRM 3D characters, plus 2D fallback avatars with lip sync, emotion, gaze, and motion feedback.
- **Replaceable AI services:** Includes a Mock provider for immediate use and supports OpenAI-compatible endpoints, Ollama, and other providers. Long-term memories are written only after user confirmation.

<details>
<summary>Current Release Scope</summary>

The most complete workflow currently uses a desktop browser with local Docker and either the Mock provider or your own provider. The Android and iOS clients are currently test shells that connect to the same service. They require trusted HTTPS and device pairing and have not been released as store-ready products. This project does not currently include WebRTC, MuseTalk, LivePortrait, or live-action talking-head video capabilities.

</details>

The source code is licensed under the **Apache License 2.0**. Character models, motions, voice weights, and sample assets may be subject to separate license terms. See [NOTICE](NOTICE) and the [third-party asset notices](assets/THIRD_PARTY_NOTICES.md).

## Quick Start

You need Docker Desktop, or a compatible Docker Engine, and Docker Compose v2. Do **not** enable the `neural-tts` profile yet.

```bash
git clone https://github.com/Johnson-Durui/Companion-Space.git
cd Companion-Space
cp .env.example .env
docker compose up --build
```

After the first startup:

- Open `https://companion.localhost`
- Follow your browser's instructions to trust Caddy's local CA (`tls internal`, **not** public Let's Encrypt)
- Start with Mock: Vault → Spaces → Materials → Characters → Co-study

Health check: after Caddy starts, open `https://companion.localhost/healthz`. The `api` and `web` containers include health checks, and Caddy waits until both are healthy.

Optional neural speech, which requires an NVIDIA GPU and downloads approximately 2.5 GB of weights on first use, is built only when you explicitly enable the profile:

```dotenv
COMPOSE_PROFILES=neural-tts
BUILTIN_NEURAL_TTS_ENABLED=true
```

Never commit a real `.env`, `storage/`, `infra/caddy/data`, private keys, tokens, or databases to Git.

### Windows

The repository root includes `START-WINDOWS.ps1`, which is intended for 16 GB hosts where the WSL/Docker memory limit should be set to 14 GB. On other machines, you can run:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Alternatively, run `.\START-WINDOWS.ps1 -SkipWslMemoryCheck`. If Docker is not running, use `.\START-LOCAL-WINDOWS.ps1` and open `http://127.0.0.1:3000` in your browser. Create backups only with the repository script. It writes to `backups/` by default, which is already ignored by Git:

```powershell
.\BACKUP-WINDOWS.ps1
```

Do not directly copy `companion.db`, its WAL/SHM files, or the entire `storage/` directory while the API is running. Run a backup before replacing the API image.

For local development without Docker, see [WINDOWS-README.md](WINDOWS-README.md). This repository is an **npm workspace**. Use `npm.cmd` / `npm`, not pnpm.

## Project Structure

```text
.
├── apps/web/          Next.js UI (VRM / 2D, sessions, settings)
├── apps/mobile/       Capacitor Android/iOS shell and secure pairing launcher
├── services/api/      FastAPI
├── services/tts/      Optional Qwen3-TTS sidecar
├── infra/caddy/       Sole HTTPS entry point (the current Caddyfile uses tls internal for every APP_HOST)
├── docker-compose.yml
├── .env.example
├── LICENSE
├── NOTICE
└── assets/THIRD_PARTY_NOTICES.md
```

The web app is built with **same-origin relative URLs** by default:

```dotenv
NEXT_PUBLIC_API_BASE_URL=/
NEXT_PUBLIC_REALTIME_WS_URL=/api/v1/sessions/:sessionId/realtime
```

With this configuration, phones can connect by IP and computers can use `companion.localhost` without rebuilding the frontend for each hostname, as long as the reverse proxy keeps requests on the same origin. If you change these build-time variables, you must rebuild the `web` image; restarting the container is not enough.

## Mobile Apps (Optional)

Phones cannot use `companion.localhost`. Give the host computer an HTTPS origin that the phone can reach and trust, then compile the **same origin** into the shell:

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run check:mobile
npm run typecheck:mobile
npm run build:mobile
npm run cap:sync --workspace @companion-space/mobile
```

Unlock the Vault in a desktop browser, then open **Settings → Mobile Devices** to generate an eight-digit code. Enter it on the phone within five minutes. Refresh credentials are stored only in Android Keystore or iOS Keychain. Access tokens are never placed in URLs, localStorage, or logs. See [docs/lan-pairing.md](docs/lan-pairing.md) and [apps/mobile/README.md](apps/mobile/README.md).

### Build an Android Debug Package on Windows

You need JDK 21, Android SDK 36, and Build Tools 36.0.0. After installation, write the SDK path to your local `apps/mobile/android/local.properties` file. This file is ignored by Git and must not be committed:

```properties
sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

Use a **placeholder** origin only to verify that the package builds. Pairing on a physical device requires an HTTPS origin that the phone can reach and trust, followed by another `build:mobile` and `cap:sync`. Do not commit an `apps/mobile/dist` build containing a real Tailscale or LAN IP address.

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm.cmd run build:mobile
npm.cmd run cap:sync --workspace @companion-space/mobile
cd apps\mobile\android
.\gradlew.bat :app:assembleDebug
```

Debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (a debug signature is sufficient). A successful build proves only that the project compiles. It does **not** prove that pairing works on a physical device, and the app has **not** been released to a store. Building for iPhone still requires macOS and Xcode.

The current `infra/caddy/Caddyfile` uses `tls internal` for **every** `APP_HOST`. Switching to a public domain does **not** automatically obtain a public ACME certificate; that would require a future Caddyfile change.

## Characters and Licensing (Please Read)

| Product character | Current 3D model | License summary |
| --- | --- | --- |
| 澄羽 MIRA | Original custom `Mira.vrm` | Embedded VRM permission: personal commercial use allowed; corporate commercial use not licensed |
| 曜柚 KITE | Original custom `Kite.vrm` | Embedded VRM permission: personal commercial use allowed; corporate commercial use not licensed |
| 凛序 CAEL | Original custom `Cael.vrm` | Embedded VRM permission: personal commercial use allowed; corporate commercial use not licensed |
| 弦灯 LYRA | Original custom `Lyra.vrm` | Embedded VRM permission: personal commercial use allowed; corporate commercial use not licensed |

The card illustrations and all four featured 3D characters are original works created for this project. Sendagaya Shino, Seed-san, Sakurada Fumiriya, and Constraint Twist remain as licensed samples. The Mori and Yuzu 2D atlases are project assets. Do not copy code from CyberVerse (GPL-3.0) into this repository.

The four original VRM models may be redistributed and modified without attribution, but their embedded permissions do not authorize corporate commercial use. They also prohibit excessive violence or sexual content, political or religious use, antisocial or hateful use, and removal of embedded metadata. See each model's `manifest.json` and the [third-party and asset notices](assets/THIRD_PARTY_NOTICES.md) for the complete fields.

The repository publishes the four validated VRM binaries and their hashes. The exact painted albedo inputs and local `.blend` working files are not included in the public repository. A clean clone can run these models directly, but the project does not promise byte-for-byte reproduction of the same hashes from public sources. See the [original 3D companion contract](docs/design/original-companions-3d.md).

## Verification Commands

From the repository root:

```bash
npm run typecheck:web
npm run lint:web
npm run check:mobile
npm run typecheck:mobile
npm run test:original-vrm
npm run test:runtime-config
npm run test:pet-assets
```

API, with local Python dependencies installed:

```bash
python3 -m ruff check services/api
PYTHONPATH=services/api python3 -m pytest services/api/tests -q
```

Do not run two Next production builds concurrently, and do not overwrite `.next` while `next start` is running.

## Documentation

- [Windows Quick Start](WINDOWS-README.md)
- [Deployment](docs/deployment.md)
- [Mobile Pairing](docs/lan-pairing.md)
- [Architecture](docs/architecture.md)
- [Privacy](docs/privacy-and-data.md)
- [Security Model](docs/security-model.md)
- [Asset Licensing](docs/asset-licensing.md)
- [Contributing](CONTRIBUTING.md)
