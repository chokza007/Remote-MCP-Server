[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'),
    [string]$TaskName = 'RemoteMcpServer',
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 30,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Emergency Stop recovery requires an elevated Administrator PowerShell session.'
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
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { throw "Task is not installed: $TaskName" }

if ($Force) { $ConfirmPreference = 'None' }
if (-not $PSCmdlet.ShouldProcess($TaskName, "Clear the owner Emergency Stop and restart MCP service")) {
    return
}

$timestamp = (Get-Date).ToUniversalTime().ToString('o')
$actor = "owner:$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
& $NodePath (Join-Path $PSScriptRoot 'clear-emergency-stop.mjs') $database $timestamp $actor
if ($LASTEXITCODE -ne 0) {
    throw "Emergency Stop clear failed with exit code $LASTEXITCODE"
}
& (Join-Path $PSScriptRoot '..\service\start.ps1') -TaskName $TaskName -TimeoutSeconds $TimeoutSeconds
Write-Output "Emergency Stop cleared at $timestamp"
