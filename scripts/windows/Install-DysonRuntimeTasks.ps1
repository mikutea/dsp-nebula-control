<#
.SYNOPSIS
Installs the fixed runtime task pair or restores a completed installation.
.DESCRIPTION
To undo a succeeded installation, supply its original deployment arguments and
Mode, add -RestoreCompletedRequestId with that installation's request id, and
choose a NEW -RequestId. Preview with -WhatIf. The source completed/<id>.json
and receipts/<id>.json must exist, and the current task pair must match that
receipt. Both original evidence files remain unchanged; the restore operation
has its own intent, receipt and archive. Failure restores the pre-restore pair.

Recovery of an interrupted restore uses the same arguments and new request id
with -Recover. Ordinary -Recover only finishes an active transaction; it does
not undo a completed succeeded installation. Archives created before completed
preimages were retained cannot be reconstructed from a receipt alone.

The archived XML, enabled state and owner/group/DACL are restored. Mode binds
the original installation; it does not override the archived enabled state.
An enabled prior logon task becomes enabled again. Running process state is
not restored and this command does not explicitly start a game process.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][Alias('StableScriptRoot')][string]$InstalledScriptRoot,
    [Parameter(Mandatory)][ValidatePattern('^[^"\r\n]{1,128}$')][string]$ServiceUser,
    [ValidateSet('PrepareDisabled', 'Activate')][string]$Mode = 'Activate',
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$RequestId = ([guid]::NewGuid().ToString('D')),
    [switch]$Recover,
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$RestoreCompletedRequestId,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$ServerTaskName = 'Dyson-Nebula-Server',
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$StopTaskName = 'Dyson-Nebula-Stop',
    [ValidateRange(5, 240)][int]$Ups = 60,
    [string]$TaskBackupRoot,
    [ValidateSet('Windows', 'Shadow')][string]$SchedulerBackend = 'Windows',
    [string]$ShadowSchedulerRoot,
    [string]$LeaseInstanceId,
    [string]$LeaseToken
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$protocol = 'DYSON_CONTROL_RUNTIME_TASK_TRANSACTION_V2'
$receiptProtocol = 'DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2'
$fixedServerTaskName = 'Dyson-Nebula-Server'
$fixedStopTaskName = 'Dyson-Nebula-Stop'
$fixedRuntimeTaskSddl = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
$taskSecurityInformation = 7 # owner, group, and DACL; never request SACL
$taskDontAddPrincipalAce = 0x10
$leaseOwner = 'runtime-task-installer'
$leaseOperation = 'runtime-task-install'
$leaseCommon = Join-Path $PSScriptRoot 'DysonHostMutationLease.Common.ps1'
if (-not (Test-Path -LiteralPath $leaseCommon -PathType Leaf)) {
    throw 'The fixed host-mutation lease implementation is unavailable.'
}
. $leaseCommon

function Get-RuntimeTaskSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function ConvertTo-RuntimeTaskCanonicalJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 16 -Compress)
}

function Assert-RuntimeTaskPlainDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$Create)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not [IO.Path]::IsPathRooted($full) -or $full -match '["\r\n]' -or [string]::IsNullOrWhiteSpace($full)) {
        throw 'A runtime-task storage path is invalid.'
    }
    if ($Create -and -not (Test-Path -LiteralPath $full)) { [void][IO.Directory]::CreateDirectory($full) }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A runtime-task storage path is redirected or unavailable.'
    }
    return $item.FullName.TrimEnd('\', '/')
}

function Assert-RuntimeTaskPlainFile {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A fixed runtime action script is unavailable or redirected.'
    }
    return $item.FullName
}

function Write-RuntimeTaskJsonNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $directory = Assert-RuntimeTaskPlainDirectory -Path ([IO.Path]::GetDirectoryName($Path)) -Create
    $temporary = Join-Path $directory ('.runtime-task-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-RuntimeTaskCanonicalJson $Value) + "`n")
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $Path)
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-RuntimeTaskJson {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissing)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw 'Required runtime-task transaction evidence is missing.'
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 2 -or $item.Length -gt 2097152) {
        throw 'Runtime-task transaction evidence is invalid.'
    }
    try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'Runtime-task transaction evidence is invalid.' }
}

function Get-RuntimeTaskExceptionCode {
    param([Parameter(Mandatory)][Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    return $null
}

function ConvertTo-RuntimeTaskCanonicalSddl {
    param([Parameter(Mandatory)][string]$SecurityDescriptor)
    if ([string]::IsNullOrWhiteSpace($SecurityDescriptor) -or $SecurityDescriptor.Length -gt 4096 -or
        $SecurityDescriptor -match '[\r\n\0]') {
        throw 'A runtime-task security descriptor is invalid.'
    }
    try {
        $raw = [Security.AccessControl.RawSecurityDescriptor]::new($SecurityDescriptor)
        # A pre-existing Windows task may inherit its DACL. Preserve that state
        # for backup/rollback; target verification separately compares the exact
        # fixed protected descriptor required for newly installed tasks.
        if ($null -eq $raw.Owner -or $null -eq $raw.Group -or $null -eq $raw.DiscretionaryAcl) {
            throw 'A runtime-task security descriptor is incomplete.'
        }
        $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
            [Security.AccessControl.AccessControlSections]::Group -bor
            [Security.AccessControl.AccessControlSections]::Access
        return $raw.GetSddlForm($sections)
    }
    catch {
        throw 'A runtime-task security descriptor is invalid.'
    }
}

function Test-RuntimeTaskSecurityDescriptorEqual {
    param([Parameter(Mandatory)][string]$Expected, [Parameter(Mandatory)][string]$Actual)
    $normalized = @(foreach ($value in @($Expected, $Actual)) {
        $raw = [Security.AccessControl.RawSecurityDescriptor]::new((ConvertTo-RuntimeTaskCanonicalSddl $value))
        # Task Scheduler marks restored inherited ACLs as auto-inherited. That
        # bookkeeping bit does not change the owner, protection or access rules.
        $raw.SetFlags($raw.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
        $allAllow = $true
        $aceKeys = @(foreach ($ace in $raw.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { $allAllow = $false }
            if ($ace -is [Security.AccessControl.KnownAce]) {
                # The scheduler persists file-object generic access mappings.
                $mask = [int64]$ace.AccessMask -band 0xffffffffL
                $mapped = $mask -band 0x0fffffffL
                if ($mask -band 0x80000000L) { $mapped = $mapped -bor 0x120089L } # FILE_GENERIC_READ
                if ($mask -band 0x40000000L) { $mapped = $mapped -bor 0x120116L } # FILE_GENERIC_WRITE
                if ($mask -band 0x20000000L) { $mapped = $mapped -bor 0x1200a0L } # FILE_GENERIC_EXECUTE
                if ($mask -band 0x10000000L) { $mapped = $mapped -bor 0x1f01ffL } # FILE_ALL_ACCESS
                $ace.AccessMask = [int]$mapped
            }
            $bytes = [byte[]]::new($ace.BinaryLength)
            $ace.GetBinaryForm($bytes, 0)
            [Convert]::ToBase64String($bytes)
        })
        if ($allAllow) {
            # Windows canonicalizes explicit/inherited allow-entry order on
            # restore. The same all-allow grants are additive; deny ordering is
            # never normalized, and every ACE byte and protection bit remains bound.
            'allow|{0}|{1}|{2}|{3}|{4}' -f $raw.Owner.Value, $raw.Group.Value,
                [int]$raw.ControlFlags, $raw.DiscretionaryAcl.Revision,
                ([string]::Join(';', @($aceKeys | Sort-Object -CaseSensitive)))
        }
        else { 'ordered|' + $raw.GetSddlForm([Security.AccessControl.AccessControlSections]'Owner, Group, Access') }
    })
    return $normalized[0] -ceq $normalized[1]
}

function Invoke-WithRuntimeTaskComObject {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][scriptblock]$Operation)
    if ($TaskName -cne $fixedServerTaskName -and $TaskName -cne $fixedStopTaskName) {
        throw 'A non-fixed runtime task name was rejected.'
    }
    $service = $null
    $folder = $null
    $registered = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder('\')
        $registered = $folder.GetTask($TaskName)
        return & $Operation $registered
    }
    finally {
        foreach ($item in @($registered, $folder, $service)) {
            if ($null -ne $item -and [Runtime.InteropServices.Marshal]::IsComObject($item)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)
            }
        }
    }
}

function Assert-RuntimeTaskMutationScope {
    if (-not $script:borrowedLease) { return }
    [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $script:resolvedDataRoot `
        -InstanceId $LeaseInstanceId -Token $LeaseToken)
}

function Get-ShadowTaskPath {
    param([Parameter(Mandatory)][string]$TaskName)
    if ($TaskName -ceq $fixedServerTaskName) { return (Join-Path $script:shadowRoot 'start-task.json') }
    if ($TaskName -ceq $fixedStopTaskName) { return (Join-Path $script:shadowRoot 'stop-task.json') }
    throw 'A non-fixed runtime task name was rejected.'
}

function Write-ShadowTaskRecord {
    param(
        [string]$TaskName,
        [string]$Xml,
        [bool]$Enabled,
        [AllowNull()]$Descriptor,
        [Parameter(Mandatory)][string]$SecurityDescriptor
    )
    $path = Get-ShadowTaskPath -TaskName $TaskName
    $record = [ordered]@{
        protocol = 'DYSON_RUNTIME_TASK_SHADOW_V1'; taskName = $TaskName; taskPath = '\'
        xmlBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Xml))
        enabled = $Enabled; descriptor = $Descriptor
        securityDescriptor = ConvertTo-RuntimeTaskCanonicalSddl $SecurityDescriptor
    }
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (ConvertTo-RuntimeTaskCanonicalJson $record), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    [IO.File]::Move($temporary, $path)
    [IO.File]::AppendAllText((Join-Path $script:shadowRoot 'writes.log'), $TaskName + "`n", [Text.UTF8Encoding]::new($false))
}

function Get-RuntimeTaskSecurityDescriptor {
    param([Parameter(Mandatory)][string]$TaskName)
    if ($SchedulerBackend -ceq 'Shadow') {
        $record = Read-RuntimeTaskJson -Path (Get-ShadowTaskPath $TaskName)
        if ($null -eq $record.PSObject.Properties['securityDescriptor'] -or
            $record.securityDescriptor -isnot [string]) {
            throw 'A shadow runtime task is missing its security descriptor.'
        }
        return ConvertTo-RuntimeTaskCanonicalSddl ([string]$record.securityDescriptor)
    }
    return Invoke-WithRuntimeTaskComObject -TaskName $TaskName -Operation {
        param($RegisteredTask)
        ConvertTo-RuntimeTaskCanonicalSddl ([string]$RegisteredTask.GetSecurityDescriptor($taskSecurityInformation))
    }
}

function Set-RuntimeTaskSecurityDescriptor {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][string]$SecurityDescriptor)
    Assert-RuntimeTaskMutationScope
    $canonical = ConvertTo-RuntimeTaskCanonicalSddl $SecurityDescriptor
    if ($SchedulerBackend -ceq 'Shadow') {
        $record = Read-RuntimeTaskJson -Path (Get-ShadowTaskPath $TaskName)
        Write-ShadowTaskRecord -TaskName $TaskName `
            -Xml ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$record.xmlBase64))) `
            -Enabled ([bool]$record.enabled) -Descriptor $record.descriptor -SecurityDescriptor $canonical
    }
    else {
        [void](Invoke-WithRuntimeTaskComObject -TaskName $TaskName -Operation {
            param($RegisteredTask)
            $RegisteredTask.SetSecurityDescriptor($canonical, $taskDontAddPrincipalAce)
        })
    }
    Assert-RuntimeTaskMutationScope
    $actual = Get-RuntimeTaskSecurityDescriptor $TaskName
    if (-not (Test-RuntimeTaskSecurityDescriptorEqual $canonical $actual)) {
        throw 'A runtime-task security descriptor did not pass exact verification.'
    }
}

function Get-RuntimeTaskImage {
    param([Parameter(Mandatory)][string]$TaskName)
    if ($SchedulerBackend -ceq 'Shadow') {
        $record = Read-RuntimeTaskJson -Path (Get-ShadowTaskPath $TaskName) -AllowMissing
        if ($null -eq $record) {
            return [pscustomobject][ordered]@{
                taskName = $TaskName; present = $false; xmlBase64 = $null; enabled = $false
                shadowDescriptor = $null; securityDescriptor = $null
            }
        }
        if ([string]$record.protocol -cne 'DYSON_RUNTIME_TASK_SHADOW_V1' -or
            [string]$record.taskName -cne $TaskName -or [string]$record.taskPath -cne '\') {
            throw 'Shadow scheduler state is invalid.'
        }
        [void][Convert]::FromBase64String([string]$record.xmlBase64)
        return [pscustomobject][ordered]@{
            taskName = $TaskName; present = $true; xmlBase64 = [string]$record.xmlBase64
            enabled = [bool]$record.enabled; shadowDescriptor = $record.descriptor
            securityDescriptor = Get-RuntimeTaskSecurityDescriptor $TaskName
        }
    }
    $matches = @(Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue)
    if ($matches.Count -eq 0) {
        return [pscustomobject][ordered]@{
            taskName = $TaskName; present = $false; xmlBase64 = $null; enabled = $false
            shadowDescriptor = $null; securityDescriptor = $null
        }
    }
    if ($matches.Count -ne 1 -or [string]$matches[0].TaskName -cne $TaskName -or [string]$matches[0].TaskPath -cne '\') {
        throw 'The fixed runtime task identity is ambiguous.'
    }
    $xml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop)
    return [pscustomobject][ordered]@{
        taskName = $TaskName; present = $true
        xmlBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))
        enabled = [bool]$matches[0].Settings.Enabled; shadowDescriptor = $null
        securityDescriptor = Get-RuntimeTaskSecurityDescriptor $TaskName
    }
}

function New-RuntimeTaskDescriptor {
    param([ValidateSet('Start', 'Stop')][string]$Kind, [bool]$Enabled)
    if ($Kind -ceq 'Start') {
        return [pscustomobject][ordered]@{
            taskName = $fixedServerTaskName; taskPath = '\'; execute = $script:powerShellExe
            arguments = $script:startArguments; userId = $ServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'AtLogOn'; triggerUserId = $ServiceUser; triggerDelay = 'PT20S'
            executionTimeLimit = 'PT0S'; multipleInstances = 'IgnoreNew'; restartCount = 3
            restartInterval = 'PT1M'; startWhenAvailable = $true; enabled = $Enabled
            taskSecurityDescriptor = $fixedRuntimeTaskSddl
            description = 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge from the stable bootstrap root.'
        }
    }
    return [pscustomobject][ordered]@{
        taskName = $fixedStopTaskName; taskPath = '\'; execute = $script:powerShellExe
        arguments = $script:stopArguments; userId = $ServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
        trigger = 'None'; triggerUserId = $null; triggerDelay = $null; executionTimeLimit = 'PT5M'
        multipleInstances = 'IgnoreNew'; restartCount = 0; restartInterval = $null
        startWhenAvailable = $false; enabled = $Enabled
        taskSecurityDescriptor = $fixedRuntimeTaskSddl
        description = 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.'
    }
}

function ConvertTo-ShadowTaskXml {
    param([Parameter(Mandatory)]$Descriptor)
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-RuntimeTaskCanonicalJson $Descriptor)))
    return '<Task xmlns="urn:dyson-control:shadow-task:v1"><Definition>' + $payload + '</Definition></Task>'
}

function Register-RuntimeTaskTarget {
    param([Parameter(Mandatory)]$Descriptor, [ValidateSet('Start', 'Stop')][string]$Kind)
    Assert-RuntimeTaskMutationScope
    if ($SchedulerBackend -ceq 'Shadow') {
        Write-ShadowTaskRecord -TaskName ([string]$Descriptor.taskName) -Xml (ConvertTo-ShadowTaskXml $Descriptor) `
            -Enabled ([bool]$Descriptor.enabled) -Descriptor $Descriptor `
            -SecurityDescriptor ([string]$Descriptor.taskSecurityDescriptor)
        Assert-RuntimeTaskMutationScope
        return
    }
    $principal = New-ScheduledTaskPrincipal -UserId $ServiceUser -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute ([string]$Descriptor.execute) -Argument ([string]$Descriptor.arguments)
    if ($Kind -ceq 'Start') {
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ServiceUser
        $trigger.Delay = 'PT20S'
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
        $settings.Enabled = [bool]$Descriptor.enabled
        Register-ScheduledTask -TaskName $fixedServerTaskName -TaskPath '\' -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Description ([string]$Descriptor.description) -Force | Out-Null
    }
    else {
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
        $settings.Enabled = [bool]$Descriptor.enabled
        Register-ScheduledTask -TaskName $fixedStopTaskName -TaskPath '\' -Action $action -Principal $principal `
            -Settings $settings -Description ([string]$Descriptor.description) -Force | Out-Null
    }
    if ([bool]$Descriptor.enabled) {
        Enable-ScheduledTask -TaskName ([string]$Descriptor.taskName) -TaskPath '\' -ErrorAction Stop | Out-Null
    }
    else {
        Disable-ScheduledTask -TaskName ([string]$Descriptor.taskName) -TaskPath '\' -ErrorAction Stop | Out-Null
    }
    Set-RuntimeTaskSecurityDescriptor -TaskName ([string]$Descriptor.taskName) `
        -SecurityDescriptor ([string]$Descriptor.taskSecurityDescriptor)
    Assert-RuntimeTaskMutationScope
}

function Remove-RuntimeTaskExact {
    param([Parameter(Mandatory)][string]$TaskName)
    Assert-RuntimeTaskMutationScope
    if ($SchedulerBackend -ceq 'Shadow') {
        $path = Get-ShadowTaskPath $TaskName
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
            [IO.File]::AppendAllText((Join-Path $script:shadowRoot 'writes.log'), $TaskName + "`n")
        }
        Assert-RuntimeTaskMutationScope
        return
    }
    if ((Get-RuntimeTaskImage $TaskName).present) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
    }
    Assert-RuntimeTaskMutationScope
}

function Restore-RuntimeTaskImage {
    param([Parameter(Mandatory)]$Image)
    if ([string]$Image.taskName -cne $fixedServerTaskName -and [string]$Image.taskName -cne $fixedStopTaskName) {
        throw 'A transaction snapshot referenced a non-fixed runtime task.'
    }
    if (-not [bool]$Image.present) { Remove-RuntimeTaskExact ([string]$Image.taskName); return }
    Assert-RuntimeTaskMutationScope
    $xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$Image.xmlBase64))
    if ($SchedulerBackend -ceq 'Shadow') {
        Write-ShadowTaskRecord -TaskName ([string]$Image.taskName) -Xml $xml -Enabled ([bool]$Image.enabled) `
            -Descriptor $Image.shadowDescriptor -SecurityDescriptor ([string]$Image.securityDescriptor)
        Assert-RuntimeTaskMutationScope
        return
    }
    Register-ScheduledTask -TaskName ([string]$Image.taskName) -TaskPath '\' -Xml $xml -Force | Out-Null
    if ([bool]$Image.enabled) { Enable-ScheduledTask -TaskName ([string]$Image.taskName) -TaskPath '\' | Out-Null }
    else { Disable-ScheduledTask -TaskName ([string]$Image.taskName) -TaskPath '\' | Out-Null }
    Set-RuntimeTaskSecurityDescriptor -TaskName ([string]$Image.taskName) `
        -SecurityDescriptor ([string]$Image.securityDescriptor)
    Assert-RuntimeTaskMutationScope
}

function Test-RuntimeTaskImageEqual {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual)
    if ([bool]$Expected.present -ne [bool]$Actual.present) { return $false }
    if (-not [bool]$Expected.present) { return $true }
    return [string]$Expected.taskName -ceq [string]$Actual.taskName -and
        [string]$Expected.xmlBase64 -ceq [string]$Actual.xmlBase64 -and
        [bool]$Expected.enabled -eq [bool]$Actual.enabled -and
        (Test-RuntimeTaskSecurityDescriptorEqual `
            ([string]$Expected.securityDescriptor) ([string]$Actual.securityDescriptor))
}

function Get-RuntimeTaskPairDigest {
    $pair = [ordered]@{
        server = Get-RuntimeTaskImage $fixedServerTaskName
        stop = Get-RuntimeTaskImage $fixedStopTaskName
    }
    return Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $pair)
}

function Test-RuntimeTaskUserEqual {
    param([string]$Expected, [string]$Actual)
    try {
        $sids = @(foreach ($value in @($Expected, $Actual)) {
            if ($value -match '^S-1-') { ([Security.Principal.SecurityIdentifier]::new($value)).Value }
            else { ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value }
        })
        return $sids[0] -ceq $sids[1]
    }
    catch { return $false }
}

function Assert-RuntimeTaskTarget {
    param([Parameter(Mandatory)]$Descriptor)
    $image = Get-RuntimeTaskImage ([string]$Descriptor.taskName)
    if (-not [bool]$image.present) { throw 'A runtime task is missing after registration.' }
    if (-not (Test-RuntimeTaskSecurityDescriptorEqual `
        ([string]$Descriptor.taskSecurityDescriptor) ([string]$image.securityDescriptor))) {
        throw 'A runtime task did not retain the fixed protected security descriptor.'
    }
    if ($SchedulerBackend -ceq 'Shadow') {
        if ((ConvertTo-RuntimeTaskCanonicalJson $image.shadowDescriptor) -cne
            (ConvertTo-RuntimeTaskCanonicalJson $Descriptor) -or [bool]$image.enabled -ne [bool]$Descriptor.enabled) {
            throw 'A shadow runtime task did not pass exact verification.'
        }
        return
    }
    $task = @(Get-ScheduledTask -TaskName ([string]$Descriptor.taskName) -TaskPath '\' -ErrorAction Stop)
    if ($task.Count -ne 1) { throw 'A runtime task is missing or ambiguous after registration.' }
    $actions = @($task[0].Actions | Where-Object { $null -ne $_ })
    $triggers = @($task[0].Triggers | Where-Object { $null -ne $_ })
    if ($actions.Count -ne 1 -or
        [string]$actions[0].Execute -cne [string]$Descriptor.execute -or
        [string]$actions[0].Arguments -cne [string]$Descriptor.arguments -or
        -not [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or
        -not (Test-RuntimeTaskUserEqual ([string]$Descriptor.userId) ([string]$task[0].Principal.UserId)) -or
        [string]$task[0].Principal.LogonType -cne 'Interactive' -or [string]$task[0].Principal.RunLevel -cne 'Limited' -or
        [bool]$task[0].Settings.Enabled -ne [bool]$Descriptor.enabled -or
        [string]$task[0].Settings.MultipleInstances -cne 'IgnoreNew') {
        throw 'An installed runtime task did not pass fixed action, principal, path, or state verification.'
    }
    if ([string]$Descriptor.trigger -ceq 'AtLogOn') {
        if ($triggers.Count -ne 1 -or
            -not (Test-RuntimeTaskUserEqual $ServiceUser ([string]$triggers[0].UserId)) -or
            [string]$triggers[0].Delay -cne 'PT20S') { throw 'The fixed start-task trigger did not pass verification.' }
    }
    elseif ($triggers.Count -ne 0) { throw 'The fixed stop task unexpectedly has a trigger.' }
}

function Restore-RuntimeTaskPair {
    param([Parameter(Mandatory)]$Intent)
    Restore-RuntimeTaskImage $Intent.previous.server
    Restore-RuntimeTaskImage $Intent.previous.stop
    if (-not (Test-RuntimeTaskImageEqual $Intent.previous.server (Get-RuntimeTaskImage $fixedServerTaskName)) -or
        -not (Test-RuntimeTaskImageEqual $Intent.previous.stop (Get-RuntimeTaskImage $fixedStopTaskName))) {
        throw 'The runtime-task pair rollback did not restore the complete prior image.'
    }
}

function Assert-RuntimeTaskIntent {
    param([Parameter(Mandatory)]$Intent,
        [string]$ExpectedRequestId = $requestId,
        [string]$ExpectedFingerprint = $requestFingerprint)
    if ([string]$Intent.protocol -cne $protocol -or [int]$Intent.schemaVersion -ne 2 -or
        [string]$Intent.requestId -cne $ExpectedRequestId -or
        [string]$Intent.requestFingerprint -cne $ExpectedFingerprint -or
        [string]$Intent.mode -cne $Mode -or
        [string]$Intent.projectRoot -cne $resolvedProjectRoot -or
        [string]$Intent.dataRoot -cne $script:resolvedDataRoot -or
        [string]$Intent.dataRootIdentity -cne $script:dataRootIdentity -or
        [string]$Intent.stableScriptRoot -cne $resolvedScriptRoot -or
        -not [string]::Equals([string]$Intent.serviceUser, $ServiceUser, [StringComparison]::OrdinalIgnoreCase) -or
        [int]$Intent.ups -ne $Ups -or
        (ConvertTo-RuntimeTaskCanonicalJson $Intent.target.server) -cne (ConvertTo-RuntimeTaskCanonicalJson $targetServer) -or
        (ConvertTo-RuntimeTaskCanonicalJson $Intent.target.stop) -cne (ConvertTo-RuntimeTaskCanonicalJson $targetStop) -or
        [string]$Intent.previous.server.taskName -cne $fixedServerTaskName -or
        [string]$Intent.previous.stop.taskName -cne $fixedStopTaskName) {
        throw 'Explicit recovery does not match the durable runtime-task transaction intent.'
    }
    foreach ($image in @($Intent.previous.server, $Intent.previous.stop)) {
        if ([bool]$image.present) {
            if ([string]::IsNullOrWhiteSpace([string]$image.xmlBase64) -or
                [string]::IsNullOrWhiteSpace([string]$image.securityDescriptor)) {
                throw 'A present runtime-task snapshot is missing its XML or security descriptor.'
            }
            try { [void][Convert]::FromBase64String([string]$image.xmlBase64) }
            catch { throw 'A runtime-task snapshot XML is invalid.' }
            [void](ConvertTo-RuntimeTaskCanonicalSddl ([string]$image.securityDescriptor))
        }
        elseif ($null -ne $image.xmlBase64 -or $null -ne $image.securityDescriptor) {
            throw 'A missing runtime-task snapshot unexpectedly contains task state.'
        }
    }
}

function Assert-RuntimeTaskTerminalLayout {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)
    if ([string]$Receipt.status -ceq 'succeeded') {
        Assert-RuntimeTaskDesiredPair $Intent.target
    }
    elseif ([string]$Receipt.status -ceq 'rolled-back') {
        if (-not (Test-RuntimeTaskImageEqual $Intent.previous.server (Get-RuntimeTaskImage $fixedServerTaskName)) -or
            -not (Test-RuntimeTaskImageEqual $Intent.previous.stop (Get-RuntimeTaskImage $fixedStopTaskName))) {
            throw 'The rolled-back runtime-task terminal layout is not the prior image.'
        }
    }
    else { throw 'Runtime-task terminal receipt is invalid.' }
    if ([string]$Receipt.terminalPairDigest -cne (Get-RuntimeTaskPairDigest)) {
        throw 'The runtime-task terminal receipt does not match the current pair.'
    }
}

function Assert-RuntimeTaskDesiredPair {
    param([Parameter(Mandatory)]$Target)
    if ($RestoreCompletedRequestId) {
        if (-not (Test-RuntimeTaskImageEqual $Target.server (Get-RuntimeTaskImage $fixedServerTaskName)) -or
            -not (Test-RuntimeTaskImageEqual $Target.stop (Get-RuntimeTaskImage $fixedStopTaskName))) {
            throw 'The completed-task restoration did not restore the archived prior pair.'
        }
    }
    else {
        Assert-RuntimeTaskTarget $Target.server
        Assert-RuntimeTaskTarget $Target.stop
    }
}

function New-RuntimeTaskReceipt {
    param([Parameter(Mandatory)]$Intent, [ValidateSet('succeeded', 'rolled-back')][string]$Status)
    $result = [pscustomobject][ordered]@{
        protocol = $receiptProtocol; schemaVersion = 2; requestId = [string]$Intent.requestId
        requestFingerprint = [string]$Intent.requestFingerprint; status = $Status; mode = [string]$Intent.mode
        serverTask = $fixedServerTaskName; stopTask = $fixedStopTaskName
        terminalPairDigest = Get-RuntimeTaskPairDigest
        completedAt = (Get-Date).ToUniversalTime().ToString('o'); reused = $false
    }
    if ($RestoreCompletedRequestId) {
        $result | Add-Member NoteProperty restoreCompletedRequestId $RestoreCompletedRequestId
    }
    return $result
}

function Read-ValidatedRuntimeTaskReceipt {
    param([string]$Path, [Parameter(Mandatory)]$Intent, [switch]$AllowMissing)
    $receipt = Read-RuntimeTaskJson -Path $Path -AllowMissing:$AllowMissing
    if ($null -eq $receipt) { return $null }
    if ([string]$receipt.protocol -cne $receiptProtocol -or [int]$receipt.schemaVersion -ne 2 -or
        [string]$receipt.requestId -cne [string]$Intent.requestId -or
        [string]$receipt.requestFingerprint -cne [string]$Intent.requestFingerprint -or
        [string]$receipt.status -notin @('succeeded', 'rolled-back') -or [string]$receipt.mode -cne [string]$Intent.mode -or
        [string]$receipt.serverTask -cne $fixedServerTaskName -or [string]$receipt.stopTask -cne $fixedStopTaskName -or
        [string]$receipt.terminalPairDigest -notmatch '^[0-9a-f]{64}$') {
        throw 'Runtime-task terminal receipt is not bound to its transaction intent.'
    }
    return $receipt
}

function Test-RuntimeTaskIntentPresent {
    param([Parameter(Mandatory)][string]$Path)

    # SMB directory metadata can briefly retain a deleted leaf across
    # PowerShell processes. FileStream open is the authoritative data-path
    # check; attributes are consulted only to retain dangling-reparse rejection.
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $stream = $null
        try {
            $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            return $true
        }
        catch [IO.FileNotFoundException] {}
        catch [IO.DirectoryNotFoundException] {}
        catch { throw 'Runtime-task transaction evidence visibility is unavailable.' }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        try {
            $attributes = [IO.File]::GetAttributes($Path)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { return $true }
        }
        catch [IO.FileNotFoundException] {}
        catch [IO.DirectoryNotFoundException] {}
        catch { throw 'Runtime-task transaction evidence visibility is unavailable.' }
        if ($attempt -lt 2) {
            [Threading.Thread]::Sleep(50)
        }
    }
    return $false
}

function Complete-RuntimeTaskIntentCleanup {
    param([string]$IntentPath)
    Assert-RuntimeTaskMutationScope
    if (Test-Path -LiteralPath $IntentPath -PathType Leaf) {
        $completedIntent = Read-RuntimeTaskJson $IntentPath
        Assert-RuntimeTaskIntent $completedIntent
        $archiveRoot = Assert-RuntimeTaskPlainDirectory -Path (Join-Path ([IO.Path]::GetDirectoryName($IntentPath)) 'completed') -Create
        $archivePath = Join-Path $archiveRoot ([string]$completedIntent.requestId + '.json')
        if (Test-Path -LiteralPath $archivePath) {
            if ((ConvertTo-RuntimeTaskCanonicalJson (Read-RuntimeTaskJson $archivePath)) -cne
                (ConvertTo-RuntimeTaskCanonicalJson $completedIntent)) { throw 'The completed runtime-task archive conflicts with its transaction.' }
        }
        else { Write-RuntimeTaskJsonNew $archivePath $completedIntent }
        Remove-Item -LiteralPath $IntentPath -Force
    }
    Assert-RuntimeTaskMutationScope
}

if ($ServerTaskName -cne $fixedServerTaskName -or $StopTaskName -cne $fixedStopTaskName) {
    throw 'Runtime task names are fixed and cannot be overridden.'
}
$resolvedProjectRoot = Assert-RuntimeTaskPlainDirectory $ProjectRoot
$dataRootInput = Assert-RuntimeTaskPlainDirectory $DataRoot
$dataRootPathInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $dataRootInput
$script:resolvedDataRoot = [string]$dataRootPathInfo.CanonicalDataRoot
$script:dataRootIdentity = [string]$dataRootPathInfo.DataRootIdentity
$resolvedScriptRoot = Assert-RuntimeTaskPlainDirectory $InstalledScriptRoot
$startScript = Assert-RuntimeTaskPlainFile (Join-Path $resolvedScriptRoot 'Start-DysonServer.ps1')
$stopScript = Assert-RuntimeTaskPlainFile (Join-Path $resolvedScriptRoot 'Stop-DysonServer.ps1')
$script:powerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $script:powerShellExe -PathType Leaf)) { throw 'Windows PowerShell is unavailable.' }
$script:startArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups {2}' -f $startScript, $resolvedProjectRoot, $Ups
$script:stopArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f $stopScript, $resolvedProjectRoot
$hasLeaseInstance = -not [string]::IsNullOrWhiteSpace($LeaseInstanceId)
$hasLeaseToken = -not [string]::IsNullOrWhiteSpace($LeaseToken)
if ($hasLeaseInstance -ne $hasLeaseToken) { throw 'LeaseInstanceId and LeaseToken must be supplied together.' }
$script:borrowedLease = $hasLeaseInstance
if ($script:borrowedLease) { Assert-RuntimeTaskMutationScope }

if ($SchedulerBackend -ceq 'Windows') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to install the Dyson runtime tasks.'
    }
}
else {
    if ($env:DYSON_RUNTIME_TASK_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowSchedulerRoot)) {
        throw 'The shadow scheduler is available only to the explicit runtime-task self-test.'
    }
    $script:shadowRoot = Assert-RuntimeTaskPlainDirectory $ShadowSchedulerRoot
    if (-not (Test-Path -LiteralPath (Join-Path $script:shadowRoot '.dyson-runtime-task-selftest') -PathType Leaf)) {
        throw 'The shadow scheduler is restricted to an explicit self-test fixture.'
    }
    $ConfirmPreference = 'None'
}

$effectiveTaskBackupRoot = $TaskBackupRoot
if ([string]::IsNullOrWhiteSpace($effectiveTaskBackupRoot)) {
    $deploymentDataRoot = [IO.Path]::GetDirectoryName($script:resolvedDataRoot)
    if ([string]::IsNullOrWhiteSpace($deploymentDataRoot) -or
        [string]::Equals(
            $deploymentDataRoot.TrimEnd('\', '/'),
            [IO.Path]::GetPathRoot($deploymentDataRoot).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The runtime-task transaction root cannot be derived from the selected data root.'
    }
    $effectiveTaskBackupRoot = Join-Path $deploymentDataRoot 'runtime-task-transactions'
}
$transactionRoot = [IO.Path]::GetFullPath($effectiveTaskBackupRoot).TrimEnd('\', '/')
if (-not [IO.Path]::IsPathRooted($transactionRoot) -or $transactionRoot -match '["\r\n]') {
    throw 'The runtime-task transaction root is invalid.'
}
$receiptsRoot = Join-Path $transactionRoot 'receipts'
$intentPath = Join-Path $transactionRoot 'active-intent.json'
$requestId = $RequestId.ToLowerInvariant()
$receiptPath = Join-Path $receiptsRoot ($requestId + '.json')
$enabled = $Mode -ceq 'Activate'
$targetServer = New-RuntimeTaskDescriptor Start $enabled
$targetStop = New-RuntimeTaskDescriptor Stop $enabled
$requestBinding = [ordered]@{
    requestId = $requestId; mode = $Mode; projectRoot = $resolvedProjectRoot
    dataRoot = $script:resolvedDataRoot; dataRootIdentity = $script:dataRootIdentity; stableScriptRoot = $resolvedScriptRoot
    serviceUser = $ServiceUser; ups = $Ups; target = [ordered]@{ server = $targetServer; stop = $targetStop }
}
$requestFingerprint = Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $requestBinding)

# A completed restore is a new transaction, never a rewrite of the original
# succeeded receipt. Its own preimage permits compensation and crash recovery.
$restoreSource = $null
$restoreReceipt = $null
if ($RestoreCompletedRequestId) {
    $RestoreCompletedRequestId = $RestoreCompletedRequestId.ToLowerInvariant()
    if ($RestoreCompletedRequestId -ceq $requestId) {
        throw 'A completed-task restoration requires a new request id.'
    }
    $restoreArchivePath = Join-Path (Join-Path $transactionRoot 'completed') ($RestoreCompletedRequestId + '.json')
    $restoreSource = Read-RuntimeTaskJson $restoreArchivePath
    if ($null -ne $restoreSource.PSObject.Properties['restoreCompletedRequestId']) {
        throw 'Only a completed installation can be selected for restoration.'
    }
    $sourceBinding = [ordered]@{}
    foreach ($key in $requestBinding.Keys) { $sourceBinding[$key] = $requestBinding[$key] }
    $sourceBinding.requestId = $RestoreCompletedRequestId
    Assert-RuntimeTaskIntent -Intent $restoreSource -ExpectedRequestId $RestoreCompletedRequestId `
        -ExpectedFingerprint (Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $sourceBinding))
    $restoreReceiptPath = Join-Path $receiptsRoot ($RestoreCompletedRequestId + '.json')
    $restoreReceipt = Read-ValidatedRuntimeTaskReceipt -Path $restoreReceiptPath -Intent $restoreSource
    if ([string]$restoreReceipt.status -cne 'succeeded') {
        throw 'Only a succeeded runtime-task installation can be restored.'
    }
    $targetServer = $restoreSource.previous.server
    $targetStop = $restoreSource.previous.stop
    $requestBinding.target = [ordered]@{ server = $targetServer; stop = $targetStop }
    $requestBinding.restoreCompletedRequestId = $RestoreCompletedRequestId
    $requestBinding.restoreArchiveSha256 = Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $restoreSource)
    $requestBinding.restoreReceiptSha256 = Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $restoreReceipt)
    $requestFingerprint = Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson $requestBinding)
}

if (-not $PSCmdlet.ShouldProcess("$fixedServerTaskName and $fixedStopTaskName", 'Apply the transactional runtime-task pair operation')) {
    [ordered]@{ protocol = $protocol; state = 'preview'; dryRun = $true; recovery = [bool]$Recover
        requestId = $requestId; mode = $Mode; restoreCompletedRequestId = $RestoreCompletedRequestId
        serverTask = $fixedServerTaskName; stopTask = $fixedStopTaskName } | ConvertTo-Json -Compress
    exit 0
}

if ($Recover) {
    $intent = Read-RuntimeTaskJson $intentPath
    Assert-RuntimeTaskIntent $intent
    $terminal = Read-ValidatedRuntimeTaskReceipt -Path $receiptPath -Intent $intent -AllowMissing
    $lease = $null
    $ownsRecoveryLease = $false
    if ($script:borrowedLease) {
        Assert-RuntimeTaskMutationScope
    }
    else {
        $candidate = $null
        try {
            $candidate = Get-DysonHostMutationLeaseRecoveryCandidate `
                -DataRoot $script:resolvedDataRoot -TimeoutMilliseconds 0
        }
        catch {
            if ((Get-RuntimeTaskExceptionCode $_.Exception) -ne 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED' -or
                $null -eq $terminal) { throw }
            Assert-RuntimeTaskTerminalLayout $intent $terminal
            Complete-RuntimeTaskIntentCleanup $intentPath
            $terminal.reused = $true
            $terminal | ConvertTo-Json -Compress
            exit 0
        }
        if ([string]$candidate.priorOperation -cne $leaseOperation -or
            [string]$candidate.priorRequestId -cne $requestId) {
            throw 'The global host-mutation recovery binding belongs to another operation.'
        }
        $lease = Enter-DysonHostMutationLease -DataRoot $script:resolvedDataRoot -Owner $leaseOwner `
            -Operation $leaseOperation -RequestId $requestId -OwnerPid $PID -TimeoutMilliseconds 0 `
            -RecoveryPriorInstanceId ([string]$candidate.priorInstanceId) `
            -RecoveryPriorRecordDigest ([string]$candidate.priorRecordDigest)
        $ownsRecoveryLease = $true
    }
    try {
        Assert-RuntimeTaskMutationScope
        if ($null -ne $terminal) {
            Assert-RuntimeTaskTerminalLayout $intent $terminal
        }
        else {
            Restore-RuntimeTaskPair $intent
            $terminal = New-RuntimeTaskReceipt $intent rolled-back
            Assert-RuntimeTaskMutationScope
            Write-RuntimeTaskJsonNew $receiptPath $terminal
            Assert-RuntimeTaskMutationScope
        }
        if ($ownsRecoveryLease) {
            [void](Exit-DysonHostMutationLease -Lease $lease -State released)
        }
        Complete-RuntimeTaskIntentCleanup $intentPath
        $terminal.reused = $true
        $terminal | ConvertTo-Json -Compress
        exit 0
    }
    catch {
        if ($ownsRecoveryLease -and $null -ne $lease -and $lease.Active) {
            try { [void](Exit-DysonHostMutationLease $lease abandoned) } catch {}
        }
        throw
    }
}

if (Test-RuntimeTaskIntentPresent -Path $intentPath) {
    throw 'A runtime-task transaction requires explicit recovery before another mutation or replay.'
}
$existingReceipt = Read-RuntimeTaskJson -Path $receiptPath -AllowMissing
if ($null -ne $existingReceipt) {
    Assert-RuntimeTaskMutationScope
    if ([string]$existingReceipt.protocol -cne $receiptProtocol -or
        [string]$existingReceipt.requestId -cne $requestId -or
        [string]$existingReceipt.requestFingerprint -cne $requestFingerprint -or
        [string]$existingReceipt.status -notin @('succeeded', 'rolled-back') -or
        [string]$existingReceipt.terminalPairDigest -cne (Get-RuntimeTaskPairDigest)) {
        throw 'The runtime-task request id conflicts with an existing terminal receipt or layout.'
    }
    $existingReceipt.reused = $true
    $existingReceipt | ConvertTo-Json -Compress
    exit 0
}

$lease = $null
$intent = $null
$terminalPersisted = $false
try {
    if ($script:borrowedLease) {
        Assert-RuntimeTaskMutationScope
    }
    else {
        $lease = Enter-DysonHostMutationLease -DataRoot $script:resolvedDataRoot -Owner $leaseOwner `
            -Operation $leaseOperation -RequestId $requestId -OwnerPid $PID -TimeoutMilliseconds 0
    }
    if (Test-RuntimeTaskIntentPresent -Path $intentPath) {
        throw 'A runtime-task transaction appeared while acquiring the host mutation lease.'
    }
    $transactionRoot = Assert-RuntimeTaskPlainDirectory -Path $transactionRoot -Create
    $receiptsRoot = Assert-RuntimeTaskPlainDirectory -Path $receiptsRoot -Create
    Assert-RuntimeTaskMutationScope
    if ($RestoreCompletedRequestId) {
        if ((Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson (Read-RuntimeTaskJson $restoreArchivePath))) -cne
                [string]$requestBinding.restoreArchiveSha256 -or
            (Get-RuntimeTaskSha256 (ConvertTo-RuntimeTaskCanonicalJson (Read-RuntimeTaskJson $restoreReceiptPath))) -cne
                [string]$requestBinding.restoreReceiptSha256 -or
            [string]$restoreReceipt.terminalPairDigest -cne (Get-RuntimeTaskPairDigest)) {
            throw 'The completed-task restoration source or current task pair has drifted.'
        }
    }
    $intent = [pscustomobject][ordered]@{
        protocol = $protocol; schemaVersion = 2; requestId = $requestId; requestFingerprint = $requestFingerprint
        mode = $Mode; projectRoot = $resolvedProjectRoot; dataRoot = $script:resolvedDataRoot
        dataRootIdentity = $script:dataRootIdentity; stableScriptRoot = $resolvedScriptRoot
        serviceUser = $ServiceUser; ups = $Ups
        previous = [ordered]@{ server = Get-RuntimeTaskImage $fixedServerTaskName; stop = Get-RuntimeTaskImage $fixedStopTaskName }
        target = [ordered]@{ server = $targetServer; stop = $targetStop }
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($RestoreCompletedRequestId) {
        $intent | Add-Member NoteProperty restoreCompletedRequestId $RestoreCompletedRequestId
    }
    Assert-RuntimeTaskMutationScope
    Write-RuntimeTaskJsonNew $intentPath $intent
    Assert-RuntimeTaskMutationScope
    if ($RestoreCompletedRequestId) { Restore-RuntimeTaskImage $targetServer }
    else { Register-RuntimeTaskTarget $targetServer Start }
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_RUNTIME_TASK_SELFTEST_FAIL_POINT -ceq 'HardExitAfterStartRegister') { [Environment]::Exit(86) }
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_RUNTIME_TASK_SELFTEST_FAIL_POINT -ceq 'SecondRegister') { throw 'Fictional shadow scheduler second-task failure.' }
    if ($RestoreCompletedRequestId) { Restore-RuntimeTaskImage $targetStop }
    else { Register-RuntimeTaskTarget $targetStop Stop }
    Assert-RuntimeTaskDesiredPair $intent.target
    $receipt = New-RuntimeTaskReceipt $intent succeeded
    Assert-RuntimeTaskMutationScope
    Write-RuntimeTaskJsonNew $receiptPath $receipt
    Assert-RuntimeTaskMutationScope
    $terminalPersisted = $true
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_RUNTIME_TASK_SELFTEST_FAIL_POINT -ceq 'HardExitAfterReceipt') { [Environment]::Exit(87) }
    if (-not $script:borrowedLease) {
        [void](Exit-DysonHostMutationLease -Lease $lease -State released)
    }
    Complete-RuntimeTaskIntentCleanup $intentPath
    $receipt | ConvertTo-Json -Compress
}
catch {
    $failure = $_
    if ($terminalPersisted) {
        if (-not $script:borrowedLease -and $null -ne $lease -and $lease.Active) {
            try { [void](Exit-DysonHostMutationLease $lease abandoned) } catch {}
        }
        throw [InvalidOperationException]::new(
            'The runtime-task terminal receipt is durable; explicit recovery must finish the lease handoff.',
            $failure.Exception
        )
    }
    if ($null -ne $intent) {
        try {
            Restore-RuntimeTaskPair $intent
            $receipt = New-RuntimeTaskReceipt $intent rolled-back
            Assert-RuntimeTaskMutationScope
            Write-RuntimeTaskJsonNew $receiptPath $receipt
            Assert-RuntimeTaskMutationScope
            if (-not $script:borrowedLease -and $null -ne $lease -and $lease.Active) {
                [void](Exit-DysonHostMutationLease $lease released)
            }
            Complete-RuntimeTaskIntentCleanup $intentPath
        }
        catch {
            if (-not $script:borrowedLease -and $null -ne $lease -and $lease.Active) {
                try { [void](Exit-DysonHostMutationLease $lease abandoned) } catch {}
            }
            throw [InvalidOperationException]::new('Runtime-task installation and rollback require explicit recovery.', $_.Exception)
        }
        throw [InvalidOperationException]::new('Runtime-task installation failed and the complete prior pair was restored.', $failure.Exception)
    }
    if (-not $script:borrowedLease -and $null -ne $lease -and $lease.Active) {
        # No intent was constructed, so no scheduler mutation was reachable.
        # A failed preimage read must not strand an otherwise untouched host.
        try { [void](Exit-DysonHostMutationLease $lease released) } catch {}
    }
    throw
}
