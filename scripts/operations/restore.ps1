[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$TaskName = 'RemoteMcpServer',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-CheckedRoot([string]$Path, [string]$Name) {
    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\')) {
        throw "$Name must not be a filesystem root: $resolved"
    }
    return $resolved
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

$backup = Get-CheckedRoot $BackupRoot 'BackupRoot'
$data = Get-CheckedRoot $DataRoot 'DataRoot'
$manifestPath = Join-Path $backup 'manifest.json'
$filesRoot = Join-Path $backup 'files'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Backup manifest is missing: $manifestPath" }
if (-not (Test-Path -LiteralPath $filesRoot -PathType Container)) { throw "Backup files are missing: $filesRoot" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw "Unsupported backup manifest schema: $($manifest.schemaVersion)" }

# Verify the entire manifest before touching live data.
foreach ($entry in @($manifest.files)) {
    $relative = [string]$entry.path
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative -split '[\\/]' -contains '..') {
        throw "Backup manifest contains an unsafe path: $relative"
    }
    $source = [System.IO.Path]::GetFullPath((Join-Path $filesRoot $relative))
    if (-not $source.StartsWith($filesRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Backup manifest path escapes the files root: $relative"
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Backup file is missing: $relative" }
    $item = Get-Item -LiteralPath $source
    if ([long]$item.Length -ne [long]$entry.size) { throw "Backup integrity size mismatch: $relative" }
    $hash = Get-Sha256 $source
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Backup integrity hash mismatch (tampered): $relative" }
}

if (-not $Force -and -not $PSCmdlet.ShouldProcess($data, "Restore verified backup $backup")) { return }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$restartTask = $null -ne $task -and $task.State -ne 'Disabled'
$parent = [System.IO.Path]::GetDirectoryName($data)
$identifier = [Guid]::NewGuid().ToString('N')
$stage = Join-Path $parent ".remote-mcp-restore-stage-$identifier"
$rollback = Join-Path $parent ".remote-mcp-restore-rollback-$identifier"
$liveMoved = $false
try {
    if ($restartTask) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $filesRoot -Force) {
        Copy-Item -LiteralPath $child.FullName -Destination $stage -Recurse -Force
    }
    if (Test-Path -LiteralPath $data) {
        Move-Item -LiteralPath $data -Destination $rollback
        $liveMoved = $true
    }
    Move-Item -LiteralPath $stage -Destination $data
    if ($liveMoved) { Remove-Item -LiteralPath $rollback -Recurse -Force }
    $liveMoved = $false
    Write-Output $data
} catch {
    if ($liveMoved -and -not (Test-Path -LiteralPath $data) -and (Test-Path -LiteralPath $rollback)) {
        Move-Item -LiteralPath $rollback -Destination $data
        $liveMoved = $false
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($restartTask) { Start-ScheduledTask -TaskName $TaskName }
}
