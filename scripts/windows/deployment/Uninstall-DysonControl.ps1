[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [switch]$SkipTaskRemoval,
    [switch]$RemoveData,
    [string]$RemoveDataConfirmation,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck,
    [Parameter(DontShow)][string]$SelfTestShadow,
    [Parameter(DontShow)][string]$SelfTestCutoverBrokerShadowRoot,
    [Parameter(DontShow)][string]$SelfTestConfigurationShadowRoot,
    [Parameter(DontShow)]
    [ValidateSet('ActivePointerDeploymentId', 'InstallRootJunction')]
    [string]$SelfTestBeforeDestructiveMutation
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

$script:DysonRemoveDataConfirmation = 'PERMANENTLY_REMOVE_DYSON_CONTROL_DATA'

function Assert-DysonUninstallPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$MaximumBytes,
        [Parameter(Mandatory)][string]$Message
    )

    try {
        $fullPath = Get-DysonFullPath -Path $Path
        $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
        if (-not [System.IO.File]::Exists($ioPath)) { throw 'invalid file' }
        $attributes = [System.IO.File]::GetAttributes($ioPath)
        $item = [System.IO.FileInfo]::new($ioPath)
        $item.Refresh()
        if (($attributes -band [System.IO.FileAttributes]::Directory) -or
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) { throw 'invalid file' }
        return $fullPath
    }
    catch { throw $Message }
}

function Test-DysonUninstallSamePath {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    return [string]::Equals(
        (Get-DysonFullPath $Left).TrimEnd('\', '/'),
        (Get-DysonFullPath $Right).TrimEnd('\', '/'),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-DysonUninstallVerifiedDeploymentState {
    param(
        [Parameter(Mandatory)][string]$ResolvedInstallRoot,
        [Parameter(Mandatory)][string]$ResolvedDataRoot
    )

    $layout = Assert-DysonDeploymentDestructiveRootLayout `
        -InstallRoot $ResolvedInstallRoot -DataRoot $ResolvedDataRoot
    [void](Assert-DysonDeploymentPlainTree -Path ([string]$layout.installRoot))
    [void](Assert-DysonDeploymentPlainTree -Path ([string]$layout.dataRoot))
    $identity = Get-DysonDeploymentIdentity -InstallRoot ([string]$layout.installRoot) `
        -DataRoot ([string]$layout.dataRoot)
    $active = Get-DysonActiveRelease -InstallRoot ([string]$layout.installRoot) `
        -DataRoot ([string]$layout.dataRoot)
    if ($null -eq $active -or -not [bool]$active.deploymentIdentityVerified -or
        [string]$active.deploymentIdentity.markerSha256 -cne [string]$identity.markerSha256 -or
        [string]$active.deploymentIdentity.marker.deploymentId -cne [string]$identity.marker.deploymentId) {
        throw 'Uninstall requires an active release bound to a verified Dyson Control deployment identity.'
    }
    return [pscustomobject][ordered]@{
        installRoot = [string]$layout.installRoot
        dataRoot = [string]$layout.dataRoot
        installRootIdentity = [string]$layout.installRootIdentity
        dataRootIdentity = [string]$layout.dataRootIdentity
        deploymentId = [string]$identity.marker.deploymentId
        markerSha256 = [string]$identity.markerSha256
        markerPath = [string]$identity.markerPath
        activeVersion = [string]$active.pointer.version
        activePayloadSha256 = [string]$active.pointer.payloadSha256
        activePointerPath = [string]$active.pointerPath
        activePointerSha256 = Get-DysonFileSha256 -Path ([string]$active.pointerPath)
    }
}

function Assert-DysonUninstallDeploymentStateUnchanged {
    param(
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After
    )

    foreach ($property in @(
        'installRootIdentity', 'dataRootIdentity', 'deploymentId', 'markerSha256',
        'activeVersion', 'activePayloadSha256', 'activePointerSha256'
    )) {
        if ([string]$Before.$property -cne [string]$After.$property) {
            throw 'The verified Dyson Control deployment identity changed before a destructive uninstall step.'
        }
    }
}

function Assert-DysonUninstallMovedIdentity {
    param(
        [Parameter(Mandatory)]$VerifiedState,
        [Parameter(Mandatory)][string]$ReleaseBackupPath
    )

    $movedRoot = Assert-DysonDeploymentPlainPathChain -Path $ReleaseBackupPath
    $movedIdentity = Read-DysonDeploymentIdentityMarker `
        -MarkerPath (Join-Path $movedRoot $script:DysonDeploymentIdentityName) `
        -ExpectedInstallRoot ([string]$VerifiedState.installRoot) `
        -ExpectedDataRoot ([string]$VerifiedState.dataRoot)
    if ([string]$movedIdentity.markerSha256 -cne [string]$VerifiedState.markerSha256 -or
        [string]$movedIdentity.marker.deploymentId -cne [string]$VerifiedState.deploymentId) {
        throw 'The recoverable uninstall release backup lost its deployment identity binding.'
    }
    return $movedIdentity
}

function Assert-DysonUninstallDataRemovalReady {
    param(
        [Parameter(Mandatory)]$VerifiedState,
        [Parameter(Mandatory)][string]$ReleaseBackupPath,
        [Parameter(Mandatory)][string]$ActivePointerBackupPath
    )

    if (Test-Path -LiteralPath ([string]$VerifiedState.installRoot)) {
        throw 'DataRoot removal is forbidden while InstallRoot is still present.'
    }
    $layout = Assert-DysonDeploymentDestructiveRootLayout `
        -InstallRoot ([string]$VerifiedState.installRoot) -DataRoot ([string]$VerifiedState.dataRoot)
    if ([string]$layout.installRootIdentity -cne [string]$VerifiedState.installRootIdentity -or
        [string]$layout.dataRootIdentity -cne [string]$VerifiedState.dataRootIdentity) {
        throw 'DataRoot removal no longer targets the verified deployment roots.'
    }
    $dataIdentity = [string]$layout.dataRootIdentity
    $releaseIdentity = Get-DysonDeploymentPathIdentity -Path $ReleaseBackupPath
    $pointerIdentity = Get-DysonDeploymentPathIdentity -Path $ActivePointerBackupPath
    if (-not (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $releaseIdentity `
            -ParentIdentity $dataIdentity) -or
        -not (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $pointerIdentity `
            -ParentIdentity $dataIdentity)) {
        throw 'DataRoot removal recovery evidence escaped the verified DataRoot.'
    }
    [void](Assert-DysonUninstallMovedIdentity -VerifiedState $VerifiedState `
        -ReleaseBackupPath $ReleaseBackupPath)
    $pointerFile = Assert-DysonUninstallPlainFile $ActivePointerBackupPath 32768 `
        'The exact active pointer recovery copy is unavailable or redirected.'
    if ((Get-DysonFileSha256 -Path $pointerFile) -cne [string]$VerifiedState.activePointerSha256) {
        throw 'The active pointer recovery copy changed before DataRoot removal.'
    }
    [void](Assert-DysonDeploymentPlainTree -Path ([string]$layout.dataRoot))
    [void](Assert-DysonUninstallMovedIdentity -VerifiedState $VerifiedState `
        -ReleaseBackupPath $ReleaseBackupPath)
    if ((Get-DysonFileSha256 -Path $pointerFile) -cne [string]$VerifiedState.activePointerSha256) {
        throw 'The active pointer recovery copy changed before DataRoot removal.'
    }
}

function ConvertTo-DysonUninstallExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $doubleSeparator = [string]::Concat($separator, $separator)
    $extendedPrefix = [string]::Concat($doubleSeparator, '?', $separator)
    if ($fullPath.StartsWith($extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath
    }
    if ($fullPath.StartsWith($doubleSeparator, [System.StringComparison]::Ordinal)) {
        return [string]::Concat($extendedPrefix, 'UNC', $separator, $fullPath.Substring(2))
    }
    return $extendedPrefix + $fullPath
}

function Remove-DysonUninstallVerifiedDataRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$VerifiedState,
        [Parameter(Mandatory)][string]$ReleaseBackupPath,
        [Parameter(Mandatory)][string]$ActivePointerBackupPath
    )

    # Keep recursive deletion behind the exact identity/recovery gate. This is
    # repeated here so the last validation is adjacent to the mutation boundary.
    Assert-DysonUninstallDataRemovalReady -VerifiedState $VerifiedState `
        -ReleaseBackupPath $ReleaseBackupPath -ActivePointerBackupPath $ActivePointerBackupPath
    $dataFull = (Get-DysonFullPath -Path ([string]$VerifiedState.dataRoot)).TrimEnd('\', '/')
    $dataItem = Get-Item -LiteralPath $dataFull -Force -ErrorAction Stop
    if (-not $dataItem.PSIsContainer -or
        ($dataItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        -not [string]::Equals(
            $dataItem.FullName.TrimEnd('\', '/'),
            $dataFull,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string](Get-DysonDeploymentPathIdentity -Path $dataItem.FullName) -cne
            [string]$VerifiedState.dataRootIdentity) {
        throw 'The verified DataRoot became unavailable or redirected immediately before removal.'
    }

    $extendedDataRoot = ConvertTo-DysonUninstallExtendedPath -Path $dataItem.FullName
    $rootAttributes = [System.IO.File]::GetAttributes($extendedDataRoot)
    if (-not ($rootAttributes -band [System.IO.FileAttributes]::Directory) -or
        ($rootAttributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The verified DataRoot became unavailable or redirected immediately before removal.'
    }

    # Windows PowerShell 5.1 Remove-Item -Recurse can lose deep descendants even
    # when long paths are enabled. Extended-length .NET paths retain the exact
    # root binding. Every encountered entry is re-checked and reparse points are
    # rejected rather than traversed or unlinked.
    $removeEntry = $null
    $removeEntry = {
        param(
            [Parameter(Mandatory)][string]$ExtendedEntry,
            [switch]$ValidatedRoot
        )

        $attributes = [System.IO.File]::GetAttributes($ExtendedEntry)
        $isDirectory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)
        if ($ValidatedRoot -and -not $isDirectory) {
            throw 'The verified DataRoot changed type during removal.'
        }
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'The verified DataRoot changed to contain a redirected entry during removal.'
        }
        if ($isDirectory) {
            $children = @([System.IO.Directory]::EnumerateFileSystemEntries($ExtendedEntry))
            foreach ($child in $children) { & $removeEntry -ExtendedEntry $child }
            $attributes = [System.IO.File]::GetAttributes($ExtendedEntry)
            if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'The verified DataRoot changed to contain a redirected entry during removal.'
            }
            if ($attributes -band [System.IO.FileAttributes]::ReadOnly) {
                $attributes = [System.IO.FileAttributes](
                    [int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly)
                )
                [System.IO.File]::SetAttributes($ExtendedEntry, $attributes)
            }
            [System.IO.Directory]::Delete($ExtendedEntry, $false)
            return
        }
        if ($attributes -band [System.IO.FileAttributes]::ReadOnly) {
            $attributes = [System.IO.FileAttributes](
                [int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly)
            )
            [System.IO.File]::SetAttributes($ExtendedEntry, $attributes)
        }
        [System.IO.File]::Delete($ExtendedEntry)
    }

    & $removeEntry -ExtendedEntry $extendedDataRoot -ValidatedRoot
    if ([System.IO.Directory]::Exists($extendedDataRoot) -or
        [System.IO.File]::Exists($extendedDataRoot)) {
        throw 'The explicitly verified DataRoot removal did not complete.'
    }
}

function Get-DysonUninstallCutoverBrokerState {
    param(
        [Parameter(Mandatory)][string]$ResolvedInstallRoot,
        [Parameter(Mandatory)][string]$ResolvedDataRoot,
        [string]$ShadowRoot
    )

    $brokerRoot = Join-Path $ResolvedDataRoot 'data\cutover-broker'
    $profilePath = Join-Path $brokerRoot 'broker-profile.json'
    $bindingPath = Join-Path $brokerRoot 'broker-bundle.json'
    if (-not (Test-Path -LiteralPath $profilePath)) {
        if (Test-Path -LiteralPath $bindingPath) {
            throw 'A cutover broker bundle binding exists without its fixed profile.'
        }
        return $null
    }
    $activeRelease = Get-DysonActiveRelease -InstallRoot $ResolvedInstallRoot -DataRoot $ResolvedDataRoot
    if ($null -eq $activeRelease) { throw 'The cutover broker cannot be removed without an active release.' }
    $expectedCutoverRoot = Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows'
    $expectedBrokerScriptRoot = Join-Path $expectedCutoverRoot 'cutover-broker'
    $expectedBrokerRoot = Join-Path $ResolvedDataRoot 'data\cutover-broker'
    $expectedRuntimeBootstrapRoot = Join-Path $ResolvedInstallRoot 'bootstrap'
    $profileFile = Assert-DysonUninstallPlainFile $profilePath 32768 `
        'The cutover broker profile is unavailable, redirected, empty, or too large.'
    $bindingFile = Assert-DysonUninstallPlainFile $bindingPath 32768 `
        'The cutover broker bundle binding is unavailable, redirected, empty, or too large.'
    $cutoverCommon = Assert-DysonUninstallPlainFile `
        (Join-Path $expectedBrokerScriptRoot 'DysonCutoverBroker.Common.ps1') 1048576 `
        'The active cutover broker common helper is unavailable or redirected.'
    $null = . $cutoverCommon
    $profile = Read-DysonCutoverBrokerProfile -BrokerRoot $brokerRoot `
        -BrokerProfileFile $profileFile
    $binding = [System.IO.File]::ReadAllText(
        $bindingFile, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json -ErrorAction Stop
    $storage = Get-DysonCutoverBrokerStorage -BrokerRoot $brokerRoot
    foreach ($pendingRoot in @($storage.requestsRoot, $storage.intentsRoot, $storage.workRoot)) {
        if (@(Get-ChildItem -LiteralPath $pendingRoot -Force -ErrorAction Stop).Count -ne 0) {
            throw 'The cutover broker has pending request, intent, or work state.'
        }
    }
    if ([string]$profile.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$binding.profileFingerprint -cne [string]$profile.profileFingerprint -or
        [string]$binding.brokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$profile.taskName -cne 'Dyson-Control-Cutover-Broker' -or
        [string]$profile.taskPath -cne '\' -or
        -not (Test-DysonUninstallSamePath ([string]$profile.brokerRoot) $expectedBrokerRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.cutoverScriptRoot) $expectedCutoverRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.brokerScriptRoot) $expectedBrokerScriptRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.runtimeBootstrapRoot) $expectedRuntimeBootstrapRoot)) {
        throw 'The cutover broker profile is not fully bound to the active immutable release.'
    }
    $installer = Assert-DysonUninstallPlainFile `
        (Join-Path $expectedBrokerScriptRoot 'Install-DysonCutoverBrokerTask.ps1') 1048576 `
        'The active cutover broker installer is unavailable, redirected, empty, or too large.'
    $authorityFile = Assert-DysonUninstallPlainFile ([string]$profile.authorityProfileFile) 262144 `
        'The cutover broker authority profile is unavailable, redirected, empty, or too large.'
    $authority = [System.IO.File]::ReadAllText(
        $authorityFile, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json -ErrorAction Stop
    if ([string]$authority.inventoryRevision -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The cutover broker authority inventory revision is invalid.'
    }
    $taskIntentPath = $null
    $taskIntentBytes = $null
    $directoryAclIntentPath = $null
    $directoryAclIntentBytes = $null
    $taskXml = $null
    $taskSddl = $null
    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        $taskIntentPath = Assert-DysonUninstallPlainFile (Join-Path $ShadowRoot 'task-intent.json') 131072 `
            'The cutover broker shadow task is unavailable or redirected.'
        $taskIntent = [System.IO.File]::ReadAllText(
            $taskIntentPath, [System.Text.UTF8Encoding]::new($false, $true)
        ) | ConvertFrom-Json -ErrorAction Stop
        if ([string]$taskIntent.taskName -cne 'Dyson-Control-Cutover-Broker' -or
            [string]$taskIntent.taskPath -cne '\' -or -not [bool]$taskIntent.enabled) {
            throw 'The cutover broker shadow task is not the enabled fixed task.'
        }
        $taskIntentBytes = [System.IO.File]::ReadAllBytes($taskIntentPath)
        $directoryAclIntentPath = Assert-DysonUninstallPlainFile `
            (Join-Path $ShadowRoot 'directory-acl-intent.json') 131072 `
            'The cutover broker shadow ACL intent is unavailable or redirected.'
        $directoryAclIntentBytes = [System.IO.File]::ReadAllBytes($directoryAclIntentPath)
    }
    else {
        $tasks = @(Get-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -ErrorAction Stop)
        if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskPath -cne '\' -or
            $tasks[0].Settings.Enabled -ne $true) {
            throw 'The cutover broker task is not the enabled fixed root task.'
        }
        $taskXml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -ErrorAction Stop)
        $taskAclScript = Assert-DysonUninstallPlainFile `
            (Join-Path $expectedBrokerScriptRoot 'DysonCutoverBroker.TaskAcl.ps1') 262144 `
            'The active cutover broker task ACL helper is unavailable or redirected.'
        $null = . $taskAclScript
        $taskSddl = Get-DysonFixedTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Cutover-Broker' -TaskPath '\'
    }
    $brokerDirectoryAcls = @(
        foreach ($directoryPath in @(
            $brokerRoot,
            (Join-Path $brokerRoot 'requests'),
            (Join-Path $brokerRoot 'receipts'),
            (Join-Path $brokerRoot 'intents'),
            (Join-Path $brokerRoot 'work'),
            (Join-Path $brokerRoot 'installation-receipts'),
            (Join-Path $brokerRoot 'installation-transactions')
        )) {
            if (Test-Path -LiteralPath $directoryPath -PathType Container) {
                $plainDirectory = Assert-DysonPlainDirectory -Path $directoryPath
                [pscustomobject][ordered]@{
                    path = $plainDirectory
                    sddl = (Microsoft.PowerShell.Security\Get-Acl `
                        -LiteralPath $plainDirectory -ErrorAction Stop).Sddl
                }
            }
        }
    )
    $durableFiles = @(
        foreach ($file in @(Get-ChildItem -LiteralPath $brokerRoot -File -Recurse -Force -ErrorAction Stop |
                Where-Object {
                    -not (Test-DysonUninstallSamePath $_.FullName $profileFile) -and
                    -not (Test-DysonUninstallSamePath $_.FullName $bindingFile)
                })) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $file.Length -gt 16777216) {
                throw 'Cutover broker durable history contains a redirected or oversized file.'
            }
            [pscustomobject][ordered]@{
                path = $file.FullName
                bytes = [IO.File]::ReadAllBytes($file.FullName)
                sddl = (Microsoft.PowerShell.Security\Get-Acl `
                    -LiteralPath $file.FullName -ErrorAction Stop).Sddl
            }
        }
    )
    $arguments = @{
        RequestId = [guid]::NewGuid().ToString('D')
        BrokerRoot = $expectedBrokerRoot
        BrokerScriptRoot = $expectedBrokerScriptRoot
        ProjectRoot = [string]$profile.projectRoot
        DataRoot = [string]$profile.dataRoot
        AuthorityProfileFile = $authorityFile
        AuthorityInventoryRevision = [string]$authority.inventoryRevision
        CutoverScriptRoot = $expectedCutoverRoot
        RuntimeBootstrapRoot = $expectedRuntimeBootstrapRoot
        RuntimeTaskTransactionRoot = [string]$profile.runtimeTaskTransactionRoot
        ServiceUser = [string]$profile.serviceUser
        GamePort = [int]$profile.gamePort
        TaskName = 'Dyson-Control-Cutover-Broker'
        Confirm = $false
    }
    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        $arguments['SchedulerBackend'] = 'Shadow'
        $arguments['ShadowRoot'] = $ShadowRoot
    }
    return [pscustomobject][ordered]@{
        activeVersion = [string]$activeRelease.pointer.version
        profile = $profile
        binding = $binding
        profilePath = $profileFile
        profileBytes = [System.IO.File]::ReadAllBytes($profileFile)
        profileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $profileFile).Sddl
        bindingPath = $bindingFile
        bindingBytes = [System.IO.File]::ReadAllBytes($bindingFile)
        bindingSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $bindingFile).Sddl
        taskIntentPath = $taskIntentPath
        taskIntentBytes = $taskIntentBytes
        directoryAclIntentPath = $directoryAclIntentPath
        directoryAclIntentBytes = $directoryAclIntentBytes
        directoryAcls = $brokerDirectoryAcls
        durableFiles = $durableFiles
        taskXml = $taskXml
        taskSddl = $taskSddl
        installer = $installer
        installArguments = $arguments
    }
}

function Assert-DysonUninstallCutoverDurableStatePreserved {
    param([Parameter(Mandatory)]$State)

    foreach ($directoryAcl in @($State.directoryAcls)) {
        if (-not (Test-Path -LiteralPath ([string]$directoryAcl.path) -PathType Container) -or
            (Microsoft.PowerShell.Security\Get-Acl `
                -LiteralPath ([string]$directoryAcl.path) -ErrorAction Stop).Sddl -cne
                    [string]$directoryAcl.sddl) {
            throw 'A cutover broker durable history directory or ACL changed.'
        }
    }
    foreach ($file in @($State.durableFiles)) {
        if (-not (Test-Path -LiteralPath ([string]$file.path) -PathType Leaf) -or
            -not (Test-DysonUninstallBytesEqual `
                -Left ([IO.File]::ReadAllBytes([string]$file.path)) -Right ([byte[]]$file.bytes)) -or
            (Microsoft.PowerShell.Security\Get-Acl `
                -LiteralPath ([string]$file.path) -ErrorAction Stop).Sddl -cne [string]$file.sddl) {
            throw 'A cutover broker receipt, transaction, intent, request, work, or audit file changed during uninstall.'
        }
    }
}

function Assert-DysonUninstallBrokerPreflightStateUnchanged {
    param(
        $Before,
        $After,
        [Parameter(Mandatory)][ValidateSet('lifecycle', 'cutover')][string]$Kind
    )

    if (($null -eq $Before) -ne ($null -eq $After)) {
        throw "The $Kind broker state changed before the uninstall lock was acquired."
    }
    if ($null -eq $Before) { return }
    $same = if ($Kind -ceq 'lifecycle') {
        [string]$Before.activeVersion -ceq [string]$After.activeVersion -and
        [string]$Before.profileHash -ceq [string]$After.profileHash -and
        [string]$Before.profileFileSddl -ceq [string]$After.profileFileSddl
    }
    else {
        [string]$Before.activeVersion -ceq [string]$After.activeVersion -and
        [string]$Before.profile.profileFingerprint -ceq [string]$After.profile.profileFingerprint -and
        [string]$Before.binding.brokerBundleSha256 -ceq [string]$After.binding.brokerBundleSha256
    }
    if (-not $same) {
        throw "The $Kind broker state changed before the uninstall lock was acquired."
    }
}

function Invoke-DysonUninstallCutoverBrokerInstaller {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][hashtable]$Arguments, [string]$ShadowRoot)

    $previousMarker = [System.Environment]::GetEnvironmentVariable(
        'DYSON_CUTOVER_BROKER_SELFTEST', [System.EnvironmentVariableTarget]::Process
    )
    try {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST', '1', [System.EnvironmentVariableTarget]::Process
            )
        }
        $output = & ([string]$State.installer) @Arguments
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST', $previousMarker,
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
    $lines = @(($output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'The cutover broker installer returned no receipt.' }
    $receipt = $lines[$lines.Count - 1] | ConvertFrom-Json -ErrorAction Stop
    if ($receipt.PSObject.Properties.Name -contains 'ok' -and $receipt.ok -eq $false) {
        throw ('Cutover broker removal failed: ' + [string]$receipt.error.code)
    }
    return $receipt
}

function Assert-DysonUninstallBrokerRestored {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)

    if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.profilePath)) -cne
            [Convert]::ToBase64String([byte[]]$State.profileBytes) -or
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.profilePath)).Sddl -cne
            [string]$State.profileSddl) {
        throw 'The cutover broker profile bytes or ACL were not restored.'
    }
    $binding = [System.IO.File]::ReadAllText(
        [string]$State.bindingPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    if ([string]$binding.profileFingerprint -cne [string]$State.profile.profileFingerprint -or
        [string]$binding.brokerBundleSha256 -cne [string]$State.binding.brokerBundleSha256 -or
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.bindingPath)) -cne
            [Convert]::ToBase64String([byte[]]$State.bindingBytes) -or
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.bindingPath)).Sddl -cne
            [string]$State.bindingSddl) {
        throw 'The cutover broker binding was not restored.'
    }
    Assert-DysonUninstallCutoverDurableStatePreserved -State $State
    foreach ($directoryAcl in @($State.directoryAcls)) {
        $directoryPath = Assert-DysonPlainDirectory -Path ([string]$directoryAcl.path)
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directoryPath -ErrorAction Stop).Sddl -cne
            [string]$directoryAcl.sddl) {
            throw 'A cutover broker storage directory ACL was not restored.'
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.taskIntentPath)) -cne
                [Convert]::ToBase64String([byte[]]$State.taskIntentBytes) -or
            [Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.directoryAclIntentPath)) -cne
                [Convert]::ToBase64String([byte[]]$State.directoryAclIntentBytes)) {
            throw 'The cutover broker shadow task/enabled/ACL state was not restored.'
        }
    }
    else {
        $tasks = @(Get-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -ErrorAction Stop)
        $taskXml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -ErrorAction Stop)
        $taskSddl = Get-DysonFixedTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Cutover-Broker' -TaskPath '\'
        if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskPath -cne '\' -or
            $tasks[0].Settings.Enabled -ne $true -or
            $taskXml -cne [string]$State.taskXml -or $taskSddl -cne [string]$State.taskSddl) {
            throw 'The cutover broker task definition/enabled/DACL state was not restored.'
        }
    }
}

function Set-DysonUninstallBrokerFileBytesAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Bytes)

    $destination = Assert-DysonUninstallPlainFile $Path 32768 `
        'A restored cutover broker state file is unavailable or redirected.'
    $temporary = $destination + '.rollback-' + [guid]::NewGuid().ToString('N')
    $backup = $destination + '.superseded-' + [guid]::NewGuid().ToString('N')
    try {
        [System.IO.File]::WriteAllBytes($temporary, $Bytes)
        [System.IO.File]::Replace($temporary, $destination, $backup)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Restore-DysonUninstallBrokerPreimageAclsAndTask {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)

    foreach ($directoryAcl in @($State.directoryAcls)) {
        $path = Assert-DysonPlainDirectory -Path ([string]$directoryAcl.path)
        Restore-DysonDeploymentDirectorySecurityPreimage -Path $path -Sddl ([string]$directoryAcl.sddl)
    }
    foreach ($binding in @(
        @([string]$State.profilePath, [byte[]]$State.profileBytes, [string]$State.profileSddl),
        @([string]$State.bindingPath, [byte[]]$State.bindingBytes, [string]$State.bindingSddl)
    )) {
        Set-DysonUninstallBrokerFileBytesAtomic `
            -Path ([string]$binding[0]) -Bytes ([byte[]]$binding[1])
        $path = Assert-DysonUninstallPlainFile ([string]$binding[0]) 32768 `
            'A restored cutover broker state file is unavailable or redirected.'
        Restore-DysonDeploymentFileSecurityPreimage -Path $path -Sddl ([string]$binding[2])
    }
    if ([string]::IsNullOrWhiteSpace($ShadowRoot)) {
        Register-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' -TaskPath '\' `
            -Xml ([string]$State.taskXml) -Force -ErrorAction Stop | Out-Null
        Restore-DysonFixedTaskSecurityDescriptor -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -Sddl ([string]$State.taskSddl)
    }
}

function Test-DysonUninstallBytesEqual {
    param([Parameter(Mandatory)][byte[]]$Left, [Parameter(Mandatory)][byte[]]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

function Assert-DysonUninstallExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Message
    )
    if ($null -eq $Value) { throw $Message }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw $Message }
    for ($index = 0; $index -lt $expected.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$expected[$index]) { throw $Message }
    }
}

function ConvertFrom-DysonUninstallLifecycleBrokerOutput {
    param([Parameter(Mandatory)]$Output)
    $lines = @(
        ($Output | Out-String) -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($lines.Count -ne 1) { throw 'The lifecycle broker installer did not return exactly one receipt.' }
    return $lines[0] | ConvertFrom-Json -ErrorAction Stop
}

function Invoke-DysonUninstallLifecycleBrokerInstaller {
    param(
        [Parameter(Mandatory)][string]$Installer,
        [Parameter(Mandatory)][hashtable]$Arguments,
        [string]$ShadowRoot
    )
    $previousMarker = [Environment]::GetEnvironmentVariable(
        'DYSON_LIFECYCLE_BROKER_SELFTEST', [EnvironmentVariableTarget]::Process
    )
    try {
        if ($ShadowRoot) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', '1', [EnvironmentVariableTarget]::Process
            )
        }
        $output = & $Installer @Arguments
    }
    finally {
        if ($ShadowRoot) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', $previousMarker, [EnvironmentVariableTarget]::Process
            )
        }
    }
    $receipt = ConvertFrom-DysonUninstallLifecycleBrokerOutput $output
    if ($receipt.PSObject.Properties.Name -contains 'ok' -and $receipt.ok -eq $false) {
        $code = [string]$receipt.error.code
        if ($code -notmatch '^DYSON_CONTROL_LIFECYCLE_BROKER_[A-Z0-9_]+$') {
            $code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
        }
        throw "Lifecycle broker operation failed: $code."
    }
    return $receipt
}

function Get-DysonUninstallLifecycleBrokerState {
    param(
        [Parameter(Mandatory)][string]$ResolvedInstallRoot,
        [Parameter(Mandatory)][string]$ResolvedDataRoot,
        [string]$ShadowRoot
    )

    $dataRoot = Join-Path $ResolvedDataRoot 'data'
    $brokerRoot = Join-Path $dataRoot 'lifecycle-broker'
    $profilePath = Join-Path $brokerRoot 'broker-profile.json'
    $shadowTaskPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-task.json' } else { $null }
    $shadowProfileAclPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-profile.sddl' } else { $null }
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
        $taskResidual = if ($ShadowRoot) {
            (Test-Path -LiteralPath $shadowTaskPath) -or (Test-Path -LiteralPath $shadowProfileAclPath)
        }
        else {
            try { @(Get-DysonLifecycleBrokerStaticWorkerTasks).Count -ne 0 }
            catch { throw 'The Task Scheduler state could not be queried.' }
        }
        if ((Test-Path -LiteralPath $profilePath) -or $taskResidual) {
            throw 'A lifecycle broker task or ACL exists without its fixed profile.'
        }
        return $null
    }
    $activeRelease = Get-DysonActiveRelease -InstallRoot $ResolvedInstallRoot -DataRoot $ResolvedDataRoot
    if ($null -eq $activeRelease) { throw 'The lifecycle broker cannot be removed without an active release.' }
    $profileFile = Assert-DysonUninstallPlainFile $profilePath 262144 `
        'The lifecycle broker profile is unavailable, redirected, empty, or too large.'
    $windowsRoot = Assert-DysonPlainDirectory (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows')
    $brokerScriptRoot = Assert-DysonPlainDirectory (Join-Path $windowsRoot 'lifecycle-broker')
    $common = Assert-DysonUninstallPlainFile (Join-Path $brokerScriptRoot 'DysonLifecycleBroker.Common.ps1') `
        1048576 'The active lifecycle broker helper is unavailable or redirected.'
    $taskAclHelper = Assert-DysonUninstallPlainFile `
        (Join-Path $brokerScriptRoot 'DysonLifecycleBroker.TaskAcl.ps1') 262144 `
        'The active lifecycle broker task ACL helper is unavailable or redirected.'
    $installer = Assert-DysonUninstallPlainFile `
        (Join-Path $brokerScriptRoot 'Install-DysonLifecycleBrokerTask.ps1') 1048576 `
        'The active lifecycle broker installer is unavailable or redirected.'
    $null = . $common
    $null = . $taskAclHelper
    $profile = Read-DysonLifecycleBrokerProfile -ProfileFile $profileFile
    $expectedBootstrap = Join-Path $ResolvedInstallRoot 'bootstrap'
    $environmentFile = Assert-DysonUninstallPlainFile `
        (Join-Path $ResolvedDataRoot 'config\dyson-control.env') 65536 `
        'The lifecycle-enabled deployment environment is unavailable or redirected.'
    $configured = Read-DysonDeploymentStatusEnvironmentFile -Path $environmentFile
    foreach ($required in @(
        'DYSON_PROVIDER', 'DYSON_LIFECYCLE_ENABLED', 'DYSON_PROJECT_ROOT', 'DYSON_DATA_DIR',
        'DYSON_LIFECYCLE_BROKER_PROFILE_FILE', 'DYSON_RUNTIME_BOOTSTRAP_ROOT',
        'DYSON_RUNTIME_SERVICE_USER', 'DYSON_GAME_PORT', 'DYSON_SERVER_TASK', 'DYSON_STOP_TASK'
    )) {
        if (-not $configured.ContainsKey($required) -or
            [string]::IsNullOrWhiteSpace([string]$configured[$required])) {
            throw 'The lifecycle-enabled deployment environment is incomplete.'
        }
    }
    if (-not (Test-DysonUninstallSamePath ([string]$profile.brokerRoot) $brokerRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.brokerScriptRoot) $brokerScriptRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.installedWindowsRoot) $windowsRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.runtimeBootstrapRoot) $expectedBootstrap) -or
        -not (Test-DysonUninstallSamePath ([string]$profile.dataRoot) $dataRoot) -or
        [string]$profile.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
        [string]$profile.workerTaskPath -cne '\DysonControl\' -or
        [string]$profile.serverTask.name -cne 'Dyson-Nebula-Server' -or
        [string]$profile.serverTask.path -cne '\' -or
        [string]$profile.stopTask.name -cne 'Dyson-Nebula-Stop' -or
        [string]$profile.stopTask.path -cne '\' -or
        [string]$configured['DYSON_PROVIDER'] -cne 'windows' -or
        [string]$configured['DYSON_LIFECYCLE_ENABLED'] -cne 'true' -or
        -not (Test-DysonUninstallSamePath ([string]$configured['DYSON_PROJECT_ROOT']) `
            ([string]$profile.projectRoot)) -or
        -not (Test-DysonUninstallSamePath ([string]$configured['DYSON_DATA_DIR']) $dataRoot) -or
        -not (Test-DysonUninstallSamePath ([string]$configured['DYSON_LIFECYCLE_BROKER_PROFILE_FILE']) `
            $profileFile) -or
        -not (Test-DysonUninstallSamePath ([string]$configured['DYSON_RUNTIME_BOOTSTRAP_ROOT']) `
            $expectedBootstrap) -or
        [string]$configured['DYSON_RUNTIME_SERVICE_USER'] -cne [string]$profile.serviceUser -or
        [string]$configured['DYSON_GAME_PORT'] -cnotmatch '^[1-9][0-9]{0,4}$' -or
        [int]$configured['DYSON_GAME_PORT'] -ne [int]$profile.gamePort -or
        [string]$configured['DYSON_SERVER_TASK'] -cne 'Dyson-Nebula-Server' -or
        [string]$configured['DYSON_STOP_TASK'] -cne 'Dyson-Nebula-Stop') {
        throw 'The lifecycle broker profile is not fully bound to the active immutable release and fixed runtime tasks.'
    }
    [void](Assert-DysonLifecycleBrokerDependencies -Profile $profile)
    $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $brokerRoot
    [void](Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage)
    $previousMarker = [Environment]::GetEnvironmentVariable(
        'DYSON_LIFECYCLE_BROKER_SELFTEST', [EnvironmentVariableTarget]::Process
    )
    try {
        if ($ShadowRoot) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', '1', [EnvironmentVariableTarget]::Process
            )
        }
        [void](Assert-DysonLifecycleBrokerTaskPair -Profile $profile `
            -Backend $(if ($ShadowRoot) { 'Shadow' } else { 'Windows' }) -ShadowRoot $ShadowRoot `
            -AllowPreparedDisabled)
    }
    finally {
        if ($ShadowRoot) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', $previousMarker, [EnvironmentVariableTarget]::Process
            )
        }
    }

    $taskXml = $null
    $taskEnabled = $null
    $taskSddl = $null
    $taskBytes = $null
    $profileAclBytes = $null
    $profileSddl = $null
    if ($ShadowRoot) {
        $taskFile = Assert-DysonUninstallPlainFile $shadowTaskPath 262144 `
            'The lifecycle broker shadow task preimage is unavailable or redirected.'
        $taskRecord = [IO.File]::ReadAllText($taskFile, [Text.UTF8Encoding]::new($false, $true)) |
            ConvertFrom-Json -ErrorAction Stop
        Assert-DysonUninstallExactProperties $taskRecord `
            @('protocol', 'schemaVersion', 'descriptor', 'xml', 'enabled', 'sddl') `
            'The lifecycle broker shadow task preimage has an unsupported shape.'
        if ([string]$taskRecord.protocol -cne 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_TASK_V1' -or
            [int]$taskRecord.schemaVersion -ne 1 -or $taskRecord.enabled -isnot [bool] -or
            -not [bool]$taskRecord.enabled) {
            throw 'The lifecycle broker shadow task is not the enabled fixed task.'
        }
        [void](Assert-DysonLifecycleBrokerTaskAclIntent ([string]$taskRecord.sddl))
        $taskXml = [string]$taskRecord.xml
        $taskEnabled = [bool]$taskRecord.enabled
        $taskSddl = [string]$taskRecord.sddl
        $taskBytes = [IO.File]::ReadAllBytes($taskFile)
        $profileAclFile = Assert-DysonUninstallPlainFile $shadowProfileAclPath 8192 `
            'The lifecycle broker shadow profile ACL is unavailable or redirected.'
        $profileAclBytes = [IO.File]::ReadAllBytes($profileAclFile)
        $profileSddl = [IO.File]::ReadAllText($profileAclFile, [Text.UTF8Encoding]::new($false, $true)).Trim()
    }
    else {
        $tasks = @(Get-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' `
            -TaskPath '\DysonControl\' -ErrorAction Stop)
        if ($tasks.Count -ne 1 -or -not [bool]$tasks[0].Settings.Enabled) {
            throw 'The fixed lifecycle broker task is missing, disabled, or ambiguous.'
        }
        [void](Assert-DysonLifecycleBrokerStaticWorkerTask -Task $tasks[0] -Profile $profile `
            -ProfileFile $profileFile)
        $taskXml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' `
            -TaskPath '\DysonControl\' -ErrorAction Stop)
        $taskEnabled = [bool]$tasks[0].Settings.Enabled
        $taskSddl = Get-DysonLifecycleBrokerTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\'
        $profileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $profileFile -ErrorAction Stop).Sddl
    }
    $directoryAcls = @(
        foreach ($path in @($storage.root, $storage.requests, $storage.intents, $storage.receipts)) {
            $plain = Assert-DysonPlainDirectory $path
            [pscustomobject][ordered]@{
                path = $plain
                sddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $plain -ErrorAction Stop).Sddl
            }
        }
    )
    $durableFiles = @(
        foreach ($file in @(Get-ChildItem -LiteralPath $storage.root -File -Recurse -Force -ErrorAction Stop |
                Where-Object { -not (Test-DysonUninstallSamePath $_.FullName $profileFile) })) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Lifecycle broker durable history contains a redirected file.'
            }
            [pscustomobject][ordered]@{
                path = $file.FullName
                sha256 = Get-DysonFileSha256 -Path $file.FullName
            }
        }
    )
    return [pscustomobject][ordered]@{
        activeVersion = [string]$activeRelease.pointer.version
        profile = $profile
        profilePath = $profileFile
        profileHash = Get-DysonLifecycleBrokerProfileHash -ProfileFile $profileFile
        profileBytes = [IO.File]::ReadAllBytes($profileFile)
        profileSddl = $profileSddl
        profileFileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $profileFile -ErrorAction Stop).Sddl
        profileAclPath = $shadowProfileAclPath
        profileAclBytes = $profileAclBytes
        taskPath = $shadowTaskPath
        taskBytes = $taskBytes
        taskXml = $taskXml
        taskEnabled = $taskEnabled
        taskSddl = $taskSddl
        directoryAcls = $directoryAcls
        durableFiles = $durableFiles
        installer = $installer
        taskAclHelper = $taskAclHelper
        installArguments = @{
            BrokerRoot = $brokerRoot
            ProjectRoot = [string]$profile.projectRoot
            DataRoot = $dataRoot
            InstalledWindowsRoot = $windowsRoot
            RuntimeBootstrapRoot = [string]$profile.runtimeBootstrapRoot
            ServiceUser = [string]$profile.serviceUser
            GamePort = [int]$profile.gamePort
            DispatchReadyTimeoutSeconds = [int]$profile.dispatchReadyTimeoutSeconds
            Backend = if ($ShadowRoot) { 'Shadow' } else { 'Windows' }
            ShadowRoot = $ShadowRoot
            Confirm = $false
        }
    }
}

function Assert-DysonUninstallLifecycleDurableStatePreserved {
    param([Parameter(Mandatory)]$State)
    foreach ($directoryAcl in @($State.directoryAcls)) {
        if (-not (Test-Path -LiteralPath ([string]$directoryAcl.path) -PathType Container) -or
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$directoryAcl.path) -ErrorAction Stop).Sddl -cne
                [string]$directoryAcl.sddl) {
            throw 'A lifecycle broker durable history directory or ACL changed.'
        }
    }
    foreach ($file in @($State.durableFiles)) {
        if (-not (Test-Path -LiteralPath ([string]$file.path) -PathType Leaf) -or
            (Get-DysonFileSha256 -Path ([string]$file.path)) -cne
                [string]$file.sha256) {
            throw 'A lifecycle broker request, receipt, intent, or audit file changed during uninstall.'
        }
    }
}

function Set-DysonUninstallLifecycleFileBytesAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [int64]$MaximumBytes = 262144
    )
    $destination = Assert-DysonUninstallPlainFile $Path $MaximumBytes `
        'A restored lifecycle broker state file is unavailable or redirected.'
    $temporary = $destination + '.rollback-' + [guid]::NewGuid().ToString('N')
    $backup = $destination + '.superseded-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        [IO.File]::Replace($temporary, $destination, $backup)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Restore-DysonUninstallLifecyclePreimageAclsAndTask {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)
    foreach ($directoryAcl in @($State.directoryAcls)) {
        Restore-DysonDeploymentDirectorySecurityPreimage -Path ([string]$directoryAcl.path) `
            -Sddl ([string]$directoryAcl.sddl)
    }
    Set-DysonUninstallLifecycleFileBytesAtomic -Path ([string]$State.profilePath) `
        -Bytes ([byte[]]$State.profileBytes)
    Restore-DysonDeploymentFileSecurityPreimage -Path ([string]$State.profilePath) `
        -Sddl ([string]$State.profileFileSddl)
    if ($ShadowRoot) {
        Set-DysonUninstallLifecycleFileBytesAtomic -Path ([string]$State.profileAclPath) `
            -Bytes ([byte[]]$State.profileAclBytes) -MaximumBytes 8192
        Set-DysonUninstallLifecycleFileBytesAtomic -Path ([string]$State.taskPath) `
            -Bytes ([byte[]]$State.taskBytes)
    }
    else {
        Register-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\' `
            -Xml ([string]$State.taskXml) -Force -ErrorAction Stop | Out-Null
        $null = . ([string]$State.taskAclHelper)
        Restore-DysonLifecycleBrokerTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\' -Sddl ([string]$State.taskSddl)
    }
}

function Assert-DysonUninstallLifecycleRestored {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)
    if (-not (Test-DysonUninstallBytesEqual `
            ([IO.File]::ReadAllBytes([string]$State.profilePath)) ([byte[]]$State.profileBytes))) {
        throw 'The lifecycle broker profile bytes were not restored.'
    }
    if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.profilePath) -ErrorAction Stop).Sddl -cne
        [string]$State.profileFileSddl) {
        throw 'The lifecycle broker profile file ACL was not restored.'
    }
    Assert-DysonUninstallLifecycleDurableStatePreserved -State $State
    foreach ($directoryAcl in @($State.directoryAcls)) {
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$directoryAcl.path) -ErrorAction Stop).Sddl -cne
            [string]$directoryAcl.sddl) {
            throw 'A lifecycle broker storage ACL was not restored.'
        }
    }
    if ($ShadowRoot) {
        if (-not (Test-DysonUninstallBytesEqual `
                ([IO.File]::ReadAllBytes([string]$State.profileAclPath)) ([byte[]]$State.profileAclBytes)) -or
            -not (Test-DysonUninstallBytesEqual `
                ([IO.File]::ReadAllBytes([string]$State.taskPath)) ([byte[]]$State.taskBytes))) {
            throw 'The lifecycle broker shadow profile ACL or task XML/enabled/DACL was not restored.'
        }
    }
    else {
        $null = . ([string]$State.taskAclHelper)
        $tasks = @(Get-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' `
            -TaskPath '\DysonControl\' -ErrorAction Stop)
        $xml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' `
            -TaskPath '\DysonControl\' -ErrorAction Stop)
        $taskSddl = Get-DysonLifecycleBrokerTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\'
        if ($tasks.Count -ne 1 -or [bool]$tasks[0].Settings.Enabled -ne [bool]$State.taskEnabled -or
            $xml -cne [string]$State.taskXml -or $taskSddl -cne [string]$State.taskSddl -or
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.profilePath)).Sddl -cne
                [string]$State.profileSddl) {
            throw 'The lifecycle broker profile ACL or task XML/enabled/DACL was not restored.'
        }
    }
}

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
if ($RemoveData) {
    if ([string]$RemoveDataConfirmation -cne $script:DysonRemoveDataConfirmation) {
        throw 'RemoveData requires the exact independent confirmation phrase.'
    }
}
elseif (-not [string]::IsNullOrWhiteSpace($RemoveDataConfirmation)) {
    throw 'RemoveDataConfirmation is valid only together with RemoveData.'
}
if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}
elseif (-not [string]::IsNullOrWhiteSpace($SelfTestBeforeDestructiveMutation)) {
    throw 'The pre-destructive mutation fixture is reserved for the isolated deployment self-test.'
}
$nodeProtection = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
    -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -InstallRoot $installFull -DataRoot $dataFull
$deploymentPreflightState = Get-DysonUninstallVerifiedDeploymentState `
    -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull
$configurationModuleRoot = Get-DysonDeploymentConfigurationVerificationModuleRoot `
    -InstallRoot $installFull -DataRoot $dataFull `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot
$configurationEvidence = Invoke-DysonDeploymentConfigurationTest `
    -DataRoot $dataFull `
    -ScriptRoot (Join-Path (Join-Path (Join-Path $installFull 'releases') `
        ([string]$deploymentPreflightState.activeVersion)) 'scripts\windows') `
    -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
    -DeploymentVersion ([string]$deploymentPreflightState.activeVersion) `
    -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
$qualifiedClientEnvironment = Read-DysonDeploymentStatusEnvironmentFile `
    -Path (Join-Path $dataFull 'config\dyson-control.env')
try {
    $qualifiedClientStoragePlan = Get-DysonQualifiedClientStoragePlan `
        -Configured $qualifiedClientEnvironment -DataRoot $dataFull
}
finally { $qualifiedClientEnvironment.Clear() }
$qualifiedClientStorageEvidence = Test-DysonQualifiedClientStorage `
    -Plan $qualifiedClientStoragePlan -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
    -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
$lifecycleBrokerProfileCandidate = Join-Path $dataFull 'data\lifecycle-broker\broker-profile.json'
$lifecycleBrokerDurableRootCandidate = Join-Path $dataFull 'data\lifecycle-broker'
$cutoverBrokerProfileCandidate = Join-Path $dataFull 'data\cutover-broker\broker-profile.json'
$cutoverBrokerDurableRootCandidate = Join-Path $dataFull 'data\cutover-broker'
$cutoverAuthorityRootCandidate = Join-Path $dataFull 'data\authority-inventory'
$lifecycleBrokerShadowFull = $null
if ($SelfTestShadow) {
    if (-not $SelfTestSkipAdministratorCheck) {
        throw 'The lifecycle broker shadow scheduler is reserved for the isolated deployment self-test.'
    }
    $lifecycleBrokerShadowFull = Assert-DysonPlainDirectory $SelfTestShadow
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $requiredPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar + `
        'dyson-control-deployment-selftest-'
    if (-not $lifecycleBrokerShadowFull.TrimEnd('\', '/').StartsWith(
            $requiredPrefix, [StringComparison]::OrdinalIgnoreCase
        ) -or -not (Test-Path -LiteralPath (Join-Path $lifecycleBrokerShadowFull `
            '.dyson-lifecycle-broker-selftest') -PathType Leaf)) {
        throw 'The lifecycle broker shadow scheduler is outside the isolated deployment self-test root.'
    }
}
elseif ($SelfTestSkipAdministratorCheck -and
    (Test-Path -LiteralPath $lifecycleBrokerProfileCandidate -PathType Leaf)) {
    throw 'The isolated lifecycle broker uninstall self-test requires a shadow scheduler root.'
}
$cutoverBrokerShadowFull = $null
if ($SelfTestCutoverBrokerShadowRoot) {
    if (-not $SelfTestSkipAdministratorCheck) {
        throw 'The cutover broker shadow scheduler is reserved for the isolated deployment self-test.'
    }
    $cutoverBrokerShadowFull = Assert-DysonPlainDirectory $SelfTestCutoverBrokerShadowRoot
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $requiredPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar + `
        'dyson-control-deployment-selftest-'
    if (-not $cutoverBrokerShadowFull.TrimEnd('\', '/').StartsWith(
        $requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase
    ) -or -not (Test-Path -LiteralPath (Join-Path $cutoverBrokerShadowFull `
        '.dyson-cutover-broker-selftest') -PathType Leaf)) {
        throw 'The cutover broker shadow scheduler is outside the isolated deployment self-test root.'
    }
}
elseif ($SelfTestSkipAdministratorCheck -and
    (Test-Path -LiteralPath $cutoverBrokerProfileCandidate -PathType Leaf)) {
    throw 'The isolated cutover broker uninstall self-test requires a shadow scheduler root.'
}
if ($SkipTaskRemoval -and ((Test-Path -LiteralPath $lifecycleBrokerProfileCandidate) -or
    (Test-Path -LiteralPath $cutoverBrokerProfileCandidate))) {
    throw 'SkipTaskRemoval is forbidden while a fixed broker profile requires an orchestrated uninstall.'
}
if ($RemoveData -and ((Test-Path -LiteralPath $lifecycleBrokerDurableRootCandidate) -or
    (Test-Path -LiteralPath $cutoverBrokerDurableRootCandidate) -or
    (Test-Path -LiteralPath $cutoverAuthorityRootCandidate))) {
    throw 'RemoveData cannot delete retained lifecycle/cutover broker history, audit, authority evidence, or recovery state.'
}
$lifecycleBrokerPreflightState = Get-DysonUninstallLifecycleBrokerState `
    -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull `
    -ShadowRoot $lifecycleBrokerShadowFull
$cutoverBrokerPreflightState = Get-DysonUninstallCutoverBrokerState `
    -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull `
    -ShadowRoot $cutoverBrokerShadowFull
if (-not $PSCmdlet.ShouldProcess("$installFull; task $TaskName", $(
    if ($RemoveData) { 'uninstall Dyson Control and permanently remove its data root' }
    else { 'uninstall Dyson Control while preserving its data root' }
))) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        installRootWillBeRemoved = $true
        taskWillBeRemoved = -not [bool]$SkipTaskRemoval
        lifecycleBrokerWillBeRemoved = Test-Path -LiteralPath $lifecycleBrokerProfileCandidate -PathType Leaf
        lifecycleBrokerHistoryWillBePreserved = $true
        cutoverBrokerWillBeRemoved = Test-Path -LiteralPath $cutoverBrokerProfileCandidate -PathType Leaf
        cutoverBrokerDurableReceiptsWillBePreserved = $true
        dataWillBePreserved = -not [bool]$RemoveData
        qualifiedClientStorageConfigured = [bool]$qualifiedClientStorageEvidence.configured
        qualifiedClientProfileEnabled = [bool]$qualifiedClientStorageEvidence.enabled
        qualifiedClientStorageLayoutSha256 = [string]$qualifiedClientStorageEvidence.layoutSha256
        qualifiedClientStorageWillBePreserved = [bool]$qualifiedClientStorageEvidence.configured -and
            -not [bool]$RemoveData
        deploymentIdentityVerified = $true
        runtimeRootIdentity = [string]$nodeProtection.runtimeRootIdentity
        nodeExecutableSha256 = [string]$nodeProtection.nodeExecutableSha256
        runtimeWillBePreserved = $true
        configurationSha256 = [string]$configurationEvidence.configurationSha256
        configurationLength = [int64]$configurationEvidence.configurationLength
        configurationNamesSha256 = [string]$configurationEvidence.configurationNamesSha256
        configurationBindingsSha256 = [string]$configurationEvidence.configurationBindingsSha256
        configurationContractSha256 = [string]$configurationEvidence.configurationContractSha256
        configurationAclFingerprint = [string]$configurationEvidence.configurationAclFingerprint
        configurationParentAclFingerprint = [string]$configurationEvidence.configurationParentAclFingerprint
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

if ((-not $SkipTaskRemoval -or (Test-Path -LiteralPath $lifecycleBrokerProfileCandidate -PathType Leaf) -or
        (Test-Path -LiteralPath $cutoverBrokerProfileCandidate -PathType Leaf)) -and
    -not $SelfTestSkipAdministratorCheck) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to remove the control-plane startup task.'
    }
}

$deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
try {
    $deploymentState = Get-DysonUninstallVerifiedDeploymentState `
        -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull
    Assert-DysonUninstallDeploymentStateUnchanged `
        -Before $deploymentPreflightState -After $deploymentState
    $configurationUnderLock = Invoke-DysonDeploymentConfigurationTest `
        -DataRoot $dataFull `
        -ScriptRoot (Join-Path (Join-Path (Join-Path $installFull 'releases') `
            ([string]$deploymentState.activeVersion)) 'scripts\windows') `
        -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
        -DeploymentVersion ([string]$deploymentState.activeVersion) `
        -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
    Assert-DysonDeploymentConfigurationEvidenceMatch `
        -Expected $configurationEvidence -Actual $configurationUnderLock
    $qualifiedClientStorageUnderLock = Test-DysonQualifiedClientStorage `
        -Plan $qualifiedClientStoragePlan -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
    if ([bool]$qualifiedClientStorageUnderLock.configured -ne
            [bool]$qualifiedClientStorageEvidence.configured -or
        [bool]$qualifiedClientStorageUnderLock.enabled -ne
            [bool]$qualifiedClientStorageEvidence.enabled -or
        [string]$qualifiedClientStorageUnderLock.layoutSha256 -cne
            [string]$qualifiedClientStorageEvidence.layoutSha256 -or
        [int]$qualifiedClientStorageUnderLock.directoryCount -ne
            [int]$qualifiedClientStorageEvidence.directoryCount) {
        throw 'The qualified-client storage state changed before uninstall mutation.'
    }
    $taskRollbackState = if ($SkipTaskRemoval) { $null } else { Get-DysonControlTaskRollbackState -TaskName $TaskName }
    $lifecycleBrokerState = Get-DysonUninstallLifecycleBrokerState -ResolvedInstallRoot $installFull `
        -ResolvedDataRoot $dataFull -ShadowRoot $lifecycleBrokerShadowFull
    $cutoverBrokerState = Get-DysonUninstallCutoverBrokerState -ResolvedInstallRoot $installFull `
        -ResolvedDataRoot $dataFull -ShadowRoot $cutoverBrokerShadowFull
    Assert-DysonUninstallBrokerPreflightStateUnchanged -Before $lifecycleBrokerPreflightState `
        -After $lifecycleBrokerState -Kind lifecycle
    Assert-DysonUninstallBrokerPreflightStateUnchanged -Before $cutoverBrokerPreflightState `
        -After $cutoverBrokerState -Kind cutover
    if (-not [string]::IsNullOrWhiteSpace($SelfTestBeforeDestructiveMutation)) {
        switch ($SelfTestBeforeDestructiveMutation) {
            'ActivePointerDeploymentId' {
                $selfTestPointerPath = Get-DysonActivePointerPath -DataRoot $dataFull
                $selfTestPointer = [System.IO.File]::ReadAllText(
                    $selfTestPointerPath, [System.Text.UTF8Encoding]::new($false, $true)
                ) | ConvertFrom-Json -ErrorAction Stop
                $selfTestPointer.deploymentId = '00000000-0000-4000-8000-000000000001'
                Write-DysonJsonAtomic -Path $selfTestPointerPath -Value $selfTestPointer
            }
            'InstallRootJunction' {
                $selfTestRelocatedRoot = $installFull + '.selftest-relocated'
                if (Test-Path -LiteralPath $selfTestRelocatedRoot) {
                    throw 'The self-test path-drift relocation target is occupied.'
                }
                [System.IO.Directory]::Move($installFull, $selfTestRelocatedRoot)
                try {
                    [void](New-Item -ItemType Junction -Path $installFull `
                        -Target $selfTestRelocatedRoot -ErrorAction Stop)
                }
                catch {
                    if (-not (Test-Path -LiteralPath $installFull) -and
                        (Test-Path -LiteralPath $selfTestRelocatedRoot -PathType Container)) {
                        [System.IO.Directory]::Move($selfTestRelocatedRoot, $installFull)
                    }
                    throw
                }
            }
        }
        $preMutationDeploymentState = Get-DysonUninstallVerifiedDeploymentState `
            -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull
        Assert-DysonUninstallDeploymentStateUnchanged `
            -Before $deploymentState -After $preMutationDeploymentState
        $preMutationLifecycleState = Get-DysonUninstallLifecycleBrokerState `
            -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull `
            -ShadowRoot $lifecycleBrokerShadowFull
        $preMutationCutoverState = Get-DysonUninstallCutoverBrokerState `
            -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull `
            -ShadowRoot $cutoverBrokerShadowFull
        Assert-DysonUninstallBrokerPreflightStateUnchanged -Before $lifecycleBrokerState `
            -After $preMutationLifecycleState -Kind lifecycle
        Assert-DysonUninstallBrokerPreflightStateUnchanged -Before $cutoverBrokerState `
            -After $preMutationCutoverState -Kind cutover
    }
    if (-not (Test-Path -LiteralPath $dataFull)) { [void](New-DysonDirectory -Path $dataFull) }
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'started' -Code 'UNINSTALL_STARTED'

    $uninstallId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $taskBackupPath = $null
    $taskMutationAttempted = $false
    $taskRemoved = $false
    $releaseBackupPath = $null
    $activePointerPath = Get-DysonActivePointerPath -DataRoot $dataFull
    $activePointerBackupPath = $null
    $lifecycleBrokerRemoved = $false
    $lifecycleBrokerRemovalReceipt = $null
    $cutoverBrokerRemoved = $false
    $cutoverBrokerRemovalReceipt = $null
    try {
        if (-not $SkipTaskRemoval -and [bool]$taskRollbackState.present) {
            $taskBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-tasks')
            $taskBackupPath = Join-Path $taskBackupRoot ($uninstallId + '.xml')
            [System.IO.File]::WriteAllText(
                $taskBackupPath,
                [string]$taskRollbackState.xml,
                [System.Text.UTF8Encoding]::new($false)
            )
            $taskMutationAttempted = $true
            Remove-DysonControlTaskForRollback -TaskName $TaskName
            $taskRemoved = $true
        }
        if ($null -ne $cutoverBrokerState) {
            $removeBrokerArguments = @{}
            foreach ($key in $cutoverBrokerState.installArguments.Keys) {
                $removeBrokerArguments[$key] = $cutoverBrokerState.installArguments[$key]
            }
            $removeBrokerArguments['RequestId'] = [guid]::NewGuid().ToString('D')
            $removeBrokerArguments['Operation'] = 'RemoveCurrent'
            $removeBrokerArguments['ExpectedProfileFingerprint'] = `
                [string]$cutoverBrokerState.profile.profileFingerprint
            $removeBrokerArguments['ExpectedBrokerBundleSha256'] = `
                [string]$cutoverBrokerState.binding.brokerBundleSha256
            $cutoverBrokerRemovalReceipt = Invoke-DysonUninstallCutoverBrokerInstaller `
                -State $cutoverBrokerState -Arguments $removeBrokerArguments `
                -ShadowRoot $cutoverBrokerShadowFull
            if ([string]$cutoverBrokerRemovalReceipt.protocol -cne `
                    'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_RECEIPT_V1' -or
                [int]$cutoverBrokerRemovalReceipt.schemaVersion -ne 1 -or
                [string]$cutoverBrokerRemovalReceipt.operation -cne 'removed-current' -or
                [string]$cutoverBrokerRemovalReceipt.profileFingerprint -cne `
                    [string]$cutoverBrokerState.profile.profileFingerprint -or
                [string]$cutoverBrokerRemovalReceipt.brokerBundleSha256 -cne `
                    [string]$cutoverBrokerState.binding.brokerBundleSha256 -or
                -not [bool]$cutoverBrokerRemovalReceipt.removed -or
                [string]$cutoverBrokerRemovalReceipt.status -cne 'succeeded') {
                throw 'The cutover broker removal receipt is invalid.'
            }
            if ((Test-Path -LiteralPath ([string]$cutoverBrokerState.profilePath)) -or
                (Test-Path -LiteralPath ([string]$cutoverBrokerState.bindingPath)) -or
                ($cutoverBrokerShadowFull -and
                    (Test-Path -LiteralPath ([string]$cutoverBrokerState.taskIntentPath)))) {
                throw 'The cutover broker removal left a fixed task/profile binding.'
            }
            Assert-DysonUninstallCutoverDurableStatePreserved -State $cutoverBrokerState
            $cutoverBrokerRemoved = $true
        }
        if ($null -ne $lifecycleBrokerState) {
            $removeLifecycleArguments = @{}
            foreach ($key in $lifecycleBrokerState.installArguments.Keys) {
                $removeLifecycleArguments[$key] = $lifecycleBrokerState.installArguments[$key]
            }
            [void]$removeLifecycleArguments.Remove('UpgradeExisting')
            [void]$removeLifecycleArguments.Remove('CompensateFirstInstall')
            $removeLifecycleArguments['RemoveCurrent'] = $true
            $removeLifecycleArguments['ExpectedProfileHash'] = [string]$lifecycleBrokerState.profileHash
            $lifecycleBrokerRemovalReceipt = Invoke-DysonUninstallLifecycleBrokerInstaller `
                -Installer ([string]$lifecycleBrokerState.installer) `
                -Arguments $removeLifecycleArguments -ShadowRoot $lifecycleBrokerShadowFull
            $removalMessage = 'The lifecycle broker removal receipt is invalid.'
            Assert-DysonUninstallExactProperties -Value $lifecycleBrokerRemovalReceipt -Names @(
                'protocol', 'schemaVersion', 'operation', 'brokerRoot', 'removedProfileHash',
                'workerTaskName', 'workerTaskPath', 'profileRemoved', 'taskRemoved',
                'preservedRequestCount', 'preservedReceiptCount', 'intentsEmpty', 'backend', 'removedAt'
            ) -Message $removalMessage
            $removedAt = [datetimeoffset]::MinValue
            if ([string]$lifecycleBrokerRemovalReceipt.protocol -cne `
                    'DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_RECEIPT_V1' -or
                [int]$lifecycleBrokerRemovalReceipt.schemaVersion -ne 1 -or
                [string]$lifecycleBrokerRemovalReceipt.operation -cne 'removed-current' -or
                -not (Test-DysonUninstallSamePath ([string]$lifecycleBrokerRemovalReceipt.brokerRoot) `
                    ([string]$lifecycleBrokerState.profile.brokerRoot)) -or
                [string]$lifecycleBrokerRemovalReceipt.removedProfileHash -cne `
                    [string]$lifecycleBrokerState.profileHash -or
                [string]$lifecycleBrokerRemovalReceipt.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
                [string]$lifecycleBrokerRemovalReceipt.workerTaskPath -cne '\DysonControl\' -or
                -not [bool]$lifecycleBrokerRemovalReceipt.profileRemoved -or
                -not [bool]$lifecycleBrokerRemovalReceipt.taskRemoved -or
                -not [bool]$lifecycleBrokerRemovalReceipt.intentsEmpty -or
                -not [datetimeoffset]::TryParseExact(
                    [string]$lifecycleBrokerRemovalReceipt.removedAt, 'o',
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind, [ref]$removedAt
                )) {
                throw $removalMessage
            }
            if ((Test-Path -LiteralPath ([string]$lifecycleBrokerState.profilePath)) -or
                ($lifecycleBrokerShadowFull -and
                    ((Test-Path -LiteralPath ([string]$lifecycleBrokerState.taskPath)) -or
                        (Test-Path -LiteralPath ([string]$lifecycleBrokerState.profileAclPath)))) -or
                (-not $lifecycleBrokerShadowFull -and
                    @(Get-DysonLifecycleBrokerStaticWorkerTasks).Count -ne 0)) {
                throw 'The lifecycle broker removal left a fixed task/profile binding.'
            }
            Assert-DysonUninstallLifecycleDurableStatePreserved -State $lifecycleBrokerState
            $lifecycleBrokerRemoved = $true
        }
        if ($lifecycleBrokerShadowFull -and
            (Test-Path -LiteralPath (Join-Path $lifecycleBrokerShadowFull `
                'fail-after-broker-removal') -PathType Leaf)) {
            throw 'Isolated deployment self-test failure after broker removal.'
        }
        if (Test-Path -LiteralPath $installFull -PathType Container) {
            [void](Assert-DysonDeploymentPlainTree -Path $installFull)
            [void](Assert-DysonDeploymentPlainTree -Path $dataFull)
            $beforeMoveState = Get-DysonUninstallVerifiedDeploymentState `
                -ResolvedInstallRoot $installFull -ResolvedDataRoot $dataFull
            Assert-DysonUninstallDeploymentStateUnchanged `
                -Before $deploymentState -After $beforeMoveState
            $releaseBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-releases')
            $releaseBackupPath = Join-Path $releaseBackupRoot $uninstallId
            $releaseBackupIdentity = Get-DysonDeploymentPathIdentity -Path $releaseBackupPath
            $dataIdentity = Get-DysonDeploymentPathIdentity -Path $dataFull
            if (-not (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $releaseBackupIdentity `
                    -ParentIdentity $dataIdentity) -or
                (Test-Path -LiteralPath $releaseBackupPath)) {
                throw 'The recoverable uninstall target is occupied or outside DataRoot.'
            }
            [void](Assert-DysonDeploymentPlainPathChain -Path $releaseBackupRoot)
            [System.IO.Directory]::Move($installFull, $releaseBackupPath)
            [void](Assert-DysonUninstallMovedIdentity -VerifiedState $deploymentState `
                -ReleaseBackupPath $releaseBackupPath)
        }
        if (Test-Path -LiteralPath $activePointerPath -PathType Leaf) {
            $stateBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-state')
            $activePointerBackupPath = Join-Path $stateBackupRoot ($uninstallId + '.active-release.json')
            if (Test-Path -LiteralPath $activePointerBackupPath) {
                throw 'The recoverable active-pointer target is already occupied.'
            }
            $activePointerFile = Assert-DysonUninstallPlainFile $activePointerPath 32768 `
                'The active release pointer became unavailable or redirected before recovery.'
            if ((Get-DysonFileSha256 -Path $activePointerFile) -cne
                [string]$deploymentState.activePointerSha256) {
                throw 'The active release pointer changed before its recoverable move.'
            }
            [System.IO.File]::Move($activePointerFile, $activePointerBackupPath)
            $movedPointer = Assert-DysonUninstallPlainFile $activePointerBackupPath 32768 `
                'The recoverable active pointer is unavailable or redirected.'
            if ((Get-DysonFileSha256 -Path $movedPointer) -cne
                [string]$deploymentState.activePointerSha256) {
                throw 'The active release pointer changed during its recoverable move.'
            }
        }
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'succeeded' -SnapshotId $uninstallId -Code 'UNINSTALL_SUCCEEDED'
    }
    catch {
        $uninstallError = $_
        $rollbackFailures = New-Object System.Collections.Generic.List[string]
        $deploymentStateRestored = $true
        try {
            if ($releaseBackupPath -and (Test-Path -LiteralPath $releaseBackupPath)) {
                if (Test-Path -LiteralPath $installFull) { throw 'The install root is occupied during uninstall rollback.' }
                [void](Assert-DysonDeploymentDestructiveRootLayout `
                    -InstallRoot $installFull -DataRoot $dataFull)
                [void](Assert-DysonDeploymentPlainTree -Path $releaseBackupPath)
                [void](Assert-DysonUninstallMovedIdentity -VerifiedState $deploymentState `
                    -ReleaseBackupPath $releaseBackupPath)
                [void](Assert-DysonDeploymentPlainPathChain -Path ([System.IO.Path]::GetDirectoryName($installFull)))
                [System.IO.Directory]::Move($releaseBackupPath, $installFull)
            }
            if ($activePointerBackupPath -and (Test-Path -LiteralPath $activePointerBackupPath -PathType Leaf)) {
                if (Test-Path -LiteralPath $activePointerPath -PathType Leaf) {
                    if ((Get-DysonFileSha256 -Path $activePointerPath) -cne
                        (Get-DysonFileSha256 -Path $activePointerBackupPath)) {
                        throw 'The active release pointer changed during uninstall rollback.'
                    }
                }
                else {
                    Copy-Item -LiteralPath $activePointerBackupPath -Destination $activePointerPath -Force -ErrorAction Stop
                }
            }
        }
        catch {
            $deploymentStateRestored = $false
            $rollbackFailures.Add('deployment-state')
        }

        $lifecycleBrokerRestored = $null -eq $lifecycleBrokerState
        if ($null -ne $lifecycleBrokerState -and $deploymentStateRestored) {
            if ($lifecycleBrokerRemoved) {
                try {
                    $restoreLifecycleArguments = @{}
                    foreach ($key in $lifecycleBrokerState.installArguments.Keys) {
                        $restoreLifecycleArguments[$key] = $lifecycleBrokerState.installArguments[$key]
                    }
                    [void]$restoreLifecycleArguments.Remove('RemoveCurrent')
                    [void]$restoreLifecycleArguments.Remove('ExpectedProfileHash')
                    [void]$restoreLifecycleArguments.Remove('UpgradeExisting')
                    [void]$restoreLifecycleArguments.Remove('CompensateFirstInstall')
                    $restoreLifecycleReceipt = Invoke-DysonUninstallLifecycleBrokerInstaller `
                        -Installer ([string]$lifecycleBrokerState.installer) `
                        -Arguments $restoreLifecycleArguments -ShadowRoot $lifecycleBrokerShadowFull
                    $restoreMessage = 'The restored lifecycle broker receipt is invalid.'
                    Assert-DysonUninstallExactProperties -Value $restoreLifecycleReceipt -Names @(
                        'protocol', 'schemaVersion', 'operation', 'reused', 'upgraded', 'brokerRoot',
                        'profileFile', 'profileHash', 'profileCreatedAt', 'workerTaskName', 'workerTaskPath',
                        'serverTaskDescriptorHash', 'stopTaskDescriptorHash', 'backend', 'aclIntent',
                        'taskAclIntent', 'installedAt'
                    ) -Message $restoreMessage
                    if ([string]$restoreLifecycleReceipt.protocol -cne `
                            'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_RECEIPT_V1' -or
                        [int]$restoreLifecycleReceipt.schemaVersion -ne 1 -or
                        [string]$restoreLifecycleReceipt.operation -cne 'installed' -or
                        [bool]$restoreLifecycleReceipt.reused -or [bool]$restoreLifecycleReceipt.upgraded -or
                        -not (Test-DysonUninstallSamePath ([string]$restoreLifecycleReceipt.profileFile) `
                            ([string]$lifecycleBrokerState.profilePath)) -or
                        [string]$restoreLifecycleReceipt.profileHash -cnotmatch '^[0-9a-f]{64}$' -or
                        [string]$restoreLifecycleReceipt.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
                        [string]$restoreLifecycleReceipt.workerTaskPath -cne '\DysonControl\') {
                        throw $restoreMessage
                    }
                    Restore-DysonUninstallLifecyclePreimageAclsAndTask -State $lifecycleBrokerState `
                        -ShadowRoot $lifecycleBrokerShadowFull
                    Assert-DysonUninstallLifecycleRestored -State $lifecycleBrokerState `
                        -ShadowRoot $lifecycleBrokerShadowFull
                    $lifecycleBrokerRestored = $true
                }
                catch { $rollbackFailures.Add('lifecycle-broker:' + $_.Exception.Message) }
            }
            else {
                try {
                    Assert-DysonUninstallLifecycleRestored -State $lifecycleBrokerState `
                        -ShadowRoot $lifecycleBrokerShadowFull
                    $lifecycleBrokerRestored = $true
                }
                catch { $rollbackFailures.Add('lifecycle-broker-preimage') }
            }
        }
        elseif ($null -ne $lifecycleBrokerState) {
            $rollbackFailures.Add('lifecycle-broker-blocked-by-deployment-state')
        }

        $cutoverBrokerRestored = $null -eq $cutoverBrokerState
        if ($null -ne $cutoverBrokerState -and $deploymentStateRestored -and $lifecycleBrokerRestored) {
            if ($cutoverBrokerRemoved) {
                try {
                    $restoreBrokerArguments = @{}
                    foreach ($key in $cutoverBrokerState.installArguments.Keys) {
                        $restoreBrokerArguments[$key] = $cutoverBrokerState.installArguments[$key]
                    }
                    $restoreBrokerArguments['RequestId'] = [guid]::NewGuid().ToString('D')
                    $restoreBrokerReceipt = Invoke-DysonUninstallCutoverBrokerInstaller `
                        -State $cutoverBrokerState -Arguments $restoreBrokerArguments `
                        -ShadowRoot $cutoverBrokerShadowFull
                    if ([string]$restoreBrokerReceipt.protocol -cne `
                            'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -or
                        [int]$restoreBrokerReceipt.schemaVersion -ne 1 -or
                        [string]$restoreBrokerReceipt.operation -cne 'installed' -or
                        [string]$restoreBrokerReceipt.profileFingerprint -cne `
                            [string]$cutoverBrokerState.profile.profileFingerprint -or
                        [bool]$restoreBrokerReceipt.reused -or [bool]$restoreBrokerReceipt.upgraded) {
                        throw 'The restored cutover broker receipt is invalid.'
                    }
                    Restore-DysonUninstallBrokerPreimageAclsAndTask -State $cutoverBrokerState `
                        -ShadowRoot $cutoverBrokerShadowFull
                    Assert-DysonUninstallBrokerRestored -State $cutoverBrokerState `
                        -ShadowRoot $cutoverBrokerShadowFull
                    $cutoverBrokerRestored = $true
                }
                catch { $rollbackFailures.Add('cutover-broker:' + $_.Exception.Message) }
            }
            else {
                try {
                    Assert-DysonUninstallBrokerRestored -State $cutoverBrokerState `
                        -ShadowRoot $cutoverBrokerShadowFull
                    $cutoverBrokerRestored = $true
                }
                catch { $rollbackFailures.Add('cutover-broker-preimage') }
            }
        }
        elseif ($null -ne $cutoverBrokerState) {
            $rollbackFailures.Add('cutover-broker-blocked-by-deployment-or-lifecycle-state')
        }

        if ($taskMutationAttempted -and [bool]$taskRollbackState.present) {
            if ($deploymentStateRestored -and $lifecycleBrokerRestored -and $cutoverBrokerRestored) {
                try {
                    [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName)
                }
                catch { $rollbackFailures.Add('control-task') }
            }
            else { $rollbackFailures.Add('control-task-blocked-by-deployment-or-broker-state') }
        }

        if ($rollbackFailures.Count -eq 0) {
            try {
                Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rolled-back' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLED_BACK'
            }
            catch { $rollbackFailures.Add('rollback-audit') }
        }
        if ($rollbackFailures.Count -gt 0) {
            try {
                Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rollback-failed' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLBACK_FAILED'
            }
            catch { }
            throw ('Uninstall failed ({0}); automatic rollback was incomplete in: {1}.' -f
                $uninstallError.Exception.Message, [string]::Join(', ', @($rollbackFailures)))
        }
        throw $uninstallError
    }

    if ($RemoveData -and (Test-Path -LiteralPath $dataFull)) {
        try {
            Remove-DysonUninstallVerifiedDataRoot -VerifiedState $deploymentState `
                -ReleaseBackupPath $releaseBackupPath -ActivePointerBackupPath $activePointerBackupPath
        }
        catch {
            $dataRemovalFailure = $_.Exception
            if (Test-Path -LiteralPath $dataFull -PathType Container) {
                try {
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'data-removal-incomplete' `
                        -SnapshotId $uninstallId -Code 'UNINSTALL_DATA_REMOVAL_INCOMPLETE'
                }
                catch { }
            }
            throw [System.InvalidOperationException]::new(
                'Dyson Control was uninstalled, but the explicitly requested data-root removal did not complete.',
                $dataRemovalFailure
            )
        }
    }
    if ($RemoveData) {
        if (Test-Path -LiteralPath (Join-Path $dataFull 'data\qualified-client')) {
            throw 'The qualified-client storage tree remained after confirmed DataRoot removal.'
        }
        $qualifiedClientStoragePreserved = $false
        $qualifiedClientStorageRemoved = [bool]$qualifiedClientStoragePlan.configured
    }
    else {
        $qualifiedClientStorageFinal = Test-DysonQualifiedClientStorage `
            -Plan $qualifiedClientStoragePlan -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
            -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
        $qualifiedClientStoragePreserved = [bool]$qualifiedClientStorageFinal.configured
        $qualifiedClientStorageRemoved = $false
    }
    $preservedRuntime = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $installFull -DataRoot $dataFull
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'uninstalled'
        taskRemoved = $taskRemoved
        lifecycleBrokerRemoved = $lifecycleBrokerRemoved
        lifecycleBrokerHistoryPreserved = $true
        cutoverBrokerRemoved = $cutoverBrokerRemoved
        cutoverBrokerDurableReceiptsPreserved = $true
        dataPreserved = -not [bool]$RemoveData
        qualifiedClientStorageConfigured = [bool]$qualifiedClientStorageEvidence.configured
        qualifiedClientProfileEnabled = [bool]$qualifiedClientStorageEvidence.enabled
        qualifiedClientStorageLayoutSha256 = [string]$qualifiedClientStorageEvidence.layoutSha256
        qualifiedClientStoragePreserved = $qualifiedClientStoragePreserved
        qualifiedClientStorageRemoved = $qualifiedClientStorageRemoved
        runtimeRootIdentity = [string]$preservedRuntime.runtimeRootIdentity
        nodeExecutableSha256 = [string]$preservedRuntime.nodeExecutableSha256
        runtimePreserved = $true
        configurationPreserved = -not [bool]$RemoveData
        configurationSha256 = [string]$configurationEvidence.configurationSha256
        configurationLength = [int64]$configurationEvidence.configurationLength
        configurationNamesSha256 = [string]$configurationEvidence.configurationNamesSha256
        configurationBindingsSha256 = [string]$configurationEvidence.configurationBindingsSha256
        configurationContractSha256 = [string]$configurationEvidence.configurationContractSha256
        configurationAclFingerprint = [string]$configurationEvidence.configurationAclFingerprint
        configurationParentAclFingerprint = [string]$configurationEvidence.configurationParentAclFingerprint
        recoverableReleaseBackup = if (-not $RemoveData -and $releaseBackupPath) { $releaseBackupPath } else { $null }
        activePointerBackup = if (-not $RemoveData -and $activePointerBackupPath) { $activePointerBackupPath } else { $null }
        taskDefinitionBackup = if (-not $RemoveData) { $taskBackupPath } else { $null }
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
}
finally {
    if ($deploymentLock) { $deploymentLock.Dispose() }
}
