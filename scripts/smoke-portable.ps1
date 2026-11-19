[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$SmokeRoot = 'E:\Codex\cs-smoke',
    [ValidateRange(15, 300)][int]$TimeoutSeconds = 120,
    [switch]$KeepExtracted
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $PackagePath) {
    $candidate = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'outputs') -Filter 'Companion-Space-*-windows-x64.zip' |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $candidate) { throw 'No portable package was found under outputs. Run scripts/build-portable.ps1 first.' }
    $PackagePath = $candidate.FullName
}
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$smokeRootFull = [System.IO.Path]::GetFullPath($SmokeRoot).TrimEnd('\')
$allowedRoot = [System.IO.Path]::GetFullPath('E:\Codex').TrimEnd('\')
if (-not $smokeRootFull.StartsWith("$allowedRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "SmokeRoot must be a child of $allowedRoot."
}
$runRoot = Join-Path $smokeRootFull ([Guid]::NewGuid().ToString('N'))

function Stop-ProcessTree {
    param([int]$ProcessId)
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        & taskkill.exe /PID $ProcessId /T /F | Out-Null
    }
}

New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$process = $null
try {
    $checksumPath = "$package.sha256"
    if (Test-Path -LiteralPath $checksumPath -PathType Leaf) {
        $expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw "Package checksum mismatch: expected $expected, got $actual." }
    }
    Expand-Archive -LiteralPath $package -DestinationPath $runRoot -Force
    $start = Get-ChildItem -LiteralPath $runRoot -Filter 'start.ps1' -Recurse | Select-Object -First 1
    if (-not $start) { throw 'Portable package does not contain start.ps1.' }
    $packageRoot = $start.Directory.FullName
    $runtime = Join-Path $packageRoot 'runtime\python.exe'
    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'Portable Python runtime is missing.' }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $dataPath = Join-Path $runRoot 'isolated-data'

    $env:COMPANION_DATA_DIR = $dataPath
    $stdout = Join-Path $runRoot 'server.stdout.log'
    $stderr = Join-Path $runRoot 'server.stderr.log'
    $process = Start-Process powershell.exe -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $start.FullName,
        '-NoBrowser', '-Port', $port
    ) -WorkingDirectory $packageRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $health = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) {
            $errorText = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { '' }
            throw "Portable server exited with code $($process.ExitCode). $errorText"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
            if ($health.ok) { break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $health -or -not $health.ok) { throw "Portable /healthz did not become ready within $TimeoutSeconds seconds." }

    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/welcome" -UseBasicParsing -TimeoutSec 10
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<div id="root"></div>') {
        throw 'Portable UI smoke failed: /welcome did not return the built SPA shell.'
    }
    $db = Join-Path $dataPath 'companion.db'
    if (-not (Test-Path -LiteralPath $db -PathType Leaf)) { throw 'Portable runtime did not create its database in isolated storage.' }
    Write-Host "Portable smoke passed: healthz + UI on loopback port $port"
} finally {
    Remove-Item Env:COMPANION_DATA_DIR -ErrorAction SilentlyContinue
    if ($process) { Stop-ProcessTree -ProcessId $process.Id }
    if (-not $KeepExtracted -and (Test-Path -LiteralPath $runRoot)) {
        Remove-Item -LiteralPath $runRoot -Recurse -Force
    }
}

