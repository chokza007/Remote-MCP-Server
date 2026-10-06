[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$ServiceName = 'RemoteMcpPrivilegedBroker',
    [string]$InstallRoot = "$env:ProgramFiles\Remote-MCP-Server\Broker",
    [switch]$RemoveOperationalData,
    [string]$DataRoot = "$env:ProgramData\Remote-MCP-Server\Broker"
)

$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Broker removal requires an elevated Administrator PowerShell session.'
}

$resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedData = [System.IO.Path]::GetFullPath($DataRoot)
$forbidden = @(
    [System.IO.Path]::GetPathRoot($resolvedInstall).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
)
if ($forbidden -contains $resolvedInstall.TrimEnd('\') -or $forbidden -contains $resolvedData.TrimEnd('\')) {
    throw 'Refusing to remove a broad system or profile directory.'
}
if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop and delete privileged broker service')) {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $service) {
        if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed with exit code $LASTEXITCODE" }
    }
    if (Test-Path -LiteralPath $resolvedInstall) {
        Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
    }
    if ($RemoveOperationalData -and (Test-Path -LiteralPath $resolvedData)) {
        Remove-Item -LiteralPath $resolvedData -Recurse -Force
    }
}
