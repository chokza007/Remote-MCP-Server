[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string[]]$SecretPath = @(),
    [string]$CurrentUserSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
)

$ErrorActionPreference = 'Stop'
$data = [System.IO.Path]::GetFullPath($DataRoot)
New-Item -ItemType Directory -Path $data -Force | Out-Null

$systemSid = '*S-1-5-18'
$administratorsSid = '*S-1-5-32-544'
$userSid = "*$CurrentUserSid"

& icacls.exe $data /inheritance:r /grant:r `
    "${systemSid}:(OI)(CI)F" `
    "${administratorsSid}:(OI)(CI)F" `
    "${userSid}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to protect service data directory with icacls (exit $LASTEXITCODE): $data"
}

$dataPrefix = $data.TrimEnd('\') + '\'
foreach ($path in $SecretPath) {
    $secret = [System.IO.Path]::GetFullPath($path)
    if (-not $secret.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Secret path must be inside DataRoot: $secret"
    }
    if (-not (Test-Path -LiteralPath $secret -PathType Leaf)) {
        throw "Secret file does not exist: $secret"
    }
    & icacls.exe $secret /inheritance:r /grant:r `
        "${systemSid}:F" `
        "${administratorsSid}:F" `
        "${userSid}:R" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to protect service secret with icacls (exit $LASTEXITCODE): $secret"
    }
}
