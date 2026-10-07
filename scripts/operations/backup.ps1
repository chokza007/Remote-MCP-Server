[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
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

$data = Get-CheckedRoot $DataRoot 'DataRoot'
$destination = Get-CheckedRoot $DestinationRoot 'DestinationRoot'
if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw "DataRoot does not exist: $data" }
if ($destination.StartsWith($data + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationRoot must not be inside DataRoot'
}
if (-not $Force -and -not $PSCmdlet.ShouldProcess($data, "Create integrity-checked backup under $destination")) { return }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$restartTask = $null -ne $task -and $task.State -ne 'Disabled'
$temporary = $null
try {
    if ($restartTask) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $identifier = [Guid]::NewGuid().ToString('N')
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $temporary = Join-Path $destination ".remote-mcp-backup-$identifier.tmp"
    $final = Join-Path $destination "backup-$timestamp-$($identifier.Substring(0, 8))"
    $filesRoot = Join-Path $temporary 'files'
    New-Item -ItemType Directory -Path $filesRoot -Force | Out-Null

    $manifestFiles = @()
    foreach ($source in Get-ChildItem -LiteralPath $data -Recurse -File -Force) {
        $relative = $source.FullName.Substring($data.Length).TrimStart('\')
        $target = Join-Path $filesRoot $relative
        New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        Copy-Item -LiteralPath $source.FullName -Destination $target -Force
        $copied = Get-Item -LiteralPath $target
        $manifestFiles += [ordered]@{
            path = $relative.Replace('\', '/')
            size = [long]$copied.Length
            sha256 = Get-Sha256 $target
        }
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        sourceRoot = $data
        files = @($manifestFiles | Sort-Object path)
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $temporary 'manifest.json'),
        ($manifest | ConvertTo-Json -Depth 8),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporary -Destination $final
    $temporary = $null
    Write-Output $final
} finally {
    if ($null -ne $temporary -and (Test-Path -LiteralPath $temporary)) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
    if ($restartTask) { Start-ScheduledTask -TaskName $TaskName }
}
