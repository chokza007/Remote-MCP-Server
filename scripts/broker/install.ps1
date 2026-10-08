[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$AuthorizationStatePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublicKey,

    [string]$CallerSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value),
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$ServiceName = 'RemoteMcpPrivilegedBroker',
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$PipeName = 'remote-mcp-privileged-v1',
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Remote-MCP-Server\Broker'),
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server\Broker')
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Broker installation requires an elevated Administrator PowerShell session.'
    }
}

function Assert-SafeManagedDirectory([string]$Path, [string]$Purpose) {
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $forbidden = @(
        [System.IO.Path]::GetPathRoot($full).TrimEnd('\'),
        [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('ProgramFiles')).TrimEnd('\'),
        [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('CommonApplicationData')).TrimEnd('\'),
        [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')
    )
    if ($forbidden -contains $full) { throw "$Purpose path is too broad: $full" }
}

$resolvedProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\broker\RemoteMcp.Broker.csproj'))
$resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedData = [System.IO.Path]::GetFullPath($DataRoot)
$resolvedAuthorization = [System.IO.Path]::GetFullPath($AuthorizationStatePath)
Assert-SafeManagedDirectory $resolvedInstall 'Install'
Assert-SafeManagedDirectory $resolvedData 'Data'
$auditPath = Join-Path $resolvedData 'audit.jsonl'
$statePath = Join-Path $resolvedData 'authorization.json'
$secretPath = Join-Path $resolvedData 'transport-secret.txt'
$runtimeStatePath = Join-Path $resolvedData 'runtime-state.json'
$createdService = $false

if (-not $PSCmdlet.ShouldProcess($resolvedInstall, "Install and authorize $ServiceName")) {
    return
}

Assert-Administrator

try {
    New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
    New-Item -ItemType Directory -Path $resolvedData -Force | Out-Null
    & icacls.exe $resolvedInstall /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
    & icacls.exe $resolvedData /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
    Copy-Item -LiteralPath $resolvedAuthorization -Destination $statePath -Force
    & icacls.exe $statePath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${CallerSid}:M" | Out-Null
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        $secretBytes = New-Object byte[] 32
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($secretBytes) } finally { $generator.Dispose() }
        [System.IO.File]::WriteAllText($secretPath, [Convert]::ToBase64String($secretBytes))
        [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    }
    & icacls.exe $secretPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${CallerSid}:R" | Out-Null

    & dotnet.exe publish $resolvedProject -c Release -r win-x64 --self-contained false -o $resolvedInstall --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

    $executable = Join-Path $resolvedInstall 'RemoteMcp.Broker.exe'
    $arguments = @(
        '--pipe', $PipeName,
        '--public-key', $PublicKey,
        '--authorization-state', $statePath,
        '--audit', $auditPath,
        '--shared-secret-file', $secretPath,
        '--runtime-state', $runtimeStatePath,
        '--caller-sid', $CallerSid,
        '--service-name', $ServiceName
    )
    $quoted = @($executable) + $arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
    $binaryPath = $quoted -join ' '

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to replace existing service $ServiceName" }
        Start-Sleep -Milliseconds 500
    }
    & sc.exe create $ServiceName "binPath=" $binaryPath "start=" auto "obj=" LocalSystem | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed with exit code $LASTEXITCODE" }
    $createdService = $true
    & sc.exe description $ServiceName 'Remote MCP persistent-authorized privileged broker' | Out-Null
    & sc.exe failure $ServiceName "reset=" 86400 "actions=" restart/5000/restart/15000/""/0 | Out-Null
    Start-Service -Name $ServiceName
    Get-Service -Name $ServiceName | Select-Object Name, Status, StartType
}
catch {
    if ($createdService) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        & sc.exe delete $ServiceName | Out-Null
    }
    throw
}
