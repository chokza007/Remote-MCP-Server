[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [string]$PublicOrigin
)

$ErrorActionPreference = 'Stop'
$project = [System.IO.Path]::GetFullPath($ProjectRoot)
$data = [System.IO.Path]::GetFullPath($DataRoot)
Set-Location -LiteralPath $project
$env:REMOTE_MCP_DATA_ROOT = $data
$env:REMOTE_MCP_OWNER_TOKEN_FILE = Join-Path $data 'owner-token.txt'
$env:REMOTE_MCP_SIGNING_KEY_FILE = Join-Path $data 'oauth-signing-key.txt'
if ($PublicOrigin) { $env:REMOTE_MCP_PUBLIC_ORIGIN = $PublicOrigin }

while ($true) {
    & $NodePath (Join-Path $project 'apps\server\dist\service-main.js')
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath (Join-Path $data 'service-restarts.log') -Value "$(Get-Date -Format o) exit=$exitCode"
    Start-Sleep -Seconds 5
}
