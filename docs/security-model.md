# Security Model

## Threat Model

Companion Space is a single-user self-hosted app, but it still handles secrets, private study materials, and microphone input. The primary risks are:

- provider API key exposure
- LAN/mobile access by untrusted devices attempting to bypass device pairing
- prompt injection through uploaded materials
- unsafe or unlicensed imported asset packs
- accidental persistence of audio or secrets in logs

## Security Baseline In This Repository Slice

- Caddy is the only public edge.
- `web` and `api` are internal-only in Docker Compose.
- `.gitignore` excludes `.env`, storage data, caches, and local CA state.
- CI does not require real provider keys.

The historical v0.1 release was same-machine only. The current repository adds
an opt-in mobile slice with one-time pairing, local-owner-only device
administration, revocation, and native secure credential storage. It does not
turn Companion Space into a public multi-user service.

## Implemented Application-Layer Controls

The following controls are implemented and covered by the v0.1 backend test
suite:

- owner-authenticated REST and WebSocket access
- encrypted provider vault with unlock/lock flow
- study-space scoped retrieval and persistence
- upload validation for file type, size, and path traversal
- explicit redaction of secrets in logs
- no durable raw audio storage by default
- one-time mobile pairing challenges with attempt and expiry limits
- atomic trusted-device enrollment and hashed credential persistence
- local-owner-only pairing/device/password administration
- 15-minute mobile access tokens plus rotating, recoverable 30-day refresh tokens
- Android Keystore and iOS Keychain storage for the refresh credential

The browser uses an in-memory owner bearer token for REST. The mobile wrapper
also keeps the access token in native memory and exposes it only to the exact
HTTPS origin approved during pairing; its refresh token never enters the remote
Web document. WebSocket access uses
a short-lived, single-use ticket bound to one session and carried in the
`companion-v1` subprotocol. The backend does not use owner-authentication
cookies.

## Remaining Validation And Hardening

- Real OpenAI-compatible, Anthropic, Gemini, and ElevenLabs credentials still
  require release-machine validation.
- Physical microphone, speaker, Bluetooth-headset, and Desktop Edge checks are
  still open release gates.
- HTTPX-based provider endpoints are resolved and validated for each operation,
  then their TCP connections are pinned to that immutable address snapshot while
  the original hostname remains authoritative for TLS verification, SNI, and
  `Host`. Redirects and environment proxies are disabled. Gemini keeps its fixed
  Google SDK endpoint and is not presented as part of the custom-URL surface.
- Signed iOS/Android store distribution and real-device certificate/network
  validation remain operator/release gates.

## Operator Guidance

- Treat the host machine as sensitive because it stores private materials.
- When enabling mobile access, use a device-trusted HTTPS origin, limit exposure
  to networks you control, and revoke devices immediately after loss or transfer.
- Keep Docker and browser updates current.
- Rotate any provider key that is ever logged or copied into the wrong place.
