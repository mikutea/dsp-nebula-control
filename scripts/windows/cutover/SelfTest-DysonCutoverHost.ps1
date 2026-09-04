[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$cutoverRoot = $PSScriptRoot
$windowsRoot = Split-Path $cutoverRoot -Parent
$evidenceScript = Join-Path $cutoverRoot 'Get-DysonCutoverEvidence.ps1'
$actionScript = Join-Path $cutoverRoot 'Invoke-DysonCutoverAction.ps1'
$commonScript = Join-Path $cutoverRoot 'DysonCutoverHost.Common.ps1'
$leaseCommon = Join-Path $windowsRoot 'DysonHostMutationLease.Common.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-cutover-host-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $testRoot 'fictional-project'
$dataRoot = Join-Path $testRoot 'fictional-data'
$profileRoot = Join-Path $dataRoot 'authority-inventory'
$profileFile = Join-Path $profileRoot 'authority-profile.json'
$previousRoot = Join-Path $dataRoot 'private\gsmanager-authority'
$bootstrapRoot = Join-Path $testRoot 'game-bootstrap'
$transactionRoot = Join-Path $testRoot 'runtime-task-transactions'
$shadowRoot = Join-Path $testRoot 'shadow'
$serviceUser = '.\DysonServer'
$gamePort = 8469
$lease = $null
$tests = [Collections.Generic.List[string]]::new()

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('SELFTEST_FAILED: ' + $Message) }
}

function Assert-SelfTestOwnerAclModel {
    foreach ($directory in @($true, $false)) {
        $security = New-CutoverHostOwnerSecurity $directory
        Assert-SelfTest (Test-CutoverHostOwnerSecurity $security $directory) 'runtime-owner ACL model was not exact'
        $rules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
            [Security.AccessControl.FileSystemRights]::Delete -bor
            [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
            [Security.AccessControl.FileSystemRights]::TakeOwnership
        $writers = @($rules | Where-Object { ([int]$_.FileSystemRights -band [int]$writeMask) -ne 0 })
        Assert-SelfTest ($writers.Count -eq 2 -and
            @($writers | Where-Object { $_.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544') }).Count -eq 2) `
            'runtime-owner ACL granted non-broker write authority'
    }
}

function Write-SelfTestText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-SelfTestNativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-SelfTestScript {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $native = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Arguments
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $powershell
    $info.Arguments = (($native | ForEach-Object { ConvertTo-SelfTestNativeArgument ([string]$_) }) -join ' ')
    $info.WorkingDirectory = $testRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'SELFTEST_FAILED: child process did not start' }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            try { $process.Kill() } catch {}
            throw 'SELFTEST_FAILED: child process timed out'
        }
        $process.WaitForExit()
        return [pscustomobject][ordered]@{
            exitCode = [int]$process.ExitCode
            stdout = [string]$stdout.GetAwaiter().GetResult()
            stderr = [string]$stderr.GetAwaiter().GetResult()
        }
    }
    finally { $process.Dispose() }
}

function Assert-SelfTestNoLeak {
    param([Parameter(Mandatory)]$Result)
    $combined = ([string]$Result.stdout) + ([string]$Result.stderr)
    Assert-SelfTest (-not $combined.Contains($testRoot)) 'a child result leaked the fixture root'
    Assert-SelfTest (-not $combined.Contains('fictional-project')) 'a child result leaked a fixture path segment'
    Assert-SelfTest ([string]$Result.stderr -eq '') 'a child emitted unbounded stderr'
}

function ConvertFrom-SelfTestResult {
    param([Parameter(Mandatory)]$Result)
    Assert-SelfTest ([Text.Encoding]::UTF8.GetByteCount([string]$Result.stdout) -le 65536) 'a child emitted oversized JSON'
    try { return ([string]$Result.stdout | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'SELFTEST_FAILED: a child emitted invalid JSON' }
}

function Get-SelfTestCommonArguments {
    param([Parameter(Mandatory)][string]$RequestId)
    return @(
        '-ProjectRoot', $projectRoot, '-ProfileFile', $profileFile,
        '-RuntimeBootstrapRoot', $bootstrapRoot, '-RuntimeTaskTransactionRoot', $transactionRoot,
        '-ServiceUser', $serviceUser, '-GamePort', [string]$gamePort,
        '-AuthorityInventoryRevision', $script:inventoryRevision, '-RequestId', $RequestId,
        '-Backend', 'Shadow', '-ShadowRoot', $shadowRoot
    )
}

function Invoke-SelfTestEvidence {
    param([string]$Revision = $script:inventoryRevision)
    $requestId = [guid]::NewGuid().ToString('D')
    $arguments = Get-SelfTestCommonArguments $requestId
    $revisionIndex = [Array]::IndexOf($arguments, '-AuthorityInventoryRevision') + 1
    $arguments[$revisionIndex] = $Revision
    return Invoke-SelfTestScript $evidenceScript $arguments
}

function Invoke-SelfTestAction {
    param([Parameter(Mandatory)][string]$Action, [string]$InstanceId, [string]$Token, [switch]$Preview)
    if ([string]::IsNullOrWhiteSpace($InstanceId)) { $InstanceId = [string]$lease.InstanceId }
    if ([string]::IsNullOrWhiteSpace($Token)) { $Token = [string]$lease.Token }
    $requestId = [guid]::NewGuid().ToString('D')
    $arguments = (Get-SelfTestCommonArguments $requestId) + @(
        '-Action', $Action, '-DataRoot', $dataRoot,
        '-LeaseInstanceId', $InstanceId, '-LeaseToken', $Token, '-Confirm:$false'
    )
    if ($Preview) { $arguments += '-WhatIf' }
    return Invoke-SelfTestScript $actionScript $arguments
}

function Assert-SelfTestEvidenceReceipt {
    param([Parameter(Mandatory)]$Result)
    Assert-SelfTest ($Result.exitCode -eq 0) 'evidence returned a failure exit code'
    Assert-SelfTestNoLeak $Result
    $receipt = ConvertFrom-SelfTestResult $Result
    Assert-SelfTest ((@($receipt.PSObject.Properties.Name) -join ',') -ceq
        'protocol,schemaVersion,requestId,authorityInventoryRevision,evidence') 'evidence receipt was not strict'
    Assert-SelfTest ([string]$receipt.protocol -ceq 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1' -and
        [int]$receipt.schemaVersion -eq 1 -and [string]$receipt.authorityInventoryRevision -ceq $script:inventoryRevision) `
        'evidence receipt binding changed'
    Assert-SelfTest ((@($receipt.evidence.PSObject.Properties.Name) -join ',') -ceq
        'previousDefined,previousEnabled,candidateDefined,candidateEnabled,unexpectedAuthorityPresent,processState,portState,previousHealthy,candidateHealthy') `
        'bounded evidence fields changed'
    return $receipt
}

function Assert-SelfTestActionReceipt {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$Action)
    if ($Result.exitCode -ne 0) {
        $failed = ConvertFrom-SelfTestResult $Result
        throw ('SELFTEST_FAILED: ' + $Action + ' returned ' + [string]$failed.error.code)
    }
    Assert-SelfTestNoLeak $Result
    $receipt = ConvertFrom-SelfTestResult $Result
    Assert-SelfTest ((@($receipt.PSObject.Properties.Name) -join ',') -ceq
        'protocol,schemaVersion,requestId,authorityInventoryRevision,action,status') 'action receipt was not strict'
    Assert-SelfTest ([string]$receipt.protocol -ceq 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1' -and
        [int]$receipt.schemaVersion -eq 1 -and [string]$receipt.authorityInventoryRevision -ceq $script:inventoryRevision -and
        [string]$receipt.action -ceq $Action -and [string]$receipt.status -ceq 'succeeded') `
        ($Action + ' receipt binding changed')
    return $receipt
}

function Assert-SelfTestFailure {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$ExpectedCode)
    Assert-SelfTest ($Result.exitCode -ne 0) 'an expected failure returned success'
    Assert-SelfTestNoLeak $Result
    $message = ConvertFrom-SelfTestResult $Result
    $matches = ((@($message.PSObject.Properties.Name) -join ',') -ceq 'ok,error' -and
        (@($message.error.PSObject.Properties.Name) -join ',') -ceq 'code' -and
        -not [bool]$message.ok -and [string]$message.error.code -ceq $ExpectedCode)
    if (-not $matches) { throw ('SELFTEST_FAILED: unexpected code-only failure ' + [string]$message.error.code + ' expected ' + $ExpectedCode) }
}

function New-SelfTestCandidateDescriptors {
    param([Parameter(Mandatory)][bool]$Enabled)
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return [pscustomobject][ordered]@{
        start = [pscustomobject][ordered]@{
            taskName = 'Dyson-Nebula-Server'; taskPath = '\'; execute = $powerShellPath
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups 60' -f (Join-Path $bootstrapRoot 'Start-DysonServer.ps1'), $projectRoot)
            userId = $serviceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'AtLogOn'; triggerUserId = $serviceUser; triggerDelay = 'PT20S'
            executionTimeLimit = 'PT0S'; multipleInstances = 'IgnoreNew'; restartCount = 3
            restartInterval = 'PT1M'; startWhenAvailable = $true; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge from the stable bootstrap root.'
        }
        stop = [pscustomobject][ordered]@{
            taskName = 'Dyson-Nebula-Stop'; taskPath = '\'; execute = $powerShellPath
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f (Join-Path $bootstrapRoot 'Stop-DysonServer.ps1'), $projectRoot)
            userId = $serviceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'None'; triggerUserId = $null; triggerDelay = $null; executionTimeLimit = 'PT5M'
            multipleInstances = 'IgnoreNew'; restartCount = 0; restartInterval = $null
            startWhenAvailable = $false; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.'
        }
    }
}

function New-SelfTestTask {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Xml,
        [Parameter(Mandatory)][bool]$Enabled,
        [Parameter(Mandatory)][bool]$Running,
        [AllowNull()]$Descriptor
    )
    return [pscustomobject][ordered]@{
        taskName = $Name; taskPath = '\'
        xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($Xml))
        enabled = $Enabled; running = $Running; descriptor = $Descriptor
    }
}

function Write-SelfTestTasks {
    param([Parameter(Mandatory)][object[]]$Tasks)
    $state = [pscustomobject][ordered]@{ protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_TASKS_V1'; tasks = @($Tasks) }
    Write-SelfTestText (Join-Path $shadowRoot 'tasks.json') ((ConvertTo-CutoverHostJson $state) + "`n")
}

function Read-SelfTestTasks {
    return (Get-Content -LiteralPath (Join-Path $shadowRoot 'tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Set-SelfTestCandidateMode {
    param([ValidateSet('prepared', 'active')][string]$Mode)
    $state = Read-SelfTestTasks
    $descriptors = New-SelfTestCandidateDescriptors ($Mode -ceq 'active')
    foreach ($binding in @(@('Dyson-Nebula-Server', $descriptors.start), @('Dyson-Nebula-Stop', $descriptors.stop))) {
        $task = @($state.tasks | Where-Object { [string]$_.taskName -ceq [string]$binding[0] })[0]
        $task.enabled = ($Mode -ceq 'active')
        $task.descriptor = $binding[1]
    }
    Write-SelfTestTasks @($state.tasks)
}

function Set-SelfTestCandidateLegacy {
    $state = Read-SelfTestTasks
    foreach ($name in @('Dyson-Nebula-Server', 'Dyson-Nebula-Stop')) {
        $task = @($state.tasks | Where-Object { [string]$_.taskName -ceq $name })[0]
        $task.enabled = $false
        $task.descriptor = $null
    }
    Write-SelfTestTasks @($state.tasks)
}

function Write-SelfTestRuntime {
    param([ValidateSet('stopped', 'running', 'ambiguous-port', 'foreign-process')][string]$Mode)
    $processId = 4242
    $processes = @()
    $pidRecord = $null
    $tcp = @()
    $udp = @()
    if ($Mode -ne 'stopped') {
        $processes = @([pscustomobject][ordered]@{ id = $processId; path = (Join-Path $projectRoot 'server\DSPGAME.exe') })
        $pidRecord = $processId; $tcp = @($processId); $udp = @($processId)
    }
    if ($Mode -ceq 'ambiguous-port') { $udp = @(9999) }
    if ($Mode -ceq 'foreign-process') { $processes += [pscustomobject][ordered]@{ id = 4343; path = (Join-Path $testRoot 'foreign\DSPGAME.exe') } }
    $runtime = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_RUNTIME_V1'
        dspProcesses = $processes; pidRecord = $pidRecord; tcpOwners = $tcp; udpOwners = $udp
    }
    Write-SelfTestText (Join-Path $shadowRoot 'runtime.json') ((ConvertTo-CutoverHostJson $runtime) + "`n")
}

function Reset-SelfTestFixture {
    param([ValidateSet('running', 'stopped')][string]$Runtime = 'running')
    $prepared = New-SelfTestCandidateDescriptors $false
    $tasks = @(
        (New-SelfTestTask 'Dyson-GSManager' '<Task><Panel>fixed</Panel></Task>' $true $true $null),
        (New-SelfTestTask 'Dyson-GSManager-Server' '<Task><PreviousStart>fixed</PreviousStart></Task>' $true $false $null),
        (New-SelfTestTask 'Dyson-GSManager-Stop' '<Task><PreviousStop>fixed</PreviousStop></Task>' $true $false $null),
        (New-SelfTestTask 'Dyson-Nebula-Server' '<Task><LegacyStart>disabled</LegacyStart></Task>' $false $false $prepared.start),
        (New-SelfTestTask 'Dyson-Nebula-Stop' '<Task><LegacyStop>disabled</LegacyStop></Task>' $false $false $prepared.stop)
    )
    Write-SelfTestTasks $tasks
    Write-SelfTestRuntime $Runtime
    $ownerFile = Join-Path $dataRoot 'cutover-host\runtime-owner.json'
    if (Test-Path -LiteralPath $ownerFile -PathType Leaf) { Remove-Item -LiteralPath $ownerFile -Force }
    [IO.File]::WriteAllText((Join-Path $shadowRoot 'writes.log'), '', [Text.UTF8Encoding]::new($false))
}

function New-SelfTestProfile {
    $tasks = (Read-SelfTestTasks).tasks
    $taskProfile = {
        param([string]$Name)
        $task = @($tasks | Where-Object { [string]$_.taskName -ceq $Name })[0]
        return [pscustomobject][ordered]@{
            taskName = $Name; taskPath = '\'
            definitionSha256 = Get-CutoverHostSha256Bytes ([Convert]::FromBase64String([string]$task.xmlBase64))
            enabled = $true
        }
    }
    $prepared = New-SelfTestCandidateDescriptors $false
    $active = New-SelfTestCandidateDescriptors $true
    $dataInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $dataRoot
    $core = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'; schemaVersion = 1
        requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant(); requestFingerprint = ('1' * 64)
        projectRootIdentity = Get-CutoverHostPathIdentity $projectRoot
        dataRootIdentity = [string]$dataInfo.DataRootIdentity
        authorityRootIdentity = Get-CutoverHostPathIdentity $profileRoot
        runtimeBootstrapIdentity = Get-CutoverHostPathIdentity $bootstrapRoot
        runtimeBootstrapStartSha256 = Get-CutoverHostSha256File (Join-Path $bootstrapRoot 'Start-DysonServer.ps1')
        runtimeBootstrapStopSha256 = Get-CutoverHostSha256File (Join-Path $bootstrapRoot 'Stop-DysonServer.ps1')
        runtimeTaskTransactionRootIdentity = Get-CutoverHostPathIdentity $transactionRoot
        serviceUser = $serviceUser; gamePort = $gamePort
        previousAuthority = [pscustomobject][ordered]@{
            main = & $taskProfile 'Dyson-GSManager'; start = & $taskProfile 'Dyson-GSManager-Server'; stop = & $taskProfile 'Dyson-GSManager-Stop'
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = 'Dyson-Nebula-Server'; stopTaskName = 'Dyson-Nebula-Stop'; taskPath = '\'
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = (& $taskProfile 'Dyson-Nebula-Server').definitionSha256
                stopDefinitionSha256 = (& $taskProfile 'Dyson-Nebula-Stop').definitionSha256
                expectedEnabledBeforeIsolation = $true; expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.start)
                stopDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.stop)
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.start)
                stopDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.stop)
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = Get-CutoverHostSha256Text (
            (Get-CutoverHostSha256File (Join-Path $previousRoot 'start-dyson-server.ps1')) + ':' +
            (Get-CutoverHostSha256File (Join-Path $previousRoot 'stop-dyson-server.ps1'))
        )
    }
    $coreJson = ConvertTo-CutoverHostJson $core
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['inventoryRevision'] = Get-CutoverHostSha256Text $coreJson
    $script:inventoryRevision = [string]$profile.inventoryRevision
    Write-SelfTestText $profileFile ((ConvertTo-CutoverHostJson $profile) + "`n")
}

try {
    foreach ($dependency in @($evidenceScript, $actionScript, $commonScript, $leaseCommon, $powershell)) {
        if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'SELFTEST_FAILED: dependency unavailable' }
    }
    [IO.Directory]::CreateDirectory((Join-Path $projectRoot 'server')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $projectRoot 'run')) | Out-Null
    [IO.Directory]::CreateDirectory($profileRoot) | Out-Null
    [IO.Directory]::CreateDirectory($previousRoot) | Out-Null
    [IO.Directory]::CreateDirectory($bootstrapRoot) | Out-Null
    [IO.Directory]::CreateDirectory($transactionRoot) | Out-Null
    [IO.Directory]::CreateDirectory($shadowRoot) | Out-Null
    Write-SelfTestText (Join-Path $projectRoot 'server\DSPGAME.exe') 'fictional-dsp-binary'
    Write-SelfTestText (Join-Path $previousRoot 'start-dyson-server.ps1') 'previous-start-fixture'
    Write-SelfTestText (Join-Path $previousRoot 'stop-dyson-server.ps1') 'previous-stop-fixture'
    Write-SelfTestText (Join-Path $bootstrapRoot 'Start-DysonServer.ps1') 'candidate-start-fixture'
    Write-SelfTestText (Join-Path $bootstrapRoot 'Stop-DysonServer.ps1') 'candidate-stop-fixture'
    Write-SelfTestText (Join-Path $shadowRoot '.dyson-cutover-host-selftest') 'fixture'
    Write-SelfTestText (Join-Path $shadowRoot 'writes.log') ''
    . $leaseCommon
    . $commonScript
    Assert-SelfTestOwnerAclModel
    $env:DYSON_CUTOVER_HOST_SELFTEST = '1'
    Reset-SelfTestFixture running
    New-SelfTestProfile

    Set-SelfTestCandidateLegacy
    $legacy = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest (-not [bool]$legacy.evidence.candidateDefined -and -not [bool]$legacy.evidence.candidateEnabled -and
        -not [bool]$legacy.evidence.unexpectedAuthorityPresent) 'the fixed disabled legacy preimage was not recognized'
    Set-SelfTestCandidateMode prepared
    $tests.Add('legacy-preimage-transition')

    $baseline = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([bool]$baseline.evidence.previousDefined -and [bool]$baseline.evidence.previousEnabled -and
        [bool]$baseline.evidence.candidateDefined -and -not [bool]$baseline.evidence.candidateEnabled -and
        [string]$baseline.evidence.processState -ceq 'previous-only' -and [string]$baseline.evidence.portState -ceq 'previous' -and
        [bool]$baseline.evidence.previousHealthy -and -not [bool]$baseline.evidence.unexpectedAuthorityPresent) `
        'baseline evidence was not the previous-authority state'
    $tests.Add('evidence-baseline')

    $lease = Enter-DysonHostMutationLease -DataRoot $dataRoot -Owner 'cutover-host-selftest' `
        -Operation 'cutover-host-selftest' -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0

    $previewWrites = [IO.File]::ReadAllText((Join-Path $shadowRoot 'writes.log'))
    $previewResult = Invoke-SelfTestAction 'DisablePreviousAuthority' -Preview
    Assert-SelfTest ($previewResult.exitCode -eq 0) 'dry-run preview failed'
    Assert-SelfTestNoLeak $previewResult
    $preview = ConvertFrom-SelfTestResult $previewResult
    Assert-SelfTest ([string]$preview.protocol -ceq 'DYSON_CONTROL_CUTOVER_ACTION_PREVIEW_V1' -and
        [bool]$preview.dryRun -and [string]$preview.action -ceq 'DisablePreviousAuthority') 'dry-run preview contract changed'
    Assert-SelfTest ([IO.File]::ReadAllText((Join-Path $shadowRoot 'writes.log')) -ceq $previewWrites) 'dry-run preview caused a write'
    $tests.Add('dry-run-no-write')

    Assert-SelfTestFailure (Invoke-SelfTestAction 'StartCandidateRuntime') 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    $tests.Add('precondition-fail-closed')

    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = 'LeaseLossAfterMutation'
    Assert-SelfTestFailure (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DYSON_CONTROL_CUTOVER_HOST_LEASE_LOST'
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
    $disabled = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest (-not [bool]$disabled.evidence.previousEnabled -and [string]$disabled.evidence.processState -ceq 'previous-only') `
        'disabled previous authority lost runtime ownership'
    Assert-SelfTest (Test-Path -LiteralPath (Join-Path $profileRoot 'runtime-owner.json') -PathType Leaf) `
        'runtime owner was not stored beside the protected authority profile'
    Assert-SelfTest (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'cutover-host\runtime-owner.json'))) `
        'legacy mutable runtime-owner path became a second source of truth'
    $tests.Add('disable-previous-idempotent')

    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopPreviousRuntime') 'StopPreviousRuntime' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopPreviousRuntime') 'StopPreviousRuntime' | Out-Null
    $stopped = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest (([string]$stopped.evidence.processState -ceq 'none') -and ([string]$stopped.evidence.portState -ceq 'closed')) `
        'previous runtime did not stop cleanly'
    Assert-SelfTest (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'runtime-owner.json'))) `
        'stopped runtime retained its owner marker'
    $tests.Add('stop-previous-idempotent')

    Set-SelfTestCandidateMode active
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StartCandidateRuntime') 'StartCandidateRuntime' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StartCandidateRuntime') 'StartCandidateRuntime' | Out-Null
    $candidateRunning = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([bool]$candidateRunning.evidence.candidateEnabled -and [bool]$candidateRunning.evidence.candidateHealthy -and
        [string]$candidateRunning.evidence.processState -ceq 'candidate-only') 'candidate runtime was not healthy'
    $tests.Add('start-candidate-idempotent')

    Set-SelfTestCandidateMode prepared
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopCandidateRuntime') 'StopCandidateRuntime' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopCandidateRuntime') 'StopCandidateRuntime' | Out-Null
    $candidateStopped = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest (([string]$candidateStopped.evidence.processState -ceq 'none') -and -not [bool]$candidateStopped.evidence.candidateEnabled) `
        'candidate runtime did not stop with its authority disabled'
    $tests.Add('stop-candidate-idempotent')

    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'EnablePreviousAuthority') 'EnablePreviousAuthority' | Out-Null
    $partial = Read-SelfTestTasks
    $partialPanel = @($partial.tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' })[0]
    $partialPanel.running = $false
    Write-SelfTestTasks @($partial.tasks)
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'EnablePreviousAuthority') 'EnablePreviousAuthority' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'EnablePreviousAuthority') 'EnablePreviousAuthority' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StartPreviousRuntime') 'StartPreviousRuntime' | Out-Null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StartPreviousRuntime') 'StartPreviousRuntime' | Out-Null
    $rolledBack = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([bool]$rolledBack.evidence.previousEnabled -and [bool]$rolledBack.evidence.previousHealthy -and
        [string]$rolledBack.evidence.processState -ceq 'previous-only') 'previous authority did not recover'
    $tests.Add('enable-start-previous-idempotent')

    Write-SelfTestRuntime ambiguous-port
    $ambiguousPort = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([string]$ambiguousPort.evidence.processState -ceq 'unknown' -and
        [string]$ambiguousPort.evidence.portState -ceq 'unknown') 'UDP ownership ambiguity was guessed'
    Write-SelfTestRuntime foreign-process
    $ambiguousProcess = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([string]$ambiguousProcess.evidence.processState -ceq 'unknown') 'multiple DSP processes were guessed'
    Write-SelfTestRuntime running
    $tests.Add('process-port-ambiguity')

    $state = Read-SelfTestTasks
    $rogueDescriptor = [pscustomobject][ordered]@{
        execute = $powershell
        arguments = ('-NoLogo -File "{0}"' -f (Join-Path $bootstrapRoot 'Start-DysonServer.ps1'))
    }
    $state.tasks += New-SelfTestTask 'Fictional-Rogue-Authority' '<Task>rogue</Task>' $true $false $rogueDescriptor
    Write-SelfTestTasks @($state.tasks)
    $rogue = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ([bool]$rogue.evidence.unexpectedAuthorityPresent) 'an unexpected managed task was not reported'
    Reset-SelfTestFixture running
    $tests.Add('task-drift')

    Assert-SelfTestFailure (Invoke-SelfTestEvidence ('f' * 64)) 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    $bootstrapStart = Join-Path $bootstrapRoot 'Start-DysonServer.ps1'
    $originalBootstrap = [IO.File]::ReadAllBytes($bootstrapStart)
    Write-SelfTestText $bootstrapStart 'drifted-bootstrap'
    Assert-SelfTestFailure (Invoke-SelfTestEvidence) 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    [IO.File]::WriteAllBytes($bootstrapStart, $originalBootstrap)
    $tests.Add('revision-profile-drift')

    $wrongTokenPrefix = if ($lease.Token[0] -ceq 'A') { 'B' } else { 'A' }
    $wrongToken = $wrongTokenPrefix + $lease.Token.Substring(1)
    $writesBefore = [IO.File]::ReadAllText((Join-Path $shadowRoot 'writes.log'))
    Assert-SelfTestFailure (Invoke-SelfTestAction 'DisablePreviousAuthority' -Token $wrongToken) 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
    Assert-SelfTest ([IO.File]::ReadAllText((Join-Path $shadowRoot 'writes.log')) -ceq $writesBefore) 'invalid lease caused a write'
    [void](Exit-DysonHostMutationLease -Lease $lease -State released)
    $lease = $null
    Assert-SelfTestFailure (Invoke-SelfTestAction 'DisablePreviousAuthority' `
        -InstanceId ([guid]::NewGuid().ToString('D')) -Token ('A' * 43)) 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
    $tests.Add('borrowed-lease-loss')

    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_HOST_SELFTEST_V1'
        status = 'passed'
        tests = @($tests)
        testCount = $tests.Count
    } | ConvertTo-Json -Depth 4 -Compress
}
finally {
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
    $env:DYSON_CUTOVER_HOST_SELFTEST = $null
    if ($null -ne $lease -and [bool]$lease.Active) {
        try { [void](Exit-DysonHostMutationLease -Lease $lease -State released) } catch {}
    }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
