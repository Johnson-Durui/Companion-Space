# Security Model

Companion Space is a single-user, local-first application that handles model API credentials, personal study documents, and live microphone input on the owner's machine.

## Architecture Baseline

- **Single-process loopback server**: Both the FastAPI backend and built React web frontend are served from `127.0.0.1:8000` by default (both in source launches and in single-container `docker compose` deployments).
- **No public exposure by default**: Companion Space is not designed to listen directly on `0.0.0.0` on untrusted networks. If remote access is ever required by an advanced operator, it must be placed behind an independent HTTPS reverse proxy with strong external authentication.
- **Zero-secret CI**: Automated test suites use in-process test doubles injected through `create_app(gateway_factory=...)` and never require live API keys.

## Implemented Controls

### 1. Loopback, Session & WebSocket Protection

- Owner REST routes require an in-memory bearer session token issued to the local browser session, combined with Origin and CSRF validation on state-mutating requests.
- Live classroom and avatar bridge WebSockets use short-lived, single-use tickets bound to the target session (`companion-v1` subprotocol) and validate request `Origin` headers.
- Duplicate classroom tabs are explicitly arbitrated (`4409 other_tab` / explicit `?takeover=1` handoff).

### 2. Credential Vault & Secret Redaction

- Provider API keys never enter browser `localStorage`, URL query strings, frontend bundles, or API list responses.
- Credentials are encrypted at rest inside `vault.json` under `COMPANION_DATA_DIR`. New installations run seamlessly with a locally protected key file, and owners can enable an explicit **master password** at any time under **Settings → Privacy & Data** to lock the vault on restart.
- Application logs redact bearer tokens and provider secrets, and never log full prompts, uploaded textbook contents, or student transcripts.

### 3. Per-Course Data Isolation & Prompt Fencing

- Every course-scoped SQLite table carries `space_id`, and repository queries enforce course-level isolation so materials, item banks, evidence, and history from one course never leak into another.
- Uploaded study materials, student inputs, and imported `.tutorpack` persona fields are treated as **untrusted data**: they are wrapped inside explicit data blocks when passed to LLMs and cannot override system-level safety or grading rules.
- Executable or structured visual outputs (KaTeX, SVG plots, Mermaid diagrams) are parsed and rendered safely without ever invoking `eval` or `exec` on model output.

### 4. Hardened `.tutorpack` & Media Import

Importing custom `.tutorpack` / `.zip` archives or single-image portraits runs strict server-side validation before extraction:

- Rejects path traversal (`..` / Zip-Slip), symlinks, absolute paths, Windows reserved device names, executable extensions, oversized archives, and excessive entry counts.
- Verifies binary container headers (`WebM`/EBML, `MP4`/`ftyp`, `PNG`, `JPEG`, `WebP`) against magic bytes rather than trusting file extensions.

### 5. Local GPU Sidecar Boundary (`/api/v2/avatar-drivers/*`)

- Optional Tier 2 real-time avatar sidecar drivers default strictly to loopback endpoints (`127.0.0.1` / `localhost`) and require explicit private-LAN allowlisting if hosted on another machine on the owner's home network.
- Cloud-live avatar configurations remain disabled by default behind explicit idle-suspend, max-duration, and session budget circuit breakers (`LiveCostGuard`).

## Operator Guidance

- Keep `storage/` (or your custom `COMPANION_DATA_DIR`) private and encrypted when backing it up off-machine.
- Enable a master password in **Settings → Privacy & Data** on shared computers.
- Immediately rotate any provider API key if you accidentally paste it into a public screenshot or bug report.
