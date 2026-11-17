# Evaluation Plan

## Release Intent

This plan tracks the v0.1 acceptance bar for the open-source companion-space pivot. It focuses on local self-hosting, scoped knowledge retrieval, provider wiring, local HTTPS, and release hygiene.

## Automated Checks In Repository Today

### Backend

- `python3 -m ruff check services/api`
- `PYTHONPATH=services/api pytest services/api/tests -q`

### Frontend

- `npm run typecheck:web`
- `npm run lint:web`
- `npm run build:web`

## Release Gates

### Must pass before tagging v0.1

- Backend tests are green.
- Backend lint is green.
- Frontend typecheck, lint, and production build are green.
- Docker Compose topology matches `caddy -> web/api`.
- Documentation for deployment, privacy, safety, and asset licensing matches current behavior.

### Still requires future application work

- real-time session latency targets
- trusted-device pairing implementation
- encrypted provider vault verification
- cross-space retrieval isolation tests
- no-audio-persistence assertions
- mobile/LAN pairing UX and trusted-device lifecycle

## Manual Validation Checklist

1. Launch local development servers and confirm web + API health.
2. Launch Docker Compose and confirm `https://companion.localhost` serves the web app through Caddy.
3. Confirm `/api/*` routes proxy to FastAPI without publishing the API directly.
4. Confirm WebSocket upgrade headers are preserved through Caddy once real-time endpoints land.
5. Review docs for consistency with actual repo commands and topology.

## Deferred Acceptance Areas

These are deliberately out of scope for the current infra/open-source pass and need application implementation later:

- study-space scoped SQLite metadata
- credential encryption and unlock flow
- character-pack import/export validation
- adult-mode gating
- mobile pairing token lifecycle
