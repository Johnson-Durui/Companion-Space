[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [switch]$SkipWslMemoryCheck
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$wslConfigPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".wslconfig"
if (-not $SkipWslMemoryCheck) {
    if (-not (Test-Path -LiteralPath $wslConfigPath)) {
        throw "Docker/WSL memory is not capped. Run .\SET-DOCKER-MEMORY-WINDOWS.ps1 once, then retry."
    }
    $wslConfig = Get-Content -LiteralPath $wslConfigPath -Raw
    $wslSectionPattern = [regex]::new(
        '(?ims)^(?<header>[ \t]*\[wsl2\][ \t]*\r?\n)(?<body>.*?)(?=^[ \t]*\[[^\]]+\][ \t]*\r?$|\z)'
    )
    $wslSection = $wslSectionPattern.Match($wslConfig)
    $memoryPattern = [regex]::new(
        '(?im)^[ \t]*memory[ \t]*=[ \t]*(?<gb>\d+)[ \t]*GB[ \t]*(?=\r?$)'
    )
    $memoryMatches = if ($wslSection.Success) {
        $memoryPattern.Matches($wslSection.Groups["body"].Value)
    } else {
        @()
    }
    if (
        -not $wslSection.Success -or
        $memoryMatches.Count -ne 1 -or
        [int]$memoryMatches[0].Groups["gb"].Value -gt 14
    ) {
        throw "Expected a WSL memory cap of 14GB or less in $wslConfigPath. Run .\SET-DOCKER-MEMORY-WINDOWS.ps1 once, then retry."
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found. Install and start Docker Desktop with the WSL 2 backend first."
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is installed but its engine is not running. Start Docker Desktop and retry."
}

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose v2 is unavailable. Update Docker Desktop and retry."
}

if ((-not (Test-Path ".env")) -or ((Get-Item ".env").Length -eq 0)) {
    Copy-Item ".env.example" ".env" -Force
    Write-Host "Created .env from .env.example." -ForegroundColor Cyan
}

& docker compose config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "docker compose config failed. Review .env and docker-compose.yml."
}

if (-not $env:COMPOSE_PARALLEL_LIMIT) {
    $env:COMPOSE_PARALLEL_LIMIT = "1"
}

if ($BuildOnly) {
    & docker compose build
    exit $LASTEXITCODE
}

Write-Host "Starting Companion Space at https://companion.localhost" -ForegroundColor Green
Write-Host "Keep this window open. Press Ctrl+C to stop the stack." -ForegroundColor DarkGray
Write-Host "Building one image at a time inside the 14 GB WSL/Docker cap." -ForegroundColor DarkGray
& docker compose build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
& docker compose up
exit $LASTEXITCODE
