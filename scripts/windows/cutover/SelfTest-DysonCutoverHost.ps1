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
    param([Parameter(Mandatory)][string]$Action, [string]$InstanceId, [string]$Token, [switch]$Preview,
        [string]$RequestId = ([guid]::NewGuid().ToString('D')), [switch]$ReconcileOnly)
    if ([string]::IsNullOrWhiteSpace($InstanceId)) { $InstanceId = [string]$lease.InstanceId }
    if ([string]::IsNullOrWhiteSpace($Token)) { $Token = [string]$lease.Token }
    $arguments = (Get-SelfTestCommonArguments $requestId) + @(
        '-Action', $Action, '-DataRoot', $dataRoot,
        '-LeaseInstanceId', $InstanceId, '-LeaseToken', $Token, '-Confirm:$false'
    )
    if ($ReconcileOnly) { $arguments += '-PreviousStopReconcileOnly' }
    if ($Action) {
        $arguments += @('-PreviousStopScriptSha256', (Get-CutoverHostSha256File (Join-Path $windowsRoot 'Stop-DysonServer.ps1')))
    }
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
    param([switch]$Reconstructed)
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
                expectedEnabledBeforeIsolation = (-not [bool]$Reconstructed); expectedEnabledAfterIsolation = $false
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
    if ($Reconstructed) {
        $core | Add-Member NoteProperty authoritySource 'reconstructed-template'
        $core | Add-Member NoteProperty legacyTemplateSha256 ('a' * 64)
    }
    $coreJson = ConvertTo-CutoverHostJson $core
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['inventoryRevision'] = Get-CutoverHostSha256Text $coreJson
    $script:inventoryRevision = [string]$profile.inventoryRevision
    Write-SelfTestText $profileFile ((ConvertTo-CutoverHostJson $profile) + "`n")
}

function Assert-SelfTestBoundStopLeaf {
    $leaf = Join-Path $windowsRoot 'Stop-DysonServer.ps1'
    $pidFile = Join-Path $projectRoot 'run\dspgame.pid'
    $prior = if (Test-Path -LiteralPath $pidFile) { [IO.File]::ReadAllBytes($pidFile) } else { $null }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        [IO.File]::WriteAllText($pidFile, [string]$self.Id)
        $started = [DateTimeOffset]::new($self.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
        foreach ($case in @('generation','identity')) {
            $receiptPath = Join-Path $testRoot ('bound-stop-negative-' + $case + '.json')
            $expectedStarted = if ($case -ceq 'generation') { $started + 1 } else { $started }
            $result = Invoke-SelfTestScript $leaf @(
                '-ProjectRoot', $projectRoot, '-StopRequestId', ([guid]::NewGuid().ToString('D')),
                '-ExpectedProcessId', ([string]$self.Id), '-ExpectedProcessStartedAtUnixMs', ([string]$expectedStarted),
                '-ExpectedScriptSha256', (Get-CutoverHostSha256File $leaf), '-ReceiptPath', $receiptPath, '-TimeoutSeconds', '10'
            )
            $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
            $expectedCode = if ($case -ceq 'generation') { 'DYSON_CONTROL_BOUND_STOP_GENERATION_MISMATCH' } else { 'DYSON_CONTROL_BOUND_STOP_IDENTITY_MISMATCH' }
            Assert-SelfTest ($result.exitCode -eq 1 -and $receipt.status -ceq 'failed' -and $receipt.errorCode -ceq $expectedCode -and
                -not $receipt.signalSent -and -not $receipt.forcedKill -and [IO.File]::ReadAllText($pidFile) -ceq [string]$self.Id) `
                'the bound leaf failed to reject a non-game or stale process generation before signaling'
        }
    }
    finally {
        $self.Dispose()
        if ($null -eq $prior) { [IO.File]::Delete($pidFile) } else { [IO.File]::WriteAllBytes($pidFile, $prior) }
    }
}

function Assert-SelfTestPreviousStopRecovery {
    $legacyBytes = [IO.File]::ReadAllBytes((Join-Path $previousRoot 'stop-dyson-server.ps1'))
    foreach ($point in @('AfterIntent','AfterTaskRegistered','AfterTaskStarted','AfterTerminal','BeforeCleanup','AfterCleanup')) {
        Reset-SelfTestFixture running
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
        $requestId = [guid]::NewGuid().ToString('D')
        $root = Join-Path $profileRoot ('previous-stop\' + $requestId)
        $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = 'PreviousStop-' + $point
        Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED'
        $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
        if ($point -in @('AfterTaskStarted','AfterTerminal','BeforeCleanup','AfterCleanup')) {
            Assert-SelfTestFailure (Invoke-SelfTestAction 'EnablePreviousAuthority') 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED'
        }
        if ($point -ceq 'AfterTaskStarted') {
            [void](Exit-DysonHostMutationLease -Lease $script:lease -State released)
            $script:lease = Enter-DysonHostMutationLease -DataRoot $dataRoot -Owner 'cutover-host-selftest' `
                -Operation 'cutover-host-selftest' -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
        }
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'StopPreviousRuntime' | Out-Null
        $completed = [IO.File]::ReadAllText((Join-Path $root 'completed.json')) | ConvertFrom-Json
        $receipt = [IO.File]::ReadAllText((Join-Path $root 'receipts\stop.json')) | ConvertFrom-Json
        Assert-SelfTest ($completed.status -ceq 'succeeded' -and $completed.taskRemoved -and
            -not (Test-Path (Join-Path $root 'task-shadow.json')) -and $receipt.processExitCode -eq -1073741510 -and -not $receipt.forcedKill) `
            ('compatible stop did not finish its own task/receipt/cleanup contract after ' + $point)
        $signals = @([IO.File]::ReadAllLines((Join-Path $shadowRoot 'writes.log')) | Where-Object { $_ -ceq 'runtime-stop:previous' }).Count
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'StopPreviousRuntime' | Out-Null
        Assert-SelfTest ($signals -eq 1 -and @([IO.File]::ReadAllLines((Join-Path $shadowRoot 'writes.log')) |
            Where-Object { $_ -ceq 'runtime-stop:previous' }).Count -eq 1) 'stop recovery/replay repeated its signal'
        Assert-SelfTest (@([IO.File]::ReadAllLines((Join-Path $shadowRoot 'writes.log')) |
            Where-Object { $_ -ceq 'dispatch:Dyson-GSManager-Stop' }).Count -eq 0) 'compatible stop dispatched the broken legacy task'
    }
    Assert-SelfTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $previousRoot 'stop-dyson-server.ps1'))) -ceq
        [Convert]::ToBase64String($legacyBytes)) 'compatible stop modified the bound legacy script'
    foreach ($fault in @('task-result','receipt-pid','timeout')) {
        Reset-SelfTestFixture running
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
        $requestId = [guid]::NewGuid().ToString('D')
        $root = Join-Path $profileRoot ('previous-stop\' + $requestId)
        $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = if ($fault -ceq 'timeout') { 'PreviousStop-Timeout' } else { 'PreviousStop-AfterTaskStarted' }
        $expectedError = if ($fault -ceq 'timeout') { 'DYSON_CONTROL_CUTOVER_HOST_TASK_TIMEOUT' } else { 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED' }
        Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) $expectedError
        $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
        if ($fault -ceq 'receipt-pid') {
            $path = Join-Path $root 'receipts\stop.json'
            $value = [IO.File]::ReadAllText($path) | ConvertFrom-Json
            $value.expectedProcessId = 9999
            Write-SelfTestText $path (ConvertTo-CutoverHostJson $value)
            $expectedError = 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECEIPT_INVALID'
        }
        else {
            if ($fault -ceq 'timeout') {
                $runtime = [IO.File]::ReadAllText((Join-Path $shadowRoot 'runtime.json')) | ConvertFrom-Json
                Assert-SelfTest ($runtime.dspProcesses.Count -eq 1 -and -not (Test-Path (Join-Path $root 'receipts\stop.json'))) 'a timeout forced or pretended to stop the game'
            }
            $path = Join-Path $root 'task-shadow.json'
            $value = [IO.File]::ReadAllText($path) | ConvertFrom-Json
            $value.lastResult = 1
            $value.state = 'Ready'
            Write-SelfTestText $path (ConvertTo-CutoverHostJson $value)
            $expectedError = 'DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED'
        }
        if ($fault -ceq 'task-result') {
            $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = 'PreviousStop-AfterFailedCleanup'
            Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED'
            $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
        }
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId -ReconcileOnly) 'ReconcilePreviousStop' | Out-Null
        $completed = [IO.File]::ReadAllText((Join-Path $root 'completed.json')) | ConvertFrom-Json
        Assert-SelfTest ($completed.status -ceq 'failed' -and $completed.taskRemoved -and -not (Test-Path (Join-Path $root 'task-shadow.json'))) `
            'a failed task/receipt was converted to success or left an owned task after terminal cleanup'
        Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'EnablePreviousAuthority' -RequestId $requestId) 'EnablePreviousAuthority' | Out-Null
        $evidence = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
        $expectedState = if ($fault -ceq 'timeout') { 'previous-only' } else { 'none' }
        Assert-SelfTest ($evidence.evidence.previousEnabled -and $evidence.evidence.processState -ceq $expectedState) 'failed stop recovery changed the observed game state'
        Assert-SelfTest (([IO.File]::ReadAllText((Join-Path $root 'completed.json')) | ConvertFrom-Json).status -ceq 'failed') 'recovery rewrote stop failure as success'
    }
    Reset-SelfTestFixture running
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
    $requestId = [guid]::NewGuid().ToString('D')
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = 'PreviousStop-AfterTaskRegistered'
    Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED'
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'EnablePreviousAuthority' -RequestId $requestId) 'EnablePreviousAuthority' | Out-Null
    $completed = [IO.File]::ReadAllText((Join-Path $profileRoot ('previous-stop\' + $requestId + '\completed.json'))) | ConvertFrom-Json
    Assert-SelfTest ($completed.status -ceq 'cancelled' -and $completed.taskRemoved) 'rollback did not cancel an unstarted temporary task'
    $evidence = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ($evidence.evidence.previousEnabled -and $evidence.evidence.processState -ceq 'previous-only') 'cancelling an unstarted task stopped the old game'
    Reset-SelfTestFixture running
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null
    $requestId = [guid]::NewGuid().ToString('D')
    $root = Join-Path $profileRoot ('previous-stop\' + $requestId)
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = 'PreviousStop-AfterDispatchIntent'
    Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED'
    $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT = $null
    Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_DISPATCH_UNCERTAIN'
    [IO.File]::Delete((Join-Path $root 'task-shadow.json'))
    Assert-SelfTestFailure (Invoke-SelfTestAction 'StopPreviousRuntime' -RequestId $requestId) 'DYSON_CONTROL_CUTOVER_HOST_STOP_DISPATCH_UNCERTAIN'
    Assert-SelfTest ((Test-Path (Join-Path $root 'dispatch.json')) -and -not (Test-Path (Join-Path $root 'task-shadow.json')) -and
        -not (Test-Path (Join-Path $root 'receipts\stop.json'))) 'uncertain dispatch was re-created or re-signaled'
    # This is an isolated shadow case with no real task/process; discard its
    # deliberately unresolved fixture after asserting that production refuses it.
    Remove-Item -LiteralPath $root -Recurse -Force
}

function Assert-SelfTestProcessExecutableAliases {
    $expected = $script:CutoverHostExpectedExecutable
    $aliasRoot = Join-Path $testRoot 'process-executable-alias'
    $otherRoot = Join-Path $testRoot 'different-executable'
    $runtimePath = Join-Path $shadowRoot 'runtime.json'
    $runtimeBytes = [IO.File]::ReadAllBytes($runtimePath)
    [void][IO.Directory]::CreateDirectory($otherRoot)
    $different = Join-Path $otherRoot 'DSPGAME.exe'
    [IO.File]::WriteAllBytes($different, [IO.File]::ReadAllBytes($expected))
    try {
        [void](New-Item -ItemType Junction -Path $aliasRoot -Target ([IO.Path]::GetDirectoryName($expected)) -ErrorAction Stop)
        $alias = Join-Path $aliasRoot 'DSPGAME.exe'
        Assert-SelfTest (Test-CutoverHostProcessExecutable $expected $expected) 'literal executable path stopped matching'
        Assert-SelfTest (Test-CutoverHostProcessExecutable $alias $expected) 'same final executable path alias was rejected'
        Assert-SelfTest (-not (Test-CutoverHostProcessExecutable $different $expected)) 'same filename and bytes were mistaken for the expected executable'
        Assert-SelfTest (-not (Test-CutoverHostProcessExecutable (Join-Path $otherRoot 'missing.exe') $expected)) 'unresolvable executable path was accepted'
        $locked = [IO.File]::Open($expected, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try {
            Assert-SelfTest (-not (Test-CutoverHostProcessExecutable $alias $expected)) 'executable handle-open failure was accepted'
        }
        finally { $locked.Dispose() }
        & {
            function Get-DysonHostMutationLeaseFinalPathFromHandle { param($Handle); throw 'fictional final-path resolution failure' }
            Assert-SelfTest (-not (Test-CutoverHostProcessExecutable $alias $expected)) 'final-path resolution failure was accepted'
        }
        Write-SelfTestRuntime running
        $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        $runtime.dspProcesses[0].path = $alias
        Write-SelfTestText $runtimePath (ConvertTo-CutoverHostJson $runtime)
        Assert-SelfTest ((Get-CutoverHostRuntimeObservation).kind -ceq 'managed') 'runtime observation failed to bind an executable alias'
        $runtime.dspProcesses[0].path = $different
        Write-SelfTestText $runtimePath (ConvertTo-CutoverHostJson $runtime)
        Assert-SelfTest ((Get-CutoverHostRuntimeObservation).kind -ceq 'unknown') 'runtime observation accepted a distinct executable with identical bytes'
    }
    finally {
        [IO.File]::WriteAllBytes($runtimePath, $runtimeBytes)
        if (Test-Path -LiteralPath $aliasRoot) { [IO.Directory]::Delete($aliasRoot, $false) }
    }
}

function Assert-SelfTestNativeCandidateRepresentation {
    $savedBackend = $script:CutoverHostBackend
    try {
        $script:CutoverHostBackend = 'Windows'
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $identitySid = $identity.User.Value
        $identityName = $identity.Name
        $otherSid = if ($identitySid -ceq 'S-1-5-18') { 'S-1-5-19' } else { 'S-1-5-18' }
        $descriptors = New-SelfTestCandidateDescriptors $false
        foreach ($kind in @('start', 'stop')) {
            $expected = $descriptors.$kind
            $expected.userId = $identitySid
            if ($kind -ceq 'start') { $expected.triggerUserId = $identitySid }
            $task = [pscustomobject]@{
                Actions = @($null, [pscustomobject]@{
                    Execute = $expected.execute; Arguments = $expected.arguments; WorkingDirectory = ''
                })
                Triggers = if ($kind -ceq 'start') {
                    @($null, [pscustomobject]@{ UserId = $identityName; Delay = $expected.triggerDelay })
                } else { $null }
                Principal = [pscustomobject]@{
                    UserId = $identityName; LogonType = $expected.logonType; RunLevel = $expected.runLevel
                }
                Settings = [pscustomobject]@{
                    MultipleInstances = $expected.multipleInstances; ExecutionTimeLimit = $expected.executionTimeLimit
                    RestartCount = $expected.restartCount; StartWhenAvailable = $expected.startWhenAvailable
                    RestartInterval = $expected.restartInterval
                }
                Description = $expected.description
            }
            $image = [pscustomobject]@{ present = $true; enabled = $false; nativeTask = $task }
            Assert-SelfTest (Test-CutoverHostCandidateTask $image $expected) `
                ('native ' + $kind + ' task rejected SID-equivalent users or nullable collections')
            $task.Principal.UserId = $otherSid
            Assert-SelfTest (-not (Test-CutoverHostCandidateTask $image $expected)) `
                'a different native principal was accepted as an equivalent account'
            $task.Principal.UserId = $identityName
            $task.Actions[1].Arguments += ' -FictionalDrift'
            Assert-SelfTest (-not (Test-CutoverHostCandidateTask $image $expected)) `
                'native task argument drift was accepted'
            $task.Actions[1].Arguments = $expected.arguments
            $image.enabled = $true
            Assert-SelfTest (-not (Test-CutoverHostCandidateTask $image $expected)) `
                'a native enabled task was mistaken for the prepared disabled candidate'
            $image.enabled = $false
            if ($kind -ceq 'start') {
                $task.Triggers[1].UserId = $otherSid
                Assert-SelfTest (-not (Test-CutoverHostCandidateTask $image $expected)) `
                    'a different logon-trigger account was accepted'
            }
            else {
                $task.Triggers = @([pscustomobject]@{ UserId = $identityName; Delay = 'PT20S' })
                Assert-SelfTest (-not (Test-CutoverHostCandidateTask $image $expected)) `
                    'a stop task with an unexpected trigger was accepted'
            }
        }
    }
    finally { $script:CutoverHostBackend = $savedBackend }
}

function Assert-SelfTestNativePortEnumeration {
    $savedPidFile = $script:CutoverHostPidFile
    try {
        $script:CutoverHostPidFile = Join-Path $testRoot 'absent-native-probe.pid'
        & {
            $failedQuery = ''
            $tcpRows = @(
                [pscustomobject]@{ LocalPort = 1; State = 'Listen'; OwningProcess = 100 },
                [pscustomobject]@{ LocalPort = $script:CutoverHostGamePort; State = 'Established'; OwningProcess = 200 }
            )
            $udpRows = @([pscustomobject]@{ LocalPort = 1; OwningProcess = 300 })
            function Get-Process { [CmdletBinding()]param([string]$Name); return @() }
            function Get-NetTCPConnection {
                [CmdletBinding()]param([int]$LocalPort, [string]$State)
                if ($PSBoundParameters.ContainsKey('LocalPort') -or $PSBoundParameters.ContainsKey('State')) {
                    throw 'fictional filtered native query has no matching object'
                }
                if ($failedQuery -ceq 'tcp') { throw 'fictional TCP enumeration failure' }
                return $tcpRows
            }
            function Get-NetUDPEndpoint {
                [CmdletBinding()]param([int]$LocalPort)
                if ($PSBoundParameters.ContainsKey('LocalPort')) {
                    throw 'fictional filtered native query has no matching object'
                }
                if ($failedQuery -ceq 'udp') { throw 'fictional UDP enumeration failure' }
                return $udpRows
            }
            $empty = Get-CutoverHostNativeRuntime
            Assert-SelfTest ($empty.tcpOwners.Count -eq 0 -and $empty.udpOwners.Count -eq 0) `
                'a successful native enumeration without a matching listener did not return zero owners'
            $tcpRows = @()
            $udpRows = @()
            $empty = Get-CutoverHostNativeRuntime
            Assert-SelfTest ($empty.tcpOwners.Count -eq 0 -and $empty.udpOwners.Count -eq 0) `
                'a successful empty native enumeration was mistaken for a probe failure'
            $tcpRows = @([pscustomobject]@{ LocalPort = $script:CutoverHostGamePort; State = 'Listen'; OwningProcess = 4242 })
            $udpRows = @([pscustomobject]@{ LocalPort = $script:CutoverHostGamePort; OwningProcess = 4343 })
            $matched = Get-CutoverHostNativeRuntime
            Assert-SelfTest ($matched.tcpOwners.Count -eq 1 -and $matched.tcpOwners[0] -eq 4242 -and
                $matched.udpOwners.Count -eq 1 -and $matched.udpOwners[0] -eq 4343) `
                'matching native TCP and UDP owners were discarded'
            foreach ($failedQuery in @('tcp', 'udp')) {
                $failureCode = $null
                try { [void](Get-CutoverHostNativeRuntime) }
                catch { $failureCode = Get-CutoverHostErrorCode $_.Exception }
                Assert-SelfTest ($failureCode -ceq 'DYSON_CONTROL_CUTOVER_HOST_RUNTIME_PROBE_FAILED') `
                    ('a real ' + $failedQuery + ' enumeration failure was treated as port closure')
            }
        }
    }
    finally { $script:CutoverHostPidFile = $savedPidFile }
}

function Assert-SelfTestNativeTaskActionShapes {
    $savedBackend = $script:CutoverHostBackend
    try {
        $script:CutoverHostBackend = 'Windows'
        & {
            $queryFails = $false
            $nativeTasks = @(
                [pscustomobject]@{
                    TaskName = 'Fictional-ComHandler'; TaskPath = '\Microsoft\Fictional\'
                    Actions = @([pscustomobject]@{ ClassId = '00000000-0000-0000-0000-000000000000'; Data = 'fixture' })
                },
                [pscustomobject]@{ TaskName = 'Fictional-NoAction'; TaskPath = '\'; Actions = $null },
                [pscustomobject]@{
                    TaskName = 'Fictional-MixedActions'; TaskPath = '\'
                    Actions = @($null, [pscustomobject]@{ Execute = (Join-Path $env:SystemRoot 'System32\notepad.exe') })
                }
            )
            function Get-ScheduledTask {
                [CmdletBinding()]
                param()
                if ($queryFails) { throw 'fictional scheduler query failure' }
                return $nativeTasks
            }
            Assert-SelfTest (-not (Test-CutoverHostUnexpectedManagedTask)) `
                'native COM-handler/null actions were mistaken for a failed scheduler query'
            $benignTasks = $nativeTasks
            $nativeTasks += [pscustomobject]@{
                TaskName = 'Fictional-UnexpectedGame'; TaskPath = '\'
                Actions = @([pscustomobject]@{ Execute = $script:CutoverHostExpectedExecutable })
            }
            Assert-SelfTest (Test-CutoverHostUnexpectedManagedTask) `
                'an unknown direct game launcher without Arguments was missed after a COM-handler action'
            $nativeTasks = $benignTasks + @([pscustomobject]@{
                TaskName = 'Fictional-UnexpectedScript'; TaskPath = '\'
                Actions = @([pscustomobject]@{
                    Execute = $powershell
                    Arguments = '-NoProfile -File "' + (Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Start-DysonServer.ps1') + '"'
                })
            })
            Assert-SelfTest (Test-CutoverHostUnexpectedManagedTask) `
                'an unknown managed script launcher was missed after a COM-handler action'
            $queryFails = $true
            $failureCode = $null
            try { [void](Test-CutoverHostUnexpectedManagedTask) }
            catch { $failureCode = Get-CutoverHostErrorCode $_.Exception }
            Assert-SelfTest ($failureCode -ceq 'DYSON_CONTROL_CUTOVER_HOST_SCHEDULER_UNAVAILABLE') `
                'a real scheduler query failure was suppressed'
        }
    }
    finally { $script:CutoverHostBackend = $savedBackend }
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
    New-SelfTestProfile -Reconstructed
    $reconstructedJson = [IO.File]::ReadAllText($profileFile)
    $validatedReconstructed = ConvertTo-CutoverHostValidatedProfile ($reconstructedJson | ConvertFrom-Json)
    Assert-SelfTest ($validatedReconstructed.authoritySource -ceq 'reconstructed-template' -and
        $validatedReconstructed.legacyTemplateSha256 -ceq ('a' * 64) -and
        -not $validatedReconstructed.candidateAuthority.legacyPreimage.expectedEnabledBeforeIsolation -and
        (@($validatedReconstructed.PSObject.Properties.Name)[-4..-1] -join ',') -ceq
            'previousScriptBundleRevision,authoritySource,legacyTemplateSha256,inventoryRevision') `
        'reconstructed profile lost source values or canonical field order'
    $reconstructedEvidence = Assert-SelfTestEvidenceReceipt (Invoke-SelfTestEvidence)
    Assert-SelfTest ($reconstructedEvidence.evidence.candidateDefined -and
        -not $reconstructedEvidence.evidence.candidateEnabled -and
        -not $reconstructedEvidence.evidence.unexpectedAuthorityPresent) `
        'reconstructed prepared candidate was not accepted by evidence collection'
    Initialize-CutoverHostContext -ProjectRoot $projectRoot -ProfileFile $profileFile `
        -RuntimeBootstrapRoot $bootstrapRoot -RuntimeTaskTransactionRoot $transactionRoot `
        -ServiceUser $serviceUser -GamePort $gamePort -AuthorityInventoryRevision $script:inventoryRevision `
        -RequestId ([guid]::NewGuid().ToString('D')) -Backend Shadow -ShadowRoot $shadowRoot
    $observedReconstructed = Get-CutoverHostAuthorityObservation $validatedReconstructed
    Assert-SelfTest ($observedReconstructed.candidatePrepared -and -not $observedReconstructed.candidateLegacy) `
        'the prepared candidate was mislabeled as historical legacy authority'
    Assert-SelfTestNativeTaskActionShapes
    $tests.Add('native-com-handler-null-actions-and-query-failure')
    Assert-SelfTestNativePortEnumeration
    $tests.Add('native-empty-port-enumeration-and-query-failure')
    Assert-SelfTestNativeCandidateRepresentation
    $tests.Add('native-candidate-null-triggers-sid-equivalence-and-drift')
    Assert-SelfTestProcessExecutableAliases
    $tests.Add('process-executable-final-path-alias-and-failure-boundary')
    Assert-SelfTestBoundStopLeaf
    $tests.Add('bound-stop-leaf-generation-and-identity-rejection')
    $tests.Add('reconstructed-profile-preserves-source-and-prepared-state')
    foreach ($invalidCase in @('source-only', 'hash-only', 'unknown-source', 'uppercase-hash', 'enabled-preimage')) {
        $invalidProfile = $reconstructedJson | ConvertFrom-Json
        switch ($invalidCase) {
            'source-only' { $invalidProfile.PSObject.Properties.Remove('legacyTemplateSha256') }
            'hash-only' { $invalidProfile.PSObject.Properties.Remove('authoritySource') }
            'unknown-source' { $invalidProfile.authoritySource = 'other' }
            'uppercase-hash' { $invalidProfile.legacyTemplateSha256 = ('A' * 64) }
            'enabled-preimage' { $invalidProfile.candidateAuthority.legacyPreimage.expectedEnabledBeforeIsolation = $true }
        }
        $failureCode = $null
        try { [void](ConvertTo-CutoverHostValidatedProfile $invalidProfile) }
        catch { $failureCode = Get-CutoverHostErrorCode $_.Exception }
        Assert-SelfTest ($failureCode -ceq 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID') `
            ('invalid reconstructed profile was accepted: ' + $invalidCase)
    }
    $changedSource = $reconstructedJson | ConvertFrom-Json
    $changedSource.legacyTemplateSha256 = ('b' * 64)
    $failureCode = $null
    try { [void](ConvertTo-CutoverHostValidatedProfile $changedSource) }
    catch { $failureCode = Get-CutoverHostErrorCode $_.Exception }
    Assert-SelfTest ($failureCode -ceq 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_REVISION_INVALID') `
        'reconstructed template digest was not bound to inventory revision'
    $tests.Add('reconstructed-profile-invalid-and-revision-bound')
    New-SelfTestProfile
    $legacyProfile = [IO.File]::ReadAllText($profileFile) | ConvertFrom-Json
    $legacyProfile.candidateAuthority.legacyPreimage.expectedEnabledBeforeIsolation = $false
    $failureCode = $null
    try { [void](ConvertTo-CutoverHostValidatedProfile $legacyProfile) }
    catch { $failureCode = Get-CutoverHostErrorCode $_.Exception }
    Assert-SelfTest ($failureCode -ceq 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID') `
        'ordinary legacy profile accepted a disabled pre-isolation state'
    $tests.Add('ordinary-profile-retains-enabled-precondition')

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

    Assert-SelfTestPreviousStopRecovery
    $tests.Add('previous-stop-temporary-task-recovery-receipts-and-no-force')
    Reset-SelfTestFixture running
    Assert-SelfTestActionReceipt (Invoke-SelfTestAction 'DisablePreviousAuthority') 'DisablePreviousAuthority' | Out-Null

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
