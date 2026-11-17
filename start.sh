#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
port=8000
mirror=default
browser=yes
while [ "$#" -gt 0 ]; do
    case "$1" in
        --port) port="$2"; shift 2 ;;
        --mirror) mirror="$2"; shift 2 ;;
        --no-browser) browser=no; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done
case "$mirror" in default|cn) ;; *) printf '%s\n' 'Mirror must be default or cn.' >&2; exit 2 ;; esac
case "$port" in ''|*[!0-9]*) printf '%s\n' 'Port must be an integer.' >&2; exit 2 ;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    printf '%s\n' 'Port must be between 1 and 65535.' >&2
    exit 2
fi

venv_python=.venv/bin/python
if [ ! -x "$venv_python" ]; then
    if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
        printf '%s\n' 'Install Python 3.12 or later, then start again.' >&2
        exit 1
    fi
    if command -v uv >/dev/null 2>&1; then
        uv venv --python "$(command -v python3)" .venv
    else
        python3 -m venv .venv
    fi
fi
if ! "$venv_python" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
    printf '%s\n' '.venv requires Python 3.12 or later. Recreate the environment before starting.' >&2
    exit 1
fi

set -- -r services/api/requirements.txt
if [ "$mirror" = cn ]; then set -- "$@" --index-url https://pypi.tuna.tsinghua.edu.cn/simple; fi
if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$venv_python" "$@"
else
    "$venv_python" -m pip install "$@"
fi

if [ ! -f apps/web/dist/index.html ]; then
    if ! command -v npx >/dev/null 2>&1; then
        printf '%s\n' 'Install Node.js 24 to build the web app from source.' >&2
        exit 1
    fi
    npx --yes npm@11.21.2 ci
    npx --yes npm@11.21.2 run build --workspace web
fi

if ! "$venv_python" - "$port" <<'PY'
import socket
import sys

with socket.socket() as listener:
    if sys.platform == 'win32':
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(('127.0.0.1', int(sys.argv[1])))
        listener.listen(1)
    except OSError:
        raise SystemExit(1) from None
PY
then
    printf 'Cannot bind loopback port %s. Close the other app or choose a different port.\n' "$port" >&2
    exit 1
fi

export PYTHONPATH="$(pwd)/services/api"
if [ "$browser" = yes ]; then
    "$venv_python" - "$port" <<'PY' &
import sys
import time
import webbrowser
from urllib.error import URLError
from urllib.request import build_opener, ProxyHandler

address = f"http://127.0.0.1:{sys.argv[1]}"
opener = build_opener(ProxyHandler({}))
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        with opener.open(f"{address}/healthz", timeout=1) as response:
            if response.status == 200:
                webbrowser.open(address)
                break
    except URLError:
        time.sleep(0.25)
PY
fi
exec "$venv_python" -m uvicorn app.main:app --host 127.0.0.1 --port "$port" --no-proxy-headers
