Set-StrictMode -Version 2.0

function Get-DysonFixedTaskReadExecuteSddl {
    return 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
}

function Get-DysonFixedTaskReadExecuteAclIntent {
    return Assert-DysonFixedTaskReadExecuteAclIntent (Get-DysonFixedTaskReadExecuteSddl)
}

function Assert-DysonFixedTaskReadExecuteAclIntent {
    param([Parameter(Mandatory)][string]$Sddl)

    try {
        $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $Sddl)
        if (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
            $null -eq $descriptor.DiscretionaryAcl -or $descriptor.DiscretionaryAcl.Count -ne 3) {
            throw 'DACL is not fixed and protected'
        }
        # Task Scheduler maps generic rights to these exact file access masks.
        $expected = @{
            'S-1-5-18' = @([int32]268435456, [int32]0x1f01ff)
            'S-1-5-32-544' = @([int32]268435456, [int32]0x1f01ff)
            'S-1-5-19' = @([int32]-1610612736, [int32]0x1200a9)
        }
        foreach ($ace in $descriptor.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
                -not $expected.ContainsKey($ace.SecurityIdentifier.Value) -or
                [int32]$ace.AccessMask -notin $expected[$ace.SecurityIdentifier.Value]) {
                throw 'DACL grants unexpected rights'
            }
            $expected.Remove($ace.SecurityIdentifier.Value)
        }
        if ($expected.Count -ne 0) { throw 'DACL is incomplete' }
        return [pscustomobject][ordered]@{
            sddl = $Sddl
            protected = $true
            system = 'full'
            administrators = 'full'
            localService = 'read-execute'
            localServiceWrite = $false
            localServiceDelete = $false
        }
    }
    catch {
        if (Get-Command -Name Throw-DysonCutoverBrokerError -ErrorAction SilentlyContinue) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
        }
        throw
    }
}

function Set-DysonFixedTaskReadExecuteAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName,
        [Parameter(Mandatory)][ValidatePattern('^\\(?:[\p{L}\p{N}_. -]+\\)*$')][string]$TaskPath
    )

    $service = $null
    $folder = $null
    $task = $null
    try {
        $sddl = Get-DysonFixedTaskReadExecuteSddl
        [void](Assert-DysonFixedTaskReadExecuteAclIntent $sddl)
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($(if ($TaskPath -eq '\') { '\' } else { $TaskPath.TrimEnd('\') }))
        $task = $folder.GetTask($TaskName)
        # TASK_DONT_ADD_PRINCIPAL_ACE keeps the explicit SYSTEM/Admin/LocalService DACL exact.
        $task.SetSecurityDescriptor($sddl, 0x10)
        $actual = [string]$task.GetSecurityDescriptor(0x4)
        $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $actual)
        $actualDacl = $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
        [void](Assert-DysonFixedTaskReadExecuteAclIntent $actualDacl)
        return $actualDacl
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        if (Get-Command -Name Throw-DysonCutoverBrokerError -ErrorAction SilentlyContinue) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
        }
        throw
    }
    finally {
        foreach ($comObject in @($task, $folder, $service)) {
            if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
            }
        }
    }
}

function Get-DysonFixedTaskSecurityDescriptor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$TaskPath
    )

    $service = $null
    $folder = $null
    $task = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($(if ($TaskPath -eq '\') { '\' } else { $TaskPath.TrimEnd('\') }))
        $task = $folder.GetTask($TaskName)
        return [string]$task.GetSecurityDescriptor(0x7)
    }
    finally {
        foreach ($comObject in @($task, $folder, $service)) {
            if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
            }
        }
    }
}

function Restore-DysonFixedTaskSecurityDescriptor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$TaskPath,
        [Parameter(Mandatory)][string]$Sddl
    )

    $service = $null
    $folder = $null
    $task = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($(if ($TaskPath -eq '\') { '\' } else { $TaskPath.TrimEnd('\') }))
        $task = $folder.GetTask($TaskName)
        $task.SetSecurityDescriptor($Sddl, 0x10)
    }
    finally {
        foreach ($comObject in @($task, $folder, $service)) {
            if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
            }
        }
    }
}

function Restore-DysonCutoverBrokerFileSecurityPreimage {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Sddl)
    $target = Assert-DysonCutoverBrokerPlainFile $Path ([int64]::MaxValue)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    if ($null -eq $descriptor.Owner -or $null -eq $descriptor.Group -or $null -eq $descriptor.DiscretionaryAcl) {
        throw 'The broker file ACL preimage is incomplete.'
    }
    if (-not ('DysonControl.CutoverBrokerFileAclRestore' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace DysonControl {
    public static class CutoverBrokerFileAclRestore {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);
    }
}
'@
    }
    # File.Replace can change inheritance bookkeeping. AUTO_INHERIT_REQ is
    # required to retain an existing AUTO_INHERITED flag with SetFileSecurity.
    if ($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) {
        $descriptor.SetFlags($descriptor.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired)
    }
    $bytes = [byte[]]::new($descriptor.BinaryLength)
    $descriptor.GetBinaryForm($bytes, 0)
    if (-not [DysonControl.CutoverBrokerFileAclRestore]::SetFileSecurityW(
        (ConvertTo-DysonCutoverBrokerExtendedPath $target), 7, $bytes)) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "The broker file ACL preimage could not be restored (Win32 $nativeError)."
    }
    if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target -ErrorAction Stop).Sddl -cne $Sddl) {
        throw 'The broker file ACL differs from its exact preimage after restore.'
    }
}
