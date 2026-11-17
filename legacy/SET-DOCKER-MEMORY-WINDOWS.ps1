[CmdletBinding()]
param(
    [ValidateRange(4, 14)]
    [int]$MemoryGB = 14
)

$ErrorActionPreference = "Stop"

$targetPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".wslconfig"
$targetFullPath = [IO.Path]::GetFullPath($targetPath)
$expectedRoot = [IO.Path]::GetFullPath(([Environment]::GetFolderPath("UserProfile")))
if ([IO.Path]::GetDirectoryName($targetFullPath) -ne $expectedRoot) {
    throw "Refusing to edit an unexpected WSL configuration path: $targetFullPath"
}

$existing = if (Test-Path -LiteralPath $targetFullPath) {
    Get-Content -LiteralPath $targetFullPath -Raw
} else {
    ""
}

if ($existing -and $existing -notmatch '(?im)^[ \t]*\[wsl2\][ \t]*\r?$') {
    throw "$targetFullPath already exists without a [wsl2] section. Merge memory=${MemoryGB}GB manually so unrelated WSL settings are preserved."
}

$updated = if (-not $existing) {
    "[wsl2]`r`nmemory=${MemoryGB}GB`r`n"
} else {
    $sectionPattern = [regex]::new(
        '(?ims)^(?<header>[ \t]*\[wsl2\][ \t]*\r?\n)(?<body>.*?)(?=^[ \t]*\[[^\]]+\][ \t]*\r?$|\z)'
    )
    $section = $sectionPattern.Match($existing)
    if (-not $section.Success) {
        throw "Unable to parse the [wsl2] section in $targetFullPath without risking unrelated settings."
    }
    $body = $section.Groups["body"].Value
    $memoryPattern = [regex]::new('(?im)^[ \t]*memory[ \t]*=[^\r\n]*(?=\r?$)')
    $memoryMatches = $memoryPattern.Matches($body)
    if ($memoryMatches.Count -gt 1) {
        throw "The [wsl2] section in $targetFullPath has duplicate memory settings. Remove the duplicates manually before continuing."
    }
    $updatedBody = if ($memoryMatches.Count -eq 1) {
        $memoryPattern.Replace($body, "memory=${MemoryGB}GB", 1)
    } else {
        "memory=${MemoryGB}GB`r`n$body"
    }
    $replacement = $section.Groups["header"].Value + $updatedBody
    $existing.Substring(0, $section.Index) +
        $replacement +
        $existing.Substring($section.Index + $section.Length)
}

if ($existing -eq $updated) {
    Write-Host "WSL/Docker memory is already capped at ${MemoryGB}GB in $targetFullPath" -ForegroundColor Green
    exit 0
}

if ($existing) {
    $backupPath = "$targetFullPath.companion-space-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $targetFullPath -Destination $backupPath -Force
    Write-Host "Backed up the previous WSL configuration to $backupPath" -ForegroundColor DarkGray
}

[IO.File]::WriteAllText($targetFullPath, $updated, [Text.UTF8Encoding]::new($false))
Write-Host "Configured WSL/Docker memory to ${MemoryGB}GB in $targetFullPath" -ForegroundColor Green
Write-Host "Run 'wsl --shutdown', then restart Docker Desktop before starting Companion Space." -ForegroundColor Cyan
