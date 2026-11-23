# Contributing to Companion Space

Companion Space is a local-first, single-user 1-on-1 AI tutor released under **Apache-2.0**. Contributions are welcome and should preserve local ownership, real-model teaching integrity, and clean licensing.

## Prerequisites

- **Python 3.12+** (CI runs on Python 3.13; the optional Windows portable archive builder uses Python 3.14 x64)
- **Node.js 24+** (workspace lockfile is managed with `npm@11.21.2`)
- **Docker** *(optional)* for single-container `docker compose` verification

## Development Setup

```bash
# Install frontend workspace dependencies (use npm, not pnpm)
npx --yes npm@11.21.2 ci

# Create a virtual environment and install backend dev dependencies
python -m venv .venv
# Windows: .venv\Scripts\python.exe -m pip install -r services/api/requirements-dev.txt
# macOS/Linux:
.venv/bin/python -m pip install -r services/api/requirements-dev.txt
```

> **Important**: Never run tests or evaluation scripts against a live `storage/` directory containing personal study data. Backend tests automatically isolate state via temporary directories (`isolated_settings`), and manual test runs should set `COMPANION_DATA_DIR` to a temporary path.

## Verification Gate

Before opening a pull request, make sure all checks pass.

**Windows (full one-command gate):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract
```

**Cross-platform individual checks:**

```bash
python -m ruff check services/api tools/tutorpack sidecars/local-gpu-avatar
PYTHONPATH=services/api python -m pytest services/api/tests -q
python -m pytest sidecars/local-gpu-avatar/tests -q
npm run generate:api:check
python scripts/check_no_fakes.py
npm run typecheck --workspace web
npm run lint --workspace web
npm run test --workspace web
npm run build --workspace web
npm run test:e2e
```

If you modified any FastAPI route request/response schema, regenerate and commit the typed frontend client first:

```bash
npm run generate:api
```

## Engineering & Licensing Rules

1. **No fake providers or canned teaching content in production code**: Test doubles belong strictly under `services/api/tests/fakes/` and `apps/web/tests/`. Enforced by `scripts/check_no_fakes.py`.
2. **Structured API errors**: User-facing HTTP errors must return structured `{"code": "...", "message": "..."}` details mapped cleanly in `apps/web/src/locales/zh-CN.json`.
3. **Design tokens & accessibility**: Keep hex colors confined to `apps/web/src/styles/theme.css`, preserve keyboard navigation and `prefers-reduced-motion` support, and keep technical jargon inside Advanced sections.
4. **Never commit secrets or private study files**: Do not commit API keys, `.env`, `vault.json`, `storage/`, SQLite databases, or copyrighted third-party textbooks and exam papers.
5. **Clean licenses only**: Code and dependencies must use permissive licenses (`Apache-2.0`, `MIT`, `BSD`, `ISC`, `MPL-2.0`; `OFL-1.1` for fonts). Do not introduce `GPL`/`AGPL` dependencies or proprietary SDKs. Any bundled portrait, video clip, voice sample, or font must have verified redistribution rights registered in [`assets/avatars/LICENSES.md`](assets/avatars/LICENSES.md) and [`assets/THIRD_PARTY_NOTICES.md`](assets/THIRD_PARTY_NOTICES.md).

## Documentation Sync

- User-facing workflow or CLI changes → [`README.md`](README.md) & [`README.en.md`](README.en.md)
- Data persistence or telemetry boundaries → [`docs/privacy-and-data.md`](docs/privacy-and-data.md)
- Loopback, vault, WebSocket, or Sidecar trust rules → [`docs/security-model.md`](docs/security-model.md)
- Content & pedagogical guardrails → [`docs/safety-policy.md`](docs/safety-policy.md)
- Media & `.tutorpack` provenance rules → [`docs/asset-licensing.md`](docs/asset-licensing.md)

## Security Reporting

Please do **not** open public issues for credential leaks, sandbox/loopback bypasses, or archive extraction vulnerabilities. Follow [`SECURITY.md`](SECURITY.md) to report security issues privately.

---

## 中文贡献简引

Companion Space 是本地优先、单用户的开源 1v1 AI 导师（Apache-2.0）：

- 开发环境需 **Python 3.12+** 与 **Node.js 24+**，前端工作区统一使用 `npx --yes npm@11.21.2 ci`（不使用 `pnpm`）。
- 提交前请确保 `scripts/gate.ps1 -Frontend -Contract` 全绿（含 Ruff、Pytest、OpenAPI 契约检查、`check_no_fakes.py` 防空壳扫描、TypeScript、ESLint、Vitest 与 Vite 构建）。
- 严禁提交真实 API Key、`vault.json`、`storage/` 用户库或受版权保护的教材/真题文件。
