[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'),
    [string]$TaskName = 'RemoteMcpServer',
    [string]$Reason = 'owner_emergency_stop',
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$data = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if ($data -eq [System.IO.Path]::GetPathRoot($data).TrimEnd('\')) { throw "DataRoot is too broad: $data" }
$database = Join-Path $data 'operational.db'
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Operational database is missing: $database" }
if ($Force) { $ConfirmPreference = 'None' }
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Activate emergency stop and stop the service task')) { return }

$timestamp = (Get-Date).ToUniversalTime().ToString('o')
$actor = "owner:$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
& $NodePath (Join-Path $PSScriptRoot 'emergency-stop.mjs') $database $timestamp $actor $Reason
if ($LASTEXITCODE -ne 0) { throw "Emergency stop database update failed with exit code $LASTEXITCODE" }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
Write-Output "Emergency stop active at $timestamp"
