#!/usr/bin/env bash
set -euo pipefail
web_port="$1"
api_base_url="${NEXT_PUBLIC_API_BASE_URL:-http://127.0.0.1:8200}"
ws_base_url="${NEXT_PUBLIC_REALTIME_WS_URL:-ws://127.0.0.1:8200/api/v1/sessions/:sessionId/realtime}"
exec node tests/e2e/start-web.mjs production "${web_port}" "${api_base_url}" "${ws_base_url}"
