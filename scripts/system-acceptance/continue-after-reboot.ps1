[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$AuthorizedSystemTest,
    [switch]$Simulate
)

$ErrorActionPreference = 'Stop'
$state = [System.IO.Path]::GetFullPath($StatePath)
if (-not (Test-Path -LiteralPath $state -PathType Leaf)) { throw "Signed state is missing: $state" }
$envelope = Get-Content -Raw -LiteralPath $state | ConvertFrom-Json
$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$envelope.payload))
$payload = $payloadJson | ConvertFrom-Json
$secretPath = Join-Path ([string]$payload.dataRoot) 'reboot-acceptance-hmac.key'
$key = [System.IO.File]::ReadAllBytes($secretPath)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
try { $expected = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payloadJson)) }
finally { $hmac.Dispose(); [Array]::Clear($key, 0, $key.Length) }
$presented = [Convert]::FromBase64String([string]$envelope.signature)
if ($expected.Length -ne $presented.Length) { throw 'Signed reboot state is invalid.' }
$difference = 0
for ($index = 0; $index -lt $expected.Length; $index++) { $difference = $difference -bor ($expected[$index] -bxor $presented[$index]) }
if ($difference -ne 0) { throw 'Signed reboot state is invalid.' }
if (((Get-Date).ToUniversalTime() - [DateTime]::Parse([string]$payload.createdAt).ToUniversalTime()).TotalHours -gt 24) { throw 'Signed reboot state is stale.' }
if (-not $Simulate -and -not $AuthorizedSystemTest) { throw 'Live continuation requires -AuthorizedSystemTest.' }
if ((Get-Content -Raw -LiteralPath ([string]$payload.artifactPath)) -ne [string]$payload.nonce) { throw 'Reboot artifact integrity check failed.' }

$database = Join-Path ([string]$payload.dataRoot) 'operational.db'
$snapshotText = & $NodePath (Join-Path $PSScriptRoot 'read-persistence-state.mjs') $database
if ($LASTEXITCODE -ne 0) { throw 'Could not read persistence identity after reboot.' }
$snapshot = $snapshotText | ConvertFrom-Json
if ([string]$snapshot.deviceId -ne [string]$payload.deviceId) { throw 'Device identity changed across reboot.' }
if ([int]$snapshot.securityEpoch -ne [int]$payload.securityEpoch) { throw 'Security epoch changed across reboot.' }
if ([int]$snapshot.activeGrants -lt [int]$payload.activeGrants) { throw 'Persistent grant count decreased across reboot.' }

$report = [ordered]@{
    schemaVersion = 1
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    deviceId = [string]$snapshot.deviceId
    securityEpoch = [int]$snapshot.securityEpoch
    activeGrants = [int]$snapshot.activeGrants
    simulated = [bool]$Simulate
    result = 'PASS'
}
$reportPath = Join-Path ([string]$payload.dataRoot) 'reboot-acceptance-result.json'
[System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
if (-not $Simulate) {
    $task = Get-ScheduledTask -TaskName ([string]$payload.continuationTaskName) -ErrorAction SilentlyContinue
    if ($null -ne $task) { Unregister-ScheduledTask -TaskName ([string]$payload.continuationTaskName) -Confirm:$false }
}
Write-Output $reportPath
