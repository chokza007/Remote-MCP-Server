[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$TaskName = 'RemoteMcpServer',
    [switch]$RemoveOperationalData,
    [string]$DataRoot = "$env:ProgramData\Remote-MCP-Server"
)

$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove Remote MCP startup task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
if ($RemoveOperationalData) {
    $resolved = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    $programData = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')
    if ($resolved -eq $programData -or -not $resolved.StartsWith($programData + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove data outside a specific ProgramData child: $resolved"
    }
    if ($PSCmdlet.ShouldProcess($resolved, 'Permanently remove Remote MCP operational data')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
