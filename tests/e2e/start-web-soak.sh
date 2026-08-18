#!/usr/bin/env bash
set -euo pipefail

web_port="$1"

if [ ! -f "apps/web/.next/BUILD_ID" ]; then
  echo "Production web build is missing. Run npm run build:web before the soak." >&2
  exit 1
fi

exec npm run start --workspace web -- --hostname 127.0.0.1 --port "${web_port}"
