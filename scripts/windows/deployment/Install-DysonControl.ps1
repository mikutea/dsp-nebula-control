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
    [switch]$InstallCutoverBrokerTask,
    [switch]$UpgradeCutoverBrokerExisting,
    [string]$CutoverProjectRoot,
    [string]$CutoverAuthorityProfileFile,
    [string]$CutoverAuthorityInventoryRevision,
    [string]$CutoverRuntimeTaskTransactionRoot,
    [string]$CutoverServiceUser,
    [Nullable[int]]$CutoverGamePort,
    [string]$CutoverRuntimeBootstrapRoot,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [uri]$ReadinessUri,
    [ValidateRange(1, 300)][int]$ReadinessTimeoutSeconds = 30,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck,
    [Parameter(DontShow)][string]$SelfTestShadow,
    [Parameter(DontShow)][string]$SelfTestCutoverBrokerShadowRoot,
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

function Get-DysonCutoverBrokerDeploymentTasks {
    try {
        # A missing named task is surfaced with localized/provider-specific
        # error identifiers on different Windows builds. Query the scheduler
        # once and apply the shared exact-name validator so absence is an
        # empty preimage while genuine query failures still fail closed.
        return @(Get-DysonScheduledTasksByExactName `
            -TaskName 'Dyson-Control-Cutover-Broker')
    }
    catch {
        throw 'The fixed cutover broker task state could not be queried.'
    }
}

function Get-DysonCutoverBrokerDeploymentBundle {
    param([Parameter(Mandatory)][string]$BrokerScriptRoot)

    $names = @(
        'DysonCutoverBroker.Common.ps1',
        'DysonCutoverBroker.TaskAcl.ps1',
        'Install-DysonCutoverBrokerTask.ps1',
        'Invoke-DysonCutoverBrokerWorker.ps1',
        'SelfTest-DysonCutoverBroker.ps1',
        'Submit-DysonCutoverBrokerRequest.ps1'
    )
    $root = Assert-DysonPlainDirectory -Path $BrokerScriptRoot
    $items = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
    $actualNames = @($items | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $expectedNames = @($names | Sort-Object -CaseSensitive)
    if ($items.Count -ne $names.Count -or
        [string]::Join("`n", $actualNames) -cne [string]::Join("`n", $expectedNames)) {
        throw 'The cutover broker script bundle inventory is inconsistent with the fixed contract.'
    }
    $files = @(
        foreach ($name in $names) {
            $path = Assert-DysonDeploymentPlainFile -Path (Join-Path $root $name) -MaximumBytes 16777216 `
                -Message 'A cutover broker dependency is unavailable, redirected, empty, or too large.'
            [pscustomobject][ordered]@{
                name = $name
                sha256 = Get-DysonCutoverBrokerSha256File $path
            }
        }
    )
    $descriptor = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_SCRIPT_BUNDLE_V1'
        schemaVersion = 1
        files = $files
    }
    return [pscustomobject][ordered]@{
        descriptor = $descriptor
        sha256 = Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $descriptor)
    }
}

function ConvertTo-DysonCutoverBrokerDeploymentBinding {
    param([Parameter(Mandatory)]$Raw)

    $message = 'The cutover broker bundle binding is invalid.'
    Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $Raw -Names @(
        'protocol', 'schemaVersion', 'profileFingerprint', 'brokerBundleSha256', 'createdAt'
    ) -Message $message
    $createdAt = [datetimeoffset]::MinValue
    if ([string]$Raw.protocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_BUNDLE_BINDING_V1' -or
        [int]$Raw.schemaVersion -ne 1 -or
        [string]$Raw.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$Raw.brokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        -not [datetimeoffset]::TryParseExact(
            [string]$Raw.createdAt, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$createdAt
        )) {
        throw $message
    }
    return $Raw
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
        $cutover = @(Get-DysonCutoverBrokerDeploymentTasks)
        if ($lifecycle.Count -gt 1 -or $cutover.Count -gt 1) {
            throw 'A fixed broker task identity is ambiguous during quiescence.'
        }
        $running = @(@($lifecycle) + @($cutover) | Where-Object { [string]$_.State -ceq 'Running' })
        if ($running.Count -eq 0) { $quietSamples += 1 } else { $quietSamples = 0 }
        if ($quietSamples -ge 2) { return }
        Start-Sleep -Milliseconds 500
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw 'The fixed broker workers did not become idle before the deployment deadline.'
}

function Assert-DysonCutoverBrokerDeploymentNoPendingWork {
    param([Parameter(Mandatory)]$Storage)

    foreach ($root in @($Storage.requestsRoot, $Storage.intentsRoot, $Storage.workRoot)) {
        if (@(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop).Count -ne 0) {
            throw 'The cutover broker has pending request, intent, or work state.'
        }
    }
}

function Get-DysonCutoverBrokerDeploymentDirectoryAclIntent {
    return @(
        [pscustomobject][ordered]@{ kind = 'root'; protected = $true; system = 'full'; administrators = 'full'; localService = 'read-execute' }
        [pscustomobject][ordered]@{ kind = 'requests'; protected = $true; system = 'full'; administrators = 'full'; localService = 'modify' }
        [pscustomobject][ordered]@{ kind = 'receipts'; protected = $true; system = 'full'; administrators = 'full'; localService = 'read-execute' }
        [pscustomobject][ordered]@{ kind = 'private'; protected = $true; system = 'full'; administrators = 'full'; localService = 'none' }
    )
}

function Assert-DysonCutoverBrokerDeploymentTask {
    param(
        [Parameter(Mandatory)]$Profile,
        [string]$ShadowRoot,
        [string]$TaskIntentPath,
        [string]$DirectoryAclIntentPath
    )

    if ($ShadowRoot) {
        $taskIntent = Read-DysonCutoverBrokerJson -Path $TaskIntentPath -MaximumBytes 131072 `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
        $expectedTaskIntent = [pscustomobject][ordered]@{
            taskName = [string]$Profile.taskName
            taskPath = [string]$Profile.taskPath
            principal = 'S-1-5-18'
            runLevel = 'Highest'
            executable = [IO.Path]::GetFullPath(
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
            )
            arguments = Get-DysonCutoverBrokerTaskArguments $Profile
            multipleInstances = 'IgnoreNew'
            enabled = $true
            acl = Get-DysonFixedTaskReadExecuteAclIntent
        }
        if ((ConvertTo-DysonCutoverBrokerJson $taskIntent) -cne
            (ConvertTo-DysonCutoverBrokerJson $expectedTaskIntent)) {
            throw 'The cutover broker shadow task is inconsistent with its active profile.'
        }
        $directoryIntent = Read-DysonCutoverBrokerJson -Path $DirectoryAclIntentPath -MaximumBytes 131072 `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED'
        if ((ConvertTo-DysonCutoverBrokerJson $directoryIntent) -cne
            (ConvertTo-DysonCutoverBrokerJson (Get-DysonCutoverBrokerDeploymentDirectoryAclIntent))) {
            throw 'The cutover broker shadow storage ACL intent is inconsistent.'
        }
        return
    }

    $tasks = @(Get-DysonCutoverBrokerDeploymentTasks)
    $actions = @(if ($tasks.Count -eq 1) { $tasks[0].Actions | Where-Object { $null -ne $_ } })
    $triggers = @(if ($tasks.Count -eq 1) { $tasks[0].Triggers | Where-Object { $null -ne $_ } })
    $expectedPowerShell = [IO.Path]::GetFullPath(
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    )
    if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskPath -cne '\' -or
        [string]$tasks[0].Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or
        [string]$tasks[0].Principal.LogonType -cne 'ServiceAccount' -or
        [string]$tasks[0].Principal.RunLevel -cne 'Highest' -or $actions.Count -ne 1 -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)),
            $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase
        ) -or [string]$actions[0].Arguments -cne (Get-DysonCutoverBrokerTaskArguments $Profile) -or
        -not [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or $triggers.Count -ne 0 -or
        [string]$tasks[0].Settings.MultipleInstances -cne 'IgnoreNew' -or
        [string]$tasks[0].Settings.ExecutionTimeLimit -cne 'PT10M' -or
        $tasks[0].Settings.Enabled -isnot [bool] -or -not [bool]$tasks[0].Settings.Enabled -or
        [string]$tasks[0].Description -cne 'Fixed SYSTEM mutation broker for Dyson Control cutover operations.') {
        throw 'The fixed cutover broker task is inconsistent with its active profile.'
    }
}

function Assert-DysonBrokerUpgradeIntent {
    param(
        [Parameter(Mandatory)][ValidateSet('lifecycle', 'cutover')][string]$Kind,
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
    param($Before, $After, [Parameter(Mandatory)][ValidateSet('lifecycle', 'cutover')][string]$Kind)

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

function Assert-DysonCutoverBrokerDeploymentBinding {
    param(
        $State,
        [string]$ProjectRoot,
        [string]$DataRoot,
        [string]$AuthorityProfileFile,
        [string]$AuthorityInventoryRevision,
        [string]$RuntimeBootstrapRoot,
        [string]$RuntimeTaskTransactionRoot,
        [string]$ServiceUser,
        [Nullable[int]]$GamePort
    )

    if ($null -eq $State) { return }
    if ([string]::IsNullOrWhiteSpace($ProjectRoot) -or
        [string]::IsNullOrWhiteSpace($DataRoot) -or
        [string]::IsNullOrWhiteSpace($AuthorityProfileFile) -or
        [string]::IsNullOrWhiteSpace($AuthorityInventoryRevision) -or
        [string]::IsNullOrWhiteSpace($RuntimeBootstrapRoot) -or
        [string]::IsNullOrWhiteSpace($RuntimeTaskTransactionRoot) -or
        [string]::IsNullOrWhiteSpace($ServiceUser) -or $null -eq $GamePort -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.projectRoot) $ProjectRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.dataRoot) $DataRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.authorityProfileFile) $AuthorityProfileFile) -or
        [string]$State.installArguments.AuthorityInventoryRevision -cne $AuthorityInventoryRevision -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.runtimeBootstrapRoot) $RuntimeBootstrapRoot) -or
        -not (Test-DysonDeploymentSamePath ([string]$State.profile.runtimeTaskTransactionRoot) `
            $RuntimeTaskTransactionRoot) -or
        [string]$State.profile.serviceUser -cne $ServiceUser -or
        [int]$State.profile.gamePort -ne [int]$GamePort) {
        throw 'The existing cutover broker profile does not match the production environment binding.'
    }
}

function Get-DysonCutoverBrokerDeploymentPreimage {
    param(
        [Parameter(Mandatory)][string]$DeploymentDataRoot,
        $ActiveRelease,
        [string]$ShadowRoot
    )

    $brokerRoot = Join-Path (Join-Path $DeploymentDataRoot 'data') 'cutover-broker'
    $profilePath = Join-Path $brokerRoot 'broker-profile.json'
    $bindingPath = Join-Path $brokerRoot 'broker-bundle.json'
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
        $taskResidual = if ($ShadowRoot) {
            Test-Path -LiteralPath (Join-Path $ShadowRoot 'task-intent.json')
        }
        else { @(Get-DysonCutoverBrokerDeploymentTasks).Count -ne 0 }
        if ((Test-Path -LiteralPath $profilePath) -or (Test-Path -LiteralPath $bindingPath) -or $taskResidual) {
            throw 'A cutover broker bundle or task exists without its fixed profile.'
        }
        if ($ShadowRoot) {
            $durableDirectoryAclIntent = Join-Path $ShadowRoot 'directory-acl-intent.json'
            if (Test-Path -LiteralPath $durableDirectoryAclIntent) {
                $intentFile = Assert-DysonDeploymentPlainFile -Path $durableDirectoryAclIntent `
                    -MaximumBytes 131072 -Message 'The retained cutover broker storage ACL intent is redirected or invalid.'
                $actualIntent = [IO.File]::ReadAllText(
                    $intentFile, [Text.UTF8Encoding]::new($false, $true)
                ) | ConvertFrom-Json -ErrorAction Stop
                if (($actualIntent | ConvertTo-Json -Depth 8 -Compress) -cne
                    ((Get-DysonCutoverBrokerDeploymentDirectoryAclIntent) |
                        ConvertTo-Json -Depth 8 -Compress)) {
                    throw 'The retained cutover broker storage ACL intent is inconsistent.'
                }
            }
        }
        return $null
    }
    if ($null -eq $ActiveRelease) {
        throw 'A cutover broker profile exists without an active immutable release.'
    }
    $expectedCutoverRoot = Join-Path ([string]$ActiveRelease.releaseRoot) 'scripts\windows'
    $expectedBrokerScriptRoot = Join-Path $expectedCutoverRoot 'cutover-broker'
    $commonPath = Assert-DysonDeploymentPlainFile `
        -Path (Join-Path $expectedBrokerScriptRoot 'DysonCutoverBroker.Common.ps1') `
        -MaximumBytes 1048576 -Message 'The active-release cutover broker common helper is unavailable or redirected.'
    $taskAclScript = Assert-DysonDeploymentPlainFile `
        -Path (Join-Path $expectedBrokerScriptRoot 'DysonCutoverBroker.TaskAcl.ps1') `
        -MaximumBytes 262144 -Message 'The active-release cutover broker task ACL helper is unavailable or redirected.'
    $null = . $commonPath
    $null = . $taskAclScript
    $profileFile = Assert-DysonDeploymentPlainFile -Path $profilePath -MaximumBytes 32768 `
        -Message 'The existing cutover broker profile is unavailable, redirected, empty, or too large.'
    $bindingFile = Assert-DysonDeploymentPlainFile -Path $bindingPath -MaximumBytes 32768 `
        -Message 'The existing cutover broker bundle binding is unavailable, redirected, empty, or too large.'
    $profile = Read-DysonCutoverBrokerProfile -BrokerRoot $brokerRoot -BrokerProfileFile $profileFile
    $bundle = Get-DysonCutoverBrokerDeploymentBundle -BrokerScriptRoot $expectedBrokerScriptRoot
    $binding = ConvertTo-DysonCutoverBrokerDeploymentBinding (
        Read-DysonCutoverBrokerJson -Path $bindingFile -MaximumBytes 32768 `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    )
    if ([string]$binding.profileFingerprint -cne [string]$profile.profileFingerprint -or
        [string]$binding.brokerBundleSha256 -cne [string]$bundle.sha256 -or
        -not (Test-DysonDeploymentSamePath -Left ([string]$profile.brokerRoot) -Right $brokerRoot) -or
        -not (Test-DysonDeploymentSamePath -Left ([string]$profile.cutoverScriptRoot) -Right $expectedCutoverRoot) -or
        -not (Test-DysonDeploymentSamePath -Left ([string]$profile.brokerScriptRoot) -Right $expectedBrokerScriptRoot)) {
        throw 'The existing cutover broker profile is not bound to the active immutable release.'
    }
    $storage = Get-DysonCutoverBrokerStorage -BrokerRoot $brokerRoot
    [void](Assert-DysonCutoverBrokerDeploymentNoPendingWork -Storage $storage)
    $leaseCommon = Assert-DysonDeploymentPlainFile `
        -Path (Join-Path $expectedCutoverRoot 'DysonHostMutationLease.Common.ps1') -MaximumBytes 2097152 `
        -Message 'The active-release cutover lease helper is unavailable or redirected.'
    $hostCommon = Assert-DysonDeploymentPlainFile `
        -Path (Join-Path $expectedCutoverRoot 'cutover\DysonCutoverHost.Common.ps1') -MaximumBytes 2097152 `
        -Message 'The active-release cutover host helper is unavailable or redirected.'
    $null = . $leaseCommon
    $null = . $hostCommon
    $authority = ConvertTo-CutoverHostValidatedProfile (
        Read-DysonCutoverBrokerJson -Path ([string]$profile.authorityProfileFile) -MaximumBytes 262144 `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    )
    $authorityRoot = [IO.Path]::GetDirectoryName([string]$profile.authorityProfileFile)
    if ([string]$authority.projectRootIdentity -cne (Get-CutoverHostPathIdentity ([string]$profile.projectRoot)) -or
        [string]$authority.dataRootIdentity -cne (Get-DysonHostMutationDataRootIdentity ([string]$profile.dataRoot)) -or
        [string]$authority.authorityRootIdentity -cne (Get-CutoverHostPathIdentity $authorityRoot) -or
        [string]$authority.runtimeBootstrapIdentity -cne
            (Get-CutoverHostPathIdentity ([string]$profile.runtimeBootstrapRoot)) -or
        [string]$authority.runtimeTaskTransactionRootIdentity -cne
            (Get-CutoverHostPathIdentity ([string]$profile.runtimeTaskTransactionRoot)) -or
        -not [string]::Equals(
            [string]$authority.serviceUser, [string]$profile.serviceUser, [StringComparison]::OrdinalIgnoreCase
        ) -or [int]$authority.gamePort -ne [int]$profile.gamePort -or
        [string]$authority.runtimeBootstrapStartSha256 -cne
            (Get-CutoverHostSha256File (Join-Path ([string]$profile.runtimeBootstrapRoot) 'Start-DysonServer.ps1')) -or
        [string]$authority.runtimeBootstrapStopSha256 -cne
            (Get-CutoverHostSha256File (Join-Path ([string]$profile.runtimeBootstrapRoot) 'Stop-DysonServer.ps1'))) {
        throw 'The existing cutover broker authority profile is inconsistent with the broker profile.'
    }
    $installer = Assert-DysonDeploymentPlainFile `
        -Path (Join-Path $expectedBrokerScriptRoot 'Install-DysonCutoverBrokerTask.ps1') `
        -MaximumBytes 1048576 `
        -Message 'The existing active-release cutover broker installer is unavailable, redirected, empty, or too large.'
    $taskIntentPath = $null
    $taskIntentBytes = $null
    $directoryAclIntentPath = $null
    $directoryAclIntentBytes = $null
    $taskXml = $null
    $taskSddl = $null
    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        $taskIntentPath = Assert-DysonDeploymentPlainFile -Path (Join-Path $ShadowRoot 'task-intent.json') `
            -MaximumBytes 131072 -Message 'The cutover broker shadow task preimage is unavailable or redirected.'
        $taskIntentBytes = [System.IO.File]::ReadAllBytes($taskIntentPath)
        $directoryAclIntentPath = Assert-DysonDeploymentPlainFile `
            -Path (Join-Path $ShadowRoot 'directory-acl-intent.json') -MaximumBytes 131072 `
            -Message 'The cutover broker shadow ACL preimage is unavailable or redirected.'
        $directoryAclIntentBytes = [System.IO.File]::ReadAllBytes($directoryAclIntentPath)
    }
    else {
        $taskXml = [string](Export-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' `
            -TaskPath '\' -ErrorAction Stop)
        $taskSddl = Get-DysonFixedTaskSecurityDescriptor `
            -TaskName 'Dyson-Control-Cutover-Broker' -TaskPath '\'
        [void](Assert-DysonFixedTaskReadExecuteAclIntent $taskSddl)
    }
    [void](Assert-DysonCutoverBrokerDeploymentTask -Profile $profile -ShadowRoot $ShadowRoot `
        -TaskIntentPath $taskIntentPath -DirectoryAclIntentPath $directoryAclIntentPath)
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
    return [pscustomobject][ordered]@{
        activeVersion = [string]$ActiveRelease.pointer.version
        activeReleaseRoot = [string]$ActiveRelease.releaseRoot
        brokerRoot = $brokerRoot
        profilePath = $profileFile
        profile = $profile
        profileBytes = [System.IO.File]::ReadAllBytes($profileFile)
        profileSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $profileFile -ErrorAction Stop).Sddl
        bindingPath = $bindingFile
        binding = $binding
        bindingBytes = [System.IO.File]::ReadAllBytes($bindingFile)
        bindingSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $bindingFile -ErrorAction Stop).Sddl
        cutoverScriptRoot = $expectedCutoverRoot
        brokerScriptRoot = $expectedBrokerScriptRoot
        installer = $installer
        taskIntentPath = $taskIntentPath
        taskIntentBytes = $taskIntentBytes
        directoryAclIntentPath = $directoryAclIntentPath
        directoryAclIntentBytes = $directoryAclIntentBytes
        directoryAcls = $brokerDirectoryAcls
        taskXml = $taskXml
        taskSddl = $taskSddl
        installArguments = @{
            RequestId = [guid]::NewGuid().ToString('D')
            BrokerRoot = [string]$profile.brokerRoot
            BrokerScriptRoot = [string]$profile.brokerScriptRoot
            ProjectRoot = [string]$profile.projectRoot
            DataRoot = [string]$profile.dataRoot
            AuthorityProfileFile = [string]$profile.authorityProfileFile
            AuthorityInventoryRevision = [string]$authority.inventoryRevision
            CutoverScriptRoot = [string]$profile.cutoverScriptRoot
            RuntimeBootstrapRoot = [string]$profile.runtimeBootstrapRoot
            RuntimeTaskTransactionRoot = [string]$profile.runtimeTaskTransactionRoot
            ServiceUser = [string]$profile.serviceUser
            GamePort = [int]$profile.gamePort
            TaskName = [string]$profile.taskName
            SchedulerBackend = if ($ShadowRoot) { 'Shadow' } else { 'Windows' }
            ShadowRoot = $ShadowRoot
            Confirm = $false
        }
    }
}

function ConvertFrom-DysonCutoverBrokerInstallerOutput {
    param([Parameter(Mandatory)]$Output)

    $lines = @(
        ($Output | Out-String) -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($lines.Count -eq 0) { throw 'The cutover broker installer returned no receipt.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json -ErrorAction Stop
}

function Assert-DysonCutoverBrokerDeploymentPreimageRestored {
    param(
        [Parameter(Mandatory)][string]$DeploymentDataRoot,
        $State,
        [string]$ShadowRoot,
        [switch]$DeferFullContract
    )

    $brokerRoot = Join-Path (Join-Path $DeploymentDataRoot 'data') 'cutover-broker'
    $profilePath = Join-Path $brokerRoot 'broker-profile.json'
    $bindingPath = Join-Path $brokerRoot 'broker-bundle.json'
    if ($null -eq $State) {
        $taskResidual = if ($ShadowRoot) {
            Test-Path -LiteralPath (Join-Path $ShadowRoot 'task-intent.json')
        }
        else { @(Get-DysonCutoverBrokerDeploymentTasks).Count -ne 0 }
        if ((Test-Path -LiteralPath $profilePath) -or (Test-Path -LiteralPath $bindingPath) -or $taskResidual) {
            throw 'A first-install cutover broker task/profile survived compensation.'
        }
        if ($ShadowRoot) {
            $durableDirectoryAclIntent = Join-Path $ShadowRoot 'directory-acl-intent.json'
            if (Test-Path -LiteralPath $durableDirectoryAclIntent) {
                $intentFile = Assert-DysonDeploymentPlainFile -Path $durableDirectoryAclIntent `
                    -MaximumBytes 131072 `
                    -Message 'The retained cutover broker storage ACL intent is redirected or invalid.'
                $actualIntent = [IO.File]::ReadAllText(
                    $intentFile, [Text.UTF8Encoding]::new($false, $true)
                ) | ConvertFrom-Json -ErrorAction Stop
                if (($actualIntent | ConvertTo-Json -Depth 8 -Compress) -cne
                    ((Get-DysonCutoverBrokerDeploymentDirectoryAclIntent) |
                        ConvertTo-Json -Depth 8 -Compress)) {
                    throw 'The retained cutover broker storage ACL intent is inconsistent.'
                }
            }
        }
        return
    }
    if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($profilePath)) -cne
            [Convert]::ToBase64String([byte[]]$State.profileBytes) -or
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $profilePath -ErrorAction Stop).Sddl -cne
            [string]$State.profileSddl) {
        throw 'The cutover broker profile did not return to its byte-exact ACL preimage.'
    }
    foreach ($directoryAcl in @($State.directoryAcls)) {
        $directoryPath = Assert-DysonPlainDirectory -Path ([string]$directoryAcl.path)
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directoryPath -ErrorAction Stop).Sddl -cne
            [string]$directoryAcl.sddl) {
            throw 'A cutover broker storage directory did not return to its exact ACL preimage.'
        }
    }
    $binding = [System.IO.File]::ReadAllText(
        $bindingPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json -ErrorAction Stop
    if ([string]$binding.profileFingerprint -cne [string]$State.profile.profileFingerprint -or
        [string]$binding.brokerBundleSha256 -cne [string]$State.binding.brokerBundleSha256 -or
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($bindingPath)) -cne
            [Convert]::ToBase64String([byte[]]$State.bindingBytes) -or
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $bindingPath -ErrorAction Stop).Sddl -cne
            [string]$State.bindingSddl) {
        throw 'The cutover broker bundle binding did not return to its previous release.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.taskIntentPath)) -cne
                [Convert]::ToBase64String([byte[]]$State.taskIntentBytes) -or
            [Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$State.directoryAclIntentPath)) -cne
                [Convert]::ToBase64String([byte[]]$State.directoryAclIntentBytes)) {
            throw 'The cutover broker shadow task/enabled/ACL preimage was not restored exactly.'
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
            throw 'The cutover broker task definition/enabled/DACL preimage was not restored exactly.'
        }
    }
    if ($DeferFullContract) { return }
    $validationActiveRelease = [pscustomobject][ordered]@{
        pointer = [pscustomobject][ordered]@{ version = [string]$State.activeVersion }
        releaseRoot = [string]$State.activeReleaseRoot
    }
    $validatedState = Get-DysonCutoverBrokerDeploymentPreimage -DeploymentDataRoot $DeploymentDataRoot `
        -ActiveRelease $validationActiveRelease -ShadowRoot $ShadowRoot
    if ($null -eq $validatedState -or
        [string]$validatedState.profile.profileFingerprint -cne [string]$State.profile.profileFingerprint -or
        [string]$validatedState.binding.brokerBundleSha256 -cne [string]$State.binding.brokerBundleSha256) {
        throw 'The restored cutover broker state did not pass the full profile/bundle/pending/task contract.'
    }
}

function Set-DysonCutoverBrokerDeploymentFileBytesAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Bytes)

    $destination = Assert-DysonDeploymentPlainFile -Path $Path -MaximumBytes 32768 `
        -Message 'A restored cutover broker state file is unavailable or redirected.'
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

function Restore-DysonCutoverBrokerDeploymentFileAcls {
    param([Parameter(Mandatory)]$State)

    foreach ($directoryAcl in @($State.directoryAcls)) {
        $path = Assert-DysonPlainDirectory -Path ([string]$directoryAcl.path)
        Restore-DysonDeploymentDirectorySecurityPreimage -Path $path -Sddl ([string]$directoryAcl.sddl)
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path -ErrorAction Stop).Sddl -cne
            [string]$directoryAcl.sddl) {
            throw 'A restored cutover broker storage directory did not return to its exact ACL preimage.'
        }
    }
    foreach ($binding in @(
        @([string]$State.profilePath, [byte[]]$State.profileBytes, [string]$State.profileSddl),
        @([string]$State.bindingPath, [byte[]]$State.bindingBytes, [string]$State.bindingSddl)
    )) {
        Set-DysonCutoverBrokerDeploymentFileBytesAtomic `
            -Path ([string]$binding[0]) -Bytes ([byte[]]$binding[1])
        $path = Assert-DysonDeploymentPlainFile -Path ([string]$binding[0]) -MaximumBytes 32768 `
            -Message 'A restored cutover broker state file is unavailable or redirected.'
        Restore-DysonDeploymentFileSecurityPreimage -Path $path -Sddl ([string]$binding[2])
        $restoredSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path -ErrorAction Stop).Sddl
        if ($restoredSddl -cne [string]$binding[2]) {
            throw 'A restored cutover broker state file did not return to its exact ACL preimage.'
        }
    }
}

function Restore-DysonCutoverBrokerDeploymentTaskPreimage {
    param([Parameter(Mandatory)]$State, [string]$ShadowRoot)

    if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) { return }
    Register-ScheduledTask -TaskName 'Dyson-Control-Cutover-Broker' -TaskPath '\' `
        -Xml ([string]$State.taskXml) -Force -ErrorAction Stop | Out-Null
    Restore-DysonFixedTaskSecurityDescriptor -TaskName 'Dyson-Control-Cutover-Broker' `
        -TaskPath '\' -Sddl ([string]$State.taskSddl)
}

function Invoke-DysonCutoverBrokerDeploymentInstaller {
    param(
        [Parameter(Mandatory)][string]$Installer,
        [Parameter(Mandatory)][hashtable]$Arguments,
        [string]$ShadowRoot
    )

    $previousSelfTestMarker = [System.Environment]::GetEnvironmentVariable(
        'DYSON_CUTOVER_BROKER_SELFTEST', [System.EnvironmentVariableTarget]::Process
    )
    try {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST', '1', [System.EnvironmentVariableTarget]::Process
            )
        }
        $output = & $Installer @Arguments
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST', $previousSelfTestMarker,
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
    $receipt = ConvertFrom-DysonCutoverBrokerInstallerOutput $output
    if ($receipt.PSObject.Properties.Name -contains 'ok' -and $receipt.ok -eq $false) {
        $code = [string]$receipt.error.code
        if ($code -notmatch '^DYSON_CONTROL_CUTOVER_BROKER_[A-Z0-9_]+$') {
            $code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
        }
        throw "Cutover broker compensation failed: $code."
    }
    return $receipt
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

function Assert-DysonCutoverBrokerEnvironment {
    param(
        [Parameter(Mandatory)][hashtable]$Configured,
        [Parameter(Mandatory)][string]$ExpectedProjectRoot,
        [Parameter(Mandatory)][string]$ExpectedDataDirectory,
        [Parameter(Mandatory)][string]$ExpectedAuthorityProfileFile,
        [Parameter(Mandatory)][string]$ExpectedRuntimeTaskTransactionRoot,
        [Parameter(Mandatory)][string]$ExpectedServiceUser,
        [Parameter(Mandatory)][int]$ExpectedGamePort
    )

    foreach ($required in @(
        'DYSON_PROVIDER',
        'DYSON_LIFECYCLE_ENABLED',
        'DYSON_CUTOVER_ENABLED',
        'DYSON_CUTOVER_RECOVERY_ENABLED',
        'DYSON_PROJECT_ROOT',
        'DYSON_DATA_DIR',
        'DYSON_CUTOVER_PROFILE_FILE',
        'DYSON_CUTOVER_TASK_TRANSACTION_ROOT',
        'DYSON_CUTOVER_SERVICE_USER',
        'DYSON_GAME_PORT'
    )) {
        if (-not $Configured.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$Configured[$required])) {
            throw "Cutover broker installation requires an explicit $required value."
        }
    }
    if ([string]$Configured['DYSON_PROVIDER'] -cne 'windows' -or
        [string]$Configured['DYSON_LIFECYCLE_ENABLED'] -cne 'true' -or
        [string]$Configured['DYSON_CUTOVER_ENABLED'] -cne 'true' -or
        [string]$Configured['DYSON_CUTOVER_RECOVERY_ENABLED'] -cne 'true') {
        throw 'Cutover broker installation requires the Windows lifecycle, CUTOVER, and CUTOVER_RECOVERY configuration gates.'
    }
    foreach ($binding in @(
        @('DYSON_PROJECT_ROOT', $ExpectedProjectRoot),
        @('DYSON_DATA_DIR', $ExpectedDataDirectory),
        @('DYSON_CUTOVER_PROFILE_FILE', $ExpectedAuthorityProfileFile),
        @('DYSON_CUTOVER_TASK_TRANSACTION_ROOT', $ExpectedRuntimeTaskTransactionRoot)
    )) {
        if (-not (Test-DysonDeploymentSamePath -Left ([string]$Configured[[string]$binding[0]]) -Right ([string]$binding[1]))) {
            throw "Cutover broker installation configuration does not match $($binding[0])."
        }
    }
    if ([string]$Configured['DYSON_CUTOVER_SERVICE_USER'] -cne $ExpectedServiceUser -or
        [string]$Configured['DYSON_GAME_PORT'] -cnotmatch '^[1-9][0-9]{0,4}$' -or
        [int]$Configured['DYSON_GAME_PORT'] -ne $ExpectedGamePort) {
        throw 'Cutover broker installation configuration does not match the service-user or game-port binding.'
    }
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
if ($InstallCutoverBrokerTask -and -not $InstallLifecycleBrokerTask) {
    throw 'Cutover broker installation requires lifecycle broker installation in the same deployment transaction.'
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

$cutoverBrokerParameterNames = @(
    'CutoverProjectRoot',
    'CutoverAuthorityProfileFile',
    'CutoverAuthorityInventoryRevision',
    'CutoverRuntimeTaskTransactionRoot',
    'CutoverServiceUser',
    'CutoverGamePort',
    'CutoverRuntimeBootstrapRoot',
    'UpgradeCutoverBrokerExisting',
    'SelfTestCutoverBrokerShadowRoot'
)
if (-not $InstallCutoverBrokerTask) {
    foreach ($parameterName in $cutoverBrokerParameterNames) {
        if ($PSBoundParameters.ContainsKey($parameterName)) {
            throw 'Cutover broker installation parameters require -InstallCutoverBrokerTask.'
        }
    }
}

$cutoverProjectFull = $null
$cutoverAuthorityProfileFull = $null
$cutoverRuntimeTaskTransactionFull = $null
$cutoverRuntimeBootstrapFull = $null
$cutoverBrokerShadowFull = $null
if ($InstallCutoverBrokerTask) {
    if (-not $configurationFull) {
        throw 'Cutover broker installation requires an explicit ConfigurationSource.'
    }
    foreach ($requiredParameter in @(
        @('CutoverProjectRoot', $CutoverProjectRoot),
        @('CutoverAuthorityProfileFile', $CutoverAuthorityProfileFile),
        @('CutoverAuthorityInventoryRevision', $CutoverAuthorityInventoryRevision),
        @('CutoverRuntimeTaskTransactionRoot', $CutoverRuntimeTaskTransactionRoot),
        @('CutoverServiceUser', $CutoverServiceUser),
        @('CutoverRuntimeBootstrapRoot', $CutoverRuntimeBootstrapRoot)
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$requiredParameter[1])) {
            throw "Cutover broker installation requires an explicit $($requiredParameter[0])."
        }
    }
    if ($null -eq $CutoverGamePort -or [int]$CutoverGamePort -lt 1 -or [int]$CutoverGamePort -gt 65535) {
        throw 'Cutover broker installation requires an explicit CutoverGamePort from 1 through 65535.'
    }
    if ($CutoverAuthorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$') {
        throw 'CutoverAuthorityInventoryRevision must be a lowercase SHA-256 value.'
    }
    if ($CutoverServiceUser -notmatch '^[^"\r\n]{3,128}$' -or $CutoverServiceUser.Trim() -cne $CutoverServiceUser) {
        throw 'CutoverServiceUser is invalid.'
    }
    $cutoverProjectFull = Assert-DysonPlainDirectory -Path $CutoverProjectRoot
    $cutoverAuthorityProfileFull = Assert-DysonDeploymentPlainFile -Path $CutoverAuthorityProfileFile `
        -MaximumBytes 262144 -Message 'CutoverAuthorityProfileFile must be a plain, non-empty file no larger than 262144 bytes.'
    $cutoverRuntimeTaskTransactionFull = Assert-DysonPlainDirectory -Path $CutoverRuntimeTaskTransactionRoot
    $cutoverRuntimeBootstrapFull = Get-DysonFullPath -Path $CutoverRuntimeBootstrapRoot
    $expectedRuntimeBootstrapRoot = Join-Path $installFull 'bootstrap'
    if (-not (Test-DysonDeploymentSamePath -Left $cutoverRuntimeBootstrapFull -Right $expectedRuntimeBootstrapRoot)) {
        throw 'CutoverRuntimeBootstrapRoot must be the stable bootstrap directory under InstallRoot.'
    }
    if (Test-Path -LiteralPath $cutoverRuntimeBootstrapFull) {
        [void](Assert-DysonPlainDirectory -Path $cutoverRuntimeBootstrapFull)
    }

    $sourceEnvironment = Read-DysonDeploymentEnvironmentFile -Path $configurationFull
    $brokerEnvironmentArguments = @{
        ExpectedProjectRoot = $cutoverProjectFull
        ExpectedDataDirectory = (Join-Path $dataFull 'data')
        ExpectedAuthorityProfileFile = $cutoverAuthorityProfileFull
        ExpectedRuntimeTaskTransactionRoot = $cutoverRuntimeTaskTransactionFull
        ExpectedServiceUser = $CutoverServiceUser
        ExpectedGamePort = [int]$CutoverGamePort
    }
    Assert-DysonCutoverBrokerEnvironment -Configured $sourceEnvironment @brokerEnvironmentArguments
    if ((Test-Path -LiteralPath $prospectiveConfigurationPath -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $dataFull 'data\cutover-broker\broker-profile.json') -PathType Leaf)) {
        $installedEnvironment = Read-DysonDeploymentEnvironmentFile -Path $prospectiveConfigurationPath
        Assert-DysonCutoverBrokerEnvironment -Configured $installedEnvironment @brokerEnvironmentArguments
    }

    if ($SelfTestCutoverBrokerShadowRoot) {
        if (-not $SelfTestSkipAdministratorCheck) {
            throw 'The cutover broker shadow scheduler is reserved for the isolated deployment self-test.'
        }
        $cutoverBrokerShadowFull = Assert-DysonPlainDirectory -Path $SelfTestCutoverBrokerShadowRoot
        $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
        $requiredPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-deployment-selftest-'
        if (-not $cutoverBrokerShadowFull.TrimEnd('\', '/').StartsWith(
            $requiredPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or -not (Test-Path -LiteralPath (Join-Path $cutoverBrokerShadowFull '.dyson-cutover-broker-selftest') -PathType Leaf)) {
            throw 'The cutover broker shadow scheduler is outside the isolated deployment self-test root.'
        }
    }
    elseif ($SelfTestSkipAdministratorCheck) {
        throw 'The isolated cutover broker deployment self-test requires a shadow scheduler root.'
    }
    if (-not (Test-DysonDeploymentSamePath $cutoverProjectFull $lifecycleProjectFull) -or
        -not (Test-DysonDeploymentSamePath $cutoverRuntimeBootstrapFull $lifecycleRuntimeBootstrapFull) -or
        [string]$CutoverServiceUser -cne [string]$ServiceUser -or
        [int]$CutoverGamePort -ne [int]$GamePort) {
        throw 'Cutover and lifecycle broker parameters must share the same project, bootstrap, service-user, and game-port binding.'
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

$cutoverBrokerPreflightState = Get-DysonCutoverBrokerDeploymentPreimage `
    -DeploymentDataRoot $dataFull -ActiveRelease $preflightActiveRelease `
    -ShadowRoot $cutoverBrokerShadowFull
if ($null -ne $cutoverBrokerPreflightState -and -not $InstallCutoverBrokerTask) {
    throw 'An installed cutover broker requires explicit broker handling for a control-plane release change.'
}
Assert-DysonBrokerUpgradeIntent -Kind cutover -Requested ([bool]$InstallCutoverBrokerTask) `
    -UpgradeRequested ([bool]$UpgradeCutoverBrokerExisting) `
    -State $cutoverBrokerPreflightState -TargetVersion $Version
Assert-DysonCutoverBrokerDeploymentBinding -State $cutoverBrokerPreflightState `
    -ProjectRoot $cutoverProjectFull -DataRoot (Join-Path $dataFull 'data') `
    -AuthorityProfileFile $cutoverAuthorityProfileFull `
    -AuthorityInventoryRevision $CutoverAuthorityInventoryRevision `
    -RuntimeBootstrapRoot $cutoverRuntimeBootstrapFull `
    -RuntimeTaskTransactionRoot $cutoverRuntimeTaskTransactionFull `
    -ServiceUser $CutoverServiceUser -GamePort $CutoverGamePort

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
        cutoverBrokerTaskRequested = [bool]$InstallCutoverBrokerTask
        cutoverBrokerUpgradeExistingRequested = [bool]$UpgradeCutoverBrokerExisting
        cutoverBrokerConfigurationValidated = [bool]$InstallCutoverBrokerTask
        cutoverBrokerTaskName = if ($InstallCutoverBrokerTask) { 'Dyson-Control-Cutover-Broker' } else { $null }
        existingConfigurationProtectedForRollback = [bool](
            $null -ne $configurationPreflight.existing
        )
        persistentCutoverDataWillBeCreated = $true
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](Test-DysonNodeRuntime -RuntimeRoot $runtimeFull -NodeExecutable $nodePath `
    -ExpectedNodeSha256 $ExpectedNodeSha256 -InstallRoot $installFull -DataRoot $dataFull `
    -MinimumMajor $sourceArtifactVerification.nodeMinimumMajor)

if (($RegisterStartupTask -or $InstallLifecycleBrokerTask -or $InstallCutoverBrokerTask -or
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
$cutoverBrokerInstallReceipt = $null
$cutoverBrokerInstallArguments = $null
$cutoverBrokerInstaller = $null
$cutoverBrokerPreviousState = $null
$activeReleaseBeforeInstall = $null
try {
    if ($RegisterStartupTask -and ($InstallLifecycleBrokerTask -or $InstallCutoverBrokerTask)) {
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
    $cutoverBrokerPreviousState = Get-DysonCutoverBrokerDeploymentPreimage `
        -DeploymentDataRoot $dataFull -ActiveRelease $activeReleaseBeforeInstall `
        -ShadowRoot $cutoverBrokerShadowFull
    Assert-DysonBrokerPreflightStateUnchanged -Before $cutoverBrokerPreflightState `
        -After $cutoverBrokerPreviousState -Kind cutover
    if ($null -ne $cutoverBrokerPreviousState -and -not $InstallCutoverBrokerTask) {
        throw 'An installed cutover broker requires explicit broker handling for a control-plane release change.'
    }
    Assert-DysonBrokerUpgradeIntent -Kind cutover -Requested ([bool]$InstallCutoverBrokerTask) `
        -UpgradeRequested ([bool]$UpgradeCutoverBrokerExisting) `
        -State $cutoverBrokerPreviousState -TargetVersion $Version
    Assert-DysonCutoverBrokerDeploymentBinding -State $cutoverBrokerPreviousState `
        -ProjectRoot $cutoverProjectFull -DataRoot (Join-Path $dataFull 'data') `
        -AuthorityProfileFile $cutoverAuthorityProfileFull `
        -AuthorityInventoryRevision $CutoverAuthorityInventoryRevision `
        -RuntimeBootstrapRoot $cutoverRuntimeBootstrapFull `
        -RuntimeTaskTransactionRoot $cutoverRuntimeTaskTransactionFull `
        -ServiceUser $CutoverServiceUser -GamePort $CutoverGamePort
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
    foreach ($relative in @('data', 'data\cutover', 'logs', 'state', 'snapshots', 'audit')) {
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
        [ordered]@{ source = Join-Path $gameBootstrapSourceRoot 'DysonGameLifecycleBootstrap.Common.ps1'; destination = 'DysonGameLifecycleBootstrap.Common.ps1' },
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
    if ($InstallCutoverBrokerTask) {
        $activeRelease = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
        if ($null -eq $activeRelease -or [string]$activeRelease.pointer.version -cne $Version) {
            throw 'The cutover broker cannot bind to an unverified active release.'
        }
        $cutoverScriptRoot = Assert-DysonPlainDirectory -Path (Join-Path $activeRelease.releaseRoot 'scripts\windows')
        $cutoverBrokerScriptRoot = Assert-DysonPlainDirectory -Path (Join-Path $cutoverScriptRoot 'cutover-broker')
        $cutoverBrokerInstaller = Assert-DysonDeploymentPlainFile `
            -Path (Join-Path $cutoverBrokerScriptRoot 'Install-DysonCutoverBrokerTask.ps1') `
            -MaximumBytes 1048576 `
            -Message 'The active release cutover broker installer is unavailable, redirected, empty, or too large.'
        $cutoverBrokerRequestId = [guid]::NewGuid().ToString('D')
        $cutoverBrokerDataRoot = Join-Path $dataFull 'data'
        $cutoverBrokerRoot = Join-Path $cutoverBrokerDataRoot 'cutover-broker'
        $cutoverBrokerInstallArguments = @{
            RequestId = $cutoverBrokerRequestId
            BrokerRoot = $cutoverBrokerRoot
            BrokerScriptRoot = $cutoverBrokerScriptRoot
            ProjectRoot = $cutoverProjectFull
            DataRoot = $cutoverBrokerDataRoot
            AuthorityProfileFile = $cutoverAuthorityProfileFull
            AuthorityInventoryRevision = $CutoverAuthorityInventoryRevision
            CutoverScriptRoot = $cutoverScriptRoot
            RuntimeBootstrapRoot = $cutoverRuntimeBootstrapFull
            RuntimeTaskTransactionRoot = $cutoverRuntimeTaskTransactionFull
            ServiceUser = $CutoverServiceUser
            GamePort = [int]$CutoverGamePort
            TaskName = 'Dyson-Control-Cutover-Broker'
            Confirm = $false
        }
        if ($UpgradeCutoverBrokerExisting) {
            $cutoverBrokerInstallArguments['UpgradeExisting'] = $true
        }
        if ($cutoverBrokerShadowFull) {
            $cutoverBrokerInstallArguments['SchedulerBackend'] = 'Shadow'
            $cutoverBrokerInstallArguments['ShadowRoot'] = $cutoverBrokerShadowFull
        }

        $previousBrokerSelfTestMarker = [System.Environment]::GetEnvironmentVariable(
            'DYSON_CUTOVER_BROKER_SELFTEST',
            [System.EnvironmentVariableTarget]::Process
        )
        try {
            if ($cutoverBrokerShadowFull) {
                [System.Environment]::SetEnvironmentVariable(
                    'DYSON_CUTOVER_BROKER_SELFTEST',
                    '1',
                    [System.EnvironmentVariableTarget]::Process
                )
            }
            $cutoverBrokerOutput = & $cutoverBrokerInstaller @cutoverBrokerInstallArguments
        }
        finally {
            if ($cutoverBrokerShadowFull) {
                [System.Environment]::SetEnvironmentVariable(
                    'DYSON_CUTOVER_BROKER_SELFTEST',
                    $previousBrokerSelfTestMarker,
                    [System.EnvironmentVariableTarget]::Process
                )
            }
        }
        $cutoverBrokerLines = @(
            ($cutoverBrokerOutput | Out-String) -split "`r?`n" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if ($cutoverBrokerLines.Count -eq 0) { throw 'The cutover broker task installer returned no receipt.' }
        $candidateCutoverBrokerInstallReceipt = $cutoverBrokerLines[$cutoverBrokerLines.Count - 1] |
            ConvertFrom-Json -ErrorAction Stop
        if ($candidateCutoverBrokerInstallReceipt.PSObject.Properties.Name -contains 'ok' -and
            $candidateCutoverBrokerInstallReceipt.ok -eq $false) {
            $brokerFailureCode = [string]$candidateCutoverBrokerInstallReceipt.error.code
            if ($brokerFailureCode -notmatch '^DYSON_CONTROL_CUTOVER_BROKER_[A-Z0-9_]+$') {
                $brokerFailureCode = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
            }
            if ($cutoverBrokerShadowFull) {
                $brokerStageLog = Join-Path $cutoverBrokerShadowFull 'install-stage.log'
                $brokerLastStage = if (Test-Path -LiteralPath $brokerStageLog -PathType Leaf) {
                    @([System.IO.File]::ReadAllLines($brokerStageLog, [System.Text.Encoding]::UTF8) |
                        Where-Object { -not [string]::IsNullOrWhiteSpace($_) })[-1]
                }
                else { 'before-dependencies-loaded' }
                throw "Cutover broker task installation failed: $brokerFailureCode at isolated self-test stage $brokerLastStage."
            }
            throw "Cutover broker task installation failed: $brokerFailureCode."
        }
        Assert-DysonLifecycleBrokerDeploymentExactProperties -Value $candidateCutoverBrokerInstallReceipt `
            -Names @(
                'protocol', 'schemaVersion', 'requestId', 'operation', 'profileFingerprint',
                'brokerBundleSha256', 'taskName', 'taskPath', 'taskSddlSha256', 'status',
                'reused', 'upgraded', 'previousProfileFingerprint', 'transactionId', 'completedAt'
            ) -Message 'The cutover broker task installer returned an unsupported receipt.'
        $completedAt = [datetimeoffset]::MinValue
        if ([string]$candidateCutoverBrokerInstallReceipt.protocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -or
            [int]$candidateCutoverBrokerInstallReceipt.schemaVersion -ne 1 -or
            [string]$candidateCutoverBrokerInstallReceipt.requestId -cne $cutoverBrokerRequestId -or
            [string]$candidateCutoverBrokerInstallReceipt.operation -cnotin @('installed', 'upgraded', 'reused') -or
            [string]$candidateCutoverBrokerInstallReceipt.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$candidateCutoverBrokerInstallReceipt.brokerBundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$candidateCutoverBrokerInstallReceipt.taskName -cne 'Dyson-Control-Cutover-Broker' -or
            [string]$candidateCutoverBrokerInstallReceipt.taskPath -cne '\' -or
            [string]$candidateCutoverBrokerInstallReceipt.taskSddlSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$candidateCutoverBrokerInstallReceipt.status -cne 'succeeded' -or
            $candidateCutoverBrokerInstallReceipt.reused -isnot [bool] -or
            $candidateCutoverBrokerInstallReceipt.upgraded -isnot [bool] -or
            ([string]$candidateCutoverBrokerInstallReceipt.operation -ceq 'installed' -and
                ([bool]$candidateCutoverBrokerInstallReceipt.reused -or [bool]$candidateCutoverBrokerInstallReceipt.upgraded)) -or
            ([string]$candidateCutoverBrokerInstallReceipt.operation -ceq 'upgraded' -and
                (-not [bool]$candidateCutoverBrokerInstallReceipt.upgraded -or [bool]$candidateCutoverBrokerInstallReceipt.reused)) -or
            ([string]$candidateCutoverBrokerInstallReceipt.operation -ceq 'reused' -and
                (-not [bool]$candidateCutoverBrokerInstallReceipt.reused -or [bool]$candidateCutoverBrokerInstallReceipt.upgraded)) -or
            ([bool]$candidateCutoverBrokerInstallReceipt.upgraded -and
                ([string]$candidateCutoverBrokerInstallReceipt.previousProfileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
                    [string]$candidateCutoverBrokerInstallReceipt.transactionId -cne $cutoverBrokerRequestId)) -or
            -not [datetimeoffset]::TryParseExact(
                [string]$candidateCutoverBrokerInstallReceipt.completedAt,
                'o',
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind,
                [ref]$completedAt
            )) {
            throw 'The cutover broker task installer returned an unsupported receipt.'
        }
        $expectedCutoverBrokerOperation = if ($null -eq $cutoverBrokerPreviousState) {
            'installed'
        }
        elseif ([string]$cutoverBrokerPreviousState.activeVersion -ceq $Version) {
            'reused'
        }
        else { 'upgraded' }
        if ([string]$candidateCutoverBrokerInstallReceipt.operation -cne $expectedCutoverBrokerOperation -or
            ($expectedCutoverBrokerOperation -ceq 'upgraded' -and
                [string]$candidateCutoverBrokerInstallReceipt.previousProfileFingerprint -cne
                    [string]$cutoverBrokerPreviousState.profile.profileFingerprint)) {
            throw 'The cutover broker installer operation does not match the captured deployment preimage and upgrade intent.'
        }
        if ($expectedCutoverBrokerOperation -ceq 'reused') {
            Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull
        }
        $cutoverBrokerInstallReceipt = $candidateCutoverBrokerInstallReceipt
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
        if ($InstallCutoverBrokerTask) { $requiredReadinessChecks += 'cutoverRecovery' }
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

    $cutoverBrokerStateRestored = $null -eq $cutoverBrokerInstallReceipt
    $cutoverBrokerRestoreDeferred = $false
    $cutoverBrokerFullValidationDeferred = $false
    if ($null -ne $cutoverBrokerInstallReceipt) {
        switch ([string]$cutoverBrokerInstallReceipt.operation) {
            'reused' {
                try {
                    Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                        -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull
                    $cutoverBrokerStateRestored = $true
                }
                catch { $rollbackFailures.Add('cutover-broker-reused-verification') }
            }
            'installed' {
                try {
                    $compensationArguments = @{}
                    foreach ($key in $cutoverBrokerInstallArguments.Keys) {
                        $compensationArguments[$key] = $cutoverBrokerInstallArguments[$key]
                    }
                    [void]$compensationArguments.Remove('UpgradeExisting')
                    $compensationArguments['RequestId'] = [guid]::NewGuid().ToString('D')
                    $compensationArguments['Operation'] = 'CompensateFirstInstall'
                    $compensationArguments['CompensateInstallRequestId'] = `
                        [string]$cutoverBrokerInstallReceipt.requestId
                    $compensationReceipt = Invoke-DysonCutoverBrokerDeploymentInstaller `
                        -Installer $cutoverBrokerInstaller -Arguments $compensationArguments `
                        -ShadowRoot $cutoverBrokerShadowFull
                    if ([string]$compensationReceipt.protocol -cne `
                            'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_RECEIPT_V1' -or
                        [int]$compensationReceipt.schemaVersion -ne 1 -or
                        [string]$compensationReceipt.operation -cne 'compensated-first-install' -or
                        [string]$compensationReceipt.installRequestId -cne `
                            [string]$cutoverBrokerInstallReceipt.requestId -or
                        [string]$compensationReceipt.profileFingerprint -cne `
                            [string]$cutoverBrokerInstallReceipt.profileFingerprint -or
                        -not [bool]$compensationReceipt.removed -or
                        [string]$compensationReceipt.status -cne 'succeeded') {
                        throw 'The cutover broker first-install compensation receipt is invalid.'
                    }
                    Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                        -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull
                    $cutoverBrokerStateRestored = $true
                }
                catch { $rollbackFailures.Add('cutover-broker-first-install-compensation') }
            }
            'upgraded' {
                if ($null -eq $cutoverBrokerPreviousState) {
                    $rollbackFailures.Add('cutover-broker-upgrade-preimage')
                }
                else { $cutoverBrokerRestoreDeferred = $true }
            }
            default { $rollbackFailures.Add('cutover-broker-operation') }
        }
    }
    elseif ($InstallCutoverBrokerTask) {
        try {
            $deferFullContract = $null -ne $cutoverBrokerPreviousState -and
                [string]$cutoverBrokerPreviousState.activeVersion -cne $Version
            Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull `
                -DeferFullContract:$deferFullContract
            $cutoverBrokerStateRestored = $true
            $cutoverBrokerFullValidationDeferred = $deferFullContract
        }
        catch { $rollbackFailures.Add('cutover-broker-install-rollback-verification') }
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
        ($cutoverBrokerStateRestored -or $cutoverBrokerRestoreDeferred) -and
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
        if (-not $cutoverBrokerStateRestored -and -not $cutoverBrokerRestoreDeferred) {
            $rollbackFailures.Add('deployment-state-blocked-by-cutover-broker')
        }
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
                    -ConfigurationModuleRoot $(
                        if ($SelfTestConfigurationShadowRoot) {
                            $configurationApplyModuleRoot
                        }
                        else { Join-Path $bootstrapRoot 'configuration' }
                    )
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
                $configurationRollbackFinalVerified = $true
            }
            catch { $rollbackFailures.Add('protected-configuration-final-verification:' + $_.Exception.Message) }
        }
        else { $rollbackFailures.Add('protected-configuration-final-verification-blocked') }
    }

    $taskDataAclPreimageRestored = $true

    if ($cutoverBrokerFullValidationDeferred) {
        if ($replacementTaskRemoved -and $deploymentStateRestored -and $bootstrapConfigurationRestored -and
            $configurationRollbackFinalVerified -and
            $taskDataAclPreimageRestored) {
            try {
                Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                    -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull
                $cutoverBrokerFullValidationDeferred = $false
            }
            catch {
                $cutoverBrokerStateRestored = $false
                $rollbackFailures.Add('cutover-broker-full-contract')
            }
        }
        else {
            $cutoverBrokerStateRestored = $false
            $rollbackFailures.Add('cutover-broker-full-contract-blocked')
        }
    }

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

    if ($cutoverBrokerRestoreDeferred) {
        if ($replacementTaskRemoved -and $deploymentStateRestored -and $bootstrapConfigurationRestored -and
            $configurationRollbackFinalVerified -and
            $taskDataAclPreimageRestored -and $lifecycleBrokerStateRestored) {
            try {
                $restoreArguments = @{}
                foreach ($key in $cutoverBrokerPreviousState.installArguments.Keys) {
                    $restoreArguments[$key] = $cutoverBrokerPreviousState.installArguments[$key]
                }
                $restoreArguments['RequestId'] = [guid]::NewGuid().ToString('D')
                $restoreArguments['UpgradeExisting'] = $true
                [void]$restoreArguments.Remove('Operation')
                [void]$restoreArguments.Remove('CompensateInstallRequestId')
                $restoreReceipt = Invoke-DysonCutoverBrokerDeploymentInstaller `
                    -Installer ([string]$cutoverBrokerPreviousState.installer) `
                    -Arguments $restoreArguments -ShadowRoot $cutoverBrokerShadowFull
                if ([string]$restoreReceipt.protocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -or
                    [int]$restoreReceipt.schemaVersion -ne 1 -or
                    [string]$restoreReceipt.operation -cne 'upgraded' -or
                    -not [bool]$restoreReceipt.upgraded -or [bool]$restoreReceipt.reused -or
                    [string]$restoreReceipt.profileFingerprint -cne `
                        [string]$cutoverBrokerPreviousState.profile.profileFingerprint -or
                    [string]$restoreReceipt.previousProfileFingerprint -cne `
                        [string]$cutoverBrokerInstallReceipt.profileFingerprint) {
                    throw 'The cutover broker rollback-to-previous-release receipt is invalid.'
                }
                Restore-DysonCutoverBrokerDeploymentFileAcls -State $cutoverBrokerPreviousState
                Restore-DysonCutoverBrokerDeploymentTaskPreimage -State $cutoverBrokerPreviousState `
                    -ShadowRoot $cutoverBrokerShadowFull
                Assert-DysonCutoverBrokerDeploymentPreimageRestored -DeploymentDataRoot $dataFull `
                    -State $cutoverBrokerPreviousState -ShadowRoot $cutoverBrokerShadowFull
                $cutoverBrokerStateRestored = $true
            }
            catch { $rollbackFailures.Add('cutover-broker-upgrade-compensation:' + $_.Exception.Message) }
        }
        else { $rollbackFailures.Add('cutover-broker-upgrade-compensation-blocked') }
    }

    if ($taskRollbackPrepared -and $replacementTaskRemoved -and $deploymentStateRestored -and
        $bootstrapConfigurationRestored -and $configurationRollbackFinalVerified -and
        $taskDataAclPreimageRestored -and
        $lifecycleBrokerStateRestored -and $cutoverBrokerStateRestored) {
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
    persistentCutoverDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data\cutover') -PathType Container
    lifecycleBrokerTaskRequested = [bool]$InstallLifecycleBrokerTask
    lifecycleBrokerOperation = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.operation } else { $null }
    lifecycleBrokerTaskInstalled = [bool]($null -ne $lifecycleBrokerInstallReceipt)
    lifecycleBrokerTaskName = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.workerTaskName } else { $null }
    lifecycleBrokerProfileHash = if ($lifecycleBrokerInstallReceipt) { [string]$lifecycleBrokerInstallReceipt.profileHash } else { $null }
    lifecycleBrokerReused = if ($lifecycleBrokerInstallReceipt) { [bool]$lifecycleBrokerInstallReceipt.reused } else { $null }
    lifecycleBrokerUpgraded = if ($lifecycleBrokerInstallReceipt) { [bool]$lifecycleBrokerInstallReceipt.upgraded } else { $null }
    lifecycleBrokerDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data\lifecycle-broker') -PathType Container
    cutoverBrokerTaskRequested = [bool]$InstallCutoverBrokerTask
    cutoverBrokerOperation = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.operation } else { $null }
    cutoverBrokerTaskInstalled = [bool]($null -ne $cutoverBrokerInstallReceipt)
    cutoverBrokerTaskName = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.taskName } else { $null }
    cutoverBrokerRequestId = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.requestId } else { $null }
    cutoverBrokerProfileFingerprint = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.profileFingerprint } else { $null }
    cutoverBrokerBundleSha256 = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.brokerBundleSha256 } else { $null }
    cutoverBrokerTaskSddlSha256 = if ($cutoverBrokerInstallReceipt) { [string]$cutoverBrokerInstallReceipt.taskSddlSha256 } else { $null }
    cutoverBrokerReused = if ($cutoverBrokerInstallReceipt) { [bool]$cutoverBrokerInstallReceipt.reused } else { $null }
    cutoverBrokerUpgraded = if ($cutoverBrokerInstallReceipt) { [bool]$cutoverBrokerInstallReceipt.upgraded } else { $null }
    cutoverBrokerDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data\cutover-broker') -PathType Container
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
