#Requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoPrefix = $repoRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
if (-not $scriptPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Windows smoke script is outside the repository root."
}
$scriptRelativePath = $scriptPath.Substring($repoPrefix.Length).Replace('\', '/')

$trackedShellFiles = @(& git -C $repoRoot ls-files -- "*.ps1" "*.sh")
if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed."
}
$shellFiles = @($trackedShellFiles + $scriptRelativePath | Sort-Object -Unique)
if ($shellFiles.Count -eq 0) {
    throw "No shell files were found."
}

$powerShellFileCount = 0
foreach ($relativePath in $shellFiles) {
    $attributeOutput = @(& git -C $repoRoot check-attr eol -- $relativePath)
    if ($LASTEXITCODE -ne 0 -or
        $attributeOutput.Count -ne 1 -or
        $attributeOutput[0] -notmatch ': eol: lf$') {
        throw "Shell files must declare eol=lf in .gitattributes: $relativePath"
    }

    $fullPath = [IO.Path]::GetFullPath(
        (Join-Path $repoRoot $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    )
    if (-not $fullPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "A shell file path is missing or escaped the repository: $relativePath"
    }
    $bytes = [IO.File]::ReadAllBytes($fullPath)
    if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
        throw "Shell files must contain LF line endings without CR bytes: $relativePath"
    }

    if ($relativePath.EndsWith(".ps1", [StringComparison]::OrdinalIgnoreCase)) {
        $tokens = $null
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseFile(
            $fullPath,
            [ref]$tokens,
            [ref]$parseErrors
        ) | Out-Null
        if ($parseErrors.Count -gt 0) {
            $detail = ($parseErrors | ForEach-Object { $_.Message }) -join "; "
            throw "PowerShell syntax errors in ${relativePath}: $detail"
        }
        $powerShellFileCount += 1
    }
}

Write-Host "Windows shell smoke passed: $($shellFiles.Count) LF files; $powerShellFileCount PowerShell files parsed."
