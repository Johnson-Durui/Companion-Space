[CmdletBinding()]
param(
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-ProjectPython {
    $candidates = @(
        (Join-Path $PSScriptRoot ".venv\Scripts\python.exe"),
        "D:\Codex\venvs\companion-space-api\Scripts\python.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    $fromPath = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }
    throw "No project Python found. Create .venv and install services/api/requirements.txt first."
}

function Find-NpmCmd {
    $fromPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }
    $portable = "D:\Codex\node-v24.14.0\npm.cmd"
    if (Test-Path -LiteralPath $portable) {
        return $portable
    }
    throw "npm.cmd was not found. Install Node 24 or add it to PATH. Do not use pnpm."
}

if (-not (Test-Path "node_modules")) {
    throw "node_modules is missing. From the repo root run: npm.cmd ci"
}

$python = Find-ProjectPython
$npm = Find-NpmCmd
$apiUrl = "http://${ApiHost}:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"

$env:PYTHONPATH = "services/api"
$env:NEXT_PUBLIC_API_BASE_URL = $apiUrl
$env:NEXT_PUBLIC_REALTIME_WS_URL = "$apiUrl/api/v1/sessions/:sessionId/realtime"

function Test-HttpOk([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Test-PortListening([int]$Port) {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$listeners
}

Write-Host "Starting Companion Space without Docker." -ForegroundColor Green
Write-Host "API  $apiUrl" -ForegroundColor DarkGray
Write-Host "Web  $webUrl" -ForegroundColor DarkGray
Write-Host "Open the Web URL after Next.js prints Ready. Four leads are painted-blender originals, not licensed samples." -ForegroundColor DarkGray
Write-Host "Healthy API/TTS on 8000/8001 are reused. This script never stops TTS." -ForegroundColor DarkGray

$webHealthy = Test-HttpOk $webUrl
$webListening = Test-PortListening $WebPort
if (-not $webHealthy -and $webListening) {
    throw "Port $WebPort is listening but $webUrl is not answering HTTP (hung Next). Stop only that Next.js process, then rerun. Do not kill API/TTS."
}

$api = $null
$apiHealthy = Test-HttpOk "$apiUrl/healthz"
if ($apiHealthy) {
    Write-Host "API already healthy — reusing $apiUrl, not starting another process." -ForegroundColor Green
} elseif (Test-PortListening $ApiPort) {
    throw "Port $ApiPort is listening but $apiUrl/healthz failed. Not starting a second API. Do not kill TTS on 8001."
} else {
    $api = Start-Process -FilePath $python -ArgumentList @(
        "-m", "uvicorn", "app.main:app",
        "--host", $ApiHost,
        "--port", "$ApiPort"
    ) -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow
}

if ($webHealthy) {
    Write-Host "Web already healthy — open $webUrl" -ForegroundColor Green
    if (-not $api) {
        exit 0
    }
    Write-Host "Keep this window open. Press Ctrl+C to stop only the API this script started." -ForegroundColor DarkGray
    try {
        Wait-Process -Id $api.Id
        exit $api.ExitCode
    } finally {
        if ($api -and -not $api.HasExited) {
            Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    & $npm run dev --workspace web -- --port $WebPort --hostname 127.0.0.1
    exit $LASTEXITCODE
}
finally {
    if ($api -and -not $api.HasExited) {
        Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
    }
}
