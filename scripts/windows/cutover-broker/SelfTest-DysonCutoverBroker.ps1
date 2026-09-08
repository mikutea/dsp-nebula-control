[CmdletBinding()]
param([switch]$FileAclOnly)

if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -FileAclOnly:$FileAclOnly
    exit $LASTEXITCODE
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$tests = [Collections.Generic.List[string]]::new()
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-cutover-broker-selftest-' + [guid]::NewGuid().ToString('N'))
$lease = $null
$priorSelfTest = $env:DYSON_CUTOVER_BROKER_SELFTEST
$priorChildMode = $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE
$priorInstallFailStage = $env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-SelfTestErrorCode {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$Expected
    )

    try { & $Action; throw ('Expected error ' + $Expected) }
    catch {
        $actual = Get-DysonCutoverBrokerErrorCode $_.Exception
        if ($actual -cne $Expected) {
            throw ('Expected {0}, received {1}: {2}' -f $Expected, $actual, $_.Exception.Message)
        }
    }
}

function Invoke-SelfTestPowerShell {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $output = @(& $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $Script @Arguments 2>&1)
    return [pscustomobject][ordered]@{
        exitCode = $LASTEXITCODE
        text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
}

function ConvertFrom-SelfTestEnvelope {
    param([Parameter(Mandatory)]$Invocation)
    try { return $Invocation.text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw ('Invocation did not return JSON. Exit={0}; output={1}' -f $Invocation.exitCode, $Invocation.text) }
}

function New-SelfTestAuthorityProfile {
    param(
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Data,
        [Parameter(Mandatory)][string]$AuthorityRoot,
        [Parameter(Mandatory)][string]$Bootstrap,
        [Parameter(Mandatory)][string]$Transactions,
        [Parameter(Mandatory)][string]$ServiceUser,
        [Parameter(Mandatory)][int]$GamePort
    )

    $taskProfile = {
        param([string]$Name, [string]$Digest)
        [pscustomobject][ordered]@{
            taskName = $Name
            taskPath = '\'
            definitionSha256 = $Digest
            enabled = $true
        }
    }
    $core = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'
        schemaVersion = 1
        requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        requestFingerprint = ('1' * 64)
        projectRootIdentity = Get-CutoverHostPathIdentity $Project
        dataRootIdentity = Get-DysonHostMutationDataRootIdentity $Data
        authorityRootIdentity = Get-CutoverHostPathIdentity $AuthorityRoot
        runtimeBootstrapIdentity = Get-CutoverHostPathIdentity $Bootstrap
        runtimeBootstrapStartSha256 = Get-CutoverHostSha256File (Join-Path $Bootstrap 'Start-DysonServer.ps1')
        runtimeBootstrapStopSha256 = Get-CutoverHostSha256File (Join-Path $Bootstrap 'Stop-DysonServer.ps1')
        runtimeTaskTransactionRootIdentity = Get-CutoverHostPathIdentity $Transactions
        serviceUser = $ServiceUser
        gamePort = $GamePort
        previousAuthority = [pscustomobject][ordered]@{
            main = & $taskProfile 'Dyson-GSManager' ('2' * 64)
            start = & $taskProfile 'Dyson-GSManager-Server' ('3' * 64)
            stop = & $taskProfile 'Dyson-GSManager-Stop' ('4' * 64)
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = 'Dyson-Nebula-Server'
            stopTaskName = 'Dyson-Nebula-Stop'
            taskPath = '\'
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = ('5' * 64)
                stopDefinitionSha256 = ('6' * 64)
                expectedEnabledBeforeIsolation = $true
                expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = ('7' * 64)
                stopDescriptorSha256 = ('8' * 64)
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = ('9' * 64)
                stopDescriptorSha256 = ('a' * 64)
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = ('b' * 64)
    }
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['inventoryRevision'] = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $core)
    return [pscustomobject]$profile
}

function Get-SelfTestSubmitArguments {
    param(
        [Parameter(Mandatory)][string]$BrokerRequestId,
        [Parameter(Mandatory)][string]$Capability,
        [Parameter(Mandatory)][string]$ChildRequestId,
        [Parameter(Mandatory)][string]$LeaseToken,
        [string]$CandidateMode,
        [switch]$CandidateRecover,
        [string]$ProjectOverride,
        [string]$RevisionOverride
    )

    $effectiveProject = if ([string]::IsNullOrWhiteSpace($ProjectOverride)) { $script:projectRoot } else { $ProjectOverride }
    $effectiveRevision = if ([string]::IsNullOrWhiteSpace($RevisionOverride)) { $script:inventoryRevision } else { $RevisionOverride }
    $arguments = @(
        '-BrokerRoot', $script:brokerRoot,
        '-BrokerProfileFile', $script:brokerProfileFile,
        '-BrokerRequestId', $BrokerRequestId,
        '-Capability', $Capability,
        '-RequestId', $ChildRequestId,
        '-AuthorityInventoryRevision', $effectiveRevision,
        '-ProjectRoot', $effectiveProject,
        '-DataRoot', $script:dataRoot,
        '-AuthorityProfileFile', $script:authorityProfileFile,
        '-CutoverScriptRoot', $script:cutoverScriptRoot,
        '-RuntimeBootstrapRoot', $script:bootstrapRoot,
        '-RuntimeTaskTransactionRoot', $script:transactionRoot,
        '-ServiceUser', $script:serviceUser,
        '-GamePort', ([string]$script:gamePort),
        '-LeaseInstanceId', $script:lease.InstanceId,
        '-LeaseToken', $LeaseToken,
        '-TimeoutSeconds', '30',
        '-SchedulerBackend', 'Shadow',
        '-ShadowRoot', $script:shadowRoot
    )
    if (-not [string]::IsNullOrWhiteSpace($CandidateMode)) {
        $arguments += @('-CandidateMode', $CandidateMode)
    }
    if ($CandidateRecover) { $arguments += '-CandidateRecover' }
    return $arguments
}

function Get-SelfTestInstallArguments {
    param(
        [Parameter(Mandatory)][string]$InstallRequestId,
        [Parameter(Mandatory)][string]$BrokerScripts,
        [Parameter(Mandatory)][string]$CutoverRoot,
        [switch]$UpgradeExisting
    )

    $arguments = @(
        '-RequestId', $InstallRequestId,
        '-BrokerRoot', $script:brokerRoot,
        '-BrokerScriptRoot', $BrokerScripts,
        '-ProjectRoot', $script:projectRoot,
        '-DataRoot', $script:dataRoot,
        '-AuthorityProfileFile', $script:authorityProfileFile,
        '-AuthorityInventoryRevision', $script:inventoryRevision,
        '-CutoverScriptRoot', $CutoverRoot,
        '-RuntimeBootstrapRoot', $script:bootstrapRoot,
        '-RuntimeTaskTransactionRoot', $script:transactionRoot,
        '-ServiceUser', $script:serviceUser,
        '-GamePort', ([string]$script:gamePort),
        '-SchedulerBackend', 'Shadow',
        '-ShadowRoot', $script:shadowRoot
    )
    if ($UpgradeExisting) { $arguments += '-UpgradeExisting' }
    return $arguments
}

function Test-SelfTestNativeAtomicFileAcl {
    $parseErrors = $null; $parseTokens = $null
    $installerAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'Install-DysonCutoverBrokerTask.ps1'), [ref]$parseTokens, [ref]$parseErrors)
    Assert-SelfTest ($parseErrors.Count -eq 0) 'Installer parse failed.'
    $atomicFunction = $installerAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-InstallerFileAtomic'
    }, $false)
    . ([scriptblock]::Create($atomicFunction.Extent.Text))
    $root = Join-Path $fixtureRoot 'native-file-acl'
    [void][IO.Directory]::CreateDirectory($root)
    $rawDriftCases = 0
    foreach ($protected in @($false, $true)) {
        foreach ($autoInherited in @($false, $true)) {
            $path = Join-Path $root ('file-' + $protected + '-' + $autoInherited + '.json')
            [IO.File]::WriteAllText($path, 'original')
            $acl = Get-Acl -LiteralPath $path
            if ($protected) { $acl.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath $path -AclObject $acl }
            $initial = (Get-Acl -LiteralPath $path).Sddl
            # Load the native helper, then independently establish the descriptor
            # variants that File.Replace must preserve (including a legacy D:).
            Restore-DysonCutoverBrokerFileSecurityPreimage -Path $path -Sddl $initial
            $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($initial)
            $flags = $descriptor.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)
            if ($autoInherited) { $flags = $flags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired }
            $descriptor.SetFlags($flags)
            $binary = [byte[]]::new($descriptor.BinaryLength); $descriptor.GetBinaryForm($binary, 0)
            Assert-SelfTest ([DysonControl.CutoverBrokerFileAclRestore]::SetFileSecurityW($path, 7, $binary)) 'Native file fixture ACL initialization failed.'
            $before = (Get-Acl -LiteralPath $path).Sddl
            $temporary = $path + '.raw'; $backup = $path + '.backup'
            [IO.File]::WriteAllText($temporary, 'raw-replacement')
            [IO.File]::Replace($temporary, $path, $backup)
            if ((Get-Acl -LiteralPath $path).Sddl -cne $before) { $rawDriftCases++ }
            Restore-DysonCutoverBrokerFileSecurityPreimage -Path $path -Sddl $before
            [IO.File]::Delete($backup)
            foreach ($content in @('candidate', 'original')) {
                Set-InstallerFileAtomic -Path $path -Bytes ([Text.Encoding]::UTF8.GetBytes($content)) -MaximumBytes 4096
                Assert-SelfTest ((Get-Acl -LiteralPath $path).Sddl -ceq $before -and
                    [IO.File]::ReadAllText($path) -ceq $content) 'Atomic replacement/rollback changed exact file bytes or ACL.'
            }
            Assert-SelfTestErrorCode { Set-InstallerFileAtomic -Path $path -Bytes ([byte[]]@(1,2)) -MaximumBytes 1 } 'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE'
            Assert-SelfTest ((Get-Acl -LiteralPath $path).Sddl -ceq $before -and
                [IO.File]::ReadAllText($path) -ceq 'original') 'Rejected atomic write changed the file preimage.'
        }
    }
    Assert-SelfTest ($rawDriftCases -gt 0) 'Native File.Replace ACL drift was not reproduced.'
    $tests.Add('native-file-replace-exact-acl-forward-rollback-and-rejection')
}

function Test-SelfTestNativeChildExitCode {
    $worker = Join-Path $PSScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$parseErrors)
    Assert-SelfTest ($parseErrors.Count -eq 0) 'The worker must parse before native child validation.'
    foreach ($name in @('ConvertTo-WorkerCommandLineArgument', 'Invoke-WorkerBoundedChild')) {
        $definitions = @($ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
        }, $true))
        Assert-SelfTest ($definitions.Count -eq 1) 'The native child helper binding is ambiguous.'
        . ([scriptblock]::Create($definitions[0].Extent.Text))
    }
    $root = Join-Path $fixtureRoot 'native-child'
    [void][IO.Directory]::CreateDirectory($root)
    $child = Join-Path $root 'child.ps1'
    $source = @'
param([int]$ExitStatus)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Write-Output '{"ok":true}'
exit $ExitStatus
'@
    [IO.File]::WriteAllText($child, $source, [Text.UTF8Encoding]::new($false))
    $result = Invoke-WorkerBoundedChild -ScriptPath $child -ChildArguments @('-ExitStatus', '0') -WorkRoot $root -TimeoutSeconds 10
    Assert-SelfTest ($result.ok -eq $true) 'A successful native child was not accepted.'
    Assert-SelfTestErrorCode {
        Invoke-WorkerBoundedChild -ScriptPath $child -ChildArguments @('-ExitStatus', '7') -WorkRoot $root -TimeoutSeconds 10
    } 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
    Assert-SelfTest (@(Get-ChildItem $root -File | Where-Object Extension -in @('.stdout', '.stderr')).Count -eq 0) 'Native child output was not cleaned.'
    $tests.Add('native-child-success-exit-and-nonzero-exit')
}

try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    $commonPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.Common.ps1'
    $aclPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.TaskAcl.ps1'
    . $commonPath
    . $aclPath
    Test-SelfTestNativeAtomicFileAcl
    if ($FileAclOnly) {
        [pscustomobject]@{ protocol = 'DYSON_CONTROL_CUTOVER_BROKER_FILE_ACL_SELFTEST_V1'; status = 'passed'; tests = @($tests) } | ConvertTo-Json -Compress
        exit 0
    }
    Test-SelfTestNativeChildExitCode
    $script:cutoverScriptRoot = Assert-DysonCutoverBrokerPlainDirectory (Split-Path $PSScriptRoot -Parent)
    $leaseCommon = Join-Path $script:cutoverScriptRoot 'DysonHostMutationLease.Common.ps1'
    $hostCommon = Join-Path $script:cutoverScriptRoot 'cutover\DysonCutoverHost.Common.ps1'
    . $leaseCommon
    . $hostCommon

    $script:projectRoot = Join-Path $fixtureRoot 'project'
    $script:dataRoot = Join-Path $fixtureRoot 'data'
    $script:bootstrapRoot = Join-Path $fixtureRoot 'bootstrap'
    $script:transactionRoot = Join-Path $fixtureRoot 'runtime-task-transactions'
    $authorityRoot = Join-Path $script:dataRoot 'authority-inventory'
    $script:authorityProfileFile = Join-Path $authorityRoot 'authority-profile.json'
    $script:brokerRoot = Join-Path $script:dataRoot 'cutover-broker'
    $script:brokerProfileFile = Join-Path $script:brokerRoot 'broker-profile.json'
    $script:shadowRoot = Join-Path $fixtureRoot 'shadow'
    $otherProject = Join-Path $fixtureRoot 'other-project'
    $script:serviceUser = 'FictionalDysonService'
    $script:gamePort = 8469
    foreach ($directory in @(
        $script:projectRoot, (Join-Path $script:projectRoot 'server'), $script:dataRoot,
        $script:bootstrapRoot, $script:transactionRoot, $authorityRoot, $script:shadowRoot, $otherProject
    )) { [void][IO.Directory]::CreateDirectory($directory) }
    [IO.File]::WriteAllText((Join-Path $script:projectRoot 'server\DSPGAME.exe'), 'fictional', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $script:bootstrapRoot 'Start-DysonServer.ps1'), "'start'`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $script:bootstrapRoot 'Stop-DysonServer.ps1'), "'stop'`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $script:shadowRoot '.dyson-cutover-broker-selftest'), 'selftest', [Text.UTF8Encoding]::new($false))
    $authorityProfile = New-SelfTestAuthorityProfile -Project $script:projectRoot -Data $script:dataRoot `
        -AuthorityRoot $authorityRoot -Bootstrap $script:bootstrapRoot -Transactions $script:transactionRoot `
        -ServiceUser $script:serviceUser -GamePort $script:gamePort
    $script:inventoryRevision = [string]$authorityProfile.inventoryRevision
    [IO.File]::WriteAllText(
        $script:authorityProfileFile,
        (ConvertTo-CutoverHostJson $authorityProfile) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $env:DYSON_CUTOVER_BROKER_SELFTEST = '1'

    $atomicParent = $fixtureRoot
    if ($atomicParent.Length -lt 225) {
        $paddingLength = 225 - $atomicParent.Length - 1
        $atomicParent = Join-Path $atomicParent ('p' * $paddingLength)
        [void](Assert-DysonCutoverBrokerPlainDirectory -Path $atomicParent -Create)
    }
    $atomicPath = Join-Path $atomicParent 'transaction.json'
    $representativeTemporaryPath = Join-Path $atomicParent `
        ('.broker-' + [guid]::Empty.ToString('N') + '.tmp')
    Assert-SelfTest ($representativeTemporaryPath.Length -gt 260) `
        'The MAX_PATH atomic-write fixture did not exceed the Win32 legacy path boundary.'
    $atomicValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_MAX_PATH_SELFTEST_V1'
        schemaVersion = 1
    }
    Write-DysonCutoverBrokerJsonNew -Path $atomicPath -Value $atomicValue -MaximumBytes 4096
    $atomicRoundTrip = Read-DysonCutoverBrokerJson -Path $atomicPath -MaximumBytes 4096
    Assert-SelfTest (
        [string]$atomicRoundTrip.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_MAX_PATH_SELFTEST_V1' -and
        [int]$atomicRoundTrip.schemaVersion -eq 1
    ) 'A create-new atomic JSON write did not survive a WinPS 5.1 MAX_PATH boundary.'
    Remove-DysonCutoverBrokerPlainFile $atomicPath
    Assert-SelfTest (-not (Test-DysonCutoverBrokerPathExists $atomicPath)) `
        'The MAX_PATH atomic-write fixture was not removed exactly.'
    $tests.Add('max-path-atomic-json')

    $installScript = Join-Path $PSScriptRoot 'Install-DysonCutoverBrokerTask.ps1'
    $installRequestId = [guid]::NewGuid().ToString('D')
    $install = Invoke-SelfTestPowerShell -Script $installScript -Arguments `
        (Get-SelfTestInstallArguments -InstallRequestId $installRequestId `
            -BrokerScripts $PSScriptRoot -CutoverRoot $script:cutoverScriptRoot)
    $installEnvelope = ConvertFrom-SelfTestEnvelope $install
    $installStages = if (Test-Path -LiteralPath (Join-Path $script:shadowRoot 'install-stage.log')) {
        (Get-Content -LiteralPath (Join-Path $script:shadowRoot 'install-stage.log')) -join ','
    }
    else { 'none' }
    Assert-SelfTest ($install.exitCode -eq 0 -and [string]$installEnvelope.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1') `
        ('Shadow installer failed at [' + $installStages + ']: ' + $install.text)
    $tests.Add('shadow-install')

    $initialBundleBindingPath = Join-Path $script:brokerRoot 'broker-bundle.json'
    $initialTaskIntentPath = Join-Path $script:shadowRoot 'task-intent.json'
    $initialProfileBytes = [IO.File]::ReadAllBytes($script:brokerProfileFile)
    $initialBundleBindingBytes = [IO.File]::ReadAllBytes($initialBundleBindingPath)
    $initialTaskIntentBytes = [IO.File]::ReadAllBytes($initialTaskIntentPath)
    $failedCompensationRequestId = [guid]::NewGuid().ToString('D')
    $failedCompensationArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $failedCompensationRequestId `
            -BrokerScripts $PSScriptRoot -CutoverRoot $script:cutoverScriptRoot
    ) + @('-Operation', 'CompensateFirstInstall', '-CompensateInstallRequestId', $installRequestId)
    try {
        $env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE = 'compensate-after-profile'
        $failedCompensation = Invoke-SelfTestPowerShell -Script $installScript -Arguments $failedCompensationArguments
    }
    finally { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE -ErrorAction SilentlyContinue }
    $failedCompensationEnvelope = ConvertFrom-SelfTestEnvelope $failedCompensation
    $failedCompensationState = [ordered]@{
        exitCode = $failedCompensation.exitCode
        errorCode = [string]$failedCompensationEnvelope.error.code
        profileRestored = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($initialProfileBytes)
        bindingRestored = [Convert]::ToBase64String([IO.File]::ReadAllBytes($initialBundleBindingPath)) -ceq
            [Convert]::ToBase64String($initialBundleBindingBytes)
        taskRestored = [Convert]::ToBase64String([IO.File]::ReadAllBytes($initialTaskIntentPath)) -ceq
            [Convert]::ToBase64String($initialTaskIntentBytes)
        receiptAbsent = -not (Test-Path -LiteralPath (Join-Path $script:brokerRoot `
            ('installation-receipts\' + $failedCompensationRequestId.ToLowerInvariant() + '.json')))
    }
    Assert-SelfTest ($failedCompensation.exitCode -eq 1 -and
        [string]$failedCompensationEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED' -and
        -not ($failedCompensationState.Values -contains $false)) `
        ('A failed first-install compensation did not restore the exact preimage: ' +
            ($failedCompensationState | ConvertTo-Json -Compress))
    $tests.Add('first-install-compensation-rollback')

    $compensationRequestId = [guid]::NewGuid().ToString('D')
    $compensationArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $compensationRequestId `
            -BrokerScripts $PSScriptRoot -CutoverRoot $script:cutoverScriptRoot
    ) + @('-Operation', 'CompensateFirstInstall', '-CompensateInstallRequestId', $installRequestId)
    $compensation = Invoke-SelfTestPowerShell -Script $installScript -Arguments $compensationArguments
    $compensationEnvelope = ConvertFrom-SelfTestEnvelope $compensation
    Assert-SelfTest ($compensation.exitCode -eq 0 -and
        [string]$compensationEnvelope.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_RECEIPT_V1' -and
        [string]$compensationEnvelope.operation -ceq 'compensated-first-install' -and
        [string]$compensationEnvelope.installRequestId -ceq $installRequestId.ToLowerInvariant() -and
        [bool]$compensationEnvelope.removed -and
        -not (Test-Path -LiteralPath $script:brokerProfileFile) -and
        -not (Test-Path -LiteralPath $initialBundleBindingPath) -and
        -not (Test-Path -LiteralPath $initialTaskIntentPath) -and
        (Test-Path -LiteralPath $script:authorityProfileFile -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $script:brokerRoot `
            ('installation-receipts\' + $installRequestId.ToLowerInvariant() + '.json')) -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $script:brokerRoot `
            ('installation-receipts\' + $compensationRequestId.ToLowerInvariant() + '.json')) -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $script:shadowRoot 'directory-acl-intent.json') -PathType Leaf)) `
        ('A successful first-install compensation removed durable evidence or left task/profile state: ' + $compensation.text)
    $tests.Add('first-install-compensation')

    $installRequestId = [guid]::NewGuid().ToString('D')
    $reinstall = Invoke-SelfTestPowerShell -Script $installScript -Arguments `
        (Get-SelfTestInstallArguments -InstallRequestId $installRequestId `
            -BrokerScripts $PSScriptRoot -CutoverRoot $script:cutoverScriptRoot)
    $reinstallEnvelope = ConvertFrom-SelfTestEnvelope $reinstall
    Assert-SelfTest ($reinstall.exitCode -eq 0 -and
        [string]$reinstallEnvelope.operation -ceq 'installed' -and
        (Test-Path -LiteralPath $script:brokerProfileFile -PathType Leaf) -and
        (Test-Path -LiteralPath $initialTaskIntentPath -PathType Leaf)) `
        ('Broker reinstall after compensation failed: ' + $reinstall.text)
    $tests.Add('reinstall-after-first-install-compensation')

    $taskIntent = Get-Content -LiteralPath (Join-Path $script:shadowRoot 'task-intent.json') -Raw | ConvertFrom-Json
    $aclIntent = Assert-DysonFixedTaskReadExecuteAclIntent ([string]$taskIntent.acl.sddl)
    Assert-SelfTest (
        [string]$taskIntent.taskName -ceq 'Dyson-Control-Cutover-Broker' -and
        [string]$taskIntent.taskPath -ceq '\' -and [string]$taskIntent.principal -ceq 'S-1-5-18' -and
        [string]$taskIntent.runLevel -ceq 'Highest' -and [bool]$taskIntent.enabled -and
        -not [bool]$aclIntent.localServiceWrite -and -not [bool]$aclIntent.localServiceDelete
    ) 'The task ACL or SYSTEM task intent is not least privilege.'
    $directoryIntent = Get-Content -LiteralPath (Join-Path $script:shadowRoot 'directory-acl-intent.json') -Raw | ConvertFrom-Json
    Assert-SelfTest (
        @($directoryIntent | Where-Object { $_.kind -eq 'requests' -and $_.localService -eq 'modify' }).Count -eq 1 -and
        @($directoryIntent | Where-Object { $_.kind -eq 'receipts' -and $_.localService -eq 'read-execute' }).Count -eq 1 -and
        @($directoryIntent | Where-Object { $_.kind -eq 'private' -and $_.localService -eq 'none' }).Count -eq 1
    ) 'The broker storage ACL intent is not separated by channel.'
    $tests.Add('acl-intent')
    $nativeAcl = Assert-DysonFixedTaskReadExecuteAclIntent 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;LS)'
    Assert-SelfTest (-not $nativeAcl.localServiceWrite) 'native mapped task rights changed access intent'
    $extraRightsRejected = $false
    try { [void](Assert-DysonFixedTaskReadExecuteAclIntent 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LS)') }
    catch { $extraRightsRejected = $true }
    Assert-SelfTest $extraRightsRejected 'mapped Local Service write access was accepted'
    $tests.Add('native-mapped-task-rights')

    $profile = Read-DysonCutoverBrokerProfile $script:brokerRoot $script:brokerProfileFile
    Assert-SelfTest (
        (Test-DysonCutoverBrokerSamePath $profile.brokerScriptRoot $PSScriptRoot) -and
        (Test-DysonCutoverBrokerSamePath $profile.cutoverScriptRoot $script:cutoverScriptRoot)
    ) 'The installed broker profile did not pin the script roots.'
    $tests.Add('fixed-profile')
    Assert-SelfTest ($profile.previousStopScriptSha256 -ceq (Get-DysonCutoverBrokerSha256File (Join-Path $script:cutoverScriptRoot 'Stop-DysonServer.ps1'))) `
        'The new profile did not pin the compatible previous-stop leaf.'
    $legacyCore = [ordered]@{}
    foreach ($property in $profile.PSObject.Properties) {
        if ($property.Name -cnotin @('profileFingerprint','previousStopScriptSha256','cutoverEvidenceScriptSha256')) { $legacyCore[$property.Name] = $property.Value }
    }
    $legacyFingerprint = Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $legacyCore)
    $legacyCore['profileFingerprint'] = $legacyFingerprint
    $legacyProfile = ConvertTo-DysonCutoverBrokerValidatedProfile ([pscustomobject]$legacyCore)
    Assert-SelfTest ($legacyProfile.profileFingerprint -ceq $legacyFingerprint -and
        $null -eq $legacyProfile.PSObject.Properties['previousStopScriptSha256']) 'Old profile fingerprint changed during compatible parsing.'
    $tests.Add('legacy-profile-readable-and-stop-leaf-bound')
    $readId = [guid]::NewGuid().ToString('D')
    $readRequest = New-DysonCutoverBrokerRequest -BrokerRequestId $readId -Capability 'CutoverEvidence' -RequestId ([guid]::NewGuid().ToString('D')) `
        -AuthorityInventoryRevision $script:inventoryRevision -ProjectRoot $script:projectRoot -DataRoot $script:dataRoot `
        -AuthorityProfileFile $script:authorityProfileFile -CutoverScriptRoot $script:cutoverScriptRoot `
        -RuntimeBootstrapRoot $script:bootstrapRoot -RuntimeTaskTransactionRoot $script:transactionRoot `
        -ServiceUser $script:serviceUser -GamePort $script:gamePort -CandidateMode $null -CandidateRecover $false
    Assert-SelfTestErrorCode { Assert-DysonCutoverBrokerRequestBinding $readRequest $legacyProfile } 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    $badRead = ConvertTo-DysonCutoverBrokerJson $readRequest | ConvertFrom-Json
    $badRead.leaseInstanceId = [guid]::NewGuid().ToString('D')
    $badRead.requestFingerprint = Get-DysonCutoverBrokerRequestFingerprint $badRead
    Assert-SelfTestErrorCode { [void](ConvertTo-DysonCutoverBrokerValidatedRequest $badRead) } 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    $withoutLease = @('-BrokerRoot',$script:brokerRoot,'-BrokerProfileFile',$script:brokerProfileFile,
        '-BrokerRequestId',$readId,'-Capability','CutoverEvidence','-RequestId',$readRequest.requestId,
        '-AuthorityInventoryRevision',$script:inventoryRevision,'-ProjectRoot',$script:projectRoot,
        '-DataRoot',$script:dataRoot,'-AuthorityProfileFile',$script:authorityProfileFile,
        '-CutoverScriptRoot',$script:cutoverScriptRoot,'-RuntimeBootstrapRoot',$script:bootstrapRoot,
        '-RuntimeTaskTransactionRoot',$script:transactionRoot,'-ServiceUser',$script:serviceUser,
        '-GamePort',[string]$script:gamePort,'-SchedulerBackend','Shadow','-ShadowRoot',$script:shadowRoot)
    $taskBeforeRead = Get-DysonCutoverBrokerSha256File (Join-Path $script:shadowRoot 'task-intent.json')
    $readResult = Invoke-SelfTestPowerShell -Script (Join-Path $PSScriptRoot 'Submit-DysonCutoverBrokerRequest.ps1') -Arguments @($withoutLease)
    $readEnvelope = ConvertFrom-SelfTestEnvelope $readResult
    Assert-SelfTest ($readResult.exitCode -eq 0 -and $readEnvelope.capability -ceq 'CutoverEvidence' -and
        $readEnvelope.childReceipt.protocol -ceq 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1' -and
        $readEnvelope.childReceipt.evidence.previousDefined -and
        (Get-DysonCutoverBrokerSha256File (Join-Path $script:shadowRoot 'task-intent.json')) -ceq $taskBeforeRead) ('Bound read-only evidence failed: ' + $readResult.text)
    $tests.Add('fixed-readonly-evidence-no-lease-legacy-binding-and-no-task-mutation')
    & {
        $tokens=$null; $errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Submit-DysonCutoverBrokerRequest.ps1'),[ref]$tokens,[ref]$errors)
        Assert-SelfTest ($errors.Count -eq 0) 'Submit script parse failed.'
        $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Start-SubmitBoundBrokerTask'},$false)
        . ([scriptblock]::Create($fn.Extent.Text))
        $script:readWakeCount=0; $script:readWakeState='Running'; $script:readWakeDrift=$false
        function Get-ScheduledTask {
            param($TaskName,$TaskPath)
            [pscustomobject]@{TaskName=$profile.taskName;TaskPath=$profile.taskPath;State=$script:readWakeState
                Principal=[pscustomobject]@{UserId='SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'}
                Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');Arguments=$(if($script:readWakeDrift){'wrong-fixed-action'}else{Get-DysonCutoverBrokerTaskArguments $profile})})}
        }
        function Start-ScheduledTask {param($TaskName,$TaskPath);$script:readWakeCount++}
        Start-SubmitBoundBrokerTask $profile -OnlyIfIdle
        Assert-SelfTest ($script:readWakeCount -eq 0) 'A busy broker was re-triggered by read wake recovery.'
        $script:readWakeState='Ready'; Start-SubmitBoundBrokerTask $profile -OnlyIfIdle
        Assert-SelfTest ($script:readWakeCount -eq 1) 'An idle broker did not receive the lost read wake.'
        $script:readWakeDrift=$true
        Assert-SelfTestErrorCode {Start-SubmitBoundBrokerTask $profile -OnlyIfIdle} 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
        Assert-SelfTest ($script:readWakeCount -eq 1) 'Read wake recovery triggered a drifted task.'
    }
    $tests.Add('read-wake-rechecks-fixed-task-and-waits-for-idle')
    $wakeWrapper = Join-Path $fixtureRoot 'read-wake-scheduler-fixture.ps1'
    $wakeSource = @'
param([string]$CaseFile)
$ErrorActionPreference='Stop'
$global:cutoverWakeConfig=Get-Content -LiteralPath $CaseFile -Raw | ConvertFrom-Json
. (Join-Path $global:cutoverWakeConfig.scripts 'DysonCutoverBroker.Common.ps1')
$global:cutoverWakeProfile=Read-DysonCutoverBrokerProfile $global:cutoverWakeConfig.brokerRoot $global:cutoverWakeConfig.profileFile
$global:cutoverWakeBusy=$true
function global:Get-ScheduledTask {
    [CmdletBinding()]param($TaskName,$TaskPath)
    [IO.File]::AppendAllText(($global:cutoverWakeConfig.log+'.trace'),"get-task`n")
    [pscustomobject]@{TaskName=$global:cutoverWakeProfile.taskName;TaskPath=$global:cutoverWakeProfile.taskPath;State=$(if($global:cutoverWakeBusy){'Running'}else{'Ready'})
        Principal=[pscustomobject]@{UserId='SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'}
        Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');Arguments=(Get-DysonCutoverBrokerTaskArguments $global:cutoverWakeProfile)})}
}
function global:Start-ScheduledTask {
    [CmdletBinding()]param($TaskName,$TaskPath)
    if($global:cutoverWakeBusy){
        # The old worker's captured request set is empty. The new queued request
        # is invisible to that pass and IgnoreNew consumes its initial wake.
        [IO.File]::AppendAllText($global:cutoverWakeConfig.log,"ignored-after-enumeration`n")
        if(-not $global:cutoverWakeConfig.stayBusy){$global:cutoverWakeBusy=$false}
        return
    }
    [IO.File]::AppendAllText($global:cutoverWakeConfig.log,"dispatch-same-request`n")
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $global:cutoverWakeConfig.scripts 'Invoke-DysonCutoverBrokerWorker.ps1') -BrokerRoot $global:cutoverWakeConfig.brokerRoot -BrokerProfileFile $global:cutoverWakeConfig.profileFile -SchedulerBackend Shadow -ShadowRoot $global:cutoverWakeConfig.shadow -OnceBrokerRequestId $global:cutoverWakeConfig.requestId | Out-Null
}
$tokens=[string[]]$global:cutoverWakeConfig.arguments
$argsForSubmit=@{}
for($i=0;$i -lt $tokens.Length;$i+=2){$argsForSubmit[$tokens[$i].TrimStart('-')]=$tokens[$i+1]}
try { & (Join-Path $global:cutoverWakeConfig.scripts 'Submit-DysonCutoverBrokerRequest.ps1') @argsForSubmit; exit $LASTEXITCODE } catch { [pscustomobject]@{fixtureError=$_.Exception.Message}|ConvertTo-Json -Compress; exit 1 }
'@
    [IO.File]::WriteAllText($wakeWrapper,$wakeSource,[Text.UTF8Encoding]::new($false))
    foreach($wakeMode in @('read-success','read-timeout','mutation-no-retry')) {
        $wakeId=[guid]::NewGuid().ToString('D')
        $wakeArgs=[Collections.Generic.List[string]]::new()
        for($i=0;$i -lt $withoutLease.Count;$i++) {
            if($withoutLease[$i] -ceq '-ShadowRoot'){$i++;continue}
            $wakeArgs.Add($withoutLease[$i])
        }
        $wakeArgs[$wakeArgs.IndexOf('-BrokerRequestId')+1]=$wakeId
        $wakeArgs[$wakeArgs.IndexOf('-SchedulerBackend')+1]='Windows'
        $wakeArgs.Add('-TimeoutSeconds');$wakeArgs.Add('10')
        if($wakeMode -ceq 'mutation-no-retry') {
            $wakeArgs[$wakeArgs.IndexOf('-Capability')+1]='StopCandidateRuntime'
            $wakeArgs.Add('-LeaseInstanceId');$wakeArgs.Add([guid]::NewGuid().ToString('D'))
            $wakeArgs.Add('-LeaseToken');$wakeArgs.Add(('x'*43))
        }
        $wakeLog=Join-Path $fixtureRoot ($wakeId+'.wake.log')
        $wakeCase=Join-Path $fixtureRoot ($wakeId+'.case.json')
        [IO.File]::WriteAllText($wakeCase,([ordered]@{scripts=$PSScriptRoot;brokerRoot=$script:brokerRoot;profileFile=$script:brokerProfileFile;shadow=$script:shadowRoot;requestId=$wakeId;log=$wakeLog;stayBusy=($wakeMode -ceq 'read-timeout');arguments=@($wakeArgs)}|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
        $timer=[Diagnostics.Stopwatch]::StartNew()
        $wakeResult=Invoke-SelfTestPowerShell -Script $wakeWrapper -Arguments @('-CaseFile',$wakeCase)
        $timer.Stop();Assert-SelfTest (Test-Path -LiteralPath $wakeLog) ('Scheduler fixture did not start: '+$wakeResult.text+'; queried='+[string](Test-Path ($wakeLog+'.trace')));$wakeEvents=@([IO.File]::ReadAllLines($wakeLog))
        if($wakeMode -ceq 'read-success') {
            $envelope=ConvertFrom-SelfTestEnvelope $wakeResult
            Assert-SelfTest ($wakeResult.exitCode -eq 0 -and $envelope.brokerRequestId -ceq $wakeId -and
                $envelope.childReceipt.protocol -ceq 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1' -and
                ($wakeEvents -join ',') -ceq 'ignored-after-enumeration,dispatch-same-request') ('Lost read wake did not converge: '+$wakeResult.text)
            $replayed=Invoke-SelfTestPowerShell -Script $wakeWrapper -Arguments @('-CaseFile',$wakeCase)
            Assert-SelfTest ($replayed.exitCode -eq 0 -and @([IO.File]::ReadAllLines($wakeLog)).Count -eq 2) 'An existing evidence receipt triggered another worker.'
        }
        else {
            $envelope=ConvertFrom-SelfTestEnvelope $wakeResult
            Assert-SelfTest ($wakeResult.exitCode -eq 1 -and $envelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_TIMEOUT' -and
                ($wakeEvents -join ',') -ceq 'ignored-after-enumeration' -and $timer.Elapsed.TotalSeconds -lt 20) ('Read timeout/mutation no-retry bound failed: '+$wakeResult.text+'; exit='+$wakeResult.exitCode+'; seconds='+$timer.Elapsed.TotalSeconds+'; events='+($wakeEvents -join ','))
            Remove-DysonCutoverBrokerPlainFile (Join-Path $script:brokerRoot ('requests\'+$wakeId+'.json'))
        }
    }
    $tests.Add('lost-read-wake-full-submit-converges-receipt-stops-and-mutation-never-retries')

    Assert-SelfTestErrorCode {
        [void](Get-DysonCutoverBrokerFullPath (Join-Path $fixtureRoot 'project\..\project'))
    } 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    $tests.Add('path-traversal')

    $junction = Join-Path $fixtureRoot 'redirected-project'
    [void](New-Item -ItemType Junction -Path $junction -Target $script:projectRoot -ErrorAction Stop)
    Assert-SelfTestErrorCode {
        [void](Assert-DysonCutoverBrokerPlainDirectory $junction)
    } 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    $tests.Add('reparse-point')

    $script:lease = Enter-DysonHostMutationLease -DataRoot $script:dataRoot -Owner 'cutover-broker-selftest' `
        -Operation 'cutover-shadow' -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
    $submitScript = Join-Path $PSScriptRoot 'Submit-DysonCutoverBrokerRequest.ps1'
    $candidateBrokerId = [guid]::NewGuid().ToString('D')
    $candidateChildId = [guid]::NewGuid().ToString('D')
    $candidateArgs = Get-SelfTestSubmitArguments -BrokerRequestId $candidateBrokerId `
        -Capability 'CandidateTaskTransaction' -ChildRequestId $candidateChildId `
        -LeaseToken $script:lease.Token -CandidateMode 'PrepareDisabled'
    $candidate = Invoke-SelfTestPowerShell -Script $submitScript -Arguments $candidateArgs
    $candidateEnvelope = ConvertFrom-SelfTestEnvelope $candidate
    Assert-SelfTest (
        $candidate.exitCode -eq 0 -and
        [string]$candidateEnvelope.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_RESULT_V1' -and
        [int]$candidateEnvelope.schemaVersion -eq 1 -and
        [string]$candidateEnvelope.brokerRequestId -ceq $candidateBrokerId.ToLowerInvariant() -and
        [string]$candidateEnvelope.capability -ceq 'CandidateTaskTransaction' -and
        [string]$candidateEnvelope.requestId -ceq $candidateChildId.ToLowerInvariant() -and
        [string]$candidateEnvelope.authorityInventoryRevision -ceq $script:inventoryRevision -and
        -not [bool]$candidateEnvelope.reused -and
        [string]$candidateEnvelope.childReceipt.protocol -ceq 'DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2'
    ) ('Candidate broker request failed: ' + $candidate.text + '; stages=' +
        ($(if (Test-Path -LiteralPath (Join-Path $script:shadowRoot 'worker-stage.log')) {
            (Get-Content -LiteralPath (Join-Path $script:shadowRoot 'worker-stage.log')) -join ','
        } else { 'none' })))
    $tests.Add('candidate-dispatch')

    $candidateRetry = Invoke-SelfTestPowerShell -Script $submitScript -Arguments $candidateArgs
    $candidateRetryEnvelope = ConvertFrom-SelfTestEnvelope $candidateRetry
    Assert-SelfTest ($candidateRetry.exitCode -eq 0 -and [bool]$candidateRetryEnvelope.reused) `
        'An exact broker replay did not reuse its terminal receipt.'
    $tests.Add('idempotent-replay')

    $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = 'candidate-rollback-replay'
    $rollbackBrokerId = [guid]::NewGuid().ToString('D')
    $rollbackReplay = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId $rollbackBrokerId `
            -Capability 'CandidateTaskTransaction' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token -CandidateMode 'Activate')
    $rollbackEnvelope = ConvertFrom-SelfTestEnvelope $rollbackReplay
    $rollbackDispatches = @(Get-Content -LiteralPath (Join-Path $script:shadowRoot 'dispatch.log') |
        ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { [string]$_.brokerRequestId -ceq $rollbackBrokerId.ToLowerInvariant() })
    Assert-SelfTest ($rollbackReplay.exitCode -eq 0 -and
        [string]$rollbackEnvelope.childReceipt.status -ceq 'rolled-back' -and
        $rollbackDispatches.Count -eq 2) `
        ('An ordinary candidate rollback did not use exactly one byte-equivalent receipt replay: ' + $rollbackReplay.text)
    $tests.Add('candidate-rollback-exact-replay')

    $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = 'candidate-recover-failure'
    $recoverBrokerId = [guid]::NewGuid().ToString('D')
    $recoverFailure = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId $recoverBrokerId `
            -Capability 'CandidateTaskTransaction' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token -CandidateMode 'Activate' -CandidateRecover)
    $recoverEnvelope = ConvertFrom-SelfTestEnvelope $recoverFailure
    $recoverDispatches = @(Get-Content -LiteralPath (Join-Path $script:shadowRoot 'dispatch.log') |
        ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { [string]$_.brokerRequestId -ceq $recoverBrokerId.ToLowerInvariant() })
    Assert-SelfTest ($recoverFailure.exitCode -eq 1 -and
        [string]$recoverEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED' -and
        $recoverDispatches.Count -eq 1) `
        'An explicit candidate recovery failure was implicitly replayed.'
    $tests.Add('candidate-recovery-no-replay')
    $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = 'success'

    $conflictArgs = Get-SelfTestSubmitArguments -BrokerRequestId $candidateBrokerId `
        -Capability 'StartCandidateRuntime' -ChildRequestId $candidateChildId -LeaseToken $script:lease.Token
    $conflict = Invoke-SelfTestPowerShell -Script $submitScript -Arguments $conflictArgs
    $conflictEnvelope = ConvertFrom-SelfTestEnvelope $conflict
    Assert-SelfTest ($conflict.exitCode -eq 1 -and
        [string]$conflictEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT') `
        'A reused broker request ID accepted a different fingerprint.'
    $tests.Add('idempotency-conflict')

    $invalidAction = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'ArbitraryCommand' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token)
    $invalidActionEnvelope = ConvertFrom-SelfTestEnvelope $invalidAction
    Assert-SelfTest ($invalidAction.exitCode -eq 1 -and
        [string]$invalidActionEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_CAPABILITY_INVALID') `
        'An action outside the fixed capability enum was not rejected.'
    $tests.Add('action-enum-reject')

    foreach ($action in @(
        'DisablePreviousAuthority', 'StopPreviousRuntime', 'EnablePreviousAuthority',
        'StartPreviousRuntime', 'StartCandidateRuntime', 'StopCandidateRuntime'
    )) {
        $invocation = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
            (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
                -Capability $action -ChildRequestId ([guid]::NewGuid().ToString('D')) `
                -LeaseToken $script:lease.Token)
        $envelope = ConvertFrom-SelfTestEnvelope $invocation
        Assert-SelfTest ($invocation.exitCode -eq 0 -and [string]$envelope.capability -ceq $action -and
            [string]$envelope.childReceipt.action -ceq $action) ('Fixed action failed: ' + $action + ': ' + $invocation.text)
    }
    $tests.Add('six-fixed-actions')

    $badLease = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'StartCandidateRuntime' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken ('z' * 43))
    $badLeaseEnvelope = ConvertFrom-SelfTestEnvelope $badLease
    Assert-SelfTest ($badLease.exitCode -eq 1 -and
        [string]$badLeaseEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_LEASE_INVALID') `
        ('An invalid lease was not rejected: ' + $badLease.text)
    $tests.Add('lease-invalid')

    $wrongBinding = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'StartCandidateRuntime' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token -ProjectOverride $otherProject)
    $wrongBindingEnvelope = ConvertFrom-SelfTestEnvelope $wrongBinding
    Assert-SelfTest ($wrongBinding.exitCode -eq 1 -and
        [string]$wrongBindingEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH') `
        'A request outside the installed project binding was accepted.'
    $tests.Add('binding-mismatch')

    $wrongRevision = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'StartCandidateRuntime' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token -RevisionOverride ('f' * 64))
    $wrongRevisionEnvelope = ConvertFrom-SelfTestEnvelope $wrongRevision
    Assert-SelfTest ($wrongRevision.exitCode -eq 1 -and
        [string]$wrongRevisionEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH') `
        'A request outside the installed inventory revision was accepted.'
    $tests.Add('revision-mismatch')

    $rawRequest = New-DysonCutoverBrokerRequest -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
        -Capability 'StartCandidateRuntime' -RequestId ([guid]::NewGuid().ToString('D')) `
        -AuthorityInventoryRevision $script:inventoryRevision -ProjectRoot $script:projectRoot `
        -DataRoot $script:dataRoot -AuthorityProfileFile $script:authorityProfileFile `
        -CutoverScriptRoot $script:cutoverScriptRoot -RuntimeBootstrapRoot $script:bootstrapRoot `
        -RuntimeTaskTransactionRoot $script:transactionRoot -ServiceUser $script:serviceUser `
        -GamePort $script:gamePort -LeaseInstanceId $script:lease.InstanceId -LeaseToken $script:lease.Token `
        -CandidateMode $null -CandidateRecover $false
    $rawRequest | Add-Member -NotePropertyName arbitraryCommand -NotePropertyValue 'forbidden'
    Assert-SelfTestErrorCode {
        [void](ConvertTo-DysonCutoverBrokerValidatedRequest $rawRequest)
    } 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    $tests.Add('strict-request-schema')

    $storage = Get-DysonCutoverBrokerStorage $script:brokerRoot
    $oversizedPath = Join-Path $storage.requestsRoot (([guid]::NewGuid().ToString('D')) + '.json')
    [IO.File]::WriteAllText($oversizedPath, ('x' * ($script:DysonCutoverBrokerMaximumRequestBytes + 1)), [Text.UTF8Encoding]::new($false))
    Assert-SelfTestErrorCode {
        [void](Read-DysonCutoverBrokerJson $oversizedPath $script:DysonCutoverBrokerMaximumRequestBytes `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID')
    } 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    Remove-Item -LiteralPath $oversizedPath -Force
    $tests.Add('bounded-request')

    $beforeDispatchCount = if (Test-Path -LiteralPath (Join-Path $script:shadowRoot 'dispatch.log')) {
        @(Get-Content -LiteralPath (Join-Path $script:shadowRoot 'dispatch.log')).Count
    }
    else { 0 }
    $intentRequest = New-DysonCutoverBrokerRequest -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
        -Capability 'StopCandidateRuntime' -RequestId ([guid]::NewGuid().ToString('D')) `
        -AuthorityInventoryRevision $script:inventoryRevision -ProjectRoot $script:projectRoot `
        -DataRoot $script:dataRoot -AuthorityProfileFile $script:authorityProfileFile `
        -CutoverScriptRoot $script:cutoverScriptRoot -RuntimeBootstrapRoot $script:bootstrapRoot `
        -RuntimeTaskTransactionRoot $script:transactionRoot -ServiceUser $script:serviceUser `
        -GamePort $script:gamePort -LeaseInstanceId $script:lease.InstanceId -LeaseToken $script:lease.Token `
        -CandidateMode $null -CandidateRecover $false
    $intentPaths = Get-DysonCutoverBrokerRecordPaths $storage $intentRequest.brokerRequestId
    Write-DysonCutoverBrokerJsonNew $intentPaths.request $intentRequest $script:DysonCutoverBrokerMaximumRequestBytes
    $intent = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_INTENT_V1'; schemaVersion = 1
        brokerRequestId = $intentRequest.brokerRequestId; requestFingerprint = $intentRequest.requestFingerprint
        capability = $intentRequest.capability; requestId = $intentRequest.requestId
        authorityInventoryRevision = $intentRequest.authorityInventoryRevision
        state = 'dispatching'; createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-DysonCutoverBrokerJsonNew $intentPaths.intent $intent $script:DysonCutoverBrokerMaximumRequestBytes
    $workerInvocation = Invoke-SelfTestPowerShell -Script (Join-Path $PSScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1') -Arguments @(
        '-BrokerRoot', $script:brokerRoot, '-BrokerProfileFile', $script:brokerProfileFile,
        '-SchedulerBackend', 'Shadow', '-ShadowRoot', $script:shadowRoot,
        '-OnceBrokerRequestId', $intentRequest.brokerRequestId
    )
    $intentReceiptRaw = Read-DysonCutoverBrokerJson $intentPaths.receipt `
        $script:DysonCutoverBrokerMaximumReceiptBytes -AllowMissing `
        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
    if ($null -eq $intentReceiptRaw) {
        throw ('Interrupted intent did not produce a receipt; worker=' + $workerInvocation.text + '; stages=' +
            ((Get-Content -LiteralPath (Join-Path $script:shadowRoot 'worker-stage.log')) -join ','))
    }
    try { $intentReceipt = ConvertTo-DysonCutoverBrokerValidatedReceipt $intentReceiptRaw }
    catch {
        throw ('Interrupted intent produced an invalid receipt; worker=' + $workerInvocation.text + '; raw=' +
            (ConvertTo-DysonCutoverBrokerJson $intentReceiptRaw))
    }
    $afterDispatchCount = @(Get-Content -LiteralPath (Join-Path $script:shadowRoot 'dispatch.log')).Count
    Assert-SelfTest ($workerInvocation.exitCode -eq 1 -and
        [string]$intentReceipt.errorCode -ceq 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED' -and
        $beforeDispatchCount -eq $afterDispatchCount) `
        'An interrupted intent was redispatched instead of failing closed.'
    $tests.Add('interrupted-intent')

    foreach ($reconcile in @($false, $true)) {
        $resumeRequest = New-DysonCutoverBrokerRequest -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'StopPreviousRuntime' -RequestId ([guid]::NewGuid().ToString('D')) `
            -AuthorityInventoryRevision $script:inventoryRevision -ProjectRoot $script:projectRoot `
            -DataRoot $script:dataRoot -AuthorityProfileFile $script:authorityProfileFile `
            -CutoverScriptRoot $script:cutoverScriptRoot -RuntimeBootstrapRoot $script:bootstrapRoot `
            -RuntimeTaskTransactionRoot $script:transactionRoot -ServiceUser $script:serviceUser `
            -GamePort $script:gamePort -LeaseInstanceId $script:lease.InstanceId -LeaseToken $script:lease.Token `
            -CandidateMode $null -CandidateRecover $false -PreviousStopReconcileOnly $reconcile
        if ($reconcile) {
            $tampered = ConvertTo-DysonCutoverBrokerJson $resumeRequest | ConvertFrom-Json
            $tampered.PSObject.Properties.Remove('previousStopReconcileOnly')
            Assert-SelfTestErrorCode { [void](ConvertTo-DysonCutoverBrokerValidatedRequest $tampered) } 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
        }
        $resumePaths = Get-DysonCutoverBrokerRecordPaths $storage $resumeRequest.brokerRequestId
        Write-DysonCutoverBrokerJsonNew $resumePaths.request $resumeRequest $script:DysonCutoverBrokerMaximumRequestBytes
        $resumeIntent = [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_BROKER_INTENT_V1'; schemaVersion = 1
            brokerRequestId = $resumeRequest.brokerRequestId; requestFingerprint = $resumeRequest.requestFingerprint
            capability = $resumeRequest.capability; requestId = $resumeRequest.requestId
            authorityInventoryRevision = $resumeRequest.authorityInventoryRevision
            state = 'dispatching'; createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-DysonCutoverBrokerJsonNew $resumePaths.intent $resumeIntent $script:DysonCutoverBrokerMaximumRequestBytes
        $resumed = Invoke-SelfTestPowerShell -Script (Join-Path $PSScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1') -Arguments @(
            '-BrokerRoot', $script:brokerRoot, '-BrokerProfileFile', $script:brokerProfileFile,
            '-SchedulerBackend', 'Shadow', '-ShadowRoot', $script:shadowRoot, '-OnceBrokerRequestId', $resumeRequest.brokerRequestId
        )
        $resumedReceipt = Read-DysonCutoverBrokerJson $resumePaths.receipt $script:DysonCutoverBrokerMaximumReceiptBytes
        $expectedAction = if ($reconcile) { 'ReconcilePreviousStop' } else { 'StopPreviousRuntime' }
        Assert-SelfTest ($resumed.exitCode -eq 0 -and $resumedReceipt.state -ceq 'succeeded' -and
            $resumedReceipt.childReceipt.action -ceq $expectedAction) 'Bound previous-stop intent did not resume with its exact cleanup mode.'
    }
    $tests.Add('previous-stop-intent-resume-and-reconcile-fingerprint')

    $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = 'oversize'
    $oversizeInvocation = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
        (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
            -Capability 'StartPreviousRuntime' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseToken $script:lease.Token)
    $oversizeEnvelope = ConvertFrom-SelfTestEnvelope $oversizeInvocation
    Assert-SelfTest ($oversizeInvocation.exitCode -eq 1 -and
        [string]$oversizeEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED') `
        'An output-limit breach did not latch an uncertain mutation as recovery-required.'
    $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = 'success'
    $workerSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1') -Raw
    Assert-SelfTest ($workerSource -match 'DysonCutoverBrokerMaximumChildOutputBytes' -and
        $workerSource -match 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_LIMIT' -and
        $workerSource -notmatch '\bInvoke-Expression\b') `
        'The worker does not enforce bounded output or contains an arbitrary execution primitive.'
    $tests.Add('bounded-child-output')

    $submitSource = Get-Content -LiteralPath $submitScript -Raw
    Assert-SelfTest ($submitSource -match 'PipelineStoppedException' -and
        $submitSource -match 'DYSON_CONTROL_CUTOVER_BROKER_TIMEOUT' -and
        $workerSource -match "cutover\\Invoke-DysonCutoverAction\.ps1" -and
        $workerSource -match "Install-DysonRuntimeTasks\.ps1") `
        'Cancellation, timeout, or fixed worker dispatch is not fail closed.'
    $tests.Add('fixed-dispatch-and-cancellation')

    $candidateReleaseRoot = Join-Path $fixtureRoot 'candidate-release'
    $candidateScriptsParent = Join-Path $candidateReleaseRoot 'scripts'
    [void][IO.Directory]::CreateDirectory($candidateScriptsParent)
    Copy-Item -LiteralPath $script:cutoverScriptRoot -Destination $candidateScriptsParent `
        -Recurse -Force -ErrorAction Stop
    $candidateCutoverRoot = Join-Path $candidateScriptsParent 'windows'
    $candidateBrokerScripts = Join-Path $candidateCutoverRoot 'cutover-broker'
    $candidateInstaller = Join-Path $candidateBrokerScripts 'Install-DysonCutoverBrokerTask.ps1'
    $expectedBrokerNames = @(
        'DysonCutoverBroker.Common.ps1',
        'DysonCutoverBroker.TaskAcl.ps1',
        'Install-DysonCutoverBrokerTask.ps1',
        'Invoke-DysonCutoverBrokerWorker.ps1',
        'SelfTest-DysonCutoverBroker.ps1',
        'Submit-DysonCutoverBrokerRequest.ps1'
    ) | Sort-Object -CaseSensitive
    $candidateBrokerNames = @(Get-ChildItem -LiteralPath $candidateBrokerScripts -Force |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    Assert-SelfTest (($candidateBrokerNames -join '|') -ceq ($expectedBrokerNames -join '|')) `
        'The candidate release fixture did not preserve the exact six-file broker bundle.'

    $profileBeforeUpgrade = [IO.File]::ReadAllBytes($script:brokerProfileFile)
    $bundleBindingPath = Join-Path $script:brokerRoot 'broker-bundle.json'
    $bundleBindingBeforeUpgrade = [IO.File]::ReadAllBytes($bundleBindingPath)
    $taskIntentPath = Join-Path $script:shadowRoot 'task-intent.json'
    $directoryAclIntentPath = Join-Path $script:shadowRoot 'directory-acl-intent.json'
    $taskIntentBeforeUpgrade = [IO.File]::ReadAllBytes($taskIntentPath)
    $directoryAclIntentBeforeUpgrade = [IO.File]::ReadAllBytes($directoryAclIntentPath)
    $installationReceiptRoot = Join-Path $script:brokerRoot 'installation-receipts'
    $installationTransactionRoot = Join-Path $script:brokerRoot 'installation-transactions'
    $installReceiptsBeforeUpgrade = @(Get-ChildItem -LiteralPath $installationReceiptRoot -File |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $oldProfileFingerprint = [string]$profile.profileFingerprint
    $upgradeFileAcls = @{}
    foreach ($path in @($script:brokerProfileFile, $bundleBindingPath, $taskIntentPath, $directoryAclIntentPath)) {
        $upgradeFileAcls[$path] = (Get-Acl -LiteralPath $path).Sddl
    }

    foreach ($failureStage in @(
        'after-snapshot', 'after-old-task-disabled', 'after-profile',
        'after-task', 'after-task-acl', 'before-receipt'
    )) {
        $failureRequestId = [guid]::NewGuid().ToString('D')
        try {
            $env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE = $failureStage
            $failedUpgrade = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments `
                (Get-SelfTestInstallArguments -InstallRequestId $failureRequestId `
                    -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot -UpgradeExisting)
        }
        finally { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE -ErrorAction SilentlyContinue }
        $failedUpgradeEnvelope = ConvertFrom-SelfTestEnvelope $failedUpgrade
        $failedTransactionPath = Join-Path $installationTransactionRoot `
            ($failureRequestId.ToLowerInvariant() + '\transaction.json')
        $failedTransaction = [IO.File]::ReadAllText(
            $failedTransactionPath, [Text.UTF8Encoding]::new($false, $true)
        ) | ConvertFrom-Json
        $installReceiptsAfterFailure = @(Get-ChildItem -LiteralPath $installationReceiptRoot -File |
            ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        Assert-SelfTest (
            $failedUpgrade.exitCode -eq 1 -and
            [string]$failedUpgradeEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED' -and
            [string]$failedTransaction.state -ceq 'rolled-back' -and
            @($upgradeFileAcls.Keys | Where-Object { (Get-Acl -LiteralPath $_).Sddl -cne $upgradeFileAcls[$_] }).Count -eq 0 -and
            [string]$failedTransaction.previousProfileFingerprint -ceq $oldProfileFingerprint -and
            [string]$failedTransaction.candidateProfileFingerprint -cmatch '^[0-9a-f]{64}$' -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
                [Convert]::ToBase64String($profileBeforeUpgrade) -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($bundleBindingPath)) -ceq
                [Convert]::ToBase64String($bundleBindingBeforeUpgrade) -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskIntentPath)) -ceq
                [Convert]::ToBase64String($taskIntentBeforeUpgrade) -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($directoryAclIntentPath)) -ceq
                [Convert]::ToBase64String($directoryAclIntentBeforeUpgrade) -and
            ($installReceiptsAfterFailure -join '|') -ceq ($installReceiptsBeforeUpgrade -join '|') -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes(
                (Join-Path (Split-Path $failedTransactionPath -Parent) 'old-profile.json')
            )) -ceq [Convert]::ToBase64String($profileBeforeUpgrade) -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes(
                (Join-Path (Split-Path $failedTransactionPath -Parent) 'old-broker-bundle.json')
            )) -ceq [Convert]::ToBase64String($bundleBindingBeforeUpgrade)
        ) ('Upgrade rollback failed at ' + $failureStage + ': ' + $failedUpgrade.text +
            '; transaction=' + ($failedTransaction | ConvertTo-Json -Depth 8 -Compress) +
            '; receiptsBefore=' + ($installReceiptsBeforeUpgrade -join ',') +
            '; receiptsAfter=' + ($installReceiptsAfterFailure -join ','))

        $probe = Invoke-SelfTestPowerShell -Script $submitScript -Arguments `
            (Get-SelfTestSubmitArguments -BrokerRequestId ([guid]::NewGuid().ToString('D')) `
                -Capability 'StartCandidateRuntime' -ChildRequestId ([guid]::NewGuid().ToString('D')) `
                -LeaseToken $script:lease.Token)
        $probeEnvelope = ConvertFrom-SelfTestEnvelope $probe
        Assert-SelfTest ($probe.exitCode -eq 0 -and
            [string]$probeEnvelope.capability -ceq 'StartCandidateRuntime') `
            ('The restored old broker was not usable after ' + $failureStage + ': ' + $probe.text)
        $tests.Add('upgrade-rollback-' + $failureStage)
    }

    $upgradeRequestId = [guid]::NewGuid().ToString('D')
    $upgradeArguments = Get-SelfTestInstallArguments -InstallRequestId $upgradeRequestId `
        -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot -UpgradeExisting
    $upgrade = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $upgradeArguments
    $upgradeEnvelope = ConvertFrom-SelfTestEnvelope $upgrade
    $upgradeTransactionPath = Join-Path $installationTransactionRoot `
        ($upgradeRequestId.ToLowerInvariant() + '\transaction.json')
    $upgradeTransaction = [IO.File]::ReadAllText(
        $upgradeTransactionPath, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $upgradedProfile = Read-DysonCutoverBrokerProfile $script:brokerRoot $script:brokerProfileFile
    $upgradedTaskIntent = [IO.File]::ReadAllText(
        $taskIntentPath, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest (
        $upgrade.exitCode -eq 0 -and
        [string]$upgradeEnvelope.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -and
        [bool]$upgradeEnvelope.upgraded -and -not [bool]$upgradeEnvelope.reused -and
        [string]$upgradeEnvelope.previousProfileFingerprint -ceq $oldProfileFingerprint -and
        [string]$upgradeEnvelope.brokerBundleSha256 -cmatch '^[0-9a-f]{64}$' -and
        [string]$upgradeTransaction.state -ceq 'committed' -and
        (Test-DysonCutoverBrokerSamePath $upgradedProfile.brokerScriptRoot $candidateBrokerScripts) -and
        (Test-DysonCutoverBrokerSamePath $upgradedProfile.cutoverScriptRoot $candidateCutoverRoot) -and
        ([string]$upgradedTaskIntent.arguments).IndexOf(
            (Join-Path $candidateBrokerScripts 'Invoke-DysonCutoverBrokerWorker.ps1'),
            [StringComparison]::OrdinalIgnoreCase
        ) -ge 0
    ) ('Cross-release upgrade did not commit the candidate fixed task/profile: ' + $upgrade.text)
    $tests.Add('cross-release-upgrade')

    $upgradeReceiptPath = Join-Path $installationReceiptRoot ($upgradeRequestId.ToLowerInvariant() + '.json')
    $upgradeReceiptBeforeReplay = [IO.File]::ReadAllBytes($upgradeReceiptPath)
    $upgradeReplay = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $upgradeArguments
    $upgradeReplayEnvelope = ConvertFrom-SelfTestEnvelope $upgradeReplay
    Assert-SelfTest ($upgradeReplay.exitCode -eq 0 -and [bool]$upgradeReplayEnvelope.reused -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($upgradeReceiptPath)) -ceq
            [Convert]::ToBase64String($upgradeReceiptBeforeReplay)) `
        'An exact committed upgrade replay changed its durable receipt.'
    $tests.Add('upgrade-request-replay')

    $sameReleaseProfileBefore = [IO.File]::ReadAllBytes($script:brokerProfileFile)
    $sameReleaseBindingBefore = [IO.File]::ReadAllBytes($bundleBindingPath)
    $sameReleaseTaskBefore = [IO.File]::ReadAllBytes($taskIntentPath)
    $sameReleaseRequestId = [guid]::NewGuid().ToString('D')
    $sameRelease = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments `
        (Get-SelfTestInstallArguments -InstallRequestId $sameReleaseRequestId `
            -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot)
    $sameReleaseEnvelope = ConvertFrom-SelfTestEnvelope $sameRelease
    Assert-SelfTest ($sameRelease.exitCode -eq 0 -and [bool]$sameReleaseEnvelope.reused -and
        -not [bool]$sameReleaseEnvelope.upgraded -and
        -not (Test-Path -LiteralPath (Join-Path $installationTransactionRoot $sameReleaseRequestId)) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($sameReleaseProfileBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($bundleBindingPath)) -ceq
            [Convert]::ToBase64String($sameReleaseBindingBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskIntentPath)) -ceq
            [Convert]::ToBase64String($sameReleaseTaskBefore)) `
        'A same-release install was not idempotent.'
    $tests.Add('same-release-idempotent')

    $candidateSelfTestPath = Join-Path $candidateBrokerScripts 'SelfTest-DysonCutoverBroker.ps1'
    $candidateSelfTestBytes = [IO.File]::ReadAllBytes($candidateSelfTestPath)
    try {
        [IO.File]::AppendAllText($candidateSelfTestPath, "# tampered fixture`n", [Text.UTF8Encoding]::new($false))
        $tamperRequestId = [guid]::NewGuid().ToString('D')
        $tamperedUpgrade = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments `
            (Get-SelfTestInstallArguments -InstallRequestId $tamperRequestId `
                -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot)
    }
    finally { [IO.File]::WriteAllBytes($candidateSelfTestPath, $candidateSelfTestBytes) }
    $tamperedEnvelope = ConvertFrom-SelfTestEnvelope $tamperedUpgrade
    Assert-SelfTest ($tamperedUpgrade.exitCode -eq 1 -and
        [string]$tamperedEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH' -and
        -not (Test-Path -LiteralPath (Join-Path $installationReceiptRoot ($tamperRequestId + '.json'))) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($sameReleaseProfileBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskIntentPath)) -ceq
            [Convert]::ToBase64String($sameReleaseTaskBefore)) `
        ('A tampered retained six-file broker bundle was accepted or changed installed state: ' +
            $tamperedUpgrade.text)
    $tests.Add('tampered-bundle-reject')

    $redirectedReleaseRoot = Join-Path $fixtureRoot 'redirected-candidate-release'
    $redirectedScriptsParent = Join-Path $redirectedReleaseRoot 'scripts'
    [void][IO.Directory]::CreateDirectory($redirectedScriptsParent)
    Copy-Item -LiteralPath $candidateCutoverRoot -Destination $redirectedScriptsParent `
        -Recurse -Force -ErrorAction Stop
    $redirectedCutoverRoot = Join-Path $redirectedScriptsParent 'windows'
    $redirectedBrokerScripts = Join-Path $redirectedCutoverRoot 'cutover-broker'
    Remove-Item -LiteralPath $redirectedBrokerScripts -Recurse -Force
    [void](New-Item -ItemType Junction -Path $redirectedBrokerScripts -Target $candidateBrokerScripts -ErrorAction Stop)
    $redirectedInstaller = Join-Path $redirectedBrokerScripts 'Install-DysonCutoverBrokerTask.ps1'
    $redirectedRequestId = [guid]::NewGuid().ToString('D')
    $redirectedUpgrade = Invoke-SelfTestPowerShell -Script $redirectedInstaller -Arguments `
        (Get-SelfTestInstallArguments -InstallRequestId $redirectedRequestId `
            -BrokerScripts $redirectedBrokerScripts -CutoverRoot $redirectedCutoverRoot)
    $redirectedEnvelope = ConvertFrom-SelfTestEnvelope $redirectedUpgrade
    Assert-SelfTest ($redirectedUpgrade.exitCode -eq 1 -and
        [string]$redirectedEnvelope.error.code -in @(
            'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID',
            'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
        ) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($sameReleaseProfileBefore)) `
        'A redirected candidate broker bundle was accepted or changed the installed profile.'
    $tests.Add('redirected-bundle-reject')

    [void](Exit-DysonHostMutationLease -Lease $script:lease -State released)
    $lease = $null
    $script:lease = $null

    $removeProfile = Read-DysonCutoverBrokerProfile $script:brokerRoot $script:brokerProfileFile
    $removeBindingPath = Join-Path $script:brokerRoot 'broker-bundle.json'
    $removeBinding = [IO.File]::ReadAllText(
        $removeBindingPath, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $removeTaskIntentPath = Join-Path $script:shadowRoot 'task-intent.json'
    $removeProfileBytes = [IO.File]::ReadAllBytes($script:brokerProfileFile)
    $removeBindingBytes = [IO.File]::ReadAllBytes($removeBindingPath)
    $removeTaskBytes = [IO.File]::ReadAllBytes($removeTaskIntentPath)
    $authorityBytesBeforeRemove = [IO.File]::ReadAllBytes($script:authorityProfileFile)
    $installationReceiptNamesBeforeRemove = @(Get-ChildItem -LiteralPath $installationReceiptRoot -File |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    foreach ($resolvedInterruptedPath in @($intentPaths.request, $intentPaths.intent)) {
        if (Test-Path -LiteralPath $resolvedInterruptedPath -PathType Leaf) {
            Remove-DysonCutoverBrokerPlainFile $resolvedInterruptedPath
        }
    }

    $driftRemoveRequestId = [guid]::NewGuid().ToString('D')
    $driftRemoveArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $driftRemoveRequestId `
            -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot
    ) + @(
        '-Operation', 'RemoveCurrent',
        '-ExpectedProfileFingerprint', ('0' * 64),
        '-ExpectedBrokerBundleSha256', ([string]$removeBinding.brokerBundleSha256)
    )
    $driftRemove = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $driftRemoveArguments
    $driftRemoveEnvelope = ConvertFrom-SelfTestEnvelope $driftRemove
    Assert-SelfTest ($driftRemove.exitCode -eq 1 -and
        [string]$driftRemoveEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED' -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($removeProfileBytes) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($removeTaskIntentPath)) -ceq
            [Convert]::ToBase64String($removeTaskBytes)) `
        'RemoveCurrent accepted a drifted expected profile fingerprint or mutated broker state.'
    $tests.Add('remove-current-drift-reject')

    $pendingRequestPath = Join-Path (Join-Path $script:brokerRoot 'requests') `
        (([guid]::NewGuid().ToString('D').ToLowerInvariant()) + '.json')
    [IO.File]::WriteAllText($pendingRequestPath, "{}`n", [Text.UTF8Encoding]::new($false))
    $pendingRemoveRequestId = [guid]::NewGuid().ToString('D')
    $pendingRemoveArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $pendingRemoveRequestId `
            -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot
    ) + @(
        '-Operation', 'RemoveCurrent',
        '-ExpectedProfileFingerprint', ([string]$removeProfile.profileFingerprint),
        '-ExpectedBrokerBundleSha256', ([string]$removeBinding.brokerBundleSha256)
    )
    $pendingRemove = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $pendingRemoveArguments
    $pendingRemoveEnvelope = ConvertFrom-SelfTestEnvelope $pendingRemove
    Remove-Item -LiteralPath $pendingRequestPath -Force
    Assert-SelfTest ($pendingRemove.exitCode -eq 1 -and
        [string]$pendingRemoveEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED' -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($removeProfileBytes)) `
        'RemoveCurrent accepted pending broker work or mutated the profile.'
    $tests.Add('remove-current-pending-reject')

    $failedRemoveRequestId = [guid]::NewGuid().ToString('D')
    $failedRemoveArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $failedRemoveRequestId `
            -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot
    ) + @(
        '-Operation', 'RemoveCurrent',
        '-ExpectedProfileFingerprint', ([string]$removeProfile.profileFingerprint),
        '-ExpectedBrokerBundleSha256', ([string]$removeBinding.brokerBundleSha256)
    )
    try {
        $env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE = 'compensate-after-profile'
        $failedRemove = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $failedRemoveArguments
    }
    finally { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE -ErrorAction SilentlyContinue }
    $failedRemoveEnvelope = ConvertFrom-SelfTestEnvelope $failedRemove
    Assert-SelfTest ($failedRemove.exitCode -eq 1 -and
        [string]$failedRemoveEnvelope.error.code -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED' -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:brokerProfileFile)) -ceq
            [Convert]::ToBase64String($removeProfileBytes) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($removeBindingPath)) -ceq
            [Convert]::ToBase64String($removeBindingBytes) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($removeTaskIntentPath)) -ceq
            [Convert]::ToBase64String($removeTaskBytes)) `
        ('A failed RemoveCurrent operation did not restore the exact broker preimage: ' + $failedRemove.text +
            '; profileExists=' + (Test-Path -LiteralPath $script:brokerProfileFile) +
            '; bindingExists=' + (Test-Path -LiteralPath $removeBindingPath) +
            '; taskExists=' + (Test-Path -LiteralPath $removeTaskIntentPath) +
            '; stages=' + (@(Get-Content -LiteralPath (Join-Path $script:shadowRoot 'install-stage.log') |
                Select-Object -Last 6) -join ','))
    $tests.Add('remove-current-rollback')

    $removeRequestId = [guid]::NewGuid().ToString('D')
    $removeArguments = @(
        Get-SelfTestInstallArguments -InstallRequestId $removeRequestId `
            -BrokerScripts $candidateBrokerScripts -CutoverRoot $candidateCutoverRoot
    ) + @(
        '-Operation', 'RemoveCurrent',
        '-ExpectedProfileFingerprint', ([string]$removeProfile.profileFingerprint),
        '-ExpectedBrokerBundleSha256', ([string]$removeBinding.brokerBundleSha256)
    )
    $remove = Invoke-SelfTestPowerShell -Script $candidateInstaller -Arguments $removeArguments
    $removeEnvelope = ConvertFrom-SelfTestEnvelope $remove
    $installationReceiptNamesAfterRemove = @(Get-ChildItem -LiteralPath $installationReceiptRoot -File |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    Assert-SelfTest ($remove.exitCode -eq 0 -and
        [string]$removeEnvelope.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_RECEIPT_V1' -and
        [string]$removeEnvelope.operation -ceq 'removed-current' -and [bool]$removeEnvelope.removed -and
        -not (Test-Path -LiteralPath $script:brokerProfileFile) -and
        -not (Test-Path -LiteralPath $removeBindingPath) -and
        -not (Test-Path -LiteralPath $removeTaskIntentPath) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:authorityProfileFile)) -ceq
            [Convert]::ToBase64String($authorityBytesBeforeRemove) -and
        $installationReceiptNamesAfterRemove.Count -eq ($installationReceiptNamesBeforeRemove.Count + 1) -and
        (Test-Path -LiteralPath (Join-Path $script:shadowRoot 'directory-acl-intent.json') -PathType Leaf)) `
        ('RemoveCurrent did not preserve authority/receipts while removing only task/profile state: ' + $remove.text)
    $tests.Add('remove-current')

    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_SELFTEST_V1'
        schemaVersion = 1
        status = 'passed'
        tests = @($tests)
        count = $tests.Count
    } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}
catch {
    if ($null -ne $lease -and $lease.Active) {
        try { [void](Exit-DysonHostMutationLease -Lease $lease -State abandoned) } catch {}
    }
    if (Get-Variable -Name lease -Scope Script -ErrorAction SilentlyContinue) {
        $scriptLease = Get-Variable -Name lease -Scope Script -ValueOnly -ErrorAction SilentlyContinue
        if ($null -ne $scriptLease -and $scriptLease.Active) {
            try { [void](Exit-DysonHostMutationLease -Lease $scriptLease -State abandoned) } catch {}
        }
    }
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_SELFTEST_V1'
        schemaVersion = 1
        status = 'failed'
        error = $_.Exception.Message
        tests = @($tests)
    } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
finally {
    if ($null -eq $priorSelfTest) { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST -ErrorAction SilentlyContinue }
    else { $env:DYSON_CUTOVER_BROKER_SELFTEST = $priorSelfTest }
    if ($null -eq $priorChildMode) { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE -ErrorAction SilentlyContinue }
    else { $env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE = $priorChildMode }
    if ($null -eq $priorInstallFailStage) { Remove-Item Env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE -ErrorAction SilentlyContinue }
    else { $env:DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE = $priorInstallFailStage }
    if (Test-Path -LiteralPath $fixtureRoot -PathType Container) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
