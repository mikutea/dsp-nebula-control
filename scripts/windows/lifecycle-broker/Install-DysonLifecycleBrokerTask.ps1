[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$InstalledWindowsRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][ValidatePattern('^[^"\r\n]{1,128}$')][string]$ServiceUser,
    [ValidateRange(1, 65535)][int]$GamePort = 8469,
    [ValidateRange(5, 60)][int]$DispatchReadyTimeoutSeconds = 30,
    [switch]$UpgradeExisting,
    [string]$PreviousBootstrapRoot,
    [switch]$CompensateFirstInstall,
    [switch]$RemoveCurrent,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedProfileHash,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$commonPath = Join-Path $PSScriptRoot 'DysonLifecycleBroker.Common.ps1'
$aclPath = Join-Path $PSScriptRoot 'DysonLifecycleBroker.TaskAcl.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf) -or -not (Test-Path -LiteralPath $aclPath -PathType Leaf)) {
    throw 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
}
. $commonPath
. $aclPath

$script:InstallerTaskName = 'Dyson-Control-Lifecycle-Broker'
$script:InstallerTaskPath = '\DysonControl\'
$script:InstallerTaskDescription = 'Executes only profile-bound Dyson lifecycle capabilities; never launches Steam or DSP directly.'
$script:InstallerShadowTaskFile = $null
$script:InstallerShadowProfileAclFile = $null
$script:InstallerFailureStage = 'none'
$script:InstallerFailureStages = @(
    'none', 'after-candidate-validated', 'after-old-snapshot', 'after-task-disabled',
    'after-profile-published', 'after-task-registered', 'after-task-acl', 'after-task-removed',
    'after-profile-removed', 'after-final-verified'
)

function Get-InstallerJsonBytes {
    param([Parameter(Mandatory)]$Value)
    return [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-DysonLifecycleBrokerJson $Value) + "`n")
}

function Test-InstallerBytesEqual {
    param([Parameter(Mandatory)][byte[]]$Left, [Parameter(Mandatory)][byte[]]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

function Set-InstallerBytesAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [int64]$MaximumBytes = 262144
    )
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt $MaximumBytes) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE'
    }
    $full = Get-DysonLifecycleBrokerFullPath $Path
    $directory = Assert-DysonLifecycleBrokerPlainDirectory ([IO.Path]::GetDirectoryName($full))
    if (Test-Path -LiteralPath $full) {
        [void](Assert-DysonLifecycleBrokerPlainFile -Path $full -MaximumBytes $MaximumBytes -AllowEmpty)
    }
    else { [void](Assert-DysonLifecycleBrokerNoReparsePath -Path $full -AllowMissingLeaf) }
    $temporary = Join-Path $directory ('.lifecycle-install-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $directory ('.lifecycle-install-' + [guid]::NewGuid().ToString('N') + '.bak')
    try {
        $stream = [IO.FileStream]::new(
            $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
            4096, [IO.FileOptions]::WriteThrough
        )
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $full) { [IO.File]::Replace($temporary, $full, $backup, $true) }
        else { [IO.File]::Move($temporary, $full) }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE'
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
        }
    }
    return $full
}

function New-InstallerDependencyHashes {
    param([Parameter(Mandatory)]$Profile)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($name in $script:DysonLifecycleBrokerDependencyNames) {
        $path = Get-DysonLifecycleBrokerExpectedDependencyPath $Profile $name
        $entries.Add([pscustomobject][ordered]@{
            name = $name; path = $path; sha256 = Get-DysonLifecycleBrokerSha256File $path
        })
    }
    return @($entries)
}

function Set-InstallerDirectoryAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('root', 'requests', 'private', 'receipts')][string]$Kind
    )
    try {
        $resolved = Assert-DysonLifecycleBrokerPlainDirectory $Path
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation = [Security.AccessControl.PropagationFlags]::None
        $allow = [Security.AccessControl.AccessControlType]::Allow
        foreach ($pair in @(
            @([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.AccessControl.FileSystemRights]::FullControl),
            @([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'), [Security.AccessControl.FileSystemRights]::FullControl)
        )) {
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($pair[0], $pair[1], $inherit, $propagation, $allow))
        }
        $localService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
        if ($Kind -ceq 'root' -or $Kind -ceq 'receipts') {
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $localService, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                $inherit, $propagation, $allow
            ))
        }
        elseif ($Kind -ceq 'requests') {
            $rights = [Security.AccessControl.FileSystemRights]::CreateFiles -bor
                [Security.AccessControl.FileSystemRights]::AppendData -bor
                [Security.AccessControl.FileSystemRights]::ListDirectory -bor
                [Security.AccessControl.FileSystemRights]::ReadAttributes -bor
                [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
                [Security.AccessControl.FileSystemRights]::Synchronize
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $localService, $rights, [Security.AccessControl.InheritanceFlags]::None,
                [Security.AccessControl.PropagationFlags]::None, $allow
            ))
            # The publisher must rename and read back the file it just created.
            # Existing SYSTEM/administrator-owned requests remain protected.
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new('S-1-3-0'),
                ([Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Delete),
                [Security.AccessControl.InheritanceFlags]::ObjectInherit,
                [Security.AccessControl.PropagationFlags]::InheritOnly, $allow
            ))
        }
        Set-Acl -LiteralPath $resolved -AclObject $security -ErrorAction Stop
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' }
}

function New-InstallerProfileSecurity {
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($pair in @(
        @([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.AccessControl.FileSystemRights]::FullControl),
        @([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'), [Security.AccessControl.FileSystemRights]::FullControl),
        @([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), [Security.AccessControl.FileSystemRights]::Read)
    )) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($pair[0], $pair[1], $allow))
    }
    return $security
}

function Get-InstallerExpectedProfileAclSddl {
    return (New-InstallerProfileSecurity).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
}

function Assert-InstallerProfileAclSddl {
    param([Parameter(Mandatory)][string]$Sddl)
    try {
        $actual = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $Sddl)
        $expected = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, (Get-InstallerExpectedProfileAclSddl))
        if (($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
            $null -eq $actual.DiscretionaryAcl -or $actual.DiscretionaryAcl.Count -ne $expected.DiscretionaryAcl.Count) {
            throw 'profile DACL shape mismatch'
        }
        $expectedAces = @{}
        foreach ($ace in $expected.DiscretionaryAcl) { $expectedAces[$ace.SecurityIdentifier.Value] = [int32]$ace.AccessMask }
        foreach ($ace in $actual.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
                -not $expectedAces.ContainsKey($ace.SecurityIdentifier.Value) -or
                [int32]$ace.AccessMask -ne [int32]$expectedAces[$ace.SecurityIdentifier.Value]) {
                throw 'profile DACL right mismatch'
            }
            $expectedAces.Remove($ace.SecurityIdentifier.Value)
        }
        if ($expectedAces.Count -ne 0) { throw 'profile DACL identity mismatch' }
        return $Sddl
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED'
    }
}

function Set-InstallerProfileAcl {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $resolved = Assert-DysonLifecycleBrokerPlainFile -Path $Path -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes
        if ($Backend -ceq 'Shadow') {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes((Get-InstallerExpectedProfileAclSddl) + "`n")
            [void](Set-InstallerBytesAtomic -Path $script:InstallerShadowProfileAclFile -Bytes $bytes -MaximumBytes 8192)
            return
        }
        Set-Acl -LiteralPath $resolved -AclObject (New-InstallerProfileSecurity) -ErrorAction Stop
        [void](Get-InstallerProfileAclSddl -Path $resolved)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED'
    }
}

function Get-InstallerProfileAclSddl {
    param([Parameter(Mandatory)][string]$Path)
    try {
        [void](Assert-DysonLifecycleBrokerPlainFile -Path $Path -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes)
        $sddl = if ($Backend -ceq 'Shadow') {
            $aclFile = Assert-DysonLifecycleBrokerPlainFile -Path $script:InstallerShadowProfileAclFile -MaximumBytes 8192
            [IO.File]::ReadAllText($aclFile, [Text.UTF8Encoding]::new($false)).Trim()
        }
        else {
            (Get-Acl -LiteralPath $Path -ErrorAction Stop).GetSecurityDescriptorSddlForm(
                [Security.AccessControl.AccessControlSections]::Access
            )
        }
        return (Assert-InstallerProfileAclSddl $sddl)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED'
    }
}

function Restore-InstallerProfileAcl {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Sddl)
    [void](Assert-InstallerProfileAclSddl $Sddl)
    if ($Backend -ceq 'Shadow') {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Sddl + "`n")
        [void](Set-InstallerBytesAtomic -Path $script:InstallerShadowProfileAclFile -Bytes $bytes -MaximumBytes 8192)
        return
    }
    try {
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetSecurityDescriptorSddlForm($Sddl, [Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' }
}

function Ensure-InstallerTaskFolder {
    if ($Backend -ceq 'Shadow') { return }
    $service = $null; $root = $null; $folder = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
        $root = $service.GetFolder('\')
        try { $folder = $service.GetFolder($script:InstallerTaskPath.TrimEnd('\')) }
        catch { $folder = $root.CreateFolder('DysonControl') }
    }
    finally {
        foreach ($entry in @($folder, $root, $service)) {
            if ($null -ne $entry -and [Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($entry)
            }
        }
    }
}

function New-InstallerWorkerTaskDescriptor {
    param([Parameter(Mandatory)]$Profile)
    $powerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $worker = Join-Path ([string]$Profile.brokerScriptRoot) 'Invoke-DysonLifecycleBrokerWorker.ps1'
    [void](Assert-DysonLifecycleBrokerPlainFile -Path $worker -MaximumBytes 4194304)
    return [pscustomobject][ordered]@{
        name = $script:InstallerTaskName; path = $script:InstallerTaskPath; execute = $powerShell.ToLowerInvariant()
        arguments = Get-DysonLifecycleBrokerTaskArguments -BrokerRoot ([string]$Profile.brokerRoot) `
            -ProfileFile (Join-Path ([string]$Profile.brokerRoot) 'broker-profile.json') -WorkerScript $worker
        workingDirectory = ''; userId = 'SYSTEM'; logonType = 'ServiceAccount'; runLevel = 'Highest'
        multipleInstances = 'IgnoreNew'; executionTimeLimit = 'PT5M'; description = $script:InstallerTaskDescription
    }
}

function Assert-InstallerWorkerTaskDescriptor {
    param([Parameter(Mandatory)]$Descriptor, [Parameter(Mandatory)]$Profile)
    Assert-DysonLifecycleBrokerExactProperties $Descriptor @(
        'name', 'path', 'execute', 'arguments', 'workingDirectory', 'userId', 'logonType',
        'runLevel', 'multipleInstances', 'executionTimeLimit', 'description'
    ) 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    $expected = New-InstallerWorkerTaskDescriptor $Profile
    if ((ConvertTo-DysonLifecycleBrokerJson $Descriptor) -cne (ConvertTo-DysonLifecycleBrokerJson $expected)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    return $Descriptor
}

function Get-InstallerShadowTaskXml {
    param([Parameter(Mandatory)]$Descriptor)
    return ('DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_TASK_XML_V1:' + (ConvertTo-DysonLifecycleBrokerJson $Descriptor))
}

function Read-InstallerShadowTaskRecord {
    param([Parameter(Mandatory)]$Profile, [switch]$RequireAcl, [switch]$RequireEnabled)
    $record = Read-DysonLifecycleBrokerJson -Path $script:InstallerShadowTaskFile -MaximumBytes 262144 `
        -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    Assert-DysonLifecycleBrokerExactProperties $record @(
        'protocol', 'schemaVersion', 'descriptor', 'xml', 'enabled', 'sddl'
    ) 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    if ([string]$record.protocol -cne 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_TASK_V1' -or
        [int]$record.schemaVersion -ne 1 -or $record.enabled -isnot [bool]) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $record.descriptor -Profile $Profile)
    if ([string]$record.xml -cne (Get-InstallerShadowTaskXml $record.descriptor) -or ($RequireEnabled -and -not [bool]$record.enabled)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    if ($RequireAcl) { [void](Assert-DysonLifecycleBrokerTaskAclIntent ([string]$record.sddl)) }
    return $record
}

function Write-InstallerShadowTaskRecord {
    param([Parameter(Mandatory)]$Record)
    [void](Set-InstallerBytesAtomic -Path $script:InstallerShadowTaskFile -Bytes (Get-InstallerJsonBytes $Record) -MaximumBytes 262144)
}

function Test-InstallerTaskExists {
    if ($Backend -ceq 'Shadow') { return (Test-Path -LiteralPath $script:InstallerShadowTaskFile -PathType Leaf) }
    try {
        return @(Get-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -ErrorAction Stop).Count -gt 0
    }
    catch { return $false }
}

function Get-InstallerWindowsTaskDescriptor {
    param([Parameter(Mandatory)]$Task)
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
    $userId = [string]$Task.Principal.UserId
    if ($userId -ceq 'S-1-5-18') { $userId = 'SYSTEM' }
    return [pscustomobject][ordered]@{
        name = [string]$Task.TaskName; path = [string]$Task.TaskPath
        execute = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)).ToLowerInvariant()
        arguments = [string]$actions[0].Arguments; workingDirectory = [string]$actions[0].WorkingDirectory
        userId = $userId; logonType = [string]$Task.Principal.LogonType; runLevel = [string]$Task.Principal.RunLevel
        multipleInstances = [string]$Task.Settings.MultipleInstances; executionTimeLimit = [string]$Task.Settings.ExecutionTimeLimit
        description = [string]$Task.Description
    }
}

function Get-InstallerTaskSnapshot {
    param([Parameter(Mandatory)]$Profile)
    if ($Backend -ceq 'Shadow') {
        $record = Read-InstallerShadowTaskRecord -Profile $Profile -RequireAcl -RequireEnabled
        $recordPath = Assert-DysonLifecycleBrokerPlainFile -Path $script:InstallerShadowTaskFile -MaximumBytes 262144
        return [pscustomobject][ordered]@{
            descriptor = $record.descriptor; xml = [string]$record.xml; enabled = [bool]$record.enabled
            sddl = [string]$record.sddl; recordBytes = [IO.File]::ReadAllBytes($recordPath)
        }
    }
    try {
        $matches = @(Get-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -ErrorAction Stop)
        if ($matches.Count -ne 1 -or -not [bool]$matches[0].Settings.Enabled) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $descriptor = Get-InstallerWindowsTaskDescriptor $matches[0]
        [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $descriptor -Profile $Profile)
        $sddl = Get-DysonLifecycleBrokerTaskSecurityDescriptor -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath
        [void](Assert-DysonLifecycleBrokerTaskAclIntent $sddl)
        return [pscustomobject][ordered]@{
            descriptor = $descriptor
            xml = [string](Export-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -ErrorAction Stop)
            enabled = [bool]$matches[0].Settings.Enabled; sddl = $sddl; recordBytes = $null
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
}

function Disable-InstallerTask {
    param([Parameter(Mandatory)]$Profile)
    if ($Backend -ceq 'Shadow') {
        $record = Read-InstallerShadowTaskRecord -Profile $Profile -RequireAcl -RequireEnabled
        Write-InstallerShadowTaskRecord ([ordered]@{
            protocol = [string]$record.protocol; schemaVersion = 1; descriptor = $record.descriptor
            xml = [string]$record.xml; enabled = $false; sddl = [string]$record.sddl
        })
        return
    }
    try {
        Disable-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -ErrorAction Stop | Out-Null
        $task = Get-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -ErrorAction Stop
        if ([bool]$task.Settings.Enabled) { throw 'task did not disable' }
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
}

function Register-InstallerTask {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Descriptor)
    [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $Descriptor -Profile $Profile)
    if ($Backend -ceq 'Shadow') {
        Write-InstallerShadowTaskRecord ([ordered]@{
            protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_TASK_V1'; schemaVersion = 1
            descriptor = $Descriptor; xml = Get-InstallerShadowTaskXml $Descriptor; enabled = $true
            sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)'
        })
        return
    }
    try {
        Ensure-InstallerTaskFolder
        $action = New-ScheduledTaskAction -Execute ([string]$Descriptor.execute) -Argument ([string]$Descriptor.arguments)
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath `
            -Action $action -Principal $principal -Settings $settings -Description $script:InstallerTaskDescription -Force | Out-Null
        Enable-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath | Out-Null
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
}

function Set-InstallerTaskAcl {
    param([Parameter(Mandatory)]$Profile)
    if ($Backend -ceq 'Shadow') {
        $record = Read-InstallerShadowTaskRecord -Profile $Profile -RequireEnabled
        Write-InstallerShadowTaskRecord ([ordered]@{
            protocol = [string]$record.protocol; schemaVersion = 1; descriptor = $record.descriptor
            xml = [string]$record.xml; enabled = [bool]$record.enabled; sddl = Get-DysonLifecycleBrokerTaskSddl
        })
        [void](Read-InstallerShadowTaskRecord -Profile $Profile -RequireAcl -RequireEnabled)
        return
    }
    [void](Set-DysonLifecycleBrokerTaskAcl -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath)
}

function Remove-InstallerTaskIfPresent {
    if (-not (Test-InstallerTaskExists)) { return }
    if ($Backend -ceq 'Shadow') { Remove-DysonLifecycleBrokerPlainFile $script:InstallerShadowTaskFile; return }
    try {
        Unregister-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath -Confirm:$false -ErrorAction Stop
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
}

function Restore-InstallerTaskSnapshot {
    param([Parameter(Mandatory)]$Snapshot)
    if ($Backend -ceq 'Shadow') {
        [void](Set-InstallerBytesAtomic -Path $script:InstallerShadowTaskFile -Bytes ([byte[]]$Snapshot.recordBytes) -MaximumBytes 262144)
        return
    }
    try {
        Register-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath `
            -Xml ([string]$Snapshot.xml) -Force | Out-Null
        if ([bool]$Snapshot.enabled) {
            Enable-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath | Out-Null
        }
        else {
            Disable-ScheduledTask -TaskName $script:InstallerTaskName -TaskPath $script:InstallerTaskPath | Out-Null
        }
        Restore-DysonLifecycleBrokerTaskSecurityDescriptor -TaskName $script:InstallerTaskName `
            -TaskPath $script:InstallerTaskPath -Sddl ([string]$Snapshot.sddl)
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
}

function Assert-InstallerRuntimeTaskBindings {
    param([Parameter(Mandatory)]$Profile)
    [void](Assert-DysonLifecycleBrokerTaskPair -Profile $Profile -Backend $Backend `
        -ShadowRoot $ShadowRoot -AllowPreparedDisabled)
}

function New-InstallerCandidateProfile {
    param(
        [Parameter(Mandatory)]$Storage, [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Data, [Parameter(Mandatory)][string]$Installed,
        [Parameter(Mandatory)][string]$Bootstrap, [Parameter(Mandatory)][string]$CreatedAt
    )
    $provisional = [pscustomobject][ordered]@{
        protocol = $script:DysonLifecycleBrokerProfileProtocol; schemaVersion = 1
        brokerRoot = $Storage.root; brokerScriptRoot = $PSScriptRoot; projectRoot = $Project; dataRoot = $Data
        installedWindowsRoot = $Installed; runtimeBootstrapRoot = $Bootstrap; serviceUser = $ServiceUser; gamePort = $GamePort
        workerTaskName = $script:InstallerTaskName; workerTaskPath = $script:InstallerTaskPath
        serverTask = [pscustomobject][ordered]@{ name = 'Dyson-Nebula-Server'; path = '\'; descriptorHash = ('0' * 64) }
        stopTask = [pscustomobject][ordered]@{ name = 'Dyson-Nebula-Stop'; path = '\'; descriptorHash = ('0' * 64) }
        dependencyHashes = @(); dispatchReadyTimeoutSeconds = $DispatchReadyTimeoutSeconds; createdAt = $CreatedAt
    }
    $pair = Get-DysonLifecycleBrokerValidatedTaskPair -Profile $provisional -Backend $Backend `
        -ShadowRoot $ShadowRoot -AllowPreparedDisabled
    $provisional.serverTask.descriptorHash = Get-DysonLifecycleBrokerExpectedActiveDescriptorHash $pair.server.descriptor
    $provisional.stopTask.descriptorHash = Get-DysonLifecycleBrokerExpectedActiveDescriptorHash $pair.stop.descriptor
    $provisional.dependencyHashes = New-InstallerDependencyHashes $provisional
    $profile = ConvertTo-DysonLifecycleBrokerValidatedProfile $provisional
    Assert-DysonLifecycleBrokerDependencies $profile
    Assert-InstallerRuntimeTaskBindings $profile
    return $profile
}

function Assert-InstallerNoPendingWork {
    param([Parameter(Mandatory)]$Storage)
    if (@(Get-ChildItem -LiteralPath $Storage.intents -Force -ErrorAction Stop).Count -ne 0) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
    }
    $requestIds = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $Storage.requests -Force -ErrorAction Stop)) {
        if ($file.PSIsContainer -or $file.Extension -cne '.json') {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        }
        $id = ConvertTo-DysonLifecycleBrokerGuid $file.BaseName 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        $paths = Get-DysonLifecycleBrokerRecordPaths $Storage $id
        if (-not (Test-DysonLifecycleBrokerSamePath $file.FullName $paths.request) -or
            -not (Test-Path -LiteralPath $paths.receipt -PathType Leaf)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        }
        try {
            $request = ConvertTo-DysonLifecycleBrokerValidatedRequest (Read-DysonLifecycleBrokerJson -Path $paths.request `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID')
            $receipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $paths.receipt `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
            if ([string]$request.brokerRequestId -cne $id -or [string]$receipt.brokerRequestId -cne $id -or
                [string]$request.requestFingerprint -cne [string]$receipt.requestFingerprint -or
                [string]$request.capability -cne [string]$receipt.capability) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
            }
        }
        catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' }
        $requestIds[$id] = $true
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $Storage.receipts -Force -ErrorAction Stop)) {
        if ($file.PSIsContainer -or $file.Extension -cne '.json') {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        }
        $id = ConvertTo-DysonLifecycleBrokerGuid $file.BaseName 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        if (-not $requestIds.ContainsKey($id)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        }
    }
}

function Get-InstallerExistingSnapshot {
    param([Parameter(Mandatory)]$Storage, [Parameter(Mandatory)][string]$ProfileFile)
    $resolvedProfile = Assert-DysonLifecycleBrokerPlainFile -Path $ProfileFile -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes
    $profileBytes = [IO.File]::ReadAllBytes($resolvedProfile)
    $profile = Read-DysonLifecycleBrokerProfile $resolvedProfile
    if (-not (Test-DysonLifecycleBrokerSamePath ([string]$profile.brokerRoot) ([string]$Storage.root))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    if ($PreviousBootstrapRoot) {
        $previousRoot = Assert-DysonLifecycleBrokerPlainDirectory $PreviousBootstrapRoot
        foreach ($entry in @($profile.dependencyHashes)) {
            $dependencyPath = Get-DysonLifecycleBrokerExpectedDependencyPath $profile ([string]$entry.name)
            if ([string]$entry.name -cin @('Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
                $dependencyPath = Join-Path $previousRoot ([string]$entry.name)
            }
            if ((Get-DysonLifecycleBrokerSha256File $dependencyPath) -cne [string]$entry.sha256) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT'
            }
        }
    }
    else { Assert-DysonLifecycleBrokerDependencies $profile }
    Assert-InstallerRuntimeTaskBindings $profile
    $profileAcl = Get-InstallerProfileAclSddl $resolvedProfile
    $task = Get-InstallerTaskSnapshot $profile
    Assert-InstallerNoPendingWork $Storage
    return [pscustomobject][ordered]@{
        profile = $profile; profileBytes = $profileBytes; profileAcl = $profileAcl; task = $task
    }
}

function Assert-InstallerPublishedState {
    param(
        [Parameter(Mandatory)][string]$ProfileFile, [Parameter(Mandatory)]$ExpectedProfile,
        [Parameter(Mandatory)][byte[]]$ExpectedBytes
    )
    $resolved = Assert-DysonLifecycleBrokerPlainFile -Path $ProfileFile -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes
    if (-not (Test-InstallerBytesEqual ([IO.File]::ReadAllBytes($resolved)) $ExpectedBytes)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    $actual = Read-DysonLifecycleBrokerProfile $resolved
    if ((ConvertTo-DysonLifecycleBrokerJson $actual) -cne (ConvertTo-DysonLifecycleBrokerJson $ExpectedProfile)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    Assert-DysonLifecycleBrokerDependencies $actual
    Assert-InstallerRuntimeTaskBindings $actual
    [void](Get-InstallerProfileAclSddl $resolved)
    [void](Get-InstallerTaskSnapshot $actual)
}

function Restore-InstallerUpgradeSnapshot {
    param([Parameter(Mandatory)][string]$ProfileFile, [Parameter(Mandatory)]$Snapshot)
    try {
        if ($PreviousBootstrapRoot) {
            foreach ($name in @('Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
                $source = Join-Path (Assert-DysonLifecycleBrokerPlainDirectory $PreviousBootstrapRoot) $name
                $entry = @($Snapshot.profile.dependencyHashes | Where-Object { [string]$_.name -ceq $name })
                if ($entry.Count -ne 1 -or
                    (Get-DysonLifecycleBrokerSha256File $source) -cne [string]$entry[0].sha256) {
                    Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT'
                }
                $destination = Get-DysonLifecycleBrokerExpectedDependencyPath $Snapshot.profile $name
                [void](Set-InstallerBytesAtomic -Path $destination -Bytes ([IO.File]::ReadAllBytes($source)) `
                    -MaximumBytes 1048576)
            }
        }
        [void](Set-InstallerBytesAtomic -Path $ProfileFile -Bytes ([byte[]]$Snapshot.profileBytes) `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes)
        Restore-InstallerProfileAcl -Path $ProfileFile -Sddl ([string]$Snapshot.profileAcl)
        Restore-InstallerTaskSnapshot $Snapshot.task
        Assert-InstallerPublishedState -ProfileFile $ProfileFile -ExpectedProfile $Snapshot.profile `
            -ExpectedBytes ([byte[]]$Snapshot.profileBytes)
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
}

function Initialize-InstallerShadow {
    if ($Backend -cne 'Shadow') { return }
    if ($env:DYSON_LIFECYCLE_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
    }
    $script:ShadowRoot = Assert-DysonLifecycleBrokerPlainDirectory $ShadowRoot
    if (-not (Test-Path -LiteralPath (Join-Path $script:ShadowRoot '.dyson-lifecycle-broker-selftest') -PathType Leaf)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
    }
    $script:InstallerShadowTaskFile = Join-Path $script:ShadowRoot 'broker-task.json'
    $script:InstallerShadowProfileAclFile = Join-Path $script:ShadowRoot 'broker-profile.sddl'
    $controlPath = Join-Path $script:ShadowRoot 'installer-control.json'
    if (Test-Path -LiteralPath $controlPath -PathType Leaf) {
        $control = Read-DysonLifecycleBrokerJson -Path $controlPath -MaximumBytes 4096 `
            -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        Assert-DysonLifecycleBrokerExactProperties $control @('failStage') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        if ([string]$control.failStage -cnotin $script:InstallerFailureStages) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
        $script:InstallerFailureStage = [string]$control.failStage
    }
    $ConfirmPreference = 'None'
}

function Invoke-InstallerFailurePoint {
    param([Parameter(Mandatory)][string]$Stage)
    if ($Backend -ceq 'Shadow' -and $script:InstallerFailureStage -ceq $Stage) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED'
    }
}

function New-InstallerReceipt {
    param(
        [Parameter(Mandatory)][ValidateSet('installed', 'reused', 'upgraded')][string]$Operation,
        [Parameter(Mandatory)]$Storage, [Parameter(Mandatory)][string]$ProfileFile,
        [Parameter(Mandatory)]$Profile
    )
    return [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_RECEIPT_V1'; schemaVersion = 1
        operation = $Operation; reused = ($Operation -ceq 'reused'); upgraded = ($Operation -ceq 'upgraded')
        brokerRoot = $Storage.root; profileFile = $ProfileFile; profileHash = Get-DysonLifecycleBrokerProfileHash $ProfileFile
        profileCreatedAt = [string]$Profile.createdAt; workerTaskName = $script:InstallerTaskName; workerTaskPath = $script:InstallerTaskPath
        serverTaskDescriptorHash = [string]$Profile.serverTask.descriptorHash
        stopTaskDescriptorHash = [string]$Profile.stopTask.descriptorHash; backend = $Backend
        aclIntent = Get-DysonLifecycleBrokerAclIntent 'S-1-5-19'; taskAclIntent = Get-DysonLifecycleBrokerTaskAclIntent
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function New-InstallerCompensationReceipt {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$RemovedProfileHash
    )
    return [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_COMPENSATION_RECEIPT_V1'; schemaVersion = 1
        operation = 'compensated-first-install'; brokerRoot = $Storage.root
        removedProfileHash = $RemovedProfileHash; workerTaskName = $script:InstallerTaskName
        workerTaskPath = $script:InstallerTaskPath; profileRemoved = $true; taskRemoved = $true
        preservedRequestCount = @(Get-ChildItem -LiteralPath $Storage.requests -File -Filter '*.json').Count
        preservedReceiptCount = @(Get-ChildItem -LiteralPath $Storage.receipts -File -Filter '*.json').Count
        backend = $Backend; compensatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function New-InstallerRemovalReceipt {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$RemovedProfileHash,
        [Parameter(Mandatory)][int]$PreservedRequestCount,
        [Parameter(Mandatory)][int]$PreservedReceiptCount
    )
    return [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_RECEIPT_V1'; schemaVersion = 1
        operation = 'removed-current'; brokerRoot = $Storage.root
        removedProfileHash = $RemovedProfileHash; workerTaskName = $script:InstallerTaskName
        workerTaskPath = $script:InstallerTaskPath; profileRemoved = $true; taskRemoved = $true
        preservedRequestCount = $PreservedRequestCount; preservedReceiptCount = $PreservedReceiptCount
        intentsEmpty = $true; backend = $Backend; removedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

$script:InstallerMode = 'none'
$script:InstallerSnapshot = $null
$script:InstallerUpgradeMutationStarted = $false
$script:InstallerFirstProfilePublished = $false
$script:InstallerFirstTaskRegistrationAttempted = $false
$script:InstallerRemoveMutationStarted = $false
$script:InstallerProfileFile = $null
$script:InstallerCandidateBytes = $null

try {
    Initialize-InstallerShadow
    if ($Backend -ceq 'Shadow') { $ConfirmPreference = 'None' }
    $exclusiveModeCount = [int][bool]$UpgradeExisting + [int][bool]$CompensateFirstInstall + [int][bool]$RemoveCurrent
    if ($exclusiveModeCount -gt 1 -or
        ($PSBoundParameters.ContainsKey('PreviousBootstrapRoot') -and
            (-not $UpgradeExisting -or [string]::IsNullOrWhiteSpace($PreviousBootstrapRoot))) -or
        ($RemoveCurrent -and -not $PSBoundParameters.ContainsKey('ExpectedProfileHash')) -or
        (-not $RemoveCurrent -and $PSBoundParameters.ContainsKey('ExpectedProfileHash'))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID'
    }
    $shouldProcessAction = if ($RemoveCurrent) {
        'Remove only the same-release fixed SYSTEM lifecycle broker task and immutable profile after fail-closed validation'
    }
    else { 'Install or explicitly upgrade the fixed SYSTEM lifecycle broker and immutable profile' }
    if (-not $PSCmdlet.ShouldProcess($script:InstallerTaskName, $shouldProcessAction)) {
        if ($RemoveCurrent) {
            [ordered]@{
                protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_PREVIEW_V1'; schemaVersion = 1
                operation = 'remove-current'; brokerRoot = Get-DysonLifecycleBrokerFullPath $BrokerRoot
                expectedProfileHash = $ExpectedProfileHash; workerTaskName = $script:InstallerTaskName
                workerTaskPath = $script:InstallerTaskPath; profileRemovalPlanned = $true
                taskRemovalPlanned = $true; historyPreserved = $true; dryRun = $true
            } | ConvertTo-Json -Compress
        }
        else {
            [ordered]@{
                protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_PREVIEW_V1'; schemaVersion = 1
                brokerRoot = Get-DysonLifecycleBrokerFullPath $BrokerRoot
                workerTaskName = $script:InstallerTaskName; workerTaskPath = $script:InstallerTaskPath
                upgradeExisting = [bool]$UpgradeExisting; compensateFirstInstall = [bool]$CompensateFirstInstall; dryRun = $true
            } | ConvertTo-Json -Compress
        }
        exit 0
    }
    if ($Backend -ceq 'Windows') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED'
        }
    }
    $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $BrokerRoot -Create
    $project = Assert-DysonLifecycleBrokerPlainDirectory $ProjectRoot
    $data = Assert-DysonLifecycleBrokerPlainDirectory $DataRoot
    $installed = Assert-DysonLifecycleBrokerPlainDirectory $InstalledWindowsRoot
    $bootstrap = Assert-DysonLifecycleBrokerPlainDirectory $RuntimeBootstrapRoot
    if (-not (Test-DysonLifecycleBrokerSamePath $PSScriptRoot (Join-Path $installed 'lifecycle-broker')) -or
        -not (Test-DysonLifecycleBrokerSamePath $storage.root (Join-Path $data 'lifecycle-broker'))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    $script:InstallerProfileFile = Join-Path $storage.root 'broker-profile.json'
    $hasProfile = Test-Path -LiteralPath $script:InstallerProfileFile -PathType Leaf
    if ($PreviousBootstrapRoot -and -not $hasProfile) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
    }

    if (($CompensateFirstInstall -or $RemoveCurrent) -and -not $hasProfile) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
    }

    if (-not $hasProfile) {
        $script:InstallerMode = 'first'
        if (Test-InstallerTaskExists) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT' }
        $profile = New-InstallerCandidateProfile -Storage $storage -Project $project -Data $data -Installed $installed `
            -Bootstrap $bootstrap -CreatedAt ((Get-Date).ToUniversalTime().ToString('o'))
        $descriptor = New-InstallerWorkerTaskDescriptor $profile
        [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $descriptor -Profile $profile)
        [void](Get-InstallerExpectedProfileAclSddl); [void](Get-DysonLifecycleBrokerTaskAclIntent)
        $script:InstallerCandidateBytes = Get-InstallerJsonBytes $profile
        Invoke-InstallerFailurePoint 'after-candidate-validated'
        if ($Backend -ceq 'Windows') {
            Set-InstallerDirectoryAcl -Path $storage.root -Kind root
            Set-InstallerDirectoryAcl -Path $storage.requests -Kind requests
            Set-InstallerDirectoryAcl -Path $storage.intents -Kind private
            Set-InstallerDirectoryAcl -Path $storage.receipts -Kind receipts
        }
        [void](Set-InstallerBytesAtomic -Path $script:InstallerProfileFile -Bytes $script:InstallerCandidateBytes `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes)
        $script:InstallerFirstProfilePublished = $true
        Set-InstallerProfileAcl $script:InstallerProfileFile
        Invoke-InstallerFailurePoint 'after-profile-published'
        $script:InstallerFirstTaskRegistrationAttempted = $true
        Register-InstallerTask -Profile $profile -Descriptor $descriptor
        Invoke-InstallerFailurePoint 'after-task-registered'
        Set-InstallerTaskAcl $profile
        Invoke-InstallerFailurePoint 'after-task-acl'
        Assert-InstallerPublishedState -ProfileFile $script:InstallerProfileFile -ExpectedProfile $profile `
            -ExpectedBytes $script:InstallerCandidateBytes
        Invoke-InstallerFailurePoint 'after-final-verified'
        New-InstallerReceipt -Operation installed -Storage $storage -ProfileFile $script:InstallerProfileFile -Profile $profile |
            ConvertTo-Json -Depth 12 -Compress
        exit 0
    }

    $script:InstallerMode = 'existing'
    $script:InstallerSnapshot = Get-InstallerExistingSnapshot -Storage $storage -ProfileFile $script:InstallerProfileFile
    $sameCandidate = New-InstallerCandidateProfile -Storage $storage -Project $project -Data $data -Installed $installed `
        -Bootstrap $bootstrap -CreatedAt ([string]$script:InstallerSnapshot.profile.createdAt)
    $sameDescriptor = New-InstallerWorkerTaskDescriptor $sameCandidate
    [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $sameDescriptor -Profile $sameCandidate)
    [void](Get-InstallerExpectedProfileAclSddl); [void](Get-DysonLifecycleBrokerTaskAclIntent)
    $sameBytes = Get-InstallerJsonBytes $sameCandidate
    Invoke-InstallerFailurePoint 'after-candidate-validated'
    $sameRelease = (Test-InstallerBytesEqual $sameBytes ([byte[]]$script:InstallerSnapshot.profileBytes)) -and
        (ConvertTo-DysonLifecycleBrokerJson $sameDescriptor) -ceq
            (ConvertTo-DysonLifecycleBrokerJson $script:InstallerSnapshot.task.descriptor)
    if ($CompensateFirstInstall -or $RemoveCurrent) {
        if (-not $sameRelease) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
        }
        $removedProfileHash = Get-DysonLifecycleBrokerProfileHash $script:InstallerProfileFile
        if ($RemoveCurrent -and $removedProfileHash -cne $ExpectedProfileHash) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
        }
        $preservedRequestCount = @(Get-ChildItem -LiteralPath $storage.requests -Force).Count
        $preservedReceiptCount = @(Get-ChildItem -LiteralPath $storage.receipts -Force).Count
        $script:InstallerMode = 'remove'
        $script:InstallerRemoveMutationStarted = $true
        Invoke-InstallerFailurePoint 'after-old-snapshot'
        Disable-InstallerTask $script:InstallerSnapshot.profile
        Invoke-InstallerFailurePoint 'after-task-disabled'
        Remove-InstallerTaskIfPresent
        if (Test-InstallerTaskExists) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
        Invoke-InstallerFailurePoint 'after-task-removed'
        Remove-DysonLifecycleBrokerPlainFile $script:InstallerProfileFile
        if ($Backend -ceq 'Shadow' -and (Test-Path -LiteralPath $script:InstallerShadowProfileAclFile -PathType Leaf)) {
            Remove-DysonLifecycleBrokerPlainFile $script:InstallerShadowProfileAclFile
        }
        if ((Test-Path -LiteralPath $script:InstallerProfileFile) -or
            -not (Test-Path -LiteralPath $storage.requests -PathType Container) -or
            -not (Test-Path -LiteralPath $storage.intents -PathType Container) -or
            -not (Test-Path -LiteralPath $storage.receipts -PathType Container)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED'
        }
        Invoke-InstallerFailurePoint 'after-profile-removed'
        Assert-InstallerNoPendingWork $storage
        if (@(Get-ChildItem -LiteralPath $storage.requests -Force).Count -ne $preservedRequestCount -or
            @(Get-ChildItem -LiteralPath $storage.receipts -Force).Count -ne $preservedReceiptCount -or
            @(Get-ChildItem -LiteralPath $storage.intents -Force).Count -ne 0) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED'
        }
        Invoke-InstallerFailurePoint 'after-final-verified'
        if ($RemoveCurrent) {
            New-InstallerRemovalReceipt -Storage $storage -RemovedProfileHash $removedProfileHash `
                -PreservedRequestCount $preservedRequestCount -PreservedReceiptCount $preservedReceiptCount |
                ConvertTo-Json -Depth 8 -Compress
        }
        else {
            New-InstallerCompensationReceipt -Storage $storage -RemovedProfileHash $removedProfileHash |
                ConvertTo-Json -Depth 8 -Compress
        }
        exit 0
    }
    if ($sameRelease) {
        Assert-InstallerPublishedState -ProfileFile $script:InstallerProfileFile -ExpectedProfile $sameCandidate -ExpectedBytes $sameBytes
        New-InstallerReceipt -Operation reused -Storage $storage -ProfileFile $script:InstallerProfileFile -Profile $sameCandidate |
            ConvertTo-Json -Depth 12 -Compress
        exit 0
    }
    if (-not $UpgradeExisting) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT' }

    $script:InstallerMode = 'upgrade'
    $candidate = New-InstallerCandidateProfile -Storage $storage -Project $project -Data $data -Installed $installed `
        -Bootstrap $bootstrap -CreatedAt ((Get-Date).ToUniversalTime().ToString('o'))
    $candidateDescriptor = New-InstallerWorkerTaskDescriptor $candidate
    [void](Assert-InstallerWorkerTaskDescriptor -Descriptor $candidateDescriptor -Profile $candidate)
    $script:InstallerCandidateBytes = Get-InstallerJsonBytes $candidate
    $script:InstallerUpgradeMutationStarted = $true
    Invoke-InstallerFailurePoint 'after-old-snapshot'
    Disable-InstallerTask $script:InstallerSnapshot.profile
    Invoke-InstallerFailurePoint 'after-task-disabled'
    [void](Set-InstallerBytesAtomic -Path $script:InstallerProfileFile -Bytes $script:InstallerCandidateBytes `
        -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes)
    Set-InstallerProfileAcl $script:InstallerProfileFile
    Invoke-InstallerFailurePoint 'after-profile-published'
    Register-InstallerTask -Profile $candidate -Descriptor $candidateDescriptor
    Invoke-InstallerFailurePoint 'after-task-registered'
    Set-InstallerTaskAcl $candidate
    Invoke-InstallerFailurePoint 'after-task-acl'
    Assert-InstallerPublishedState -ProfileFile $script:InstallerProfileFile -ExpectedProfile $candidate `
        -ExpectedBytes $script:InstallerCandidateBytes
    Invoke-InstallerFailurePoint 'after-final-verified'
    New-InstallerReceipt -Operation upgraded -Storage $storage -ProfileFile $script:InstallerProfileFile -Profile $candidate |
        ConvertTo-Json -Depth 12 -Compress
    exit 0
}
catch {
    $code = Get-DysonLifecycleBrokerErrorCode $_.Exception
    if ($script:InstallerMode -ceq 'upgrade' -and $script:InstallerUpgradeMutationStarted -and $null -ne $script:InstallerSnapshot) {
        try { Restore-InstallerUpgradeSnapshot -ProfileFile $script:InstallerProfileFile -Snapshot $script:InstallerSnapshot }
        catch { $code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
    }
    elseif ($script:InstallerMode -ceq 'remove' -and $script:InstallerRemoveMutationStarted -and $null -ne $script:InstallerSnapshot) {
        try { Restore-InstallerUpgradeSnapshot -ProfileFile $script:InstallerProfileFile -Snapshot $script:InstallerSnapshot }
        catch { $code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
    }
    elseif ($script:InstallerMode -ceq 'first') {
        try {
            if ($script:InstallerFirstTaskRegistrationAttempted -and (Test-InstallerTaskExists)) { Remove-InstallerTaskIfPresent }
            if ($script:InstallerFirstProfilePublished -and (Test-Path -LiteralPath $script:InstallerProfileFile -PathType Leaf)) {
                $actual = [IO.File]::ReadAllBytes((Assert-DysonLifecycleBrokerPlainFile -Path $script:InstallerProfileFile `
                    -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes))
                if (Test-InstallerBytesEqual $actual ([byte[]]$script:InstallerCandidateBytes)) {
                    Remove-DysonLifecycleBrokerPlainFile $script:InstallerProfileFile
                }
            }
            if ($Backend -ceq 'Shadow' -and $script:InstallerFirstProfilePublished -and
                (Test-Path -LiteralPath $script:InstallerShadowProfileAclFile -PathType Leaf)) {
                Remove-DysonLifecycleBrokerPlainFile $script:InstallerShadowProfileAclFile
            }
        }
        catch { $code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' }
    }
    Write-DysonLifecycleBrokerFailureEnvelope $code
    exit 1
}
