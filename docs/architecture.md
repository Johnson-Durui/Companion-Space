# Architecture

## Goal

Companion Space v0.1 keeps the current Next.js + FastAPI prototype shape while shifting the product into a generic study-companion platform. The release posture is local-first, single-user, and self-hosted.

## Runtime Topology

### Browser

- Renders the companion UI, VRM avatar, 2D fallback, lesson board, and demo player.
- Talks to the backend through the web app and proxied API origin.
- Keeps the owner bearer token in browser module memory only. It does not store
  provider API keys, and a page refresh normally requires unlocking again.

### Web app

- Path: `apps/web`
- Stack: Next.js 15 + TypeScript
- Responsibilities:
  - shell, navigation, study pages, and settings UI
  - API calls through `NEXT_PUBLIC_API_BASE_URL`
  - real-time call room, character studio, lesson board, and recap workflow

### API

- Path: `services/api`
- Stack: FastAPI
- Responsibilities:
  - text and real-time session coordination
  - provider routing and fallback policy
  - material ingestion and retrieval
  - transcript, memory, and review persistence

### Edge proxy

- Path: `infra/caddy/Caddyfile`
- Stack: Caddy
- Responsibilities:
  - single public entrypoint
  - local HTTPS with internal CA
  - HTTP and WebSocket proxying to `web` and `api`
  - same-machine HTTPS for v0.1; groundwork for a future trusted-device LAN flow

## Data Boundaries

The v0.1 application now uses a local, space-scoped storage model:

- metadata in SQLite WAL
- uploaded materials under `storage/spaces/{space_id}/materials`
- no durable raw audio by default
- encrypted provider credentials outside browser storage

`storage/` is runtime data, not source distribution.

## Trust Boundaries

1. `Browser <-> Caddy`
   - HTTPS is the supported v0.1 Docker entrypoint on the same machine.
   - The current optional Capacitor clients use the same Caddy origin after a
     local owner approves a one-time device pairing challenge.
   - Mobile refresh credentials stay in native Keychain/Keystore; only a
     short-lived access credential is exposed to the exact paired Web origin.

2. `Caddy <-> web/api`
   - Internal Docker network only.
   - `web` and `api` are not intended to publish host ports directly.

3. `API <-> provider APIs`
   - User-supplied credentials.
   - Keys must be redacted from logs and never sent to the browser.

4. `API <-> local materials`
   - Uploaded files are untrusted input.
   - Parsing, chunking, and retrieval should treat document instructions as data, not commands.

## Request Flow

### Text flow

1. Browser sends a request to the web app.
2. Web app calls the API origin exposed through Caddy.
3. FastAPI loads prompt/schema context, queries retrieval, and routes to a provider.
4. The response returns structured content plus citations.

### Real-time flow

1. Browser opens one WebSocket session per conversation.
2. Browser streams microphone audio frames.
3. API emits audio-buffer progress, final ASR text, LLM deltas, and TTS chunks.
4. Browser animates the selected character locally and persists only final transcript-level artifacts.

## Release Notes For Maintainers

- `infra/nginx` is intentionally replaced by Caddy as the supported entrypoint.
- Shared prompts and schemas under `libs/` define the generic companion contract
  used by the live API path; law-specific behavior is limited to the optional demo
  pack.
- CI covers backend lint/tests and frontend typecheck/lint/build. Playwright,
  dependency audits, Docker smoke, hardware rendering, and the long realtime soak
  are recorded as release evidence outside the default CI job.
