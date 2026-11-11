# Companion Space

[简体中文](README.md) | **English**

Companion Space is a local-first anime-style study companion. Create learning spaces, import materials, choose a character, study through text or voice, and turn sessions into reviews and confirmed memories.

The supported acceptance path is a Windows desktop browser with the local Mock provider. Docker is also supported. External providers receive requests only when configured and selected. The source is Apache License 2.0. Character models, motions, voice weights, and sample assets have separate terms in [NOTICE](NOTICE) and [assets/THIRD_PARTY_NOTICES.md](assets/THIRD_PARTY_NOTICES.md).

## Current release

- Interactive study room with spaces, session recovery, material and companion shortcuts, lighting, and a focus timer.
- Immersive companion room with shared text history, keyboard shortcuts, 2D fallbacks, and six bundled VRM characters.
- Material import, citation-aware retrieval, session review, user-confirmed memories, and review items.
- Optional Capacitor Android/iOS shells with trusted HTTPS and eight-digit pairing.
- Optional neural speech sidecar for compatible NVIDIA hosts.

The release includes Windows production startup and Docker HTTPS smoke checks. Real providers, physical microphones, mobile signing, and real-device pairing require target-environment validation. See the [room and runtime update](docs/release/room-and-runtime-20261112.md) and [voice interface release record](docs/release/voice-interface-20261112.md).

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

See [Windows usage](WINDOWS-README.md), [architecture](docs/architecture.md), [deployment](docs/deployment.md), [voice service](docs/voice-service.md), [asset licensing](docs/asset-licensing.md), and [contributing](CONTRIBUTING.md).
