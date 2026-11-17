[CmdletBinding()]
param(
    [switch]$Frontend,
    [switch]$Contract
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$python = '.venv\Scripts\python.exe'
$env:PYTHONPATH = 'services/api'
$env:OBJECT_STORAGE_PATH = Join-Path ([IO.Path]::GetTempPath()) ('companion-gate-' + [guid]::NewGuid().ToString('N'))

& $python -m ruff check services/api
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $python -m pytest services/api/tests -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Contract) {
    npm.cmd run generate:api:check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Frontend) {
    & $python scripts/check_no_fakes.py
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    foreach ($task in @('typecheck', 'lint', 'test', 'build')) {
        npm.cmd run $task --workspace web
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
