[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$DataRoot = "$env:ProgramData\Remote-MCP-Server",
    [string]$TaskName = 'RemoteMcpServer',
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$data = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if ($data -eq [System.IO.Path]::GetPathRoot($data).TrimEnd('\')) { throw "DataRoot is too broad: $data" }
$database = Join-Path $data 'operational.db'
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Operational database is missing: $database" }
if (-not $Force -and -not $PSCmdlet.ShouldProcess($data, 'Rotate security epoch and invalidate every grant and OAuth token')) { return }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$restartTask = $null -ne $task -and $task.State -ne 'Disabled'
try {
    if ($restartTask) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }
    $timestamp = (Get-Date).ToUniversalTime().ToString('o')
    & $NodePath (Join-Path $PSScriptRoot 'security-reset.mjs') $database $timestamp
    if ($LASTEXITCODE -ne 0) { throw "Security reset database update failed with exit code $LASTEXITCODE" }
    foreach ($name in @('owner-token.txt', 'oauth-signing-key.txt', 'local-development-token.txt')) {
        $path = Join-Path $data $name
        $temporary = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
        $bytes = New-Object byte[] 48
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        [System.IO.File]::WriteAllText($temporary, [Convert]::ToBase64String($bytes), [System.Text.UTF8Encoding]::new($false))
        [Array]::Clear($bytes, 0, $bytes.Length)
        Move-Item -LiteralPath $temporary -Destination $path -Force
    }
    Write-Output "Security reset complete at $timestamp; all clients must authorize again."
} finally {
    if ($restartTask) { Start-ScheduledTask -TaskName $TaskName }
}
