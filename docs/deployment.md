# Deployment

## Supported Mode

Companion Space is designed for self-hosted, single-owner deployment. The
historical v0.1 browser release is same-machine first; the current repository
also includes opt-in Android/iOS wrappers that connect to one explicitly
approved HTTPS origin.

The default display name is neutral: `Companion Space`. Override `APP_DISPLAY_NAME` only if you want a different local label.

## Local Development

### Frontend

```bash
npm ci
npm run dev --workspace web
```

### Backend

```bash
python3 -m pip install -r services/api/requirements.txt
PYTHONPATH=services/api uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Docker Compose

### Start

```bash
cp .env.example .env
docker compose up --build
```

### Services

- `caddy`: only public entrypoint on ports `80` and `443`
- `web`: internal Next.js container
- `api`: internal FastAPI container
- `neural-tts`: internal Qwen3-TTS container on port `8001` (not published to the host)

### Default host

- `https://companion.localhost`

Set `APP_HOST` in `.env` to change the hostname. Keep
`companion.localhost` for same-machine browser use. A phone must use a reachable,
device-trusted HTTPS origin; build that exact origin into the mobile allowlist
with `COMPANION_MOBILE_TRUSTED_ORIGINS`. See
[Mobile HTTPS And Device Pairing](lan-pairing.md).

### Provider setup after launch

- Mock is available by default and does not need an API key.
- Add BYOK providers from the app after unlocking the local vault.
- OpenAI-compatible providers can use a custom Base URL.
- Ollama works through its explicit provider entry or through an OpenAI-compatible endpoint shape.
- Provider failures should surface the provider-specific reason to the user. When a capability is unavailable, the app should fall back to text-only behavior instead of silently switching vendors.

### Built-in neural speech

Enable the local Qwen3-TTS sidecar with `COMPOSE_PROFILES=neural-tts`,
`BUILTIN_NEURAL_TTS_ENABLED=true`, and
`LOCAL_NEURAL_TTS_BASE_URL=http://neural-tts:8001`. The model is pinned to
revision `85e237c12c027371202489a0ec509ded67b5e4b5`; the first start downloads
about 2.5 GB into the `qwen3_tts_model_cache` Docker volume. On Windows, set
`TTS_MODEL_CACHE_PATH` to a directory you control, for example
`./qwen3-tts-cache`. The cache stays outside `storage/` and full application backups.
NVIDIA CUDA with bfloat16 and SDPA is used and does not require FlashAttention.
The supplied Compose profile is intentionally GPU-only; keep it disabled when
NVIDIA GPU passthrough is unavailable. Existing bootstrap spaces remain on Mock
TTS until the sidecar reports the pinned model ready, then migrate atomically.
The API-facing model ID is `qwen3-tts-0.6b-customvoice`; it maps only to the
pinned upstream model and cannot select an arbitrary Hugging Face repository.

The sidecar accepts at most 320 Chinese characters and returns raw mono
24 kHz signed little-endian PCM16. Speech is synthesized content. It supports
only Vivian, Serena, Uncle_Fu, Dylan, and Eric (plus fixed compatibility
aliases), and does not accept URLs, reference audio, cloning, or arbitrary
instructions. Request text and PCM are neither logged nor persisted. Model
weights are downloaded at runtime; ordinary video/audio assets are not bundled.
The API accepts only the seven application emotion values and keeps the selected
speaker fixed. It applies a small, clamped speaking-rate adjustment (`0.5` to
`2.0`); bundled style instructions are forward-compatible hints, not a guarantee
of full instruction-based emotion control from the 0.6B checkpoint.

## Local HTTPS

### Why HTTPS is required

The local HTTPS entrypoint is Caddy-based. It keeps the browser-to-proxy hop encrypted and lets the app use a single public origin.

### Local CA

Caddy stores local certificate authority state inside:

- `infra/caddy/data`
- `infra/caddy/config`

The checked-in `infra/caddy/Caddyfile` applies `tls internal` to **every**
`APP_HOST` value. That includes public DNS names. Caddy will **not** request a
public ACME / Let's Encrypt certificate until this file is changed and verified.
Do not claim that switching `APP_HOST` to a public domain yields a publicly
trusted certificate.

For `companion.localhost`, LAN IPs, and other internal names:

1. Launch `docker compose up --build`.
2. Trust Caddy's local root certificate on the host (`infra/caddy/data/.../root.crt` after first start).
3. Completely restart the browser before using the HTTPS entrypoint.

Mobile and local trust steps live in [lan-pairing.md](lan-pairing.md).

## Android And iOS

The checked-in `apps/mobile` Capacitor project provides a local connection and
pairing launcher, Android Keystore/iOS Keychain refresh-token storage, and a
strict bridge that supplies only the short-lived access token to the exact
approved server origin.

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run check:mobile
npm run typecheck:mobile
npm run build:mobile
npm run cap:sync --workspace @companion-space/mobile
```

Android builds require JDK 21 and Android SDK 36. iOS compilation requires
macOS and Xcode 26 or newer; CI performs an unsigned simulator build. Store
signing remains credential-gated.

## Security Expectations

- Do not expose `web` or `api` directly on host ports in production-like setups.
- Keep `.env`, provider keys, local CA state, and `storage/` outside public backups unless intentionally encrypted.
- Treat uploaded documents and imported character packs as untrusted input.

## SQLite Lifecycle and Backups

- The current schema is recorded as SQLite `PRAGMA user_version = 3`. Explicit
  v1→v2→v3 migrations add trusted-device enrollment, device-bound owner
  sessions, and recoverable refresh-token rotation. A newer database is rejected
  before WAL mode or schema objects are changed.
- Connections set both the native SQLite timeout and `PRAGMA busy_timeout`; the default is `SQLITE_BUSY_TIMEOUT_MS=5000` and valid values are 0–60000 ms.
- WAL mode is enabled and checked during repository initialization, not rewritten on every business connection.
- A maintenance `TRUNCATE` checkpoint is successful only when the first value returned by `PRAGMA wal_checkpoint(TRUNCATE)` is zero.

On Windows, use `BACKUP-WINDOWS.ps1`. Its default full mode briefly stops only the API, checkpoints WAL, creates a clean SQLite snapshot with the standard-library backup API, copies the remaining Storage files, verifies SHA-256 hashes, and restarts the API only when it was previously running. `-OnlineDatabaseOnly` keeps the API running but omits the Vault, materials, and character assets.

Never copy an active `companion.db`, WAL/SHM pair, or full `storage/` tree. A directory ending in `.partial` is an incomplete attempt, not a recovery point. Restore a full backup only while the API is stopped, preserve the current Storage directory as rollback, verify the manifest, and validate health, Vault access, materials, and characters before removing rollback data.

## Background Recap Recovery

- API startup scans SQLite for learning-artifact jobs left in `pending` or `running` and schedules them once. Rows already marked `ready` are not regenerated.
- Open sessions recover summary generation only. Ended sessions also replace stale candidate memories and pending review items while preserving user-confirmed memories, completed reviews, and manually edited summaries.
- Generation is serialized to one job at a time so a restart backlog cannot burst requests at the analysis provider.
- A locked or not-yet-initialized Vault leaves remote-provider work in `pending` without a false error; the job resumes after the Vault is unlocked. Graceful shutdown cancels in-memory tasks while keeping their database state recoverable.
- Run one API/Uvicorn process. Docker deliberately reserves host loopback port
  `127.0.0.1:8000`; the local Windows launcher checks the same port and refuses
  to start a second API. Keep Caddy as the only non-loopback ingress. Add an
  atomic database claim or lease before enabling multiple API workers or
  replicas.

## Upgrade Notes

- The release uses SQLite WAL for runtime metadata and an encrypted provider vault for secrets.
- Increment `PRAGMA user_version` and add an atomic migration whenever the SQLite schema changes.
- Revisit backup, migration, and recovery steps whenever the storage layout or vault schema changes.
