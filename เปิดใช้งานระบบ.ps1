[CmdletBinding()]
param(
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\service\start.ps1') -TimeoutSeconds $TimeoutSeconds
