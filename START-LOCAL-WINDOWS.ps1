[CmdletBinding()]
param(
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [string]$PythonPath,
    [string]$NpmPath
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-Executable([string]$Candidate, [string[]]$Arguments) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        return $false
    }
    & $Candidate @Arguments *> $null
    return $LASTEXITCODE -eq 0
}

function Find-ProjectPython([string]$RequestedPath) {
    if ($RequestedPath) {
        $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RequestedPath)
        if (-not (Test-Executable $resolved @("--version"))) {
            throw "PythonPath is not an executable Python interpreter: $resolved"
        }
        return $resolved
    }
    $candidates = @(
        (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Executable $candidate @("--version")) {
            return $candidate
        }
    }
    foreach ($commandName in @("python.exe", "python3.exe")) {
        $fromPath = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($fromPath -and (Test-Executable $fromPath.Source @("--version"))) {
            return $fromPath.Source
        }
    }
    throw "No usable Python found. Create .venv, install services/api/requirements.txt, or pass -PythonPath."
}

function Find-NpmCmd([string]$RequestedPath) {
    if ($RequestedPath) {
        $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RequestedPath)
        if (-not (Test-Executable $resolved @("--version"))) {
            throw "NpmPath is not an executable npm command: $resolved"
        }
        return $resolved
    }
    foreach ($commandName in @("npm.cmd", "npm")) {
        $fromPath = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($fromPath -and (Test-Executable $fromPath.Source @("--version"))) {
            return $fromPath.Source
        }
    }
    throw "npm was not found. Install Node 24, add npm to PATH, or pass -NpmPath. Do not use pnpm."
}

if (-not (Test-Path "node_modules")) {
    throw "node_modules is missing. From the repo root run: npm.cmd ci"
}

$python = Find-ProjectPython $PythonPath
$npm = Find-NpmCmd $NpmPath
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
Write-Host "Open the Web URL after Next.js prints Ready. All six leads are original project assets; four use painted-blender models." -ForegroundColor DarkGray
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
    $localLogRoot = Join-Path $PSScriptRoot ".playwright"
    New-Item -ItemType Directory -Path $localLogRoot -Force | Out-Null
    $api = Start-Process -FilePath $python -ArgumentList @(
        "-m", "uvicorn", "app.main:app",
        "--host", $ApiHost,
        "--port", "$ApiPort"
    ) -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $localLogRoot "local-api.stdout.log") `
        -RedirectStandardError (Join-Path $localLogRoot "local-api.stderr.log")

    $apiReady = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        if ($api.HasExited) {
            throw "API exited before becoming healthy. See .playwright/local-api.stderr.log."
        }
        if (Test-HttpOk "$apiUrl/healthz") {
            $apiReady = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $apiReady) {
        Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
        throw "API did not become healthy within 60 seconds. See .playwright/local-api.stderr.log."
    }
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
