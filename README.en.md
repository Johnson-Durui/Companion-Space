# Companion Space v2

> Companion Space is being rebuilt for v1.0. See the [rebuild plan](docs/rebuild/PLAN.md).

## M1 local quick start

1. Install Python 3.12 or later. Building the web UI from source also requires Node.js 24.
2. Double-click `start.bat` on Windows or run `sh start.sh` on macOS or Linux.
3. When [Companion Space](http://127.0.0.1:8000/welcome) opens, choose a tutor. In Settings, add a model connection using a preset and your key. Run the connection checks, then try a message or image on the diagnostic page.

The welcome page opens without a password on first run. Enabling a master password requires it on restart. The app encrypts keys at rest in the data directory shown in Settings.

To use a Chinese Python package mirror, pass `-Mirror cn` to `start.ps1` or run `sh start.sh --mirror cn`. Distributions with a prebuilt web UI only need Python at runtime.

> The remaining sections document the pre-rebuild version. Use the local quick start for this worktree.

[简体中文](README.md) | **English**

Companion Space is a local-first anime-style study companion. Create learning spaces, import materials, choose a character, study through text or voice, and turn sessions into reviews and confirmed memories.

The supported acceptance path is a Windows desktop browser with the local Mock provider. Docker is also supported. External providers receive requests only when configured and selected. The source is Apache License 2.0. Character models, motions, voice weights, and sample assets have separate terms in [NOTICE](NOTICE) and [assets/THIRD_PARTY_NOTICES.md](assets/THIRD_PARTY_NOTICES.md).

## Classroom workflow

Open a study space, add source material, and pick a tutor. The classroom includes a persistent interactive board with formulas, step tracing, and a checkpoint quiz. Review cited excerpts and confirm flashcards for FSRS scheduling. The built-in Mock provider supports the full workflow without API keys.

The responsive Web app supports Windows local startup and optional Docker hosting.

## Quick start

Install Node.js 24 and Python 3.12 or 3.13. Create `.env` from `.env.example` for Docker, or use `START-LOCAL-WINDOWS.ps1 -Production` for a Windows local run. Mock does not require an API key. Configure your own provider for unrestricted conversations.

```text
git clone https://github.com/Johnson-Durui/Companion-Space.git
cd Companion-Space
cp .env.example .env
docker compose up --build
```

Open `https://companion.localhost`, trust Caddy's local CA, unlock the Vault, and start with Mock. Never commit `.env`, `storage/`, databases, private keys, tokens, or generated build output.

## Verification

Run `npm run typecheck:web`, `npm run lint:web`, `npm run test:runtime-config`, and `npm run test:pet-assets`. With Python dependencies installed, run `python -m ruff check services/api` and `python -m pytest services/api/tests -q`.

See [Windows usage](legacy/WINDOWS-README.md), [architecture](docs/archive/architecture.md), [deployment](docs/archive/deployment.md), [voice service](docs/archive/voice-service.md), [asset licensing](docs/asset-licensing.md), and [contributing](CONTRIBUTING.md).
