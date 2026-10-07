[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$ProjectRoot = ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))),
    [string]$StatePath,
    [string]$ContinuationTaskName = 'RemoteMcpRebootAcceptance',
    [string]$ServiceTaskName = 'RemoteMcpServer',
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [Uri]$Endpoint = 'http://127.0.0.1:7331/mcp',
    [switch]$PrepareOnly,
    [switch]$AuthorizedSystemTest,
    [switch]$Reboot
)

$ErrorActionPreference = 'Stop'
$data = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$project = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
if ($data -eq [System.IO.Path]::GetPathRoot($data).TrimEnd('\')) { throw "DataRoot is too broad: $data" }
if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw "DataRoot does not exist: $data" }
if (-not (Test-Path -LiteralPath (Join-Path $project 'package.json') -PathType Leaf)) { throw "Invalid project root: $project" }
$database = Join-Path $data 'operational.db'
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Operational database is missing: $database" }
if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path $data 'reboot-acceptance-state.json' }
$state = [System.IO.Path]::GetFullPath($StatePath)
if ($Endpoint.Scheme -ne 'http' -or -not [System.Net.IPAddress]::IsLoopback(([System.Net.Dns]::GetHostAddresses($Endpoint.DnsSafeHost) | Select-Object -First 1))) {
    throw 'Reboot continuation endpoint must be loopback HTTP.'
}

if ($Reboot -and (-not $AuthorizedSystemTest -or $env:REMOTE_MCP_AUTHORIZED_REBOOT_TEST -ne '1')) {
    throw 'Live reboot requires -AuthorizedSystemTest and REMOTE_MCP_AUTHORIZED_REBOOT_TEST=1.'
}

$snapshotText = & $NodePath (Join-Path $PSScriptRoot 'read-persistence-state.mjs') $database
if ($LASTEXITCODE -ne 0) { throw 'Could not read persistence identity.' }
$snapshot = $snapshotText | ConvertFrom-Json
if ([int]$snapshot.activeGrants -lt 1) { throw 'The reboot test requires at least one active persistent grant.' }

$secretPath = Join-Path $data 'reboot-acceptance-hmac.key'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    $secret = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($secret) } finally { $generator.Dispose() }
    [System.IO.File]::WriteAllBytes($secretPath, $secret)
    [Array]::Clear($secret, 0, $secret.Length)
    if (-not $PrepareOnly) {
        $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $secretPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${currentIdentity}:R" | Out-Null
    }
}
$artifactPath = Join-Path $data 'reboot-acceptance-artifact.txt'
$nonce = [Guid]::NewGuid().ToString('N')
[System.IO.File]::WriteAllText($artifactPath, $nonce, [System.Text.UTF8Encoding]::new($false))
$payload = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    nonce = $nonce
    dataRoot = $data
    projectRoot = $project
    serviceTaskName = $ServiceTaskName
    continuationTaskName = $ContinuationTaskName
    endpoint = $Endpoint.AbsoluteUri
    deviceId = [string]$snapshot.deviceId
    securityEpoch = [int]$snapshot.securityEpoch
    activeGrants = [int]$snapshot.activeGrants
    artifactPath = $artifactPath
}
$payloadJson = $payload | ConvertTo-Json -Compress
$key = [System.IO.File]::ReadAllBytes($secretPath)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
try { $signature = [Convert]::ToBase64String($hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payloadJson))) }
finally { $hmac.Dispose(); [Array]::Clear($key, 0, $key.Length) }
$envelope = [ordered]@{ payload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payloadJson)); signature = $signature }
[System.IO.File]::WriteAllText($state, ($envelope | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))

if ($PrepareOnly) { Write-Output $state; return }
if (-not $AuthorizedSystemTest) { throw 'Registering reboot continuation requires -AuthorizedSystemTest.' }
$continueScript = Join-Path $PSScriptRoot 'continue-after-reboot.ps1'
$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$continueScript`" -StatePath `"$state`" -NodePath `"$NodePath`" -AuthorizedSystemTest"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $ContinuationTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ($Reboot -and $PSCmdlet.ShouldProcess($env:COMPUTERNAME, 'Reboot for signed persistence acceptance test')) {
    Restart-Computer -Force
}
Write-Output $state
