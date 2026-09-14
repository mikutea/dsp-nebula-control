[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArtifactPayloadSha256,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [string]$EntryPointRelativePath = 'apps\api\dist\index.js',
    [Parameter(Mandatory)][string]$ConfigurationSource,
    [switch]$RegisterStartupTask,
    [switch]$StartAfterInstall,
    [switch]$InstallLifecycleBrokerTask,
    [switch]$UpgradeLifecycleBrokerExisting,
    [string]$ProjectRoot,
    [string]$RuntimeBootstrapRoot,
    [string]$ServiceUser,
    [Nullable[int]]$GamePort,
    [Nullable[int]]$DispatchReadyTimeout,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [uri]$ReadinessUri,
    [ValidateRange(1, 300)][int]$ReadinessTimeoutSeconds = 30,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck,
    [Parameter(DontShow)][string]$SelfTestShadow,
    [Parameter(DontShow)][string]$SelfTestConfigurationShadowRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

function Test-DysonDeploymentSamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    return [string]::Equals(
        (Get-DysonFullPath -Path $Left).TrimEnd('\', '/'),
        (Get-DysonFullPath -Path $Right).TrimEnd('\', '/'),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Remove-DysonDeploymentCreatedConfiguration {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [Parameter(Mandatory)]$ExpectedPreflight,
        [Parameter(Mandatory)][string]$ConfigurationModuleRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $moduleRoot = Resolve-DysonDeploymentConfigurationModuleRoot `
        -ModuleRoot $ConfigurationModuleRoot
    . (Join-Path $moduleRoot 'DysonConfiguration.Common.ps1')
    $configurationPath = Join-Path (Join-Path (Get-DysonFullPath -Path $DataRoot) 'config') `
        'dyson-control.env'

    if ($AllowSelfTestAdministrator) {
        Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $DataRoot -DataRoot $DataRoot
        if (-not (Test-Path -LiteralPath (Join-Path $moduleRoot `
                    '.dyson-configuration-selftest') -PathType Leaf)) {
            throw 'The isolated configuration rollback fixture is unavailable.'
        }
        $fixtureConfigRoot = Assert-DysonPlainDirectory `
            -Path ([System.IO.Path]::GetDirectoryName($configurationPath))
        $fixtureEntries = @(Get-ChildItem -LiteralPath $fixtureConfigRoot -Force -ErrorAction Stop)
        if ($fixtureEntries.Count -ne 1 -or $fixtureEntries[0].PSIsContainer -or
            -not (Test-DysonDeploymentSamePath -Left $fixtureEntries[0].FullName `
                -Right $configurationPath)) {
            throw 'The isolated created-configuration rollback fixture is inconsistent.'
        }
        $fixtureEvidence = Get-FixtureConfigurationEvidence -ConfigurationPath $configurationPath `
            -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
            -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
        if ([string]$fixtureEvidence.configurationSha256 -cne [string]$ExpectedPreflight.sourceSha256 -or
            [int64]$fixtureEvidence.configurationLength -ne [int64]$ExpectedPreflight.sourceLength -or
            [string]$fixtureEvidence.namesSha256 -cne [string]$ExpectedPreflight.namesSha256 -or
            [string]$fixtureEvidence.bindingsSha256 -cne [string]$ExpectedPreflight.bindingsSha256 -or
            [string]$fixtureEvidence.contractSha256 -cne [string]$ExpectedPreflight.contractSha256) {
            throw 'The isolated created-configuration rollback target changed after installation.'
        }
        [System.IO.File]::Delete($fixtureEntries[0].FullName)
        [System.IO.Directory]::Delete($fixtureConfigRoot, $false)
        if ((Test-Path -LiteralPath $configurationPath) -or
            (Test-Path -LiteralPath $fixtureConfigRoot)) {
            throw 'The isolated created-configuration rollback did not restore an absent preimage.'
        }
        return
    }

    $dataFull = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
    $serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
    $contract = Get-DysonConfigurationContract -ContractPath (
        Join-Path $moduleRoot 'dyson-control.environment-contract.json'
    )
    $bindings = Get-DysonDeploymentConfigurationBindings -DataRoot $dataFull `
        -ScriptRoot $ScriptRoot -RuntimeBootstrapRoot $RuntimeBootstrapRoot `
        -DeploymentVersion $DeploymentVersion
    $storage = Get-DysonConfigurationStoragePaths -DataRoot $dataFull
    $approvalPath = Join-Path $storage.configRoot $script:DysonConfigurationRuntimeApprovalName
    foreach ($directory in @(
            $storage.configRoot, $storage.transactionRoot, $storage.intentsRoot,
            $storage.receiptsRoot, $storage.snapshotRoot
        )) {
        [void](Assert-DysonConfigurationPlainDirectoryChain $directory)
    }
    [void](Assert-DysonConfigurationAcl -Path $storage.configRoot `
        -Kind ConfigDirectory -ServiceSid $serviceSid)
    foreach ($directory in @(
            $storage.transactionRoot, $storage.intentsRoot, $storage.receiptsRoot,
            $storage.snapshotRoot
        )) {
        [void](Assert-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory)
    }

    $configurationLock = Enter-DysonConfigurationMutationLock -Storage $storage
    try {
        $state = Get-DysonConfigurationTransactionState -Storage $storage `
            -ServiceSid $serviceSid -Contract $contract `
            -ExpectedLauncherBindings $bindings -LockHeld
        $intentEntries = @($state.intents.Values)
        $receiptEntries = @($state.receipts.Values)
        if (-not [bool]$state.clean -or $intentEntries.Count -ne 1 -or
            $receiptEntries.Count -ne 1 -or [int64]$state.nextSequence -ne 2 -or
            [int64]$state.terminalSequence -ne 1 -or
            [string]$state.terminalReceiptState -cne 'installed' -or
            -not [bool]$state.terminalTargetPresent -or
            [string]$state.terminalTargetSha256 -cne [string]$ExpectedPreflight.sourceSha256 -or
            [int64]$state.terminalTargetLength -ne [int64]$ExpectedPreflight.sourceLength -or
            [string]$state.terminalBindingsSha256 -cne [string]$ExpectedPreflight.bindingsSha256 -or
            [string]$state.terminalContractSha256 -cne [string]$ExpectedPreflight.contractSha256 -or
            [string]$state.terminalTargetPathSha256 -cne
                (Get-DysonConfigurationPathBindingSha256 $storage.configurationPath)) {
            throw 'The created protected configuration is not the exact single-transaction postimage.'
        }
        $intent = $intentEntries[0]
        $receipt = $receiptEntries[0]
        if ([string]$intent.record.operation -cne 'create' -or
            [bool]$intent.record.preimagePresent -or [int64]$intent.record.sequence -ne 1 -or
            [string]$intent.record.sourceSha256 -cne [string]$ExpectedPreflight.sourceSha256 -or
            [int64]$intent.record.sourceLength -ne [int64]$ExpectedPreflight.sourceLength -or
            [string]$intent.record.bindingsSha256 -cne [string]$ExpectedPreflight.bindingsSha256 -or
            [string]$intent.record.contractSha256 -cne [string]$ExpectedPreflight.contractSha256 -or
            [string]$receipt.record.state -cne 'installed' -or
            [int64]$receipt.record.sequence -ne 1 -or
            [string]$receipt.record.transactionId -cne [string]$intent.record.transactionId -or
            [string]$receipt.record.targetSha256 -cne [string]$ExpectedPreflight.sourceSha256 -or
            [int64]$receipt.record.targetLength -ne [int64]$ExpectedPreflight.sourceLength) {
            throw 'The created protected configuration transaction does not match its validated source.'
        }
        $approvalPresent = Test-Path -LiteralPath $approvalPath -PathType Leaf
        if ($approvalPresent) {
            $parentAcl = Assert-DysonConfigurationParentAcl -Path $dataFull -ServiceSid $serviceSid
            $runtimeApproval = Test-DysonConfigurationRuntimeApproval -Storage $storage `
                -Contract $contract -ExpectedLauncherBindings $bindings `
                -ServiceSid $serviceSid -ParentAcl $parentAcl
            if ([string]$runtimeApproval.configurationSha256 -cne [string]$ExpectedPreflight.sourceSha256 -or
                [int64]$runtimeApproval.configurationLength -ne [int64]$ExpectedPreflight.sourceLength -or
                [string]$runtimeApproval.namesSha256 -cne [string]$ExpectedPreflight.namesSha256 -or
                [string]$runtimeApproval.bindingsSha256 -cne [string]$ExpectedPreflight.bindingsSha256 -or
                [string]$runtimeApproval.contractSha256 -cne [string]$ExpectedPreflight.contractSha256 -or
                [int]$runtimeApproval.completedTransactionCount -ne 1 -or
                [int]$runtimeApproval.protectedSnapshotCount -ne 0) {
                throw 'The created protected configuration runtime approval does not match its transaction.'
            }
        }
        $configEntries = @(Get-ChildItem -LiteralPath $storage.configRoot -Force -ErrorAction Stop)
        $transactionEntries = @(Get-ChildItem -LiteralPath $storage.transactionRoot -Force -ErrorAction Stop)
        $intentFiles = @(Get-ChildItem -LiteralPath $storage.intentsRoot -Force -ErrorAction Stop)
        $receiptFiles = @(Get-ChildItem -LiteralPath $storage.receiptsRoot -Force -ErrorAction Stop)
        $snapshotEntries = @(Get-ChildItem -LiteralPath $storage.snapshotRoot -Force -ErrorAction Stop)
        $configNames = @($configEntries.Name | Sort-Object -CaseSensitive)
        $expectedConfigNames = @(
            @('dyson-control.env') + $(if ($approvalPresent) {
                @($script:DysonConfigurationRuntimeApprovalName)
            } else { @() }) | Sort-Object -CaseSensitive
        )
        if ($configEntries.Count -ne $expectedConfigNames.Count -or
            ($configNames -join '|') -cne ($expectedConfigNames -join '|') -or
            @($configEntries | Where-Object { $_.PSIsContainer }).Count -ne 0 -or
            $transactionEntries.Count -ne 3 -or
            (@($transactionEntries.Name | Sort-Object -CaseSensitive) -join '|') -cne
                (@('configuration.lock', 'intents', 'receipts') -join '|') -or
            $intentFiles.Count -ne 1 -or $receiptFiles.Count -ne 1 -or
            $snapshotEntries.Count -ne 0 -or
            -not (Test-DysonDeploymentSamePath -Left $intentFiles[0].FullName -Right $intent.path) -or
            -not (Test-DysonDeploymentSamePath -Left $receiptFiles[0].FullName -Right $receipt.path)) {
            throw 'The created protected configuration storage contains an unexpected entry.'
        }
        if ($approvalPresent) {
            [System.IO.File]::Delete((ConvertTo-DysonConfigurationExtendedPath $approvalPath))
        }
        [System.IO.File]::Delete(
            (ConvertTo-DysonConfigurationExtendedPath $storage.configurationPath)
        )
        [System.IO.File]::Delete((ConvertTo-DysonConfigurationExtendedPath $receipt.path))
        [System.IO.File]::Delete((ConvertTo-DysonConfigurationExtendedPath $intent.path))
        if ([System.IO.File]::Exists(
                (ConvertTo-DysonConfigurationExtendedPath $storage.configurationPath)
            ) -or @(Get-ChildItem -LiteralPath $storage.intentsRoot -Force -ErrorAction Stop).Count -ne 0 -or
            @(Get-ChildItem -LiteralPath $storage.receiptsRoot -Force -ErrorAction Stop).Count -ne 0) {
            throw 'The created protected configuration files were not removed.'
        }
    }
    finally { $configurationLock.Dispose() }

    [void](Assert-DysonConfigurationAcl -Path $storage.lockPath -Kind PrivateFile)
    [System.IO.File]::Delete((ConvertTo-DysonConfigurationExtendedPath $storage.lockPath))
    foreach ($directory in @(
            $storage.receiptsRoot, $storage.intentsRoot, $storage.transactionRoot,
            $storage.snapshotRoot, $storage.configRoot
        )) {
        [void](Assert-DysonConfigurationPlainDirectoryChain $directory)
        if (@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop).Count -ne 0) {
            throw 'The created protected configuration storage changed during rollback.'
        }
        [System.IO.Directory]::Delete(
            (ConvertTo-DysonConfigurationExtendedPath $directory), $false
        )
    }
    foreach ($path in @(
            $storage.configurationPath, $storage.configRoot, $storage.transactionRoot,
            $storage.snapshotRoot
        )) {
        if (Test-Path -LiteralPath $path) {
            throw 'The created protected configuration rollback did not restore an absent preimage.'
        }
    }
}

function Assert-DysonDeploymentPlainFile {
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







function Stop-DysonDeploymentControlTaskForBrokerUpgrade {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$TaskName)

    if (-not [bool]$State.present) { return }
    $task = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($task.Count -ne 1 -or [string]$task[0].TaskPath -cne [string]$State.taskPath -or
        (Get-DysonTextSha256 ([string](Export-ScheduledTask -TaskName $TaskName `
            -TaskPath $State.taskPath -ErrorAction Stop))) -cne [string]$State.xmlSha256) {
        throw 'The previous control-plane task changed before broker quiescence.'
    }
    if ([string]$task[0].State -ceq 'Running') {
        Stop-ScheduledTask -InputObject $task[0] -ErrorAction Stop
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $task = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($task.Count -ne 1 -or [string]$task[0].TaskPath -cne [string]$State.taskPath) {
            throw 'The previous control-plane task identity changed during broker quiescence.'
        }
        if ([string]$task[0].State -cne 'Running') { return }
        Start-Sleep -Milliseconds 250
    } while ($timer.Elapsed.TotalSeconds -lt 20)
    throw 'The previous control-plane task did not stop before broker quiescence.'
}

function Wait-DysonDeploymentBrokerWorkersIdle {
    # Do not stop SYSTEM workers: a dispatched read-only status request must
    # finish its receipt publication and history retention naturally. Pending
    # records remain subject to the unchanged strict preimage checks afterward.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $quietSamples = 0
    do {
        $lifecycle = @(Get-DysonLifecycleBrokerStaticWorkerTasks)

        if ($lifecycle.Count -gt 1) {
            throw 'A fixed broker task identity is ambiguous during quiescence.'
        }
        $running = @(@($lifecycle) | Where-Object { [string]$_.State -ceq 'Running' })
        if ($running.Count -eq 0) { $quietSamples += 1 } else { $quietSamples = 0 }
        if ($quietSamples -ge 2) { return }
        Start-Sleep -Milliseconds 500
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw 'The fixed broker workers did not become idle before the deployment deadline.'
}







function Assert-DysonBrokerUpgradeIntent {
    param(
        [Parameter(Mandatory)][ValidateSet('lifecycle')][string]$Kind,
        [Parameter(Mandatory)][bool]$Requested,
        [Parameter(Mandatory)][bool]$UpgradeRequested,
        $State,
        [Parameter(Mandatory)][string]$TargetVersion
    )

    if (-not $Requested) { return }
    if ($null -eq $State) {
        if ($UpgradeRequested) {
            throw "The $Kind broker upgrade switch is invalid for a first installation."
        }
        return
    }
    $crossRelease = [string]$State.activeVersion -cne $TargetVersion
    if ($crossRelease -and -not $UpgradeRequested) {
        throw "A cross-release $Kind broker deployment requires its explicit upgrade switch."
    }
    if (-not $crossRelease -and $UpgradeRequested) {
        throw "The $Kind broker upgrade switch is invalid for a same-release reuse."
    }
}

function Assert-DysonBrokerPreflightStateUnchanged {
    param($Before, $After, [Parameter(Mandatory)][ValidateSet('lifecycle')][string]$Kind)

    if (($null -eq $Before) -ne ($null -eq $After)) {
        throw "The $Kind broker deployment state changed before the deployment lock was acquired."
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
        throw "The $Kind broker deployment state changed before the deployment lock was acquired."
    }
}

function Assert-DysonLifecycleBrokerDeploymentBinding {
    param(
        $State,
        [string]$ProjectRoot,
        [string]$RuntimeBootstrapRoot,
        [string]$ServiceUser,
        [Nullable[int]]$GamePort,
        [Nullable[int]]$DispatchReadyTimeout
    )

    if ($null -eq $State) { return }
    if ([string]::IsNullOrWhiteSpace($ProjectRoot) -or
        [string]::IsNullOrWhiteSpace($RuntimeBootstrapRoot) -or
        [string]::IsNullOrWhiteSpace($ServiceUser) -or
        $null -eq $GamePort -or $null -eq $DispatchReadyTimeout -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.projectRoot) $ProjectRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.runtimeBootstrapRoot) $RuntimeBootstrapRoot) -or
        [string]$State.profile.serviceUser -cne $ServiceUser -or
        [int]$State.profile.gamePort -ne [int]$GamePort -or
        [int]$State.profile.dispatchReadyTimeoutSeconds -ne [int]$DispatchReadyTimeout) {
        throw 'The existing lifecycle broker profile does not match the production environment binding.'
    }
}

















function Test-DysonLifecycleBrokerDeploymentBytesEqual {
    param([Parameter(Mandatory)][byte[]]$Left, [Parameter(Mandatory)][byte[]]$Right)

    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

function Assert-DysonLifecycleBrokerDeploymentExactProperties {
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

function ConvertFrom-DysonLifecycleBrokerDeploymentInstallerOutput {
    param([Parameter(Mandatory)]$Output)

    $lines = @(
        ($Output | Out-String) -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($lines.Count -ne 1) { throw 'The lifecycle broker installer did not return exactly one receipt.' }
    return $lines[0] | ConvertFrom-Json -ErrorAction Stop
}

function Invoke-DysonLifecycleBrokerDeploymentInstaller {
    param(
        [Parameter(Mandatory)][string]$Installer,
        [Parameter(Mandatory)][hashtable]$Arguments,
        [string]$ShadowRoot
    )

    $previousMarker = [Environment]::GetEnvironmentVariable(
        'DYSON_LIFECYCLE_BROKER_SELFTEST', [EnvironmentVariableTarget]::Process
    )
    try {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', '1', [EnvironmentVariableTarget]::Process
            )
        }
        $output = & $Installer @Arguments
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [Environment]::SetEnvironmentVariable(
                'DYSON_LIFECYCLE_BROKER_SELFTEST', $previousMarker, [EnvironmentVariableTarget]::Process
            )
        }
    }
    $receipt = ConvertFrom-DysonLifecycleBrokerDeploymentInstallerOutput $output
    if ($receipt.PSObject.Properties.Name -contains 'error') {
        Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $receipt -Names @('error') `
            -Message 'The lifecycle broker installer returned an unsupported failure envelope.'
        Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $receipt.error -Names @('code') `
            -Message 'The lifecycle broker installer returned an unsupported failure envelope.'
        $code = [string]$receipt.error.code
        if ($code -notmatch '^DYSON_CONTROL_LIFECYCLE_BROKER_[A-Z0-9_]+$') {
            $code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
        }
        throw "Lifecycle broker operation failed: $code."
    }
    return $receipt
}

function Restore-DysonLifecycleBrokerDeploymentFirstInstall {
    param(
        [Parameter(Mandatory)][string]$Installer,
        [Parameter(Mandatory)][hashtable]$InstallArguments,
        [Parameter(Mandatory)][string]$DeploymentDataRoot,
        [string]$ShadowRoot,
        [string]$ExpectedProfileHash
    )

    $profilePath = Assert-DysonDeploymentPlainFile -Path (
        Join-Path ([string]$InstallArguments.BrokerRoot) 'broker-profile.json'
    ) -MaximumBytes 262144 -Message 'The first-install lifecycle broker profile is unavailable.'
    $profileHash = Get-DysonFileSha256 -Path $profilePath
    if ($ExpectedProfileHash -and $profileHash -cne $ExpectedProfileHash) {
        throw 'The first-install lifecycle broker profile changed before compensation.'
    }
    $arguments = @{}
    foreach ($key in $InstallArguments.Keys) { $arguments[$key] = $InstallArguments[$key] }
    [void]$arguments.Remove('UpgradeExisting')
    $arguments['CompensateFirstInstall'] = $true
    # The fixed child reconstructs the candidate from these original trusted
    # bindings and validates its exact profile/task before removing anything.
    # No cleanup path or operation is taken from an unaccepted install receipt.
    $receipt = Invoke-DysonLifecycleBrokerDeploymentInstaller -Installer $Installer `
        -Arguments $arguments -ShadowRoot $ShadowRoot
    Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $receipt -Names @(
        'protocol', 'schemaVersion', 'operation', 'brokerRoot', 'removedProfileHash',
        'workerTaskName', 'workerTaskPath', 'profileRemoved', 'taskRemoved',
        'preservedRequestCount', 'preservedReceiptCount', 'backend', 'compensatedAt'
    ) -Message 'The lifecycle broker first-install compensation receipt is invalid.'
    if ([string]$receipt.protocol -cne 'DYSON_CONTROL_LIFECYCLE_BROKER_COMPENSATION_RECEIPT_V1' -or
        [int]$receipt.schemaVersion -ne 1 -or [string]$receipt.operation -cne 'compensated-first-install' -or
        [string]$receipt.removedProfileHash -cne $profileHash -or
        -not (Test-DysonDeploymentSamePath ([string]$receipt.brokerRoot) ([string]$InstallArguments.BrokerRoot)) -or
        [string]$receipt.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
        [string]$receipt.workerTaskPath -cne '\DysonControl\' -or
        $receipt.profileRemoved -isnot [bool] -or -not [bool]$receipt.profileRemoved -or
        $receipt.taskRemoved -isnot [bool] -or -not [bool]$receipt.taskRemoved) {
        throw 'The lifecycle broker first-install compensation receipt is invalid.'
    }
    Assert-DysonLifecycleBrokerDeploymentPreimageRestored -DeploymentDataRoot $DeploymentDataRoot `
        -State $null -ShadowRoot $ShadowRoot
}

function Get-DysonLifecycleBrokerDeploymentPreimage {
    param(
        [Parameter(Mandatory)][string]$DeploymentDataRoot,
        $ActiveRelease,
        [string]$ShadowRoot,
        [switch]$AllowPendingStatusRequests
    )

    $dataRoot = Join-Path $DeploymentDataRoot 'data'
    $brokerRoot = Join-Path $dataRoot 'lifecycle-broker'
    $profilePath = Join-Path $brokerRoot 'broker-profile.json'
    $shadowTaskPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-task.json' } else { $null }
    $shadowProfileAclPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-profile.sddl' } else { $null }
    $profilePresent = Test-Path -LiteralPath $profilePath -PathType Leaf
    if (-not $profilePresent) {
        $taskPresent = if ($ShadowRoot) {
            (Test-Path -LiteralPath $shadowTaskPath) -or (Test-Path -LiteralPath $shadowProfileAclPath)
        }
        else { @(Get-DysonLifecycleBrokerStaticWorkerTasks).Count -ne 0 }
        if ((Test-Path -LiteralPath $profilePath) -or $taskPresent) {
            throw 'A lifecycle broker task or ACL exists without its fixed profile.'
        }
        return $null
    }
    if ($null -eq $ActiveRelease) {
        throw 'A lifecycle broker profile exists without an active immutable release.'
    }

    $profileFile = Assert-DysonDeploymentPlainFile -Path $profilePath -MaximumBytes 262144 `
        -Message 'The existing lifecycle broker profile is unavailable, redirected, empty, or too large.'
    $windowsRoot = Assert-DysonPlainDirectory -Path (Join-Path ([string]$ActiveRelease.releaseRoot) 'scripts\windows')
    $brokerScriptRoot = Assert-DysonPlainDirectory -Path (Join-Path $windowsRoot 'lifecycle-broker')
    $common = Assert-DysonDeploymentPlainFile -Path (Join-Path $brokerScriptRoot 'DysonLifecycleBroker.Common.ps1') `
        -MaximumBytes 1048576 -Message 'The active lifecycle broker common helper is unavailable or redirected.'
    $taskAclHelper = Assert-DysonDeploymentPlainFile -Path (Join-Path $brokerScriptRoot 'DysonLifecycleBroker.TaskAcl.ps1') `
        -MaximumBytes 262144 -Message 'The active lifecycle broker task ACL helper is unavailable or redirected.'
    $installer = Assert-DysonDeploymentPlainFile -Path (Join-Path $brokerScriptRoot 'Install-DysonLifecycleBrokerTask.ps1') `
        -MaximumBytes 1048576 -Message 'The active lifecycle broker installer is unavailable or redirected.'
    $null = . $common
    $null = . $taskAclHelper
    $profile = Read-DysonLifecycleBrokerProfile -ProfileFile $profileFile
    $activeInstallRoot = [IO.Path]::GetDirectoryName(
        [IO.Path]::GetDirectoryName([string]$ActiveRelease.releaseRoot)
    )
    $expectedBootstrap = Join-Path $activeInstallRoot 'bootstrap'
    if (-not (Test-DysonDeploymentSamePath ([string]$profile.brokerRoot) $brokerRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$profile.brokerScriptRoot) $brokerScriptRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$profile.installedWindowsRoot) $windowsRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$profile.runtimeBootstrapRoot) $expectedBootstrap) -or
        -not (Test-DysonDeploymentSamePath ([string]$profile.dataRoot) $dataRoot) -or
        [string]$profile.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
        [string]$profile.workerTaskPath -cne '\DysonControl\' -or
        [string]$profile.serverTask.name -cne 'Dyson-Nebula-Server' -or
        [string]$profile.serverTask.path -cne '\' -or
        [string]$profile.stopTask.name -cne 'Dyson-Nebula-Stop' -or
        [string]$profile.stopTask.path -cne '\') {
        throw 'The existing lifecycle broker profile is not bound to the active immutable release and fixed runtime tasks.'
    }
    [void](Assert-DysonLifecycleBrokerDependencies -Profile $profile)
    $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $brokerRoot
    [void](Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage `
        -AllowPendingStatusRequests:$AllowPendingStatusRequests)

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
        $taskFile = Assert-DysonDeploymentPlainFile -Path $shadowTaskPath -MaximumBytes 262144 `
            -Message 'The lifecycle broker shadow task preimage is unavailable or redirected.'
        $taskRecord = [IO.File]::ReadAllText($taskFile, [Text.UTF8Encoding]::new($false, $true)) |
            ConvertFrom-Json -ErrorAction Stop
        Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $taskRecord `
            -Names @('protocol', 'schemaVersion', 'descriptor', 'xml', 'enabled', 'sddl') `
            -Message 'The lifecycle broker shadow task preimage has an unsupported shape.'
        if ([string]$taskRecord.protocol -cne 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_TASK_V1' -or
            [int]$taskRecord.schemaVersion -ne 1 -or $taskRecord.enabled -isnot [bool] -or
            -not [bool]$taskRecord.enabled -or [string]::IsNullOrWhiteSpace([string]$taskRecord.xml)) {
            throw 'The lifecycle broker shadow task preimage is not the enabled fixed task.'
        }
        [void](Assert-DysonLifecycleBrokerTaskAclIntent ([string]$taskRecord.sddl))
        $taskXml = [string]$taskRecord.xml
        $taskEnabled = [bool]$taskRecord.enabled
        $taskSddl = [string]$taskRecord.sddl
        $taskBytes = [IO.File]::ReadAllBytes($taskFile)
        $profileAclFile = Assert-DysonDeploymentPlainFile -Path $shadowProfileAclPath -MaximumBytes 8192 `
            -Message 'The lifecycle broker shadow profile ACL preimage is unavailable or redirected.'
        $profileAclBytes = [IO.File]::ReadAllBytes($profileAclFile)
        $profileSddl = [IO.File]::ReadAllText($profileAclFile, [Text.UTF8Encoding]::new($false, $true)).Trim()
    }
    else {
        $tasks = @(Get-DysonLifecycleBrokerStaticWorkerTasks)
        if ($tasks.Count -ne 1) { throw 'The fixed lifecycle broker task preimage is missing or ambiguous.' }
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
            $plain = Assert-DysonPlainDirectory -Path $path
            [pscustomobject][ordered]@{
                path = $plain
                sddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $plain -ErrorAction Stop).Sddl
            }
        }
    )
    return [pscustomobject][ordered]@{
        activeVersion = [string]$ActiveRelease.pointer.version
        activeReleaseRoot = [string]$ActiveRelease.releaseRoot
        windowsRoot = $windowsRoot
        brokerScriptRoot = $brokerScriptRoot
        installer = $installer
        taskAclHelper = $taskAclHelper
        brokerRoot = $brokerRoot
        profilePath = $profileFile
        profile = $profile
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

function Set-DysonLifecycleBrokerDeploymentFileBytesAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [int64]$MaximumBytes = 262144
    )

    $destination = Assert-DysonDeploymentPlainFile -Path $Path -MaximumBytes $MaximumBytes `
        -Message 'A restored lifecycle broker state file is unavailable or redirected.'
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

function Restore-DysonLifecycleBrokerDeploymentPreimage {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)

    foreach ($directoryAcl in @($State.directoryAcls)) {
        $path = Assert-DysonPlainDirectory -Path ([string]$directoryAcl.path)
        Restore-DysonDeploymentDirectorySecurityPreimage -Path $path -Sddl ([string]$directoryAcl.sddl)
    }
    Set-DysonLifecycleBrokerDeploymentFileBytesAtomic `
        -Path ([string]$State.profilePath) -Bytes ([byte[]]$State.profileBytes)
    # Shadow task/profile ACL intent files model scheduler policy, not the ACL
    # of this real profile file. Restore the actual file descriptor in both modes.
    Restore-DysonDeploymentFileSecurityPreimage -Path ([string]$State.profilePath) `
        -Sddl ([string]$State.profileFileSddl)
    if ($ShadowRoot) {
        Set-DysonLifecycleBrokerDeploymentFileBytesAtomic -Path ([string]$State.profileAclPath) `
            -Bytes ([byte[]]$State.profileAclBytes) -MaximumBytes 8192
        Set-DysonLifecycleBrokerDeploymentFileBytesAtomic -Path ([string]$State.taskPath) `
            -Bytes ([byte[]]$State.taskBytes)
    }
    else {
        $null = . ([string]$State.taskAclHelper)
        Register-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\' `
            -Xml ([string]$State.taskXml) -Force -ErrorAction Stop | Out-Null
        Restore-DysonLifecycleBrokerTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\' -Sddl ([string]$State.taskSddl)
    }
}

function Assert-DysonLifecycleBrokerDeploymentPreimageRestored {
    param(
        [Parameter(Mandatory)][string]$DeploymentDataRoot,
        $State,
        [string]$ShadowRoot
    )

    $profilePath = Join-Path $DeploymentDataRoot 'data\lifecycle-broker\broker-profile.json'
    $shadowTaskPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-task.json' } else { $null }
    $shadowAclPath = if ($ShadowRoot) { Join-Path $ShadowRoot 'broker-profile.sddl' } else { $null }
    if ($null -eq $State) {
        $taskResidual = if ($ShadowRoot) {
            (Test-Path -LiteralPath $shadowTaskPath) -or (Test-Path -LiteralPath $shadowAclPath)
        }
        else { @(Get-DysonLifecycleBrokerStaticWorkerTasks).Count -ne 0 }
        if ((Test-Path -LiteralPath $profilePath) -or $taskResidual) {
            throw 'A first-install lifecycle broker task/profile survived compensation.'
        }
        return
    }
    if (-not (Test-DysonLifecycleBrokerDeploymentBytesEqual `
            -Left ([IO.File]::ReadAllBytes([string]$State.profilePath)) `
            -Right ([byte[]]$State.profileBytes))) {
        throw 'The lifecycle broker profile did not return to its byte-exact preimage.'
    }
    if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.profilePath) -ErrorAction Stop).Sddl -cne
        [string]$State.profileFileSddl) {
        throw 'The lifecycle broker profile file did not return to its exact ACL preimage.'
    }
    foreach ($directoryAcl in @($State.directoryAcls)) {
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$directoryAcl.path) -ErrorAction Stop).Sddl -cne
            [string]$directoryAcl.sddl) {
            throw 'A lifecycle broker storage directory did not return to its ACL preimage.'
        }
    }
    if ($ShadowRoot) {
        if (-not (Test-DysonLifecycleBrokerDeploymentBytesEqual `
                -Left ([IO.File]::ReadAllBytes([string]$State.profileAclPath)) `
                -Right ([byte[]]$State.profileAclBytes)) -or
            -not (Test-DysonLifecycleBrokerDeploymentBytesEqual `
                -Left ([IO.File]::ReadAllBytes([string]$State.taskPath)) `
                -Right ([byte[]]$State.taskBytes))) {
            throw 'The lifecycle broker shadow profile ACL or task XML/enabled/DACL preimage was not restored.'
        }
    }
    else {
        $null = . ([string]$State.taskAclHelper)
        $tasks = @(Get-DysonLifecycleBrokerStaticWorkerTasks)
        $xml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Lifecycle-Broker' `
            -TaskPath '\DysonControl\' -ErrorAction Stop)
        $taskSddl = Get-DysonLifecycleBrokerTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Lifecycle-Broker' -TaskPath '\DysonControl\'
        if ($tasks.Count -ne 1 -or [bool]$tasks[0].Settings.Enabled -ne [bool]$State.taskEnabled -or
            $xml -cne [string]$State.taskXml -or $taskSddl -cne [string]$State.taskSddl -or
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath ([string]$State.profilePath) -ErrorAction Stop).Sddl -cne
                [string]$State.profileSddl) {
            throw 'The lifecycle broker profile ACL or task XML/enabled/DACL preimage was not restored.'
        }
    }
}

function Assert-DysonLifecycleBrokerInstallReceipt {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][string]$ExpectedBrokerRoot,
        [Parameter(Mandatory)][string]$ExpectedProfileFile,
        [Parameter(Mandatory)][string]$ExpectedBackend
    )

    $message = 'The lifecycle broker task installer returned an unsupported receipt.'
    $expectedReceiptProperties = @(
        'protocol', 'schemaVersion', 'operation', 'reused', 'upgraded', 'brokerRoot', 'profileFile',
        'profileHash', 'profileCreatedAt', 'workerTaskName', 'workerTaskPath', 'serverTaskDescriptorHash',
        'stopTaskDescriptorHash', 'backend', 'aclIntent', 'taskAclIntent', 'installedAt'
    )
    if ($null -eq $Receipt) { throw ($message + ' Top-level fields mismatch: receipt is null.') }
    $actualReceiptProperties = @($Receipt.PSObject.Properties.Name)
    $missingReceiptProperties = @(
        $expectedReceiptProperties | Where-Object { $actualReceiptProperties -cnotcontains $_ }
    )
    $extraReceiptProperties = @(
        $actualReceiptProperties | Where-Object { $expectedReceiptProperties -cnotcontains $_ }
    )
    if ($missingReceiptProperties.Count -ne 0 -or $extraReceiptProperties.Count -ne 0) {
        $missingLabel = if ($missingReceiptProperties.Count -eq 0) {
            '<none>'
        }
        else { [string]::Join(',', @($missingReceiptProperties | Sort-Object)) }
        $extraLabel = if ($extraReceiptProperties.Count -eq 0) {
            '<none>'
        }
        else { [string]::Join(',', @($extraReceiptProperties | Sort-Object)) }
        throw ($message + " Top-level fields mismatch: missing=$missingLabel; extra=$extraLabel.")
    }
    Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $Receipt `
        -Names $expectedReceiptProperties -Message ($message + ' Top-level fields mismatch.')
    $profileCreatedAt = [datetimeoffset]::MinValue
    $installedAt = [datetimeoffset]::MinValue
    $contractFailures = [Collections.Generic.List[string]]::new()
    if ([string]$Receipt.protocol -cne 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_RECEIPT_V1') { $contractFailures.Add('protocol') }
    if ([int]$Receipt.schemaVersion -ne 1) { $contractFailures.Add('schemaVersion') }
    if ([string]$Receipt.operation -cnotin @('installed', 'reused', 'upgraded')) { $contractFailures.Add('operation') }
    if ($Receipt.reused -isnot [bool] -or $Receipt.upgraded -isnot [bool]) { $contractFailures.Add('operationFlagsType') }
    elseif (([string]$Receipt.operation -ceq 'installed' -and ([bool]$Receipt.reused -or [bool]$Receipt.upgraded)) -or
        ([string]$Receipt.operation -ceq 'reused' -and (-not [bool]$Receipt.reused -or [bool]$Receipt.upgraded)) -or
        ([string]$Receipt.operation -ceq 'upgraded' -and ([bool]$Receipt.reused -or -not [bool]$Receipt.upgraded))) {
        $contractFailures.Add('operationFlags')
    }
    if (-not (Test-DysonDeploymentSamePath ([string]$Receipt.brokerRoot) $ExpectedBrokerRoot)) { $contractFailures.Add('brokerRoot') }
    if (-not (Test-DysonDeploymentSamePath ([string]$Receipt.profileFile) $ExpectedProfileFile)) { $contractFailures.Add('profileFile') }
    if ([string]$Receipt.profileHash -cnotmatch '^[0-9a-f]{64}$') { $contractFailures.Add('profileHash') }
    if ([string]$Receipt.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker') { $contractFailures.Add('workerTaskName') }
    if ([string]$Receipt.workerTaskPath -cne '\DysonControl\') { $contractFailures.Add('workerTaskPath') }
    if ([string]$Receipt.serverTaskDescriptorHash -cnotmatch '^[0-9a-f]{64}$') { $contractFailures.Add('serverTaskDescriptorHash') }
    if ([string]$Receipt.stopTaskDescriptorHash -cnotmatch '^[0-9a-f]{64}$') { $contractFailures.Add('stopTaskDescriptorHash') }
    if ([string]$Receipt.backend -cne $ExpectedBackend) { $contractFailures.Add('backend') }
    if (-not [datetimeoffset]::TryParseExact([string]$Receipt.profileCreatedAt, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$profileCreatedAt)) { $contractFailures.Add('profileCreatedAt') }
    if (-not [datetimeoffset]::TryParseExact([string]$Receipt.installedAt, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$installedAt)) { $contractFailures.Add('installedAt') }
    if ($contractFailures.Count -ne 0) {
        throw ($message + ' Contract mismatch: ' + [string]::Join(',', @($contractFailures)) + '.')
    }
    Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $Receipt.aclIntent `
        -Names @('root', 'requests', 'intents', 'receipts', 'profile', 'task') `
        -Message ($message + ' ACL intent fields mismatch.')
    Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $Receipt.taskAclIntent `
        -Names @('sddl', 'protected', 'system', 'administrators', 'localService', 'localServiceWrite', 'localServiceDelete') `
        -Message ($message + ' Task ACL intent fields mismatch.')
    $expectedAclIntent = [ordered]@{
        root = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', 'S-1-5-19:ReadAndExecute')
        requests = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl',
            'S-1-5-19:CreateFiles+AppendData+ListDirectory+ReadAttributes+Synchronize',
            'CREATOR OWNER:Read+Delete (files only)')
        intents = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl')
        receipts = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', 'S-1-5-19:ReadAndExecute')
        profile = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', 'S-1-5-19:Read')
        task = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', 'S-1-5-19:Read+Execute')
    }
    foreach ($aclName in $expectedAclIntent.Keys) {
        $actualAclEntries = @($Receipt.aclIntent.PSObject.Properties[[string]$aclName].Value)
        $expectedAclEntries = @($expectedAclIntent[$aclName])
        if ($actualAclEntries.Count -ne $expectedAclEntries.Count) {
            throw ($message + " ACL intent count mismatch: $aclName.")
        }
        for ($index = 0; $index -lt $expectedAclEntries.Count; $index += 1) {
            if ($actualAclEntries[$index] -isnot [string] -or
                [string]$actualAclEntries[$index] -cne [string]$expectedAclEntries[$index]) {
                throw ($message + " ACL intent mismatch: $aclName[$index].")
            }
        }
    }
    if ($Receipt.taskAclIntent.protected -isnot [bool] -or -not [bool]$Receipt.taskAclIntent.protected -or
        [string]$Receipt.taskAclIntent.system -cne 'full' -or
        [string]$Receipt.taskAclIntent.administrators -cne 'full' -or
        [string]$Receipt.taskAclIntent.localService -cne 'read-execute' -or
        $Receipt.taskAclIntent.localServiceWrite -isnot [bool] -or [bool]$Receipt.taskAclIntent.localServiceWrite -or
        $Receipt.taskAclIntent.localServiceDelete -isnot [bool] -or [bool]$Receipt.taskAclIntent.localServiceDelete -or
        [string]$Receipt.taskAclIntent.sddl -cne 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)') {
        throw ($message + ' Task ACL intent mismatch.')
    }
    $actualHash = Get-DysonFileSha256 -Path $ExpectedProfileFile
    if ($actualHash -cne [string]$Receipt.profileHash) { throw ($message + ' Profile hash mismatch.') }
    $receiptProfile = [IO.File]::ReadAllText(
        $ExpectedProfileFile, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json -ErrorAction Stop
    if ([string]$receiptProfile.createdAt -cne [string]$Receipt.profileCreatedAt -or
        [string]$receiptProfile.serverTask.descriptorHash -cne [string]$Receipt.serverTaskDescriptorHash -or
        [string]$receiptProfile.stopTask.descriptorHash -cne [string]$Receipt.stopTaskDescriptorHash -or
        $installedAt -lt $profileCreatedAt) {
        throw ($message + ' Profile binding mismatch.')
    }
    return $Receipt
}

function Read-DysonDeploymentEnvironmentFile {
    param([Parameter(Mandatory)][string]$Path)

    $environmentPath = Assert-DysonDeploymentPlainFile -Path $Path -MaximumBytes 65536 `
        -Message 'The production environment file is unavailable, redirected, empty, or too large.'
    $configured = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($environmentPath, [System.Text.Encoding]::UTF8)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw 'The production environment file contains an invalid line.' }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1)
        if ($name -ne 'NODE_ENV' -and $name -notmatch '^DYSON_[A-Z0-9_]{1,96}$') {
            throw "Unsupported environment variable in production configuration: $name"
        }
        if ($configured.ContainsKey($name)) { throw "Duplicate environment variable in production configuration: $name" }
        $configured[$name] = $value
    }
    return $configured
}



function Assert-DysonLifecycleBrokerEnvironment {
    param(
        [Parameter(Mandatory)][hashtable]$Configured,
        [Parameter(Mandatory)][string]$ExpectedProjectRoot,
        [Parameter(Mandatory)][string]$ExpectedDataDirectory,
        [Parameter(Mandatory)][string]$ExpectedProfileFile,
        [Parameter(Mandatory)][string]$ExpectedRuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$ExpectedServiceUser,
        [Parameter(Mandatory)][int]$ExpectedGamePort
    )

    foreach ($required in @(
        'DYSON_PROVIDER', 'DYSON_LIFECYCLE_ENABLED', 'DYSON_PROJECT_ROOT', 'DYSON_DATA_DIR',
        'DYSON_LIFECYCLE_BROKER_PROFILE_FILE', 'DYSON_RUNTIME_BOOTSTRAP_ROOT',
        'DYSON_RUNTIME_SERVICE_USER', 'DYSON_GAME_PORT', 'DYSON_SERVER_TASK', 'DYSON_STOP_TASK'
    )) {
        if (-not $Configured.ContainsKey($required) -or
            [string]::IsNullOrWhiteSpace([string]$Configured[$required])) {
            throw "Lifecycle broker installation requires an explicit $required value."
        }
    }
    if ([string]$Configured['DYSON_PROVIDER'] -cne 'windows' -or
        [string]$Configured['DYSON_LIFECYCLE_ENABLED'] -cne 'true') {
        throw 'Lifecycle broker installation requires the Windows provider and lifecycle=true gates.'
    }
    foreach ($binding in @(
        @('DYSON_PROJECT_ROOT', $ExpectedProjectRoot),
        @('DYSON_DATA_DIR', $ExpectedDataDirectory),
        @('DYSON_LIFECYCLE_BROKER_PROFILE_FILE', $ExpectedProfileFile),
        @('DYSON_RUNTIME_BOOTSTRAP_ROOT', $ExpectedRuntimeBootstrapRoot)
    )) {
        if (-not (Test-DysonDeploymentSamePath `
                -Left ([string]$Configured[[string]$binding[0]]) -Right ([string]$binding[1]))) {
            throw "Lifecycle broker installation configuration does not match $($binding[0])."
        }
    }
    if ([string]$Configured['DYSON_RUNTIME_SERVICE_USER'] -cne $ExpectedServiceUser -or
        [string]$Configured['DYSON_GAME_PORT'] -cnotmatch '^[1-9][0-9]{0,4}$' -or
        [int]$Configured['DYSON_GAME_PORT'] -ne $ExpectedGamePort -or
        [string]$Configured['DYSON_SERVER_TASK'] -cne 'Dyson-Nebula-Server' -or
        [string]$Configured['DYSON_STOP_TASK'] -cne 'Dyson-Nebula-Stop') {
        throw 'Lifecycle broker installation configuration does not match the service user, game port, or fixed runtime tasks.'
    }
}

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
# Installation must use a layout that its rollback and uninstall can also
# handle. Reject unsupported roots before artifact reads or filesystem writes.
[void](Assert-DysonDeploymentDestructiveRootLayout -InstallRoot $installFull -DataRoot $dataFull)
[void](Assert-DysonRetiredPrivilegedRuntimeAbsent)
$sourceFull = Assert-DysonPlainDirectory -Path $SourcePath
Assert-DysonVersion -Version $Version
Assert-DysonRelativePath -Path $EntryPointRelativePath -Name 'EntryPointRelativePath'
$sourceArtifactVerification = Test-DysonSourceArtifact -SourcePath $sourceFull -ExpectedVersion $Version `
    -ExpectedEntryPoint $EntryPointRelativePath -ExpectedPayloadSha256 $ExpectedArtifactPayloadSha256
$configurationFull = Assert-DysonDeploymentPlainFile -Path $ConfigurationSource -MaximumBytes 65536 `
    -Message 'ConfigurationSource must be a plain, non-empty file no larger than 65536 bytes.'
$prospectiveConfigurationPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
if ($StartAfterInstall -and -not $RegisterStartupTask) { throw 'StartAfterInstall requires RegisterStartupTask.' }
if ($StartAfterInstall -and -not $ReadinessUri) { throw 'StartAfterInstall requires a loopback ReadinessUri.' }
if ($ReadinessUri -and ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
    $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1'))) {
    throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
}
if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}
$configurationApplyModuleRoot = Join-Path $PSScriptRoot '..\configuration'
if (-not [string]::IsNullOrWhiteSpace($SelfTestConfigurationShadowRoot)) {
    if (-not $SelfTestSkipAdministratorCheck) {
        throw 'The configuration shadow module is reserved for the isolated deployment self-test.'
    }
    $configurationApplyModuleRoot = Assert-DysonPlainDirectory -Path $SelfTestConfigurationShadowRoot
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $requiredPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar + `
        'dyson-control-deployment-selftest-'
    if (-not $configurationApplyModuleRoot.TrimEnd('\', '/').StartsWith(
            $requiredPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or -not (Test-Path -LiteralPath (Join-Path $configurationApplyModuleRoot `
            '.dyson-configuration-selftest') -PathType Leaf)) {
        throw 'The configuration shadow module is outside the isolated deployment self-test root.'
    }
    [void](Resolve-DysonDeploymentConfigurationModuleRoot -ModuleRoot $configurationApplyModuleRoot)
}
elseif ($SelfTestSkipAdministratorCheck) {
    throw 'The isolated deployment self-test requires a configuration shadow module.'
}
$prospectiveReleaseRoot = Join-Path (Join-Path $installFull 'releases') $Version
$prospectiveScriptRoot = Join-Path $prospectiveReleaseRoot 'scripts\windows'
$prospectiveBootstrapRoot = Join-Path $installFull 'bootstrap'
$preflightActiveRelease = $null
$existingActivePointerPath = Join-Path $dataFull 'state\active-release.json'
if (Test-Path -LiteralPath $existingActivePointerPath -PathType Leaf) {
    $preflightActiveRelease = Get-DysonActiveRelease `
        -InstallRoot $installFull -DataRoot $dataFull
    if ($null -eq $preflightActiveRelease) {
        throw 'An existing protected configuration pointer has no verifiable active release.'
    }
}
$existingConfigurationScriptRoot = if ($preflightActiveRelease) {
    Join-Path ([string]$preflightActiveRelease.releaseRoot) 'scripts\windows'
}
else { $prospectiveScriptRoot }
$existingConfigurationBootstrapRoot = $prospectiveBootstrapRoot
$existingConfigurationDeploymentVersion = if ($preflightActiveRelease) {
    [string]$preflightActiveRelease.pointer.version
}
else { $Version }
$configurationPreflight = Get-DysonDeploymentConfigurationPreflight `
    -ConfigurationSource $configurationFull -DataRoot $dataFull `
    -ScriptRoot $prospectiveScriptRoot -RuntimeBootstrapRoot $prospectiveBootstrapRoot `
    -DeploymentVersion $Version -ServiceAccount $ServiceAccount `
    -ExistingScriptRoot $existingConfigurationScriptRoot `
    -ExistingRuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
    -ExistingDeploymentVersion $existingConfigurationDeploymentVersion `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot `
    -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
if (-not (Test-DysonDeploymentSamePath -Left ([string]$configurationPreflight.configurationPath) `
        -Right $prospectiveConfigurationPath)) {
    throw 'The protected configuration target escaped its fixed DataRoot location.'
}
$qualifiedClientSourceEnvironment = Read-DysonDeploymentEnvironmentFile -Path $configurationFull
try {
    $qualifiedClientStoragePlan = Get-DysonQualifiedClientStoragePlan `
        -Configured $qualifiedClientSourceEnvironment -DataRoot $dataFull
    $qualifiedClientStoragePreflight = Get-DysonQualifiedClientStoragePreimage `
        -Plan $qualifiedClientStoragePlan -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
}
finally { $qualifiedClientSourceEnvironment.Clear() }
$nodeProtection = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
    -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -InstallRoot $installFull -DataRoot $dataFull
$runtimeFull = [string]$nodeProtection.runtimeRoot
$nodePath = [string]$nodeProtection.nodeExecutable

$lifecycleBrokerParameterNames = @(
    'UpgradeLifecycleBrokerExisting', 'ProjectRoot', 'RuntimeBootstrapRoot', 'ServiceUser',
    'GamePort', 'DispatchReadyTimeout', 'SelfTestShadow'
)
if (-not $InstallLifecycleBrokerTask) {
    foreach ($parameterName in $lifecycleBrokerParameterNames) {
        if ($PSBoundParameters.ContainsKey($parameterName)) {
            throw 'Lifecycle broker installation parameters require -InstallLifecycleBrokerTask.'
        }
    }
}

$lifecycleProfileCandidate = Join-Path $dataFull 'data\lifecycle-broker\broker-profile.json'
if ((Test-Path -LiteralPath $lifecycleProfileCandidate) -and -not $InstallLifecycleBrokerTask) {
    throw 'An installed lifecycle broker requires explicit lifecycle broker handling for a control-plane release change.'
}

$lifecycleProjectFull = $null
$lifecycleRuntimeBootstrapFull = $null
$lifecycleBrokerShadowFull = $null
if ($InstallLifecycleBrokerTask) {
    if (-not $configurationFull) {
        throw 'Lifecycle broker installation requires an explicit ConfigurationSource.'
    }
    if (-not $RegisterStartupTask -or -not $StartAfterInstall -or -not $ReadinessUri) {
        throw 'Lifecycle broker installation requires a registered control task, startup, and loopback readiness validation.'
    }
    foreach ($requiredParameter in @(
        @('ProjectRoot', $ProjectRoot),
        @('RuntimeBootstrapRoot', $RuntimeBootstrapRoot),
        @('ServiceUser', $ServiceUser)
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$requiredParameter[1])) {
            throw "Lifecycle broker installation requires an explicit $($requiredParameter[0])."
        }
    }
    if ($null -eq $GamePort -or [int]$GamePort -lt 1 -or [int]$GamePort -gt 65535) {
        throw 'Lifecycle broker installation requires an explicit GamePort from 1 through 65535.'
    }
    if ($null -eq $DispatchReadyTimeout -or [int]$DispatchReadyTimeout -lt 5 -or
        [int]$DispatchReadyTimeout -gt 60) {
        throw 'Lifecycle broker installation requires an explicit DispatchReadyTimeout from 5 through 60 seconds.'
    }
    if ($ServiceUser -notmatch '^[^"\r\n]{1,128}$' -or $ServiceUser.Trim() -cne $ServiceUser) {
        throw 'ServiceUser is invalid.'
    }
    $lifecycleProjectFull = Assert-DysonPlainDirectory -Path $ProjectRoot
    $lifecycleRuntimeBootstrapFull = Get-DysonFullPath -Path $RuntimeBootstrapRoot
    $expectedRuntimeBootstrapRoot = Join-Path $installFull 'bootstrap'
    if (-not (Test-DysonDeploymentSamePath $lifecycleRuntimeBootstrapFull $expectedRuntimeBootstrapRoot)) {
        throw 'RuntimeBootstrapRoot must be the stable bootstrap directory under InstallRoot.'
    }
    if (Test-Path -LiteralPath $lifecycleRuntimeBootstrapFull) {
        [void](Assert-DysonPlainDirectory -Path $lifecycleRuntimeBootstrapFull)
    }
    $expectedLifecycleDataRoot = Join-Path $dataFull 'data'
    $expectedLifecycleProfile = Join-Path $expectedLifecycleDataRoot 'lifecycle-broker\broker-profile.json'
    $sourceEnvironment = Read-DysonDeploymentEnvironmentFile -Path $configurationFull
    $lifecycleEnvironmentArguments = @{
        ExpectedProjectRoot = $lifecycleProjectFull
        ExpectedDataDirectory = $expectedLifecycleDataRoot
        ExpectedProfileFile = $expectedLifecycleProfile
        ExpectedRuntimeBootstrapRoot = $lifecycleRuntimeBootstrapFull
        ExpectedServiceUser = $ServiceUser
        ExpectedGamePort = [int]$GamePort
    }
    Assert-DysonLifecycleBrokerEnvironment -Configured $sourceEnvironment @lifecycleEnvironmentArguments
    if ((Test-Path -LiteralPath $prospectiveConfigurationPath -PathType Leaf) -and
        (Test-Path -LiteralPath $expectedLifecycleProfile -PathType Leaf)) {
        $installedEnvironment = Read-DysonDeploymentEnvironmentFile -Path $prospectiveConfigurationPath
        Assert-DysonLifecycleBrokerEnvironment -Configured $installedEnvironment @lifecycleEnvironmentArguments
    }
    if ($SelfTestShadow) {
        if (-not $SelfTestSkipAdministratorCheck) {
            throw 'The lifecycle broker shadow scheduler is reserved for the isolated deployment self-test.'
        }
        $lifecycleBrokerShadowFull = Assert-DysonPlainDirectory -Path $SelfTestShadow
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
    elseif ($SelfTestSkipAdministratorCheck) {
        throw 'The isolated lifecycle broker deployment self-test requires a shadow scheduler root.'
    }
}











$preflightActiveRelease = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
$lifecycleBrokerPreflightState = Get-DysonLifecycleBrokerDeploymentPreimage `
    -DeploymentDataRoot $dataFull -ActiveRelease $preflightActiveRelease `
    -ShadowRoot $lifecycleBrokerShadowFull `
    -AllowPendingStatusRequests:($RegisterStartupTask -and $InstallLifecycleBrokerTask -and $UpgradeLifecycleBrokerExisting)
if ($null -ne $lifecycleBrokerPreflightState -and -not $InstallLifecycleBrokerTask) {
    throw 'An installed lifecycle broker requires explicit lifecycle broker handling for a control-plane release change.'
}
Assert-DysonBrokerUpgradeIntent -Kind lifecycle -Requested ([bool]$InstallLifecycleBrokerTask) `
    -UpgradeRequested ([bool]$UpgradeLifecycleBrokerExisting) `
    -State $lifecycleBrokerPreflightState -TargetVersion $Version
Assert-DysonLifecycleBrokerDeploymentBinding -State $lifecycleBrokerPreflightState `
    -ProjectRoot $lifecycleProjectFull -RuntimeBootstrapRoot $lifecycleRuntimeBootstrapFull `
    -ServiceUser $ServiceUser -GamePort $GamePort -DispatchReadyTimeout $DispatchReadyTimeout






if (-not $PSCmdlet.ShouldProcess("$installFull; $dataFull", "install and activate Dyson Control $Version")) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        version = $Version
        installRoot = $installFull
        dataRoot = $dataFull
        runtimeRootIdentity = [string]$nodeProtection.runtimeRootIdentity
        nodeExecutableSha256 = [string]$nodeProtection.nodeExecutableSha256
        nodeRuntimeProtected = $true
        sourceValidated = $true
        artifactPayloadSha256 = [string]$sourceArtifactVerification.payloadSha256
        artifactProvenanceBound = [bool]$sourceArtifactVerification.provenancePayloadBound
        sourceArtifactScriptsExecuted = $false
        configurationSourceSha256 = [string]$configurationPreflight.sourceSha256
        configurationLength = [int64]$configurationPreflight.sourceLength
        configurationNamesSha256 = [string]$configurationPreflight.namesSha256
        configurationBindingsSha256 = [string]$configurationPreflight.bindingsSha256
        configurationContractSha256 = [string]$configurationPreflight.contractSha256
        configurationIdenticalReuse = [bool](
            $null -ne $configurationPreflight.existing -and
            [string]$configurationPreflight.existing.configurationSha256 -ceq
                [string]$configurationPreflight.sourceSha256 -and
            [int64]$configurationPreflight.existing.configurationLength -eq
                [int64]$configurationPreflight.sourceLength
        )
        configurationReplacementSupported = $true
        qualifiedClientStorageConfigured = [bool]$qualifiedClientStoragePlan.configured
        qualifiedClientProfileEnabled = [bool]$qualifiedClientStoragePlan.enabled
        qualifiedClientStorageLayoutSha256 = [string]$qualifiedClientStoragePlan.layoutSha256
        qualifiedClientStorageDirectoryCount = @($qualifiedClientStoragePlan.entries).Count
        qualifiedClientStoragePreimageValidated = $true
        configurationReplacementRequired = [bool](
            $null -ne $configurationPreflight.existing -and
            ([string]$configurationPreflight.existing.configurationSha256 -cne
                [string]$configurationPreflight.sourceSha256 -or
            [int64]$configurationPreflight.existing.configurationLength -ne
                [int64]$configurationPreflight.sourceLength)
        )
        registerStartupTask = [bool]$RegisterStartupTask
        startAfterInstall = [bool]$StartAfterInstall
        lifecycleBrokerTaskRequested = [bool]$InstallLifecycleBrokerTask
        lifecycleBrokerUpgradeExistingRequested = [bool]$UpgradeLifecycleBrokerExisting
        lifecycleBrokerConfigurationValidated = [bool]$InstallLifecycleBrokerTask
        lifecycleBrokerTaskName = if ($InstallLifecycleBrokerTask) { 'Dyson-Control-Lifecycle-Broker' } else { $null }
        existingConfigurationProtectedForRollback = [bool](
            $null -ne $configurationPreflight.existing
        )
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](Test-DysonNodeRuntime -RuntimeRoot $runtimeFull -NodeExecutable $nodePath `
    -ExpectedNodeSha256 $ExpectedNodeSha256 -InstallRoot $installFull -DataRoot $dataFull `
    -MinimumMajor $sourceArtifactVerification.nodeMinimumMajor)

if (($RegisterStartupTask -or $InstallLifecycleBrokerTask -or
        [bool]$qualifiedClientStoragePlan.configured) -and
    -not $SelfTestSkipAdministratorCheck) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required for the selected deployment mutations.'
    }
}

$configurationBeforeMutation = Get-DysonDeploymentConfigurationPreflight `
    -ConfigurationSource $configurationFull -DataRoot $dataFull `
    -ScriptRoot $prospectiveScriptRoot -RuntimeBootstrapRoot $prospectiveBootstrapRoot `
    -DeploymentVersion $Version -ServiceAccount $ServiceAccount `
    -ExistingScriptRoot $existingConfigurationScriptRoot `
    -ExistingRuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
    -ExistingDeploymentVersion $existingConfigurationDeploymentVersion `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot `
    -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
Assert-DysonDeploymentConfigurationPreflightUnchanged `
    -Expected $configurationPreflight -Actual $configurationBeforeMutation
$dataRootCreatedByInstaller = -not (Test-Path -LiteralPath $dataFull -PathType Container)
if ($dataRootCreatedByInstaller) {
    [System.IO.Directory]::CreateDirectory($dataFull) | Out-Null
    Set-DysonDeploymentProtectedDataRootAcl -DataRoot $dataFull `
        -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
}
$configurationAfterDataRoot = Get-DysonDeploymentConfigurationPreflight `
    -ConfigurationSource $configurationFull -DataRoot $dataFull `
    -ScriptRoot $prospectiveScriptRoot -RuntimeBootstrapRoot $prospectiveBootstrapRoot `
    -DeploymentVersion $Version -ServiceAccount $ServiceAccount `
    -ExistingScriptRoot $existingConfigurationScriptRoot `
    -ExistingRuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
    -ExistingDeploymentVersion $existingConfigurationDeploymentVersion `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot `
    -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
Assert-DysonDeploymentConfigurationPreflightUnchanged `
    -Expected $configurationBeforeMutation -Actual $configurationAfterDataRoot

$brokerQuiescenceLease = $null
$brokerQuiescenceAttempted = $false
$brokerQuiescenceCompleted = $false
$deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
try {
$configurationPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
$configurationCreated = $false
$configurationReplaced = $false
$configurationReplacementRequired = $false
$configurationPreimageSnapshot = $null
$configurationPostimageSnapshot = $null
$configurationRuntimeModuleRoot = $null
$configurationInstallEvidence = $null
$configurationEvidence = $null
$qualifiedClientStorageEvidence = $null
$qualifiedClientStorageApplied = $false
$bootstrapRoot = Join-Path $installFull 'bootstrap'
$bootstrapHadPrevious = Test-Path -LiteralPath $bootstrapRoot -PathType Container
$bootstrapBackup = $null
$newBootstrap = Join-Path $installFull '.b'
$oldBootstrap = Join-Path $installFull '.o'
foreach ($reservedBootstrapPath in @($newBootstrap, $oldBootstrap)) {
    $reservedBootstrapIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $reservedBootstrapPath
    if ([System.IO.Directory]::Exists($reservedBootstrapIoPath) -or
        [System.IO.File]::Exists($reservedBootstrapIoPath)) {
        throw 'A fixed bootstrap transaction path is already occupied.'
    }
}
$deploymentResult = $null
$taskRollbackState = $null
$taskRollbackPrepared = $false
$lifecycleBrokerInstallReceipt = $null
$lifecycleBrokerInstallAttempted = $false
$lifecycleBrokerInstallArguments = $null
$lifecycleBrokerInstaller = $null
$lifecycleBrokerPreviousState = $null




$activeReleaseBeforeInstall = $null
try {
    if ($RegisterStartupTask -and ($InstallLifecycleBrokerTask)) {
        # This runs only after ShouldProcess and under the deployment lock. The
        # shared application lease rejects active mutations before stopping the
        # old panel; status workers do not require that lease and may drain.
        $brokerQuiescenceAttempted = $true
        . (Join-Path (Split-Path $PSScriptRoot -Parent) 'DysonHostMutationLease.Common.ps1')
        $brokerQuiescenceLease = Enter-DysonHostMutationLease -DataRoot (Join-Path $dataFull 'data') `
            -Owner 'control-deployment' -Operation 'broker-upgrade' `
            -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
        $taskRollbackState = Get-DysonControlTaskRollbackState -TaskName $TaskName
        $taskRollbackPrepared = $true
        Stop-DysonDeploymentControlTaskForBrokerUpgrade -State $taskRollbackState -TaskName $TaskName
        Wait-DysonDeploymentBrokerWorkersIdle
    }
    $configurationUnderLock = Get-DysonDeploymentConfigurationPreflight `
        -ConfigurationSource $configurationFull -DataRoot $dataFull `
        -ScriptRoot $prospectiveScriptRoot -RuntimeBootstrapRoot $prospectiveBootstrapRoot `
        -DeploymentVersion $Version -ServiceAccount $ServiceAccount `
        -ExistingScriptRoot $existingConfigurationScriptRoot `
        -ExistingRuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
        -ExistingDeploymentVersion $existingConfigurationDeploymentVersion `
        -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
    Assert-DysonDeploymentConfigurationPreflightUnchanged `
        -Expected $configurationAfterDataRoot -Actual $configurationUnderLock
    [void](Assert-DysonQualifiedClientStoragePreimageUnchanged `
        -Plan $qualifiedClientStoragePlan -Expected $qualifiedClientStoragePreflight `
        -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck)
    $configurationAfterDataRoot = $configurationUnderLock
    $configurationReplacementRequired = [bool](
        $null -ne $configurationUnderLock.existing -and
        ([string]$configurationUnderLock.existing.configurationSha256 -cne
            [string]$configurationUnderLock.sourceSha256 -or
        [int64]$configurationUnderLock.existing.configurationLength -ne
            [int64]$configurationUnderLock.sourceLength)
    )
    $activeReleaseBeforeInstall = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
    $lifecycleBrokerPreviousState = Get-DysonLifecycleBrokerDeploymentPreimage `
        -DeploymentDataRoot $dataFull -ActiveRelease $activeReleaseBeforeInstall `
        -ShadowRoot $lifecycleBrokerShadowFull
    Assert-DysonBrokerPreflightStateUnchanged -Before $lifecycleBrokerPreflightState `
        -After $lifecycleBrokerPreviousState -Kind lifecycle
    if ($null -ne $lifecycleBrokerPreviousState -and -not $InstallLifecycleBrokerTask) {
        throw 'An installed lifecycle broker requires explicit lifecycle broker handling for a control-plane release change.'
    }
    Assert-DysonBrokerUpgradeIntent -Kind lifecycle -Requested ([bool]$InstallLifecycleBrokerTask) `
        -UpgradeRequested ([bool]$UpgradeLifecycleBrokerExisting) `
        -State $lifecycleBrokerPreviousState -TargetVersion $Version
    Assert-DysonLifecycleBrokerDeploymentBinding -State $lifecycleBrokerPreviousState `
        -ProjectRoot $lifecycleProjectFull -RuntimeBootstrapRoot $lifecycleRuntimeBootstrapFull `
        -ServiceUser $ServiceUser -GamePort $GamePort -DispatchReadyTimeout $DispatchReadyTimeout





    [void](New-DysonDirectory -Path $installFull)
    $brokerQuiescenceCompleted = $brokerQuiescenceAttempted
    if ($configurationReplacementRequired) {
        $configurationPreimageSnapshot = New-DysonDeploymentConfigurationSnapshot `
            -DataRoot $dataFull -ScriptRoot $existingConfigurationScriptRoot `
            -RuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
            -DeploymentVersion $existingConfigurationDeploymentVersion `
            -ServiceAccount $ServiceAccount `
            -ConfigurationModuleRoot $configurationApplyModuleRoot
        if ([string]$configurationPreimageSnapshot.configurationSha256 -cne
                [string]$configurationUnderLock.existing.configurationSha256 -or
            [int64]$configurationPreimageSnapshot.configurationLength -ne
                [int64]$configurationUnderLock.existing.configurationLength -or
            [string]$configurationPreimageSnapshot.configurationAclFingerprint -cne
                [string]$configurationUnderLock.existing.configurationAclFingerprint) {
            throw 'The protected configuration preimage snapshot does not match the under-lock target.'
        }
    }
    foreach ($relative in @('data', 'logs', 'state', 'snapshots', 'audit')) {
        [void](New-DysonDirectory -Path (Join-Path $dataFull $relative))
    }
    $qualifiedClientStorageEvidence = Install-DysonQualifiedClientStorage `
        -Plan $qualifiedClientStoragePlan -Preimage $qualifiedClientStoragePreflight `
        -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
    $qualifiedClientStorageApplied = [bool]$qualifiedClientStoragePlan.configured
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'started' -Version $Version -Code 'INSTALL_STARTED'

    $deploymentOutput = & (Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1') `
        -Operation Upgrade `
        -SourcePath $sourceFull `
        -Version $Version `
        -ExpectedArtifactPayloadSha256 $ExpectedArtifactPayloadSha256 `
        -InstallRoot $installFull `
        -DataRoot $dataFull `
        -EntryPointRelativePath $EntryPointRelativePath `
        -ExistingDeploymentLock $deploymentLock `
        -Confirm:$false
    $deploymentResult = ($deploymentOutput | Out-String).Trim() | ConvertFrom-Json
    $activeRelease = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
    if ($null -eq $activeRelease -or [string]$activeRelease.pointer.version -cne $Version) {
        throw 'The activated immutable release could not be verified.'
    }

    if ($bootstrapHadPrevious) {
        $bootstrapBackupCandidate = Join-Path (Join-Path (Join-Path $dataFull 'snapshots') 'bootstrap') ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        Copy-DysonDirectoryContents -Source $bootstrapRoot -Destination $bootstrapBackupCandidate
        $bootstrapBackup = $bootstrapBackupCandidate
    }
    [System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $newBootstrap)
    ) | Out-Null
    $activeDeploymentSourceRoot = Assert-DysonPlainDirectory `
        -Path (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows\deployment')
    $activeConfigurationSourceRoot = Assert-DysonPlainDirectory `
        -Path (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows\configuration')
    $gameBootstrapSourceRoot = Assert-DysonPlainDirectory `
        -Path (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows\bootstrap')
    $bootstrapSources = @(
        [ordered]@{ source = Join-Path $activeDeploymentSourceRoot 'DysonDeployment.Common.ps1'; destination = 'DysonDeployment.Common.ps1' },
        [ordered]@{ source = Join-Path $activeDeploymentSourceRoot 'DysonDeployment.Configuration.ps1'; destination = 'DysonDeployment.Configuration.ps1' },
        [ordered]@{ source = Join-Path $activeDeploymentSourceRoot 'Start-DysonControl.ps1'; destination = 'Start-DysonControl.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'DysonConfiguration.Common.ps1'; destination = 'configuration\DysonConfiguration.Common.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'Install-DysonControlConfiguration.ps1'; destination = 'configuration\Install-DysonControlConfiguration.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'New-DysonControlConfigurationSnapshot.ps1'; destination = 'configuration\New-DysonControlConfigurationSnapshot.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'Restore-DysonControlConfiguration.ps1'; destination = 'configuration\Restore-DysonControlConfiguration.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'Test-DysonControlConfiguration.ps1'; destination = 'configuration\Test-DysonControlConfiguration.ps1' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'dyson-control.environment-contract.json'; destination = 'configuration\dyson-control.environment-contract.json' },
        [ordered]@{ source = Join-Path $activeConfigurationSourceRoot 'dyson-control.environment-contract.rc26.json'; destination = 'configuration\dyson-control.environment-contract.rc26.json' },
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'DysonGameLifecycleBootstrap.Common.ps1'; destination = 'DysonGameLifecycleBootstrap.Common.ps1' },
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'DysonStoppedSaveCapture.ps1'; destination = 'DysonStoppedSaveCapture.ps1' },
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'Resolve-DysonGameLifecycleRelease.ps1'; destination = 'Resolve-DysonGameLifecycleRelease.ps1' },
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'Start-DysonServer.ps1'; destination = 'Start-DysonServer.ps1' },
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'Stop-DysonServer.ps1'; destination = 'Stop-DysonServer.ps1' }
    )
    foreach ($bootstrapSource in $bootstrapSources) {
        $sourcePath = Get-DysonFullPath -Path ([string]$bootstrapSource.source)
        $sourceIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $sourcePath
        if (-not [System.IO.File]::Exists($sourceIoPath)) {
            throw 'A required stable bootstrap source is unavailable or redirected.'
        }
        $sourceAttributes = [System.IO.File]::GetAttributes($sourceIoPath)
        if (($sourceAttributes -band [System.IO.FileAttributes]::Directory) -or
            ($sourceAttributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'A required stable bootstrap source is unavailable or redirected.'
        }
        $destinationPath = Get-DysonFullPath -Path `
            (Join-Path $newBootstrap ([string]$bootstrapSource.destination))
        [System.IO.Directory]::CreateDirectory(
            (ConvertTo-DysonDeploymentExtendedPath -Path `
                ([System.IO.Path]::GetDirectoryName($destinationPath)))
        ) | Out-Null
        [System.IO.File]::Copy(
            $sourceIoPath,
            (ConvertTo-DysonDeploymentExtendedPath -Path $destinationPath),
            $true
        )
    }
    $null = . (Join-Path $newBootstrap 'DysonGameLifecycleBootstrap.Common.ps1')
    [void](Write-DysonGameBootstrapLayout -BootstrapRoot $newBootstrap -DataRoot $dataFull)
    if (Test-Path -LiteralPath $bootstrapRoot) { [System.IO.Directory]::Move($bootstrapRoot, $oldBootstrap) }
    [System.IO.Directory]::Move($newBootstrap, $bootstrapRoot)
    Remove-DysonDeploymentPlainTree -Path $oldBootstrap -ExpectedParent $installFull `
        -ExpectedLeafPattern '^\.o$'

    $configurationRuntimeModuleRoot = if ($SelfTestConfigurationShadowRoot) {
        $configurationApplyModuleRoot
    }
    else { Join-Path $bootstrapRoot 'configuration' }
    $configurationCreated = $null -eq $configurationPreflight.existing
    $configurationReplaced = $configurationReplacementRequired
    $configurationInstallEvidence = Invoke-DysonDeploymentConfigurationInstall `
        -ConfigurationSource $configurationFull -DataRoot $dataFull `
        -ScriptRoot (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows') `
        -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion $Version `
        -ServiceAccount $ServiceAccount `
        -ProtectedPreimageSnapshotPath $(
            if ($configurationPreimageSnapshot) {
                [string]$configurationPreimageSnapshot.snapshotPath
            }
            else { $null }
        ) `
        -ConfigurationModuleRoot $configurationRuntimeModuleRoot
    $configurationEvidence = Invoke-DysonDeploymentConfigurationTest `
        -DataRoot $dataFull `
        -ScriptRoot (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows') `
        -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion $Version `
        -ServiceAccount $ServiceAccount -ConfigurationModuleRoot $configurationRuntimeModuleRoot
    Assert-DysonDeploymentConfigurationEvidenceMatch `
        -Expected $configurationInstallEvidence -Actual $configurationEvidence
    if ([string]$configurationEvidence.configurationSha256 -cne [string]$configurationPreflight.sourceSha256 -or
        [int64]$configurationEvidence.configurationLength -ne [int64]$configurationPreflight.sourceLength -or
        [string]$configurationEvidence.configurationNamesSha256 -cne [string]$configurationPreflight.namesSha256 -or
        [string]$configurationEvidence.configurationBindingsSha256 -cne [string]$configurationPreflight.bindingsSha256 -or
        [string]$configurationEvidence.configurationContractSha256 -cne [string]$configurationPreflight.contractSha256) {
        throw 'The installed protected configuration does not match its validated source contract.'
    }
    if ($null -ne $configurationPreflight.existing -and -not $configurationReplacementRequired) {
        $existingConfigurationEvidence = ConvertTo-DysonDeploymentConfigurationEvidence `
            -Result $configurationPreflight.existing -Kind preflight
        Assert-DysonDeploymentConfigurationEvidenceMatch `
            -Expected $existingConfigurationEvidence -Actual $configurationEvidence
    }
    $qualifiedClientInstalledEnvironment = Read-DysonDeploymentEnvironmentFile -Path $configurationPath
    try {
        $qualifiedClientInstalledPlan = Get-DysonQualifiedClientStoragePlan `
            -Configured $qualifiedClientInstalledEnvironment -DataRoot $dataFull
    }
    finally { $qualifiedClientInstalledEnvironment.Clear() }
    if ([bool]$qualifiedClientInstalledPlan.configured -ne [bool]$qualifiedClientStoragePlan.configured -or
        [bool]$qualifiedClientInstalledPlan.enabled -ne [bool]$qualifiedClientStoragePlan.enabled -or
        [string]$qualifiedClientInstalledPlan.layoutSha256 -cne
            [string]$qualifiedClientStoragePlan.layoutSha256 -or
        [string]$qualifiedClientInstalledPlan.authority -cne
            [string]$qualifiedClientStoragePlan.authority) {
        throw 'The installed qualified-client storage binding changed after protected configuration publication.'
    }
    $qualifiedClientStorageEvidence = Test-DysonQualifiedClientStorage `
        -Plan $qualifiedClientInstalledPlan -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck

    if ($RegisterStartupTask) {
        if (-not $taskRollbackPrepared) {
            $taskRollbackState = Get-DysonControlTaskRollbackState -TaskName $TaskName
            $taskRollbackPrepared = $true
        }
        if ([bool]$taskRollbackState.present) {
            Remove-DysonControlTaskForRollback -TaskName $TaskName
        }
        $taskInstallOutput = & (Join-Path $PSScriptRoot 'Install-DysonControlTask.ps1') `
            -InstallRoot $installFull `
            -DataRoot $dataFull `
            -RuntimeRoot $runtimeFull `
            -NodeExecutable $nodePath `
            -ExpectedNodeSha256 $ExpectedNodeSha256 `
            -TaskName $TaskName `
            -ServiceAccount $ServiceAccount `
            -EnvironmentFile $configurationPath `
            -ExistingDeploymentLock $deploymentLock `
            -SelfTestSkipAdministratorCheck:$SelfTestSkipAdministratorCheck `
            -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot `
            -Confirm:$false
        $taskInstallLines = @(
            ($taskInstallOutput | Out-String) -split "`r?`n" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if ($taskInstallLines.Count -eq 0) { throw 'The control-plane task installer returned no receipt.' }
        $taskInstallReceipt = $taskInstallLines[$taskInstallLines.Count - 1] | ConvertFrom-Json -ErrorAction Stop
        if ([string]$taskInstallReceipt.protocol -cne $script:DysonDeploymentProtocol -or
            [string]$taskInstallReceipt.state -cne 'installed' -or
            [string]$taskInstallReceipt.taskName -cne $TaskName -or
            [string]$taskInstallReceipt.runtimeRootIdentity -cne [string]$nodeProtection.runtimeRootIdentity -or
            [string]$taskInstallReceipt.nodeExecutableSha256 -cne $ExpectedNodeSha256 -or
            [string]$taskInstallReceipt.configurationSha256 -cne [string]$configurationEvidence.configurationSha256 -or
            [int64]$taskInstallReceipt.configurationLength -ne [int64]$configurationEvidence.configurationLength -or
            [string]$taskInstallReceipt.configurationNamesSha256 -cne [string]$configurationEvidence.configurationNamesSha256 -or
            [string]$taskInstallReceipt.configurationBindingsSha256 -cne [string]$configurationEvidence.configurationBindingsSha256 -or
            [string]$taskInstallReceipt.configurationContractSha256 -cne [string]$configurationEvidence.configurationContractSha256 -or
            [string]$taskInstallReceipt.configurationAclFingerprint -cne [string]$configurationEvidence.configurationAclFingerprint -or
            [string]$taskInstallReceipt.configurationParentAclFingerprint -cne [string]$configurationEvidence.configurationParentAclFingerprint -or
            $taskInstallReceipt.nodeRuntimeProtected -isnot [bool] -or
            -not [bool]$taskInstallReceipt.nodeRuntimeProtected -or
            $taskInstallReceipt.runtimeChanged -isnot [bool] -or
            [bool]$taskInstallReceipt.runtimeChanged) {
            throw 'The control-plane task installer returned an unsupported receipt.'
        }
        $replacementTasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($replacementTasks.Count -ne 1 -or
            [string]$replacementTasks[0].TaskPath -cne $script:DysonControlTaskPath -or
            [string]$replacementTasks[0].State -cne 'Ready') {
            throw 'The replacement control-plane task was not registered uniquely in the non-started Ready state.'
        }
    }
    if ($InstallLifecycleBrokerTask) {
        $lifecycleWindowsRoot = Assert-DysonPlainDirectory `
            -Path (Join-Path ([string]$activeRelease.releaseRoot) 'scripts\windows')
        $lifecycleBrokerScriptRoot = Assert-DysonPlainDirectory `
            -Path (Join-Path $lifecycleWindowsRoot 'lifecycle-broker')
        $lifecycleBrokerInstaller = Assert-DysonDeploymentPlainFile `
            -Path (Join-Path $lifecycleBrokerScriptRoot 'Install-DysonLifecycleBrokerTask.ps1') `
            -MaximumBytes 1048576 `
            -Message 'The active release lifecycle broker installer is unavailable, redirected, empty, or too large.'
        $lifecycleBrokerDataRoot = Join-Path $dataFull 'data'
        $lifecycleBrokerRoot = Join-Path $lifecycleBrokerDataRoot 'lifecycle-broker'
        $lifecycleBrokerProfileFile = Join-Path $lifecycleBrokerRoot 'broker-profile.json'
        $lifecycleBrokerInstallArguments = @{
            BrokerRoot = $lifecycleBrokerRoot
            ProjectRoot = $lifecycleProjectFull
            DataRoot = $lifecycleBrokerDataRoot
            InstalledWindowsRoot = $lifecycleWindowsRoot
            RuntimeBootstrapRoot = $lifecycleRuntimeBootstrapFull
            ServiceUser = $ServiceUser
            GamePort = [int]$GamePort
            DispatchReadyTimeoutSeconds = [int]$DispatchReadyTimeout
            Confirm = $false
        }
        if ($UpgradeLifecycleBrokerExisting) {
            $lifecycleBrokerInstallArguments['UpgradeExisting'] = $true
            if ($null -ne $lifecycleBrokerPreviousState -and $bootstrapBackup) {
                $lifecycleBrokerInstallArguments['PreviousBootstrapRoot'] = $bootstrapBackup
            }
        }
        if ($lifecycleBrokerShadowFull) {
            $lifecycleBrokerInstallArguments['Backend'] = 'Shadow'
            $lifecycleBrokerInstallArguments['ShadowRoot'] = $lifecycleBrokerShadowFull
        }
        $lifecycleBrokerInstallAttempted = $true
        $candidateLifecycleBrokerReceipt = Invoke-DysonLifecycleBrokerDeploymentInstaller `
            -Installer $lifecycleBrokerInstaller -Arguments $lifecycleBrokerInstallArguments `
            -ShadowRoot $lifecycleBrokerShadowFull
        [void](Assert-DysonLifecycleBrokerInstallReceipt -Receipt $candidateLifecycleBrokerReceipt `
            -ExpectedBrokerRoot $lifecycleBrokerRoot -ExpectedProfileFile $lifecycleBrokerProfileFile `
            -ExpectedBackend $(if ($lifecycleBrokerShadowFull) { 'Shadow' } else { 'Windows' }))
        $expectedLifecycleBrokerOperation = if ($null -eq $lifecycleBrokerPreviousState) {
            'installed'
        }
        elseif ([string]$lifecycleBrokerPreviousState.activeVersion -ceq $Version) {
            'reused'
        }
        else { 'upgraded' }
        if ([string]$candidateLifecycleBrokerReceipt.operation -cne $expectedLifecycleBrokerOperation) {
            throw 'The lifecycle broker installer operation does not match the captured deployment preimage.'
        }
        if ($expectedLifecycleBrokerOperation -ceq 'reused') {
            Assert-DysonLifecycleBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                -State $lifecycleBrokerPreviousState -ShadowRoot $lifecycleBrokerShadowFull
        }
        $lifecycleBrokerInstallReceipt = $candidateLifecycleBrokerReceipt
    }

    if ($StartAfterInstall) {
        # Startup recovery may use the same host lease. Broker/configuration
        # publication is complete; release it before launching the new panel.
        if ($null -ne $brokerQuiescenceLease) {
            Exit-DysonHostMutationLease -Lease $brokerQuiescenceLease | Out-Null
            $brokerQuiescenceLease = $null
        }
        Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop
        $requiredReadinessChecks = @()
        if ($InstallLifecycleBrokerTask) { $requiredReadinessChecks += 'lifecycleBroker' }

        [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri -ExpectedVersion $Version `
            -RequiredChecks $requiredReadinessChecks -TimeoutSeconds $ReadinessTimeoutSeconds)
    }
}
catch {
    $installError = $_
    if ($brokerQuiescenceAttempted -and -not $brokerQuiescenceCompleted) {
        # No deployment snapshot/configuration/broker mutation has begun yet.
        # A busy lease or an undrained status request must not strand the old UI
        # or be confused with a partially installed broker requiring rollback.
        if ($null -ne $brokerQuiescenceLease) {
            Exit-DysonHostMutationLease -Lease $brokerQuiescenceLease | Out-Null
            $brokerQuiescenceLease = $null
        }
        if ($taskRollbackPrepared) {
            try { [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName) }
            catch { throw 'Broker quiescence failed; the previous control-plane task could not be restored.' }
        }
        throw $installError
    }
    if ($brokerQuiescenceCompleted -and $null -eq $brokerQuiescenceLease) {
        # The new panel may have acquired a host lease during startup recovery.
        # If so, do not interrupt it or run compensating mutations concurrently.
        try {
            $brokerQuiescenceLease = Enter-DysonHostMutationLease -DataRoot (Join-Path $dataFull 'data') `
                -Owner 'control-deployment' -Operation 'broker-rollback' `
                -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
        }
        catch { throw 'Installation failed; automatic rollback is deferred because the host mutation lease is unavailable.' }
    }
    $rollbackFailures = New-Object System.Collections.Generic.List[string]
    $replacementTaskRemoved = -not $taskRollbackPrepared
    if ($taskRollbackPrepared) {
        try {
            Remove-DysonControlTaskForRollback -TaskName $TaskName
            if ($brokerQuiescenceCompleted) { Wait-DysonDeploymentBrokerWorkersIdle }
            $replacementTaskRemoved = $true
        }
        catch {
            if ($brokerQuiescenceCompleted) {
                throw 'Installation failed; automatic rollback is deferred because the control plane or broker workers are not idle.'
            }
            $rollbackFailures.Add('replacement-task-stop-remove')
        }
    }

    $qualifiedClientStorageStateRestored = -not $qualifiedClientStorageApplied
    if ($qualifiedClientStorageApplied) {
        try {
            [void](Restore-DysonQualifiedClientStoragePreimage `
                -Plan $qualifiedClientStoragePlan -Preimage $qualifiedClientStoragePreflight)
            $qualifiedClientStorageStateRestored = $true
        }
        catch {
            $qualifiedClientStorageStateRestored = $false
            $rollbackFailures.Add('qualified-client-storage')
        }
    }






    $lifecycleBrokerStateRestored = $null -eq $lifecycleBrokerInstallReceipt
    $lifecycleBrokerRestoreDeferred = $false
    if ($null -ne $lifecycleBrokerInstallReceipt) {
        switch ([string]$lifecycleBrokerInstallReceipt.operation) {
            'reused' {
                try {
                    Assert-DysonLifecycleBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                        -State $lifecycleBrokerPreviousState -ShadowRoot $lifecycleBrokerShadowFull
                    $lifecycleBrokerStateRestored = $true
                }
                catch { $rollbackFailures.Add('lifecycle-broker-reused-verification') }
            }
            'installed' {
                try {
                    Restore-DysonLifecycleBrokerDeploymentFirstInstall -Installer $lifecycleBrokerInstaller `
                        -InstallArguments $lifecycleBrokerInstallArguments -DeploymentDataRoot $dataFull `
                        -ShadowRoot $lifecycleBrokerShadowFull `
                        -ExpectedProfileHash ([string]$lifecycleBrokerInstallReceipt.profileHash)
                    $lifecycleBrokerStateRestored = $true
                }
                catch { $rollbackFailures.Add('lifecycle-broker-first-install-compensation:' + $_.Exception.Message) }
            }
            'upgraded' {
                if ($null -eq $lifecycleBrokerPreviousState) {
                    $rollbackFailures.Add('lifecycle-broker-upgrade-preimage')
                }
                else { $lifecycleBrokerRestoreDeferred = $true }
            }
            default { $rollbackFailures.Add('lifecycle-broker-operation') }
        }
    }
    elseif ($InstallLifecycleBrokerTask) {
        try {
            Assert-DysonLifecycleBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                -State $lifecycleBrokerPreviousState -ShadowRoot $lifecycleBrokerShadowFull
            $lifecycleBrokerStateRestored = $true
        }
        catch {
            $lifecycleBrokerStateRestored = $false
            if ($lifecycleBrokerInstallAttempted -and $null -eq $lifecycleBrokerPreviousState -and
                $null -ne $lifecycleBrokerInstallArguments -and $lifecycleBrokerInstaller) {
                try {
                    Restore-DysonLifecycleBrokerDeploymentFirstInstall -Installer $lifecycleBrokerInstaller `
                        -InstallArguments $lifecycleBrokerInstallArguments -DeploymentDataRoot $dataFull `
                        -ShadowRoot $lifecycleBrokerShadowFull
                    $lifecycleBrokerStateRestored = $true
                }
                catch { $rollbackFailures.Add('lifecycle-broker-unaccepted-receipt-compensation:' + $_.Exception.Message) }
            }
            else { $rollbackFailures.Add('lifecycle-broker-install-rollback-verification') }
        }
    }

    $configurationStateRestored = $true
    if ($configurationCreated -and (Test-Path -LiteralPath $configurationPath)) {
        $configurationStateRestored = $false
        if (-not $replacementTaskRemoved) {
            $rollbackFailures.Add('protected-configuration-first-install-restore-blocked-by-task')
        }
        else {
            try {
                if ([string]::IsNullOrWhiteSpace([string]$configurationRuntimeModuleRoot)) {
                    throw 'The created protected configuration runtime module is unavailable.'
                }
                Remove-DysonDeploymentCreatedConfiguration -DataRoot $dataFull `
                    -ScriptRoot $prospectiveScriptRoot -RuntimeBootstrapRoot $bootstrapRoot `
                    -DeploymentVersion $Version -ServiceAccount $ServiceAccount `
                    -ExpectedPreflight $configurationPreflight `
                    -ConfigurationModuleRoot $configurationRuntimeModuleRoot `
                    -AllowSelfTestAdministrator:$SelfTestSkipAdministratorCheck
                $configurationStateRestored = $true
            }
            catch {
                $rollbackFailures.Add(
                    'protected-configuration-first-install-restore:' + $_.Exception.Message
                )
            }
        }
    }
    elseif ($configurationReplaced) {
        try {
            if ($null -eq $configurationPreimageSnapshot -or
                [string]::IsNullOrWhiteSpace([string]$configurationRuntimeModuleRoot)) {
                throw 'The protected configuration replacement preimage is unavailable.'
            }
            if ($null -eq $configurationInstallEvidence) {
                $candidateConfigurationEvidence = $null
                try {
                    $candidateConfigurationEvidence = Invoke-DysonDeploymentConfigurationTest `
                        -DataRoot $dataFull -ScriptRoot $prospectiveScriptRoot `
                        -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion $Version `
                        -ServiceAccount $ServiceAccount `
                        -ConfigurationModuleRoot $configurationRuntimeModuleRoot
                }
                catch {
                    $predecessorConfigurationEvidence = Invoke-DysonDeploymentConfigurationTest `
                        -DataRoot $dataFull -ScriptRoot $existingConfigurationScriptRoot `
                        -RuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
                        -DeploymentVersion $existingConfigurationDeploymentVersion `
                        -ServiceAccount $ServiceAccount `
                        -ConfigurationModuleRoot $configurationRuntimeModuleRoot
                    if ([string]$predecessorConfigurationEvidence.configurationSha256 -cne
                            [string]$configurationPreimageSnapshot.configurationSha256 -or
                        [int64]$predecessorConfigurationEvidence.configurationLength -ne
                            [int64]$configurationPreimageSnapshot.configurationLength -or
                        [string]$predecessorConfigurationEvidence.configurationAclFingerprint -cne
                            [string]$configurationPreimageSnapshot.configurationAclFingerprint) {
                        throw 'The failed configuration replacement left an unrecognized target.'
                    }
                    $configurationStateRestored = $true
                }
                if ($null -ne $candidateConfigurationEvidence) {
                    if ([string]$candidateConfigurationEvidence.configurationSha256 -cne
                            [string]$configurationPreflight.sourceSha256 -or
                        [int64]$candidateConfigurationEvidence.configurationLength -ne
                            [int64]$configurationPreflight.sourceLength) {
                        throw 'The failed configuration replacement left an unrecognized candidate target.'
                    }
                    $configurationInstallEvidence = $candidateConfigurationEvidence
                }
            }
            if ($null -ne $configurationInstallEvidence) {
                $configurationPostimageSnapshot = New-DysonDeploymentConfigurationSnapshot `
                    -DataRoot $dataFull -ScriptRoot $prospectiveScriptRoot `
                    -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion $Version `
                    -ServiceAccount $ServiceAccount `
                    -ConfigurationModuleRoot $configurationRuntimeModuleRoot
                if ([string]$configurationPostimageSnapshot.configurationSha256 -cne
                        [string]$configurationInstallEvidence.configurationSha256 -or
                    [int64]$configurationPostimageSnapshot.configurationLength -ne
                        [int64]$configurationInstallEvidence.configurationLength -or
                    [string]$configurationPostimageSnapshot.configurationAclFingerprint -cne
                        [string]$configurationInstallEvidence.configurationAclFingerprint) {
                    throw 'The protected configuration rollback postimage does not match the installed target.'
                }
                $configurationRestoreEvidence = Restore-DysonDeploymentConfigurationSnapshot `
                    -ProtectedSnapshotPath ([string]$configurationPreimageSnapshot.snapshotPath) `
                    -CurrentProtectedSnapshotPath ([string]$configurationPostimageSnapshot.snapshotPath) `
                    -DataRoot $dataFull -ServiceAccount $ServiceAccount `
                    -ConfigurationModuleRoot $configurationRuntimeModuleRoot
                if ([string]$configurationRestoreEvidence.sourceSnapshotId -cne
                        [string]$configurationPreimageSnapshot.snapshotId -or
                    [string]$configurationRestoreEvidence.preimageSnapshotId -cne
                        [string]$configurationPostimageSnapshot.snapshotId -or
                    [string]$configurationRestoreEvidence.configurationSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationSha256 -or
                    [int64]$configurationRestoreEvidence.configurationLength -ne
                        [int64]$configurationPreimageSnapshot.configurationLength -or
                    [string]$configurationRestoreEvidence.configurationAclFingerprint -cne
                        [string]$configurationPreimageSnapshot.configurationAclFingerprint -or
                    [string]$configurationRestoreEvidence.configurationBindingsSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationBindingsSha256 -or
                    [string]$configurationRestoreEvidence.configurationContractSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationContractSha256) {
                    throw 'The protected configuration rollback did not restore the exact preimage.'
                }
                $configurationStateRestored = $true
            }
        }
        catch {
            $configurationStateRestored = $false
            $rollbackFailures.Add('protected-configuration-restore:' + $_.Exception.Message)
        }
    }

    $deploymentStateRestored = -not [bool]($deploymentResult -and $deploymentResult.snapshotId)
    if ($configurationStateRestored -and $replacementTaskRemoved -and
        ($lifecycleBrokerStateRestored -or $lifecycleBrokerRestoreDeferred)) {
        try {
            if ($deploymentResult -and $deploymentResult.snapshotId) {
                & (Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1') `
                    -Operation Rollback `
                    -SnapshotId ([string]$deploymentResult.snapshotId) `
                    -InstallRoot $installFull `
                    -DataRoot $dataFull `
                    -ExistingDeploymentLock $deploymentLock `
                    -PreserveProtectedConfiguration `
                    -Confirm:$false | Out-Null
            }
            $deploymentStateRestored = $true
        }
        catch { $rollbackFailures.Add('deployment-state') }
    }
    else {
        if (-not $configurationStateRestored) {
            $rollbackFailures.Add('deployment-state-blocked-by-protected-configuration')
        }
        if (-not $replacementTaskRemoved) { $rollbackFailures.Add('deployment-state-blocked-by-task') }

        if (-not $lifecycleBrokerStateRestored -and -not $lifecycleBrokerRestoreDeferred) {
            $rollbackFailures.Add('deployment-state-blocked-by-lifecycle-broker')
        }
    }

    $bootstrapConfigurationRestored = $false
    if ($replacementTaskRemoved -and $deploymentStateRestored) {
        try {
            $bootstrapRootPresent = [System.IO.Directory]::Exists(
                (ConvertTo-DysonDeploymentExtendedPath -Path $bootstrapRoot)
            )
            $bootstrapBackupPresent = $bootstrapBackup -and [System.IO.Directory]::Exists(
                (ConvertTo-DysonDeploymentExtendedPath -Path $bootstrapBackup)
            )
            if ($bootstrapBackupPresent) {
                if ($bootstrapRootPresent) {
                    Remove-DysonDeploymentPlainTree -Path $bootstrapRoot -ExpectedParent $installFull `
                        -ExpectedLeafPattern '^bootstrap$'
                }
                Copy-DysonDirectoryContents -Source $bootstrapBackup -Destination $bootstrapRoot
            }
            elseif (-not $bootstrapHadPrevious -and $bootstrapRootPresent) {
                Remove-DysonDeploymentPlainTree -Path $bootstrapRoot -ExpectedParent $installFull `
                    -ExpectedLeafPattern '^bootstrap$'
            }
            if ([System.IO.Directory]::Exists(
                (ConvertTo-DysonDeploymentExtendedPath -Path $oldBootstrap)
            )) {
                if (-not [System.IO.Directory]::Exists(
                    (ConvertTo-DysonDeploymentExtendedPath -Path $bootstrapRoot)
                )) { [System.IO.Directory]::Move($oldBootstrap, $bootstrapRoot) }
                else {
                    Remove-DysonDeploymentPlainTree -Path $oldBootstrap -ExpectedParent $installFull `
                        -ExpectedLeafPattern '^\.o$'
                }
            }
            if ([System.IO.Directory]::Exists(
                (ConvertTo-DysonDeploymentExtendedPath -Path $newBootstrap)
            )) {
                Remove-DysonDeploymentPlainTree -Path $newBootstrap -ExpectedParent $installFull `
                    -ExpectedLeafPattern '^\.b$'
            }
            $bootstrapConfigurationRestored = $true
        }
        catch { $rollbackFailures.Add('bootstrap-configuration') }
    }
    else { $rollbackFailures.Add('bootstrap-configuration-blocked') }

    $configurationRollbackFinalVerified = if ($configurationCreated) {
        $configurationStateRestored -and -not (Test-Path -LiteralPath $configurationPath)
    }
    elseif (-not $configurationReplaced) { $true }
    else { $configurationStateRestored -and $null -eq $configurationInstallEvidence }
    if (-not $configurationRollbackFinalVerified) {
        if ($configurationStateRestored -and $deploymentStateRestored -and
            $bootstrapConfigurationRestored) {
            try {
                $restoredConfigurationEvidence = Invoke-DysonDeploymentConfigurationTest `
                    -DataRoot $dataFull -ScriptRoot $existingConfigurationScriptRoot `
                    -RuntimeBootstrapRoot $existingConfigurationBootstrapRoot `
                    -DeploymentVersion $existingConfigurationDeploymentVersion `
                    -ServiceAccount $ServiceAccount `
                    -ConfigurationModuleRoot $configurationApplyModuleRoot
                if ([string]$restoredConfigurationEvidence.configurationSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationSha256 -or
                    [int64]$restoredConfigurationEvidence.configurationLength -ne
                        [int64]$configurationPreimageSnapshot.configurationLength -or
                    [string]$restoredConfigurationEvidence.configurationBindingsSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationBindingsSha256 -or
                    [string]$restoredConfigurationEvidence.configurationContractSha256 -cne
                        [string]$configurationPreimageSnapshot.configurationContractSha256 -or
                    [string]$restoredConfigurationEvidence.configurationAclFingerprint -cne
                        [string]$configurationPreimageSnapshot.configurationAclFingerprint) {
                    throw 'The restored protected configuration changed after release/bootstrap rollback.'
                }
                if (-not $SelfTestConfigurationShadowRoot) {
                    $restoredRuntimeEvidence = Invoke-DysonDeploymentConfigurationTest -DataRoot $dataFull -ScriptRoot $existingConfigurationScriptRoot -RuntimeBootstrapRoot $existingConfigurationBootstrapRoot -DeploymentVersion $existingConfigurationDeploymentVersion -ServiceAccount $ServiceAccount -ConfigurationModuleRoot (Join-Path $bootstrapRoot 'configuration') -RuntimeOnly
                    if ([string]$restoredRuntimeEvidence.configurationSha256 -cne [string]$configurationPreimageSnapshot.configurationSha256 -or
                        [string]$restoredRuntimeEvidence.configurationBindingsSha256 -cne [string]$configurationPreimageSnapshot.configurationBindingsSha256 -or
                        [string]$restoredRuntimeEvidence.configurationContractSha256 -cne [string]$configurationPreimageSnapshot.configurationContractSha256) {
                        throw 'The restored launcher did not accept the original configuration approval.'
                    }
                }
                $configurationRollbackFinalVerified = $true
            }
            catch { $rollbackFailures.Add('protected-configuration-final-verification:' + $_.Exception.Message) }
        }
        else { $rollbackFailures.Add('protected-configuration-final-verification-blocked') }
    }

    $taskDataAclPreimageRestored = $true



    if ($lifecycleBrokerRestoreDeferred) {
        if ($replacementTaskRemoved -and $deploymentStateRestored -and $bootstrapConfigurationRestored -and
            $configurationRollbackFinalVerified -and
            $taskDataAclPreimageRestored) {
            try {
                $restoreArguments = @{}
                foreach ($key in $lifecycleBrokerPreviousState.installArguments.Keys) {
                    $restoreArguments[$key] = $lifecycleBrokerPreviousState.installArguments[$key]
                }
                $restoreArguments['UpgradeExisting'] = $true
                [void]$restoreArguments.Remove('CompensateFirstInstall')
                [void]$restoreArguments.Remove('RemoveCurrent')
                [void]$restoreArguments.Remove('ExpectedProfileHash')
                $restoreReceipt = Invoke-DysonLifecycleBrokerDeploymentInstaller `
                    -Installer ([string]$lifecycleBrokerPreviousState.installer) `
                    -Arguments $restoreArguments -ShadowRoot $lifecycleBrokerShadowFull
                [void](Assert-DysonLifecycleBrokerInstallReceipt -Receipt $restoreReceipt `
                    -ExpectedBrokerRoot ([string]$lifecycleBrokerPreviousState.brokerRoot) `
                    -ExpectedProfileFile ([string]$lifecycleBrokerPreviousState.profilePath) `
                    -ExpectedBackend $(if ($lifecycleBrokerShadowFull) { 'Shadow' } else { 'Windows' }))
                if ([string]$restoreReceipt.operation -cne 'upgraded' -or
                    -not [bool]$restoreReceipt.upgraded -or [bool]$restoreReceipt.reused) {
                    throw 'The lifecycle broker rollback-to-previous-release receipt is invalid.'
                }
                Restore-DysonLifecycleBrokerDeploymentPreimage -State $lifecycleBrokerPreviousState `
                    -ShadowRoot $lifecycleBrokerShadowFull
                Assert-DysonLifecycleBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                    -State $lifecycleBrokerPreviousState -ShadowRoot $lifecycleBrokerShadowFull
                $lifecycleBrokerStateRestored = $true
            }
            catch { $rollbackFailures.Add('lifecycle-broker-upgrade-compensation:' + $_.Exception.Message) }
        }
        else { $rollbackFailures.Add('lifecycle-broker-upgrade-compensation-blocked') }
    }



    if ($taskRollbackPrepared -and $replacementTaskRemoved -and $deploymentStateRestored -and
        $bootstrapConfigurationRestored -and $configurationRollbackFinalVerified -and
        $taskDataAclPreimageRestored -and
        $lifecycleBrokerStateRestored) {
        try {
            if ($null -ne $brokerQuiescenceLease) {
                Exit-DysonHostMutationLease -Lease $brokerQuiescenceLease | Out-Null
                $brokerQuiescenceLease = $null
            }
            [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName)
        }
        catch { $rollbackFailures.Add('previous-task-restore') }
    }
    elseif ($taskRollbackPrepared) { $rollbackFailures.Add('previous-task-restore-blocked') }
    if ($rollbackFailures.Count -eq 0) {
        try {
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'failed-rolled-back' -Version $Version -SnapshotId $(
            if ($deploymentResult) { [string]$deploymentResult.snapshotId } else { $null }
        ) -Code 'INSTALL_ROLLED_BACK'
        }
        catch { $rollbackFailures.Add('rollback-audit') }
    }
    if ($rollbackFailures.Count -gt 0) {
        try {
            Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'failed-rollback-failed' -Version $Version -Code 'INSTALL_ROLLBACK_FAILED'
        }
        catch { }
        throw ('Installation failed ({0}); automatic rollback was incomplete in: {1}.' -f
            $installError.Exception.Message, [string]::Join(', ', @($rollbackFailures)))
    }
    throw $installError
}

Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'succeeded' -Version $Version -SnapshotId ([string]$deploymentResult.snapshotId) -Code 'INSTALL_SUCCEEDED'
[ordered]@{
    protocol = $script:DysonDeploymentProtocol
    state = 'installed'
    version = $Version
    artifactPayloadSha256 = [string]$sourceArtifactVerification.payloadSha256
    artifactProvenanceBound = $true
    sourceArtifactScriptsExecuted = $false
    runtimeRootIdentity = [string]$nodeProtection.runtimeRootIdentity
    nodeExecutableSha256 = [string]$nodeProtection.nodeExecutableSha256
    nodeRuntimeProtected = $true
    runtimeChanged = $false
    deploymentSnapshotId = [string]$deploymentResult.snapshotId
    configurationCreated = $configurationCreated
    configurationReplaced = $configurationReplaced
    configurationReady = Test-Path -LiteralPath $configurationPath -PathType Leaf
    configurationSha256 = [string]$configurationEvidence.configurationSha256
    configurationLength = [int64]$configurationEvidence.configurationLength
    configurationNamesSha256 = [string]$configurationEvidence.configurationNamesSha256
    configurationBindingsSha256 = [string]$configurationEvidence.configurationBindingsSha256
    configurationContractSha256 = [string]$configurationEvidence.configurationContractSha256
    configurationAclFingerprint = [string]$configurationEvidence.configurationAclFingerprint
    configurationParentAclFingerprint = [string]$configurationEvidence.configurationParentAclFingerprint
    configurationReplacementSupported = $true
    qualifiedClientStorageConfigured = [bool]$qualifiedClientStorageEvidence.configured
    qualifiedClientProfileEnabled = [bool]$qualifiedClientStorageEvidence.enabled
    qualifiedClientStorageReady = [bool]$qualifiedClientStorageEvidence.ready
    qualifiedClientStorageLayoutSha256 = [string]$qualifiedClientStorageEvidence.layoutSha256
    qualifiedClientStorageDirectoryCount = [int]$qualifiedClientStorageEvidence.directoryCount
    startupTaskInstalled = [bool]$RegisterStartupTask
    readinessVerified = [bool]$StartAfterInstall
    loopbackForcedByLauncher = $true
    persistentDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data') -PathType Container
    lifecycleBrokerTaskRequested = [bool]$InstallLifecycleBrokerTask
    lifecycleBrokerOperation = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.operation } else { $null }
    lifecycleBrokerTaskInstalled = [bool]($null -ne $lifecycleBrokerInstallReceipt)
    lifecycleBrokerTaskName = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.workerTaskName } else { $null }
    lifecycleBrokerProfileHash = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.profileHash } else { $null }
    lifecycleBrokerReused = if ($lifecycleBrokerInstallReceipt) { [bool]$lifecycleBrokerInstallReceipt.reused } else { $null }
    lifecycleBrokerUpgraded = if ($lifecycleBrokerInstallReceipt) { [bool]$lifecycleBrokerInstallReceipt.upgraded } else { $null }
    lifecycleBrokerDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data\lifecycle-broker') -PathType Container
    gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
}
finally {
    try {
        if ($null -ne $brokerQuiescenceLease) {
            Exit-DysonHostMutationLease -Lease $brokerQuiescenceLease | Out-Null
        }
    }
    finally { if ($deploymentLock) { $deploymentLock.Dispose() } }
}
