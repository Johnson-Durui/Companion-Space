#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_name="${COMPOSE_PROJECT_NAME:-companion-space-smoke}"
http_port="${COMPANION_HTTP_PORT:-18080}"
https_port="${COMPANION_HTTPS_PORT:-18443}"
public_api_url="${NEXT_PUBLIC_API_BASE_URL:-/}"
public_realtime_url="${NEXT_PUBLIC_REALTIME_WS_URL:-/api/v1/sessions/:sessionId/realtime}"
compose=(
  docker compose
  --project-name "${project_name}"
  --file "${repo_root}/docker-compose.yml"
  --file "${repo_root}/infra/docker/docker-compose.smoke.yml"
)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

compose_build_output=""
if ! compose_build_output="$("${compose[@]}" build 2>&1)"; then
  printf '%s\n' "${compose_build_output}" >&2
  if [[
    "${compose_build_output}" != *"x-docker-expose-session-sharedkey"* &&
    "${compose_build_output}" != *"non-printable ASCII characters"*
  ]]; then
    exit 1
  fi

  echo "Docker Desktop BuildKit session is invalid; retrying the two local images with the legacy builder." >&2
  DOCKER_BUILDKIT=0 docker build \
    --file "${repo_root}/infra/docker/api.Dockerfile" \
    --tag "${project_name}-api" \
    "${repo_root}"
  DOCKER_BUILDKIT=0 docker build \
    --build-arg "NEXT_PUBLIC_API_BASE_URL=${public_api_url}" \
    --build-arg "NEXT_PUBLIC_REALTIME_WS_URL=${public_realtime_url}" \
    --file "${repo_root}/infra/docker/web.Dockerfile" \
    --tag "${project_name}-web" \
    "${repo_root}"
else
  printf '%s\n' "${compose_build_output}"
fi

COMPANION_HTTP_PORT="${http_port}" \
COMPANION_HTTPS_PORT="${https_port}" \
  "${compose[@]}" up --detach --no-build

health_url="https://companion.localhost:${https_port}/healthz"
app_url="https://companion.localhost:${https_port}/"
vault_status_url="https://companion.localhost:${https_port}/api/v1/vault/status"
realtime_probe_url="https://companion.localhost:${https_port}/api/v1/sessions/smoke-probe/realtime"
ready=false
for _ in $(seq 1 90); do
  if curl \
    --silent \
    --show-error \
    --fail \
    --insecure \
    --resolve "companion.localhost:${https_port}:127.0.0.1" \
    "${health_url}" >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "${ready}" != "true" ]]; then
  "${compose[@]}" ps
  "${compose[@]}" logs --no-color --tail 200
  exit 1
fi

running_services="$("${compose[@]}" ps --services --status running | sort)"
expected_services=$'api\ncaddy\nweb'
if [[ "${running_services}" != "${expected_services}" ]]; then
  "${compose[@]}" ps
  exit 1
fi

for service in api web; do
  if ! "${compose[@]}" exec --no-TTY "${service}" sh -c \
    'test ! -e /app/.env && test ! -d /app/.playwright && test ! -d /app/infra/caddy/data'; then
    echo "Sensitive local runtime paths leaked into the ${service} image." >&2
    exit 1
  fi
done

health_payload="$(
  curl \
    --silent \
    --show-error \
    --fail \
    --insecure \
    --resolve "companion.localhost:${https_port}:127.0.0.1" \
    "${health_url}"
)"
app_payload="$(
  curl \
    --silent \
    --show-error \
    --fail \
    --insecure \
    --resolve "companion.localhost:${https_port}:127.0.0.1" \
    "${app_url}"
)"
vault_status_payload="$(
  curl \
    --silent \
    --show-error \
    --fail \
    --insecure \
    --resolve "companion.localhost:${https_port}:127.0.0.1" \
    "${vault_status_url}"
)"
realtime_probe_status="$(
  curl \
    --silent \
    --show-error \
    --insecure \
    --http1.1 \
    --output /dev/null \
    --write-out "%{http_code}" \
    --resolve "companion.localhost:${https_port}:127.0.0.1" \
    --header "Connection: Upgrade" \
    --header "Upgrade: websocket" \
    --header "Origin: https://companion.localhost:${https_port}" \
    --header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    --header "Sec-WebSocket-Version: 13" \
    "${realtime_probe_url}"
)"

if [[ "${health_payload}" != *'"ok":true'* ]]; then
  echo "Unexpected health payload: ${health_payload}" >&2
  exit 1
fi
if [[ "${app_payload}" != *"Companion Space"* ]]; then
  echo "Companion Space shell was not present in the HTTPS response." >&2
  exit 1
fi
if [[ "${app_payload}" != *"/_next/static/"* ]]; then
  echo "The Next.js application assets were not linked from the HTTPS response." >&2
  exit 1
fi
if [[ "${vault_status_payload}" != *'"initialized":false'* ]]; then
  echo "Unexpected proxied vault status payload: ${vault_status_payload}" >&2
  exit 1
fi
if [[ "${realtime_probe_status}" != "403" ]]; then
  echo "Realtime WebSocket probe did not reach the ticket guard (HTTP ${realtime_probe_status})." >&2
  exit 1
fi

echo "Docker smoke passed: caddy + api + web + WebSocket guard via ${app_url}"
