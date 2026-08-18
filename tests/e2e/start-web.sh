#!/usr/bin/env bash
set -euo pipefail

web_port="$1"
api_base_url="$2"
ws_base_url="$3"

export NEXT_PUBLIC_API_BASE_URL="${api_base_url}"
export NEXT_PUBLIC_REALTIME_WS_URL="${ws_base_url}"
export NEXT_PUBLIC_E2E_AUDIO_HOOK="1"

rm -rf apps/web/.next

exec npm run dev --workspace web -- --hostname 127.0.0.1 --port "${web_port}"
