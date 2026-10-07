Set-StrictMode -Version Latest

if (-not ('RemoteMcpCredentialNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RemoteMcpCredentialNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll", SetLastError = false)]
    public static extern void CredFree(IntPtr buffer);
}
'@
}

function Set-RemoteMcpCredential {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter()][AllowEmptyString()][string]$Username = '',
        [Parameter(Mandatory)][byte[]]$SecretBytes
    )

    $blob = [IntPtr]::Zero
    try {
        if ($SecretBytes.Length -gt 0) {
            $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($SecretBytes.Length)
            [Runtime.InteropServices.Marshal]::Copy($SecretBytes, 0, $blob, $SecretBytes.Length)
        }
        $credential = New-Object RemoteMcpCredentialNative+CREDENTIAL
        $credential.Type = 1
        $credential.TargetName = $Target
        $credential.CredentialBlobSize = $SecretBytes.Length
        $credential.CredentialBlob = $blob
        $credential.Persist = 2
        $credential.UserName = $Username
        if (-not [RemoteMcpCredentialNative]::CredWrite([ref]$credential, 0)) {
            throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
    }
    finally {
        if ($blob -ne [IntPtr]::Zero) {
            for ($index = 0; $index -lt $SecretBytes.Length; $index++) {
                [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0)
            }
            [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
        }
        if ($null -ne $SecretBytes) { [Array]::Clear($SecretBytes, 0, $SecretBytes.Length) }
    }
}

function Get-RemoteMcpCredential {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Target)

    $pointer = [IntPtr]::Zero
    if (-not [RemoteMcpCredentialNative]::CredRead($Target, 1, 0, [ref]$pointer)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 1168) { return $null }
        throw [ComponentModel.Win32Exception]::new($errorCode)
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $pointer,
            [type][RemoteMcpCredentialNative+CREDENTIAL]
        )
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        if ($credential.CredentialBlobSize -gt 0) {
            [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
        }
        [PSCustomObject]@{ Username = $credential.UserName; SecretBytes = $bytes }
    }
    finally {
        [RemoteMcpCredentialNative]::CredFree($pointer)
    }
}

function Remove-RemoteMcpCredential {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Target)

    if ([RemoteMcpCredentialNative]::CredDelete($Target, 1, 0)) { return $true }
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 1168) { return $false }
    throw [ComponentModel.Win32Exception]::new($errorCode)
}

Export-ModuleMember -Function Set-RemoteMcpCredential, Get-RemoteMcpCredential, Remove-RemoteMcpCredential
