Set-StrictMode -Version 2.0

function Get-DysonLifecycleBrokerTaskSddl {
    return 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
}

function Assert-DysonLifecycleBrokerTaskAclIntent {
    param([Parameter(Mandatory)][string]$Sddl)
    try {
        $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $Sddl)
        if (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
            $null -eq $descriptor.DiscretionaryAcl -or $descriptor.DiscretionaryAcl.Count -ne 3) {
            throw 'unexpected DACL shape'
        }
        $expected = @{
            'S-1-5-18' = [int32]268435456
            'S-1-5-32-544' = [int32]268435456
            'S-1-5-19' = [int32]-1610612736
        }
        foreach ($ace in $descriptor.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
                -not $expected.ContainsKey($ace.SecurityIdentifier.Value) -or
                [int32]$ace.AccessMask -ne [int32]$expected[$ace.SecurityIdentifier.Value]) {
                throw 'unexpected task right'
            }
            $expected.Remove($ace.SecurityIdentifier.Value)
        }
        if ($expected.Count -ne 0) { throw 'missing task right' }
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
        if (Get-Command Throw-DysonLifecycleBrokerError -ErrorAction SilentlyContinue) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED'
        }
        throw
    }
}

function Get-DysonLifecycleBrokerTaskAclIntent {
    return (Assert-DysonLifecycleBrokerTaskAclIntent (Get-DysonLifecycleBrokerTaskSddl))
}

function Set-DysonLifecycleBrokerTaskAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName,
        [Parameter(Mandatory)][ValidatePattern('^\\(?:[\p{L}\p{N}_. -]+\\)*$')][string]$TaskPath
    )
    $service = $null; $folder = $null; $task = $null
    try {
        $sddl = Get-DysonLifecycleBrokerTaskSddl
        [void](Assert-DysonLifecycleBrokerTaskAclIntent $sddl)
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($TaskPath)
        $task = $folder.GetTask($TaskName)
        $task.SetSecurityDescriptor($sddl, 0x10)
        $actual = [string]$task.GetSecurityDescriptor(0x4)
        $actualDescriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $actual)
        $actualDacl = $actualDescriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
        [void](Assert-DysonLifecycleBrokerTaskAclIntent $actualDacl)
        return $actualDacl
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED'
    }
    finally {
        foreach ($entry in @($task, $folder, $service)) {
            if ($null -ne $entry -and [Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($entry)
            }
        }
    }
}

function Get-DysonLifecycleBrokerTaskSecurityDescriptor {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][string]$TaskPath)
    $service = $null; $folder = $null; $task = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($TaskPath)
        $task = $folder.GetTask($TaskName)
        return [string]$task.GetSecurityDescriptor(0x7)
    }
    finally {
        foreach ($entry in @($task, $folder, $service)) {
            if ($null -ne $entry -and [Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($entry)
            }
        }
    }
}

function Restore-DysonLifecycleBrokerTaskSecurityDescriptor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$TaskPath,
        [Parameter(Mandatory)][string]$Sddl
    )
    $service = $null; $folder = $null; $task = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder($TaskPath)
        $task = $folder.GetTask($TaskName)
        $task.SetSecurityDescriptor($Sddl, 0x10)
    }
    finally {
        foreach ($entry in @($task, $folder, $service)) {
            if ($null -ne $entry -and [Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($entry)
            }
        }
    }
}
