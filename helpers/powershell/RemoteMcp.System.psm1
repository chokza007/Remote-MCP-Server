Set-StrictMode -Version Latest

function Get-RemoteMcpProcess {
    [CmdletBinding()]
    param([int]$ProcessId)

    $filter = if ($PSBoundParameters.ContainsKey('ProcessId')) { "ProcessId=$ProcessId" } else { $null }
    Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop
}

function Get-RemoteMcpService {
    [CmdletBinding()]
    param([string]$Name)

    if ($Name) {
        Get-CimInstance -ClassName Win32_Service -Filter "Name='$($Name.Replace("'", "''"))'" -ErrorAction Stop
    } else {
        Get-CimInstance -ClassName Win32_Service -ErrorAction Stop
    }
}

function Get-RemoteMcpTcpListener {
    [CmdletBinding()]
    param()

    Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Select-Object LocalAddress, LocalPort, OwningProcess, State
}

Export-ModuleMember -Function Get-RemoteMcpProcess, Get-RemoteMcpService, Get-RemoteMcpTcpListener
