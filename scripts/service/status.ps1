[CmdletBinding()]
param(
    [string]$TaskName = 'RemoteMcpServer',
    [string]$DataRoot = "$env:ProgramData\Remote-MCP-Server"
)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{ Installed = $false; TaskName = $TaskName; State = 'NotInstalled'; DataRoot = $DataRoot }
    return
}
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    Installed = $true
    TaskName = $TaskName
    State = [string]$task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
    DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
}
