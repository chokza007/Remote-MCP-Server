[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Join-Path $PSScriptRoot '..\..'
}
$project = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $project 'package.json') -PathType Leaf)) {
    throw "ProjectRoot is not a Remote MCP checkout: $project"
}

$destination = [System.IO.Path]::GetFullPath((Join-Path $project 'tools\tunnel-client'))
$projectPrefix = $project + '\'
if (-not $destination.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Tunnel client destination must remain inside ProjectRoot: $destination"
}

$architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'X64' { 'amd64' }
    'Arm64' { 'arm64' }
    default { throw "Unsupported Windows architecture: $($_)" }
}

$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'Remote-MCP-Server-Tunnel-Installer'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest' -Headers $headers
$assetName = "tunnel-client-$($release.tag_name)-windows-$architecture.zip"
$asset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
$checksumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
if ($null -eq $asset -or $null -eq $checksumAsset) {
    throw "The official release does not contain $assetName or SHA256SUMS.txt"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$installedVersionPath = Join-Path $destination 'VERSION.txt'
$installedVersion = if (Test-Path -LiteralPath $installedVersionPath -PathType Leaf) {
    (Get-Content -LiteralPath $installedVersionPath -Raw).Trim()
} else {
    ''
}
$installedExe = Join-Path $destination 'tunnel-client.exe'
$installedArchive = Join-Path $destination $assetName
if (-not $Force -and $installedVersion -eq $release.tag_name -and
    (Test-Path -LiteralPath $installedExe -PathType Leaf) -and
    (Test-Path -LiteralPath $installedArchive -PathType Leaf)) {
    [pscustomobject]@{
        Status = 'AlreadyCurrent'
        Version = $release.tag_name
        Executable = $installedExe
        Archive = $installedArchive
    }
    return
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("remote-mcp-tunnel-client-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    $downloadedArchive = Join-Path $staging $assetName
    $downloadedChecksums = Join-Path $staging 'SHA256SUMS.txt'
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $downloadedArchive -UseBasicParsing
    Invoke-WebRequest -Uri $checksumAsset.browser_download_url -Headers $headers -OutFile $downloadedChecksums -UseBasicParsing

    $checksumLine = Get-Content -LiteralPath $downloadedChecksums |
        Where-Object { $_ -match ([regex]::Escape($assetName) + '$') } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw "Official checksum entry is missing for $assetName"
    }
    $expectedHash = (($checksumLine -split '\s+')[0]).ToLowerInvariant()
    $actualHash = Get-Sha256Hex -Path $downloadedArchive
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 verification failed for $assetName"
    }

    $extracted = Join-Path $staging 'extracted'
    Expand-Archive -LiteralPath $downloadedArchive -DestinationPath $extracted -Force
    $sourceExe = Get-ChildItem -LiteralPath $extracted -Filter 'tunnel-client.exe' -Recurse -File |
        Select-Object -First 1
    if ($null -eq $sourceExe) {
        throw "tunnel-client.exe is missing from $assetName"
    }

    Copy-Item -LiteralPath $sourceExe.FullName -Destination $installedExe -Force
    Copy-Item -LiteralPath $downloadedArchive -Destination $installedArchive -Force
    Copy-Item -LiteralPath $downloadedChecksums -Destination (Join-Path $destination 'SHA256SUMS.txt') -Force
    [System.IO.File]::WriteAllText($installedVersionPath, "$($release.tag_name)`r`n")
    [System.IO.File]::WriteAllText(
        (Join-Path $destination 'SOURCE.txt'),
        "$($asset.browser_download_url)`r`nSHA256=$actualHash`r`n"
    )

    $reportedVersion = (& $installedExe --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Installed tunnel-client failed its version check with exit code $LASTEXITCODE"
    }
    [pscustomobject]@{
        Status = 'Installed'
        Version = $release.tag_name
        ReportedVersion = $reportedVersion
        Sha256 = $actualHash
        Executable = $installedExe
        Archive = $installedArchive
    }
} finally {
    $stagingFull = [System.IO.Path]::GetFullPath($staging)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($stagingFull.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $stagingFull) -like 'remote-mcp-tunnel-client-*') {
        Remove-Item -LiteralPath $stagingFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}
