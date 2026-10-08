[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$RequestId,
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'),
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Granting persistent Full Access requires an elevated Administrator PowerShell session.'
    }
}

Assert-Administrator
$data = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if ($data -eq [System.IO.Path]::GetPathRoot($data).TrimEnd('\')) {
    throw "DataRoot is too broad: $data"
}
$database = Join-Path $data 'operational.db'
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
    throw "Operational database is missing: $database"
}

$target = "request $RequestId in $database"
if (-not $Force -and -not $PSCmdlet.ShouldProcess($target, 'Grant persistent Full Access until revoked')) {
    return
}

$actor = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& $NodePath (Join-Path $PSScriptRoot 'grant-full-access.mjs') $database $RequestId $actor
if ($LASTEXITCODE -ne 0) {
    throw "Full Access grant failed with exit code $LASTEXITCODE"
}
