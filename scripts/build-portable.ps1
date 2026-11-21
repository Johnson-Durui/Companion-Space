[CmdletBinding()]
param(
    [ValidateSet('default', 'cn')][string]$Mirror = 'default',
    [string]$OutputDirectory,
    [switch]$SkipWebBuild,
    [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$version = '1.0.0-rc.2'
$pythonVersion = '3.14.10'
$pythonArchive = "python-$pythonVersion-embed-amd64.zip"
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/$pythonArchive"
$pythonSha256 = '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutputDirectory = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $root 'outputs' }
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$work = Join-Path $output '.portable-work'
$cache = Join-Path $work 'cache'
$stage = Join-Path $work "Companion-Space-$version-windows-x64"
$runtime = Join-Path $stage 'runtime'
$artifactName = "Companion-Space-$version-windows-x64"
$artifactDirectory = Join-Path $output $artifactName
$artifactZip = Join-Path $output "$artifactName.zip"
$hostPython = Join-Path $root '.venv\Scripts\python.exe'

function Invoke-Checked {
    param([Parameter(Mandatory)][scriptblock]$Command, [Parameter(Mandatory)][string]$Failure)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Failure (exit code $LASTEXITCODE)" }
}

function Copy-Tree {
    param([Parameter(Mandatory)][string]$RelativePath)
    $source = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $source)) { throw "Required path is missing: $RelativePath" }
    $destination = Join-Path $stage $RelativePath
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

if ($env:OS -ne 'Windows_NT') { throw 'The portable Windows package must be built on Windows.' }
if (-not (Test-Path -LiteralPath $hostPython -PathType Leaf)) {
    throw 'Create the project .venv with Python 3.14 x64 before building the portable package.'
}

$pythonProbe = & $hostPython -c "import platform,sys; print(f'{sys.version_info.major}.{sys.version_info.minor}|{platform.machine()}')"
if ($LASTEXITCODE -ne 0 -or $pythonProbe.Trim() -notmatch '^3\.14\|(AMD64|x86_64)$') {
    throw "The build .venv must use Python 3.14 x64; found '$pythonProbe'."
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Path $cache, $runtime -Force | Out-Null

if (-not $SkipWebBuild) {
    $npm = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'Node.js 24 with npx.cmd is required to build the web app.' }
    Push-Location $root
    try {
        Invoke-Checked { & $npm.Source --yes npm@11.21.2 ci } 'npm ci failed'
        Invoke-Checked { & $npm.Source --yes npm@11.21.2 run build --workspace web } 'Web build failed'
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\web\dist\index.html') -PathType Leaf)) {
    throw 'apps/web/dist/index.html is missing. Build the web app or omit -SkipWebBuild.'
}

$archivePath = Join-Path $cache $pythonArchive
Invoke-WebRequest -Uri $pythonUrl -OutFile $archivePath -UseBasicParsing
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $pythonSha256) {
    throw "Embedded Python checksum mismatch: expected $pythonSha256, got $actualHash."
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $runtime -Force

$pth = Get-ChildItem -LiteralPath $runtime -Filter 'python*._pth' | Select-Object -First 1
if (-not $pth) { throw 'Embedded Python path configuration was not found.' }
@(
    'python314.zip'
    '.'
    'Lib'
    'Lib\site-packages'
    '..\services\api'
    'import site'
) | Set-Content -LiteralPath $pth.FullName -Encoding ascii

$sitePackages = Join-Path $runtime 'Lib\site-packages'
New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
$pipArgs = @(
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--only-binary=:all:',
    '--target', $sitePackages, '-r', (Join-Path $root 'services\api\requirements.txt')
)
if ($Mirror -eq 'cn') { $pipArgs += @('--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple') }
Invoke-Checked { & $hostPython @pipArgs } 'Portable dependency installation failed'

$copyApplication = "import shutil, sys; shutil.copytree(sys.argv[1], sys.argv[2], ignore=shutil.ignore_patterns('__pycache__', '*.py[co]'))"
Invoke-Checked {
    & $hostPython -c $copyApplication (Join-Path $root 'services\api\app') (Join-Path $stage 'services\api\app')
} 'Application source copy failed'
Copy-Tree 'services\api\requirements.txt'
Copy-Tree 'services\api\requirements-local-stt.txt'
Copy-Tree 'apps\web\dist'
Copy-Tree 'libs\prompts'
Copy-Tree 'libs\schemas'
Copy-Tree 'assets\avatars'
Copy-Tree 'assets\THIRD_PARTY_NOTICES.md'
Copy-Tree 'content\characters'
Copy-Tree 'content\sample-course'
Copy-Tree 'content\speech'
Copy-Tree 'LICENSE'
Copy-Tree 'NOTICE'
Copy-Tree 'README.md'
Copy-Tree 'README.en.md'
Copy-Tree 'CHANGELOG.md'
Copy-Tree 'docs\images\sample-lesson.png'
Copy-Tree 'docs\images\six-anime-tutors.jpg'
New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null

# All six active built-in anime tutor anchor portraits (xuechuan, shenyan, lanyue,
# chutang, qingheng, lanyin) are owner-created original assets registered under Apache-2.0.
@'
# Portable asset eligibility

All six active built-in anime tutor anchor portraits (`xuechuan.webp`,
`shenyan.webp`, `lanyue.webp`, `chutang.webp`, `qingheng.webp`, `lanyin.webp`)
and any verified `.tutorpack` clips registered under `assets/avatars/packs/`
are covered by `assets/avatars/LICENSES.md` and `assets/THIRD_PARTY_NOTICES.md`.

Retired 3D VRM models (`assets-archive/retired-vrm/`) and retired legacy
portraits (`assets-archive/retired-portraits/`) are excluded from this package.
'@ | Set-Content -LiteralPath (Join-Path $stage 'PORTABLE-ASSET-STATUS.md') -Encoding utf8

$portableStart = @'
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot 'runtime\python.exe'
$data = if ($env:COMPANION_DATA_DIR) { $env:COMPANION_DATA_DIR } else { Join-Path $PSScriptRoot 'data' }
$url = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Path $data -Force | Out-Null
$portCheck = @"
import socket
import sys

with socket.socket() as listener:
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    listener.bind(('127.0.0.1', int(sys.argv[1])))
"@
& $python -c $portCheck $Port
if ($LASTEXITCODE -ne 0) { throw "Cannot bind loopback port $Port. Close the other app or choose a different port." }

$env:APP_ENV = 'production'
$env:APP_BASE_URL = $url
$env:API_BASE_URL = $url
$env:COMPANION_DATA_DIR = $data
$env:PYTHONPATH = Join-Path $PSScriptRoot 'services\api'

$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ArgumentList $url -ScriptBlock {
        param($address)
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            try {
                $health = Invoke-RestMethod -Uri "$address/healthz" -TimeoutSec 1
                if ($health.ok) { Start-Process "$address/welcome"; return }
            } catch { Start-Sleep -Milliseconds 250 }
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
'@
$portableStart | Set-Content -LiteralPath (Join-Path $stage 'start.ps1') -Encoding ascii
@(
    '@echo off'
    'setlocal'
    'cd /d "%~dp0"'
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*'
    'if errorlevel 1 pause'
) | Set-Content -LiteralPath (Join-Path $stage 'start.bat') -Encoding ascii

if (Test-Path -LiteralPath $artifactDirectory) { Remove-Item -LiteralPath $artifactDirectory -Recurse -Force }
if (Test-Path -LiteralPath $artifactZip) { Remove-Item -LiteralPath $artifactZip -Force }
Move-Item -LiteralPath $stage -Destination $artifactDirectory
Compress-Archive -LiteralPath $artifactDirectory -DestinationPath $artifactZip -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $artifactZip -Algorithm SHA256).Hash.ToLowerInvariant()
"$zipHash  $([System.IO.Path]::GetFileName($artifactZip))" | Set-Content -LiteralPath "$artifactZip.sha256" -Encoding ascii

if (-not $KeepStaging -and (Test-Path -LiteralPath $work)) {
    Remove-Item -LiteralPath $work -Recurse -Force
}
Write-Host "Portable package: $artifactZip"
Write-Host "SHA256: $zipHash"

