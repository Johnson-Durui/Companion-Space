[CmdletBinding()]
param(
    [ValidateSet('default', 'cn')][string]$Mirror = 'default',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$NoBrowser,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$uv = Get-Command uv.exe -ErrorAction SilentlyContinue
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$versionCheck = 'import sys; sys.exit(sys.version_info < (3, 12))'

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    $interpreter = $null
    $candidates = @(
        @{ Name = 'py.exe'; Arguments = @('-3') }
        @{ Name = 'python3.exe'; Arguments = @() }
        @{ Name = 'python.exe'; Arguments = @() }
    )
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        $probeArguments = $candidate.Arguments + @(
            '-c',
            'import sys; print(sys.executable) if sys.version_info >= (3, 12) else sys.exit(1)'
        )
        $found = & $command.Source @probeArguments
        if ($LASTEXITCODE -eq 0 -and $found -and (Test-Path -LiteralPath $found -PathType Leaf)) {
            $interpreter = $found
            break
        }
    }
    if (-not $interpreter) { throw 'Install Python 3.12 or later, then start again.' }
    if ($uv) { & $uv.Source venv --python $interpreter .venv }
    else { & $interpreter -m venv .venv }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $python -c $versionCheck
if ($LASTEXITCODE -ne 0) { throw '.venv requires Python 3.12 or later. Recreate the environment before starting.' }

$requirementsFile = Join-Path $PSScriptRoot 'services/api/requirements.txt'
$requirementsStamp = Join-Path $PSScriptRoot '.venv\.requirements.sha256'
$requirementsHash = (Get-FileHash -LiteralPath $requirementsFile -Algorithm SHA256).Hash.ToLowerInvariant()
$importCheck = @'
import sys
try:
    import fastapi
    import uvicorn
except Exception:
    sys.exit(1)
'@
$needsInstall = $Reinstall.IsPresent
if (-not $needsInstall) {
    $savedHash = ''
    if (Test-Path -LiteralPath $requirementsStamp -PathType Leaf) {
        $rawHash = Get-Content -LiteralPath $requirementsStamp -Raw
        if ($null -ne $rawHash) { $savedHash = $rawHash.Trim().ToLowerInvariant() }
    }
    if ($savedHash -ne $requirementsHash) {
        $needsInstall = $true
    } else {
        & $python -c $importCheck
        if ($LASTEXITCODE -ne 0) {
            $needsInstall = $true
        }
    }
}
if ($needsInstall) {
    $installOptions = @('-r', $requirementsFile)
    if ($Mirror -eq 'cn') { $installOptions += @('--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple') }
    if ($uv) { & $uv.Source pip install --python $python @installOptions }
    else { & $python -m pip install @installOptions }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Set-Content -LiteralPath $requirementsStamp -Value $requirementsHash -NoNewline -Encoding ASCII
}

if (-not (Test-Path -LiteralPath 'apps/web/dist/index.html' -PathType Leaf)) {
    if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 24 to build the web app from source.'
    }
    npx.cmd --yes npm@11.21.2 ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npx.cmd --yes npm@11.21.2 run build --workspace web
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$portCheck = @'
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
'@
& $python -c $portCheck $Port
if ($LASTEXITCODE -ne 0) {
    throw "Cannot bind loopback port $Port. Close the other app or choose a different port."
}

$env:PYTHONPATH = Join-Path $PSScriptRoot 'services/api'
$url = "http://127.0.0.1:$Port"
$healthPoll = @'
import json
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

address = sys.argv[1]
opener = build_opener(ProxyHandler({}))
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        with opener.open(f'{address}/healthz', timeout=1) as response:
            if response.status == 200:
                payload = json.loads(response.read().decode('utf-8'))
                if isinstance(payload, dict) and payload.get('ok'):
                    raise SystemExit(0)
    except (URLError, OSError, ValueError):
        pass
    time.sleep(0.25)
raise SystemExit(1)
'@
$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ArgumentList $url, $python, $healthPoll -ScriptBlock {
        param($address, $py, $script)
        & $py -c $script $address
        if ($LASTEXITCODE -eq 0) {
            Start-Process $address
        }
    }
}
try {
    & $python -m uvicorn app.main:app --host 127.0.0.1 --port $Port --no-proxy-headers
    exit $LASTEXITCODE
} finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job -Job $browserJob -ErrorAction SilentlyContinue
    }
}
