#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found."
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker engine is not running."
}

Write-Host "Starting existing neural-tts image on 127.0.0.1:8001 (no rebuild)." -ForegroundColor Green
& docker compose -f docker-compose.yml -f docker-compose.neural-host.yml --profile neural-tts up -d --no-build neural-tts
if ($LASTEXITCODE -ne 0) {
    throw "Failed to start neural-tts from the existing image."
}

Write-Host "Health: http://127.0.0.1:8001/healthz  (status=ready means the model is loaded)" -ForegroundColor DarkGray
Write-Host "The local API should use LOCAL_NEURAL_TTS_BASE_URL=http://127.0.0.1:8001" -ForegroundColor DarkGray
