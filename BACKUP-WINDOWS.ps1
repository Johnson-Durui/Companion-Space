#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$OnlineDatabaseOnly,
    [string]$DestinationRoot = ""
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BasePath
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "A filesystem path cannot be empty."
    }
    if (-not [IO.Path]::IsPathRooted($Path)) {
        $Path = Join-Path $BasePath $Path
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-PathAtOrBelow {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $candidatePath = $Candidate.TrimEnd([char[]]@('\', '/'))
    $rootPath = $Root.TrimEnd([char[]]@('\', '/'))
    if ($candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidatePath.StartsWith(
        $rootPath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-NoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $current = [IO.Path]::GetFullPath($Path)
    while ($null -ne $current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Backup paths cannot use a symlink or junction: $current"
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            break
        }
        $current = $parent.FullName
    }
}

function Get-SafeTreeFiles {
    param([Parameter(Mandatory = $true)][string]$Root)

    $pending = New-Object System.Collections.Stack
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = [string]$pending.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $fullPath = [IO.Path]::GetFullPath($entry)
            if (-not (Test-PathAtOrBelow -Candidate $fullPath -Root $Root)) {
                throw "A backup entry escaped its expected root: $fullPath"
            }
            $attributes = [IO.File]::GetAttributes($fullPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Backup trees cannot contain a symlink or junction: $fullPath"
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($fullPath)
                continue
            }
            [PSCustomObject]@{
                FullPath = $fullPath
                RelativePath = $fullPath.Substring($Root.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
            }
        }
    }
}

function Copy-StorageTree {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][string[]]$ExcludedPaths
    )

    $pending = New-Object System.Collections.Stack
    $pending.Push($SourceRoot)
    while ($pending.Count -gt 0) {
        $sourceDirectory = [string]$pending.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($sourceDirectory)) {
            $sourcePath = [IO.Path]::GetFullPath($entry)
            if (-not (Test-PathAtOrBelow -Candidate $sourcePath -Root $SourceRoot)) {
                throw "A storage entry escaped its expected root: $sourcePath"
            }
            $attributes = [IO.File]::GetAttributes($sourcePath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Storage cannot contain a symlink or junction during backup: $sourcePath"
            }
            $relativePath = $sourcePath.Substring($SourceRoot.Length).TrimStart([char[]]@('\', '/'))
            $destinationPath = [IO.Path]::GetFullPath((Join-Path $DestinationRoot $relativePath))
            if (-not (Test-PathAtOrBelow -Candidate $destinationPath -Root $DestinationRoot)) {
                throw "A copied entry escaped the partial backup directory: $destinationPath"
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                if (-not (Test-Path -LiteralPath $destinationPath)) {
                    [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
                }
                $pending.Push($sourcePath)
                continue
            }
            if ($ExcludedPaths -contains $sourcePath) {
                continue
            }
            [IO.File]::Copy($sourcePath, $destinationPath, $false)
        }
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-DockerCommand {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $script:DockerExecutable @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        $detail = (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = "no command output"
        }
        throw "docker $($Arguments -join ' ') failed with exit code ${exitCode}: $detail"
    }
    return $output
}

function Convert-LastOutputLineFromJson {
    param(
        [Parameter(Mandatory = $true)][object[]]$Output,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    $lines = @($Output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0) {
        throw "$Operation returned no JSON output."
    }
    try {
        return $lines[$lines.Count - 1] | ConvertFrom-Json
    }
    catch {
        throw "$Operation did not return valid JSON on its last output line: $($lines[$lines.Count - 1])"
    }
}

function Invoke-SqliteMaintenance {
    param(
        [Parameter(Mandatory = $true)][string]$PartialPath,
        [Parameter(Mandatory = $true)][string[]]$Command
    )

    $volume = "${PartialPath}:/app/backup"
    $arguments = @(
        "compose", "run", "--rm", "--no-deps",
        "--volume", $volume,
        "--env", "OBJECT_STORAGE_PATH=/app/storage",
        "api", "python", "-m", "app.sqlite_maintenance"
    ) + $Command
    $output = @(Invoke-DockerCommand -Arguments $arguments)
    return Convert-LastOutputLineFromJson -Output $output -Operation "SQLite maintenance"
}

function Write-AndVerifyManifest {
    param(
        [Parameter(Mandatory = $true)][string]$PartialPath,
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][object]$DatabaseResult
    )

    $manifestPath = Join-Path $PartialPath "backup-manifest.json"
    if (Test-Path -LiteralPath $manifestPath) {
        throw "The new partial backup unexpectedly contains backup-manifest.json."
    }
    $files = @(
        Get-SafeTreeFiles -Root $PartialPath |
            Sort-Object RelativePath |
            ForEach-Object {
                $item = Get-Item -LiteralPath $_.FullPath -Force
                [ordered]@{
                    path = $_.RelativePath
                    size_bytes = [Int64]$item.Length
                    sha256 = Get-Sha256 -Path $_.FullPath
                }
            }
    )
    $manifest = [ordered]@{
        format_version = 1
        created_at_utc = [DateTimeOffset]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        mode = $Mode
        complete_application_backup = ($Mode -eq "full")
        not_full_application_backup = ($Mode -ne "full")
        database = [ordered]@{
            filename = [string]$DatabaseResult.database_filename
            user_version = [int]$DatabaseResult.user_version
            integrity_check = [string]$DatabaseResult.integrity_check
            foreign_key_violation_count = [int]$DatabaseResult.foreign_key_violation_count
        }
        files = $files
    }
    $json = $manifest | ConvertTo-Json -Depth 6
    $stream = [IO.File]::Open(
        $manifestPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $writer = New-Object IO.StreamWriter($stream, $encoding)
        try {
            $writer.Write($json)
        }
        finally {
            $writer.Dispose()
        }
    }
    catch {
        $stream.Dispose()
        throw
    }

    $parsed = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $declaredFiles = @($parsed.files)
    $actualFiles = @(
        Get-SafeTreeFiles -Root $PartialPath |
            Where-Object { $_.RelativePath -ne "backup-manifest.json" }
    )
    if ($declaredFiles.Count -ne $actualFiles.Count) {
        throw "Backup manifest file count verification failed."
    }
    $actualByPath = @{}
    foreach ($file in $actualFiles) {
        if ($actualByPath.ContainsKey($file.RelativePath)) {
            throw "Backup contains duplicate case-insensitive paths: $($file.RelativePath)"
        }
        $actualByPath[$file.RelativePath] = $file.FullPath
    }
    $declaredPaths = @{}
    foreach ($entry in $declaredFiles) {
        $relativePath = [string]$entry.path
        if ($declaredPaths.ContainsKey($relativePath)) {
            throw "Backup manifest contains a duplicate path: $relativePath"
        }
        $declaredPaths[$relativePath] = $true
        if (-not $actualByPath.ContainsKey($relativePath)) {
            throw "Backup manifest references a missing file: $relativePath"
        }
        $fullPath = [string]$actualByPath[$relativePath]
        $item = Get-Item -LiteralPath $fullPath -Force
        if ([Int64]$entry.size_bytes -ne [Int64]$item.Length) {
            throw "Backup manifest size verification failed: $relativePath"
        }
        if (-not ([string]$entry.sha256).Equals((Get-Sha256 -Path $fullPath), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Backup manifest SHA-256 verification failed: $relativePath"
        }
    }
    return $manifestPath
}

$repoRoot = Get-NormalizedPath -Path $PSScriptRoot -BasePath $PSScriptRoot
Assert-NoReparsePoint -Path $repoRoot
Set-Location -LiteralPath $repoRoot

if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $DestinationRoot = Join-Path $repoRoot "backups"
}

$storagePath = Get-NormalizedPath -Path (Join-Path $repoRoot "storage") -BasePath $repoRoot
if (-not (Test-Path -LiteralPath $storagePath -PathType Container)) {
    throw "Companion Space storage directory does not exist: $storagePath"
}
Assert-NoReparsePoint -Path $storagePath
Get-SafeTreeFiles -Root $storagePath | Out-Null

$destinationPath = Get-NormalizedPath -Path $DestinationRoot -BasePath $repoRoot
$filesystemRoot = [IO.Path]::GetPathRoot($destinationPath).TrimEnd([char[]]@('\', '/'))
if ($destinationPath.Equals($filesystemRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The backup destination cannot be a filesystem root: $destinationPath"
}
if (Test-PathAtOrBelow -Candidate $destinationPath -Root $storagePath) {
    throw "The backup destination must be outside Companion Space storage: $destinationPath"
}
Assert-NoReparsePoint -Path $destinationPath
if (Test-Path -LiteralPath $destinationPath) {
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
        throw "The backup destination is not a directory: $destinationPath"
    }
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -eq $dockerCommand) {
    $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
}
if ($null -eq $dockerCommand -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $fallbackDocker = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $fallbackDocker -PathType Leaf) {
        $script:DockerExecutable = $fallbackDocker
    }
}
if (-not (Test-Path Variable:script:DockerExecutable)) {
    if ($null -eq $dockerCommand) {
        throw "Docker CLI was not found. Install and start Docker Desktop first."
    }
    $script:DockerExecutable = $dockerCommand.Source
}

Invoke-DockerCommand -Arguments @("info") | Out-Null
Invoke-DockerCommand -Arguments @("compose", "version") | Out-Null
Invoke-DockerCommand -Arguments @("compose", "config", "--quiet") | Out-Null

if (-not (Test-Path -LiteralPath $destinationPath)) {
    [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
}
Assert-NoReparsePoint -Path $destinationPath

$mode = "full"
if ($OnlineDatabaseOnly) {
    $mode = "online-database-only"
}
$backupName = "companion-space-$mode-$([DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$finalPath = [IO.Path]::GetFullPath((Join-Path $destinationPath $backupName))
$partialPath = "${finalPath}.partial"
if (-not (Test-PathAtOrBelow -Candidate $finalPath -Root $destinationPath) -or
    -not (Test-PathAtOrBelow -Candidate $partialPath -Root $destinationPath)) {
    throw "The generated backup path escaped the destination root."
}
if ((Test-Path -LiteralPath $finalPath) -or (Test-Path -LiteralPath $partialPath)) {
    throw "The generated backup target is not unique: $backupName"
}
[IO.Directory]::CreateDirectory($partialPath) | Out-Null
$partialStoragePath = Join-Path $partialPath "storage"
[IO.Directory]::CreateDirectory($partialStoragePath) | Out-Null
Assert-NoReparsePoint -Path $partialPath

$apiWasRunning = $false
$operationFailure = $null
$published = $false
try {
    if (-not $OnlineDatabaseOnly) {
        $runningOutput = @(Invoke-DockerCommand -Arguments @("compose", "ps", "--status", "running", "--quiet", "api"))
        $runningIds = @(
            $runningOutput |
                ForEach-Object { ([string]$_).Trim() } |
                Where-Object { $_ -match '^[0-9a-fA-F]{12,64}$' }
        )
        $apiWasRunning = $runningIds.Count -gt 0
        if ($apiWasRunning) {
            Write-Host "Stopping the API for a consistent full backup..." -ForegroundColor Cyan
            Invoke-DockerCommand -Arguments @("compose", "stop", "api") | Out-Null
        }
        $checkpoint = Invoke-SqliteMaintenance -PartialPath $partialPath -Command @("checkpoint", "--mode", "TRUNCATE")
        if ($null -eq $checkpoint.PSObject.Properties["busy"] -or [int]$checkpoint.busy -ne 0) {
            throw "SQLite TRUNCATE checkpoint remained busy; the full backup was not published."
        }
    }

    $databaseResult = Invoke-SqliteMaintenance -PartialPath $partialPath -Command @(
        "backup", "--destination-directory", "/app/backup/storage"
    )
    if ($null -eq $databaseResult.PSObject.Properties["database_filename"]) {
        throw "SQLite backup output did not include database_filename."
    }
    $databaseFilename = [string]$databaseResult.database_filename
    if ([string]::IsNullOrWhiteSpace($databaseFilename) -or
        [IO.Path]::IsPathRooted($databaseFilename) -or
        -not ([IO.Path]::GetFileName($databaseFilename)).Equals($databaseFilename, [StringComparison]::Ordinal)) {
        throw "SQLite backup returned an unsafe database filename: $databaseFilename"
    }
    $sourceDatabase = [IO.Path]::GetFullPath((Join-Path $storagePath $databaseFilename))
    $backupDatabase = [IO.Path]::GetFullPath((Join-Path $partialStoragePath $databaseFilename))
    if (-not (Test-PathAtOrBelow -Candidate $sourceDatabase -Root $storagePath) -or
        -not (Test-PathAtOrBelow -Candidate $backupDatabase -Root $partialStoragePath)) {
        throw "SQLite backup paths escaped their expected storage roots."
    }
    if (-not (Test-Path -LiteralPath $sourceDatabase -PathType Leaf) -or
        -not (Test-Path -LiteralPath $backupDatabase -PathType Leaf)) {
        throw "SQLite source or backup database is missing."
    }
    Assert-NoReparsePoint -Path $sourceDatabase
    Assert-NoReparsePoint -Path $backupDatabase
    if ([string]$databaseResult.integrity_check -ne "ok" -or
        [int]$databaseResult.foreign_key_violation_count -ne 0) {
        throw "SQLite backup validation did not report a clean database."
    }
    $backupDatabaseItem = Get-Item -LiteralPath $backupDatabase -Force
    if ([Int64]$databaseResult.size_bytes -ne [Int64]$backupDatabaseItem.Length -or
        -not ([string]$databaseResult.sha256).Equals((Get-Sha256 -Path $backupDatabase), [StringComparison]::OrdinalIgnoreCase)) {
        throw "SQLite backup size or SHA-256 did not match the maintenance result."
    }

    if (-not $OnlineDatabaseOnly) {
        $excludedDatabaseFiles = @($sourceDatabase, "${sourceDatabase}-wal", "${sourceDatabase}-shm")
        Copy-StorageTree `
            -SourceRoot $storagePath `
            -DestinationRoot $partialStoragePath `
            -ExcludedPaths $excludedDatabaseFiles
    }

    $manifestPath = Write-AndVerifyManifest `
        -PartialPath $partialPath `
        -Mode $mode `
        -DatabaseResult $databaseResult
    Assert-NoReparsePoint -Path $manifestPath
    if (Test-Path -LiteralPath $finalPath) {
        throw "The final backup path appeared before publication: $finalPath"
    }
    [IO.Directory]::Move($partialPath, $finalPath)
    $published = $true
}
catch {
    $operationFailure = $_
    if (Test-Path -LiteralPath $partialPath) {
        Write-Warning "Backup failed. The partial directory was preserved at: $partialPath"
    }
}
finally {
    if ($apiWasRunning) {
        try {
            Write-Host "Restoring the API service..." -ForegroundColor Cyan
            Invoke-DockerCommand -Arguments @("compose", "start", "api") | Out-Null
        }
        catch {
            if ($null -eq $operationFailure) {
                $operationFailure = $_
            }
            else {
                Write-Warning "The backup failed and the API could not be restarted: $($_.Exception.Message)"
            }
        }
    }
}

if ($null -ne $operationFailure) {
    if ($published) {
        Write-Warning "The backup was published before a later operation failed: $finalPath"
    }
    throw $operationFailure
}

Write-Host "Backup completed and verified: $finalPath" -ForegroundColor Green
Write-Host "Manifest: $(Join-Path $finalPath 'backup-manifest.json')" -ForegroundColor DarkGray
