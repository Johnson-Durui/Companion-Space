[CmdletBinding()]
param(
    [ValidateSet('default', 'cn')][string]$Mirror = 'default',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 6)
$reviewDataDir = Join-Path ([IO.Path]::GetTempPath()) "companion-space-review-$stamp-$suffix"
New-Item -ItemType Directory -Path $reviewDataDir -Force | Out-Null

$env:COMPANION_DATA_DIR = $reviewDataDir
Write-Host "Review data directory: $reviewDataDir"
Write-Host "Real user data will not be modified."

$startScript = Join-Path $repoRoot 'start.ps1'
& $startScript -Mirror $Mirror -Port $Port -NoBrowser:$NoBrowser
exit $LASTEXITCODE
