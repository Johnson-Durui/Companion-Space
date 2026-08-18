#!/usr/bin/env bash
set -euo pipefail

api_port="$1"
web_port="$2"
storage_root="$3"
repo_root="$(pwd)"
allowed_prefix="${repo_root}/.playwright/"

python_bin="python3"
if [ -x ".venv/bin/python" ]; then
  python_bin=".venv/bin/python"
fi

mkdir -p .playwright
storage_abs="${repo_root}/${storage_root#./}"
case "${storage_abs}" in
  "${allowed_prefix}"*)
    if [ "${storage_abs}" = "${repo_root}/.playwright" ] || [ "${storage_abs}" = "${repo_root}/.playwright/" ]; then
      echo "Refusing to use .playwright root as storage target" >&2
      exit 1
    fi
    ;;
  *)
    echo "Refusing to clear storage outside ${allowed_prefix}" >&2
    exit 1
    ;;
esac
rm -rf -- "${storage_abs}"

export PYTHONPATH="services/api"
export OBJECT_STORAGE_PATH="${storage_root}"
export APP_BASE_URL="http://127.0.0.1:${web_port}"
export API_BASE_URL="http://127.0.0.1:${api_port}"
export ALLOWED_ORIGINS="http://127.0.0.1:${web_port}"

exec "${python_bin}" -m uvicorn app.main:app --host 127.0.0.1 --port "${api_port}"
