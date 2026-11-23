## Summary / 变更概述

<!-- 简述本 PR 解决的问题或新增的能力 -->

## Verification / 验证清单

- [ ] Backend checks pass (`python -m ruff check services/api tools/tutorpack sidecars/local-gpu-avatar` & `pytest`)
- [ ] OpenAPI contract & anti-shell checks pass (`npm run generate:api:check` & `python scripts/check_no_fakes.py`)
- [ ] Frontend checks pass (`typecheck`, `lint`, `test`, `build` in `--workspace web`)
- [ ] No secrets, `.env`, `vault.json`, `storage/`, or unlicensed/copyrighted media assets are included
- [ ] Relevant documentation (`README.md`, `README.en.md`, `docs/*.md`, or `assets/avatars/LICENSES.md`) updated if applicable
