[CmdletBinding()]
param(
    [ValidateSet('default', 'cn')][string]$Mirror = 'default',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$NoBrowser
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

$installOptions = @('-r', 'services/api/requirements.txt')
if ($Mirror -eq 'cn') { $installOptions += @('--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple') }
if ($uv) { & $uv.Source pip install --python $python @installOptions }
else { & $python -m pip install @installOptions }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

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
$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ArgumentList $url -ScriptBlock {
        param($address)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $status = Invoke-RestMethod -Uri "$address/healthz" -TimeoutSec 1 -ErrorAction Stop
                if ($status.ok) {
                    Start-Process $address
                    return
                }
            } catch {
                Start-Sleep -Milliseconds 250
            }
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
