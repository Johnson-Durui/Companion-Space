[CmdletBinding()]
param(
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [switch]$Production
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-ProjectPython {
    $candidates = @()
    if ($env:COMPANION_PYTHON) {
        $candidates += $env:COMPANION_PYTHON
    } else {
        $candidates += (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
        $fromPath = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($fromPath) {
            $candidates += $fromPath.Source
        }
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate) -and -not (Get-Command $candidate -ErrorAction SilentlyContinue)) {
            continue
        }
        try {
            & $candidate -c "import sys; print(sys.executable)" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                return $candidate
            }
        } catch {
            continue
        }
    }
    throw "No usable project Python found. Create .venv or set COMPANION_PYTHON to a Python with services/api dependencies."
}

function Find-NpmCmd {
    $fromPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }
    throw "npm.cmd was not found. Install Node 24 and add it to PATH. Do not use pnpm."
}

if (-not (Test-Path "node_modules")) {
    throw "node_modules is missing. From the repo root run: npx.cmd --yes npm@11.21.2 ci"
}

$python = Find-ProjectPython
$npm = Find-NpmCmd
$apiUrl = "http://${ApiHost}:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"

$env:PYTHONPATH = "services/api"
$env:ALLOWED_ORIGINS = $webUrl
$env:APP_BASE_URL = $webUrl
$env:API_BASE_URL = $apiUrl
$env:NEXT_PUBLIC_API_BASE_URL = $apiUrl
$env:NEXT_PUBLIC_REALTIME_WS_URL = "$apiUrl/api/v1/sessions/:sessionId/realtime"

function Test-HttpSuccess([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Test-CompanionApi([string]$BaseUrl) {
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
            return $false
        }
        $payload = $response.Content | ConvertFrom-Json -ErrorAction Stop
        return $payload.ok -eq $true
    } catch {
        return $false
    }
}

function Test-ApiBrowserOrigin([string]$BaseUrl, [string]$BrowserOrigin) {
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/api/v1/vault/status" `
            -Method Options `
            -Headers @{
                Origin = $BrowserOrigin
                "Access-Control-Request-Method" = "GET"
            } `
            -UseBasicParsing `
            -TimeoutSec 3
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
            return $false
        }
        $allowedOrigin = [string]$response.Headers["Access-Control-Allow-Origin"]
        return $allowedOrigin -eq $BrowserOrigin
    } catch {
        return $false
    }
}

function Test-PortListening([int]$Port) {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$listeners
}

Write-Host "Starting Companion Space without Docker." -ForegroundColor Green
Write-Host "Mode $(if ($Production) { 'production build + start' } else { 'development' })" -ForegroundColor DarkGray
Write-Host "API  $apiUrl" -ForegroundColor DarkGray
Write-Host "Web  $webUrl" -ForegroundColor DarkGray
Write-Host "Open the Web URL after Next.js prints Ready. Four leads are painted-blender originals, not licensed samples." -ForegroundColor DarkGray
Write-Host "Healthy API/TTS on 8000/8001 are reused. This script never stops TTS." -ForegroundColor DarkGray

$webHealthy = Test-HttpSuccess $webUrl
$webListening = Test-PortListening $WebPort
if ($Production -and $webHealthy) {
    throw "Port $WebPort already serves HTTP. Production mode will not replace or reuse an unidentified Web process. Choose another -WebPort or stop that process yourself."
}
if (-not $webHealthy -and $webListening) {
    throw "Port $WebPort is listening but $webUrl is not answering HTTP (hung Next). Stop only that Next.js process, then rerun. Do not kill API/TTS."
}

$api = $null
$apiHealthy = Test-CompanionApi $apiUrl
if ($apiHealthy) {
    if (-not (Test-ApiBrowserOrigin $apiUrl $webUrl)) {
        throw "The Companion API at $apiUrl does not allow browser origin $webUrl. Choose matching ports or restart that API with ALLOWED_ORIGINS=$webUrl."
    }
    Write-Host "API already healthy — reusing $apiUrl, not starting another process." -ForegroundColor Green
} elseif (Test-PortListening $ApiPort) {
    throw "Port $ApiPort is listening but is not a compatible Companion API ($apiUrl/healthz must return 2xx with {`"ok`":true}). Not starting a second API."
} else {
    $localRuntimeDir = Join-Path $PSScriptRoot ".playwright\local-runtime"
    New-Item -ItemType Directory -Force -Path $localRuntimeDir | Out-Null
    $api = Start-Process -FilePath $python -ArgumentList @(
        "-m", "uvicorn", "app.main:app",
        "--host", $ApiHost,
        "--port", "$ApiPort"
    ) -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $localRuntimeDir "api.stdout.log") `
        -RedirectStandardError (Join-Path $localRuntimeDir "api.stderr.log")
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
    if ($Production) {
        $env:NEXT_DIST_DIR = ".next-local-production"
        Write-Host "Building the production Web bundle in apps/web/.next-local-production..." -ForegroundColor Cyan
        & $npm run build --workspace web
        if ($LASTEXITCODE -ne 0) {
            throw "Production Web build failed with exit code $LASTEXITCODE."
        }
        & $npm run start --workspace web -- --port $WebPort --hostname 127.0.0.1
    } else {
        & $npm run dev --workspace web -- --port $WebPort --hostname 127.0.0.1
    }
    exit $LASTEXITCODE
}
finally {
    if ($api -and -not $api.HasExited) {
        Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
    }
}
