[CmdletBinding()]
param(
    [string]$TaskName = 'RemoteMcpServer',
    [ValidatePattern('^http://127\.0\.0\.1(?::\d+)?/')]
    [string]$Endpoint = 'http://127.0.0.1:7331/',
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    throw "Remote MCP is not installed. Run scripts\service\install.ps1 once from Administrator PowerShell."
}

if ($task.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$response = $null
do {
    try {
        $response = Invoke-WebRequest -Uri $Endpoint -UseBasicParsing -TimeoutSec 2
        break
    } catch {
        Start-Sleep -Milliseconds 250
    }
} while ((Get-Date) -lt $deadline)

if ($null -eq $response -or $response.StatusCode -ne 200) {
    $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $state = if ($null -eq $currentTask) { 'Missing' } else { [string]$currentTask.State }
    throw "Remote MCP did not become healthy within $TimeoutSeconds seconds. Task state: $state"
}

$currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
[pscustomobject]@{
    TaskName = $TaskName
    State = [string]$currentTask.State
    HttpStatus = [int]$response.StatusCode
    Endpoint = $Endpoint
}
