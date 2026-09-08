[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$BrokerScriptRoot,
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$AuthorityProfileFile,
    [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
    [Parameter(Mandatory)][string]$CutoverScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
    [Parameter(Mandatory)][string]$ServiceUser,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$GamePort,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Cutover-Broker',
    [ValidateSet('Install', 'CompensateFirstInstall', 'RemoveCurrent')][string]$Operation = 'Install',
    [string]$CompensateInstallRequestId,
    [string]$ExpectedProfileFingerprint,
    [string]$ExpectedBrokerBundleSha256,
    [switch]$UpgradeExisting,
    [ValidateSet('Windows', 'Shadow')][string]$SchedulerBackend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-InstallerSelfTestStage {
    param([Parameter(Mandatory)][string]$Stage)
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_CUTOVER_BROKER_SELFTEST -ceq '1' -and
        -not [string]::IsNullOrWhiteSpace($ShadowRoot) -and (Test-Path -LiteralPath $ShadowRoot -PathType Container)) {
        [IO.File]::AppendAllText((Join-Path $ShadowRoot 'install-stage.log'), $Stage + "`n", [Text.UTF8Encoding]::new($false))
    }
}

$script:DysonCutoverBrokerExactScriptNames = @(
    'DysonCutoverBroker.Common.ps1',
    'DysonCutoverBroker.TaskAcl.ps1',
    'Install-DysonCutoverBrokerTask.ps1',
    'Invoke-DysonCutoverBrokerWorker.ps1',
    'SelfTest-DysonCutoverBroker.ps1',
    'Submit-DysonCutoverBrokerRequest.ps1'
)

function Invoke-InstallerSelfTestFailure {
    param([Parameter(Mandatory)][string]$Stage)

    Write-InstallerSelfTestStage $Stage
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_CUTOVER_BROKER_SELFTEST -ceq '1' -and
        [string]$env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE -ceq $Stage) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED'
    }
}

function Get-InstallerBrokerScriptBundle {
    param([Parameter(Mandatory)][string]$Scripts)

    try {
        $root = Assert-DysonCutoverBrokerPlainDirectory $Scripts
        $items = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
        $actual = @($items | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        $expected = @($script:DysonCutoverBrokerExactScriptNames | Sort-Object -CaseSensitive)
        if ($items.Count -ne $expected.Count -or
            [string]::Join("`n", $actual) -cne [string]::Join("`n", $expected)) {
            throw 'bundle inventory'
        }
        $files = @()
        foreach ($name in $script:DysonCutoverBrokerExactScriptNames) {
            $path = Assert-DysonCutoverBrokerPlainFile (Join-Path $root $name) 16777216
            $files += [pscustomobject][ordered]@{
                name = $name
                sha256 = Get-DysonCutoverBrokerSha256File $path
            }
        }
        $descriptor = [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_BROKER_SCRIPT_BUNDLE_V1'
            schemaVersion = 1
            files = $files
        }
        return [pscustomobject][ordered]@{
            root = $root
            descriptor = $descriptor
            sha256 = Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $descriptor)
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
}

function Write-InstallerFileNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $stream = $null
    try {
        if ($Bytes.Length -lt 1 -or $Bytes.Length -gt $MaximumBytes) { throw 'invalid bytes' }
        $directory = Assert-DysonCutoverBrokerPlainDirectory ([IO.Path]::GetDirectoryName($Path))
        $expected = Join-Path $directory ([IO.Path]::GetFileName($Path))
        if (-not (Test-DysonCutoverBrokerSamePath $expected $Path) -or
            (Test-DysonCutoverBrokerPathExists $expected)) {
            throw 'invalid destination'
        }
        $stream = [IO.FileStream]::new(
            (ConvertTo-DysonCutoverBrokerExtendedPath $expected),
            [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $persisted = Assert-DysonCutoverBrokerPlainFile $expected $MaximumBytes
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes(
                (ConvertTo-DysonCutoverBrokerExtendedPath $persisted)
            )) -cne [Convert]::ToBase64String($Bytes)) {
            throw 'persisted bytes changed'
        }
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Set-InstallerFileAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $temporary = $null
    $replacementBackup = $null
    $stream = $null
    $fileSddl = $null
    try {
        if ($Bytes.Length -lt 1 -or $Bytes.Length -gt $MaximumBytes) { throw 'invalid bytes' }
        $directory = Assert-DysonCutoverBrokerPlainDirectory ([IO.Path]::GetDirectoryName($Path))
        $expected = Join-Path $directory ([IO.Path]::GetFileName($Path))
        if (-not (Test-DysonCutoverBrokerSamePath $expected $Path)) { throw 'invalid destination' }
        if (Test-DysonCutoverBrokerPathExists $expected) {
            [void](Assert-DysonCutoverBrokerPlainFile $expected $MaximumBytes)
            $fileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $expected -ErrorAction Stop).Sddl
        }
        $temporary = Join-Path $directory ('.broker-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $stream = [IO.FileStream]::new(
            (ConvertTo-DysonCutoverBrokerExtendedPath $temporary),
            [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [void](Assert-DysonCutoverBrokerPlainFile $temporary $MaximumBytes)
        if (Test-DysonCutoverBrokerFileExists $expected) {
            $replacementBackup = Join-Path $directory ('.backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
            [IO.File]::Replace(
                (ConvertTo-DysonCutoverBrokerExtendedPath $temporary),
                (ConvertTo-DysonCutoverBrokerExtendedPath $expected),
                (ConvertTo-DysonCutoverBrokerExtendedPath $replacementBackup)
            )
            [void](Assert-DysonCutoverBrokerPlainFile $replacementBackup $MaximumBytes)
            [IO.File]::Delete((ConvertTo-DysonCutoverBrokerExtendedPath $replacementBackup))
            if (Test-DysonCutoverBrokerPathExists $replacementBackup) { throw 'backup survived removal' }
            $replacementBackup = $null
        }
        else {
            [IO.File]::Move(
                (ConvertTo-DysonCutoverBrokerExtendedPath $temporary),
                (ConvertTo-DysonCutoverBrokerExtendedPath $expected)
            )
        }
        $temporary = $null
        $persisted = Assert-DysonCutoverBrokerPlainFile $expected $MaximumBytes
        if ($null -ne $fileSddl) { Restore-DysonCutoverBrokerFileSecurityPreimage -Path $persisted -Sddl $fileSddl }
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes(
                (ConvertTo-DysonCutoverBrokerExtendedPath $persisted)
            )) -cne [Convert]::ToBase64String($Bytes)) {
            throw 'persisted bytes changed'
        }
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE' }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $temporary -and (Test-DysonCutoverBrokerFileExists $temporary)) {
            try { [IO.File]::Delete((ConvertTo-DysonCutoverBrokerExtendedPath $temporary)) } catch {}
        }
        if ($null -ne $replacementBackup -and (Test-DysonCutoverBrokerFileExists $replacementBackup)) {
            try { [IO.File]::Delete((ConvertTo-DysonCutoverBrokerExtendedPath $replacementBackup)) } catch {}
        }
    }
}

function Set-InstallerJsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-DysonCutoverBrokerJson $Value) + "`n")
    Set-InstallerFileAtomic -Path $Path -Bytes $bytes -MaximumBytes $MaximumBytes
}

function Get-InstallerExpectedShadowTaskIntent {
    param([Parameter(Mandatory)]$Profile)

    return [pscustomobject][ordered]@{
        taskName = $Profile.taskName
        taskPath = $Profile.taskPath
        principal = 'S-1-5-18'
        runLevel = 'Highest'
        executable = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        arguments = Get-DysonCutoverBrokerTaskArguments $Profile
        multipleInstances = 'IgnoreNew'
        enabled = $true
        acl = Get-DysonFixedTaskReadExecuteAclIntent
    }
}

function ConvertTo-InstallerValidatedInstallReceipt {
    param([Parameter(Mandatory)]$Raw)

    try {
        $expected = @(
            'protocol', 'schemaVersion', 'requestId', 'operation', 'profileFingerprint',
            'brokerBundleSha256', 'taskName', 'taskPath', 'taskSddlSha256', 'status',
            'reused', 'upgraded', 'previousProfileFingerprint', 'transactionId', 'completedAt'
        )
        $actual = @($Raw.PSObject.Properties.Name)
        $completedAt = [datetimeoffset]::MinValue
        if ($actual.Count -ne $expected.Count -or
            @($actual | Where-Object { $expected -cnotcontains $_ }).Count -ne 0 -or
            [string]$Raw.protocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -or
            [int]$Raw.schemaVersion -ne 1 -or
            [string]$Raw.requestId -cnotmatch '^[0-9a-f-]{36}$' -or
            [string]$Raw.operation -cnotin @('installed', 'upgraded', 'reused') -or
            [string]$Raw.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Raw.brokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Raw.taskName -cne $script:DysonCutoverBrokerTaskName -or
            [string]$Raw.taskPath -cne $script:DysonCutoverBrokerTaskPath -or
            [string]$Raw.taskSddlSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Raw.status -cne 'succeeded' -or
            $Raw.reused -isnot [bool] -or $Raw.upgraded -isnot [bool] -or
            ([string]$Raw.operation -ceq 'installed' -and ([bool]$Raw.reused -or [bool]$Raw.upgraded)) -or
            ([string]$Raw.operation -ceq 'upgraded' -and (-not [bool]$Raw.upgraded -or [bool]$Raw.reused)) -or
            ([string]$Raw.operation -ceq 'reused' -and (-not [bool]$Raw.reused -or [bool]$Raw.upgraded)) -or
            ([string]$Raw.operation -ceq 'upgraded' -and
                ([string]$Raw.previousProfileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
                    [string]$Raw.transactionId -cnotmatch '^[0-9a-f-]{36}$')) -or
            ([string]$Raw.operation -cne 'upgraded' -and
                ($null -ne $Raw.previousProfileFingerprint -or $null -ne $Raw.transactionId)) -or
            -not [datetimeoffset]::TryParseExact(
                [string]$Raw.completedAt, 'o', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$completedAt
            )) {
            throw 'invalid install receipt'
        }
        return $Raw
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT' }
}

function Assert-InstallerNoPendingBrokerWork {
    param([Parameter(Mandatory)]$Storage)

    try {
        foreach ($root in @($Storage.requestsRoot, $Storage.intentsRoot, $Storage.workRoot)) {
            if (@(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop).Count -ne 0) {
                throw 'pending broker work'
            }
        }
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED' }
}

function Test-InstallerShadowTaskDefinition {
    param(
        [Parameter(Mandatory)]$TaskIntent,
        [Parameter(Mandatory)]$Profile
    )

    try {
        $expected = Get-InstallerExpectedShadowTaskIntent $Profile
        return (ConvertTo-DysonCutoverBrokerJson $TaskIntent) -ceq (ConvertTo-DysonCutoverBrokerJson $expected)
    }
    catch { return $false }
}

function Get-InstallerNormalizedTaskDacl {
    param([Parameter(Mandatory)][string]$Sddl)

    try {
        $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $Sddl)
        return $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID' }
}

function Test-InstallerProfileMatchesBundle {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Bundle
    )

    try {
        $hashes = @{}
        foreach ($file in @($Bundle.descriptor.files)) { $hashes[[string]$file.name] = [string]$file.sha256 }
        return (
            $hashes.Count -eq $script:DysonCutoverBrokerExactScriptNames.Count -and
            [string]$Profile.commonScriptSha256 -ceq $hashes['DysonCutoverBroker.Common.ps1'] -and
            [string]$Profile.taskAclScriptSha256 -ceq $hashes['DysonCutoverBroker.TaskAcl.ps1'] -and
            [string]$Profile.installerScriptSha256 -ceq $hashes['Install-DysonCutoverBrokerTask.ps1'] -and
            [string]$Profile.workerScriptSha256 -ceq $hashes['Invoke-DysonCutoverBrokerWorker.ps1'] -and
            [string]$Profile.submitScriptSha256 -ceq $hashes['Submit-DysonCutoverBrokerRequest.ps1'] -and
            [string]$hashes['SelfTest-DysonCutoverBroker.ps1'] -cmatch '^[0-9a-f]{64}$'
        )
    }
    catch { return $false }
}

function ConvertTo-InstallerUtf8Bytes {
    param([Parameter(Mandatory)][string]$Text)
    return [Text.UTF8Encoding]::new($false).GetBytes($Text)
}

function Get-InstallerTaskXmlFingerprint {
    param([Parameter(Mandatory)][string]$Xml)

    try {
        if ([string]::IsNullOrWhiteSpace($Xml) -or $Xml.Length -gt 1048576) { throw 'invalid task XML' }
        $document = [Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $false
        $document.XmlResolver = $null
        $document.LoadXml($Xml)
        return Get-DysonCutoverBrokerSha256Text $document.OuterXml
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID' }
}

function New-InstallerBundleBinding {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Bundle
    )

    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_BUNDLE_BINDING_V1'
        schemaVersion = 1
        profileFingerprint = [string]$Profile.profileFingerprint
        brokerBundleSha256 = [string]$Bundle.sha256
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function ConvertTo-InstallerValidatedBundleBinding {
    param([Parameter(Mandatory)]$Raw)

    try {
        $expected = @('protocol', 'schemaVersion', 'profileFingerprint', 'brokerBundleSha256', 'createdAt')
        $actual = @($Raw.PSObject.Properties.Name)
        $parsed = [datetimeoffset]::MinValue
        if ($actual.Count -ne $expected.Count -or @($actual | Where-Object { $expected -cnotcontains $_ }).Count -ne 0 -or
            [string]$Raw.protocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_BUNDLE_BINDING_V1' -or
            [int]$Raw.schemaVersion -ne 1 -or
            [string]$Raw.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Raw.brokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            -not [datetimeoffset]::TryParseExact(
                [string]$Raw.createdAt, 'o', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed
            )) { throw 'invalid bundle binding' }
        return [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_BROKER_BUNDLE_BINDING_V1'
            schemaVersion = 1
            profileFingerprint = [string]$Raw.profileFingerprint
            brokerBundleSha256 = [string]$Raw.brokerBundleSha256
            createdAt = [string]$Raw.createdAt
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
}

function Assert-InstallerAuthorityProfile {
    param(
        [Parameter(Mandatory)][string]$ProfileFile,
        [Parameter(Mandatory)][string]$Revision,
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Data,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$BootstrapRoot,
        [Parameter(Mandatory)][string]$TransactionRoot,
        [Parameter(Mandatory)][string]$User,
        [Parameter(Mandatory)][int]$Port
    )

    try {
        $leaseCommon = Join-Path $ScriptRoot 'DysonHostMutationLease.Common.ps1'
        $hostCommon = Join-Path $ScriptRoot 'cutover\DysonCutoverHost.Common.ps1'
        [void](Assert-DysonCutoverBrokerPlainFile $leaseCommon 2097152)
        [void](Assert-DysonCutoverBrokerPlainFile $hostCommon 2097152)
        . $leaseCommon
        . $hostCommon
        $raw = Read-DysonCutoverBrokerJson $ProfileFile $script:DysonCutoverBrokerMaximumProfileBytes `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
        $authority = ConvertTo-CutoverHostValidatedProfile $raw
        $profileRoot = [IO.Path]::GetDirectoryName($ProfileFile)
        if ([string]$authority.inventoryRevision -cne $Revision -or
            [string]$authority.projectRootIdentity -cne (Get-CutoverHostPathIdentity $Project) -or
            [string]$authority.dataRootIdentity -cne (Get-DysonHostMutationDataRootIdentity $Data) -or
            [string]$authority.authorityRootIdentity -cne (Get-CutoverHostPathIdentity $profileRoot) -or
            [string]$authority.runtimeBootstrapIdentity -cne (Get-CutoverHostPathIdentity $BootstrapRoot) -or
            [string]$authority.runtimeTaskTransactionRootIdentity -cne (Get-CutoverHostPathIdentity $TransactionRoot) -or
            -not [string]::Equals([string]$authority.serviceUser, $User, [StringComparison]::OrdinalIgnoreCase) -or
            [int]$authority.gamePort -ne $Port) {
            throw 'authority binding'
        }
        $start = Join-Path $BootstrapRoot 'Start-DysonServer.ps1'
        $stop = Join-Path $BootstrapRoot 'Stop-DysonServer.ps1'
        if ([string]$authority.runtimeBootstrapStartSha256 -cne (Get-CutoverHostSha256File $start) -or
            [string]$authority.runtimeBootstrapStopSha256 -cne (Get-CutoverHostSha256File $stop)) {
            throw 'bootstrap digest'
        }
        return $authority
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and
            [string]$_.Exception.Data['Code'] -like 'DYSON_CONTROL_CUTOVER_BROKER_*') {
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
}

function New-InstallerBrokerProfile {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$Scripts,
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Data,
        [Parameter(Mandatory)][string]$AuthorityFile,
        [Parameter(Mandatory)][string]$CutoverRoot,
        [Parameter(Mandatory)][string]$BootstrapRoot,
        [Parameter(Mandatory)][string]$TransactionRoot,
        [Parameter(Mandatory)][string]$User,
        [Parameter(Mandatory)][int]$Port
    )

    $core = [pscustomobject][ordered]@{
        protocol = $script:DysonCutoverBrokerProfileProtocol
        schemaVersion = 1
        brokerRoot = $Storage.brokerRoot
        brokerScriptRoot = $Scripts
        projectRoot = $Project
        dataRoot = $Data
        authorityProfileFile = $AuthorityFile
        authorityProfileSha256 = Get-DysonCutoverBrokerSha256File $AuthorityFile
        cutoverScriptRoot = $CutoverRoot
        leaseCommonSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'DysonHostMutationLease.Common.ps1')
        cutoverHostCommonSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'cutover\DysonCutoverHost.Common.ps1')
        cutoverActionScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'cutover\Invoke-DysonCutoverAction.ps1')
        runtimeTaskInstallerSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'Install-DysonRuntimeTasks.ps1')
        runtimeBootstrapRoot = $BootstrapRoot
        runtimeTaskTransactionRoot = $TransactionRoot
        serviceUser = $User
        gamePort = $Port
        taskName = $script:DysonCutoverBrokerTaskName
        taskPath = $script:DysonCutoverBrokerTaskPath
        localServiceSid = 'S-1-5-19'
        commonScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $Scripts 'DysonCutoverBroker.Common.ps1')
        taskAclScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $Scripts 'DysonCutoverBroker.TaskAcl.ps1')
        installerScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $Scripts 'Install-DysonCutoverBrokerTask.ps1')
        workerScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $Scripts 'Invoke-DysonCutoverBrokerWorker.ps1')
        submitScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $Scripts 'Submit-DysonCutoverBrokerRequest.ps1')
        previousStopScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'Stop-DysonServer.ps1')
        cutoverEvidenceScriptSha256 = Get-DysonCutoverBrokerSha256File (Join-Path $CutoverRoot 'cutover\Get-DysonCutoverEvidence.ps1')
    }
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['profileFingerprint'] = Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $core)
    return ConvertTo-DysonCutoverBrokerValidatedProfile ([pscustomobject]$profile)
}

function Get-InstallerDirectoryAclIntent {
    param([Parameter(Mandatory)][ValidateSet('root', 'requests', 'receipts', 'private')][string]$Kind)

    $localService = switch ($Kind) {
        'requests' { 'modify' }
        'root' { 'read-execute' }
        'receipts' { 'read-execute' }
        default { 'none' }
    }
    return [pscustomobject][ordered]@{
        kind = $Kind
        protected = $true
        system = 'full'
        administrators = 'full'
        localService = $localService
    }
}

function Set-InstallerDirectoryAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('root', 'requests', 'receipts', 'private')][string]$Kind
    )

    try {
        $directory = Assert-DysonCutoverBrokerPlainDirectory $Path
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation = [Security.AccessControl.PropagationFlags]::None
        foreach ($entry in @(
            @('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl),
            @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl)
        )) {
            $sid = [Security.Principal.SecurityIdentifier]::new([string]$entry[0])
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid, $entry[1], $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
        if ($Kind -ne 'private') {
            $rights = if ($Kind -ceq 'requests') {
                [Security.AccessControl.FileSystemRights]::Modify
            }
            else { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
            $localService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $localService, $rights, $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $directory -AclObject $security -ErrorAction Stop
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED' }
}

function Test-InstallerTaskDefinition {
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)]$Profile
    )

    try {
        if ([string]$Task.TaskName -cne $Profile.taskName -or [string]$Task.TaskPath -cne $Profile.taskPath -or
            [string]$Task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or
            [string]$Task.Principal.LogonType -cne 'ServiceAccount' -or
            [string]$Task.Principal.RunLevel -cne 'Highest') { throw 'principal' }
        $actions = @($Task.Actions)
        $expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        if ($actions.Count -ne 1 -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)),
                $expectedPowerShell,
                [StringComparison]::OrdinalIgnoreCase
            ) -or [string]$actions[0].Arguments -cne (Get-DysonCutoverBrokerTaskArguments $Profile)) {
            throw 'action'
        }
        return $true
    }
    catch { return $false }
}

try {
    $commonPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.Common.ps1'
    $aclPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.TaskAcl.ps1'
    if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $aclPath -PathType Leaf)) { throw 'dependency' }
    . $commonPath
    . $aclPath
    $securityModuleManifest = Join-Path $PSHOME `
        'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    if (-not (Test-Path -LiteralPath $securityModuleManifest -PathType Leaf)) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED'
    }
    Import-Module -Name $securityModuleManifest -Force -ErrorAction Stop
    Write-InstallerSelfTestStage 'dependencies-loaded'

    $normalizedRequestId = ConvertTo-DysonCutoverBrokerGuid $RequestId
    $normalizedCompensateInstallRequestId = $null
    if ($Operation -ceq 'CompensateFirstInstall') {
        if ([string]::IsNullOrWhiteSpace($CompensateInstallRequestId) -or $UpgradeExisting) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
        $normalizedCompensateInstallRequestId = ConvertTo-DysonCutoverBrokerGuid $CompensateInstallRequestId
        if ($normalizedCompensateInstallRequestId -ceq $normalizedRequestId) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
        if ($PSBoundParameters.ContainsKey('ExpectedProfileFingerprint') -or
            $PSBoundParameters.ContainsKey('ExpectedBrokerBundleSha256')) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
    }
    elseif ($Operation -ceq 'RemoveCurrent') {
        if ($UpgradeExisting -or $PSBoundParameters.ContainsKey('CompensateInstallRequestId') -or
            [string]$ExpectedProfileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$ExpectedBrokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$') {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
    }
    elseif ($PSBoundParameters.ContainsKey('CompensateInstallRequestId') -or
        $PSBoundParameters.ContainsKey('ExpectedProfileFingerprint') -or
        $PSBoundParameters.ContainsKey('ExpectedBrokerBundleSha256')) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
    }
    if ($TaskName -cne $script:DysonCutoverBrokerTaskName -or
        $AuthorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$') {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
    }
    $project = Assert-DysonCutoverBrokerPlainDirectory $ProjectRoot
    $data = Assert-DysonCutoverBrokerPlainDirectory $DataRoot
    $authorityFile = Assert-DysonCutoverBrokerPlainFile $AuthorityProfileFile $script:DysonCutoverBrokerMaximumProfileBytes
    $cutoverRoot = Assert-DysonCutoverBrokerPlainDirectory $CutoverScriptRoot
    $scripts = Assert-DysonCutoverBrokerPlainDirectory $BrokerScriptRoot
    $bootstrap = Assert-DysonCutoverBrokerPlainDirectory $RuntimeBootstrapRoot
    $transactions = Assert-DysonCutoverBrokerPlainDirectory $RuntimeTaskTransactionRoot
    $expectedBrokerRoot = [IO.Path]::GetFullPath((Join-Path $data 'cutover-broker')).TrimEnd('\', '/')
    $suppliedBrokerRoot = Get-DysonCutoverBrokerFullPath $BrokerRoot
    if (-not [string]::Equals($expectedBrokerRoot, $suppliedBrokerRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-DysonCutoverBrokerSamePath $scripts (Join-Path $cutoverRoot 'cutover-broker')) -or
        -not (Test-DysonCutoverBrokerSamePath $PSScriptRoot $scripts)) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
    [void](Assert-InstallerAuthorityProfile -ProfileFile $authorityFile -Revision $AuthorityInventoryRevision `
        -Project $project -Data $data -ScriptRoot $cutoverRoot -BootstrapRoot $bootstrap `
        -TransactionRoot $transactions -User $ServiceUser -Port $GamePort)
    [void](Assert-DysonFixedTaskReadExecuteAclIntent (Get-DysonFixedTaskReadExecuteSddl))
    $candidateBundleAtPreflight = Get-InstallerBrokerScriptBundle $scripts
    Write-InstallerSelfTestStage 'preflight-validated'
    if ($SchedulerBackend -ceq 'Shadow' -and $env:DYSON_CUTOVER_BROKER_SELFTEST -ceq '1') {
        $ConfirmPreference = 'None'
    }

    $installerAction = if ($Operation -ceq 'CompensateFirstInstall') {
        'compensate a verified first-install cutover broker task/profile without removing durable receipts'
    }
    elseif ($Operation -ceq 'RemoveCurrent') {
        'remove the fully bound current cutover broker task/profile without removing durable receipts'
    }
    else { 'install the fixed SYSTEM cutover broker task and protected LocalService request channel' }
    if (-not $PSCmdlet.ShouldProcess(
        ($script:DysonCutoverBrokerTaskPath + $script:DysonCutoverBrokerTaskName),
        $installerAction
    )) {
        [pscustomobject][ordered]@{
            protocol = if ($Operation -cne 'Install') {
                'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_PREVIEW_V1'
            }
            else { 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_PREVIEW_V1' }
            schemaVersion = 1
            requestId = $normalizedRequestId
            operation = $Operation
            compensateInstallRequestId = $normalizedCompensateInstallRequestId
            expectedProfileFingerprint = if ($Operation -ceq 'RemoveCurrent') { $ExpectedProfileFingerprint } else { $null }
            expectedBrokerBundleSha256 = if ($Operation -ceq 'RemoveCurrent') { $ExpectedBrokerBundleSha256 } else { $null }
            brokerRoot = $suppliedBrokerRoot
            brokerScriptRoot = $scripts
            brokerBundleSha256 = $candidateBundleAtPreflight.sha256
            taskName = $script:DysonCutoverBrokerTaskName
            taskPath = $script:DysonCutoverBrokerTaskPath
            taskAcl = Get-DysonFixedTaskReadExecuteAclIntent
            upgradeExisting = [bool]$UpgradeExisting
            dryRun = $true
        } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }

    $profileMutationStarted = $false
    $bundleBindingMutationStarted = $false
    $taskMutationStarted = $false
    $directoryIntentMutationStarted = $false
    $receiptWasCreated = $false
    $storage = $null
    $shadow = $null
    $taskIntentPath = $null
    $directoryAclIntentPath = $null
    $oldProfile = $null
    $oldProfileBytes = $null
    $oldBundleBinding = $null
    $oldBundleBindingBytes = $null
    $oldBundle = $null
    $oldTaskIntentBytes = $null
    $oldDirectoryAclIntentBytes = $null
    $oldTaskXml = $null
    $oldTaskXmlFingerprint = $null
    $oldTaskSddl = $null
    $oldTaskDacl = $null
    $transactionDirectory = $null
    $transactionRecord = $null
    $transactionPrepared = $false
    $preimageValidated = $false
    $receiptPath = $null
    try {
        if ($SchedulerBackend -ceq 'Shadow') {
            if ($env:DYSON_CUTOVER_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
            }
            $shadow = Assert-DysonCutoverBrokerPlainDirectory $ShadowRoot
            if (-not (Test-Path -LiteralPath (Join-Path $shadow '.dyson-cutover-broker-selftest') -PathType Leaf)) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
            }
            $taskIntentPath = Join-Path $shadow 'task-intent.json'
            $directoryAclIntentPath = Join-Path $shadow 'directory-acl-intent.json'
        }
        else {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED'
            }
        }

        $storage = Get-DysonCutoverBrokerStorage -BrokerRoot $suppliedBrokerRoot -Create
        $installationRoot = Assert-DysonCutoverBrokerPlainDirectory `
            (Join-Path $storage.brokerRoot 'installation-receipts') -Create
        $installationTransactionsRoot = Assert-DysonCutoverBrokerPlainDirectory `
            (Join-Path $storage.brokerRoot 'installation-transactions') -Create
        Write-InstallerSelfTestStage 'storage-created'
        if ($SchedulerBackend -ceq 'Windows') {
            Set-InstallerDirectoryAcl $storage.brokerRoot root
            Set-InstallerDirectoryAcl $storage.requestsRoot requests
            Set-InstallerDirectoryAcl $storage.receiptsRoot receipts
            Set-InstallerDirectoryAcl $storage.intentsRoot private
            Set-InstallerDirectoryAcl $storage.workRoot private
            Set-InstallerDirectoryAcl $installationRoot receipts
            Set-InstallerDirectoryAcl $installationTransactionsRoot private
        }

        $candidateBundle = Get-InstallerBrokerScriptBundle $scripts
        if ([string]$candidateBundle.sha256 -cne [string]$candidateBundleAtPreflight.sha256) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
        }
        $profile = New-InstallerBrokerProfile -Storage $storage -Scripts $scripts -Project $project `
            -Data $data -AuthorityFile $authorityFile -CutoverRoot $cutoverRoot -BootstrapRoot $bootstrap `
            -TransactionRoot $transactions -User $ServiceUser -Port $GamePort
        $candidateBundleAfterProfile = Get-InstallerBrokerScriptBundle $scripts
        if ([string]$candidateBundleAfterProfile.sha256 -cne [string]$candidateBundle.sha256 -or
            -not (Test-InstallerProfileMatchesBundle -Profile $profile -Bundle $candidateBundleAfterProfile)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
        }
        $candidateBundle = $candidateBundleAfterProfile
        $candidateBundleBinding = New-InstallerBundleBinding -Profile $profile -Bundle $candidateBundle
        $candidateTaskIntent = Get-InstallerExpectedShadowTaskIntent $profile
        if (-not (Test-InstallerShadowTaskDefinition -TaskIntent $candidateTaskIntent -Profile $profile)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
        }
        $candidateTaskDefinitionSha256 = Get-DysonCutoverBrokerSha256Text `
            (ConvertTo-DysonCutoverBrokerJson $candidateTaskIntent)
        Write-InstallerSelfTestStage 'candidate-validated'

        $existingProfileRaw = Read-DysonCutoverBrokerJson -Path $storage.profileFile `
            -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID'
        if ($null -ne $existingProfileRaw) {
            $oldProfileFile = Assert-DysonCutoverBrokerPlainFile `
                $storage.profileFile $script:DysonCutoverBrokerMaximumProfileBytes
            $oldProfileBytes = [IO.File]::ReadAllBytes($oldProfileFile)
            $oldProfile = ConvertTo-DysonCutoverBrokerValidatedProfile $existingProfileRaw
            $oldBundle = Get-InstallerBrokerScriptBundle $oldProfile.brokerScriptRoot
            $bundleBindingPath = Join-Path $storage.brokerRoot 'broker-bundle.json'
            $oldBundleBindingFile = Assert-DysonCutoverBrokerPlainFile `
                $bundleBindingPath $script:DysonCutoverBrokerMaximumProfileBytes
            $oldBundleBindingBytes = [IO.File]::ReadAllBytes($oldBundleBindingFile)
            $oldBundleBinding = ConvertTo-InstallerValidatedBundleBinding `
                (Read-DysonCutoverBrokerJson $bundleBindingPath $script:DysonCutoverBrokerMaximumProfileBytes `
                    -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
            if (-not (Test-InstallerProfileMatchesBundle -Profile $oldProfile -Bundle $oldBundle) -or
                [string]$oldBundleBinding.profileFingerprint -cne [string]$oldProfile.profileFingerprint -or
                [string]$oldBundleBinding.brokerBundleSha256 -cne [string]$oldBundle.sha256) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
            }
        }
        else {
            $bundleBindingPath = Join-Path $storage.brokerRoot 'broker-bundle.json'
            if (Test-Path -LiteralPath $bundleBindingPath) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
            }
        }
        $isUpgrade = $null -ne $oldProfile -and
            [string]$oldProfile.profileFingerprint -cne [string]$profile.profileFingerprint
        $isSameRelease = $null -ne $oldProfile -and
            [string]$oldProfile.profileFingerprint -ceq [string]$profile.profileFingerprint
        if ($Operation -ceq 'Install' -and $isUpgrade -and -not $UpgradeExisting) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
        if ($Operation -ceq 'Install' -and $UpgradeExisting -and $null -eq $oldProfile) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }

        $directoryAclIntent = @(
            Get-InstallerDirectoryAclIntent root
            Get-InstallerDirectoryAclIntent requests
            Get-InstallerDirectoryAclIntent receipts
            Get-InstallerDirectoryAclIntent private
        )
        if ($SchedulerBackend -ceq 'Shadow') {
            if ($null -ne $oldProfile) {
                $oldTaskIntentFile = Assert-DysonCutoverBrokerPlainFile $taskIntentPath 131072
                $oldTaskIntentBytes = [IO.File]::ReadAllBytes($oldTaskIntentFile)
                $oldTaskIntentRaw = Read-DysonCutoverBrokerJson $taskIntentPath 131072 `
                    -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                if (-not (Test-InstallerShadowTaskDefinition -TaskIntent $oldTaskIntentRaw -Profile $oldProfile)) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                }
                $oldDirectoryAclIntentFile = Assert-DysonCutoverBrokerPlainFile $directoryAclIntentPath 131072
                $oldDirectoryAclIntentBytes = [IO.File]::ReadAllBytes($oldDirectoryAclIntentFile)
                $oldDirectoryAclIntentRaw = Read-DysonCutoverBrokerJson $directoryAclIntentPath 131072 `
                    -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
                if ((ConvertTo-DysonCutoverBrokerJson $oldDirectoryAclIntentRaw) -cne
                    (ConvertTo-DysonCutoverBrokerJson $directoryAclIntent)) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
                }
            }
            elseif (Test-Path -LiteralPath $taskIntentPath) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
            }
            elseif (Test-Path -LiteralPath $directoryAclIntentPath) {
                $oldDirectoryAclIntentFile = Assert-DysonCutoverBrokerPlainFile $directoryAclIntentPath 131072
                $oldDirectoryAclIntentBytes = [IO.File]::ReadAllBytes($oldDirectoryAclIntentFile)
                $oldDirectoryAclIntentRaw = Read-DysonCutoverBrokerJson $directoryAclIntentPath 131072 `
                    -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
                if ((ConvertTo-DysonCutoverBrokerJson $oldDirectoryAclIntentRaw) -cne
                    (ConvertTo-DysonCutoverBrokerJson $directoryAclIntent)) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
                }
            }
        }
        else {
            $matches = @(Get-ScheduledTask -TaskName $script:DysonCutoverBrokerTaskName `
                -TaskPath $script:DysonCutoverBrokerTaskPath -ErrorAction SilentlyContinue)
            if ($null -eq $oldProfile) {
                if ($matches.Count -ne 0) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                }
            }
            else {
                if ($matches.Count -ne 1 -or
                    -not (Test-InstallerTaskDefinition -Task $matches[0] -Profile $oldProfile)) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                }
                if ($isUpgrade -and [string]$matches[0].State -ceq 'Running') {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                }
                $oldTaskXml = [string](Export-ScheduledTask -TaskName $oldProfile.taskName `
                    -TaskPath $oldProfile.taskPath -ErrorAction Stop)
                $oldTaskXmlFingerprint = Get-InstallerTaskXmlFingerprint $oldTaskXml
                $oldTaskSddl = Get-DysonFixedTaskSecurityDescriptor `
                    -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath
                $oldTaskDacl = Get-InstallerNormalizedTaskDacl $oldTaskSddl
                [void](Assert-DysonFixedTaskReadExecuteAclIntent $oldTaskDacl)
            }
        }
        $preimageValidated = $true
        Write-InstallerSelfTestStage 'preimage-validated'

        if ($Operation -cne 'Install') {
            if (-not $isSameRelease -or $null -eq $oldProfile) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
            }
            Assert-InstallerNoPendingBrokerWork $storage
            if ($Operation -ceq 'CompensateFirstInstall') {
                $installReceiptPath = Join-Path $installationRoot ($normalizedCompensateInstallRequestId + '.json')
                $installReceipt = ConvertTo-InstallerValidatedInstallReceipt `
                    (Read-DysonCutoverBrokerJson $installReceiptPath `
                        $script:DysonCutoverBrokerMaximumRequestBytes `
                        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED')
                if ([string]$installReceipt.requestId -cne $normalizedCompensateInstallRequestId -or
                    [string]$installReceipt.operation -cne 'installed' -or
                    [string]$installReceipt.profileFingerprint -cne [string]$oldProfile.profileFingerprint -or
                    [string]$installReceipt.brokerBundleSha256 -cne [string]$oldBundle.sha256 -or
                    [bool]$installReceipt.reused -or [bool]$installReceipt.upgraded) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
                }
            }
            elseif ([string]$ExpectedProfileFingerprint -cne [string]$oldProfile.profileFingerprint -or
                [string]$ExpectedBrokerBundleSha256 -cne [string]$oldBundle.sha256) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
            }
            $compensationReceiptPath = Join-Path $installationRoot ($normalizedRequestId + '.json')
            if (Test-Path -LiteralPath $compensationReceiptPath) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }

            $profileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $storage.profileFile -ErrorAction Stop).Sddl
            $bundleBindingSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $bundleBindingPath -ErrorAction Stop).Sddl
            $compensationTaskRemoved = $false
            $compensationProfileRemoved = $false
            $compensationBundleBindingRemoved = $false
            $compensationReceiptCreated = $false
            try {
                if ($SchedulerBackend -ceq 'Shadow') {
                    Remove-DysonCutoverBrokerPlainFile $taskIntentPath
                }
                else {
                    Unregister-ScheduledTask -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath `
                        -Confirm:$false -ErrorAction Stop
                }
                $compensationTaskRemoved = $true
                Invoke-InstallerSelfTestFailure 'compensate-after-task'

                Remove-DysonCutoverBrokerPlainFile $storage.profileFile
                $compensationProfileRemoved = $true
                Remove-DysonCutoverBrokerPlainFile $bundleBindingPath
                $compensationBundleBindingRemoved = $true
                Invoke-InstallerSelfTestFailure 'compensate-after-profile'

                $compensationReceipt = [pscustomobject][ordered]@{
                    protocol = 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_RECEIPT_V1'
                    schemaVersion = 1
                    requestId = $normalizedRequestId
                    operation = if ($Operation -ceq 'CompensateFirstInstall') {
                        'compensated-first-install'
                    }
                    else { 'removed-current' }
                    installRequestId = if ($Operation -ceq 'CompensateFirstInstall') {
                        $normalizedCompensateInstallRequestId
                    }
                    else { $null }
                    profileFingerprint = $oldProfile.profileFingerprint
                    brokerBundleSha256 = $oldBundle.sha256
                    taskName = $oldProfile.taskName
                    taskPath = $oldProfile.taskPath
                    taskSddlSha256 = Get-DysonCutoverBrokerSha256Text (Get-DysonFixedTaskReadExecuteSddl)
                    status = 'succeeded'
                    removed = $true
                    completedAt = (Get-Date).ToUniversalTime().ToString('o')
                }
                Write-DysonCutoverBrokerJsonNew -Path $compensationReceiptPath -Value $compensationReceipt `
                    -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes
                $compensationReceiptCreated = $true
                Invoke-InstallerSelfTestFailure 'compensate-before-receipt'

                if ((Test-Path -LiteralPath $storage.profileFile) -or
                    (Test-Path -LiteralPath $bundleBindingPath)) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
                }
                if ($SchedulerBackend -ceq 'Shadow') {
                    if (Test-Path -LiteralPath $taskIntentPath) {
                        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
                    }
                }
                else {
                    $remainingTasks = @(Get-ScheduledTask -TaskName $oldProfile.taskName `
                        -TaskPath $oldProfile.taskPath -ErrorAction SilentlyContinue)
                    if ($remainingTasks.Count -ne 0) {
                        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
                    }
                }
                Assert-InstallerNoPendingBrokerWork $storage
                $compensationReceipt | ConvertTo-Json -Depth 8 -Compress
                exit 0
            }
            catch {
                $compensationFailure = $_
                $compensationFailureCode = Get-DysonCutoverBrokerErrorCode $_.Exception
                $compensationRollbackFailures = [Collections.Generic.List[string]]::new()
                if ($compensationReceiptCreated -and
                    (Test-Path -LiteralPath $compensationReceiptPath -PathType Leaf)) {
                    try { Remove-DysonCutoverBrokerPlainFile $compensationReceiptPath }
                    catch { $compensationRollbackFailures.Add('receipt') }
                }
                if ($compensationProfileRemoved) {
                    try {
                        Set-InstallerFileAtomic -Path $storage.profileFile -Bytes $oldProfileBytes `
                            -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
                        Restore-DysonCutoverBrokerFileSecurityPreimage -Path $storage.profileFile -Sddl $profileSddl
                    }
                    catch { $compensationRollbackFailures.Add('profile') }
                }
                if ($compensationBundleBindingRemoved) {
                    try {
                        Set-InstallerFileAtomic -Path $bundleBindingPath -Bytes $oldBundleBindingBytes `
                            -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
                        Restore-DysonCutoverBrokerFileSecurityPreimage -Path $bundleBindingPath -Sddl $bundleBindingSddl
                    }
                    catch { $compensationRollbackFailures.Add('bundle-binding') }
                }
                if ($compensationTaskRemoved) {
                    if ($SchedulerBackend -ceq 'Shadow') {
                        try {
                            Set-InstallerFileAtomic -Path $taskIntentPath -Bytes $oldTaskIntentBytes -MaximumBytes 131072
                        }
                        catch { $compensationRollbackFailures.Add('task') }
                    }
                    else {
                        try {
                            Register-ScheduledTask -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath `
                                -Xml $oldTaskXml -Force -ErrorAction Stop | Out-Null
                            Restore-DysonFixedTaskSecurityDescriptor -TaskName $oldProfile.taskName `
                                -TaskPath $oldProfile.taskPath -Sddl $oldTaskSddl
                        }
                        catch { $compensationRollbackFailures.Add('task') }
                    }
                }
                try {
                    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($storage.profileFile)) -cne
                        [Convert]::ToBase64String($oldProfileBytes)) { throw 'profile bytes' }
                    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($bundleBindingPath)) -cne
                        [Convert]::ToBase64String($oldBundleBindingBytes)) { throw 'binding bytes' }
                    if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $storage.profileFile -ErrorAction Stop).Sddl -cne
                        $profileSddl) { throw 'profile ACL' }
                    if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $bundleBindingPath -ErrorAction Stop).Sddl -cne
                        $bundleBindingSddl) { throw 'binding ACL' }
                    if ($SchedulerBackend -ceq 'Shadow') {
                        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($taskIntentPath)) -cne
                                [Convert]::ToBase64String($oldTaskIntentBytes)) {
                            throw 'restored task preimage mismatch'
                        }
                    }
                    else {
                        $restoredTasks = @(Get-ScheduledTask -TaskName $oldProfile.taskName `
                            -TaskPath $oldProfile.taskPath -ErrorAction Stop)
                        $restoredTaskXml = [string](Export-ScheduledTask -TaskName $oldProfile.taskName `
                            -TaskPath $oldProfile.taskPath -ErrorAction Stop)
                        $restoredTaskDacl = Get-InstallerNormalizedTaskDacl (Get-DysonFixedTaskSecurityDescriptor `
                            -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath)
                        if ($restoredTasks.Count -ne 1 -or
                            (Get-InstallerTaskXmlFingerprint $restoredTaskXml) -cne $oldTaskXmlFingerprint -or
                            $restoredTaskDacl -cne $oldTaskDacl) {
                            throw 'restored task preimage mismatch'
                        }
                    }
                }
                catch {
                    Write-InstallerSelfTestStage ('compensate-rollback-verification-' +
                        $_.Exception.Message.Replace(' ', '-'))
                    $compensationRollbackFailures.Add('verification')
                }
                if ($compensationRollbackFailures.Count -gt 0) {
                    Write-InstallerSelfTestStage ('compensate-rollback-failed-' +
                        [string]::Join('-', @($compensationRollbackFailures)))
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED'
                }
                if (-not [string]::IsNullOrWhiteSpace($compensationFailureCode)) {
                    Throw-DysonCutoverBrokerError $compensationFailureCode
                }
                throw $compensationFailure.Exception
            }
        }

        $receiptPath = Join-Path $installationRoot ($normalizedRequestId + '.json')
        $existingReceipt = Read-DysonCutoverBrokerJson -Path $receiptPath `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
        if ($null -ne $existingReceipt) {
            $existingReceipt = ConvertTo-InstallerValidatedInstallReceipt $existingReceipt
            if (-not $isSameRelease -or
                [string]$existingReceipt.requestId -cne $normalizedRequestId -or
                [string]$existingReceipt.profileFingerprint -cne [string]$profile.profileFingerprint -or
                [string]$existingReceipt.brokerBundleSha256 -cne [string]$candidateBundle.sha256 -or
                [string]$existingReceipt.taskName -cne [string]$profile.taskName -or
                [string]$existingReceipt.taskPath -cne [string]$profile.taskPath) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }
            $existingReceipt.operation = 'reused'
            $existingReceipt.reused = $true
            $existingReceipt.upgraded = $false
            $existingReceipt.previousProfileFingerprint = $null
            $existingReceipt.transactionId = $null
            $existingReceipt | ConvertTo-Json -Depth 8 -Compress
            exit 0
        }

        if ($isUpgrade) {
            $transactionDirectoryPath = Join-Path $installationTransactionsRoot $normalizedRequestId
            if (Test-Path -LiteralPath $transactionDirectoryPath) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }
            $transactionDirectory = Assert-DysonCutoverBrokerPlainDirectory $transactionDirectoryPath -Create
            if ($SchedulerBackend -ceq 'Windows') { Set-InstallerDirectoryAcl $transactionDirectory private }
            Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-profile.json') `
                -Bytes $oldProfileBytes -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
            Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-broker-bundle.json') `
                -Bytes $oldBundleBindingBytes -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
            if ($SchedulerBackend -ceq 'Shadow') {
                Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-task-intent.json') `
                    -Bytes $oldTaskIntentBytes -MaximumBytes 131072
                Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-directory-acl-intent.json') `
                    -Bytes $oldDirectoryAclIntentBytes -MaximumBytes 131072
            }
            else {
                Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-task-xml.txt') `
                    -Bytes (ConvertTo-InstallerUtf8Bytes $oldTaskXml) -MaximumBytes 1048576
                Write-InstallerFileNew -Path (Join-Path $transactionDirectory 'old-task-sddl.txt') `
                    -Bytes (ConvertTo-InstallerUtf8Bytes $oldTaskSddl) -MaximumBytes 131072
            }
            $transactionRecord = [ordered]@{
                protocol = 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_TRANSACTION_V1'
                schemaVersion = 1
                requestId = $normalizedRequestId
                state = 'snapshot-persisted'
                schedulerBackend = $SchedulerBackend
                previousProfileFingerprint = $oldProfile.profileFingerprint
                previousBrokerBundleSha256 = $oldBundle.sha256
                previousBundleBindingSha256 = Get-DysonCutoverBrokerSha256File `
                    (Join-Path $transactionDirectory 'old-broker-bundle.json')
                candidateProfileFingerprint = $profile.profileFingerprint
                candidateBrokerBundleSha256 = $candidateBundle.sha256
                candidateTaskDefinitionSha256 = $candidateTaskDefinitionSha256
                previousTaskDefinitionSha256 = if ($SchedulerBackend -ceq 'Shadow') {
                    Get-DysonCutoverBrokerSha256Text ([Text.UTF8Encoding]::new($false, $true).GetString($oldTaskIntentBytes))
                }
                else { $oldTaskXmlFingerprint }
                previousTaskSddlSha256 = if ($SchedulerBackend -ceq 'Shadow') {
                    Get-DysonCutoverBrokerSha256Text (Get-DysonFixedTaskReadExecuteSddl)
                }
                else { Get-DysonCutoverBrokerSha256Text $oldTaskDacl }
                createdAt = (Get-Date).ToUniversalTime().ToString('o')
            }
            Write-DysonCutoverBrokerJsonNew -Path (Join-Path $transactionDirectory 'transaction.json') `
                -Value ([pscustomobject]$transactionRecord) -MaximumBytes 131072
            $transactionPrepared = $true
            Invoke-InstallerSelfTestFailure 'after-snapshot'
        }

        if ($isUpgrade -and $SchedulerBackend -ceq 'Windows') {
            $taskMutationStarted = $true
            Disable-ScheduledTask -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath `
                -ErrorAction Stop | Out-Null
            $quiesced = @(Get-ScheduledTask -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath -ErrorAction Stop)
            if ($quiesced.Count -ne 1 -or [string]$quiesced[0].State -ceq 'Running') {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
            }
        }
        Invoke-InstallerSelfTestFailure 'after-old-task-disabled'

        if ($null -eq $oldProfile) {
            Write-DysonCutoverBrokerJsonNew -Path $storage.profileFile -Value $profile `
                -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
            $profileMutationStarted = $true
            Write-DysonCutoverBrokerJsonNew -Path $bundleBindingPath -Value $candidateBundleBinding `
                -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
            $bundleBindingMutationStarted = $true
        }
        elseif ($isUpgrade) {
            $profileMutationStarted = $true
            Set-InstallerJsonAtomic -Path $storage.profileFile -Value $profile `
                -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
            $bundleBindingMutationStarted = $true
            Set-InstallerJsonAtomic -Path $bundleBindingPath -Value $candidateBundleBinding `
                -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
        }
        $persistedProfile = Read-DysonCutoverBrokerProfile $storage.brokerRoot $storage.profileFile
        $persistedBundleBinding = ConvertTo-InstallerValidatedBundleBinding `
            (Read-DysonCutoverBrokerJson $bundleBindingPath $script:DysonCutoverBrokerMaximumProfileBytes `
                -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
        if ([string]$persistedProfile.profileFingerprint -cne [string]$profile.profileFingerprint -or
            [string]$persistedBundleBinding.profileFingerprint -cne [string]$profile.profileFingerprint -or
            [string]$persistedBundleBinding.brokerBundleSha256 -cne [string]$candidateBundle.sha256) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
        }
        Invoke-InstallerSelfTestFailure 'after-profile'

        if ($SchedulerBackend -ceq 'Shadow') {
            if (-not $isSameRelease) {
                $taskMutationStarted = $true
                Set-InstallerJsonAtomic -Path $taskIntentPath -Value $candidateTaskIntent -MaximumBytes 131072
                $directoryIntentMutationStarted = $true
                Set-InstallerJsonAtomic -Path $directoryAclIntentPath -Value $directoryAclIntent -MaximumBytes 131072
            }
        }
        elseif (-not $isSameRelease) {
            $taskMutationStarted = $true
            $action = New-ScheduledTaskAction `
                -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
                -Argument (Get-DysonCutoverBrokerTaskArguments $profile)
            $systemPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable `
                -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $profile.taskName -TaskPath $profile.taskPath `
                -Action $action -Principal $systemPrincipal -Settings $settings `
                -Description 'Fixed SYSTEM mutation broker for Dyson Control cutover operations.' `
                -Force -ErrorAction Stop | Out-Null
        }
        Invoke-InstallerSelfTestFailure 'after-task'

        if ($SchedulerBackend -ceq 'Windows' -and -not $isSameRelease) {
            [void](Set-DysonFixedTaskReadExecuteAcl -TaskName $profile.taskName -TaskPath $profile.taskPath)
        }
        Invoke-InstallerSelfTestFailure 'after-task-acl'

        if ($SchedulerBackend -ceq 'Shadow') {
            $installedTaskIntent = Read-DysonCutoverBrokerJson $taskIntentPath 131072 `
                -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
            if (-not (Test-InstallerShadowTaskDefinition -TaskIntent $installedTaskIntent -Profile $profile)) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
            }
        }
        else {
            $installed = @(Get-ScheduledTask -TaskName $profile.taskName -TaskPath $profile.taskPath -ErrorAction Stop)
            if ($installed.Count -ne 1 -or -not (Test-InstallerTaskDefinition -Task $installed[0] -Profile $profile)) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
            }
            $installedDacl = Get-InstallerNormalizedTaskDacl (Get-DysonFixedTaskSecurityDescriptor `
                -TaskName $profile.taskName -TaskPath $profile.taskPath)
            [void](Assert-DysonFixedTaskReadExecuteAclIntent $installedDacl)
        }
        Invoke-InstallerSelfTestFailure 'before-receipt'

        $receipt = [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1'
            schemaVersion = 1
            requestId = $normalizedRequestId
            operation = if ($isSameRelease) { 'reused' } elseif ($isUpgrade) { 'upgraded' } else { 'installed' }
            profileFingerprint = $profile.profileFingerprint
            brokerBundleSha256 = $candidateBundle.sha256
            taskName = $profile.taskName
            taskPath = $profile.taskPath
            taskSddlSha256 = Get-DysonCutoverBrokerSha256Text (Get-DysonFixedTaskReadExecuteSddl)
            status = 'succeeded'
            reused = [bool]$isSameRelease
            upgraded = [bool]$isUpgrade
            previousProfileFingerprint = if ($isUpgrade) { $oldProfile.profileFingerprint } else { $null }
            transactionId = if ($isUpgrade) { $normalizedRequestId } else { $null }
            completedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-DysonCutoverBrokerJsonNew -Path $receiptPath -Value $receipt `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes
        $receiptWasCreated = $true
        if ($transactionPrepared) {
            $transactionRecord['state'] = 'committed'
            $transactionRecord['completedAt'] = (Get-Date).ToUniversalTime().ToString('o')
            Set-InstallerJsonAtomic -Path (Join-Path $transactionDirectory 'transaction.json') `
                -Value ([pscustomobject]$transactionRecord) -MaximumBytes 131072
        }
        $receipt | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    catch {
        $failure = $_
        $failureCode = Get-DysonCutoverBrokerErrorCode $_.Exception
        $rollbackFailures = [Collections.Generic.List[string]]::new()
        if ($receiptWasCreated -and -not [string]::IsNullOrWhiteSpace($receiptPath)) {
            try { Remove-DysonCutoverBrokerPlainFile $receiptPath }
            catch { $rollbackFailures.Add('receipt') }
        }

        if ($profileMutationStarted -and $null -ne $storage) {
            try {
                if ($null -ne $oldProfileBytes) {
                    Set-InstallerFileAtomic -Path $storage.profileFile -Bytes $oldProfileBytes `
                        -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
                }
                elseif (Test-Path -LiteralPath $storage.profileFile -PathType Leaf) {
                    Remove-DysonCutoverBrokerPlainFile $storage.profileFile
                }
            }
            catch { $rollbackFailures.Add('profile') }
        }
        if ($bundleBindingMutationStarted -and -not [string]::IsNullOrWhiteSpace($bundleBindingPath)) {
            try {
                if ($null -ne $oldBundleBindingBytes) {
                    Set-InstallerFileAtomic -Path $bundleBindingPath -Bytes $oldBundleBindingBytes `
                        -MaximumBytes $script:DysonCutoverBrokerMaximumProfileBytes
                }
                elseif (Test-Path -LiteralPath $bundleBindingPath -PathType Leaf) {
                    Remove-DysonCutoverBrokerPlainFile $bundleBindingPath
                }
            }
            catch { $rollbackFailures.Add('bundle-binding') }
        }

        if ($taskMutationStarted) {
            if ($SchedulerBackend -ceq 'Shadow') {
                try {
                    if ($null -ne $oldTaskIntentBytes) {
                        Set-InstallerFileAtomic -Path $taskIntentPath -Bytes $oldTaskIntentBytes -MaximumBytes 131072
                    }
                    elseif (Test-Path -LiteralPath $taskIntentPath -PathType Leaf) {
                        Remove-DysonCutoverBrokerPlainFile $taskIntentPath
                    }
                }
                catch { $rollbackFailures.Add('task-definition') }
            }
            else {
                try {
                    if ($null -ne $oldProfile) {
                        Register-ScheduledTask -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath `
                            -Xml $oldTaskXml -Force -ErrorAction Stop | Out-Null
                        Restore-DysonFixedTaskSecurityDescriptor -TaskName $oldProfile.taskName `
                            -TaskPath $oldProfile.taskPath -Sddl $oldTaskSddl
                    }
                    else {
                        $newTasks = @(Get-ScheduledTask -TaskName $script:DysonCutoverBrokerTaskName `
                            -TaskPath $script:DysonCutoverBrokerTaskPath -ErrorAction SilentlyContinue)
                        if ($newTasks.Count -gt 1) { throw 'ambiguous replacement task' }
                        if ($newTasks.Count -eq 1) {
                            Unregister-ScheduledTask -TaskName $script:DysonCutoverBrokerTaskName `
                                -TaskPath $script:DysonCutoverBrokerTaskPath -Confirm:$false -ErrorAction Stop
                        }
                    }
                }
                catch { $rollbackFailures.Add('task-definition') }
            }
        }
        if ($directoryIntentMutationStarted -and $SchedulerBackend -ceq 'Shadow') {
            try {
                if ($null -ne $oldDirectoryAclIntentBytes) {
                    Set-InstallerFileAtomic -Path $directoryAclIntentPath `
                        -Bytes $oldDirectoryAclIntentBytes -MaximumBytes 131072
                }
                elseif (Test-Path -LiteralPath $directoryAclIntentPath -PathType Leaf) {
                    Remove-DysonCutoverBrokerPlainFile $directoryAclIntentPath
                }
            }
            catch { $rollbackFailures.Add('directory-acl') }
        }

        if ($preimageValidated) {
            try {
                if ($null -ne $oldProfile) {
                $restoredProfile = Read-DysonCutoverBrokerProfile $storage.brokerRoot $storage.profileFile
                $restoredBundle = Get-InstallerBrokerScriptBundle $restoredProfile.brokerScriptRoot
                $restoredBundleBinding = ConvertTo-InstallerValidatedBundleBinding `
                    (Read-DysonCutoverBrokerJson $bundleBindingPath `
                        $script:DysonCutoverBrokerMaximumProfileBytes `
                        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
                if ([string]$restoredProfile.profileFingerprint -cne [string]$oldProfile.profileFingerprint -or
                    [string]$restoredBundle.sha256 -cne [string]$oldBundle.sha256 -or
                    [string]$restoredBundleBinding.profileFingerprint -cne [string]$oldBundleBinding.profileFingerprint -or
                    [string]$restoredBundleBinding.brokerBundleSha256 -cne [string]$oldBundleBinding.brokerBundleSha256 -or
                    [string]$restoredBundleBinding.brokerBundleSha256 -cne [string]$restoredBundle.sha256 -or
                    -not (Test-InstallerProfileMatchesBundle -Profile $restoredProfile -Bundle $restoredBundle)) {
                    throw 'restored broker profile is not usable'
                }
                if ($SchedulerBackend -ceq 'Shadow') {
                    $restoredTaskIntent = Read-DysonCutoverBrokerJson $taskIntentPath 131072 `
                        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
                    if (-not (Test-InstallerShadowTaskDefinition -TaskIntent $restoredTaskIntent -Profile $restoredProfile) -or
                        [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskIntentPath)) -cne
                            [Convert]::ToBase64String($oldTaskIntentBytes)) {
                        throw 'restored shadow task is not usable'
                    }
                }
                else {
                    $restoredTasks = @(Get-ScheduledTask -TaskName $oldProfile.taskName `
                        -TaskPath $oldProfile.taskPath -ErrorAction Stop)
                    $restoredXml = [string](Export-ScheduledTask -TaskName $oldProfile.taskName `
                        -TaskPath $oldProfile.taskPath -ErrorAction Stop)
                    $restoredDacl = Get-InstallerNormalizedTaskDacl (Get-DysonFixedTaskSecurityDescriptor `
                        -TaskName $oldProfile.taskName -TaskPath $oldProfile.taskPath)
                    if ($restoredTasks.Count -ne 1 -or
                        -not (Test-InstallerTaskDefinition -Task $restoredTasks[0] -Profile $restoredProfile) -or
                        (Get-InstallerTaskXmlFingerprint $restoredXml) -cne $oldTaskXmlFingerprint -or
                        $restoredDacl -cne $oldTaskDacl) { throw 'restored task is not usable' }
                    [void](Assert-DysonFixedTaskReadExecuteAclIntent $restoredDacl)
                }
            }
            else {
                    if ($null -ne $storage -and (Test-Path -LiteralPath $storage.profileFile)) {
                        throw 'new profile survived rollback'
                    }
                    if (-not [string]::IsNullOrWhiteSpace($bundleBindingPath) -and
                        (Test-Path -LiteralPath $bundleBindingPath)) {
                        throw 'new bundle binding survived rollback'
                    }
                    if ($SchedulerBackend -ceq 'Shadow') {
                        if (Test-Path -LiteralPath $taskIntentPath) { throw 'new task survived rollback' }
                    }
                    else {
                        $remaining = @(Get-ScheduledTask -TaskName $script:DysonCutoverBrokerTaskName `
                            -TaskPath $script:DysonCutoverBrokerTaskPath -ErrorAction SilentlyContinue)
                        if ($remaining.Count -ne 0) { throw 'new task survived rollback' }
                    }
            }
            }
            catch { $rollbackFailures.Add('verification') }
        }

        if ($transactionPrepared) {
            try {
                $transactionRecord['state'] = if ($rollbackFailures.Count -eq 0) { 'rolled-back' } else { 'rollback-failed' }
                $transactionRecord['rolledBackAt'] = (Get-Date).ToUniversalTime().ToString('o')
                Set-InstallerJsonAtomic -Path (Join-Path $transactionDirectory 'transaction.json') `
                    -Value ([pscustomobject]$transactionRecord) -MaximumBytes 131072
            }
            catch { $rollbackFailures.Add('transaction-record') }
        }
        if ($rollbackFailures.Count -gt 0) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED'
        }
        if (-not [string]::IsNullOrWhiteSpace($failureCode)) {
            Throw-DysonCutoverBrokerError $failureCode
        }
        throw $failure.Exception
    }
}
catch {
    $code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
    if (Get-Command -Name Get-DysonCutoverBrokerErrorCode -ErrorAction SilentlyContinue) {
        $code = Get-DysonCutoverBrokerErrorCode $_.Exception
    }
    Write-DysonCutoverBrokerFailureEnvelope $code
    exit 1
}
