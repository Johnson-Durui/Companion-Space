#!/usr/bin/env bash
set -euo pipefail
exec node tests/e2e/start-api.mjs "$@"
