[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$ServiceName = 'RemoteMcpPrivilegedBroker',
    [string]$DataRoot = "$env:ProgramData\Remote-MCP-Server\Broker"
)

$service = Get-CimInstance Win32_Service -Filter "Name='$($ServiceName.Replace("'", "''"))'" -ErrorAction SilentlyContinue
$auditPath = Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'audit.jsonl'
[pscustomobject]@{
    Name = $ServiceName
    Installed = $null -ne $service
    State = if ($null -eq $service) { 'not_installed' } else { [string]$service.State }
    StartMode = if ($null -eq $service) { $null } else { [string]$service.StartMode }
    ProcessId = if ($null -eq $service -or $service.ProcessId -eq 0) { $null } else { [int]$service.ProcessId }
    AuditPath = $auditPath
    AuditExists = Test-Path -LiteralPath $auditPath -PathType Leaf
}
