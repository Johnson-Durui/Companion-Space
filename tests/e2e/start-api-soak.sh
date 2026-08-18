#!/usr/bin/env bash
set -euo pipefail

api_port="$1"
web_port="$2"
storage_root="$3"
repo_root="$(pwd -P)"

python_bin="python3"
if [ -x ".venv/bin/python" ]; then
  python_bin=".venv/bin/python"
fi

mkdir -p "${repo_root}/.playwright"
playwright_root="$(cd "${repo_root}/.playwright" && pwd -P)"
if [ "${playwright_root}" != "${repo_root}/.playwright" ]; then
  echo "Refusing to use a symlinked .playwright root" >&2
  exit 1
fi
storage_relative="${storage_root#./}"
storage_name="${storage_relative#.playwright/}"
if [ "${storage_relative}" = "${storage_name}" ] \
  || [[ ! "${storage_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Soak storage must be one named child of .playwright" >&2
  exit 1
fi
storage_abs="${playwright_root}/${storage_name}"

rm -rf -- "${storage_abs}"
mkdir -p "${storage_abs}"
printf '%s\n' "$$" > "${storage_abs}/api.pid"

export PYTHONPATH="services/api"
export OBJECT_STORAGE_PATH="${storage_root}"
export APP_BASE_URL="http://127.0.0.1:${web_port}"
export API_BASE_URL="http://127.0.0.1:${api_port}"
export ALLOWED_ORIGINS="http://127.0.0.1:${web_port}"
export AUDIO_PERSIST_ENABLED="false"

exec "${python_bin}" -m uvicorn app.main:app \
  --host 127.0.0.1 \
  --port "${api_port}" \
  >> "${storage_abs}/api.log" 2>&1
