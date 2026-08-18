# Contributing

## Scope

Companion Space is a local-first, single-user study companion project. Contributions should preserve that constraint unless a maintainer explicitly widens the scope.

## Setup

### Prerequisites

- Node.js 24+
- Python 3.13+
- Docker Desktop or compatible Docker Engine for Compose validation

### Install

```bash
cp .env.example .env
npm install
python3 -m pip install -r services/api/requirements-dev.txt
```

## Development Workflow

1. Keep changes small and reversible.
2. Reuse existing patterns before introducing new abstractions.
3. Do not commit API keys, local certificates, Caddy CA private keys, `.env` values, `storage/`, or user databases.
4. This is an npm workspace. Use `npm` / `npm.cmd`, not pnpm.
5. If you add assets, include their license metadata in `docs/asset-licensing.md` or an adjacent manifest.
6. If you add new externally reachable behavior, update `docs/security-model.md` and `docs/deployment.md`.
7. Do not enable `*` CORS, disable TLS verification, or place refresh tokens in URLs, remote JS, localStorage, or logs.

## Verification

Run the relevant checks before opening a PR:

```bash
python3 -m ruff check services/api
PYTHONPATH=services/api pytest services/api/tests -q
npm run typecheck:web
npm run lint:web
npm run build:web
```

If Docker is available, also validate:

```bash
docker compose up --build
```

## Documentation Expectations

- User-facing behavior changes must update `README.md`.
- Data-handling changes must update `docs/privacy-and-data.md`.
- Proxy, LAN, or container changes must update `docs/deployment.md` and `docs/lan-pairing.md`.
- Safety-boundary changes must update `docs/safety-policy.md`.

## Security Reporting

Do not open a public issue for credential leaks, trust-boundary bypasses, or unsafe asset execution paths. Report them privately to the maintainers with reproduction steps and affected files.

## 中文摘要

这是本地优先、单用户的学习搭子。贡献请保持范围，不要把密钥、证书、用户数据和构建快照提交进仓库。验证命令见仓库根 `README.md`。
