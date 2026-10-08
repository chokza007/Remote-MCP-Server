[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$TaskName = 'RemoteMcpServer',
    [string]$ProjectRoot,
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'),
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [ValidatePattern('^https://')]
    [string]$PublicOrigin,
    [switch]$SkipBuild,
    [switch]$SkipTunnelClient
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Installation requires an elevated Administrator PowerShell session.'
    }
}

Assert-Administrator
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Join-Path $PSScriptRoot '..\..'
}
$project = [System.IO.Path]::GetFullPath($ProjectRoot)
$data = [System.IO.Path]::GetFullPath($DataRoot)
$systemDataRoot = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('CommonApplicationData')).TrimEnd('\')
$userProfileRoot = [Environment]::GetFolderPath('UserProfile')
$protectedRoots = @(
    [System.IO.Path]::GetPathRoot($data).TrimEnd('\'),
    $systemDataRoot
)
if (-not [string]::IsNullOrWhiteSpace($userProfileRoot)) {
    $protectedRoots += [System.IO.Path]::GetFullPath($userProfileRoot).TrimEnd('\')
}
if ($data.TrimEnd('\') -in $protectedRoots) { throw "DataRoot is too broad: $data" }
if (-not (Test-Path -LiteralPath (Join-Path $project 'package.json') -PathType Leaf)) {
    throw "ProjectRoot is not a Remote MCP checkout: $project"
}
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Install persistent Remote MCP startup task')) { return }

New-Item -ItemType Directory -Path $data -Force | Out-Null
if (-not $SkipBuild) {
    & npm.cmd --prefix $project ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    & npm.cmd --prefix $project run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
}
if (-not $SkipTunnelClient) {
    & (Join-Path $project 'scripts\tunnel\install-client.ps1') -ProjectRoot $project
    if ($LASTEXITCODE -ne 0) { throw "Tunnel client installation failed with exit code $LASTEXITCODE" }
}

$ownerTokenPath = Join-Path $data 'owner-token.txt'
$signingKeyPath = Join-Path $data 'oauth-signing-key.txt'
foreach ($path in @($ownerTokenPath, $signingKeyPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $bytes = New-Object byte[] 48
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        [System.IO.File]::WriteAllText($path, [Convert]::ToBase64String($bytes))
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}
& (Join-Path $PSScriptRoot 'protect-data.ps1') -DataRoot $data -SecretPath @($ownerTokenPath, $signingKeyPath)

$arguments = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + (Join-Path $PSScriptRoot 'runner.ps1') + '"'),
    '-ProjectRoot', ('"' + $project + '"'),
    '-DataRoot', ('"' + $data + '"'),
    '-NodePath', ('"' + ([System.IO.Path]::GetFullPath($NodePath)) + '"')
)
if ($PublicOrigin) { $arguments += @('-PublicOrigin', ('"' + $PublicOrigin + '"')) }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($arguments -join ' ')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Write-Host "Owner token: $ownerTokenPath"
Write-Host "OAuth signing key: $signingKeyPath"
