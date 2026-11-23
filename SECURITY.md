# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` | :white_check_mark: Yes |
| `< 1.0` | :x: No (retired pre-rebuild architecture) |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub Issues.

Instead, use [GitHub Private Vulnerability Reporting](https://github.com/Johnson-Durui/Companion-Space/security/advisories/new) on this repository to submit a confidential report with:

1. Affected component (`services/api`, `apps/web`, `packages/*`, `tools/tutorpack`, `sidecars/local-gpu-avatar`, or packaging scripts).
2. Clear step-by-step reproduction instructions on a clean local environment.
3. Expected vs. actual security boundary behavior.

> **Important**: Never include real provider API keys, `vault.json`, or private user study materials in any report.

## Security Scope Notes

Companion Space is a **single-user, loopback-only (`127.0.0.1`)** desktop/local web application. See [`docs/security-model.md`](docs/security-model.md) for full details on:

- Owner session bearer tokens, Origin/CSRF checks, and single-use WebSocket tickets (`companion-v1`).
- Encrypted server-side `vault.json` storage and optional master-password protection.
- `.tutorpack` archive extraction hardening (Zip-Slip, symlink, executable, and magic-byte validation).
- Untrusted prompt data-block fencing and per-course `space_id` isolation.

Issues that require an owner to manually rewrite binding configuration to `0.0.0.0` without an external authenticating HTTPS reverse proxy are outside the supported deployment model.
