[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -cne 'Desktop') {
    throw 'DYSON_QUALIFICATION_SELFTEST_REQUIRES_WINDOWS_POWERSHELL_5_1'
}

$executorPath = Join-Path $PSScriptRoot 'Qualification.Executor.ps1'
$shadowPath = Join-Path $PSScriptRoot 'Qualification.Shadow.ps1'
$planPath = Join-Path $PSScriptRoot 'Qualification.Plan.ps1'
$scenarioPath = Join-Path $PSScriptRoot 'fixtures\shadow-scenarios.v1.json'
$v2SelfTestPath = Join-Path $PSScriptRoot 'Invoke-QualificationV2SelfTest.ps1'
$orchestrationV2SelfTestPath = Join-Path $PSScriptRoot 'Invoke-QualificationOrchestrationV2SelfTest.ps1'
. $executorPath
. $shadowPath
. $planPath

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-qualification-selftest-' + [guid]::NewGuid().ToString('N'))
$shadowRoot = Join-Path $testRoot 'shadow'
$fixtureId = '11111111-2222-4333-8444-555555555555'
$targetIdentity = 'sha256:' + ('a' * 64)
$virtualNow = '2026-09-01T00:00:00.000Z'
$oldEnvironment = [Environment]::GetEnvironmentVariable(
    $script:DysonQualificationExecutorEnvironmentName,
    [EnvironmentVariableTarget]::Process
)
$oldProtocolEnvironment = [Environment]::GetEnvironmentVariable(
    $script:DysonQualificationProtocolExecuteEnvironmentName,
    [EnvironmentVariableTarget]::Process
)
$results = New-Object 'System.Collections.Generic.List[object]'
$stage = 'initialize'

function Assert-QualificationSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('DYSON_QUALIFICATION_SELFTEST_FAILED: ' + $Message) }
}

function Add-QualificationSelfTestResult {
    param([Parameter(Mandatory)][string]$Name)
    $results.Add([pscustomobject][ordered]@{ name = $Name; status = 'passed' }) | Out-Null
}

function Assert-QualificationSelfTestCode {
    param([Parameter(Mandatory)][scriptblock]$Operation, [Parameter(Mandatory)][string]$ExpectedCode)

    $observed = $null
    $detail = $null
    try { & $Operation | Out-Null }
    catch {
        $observed = Get-DysonQualificationExecutorErrorCode -Exception $_.Exception
        $detail = [string]$_.Exception.Message
    }
    Assert-QualificationSelfTest -Condition ($observed -ceq $ExpectedCode) `
        -Message ('expected ' + $ExpectedCode + ', observed ' + [string]$observed + '; detail=' + $detail)
}

function Assert-QualificationSelfTestProtocolFailure {
    param([Parameter(Mandatory)][scriptblock]$Operation, [Parameter(Mandatory)][string]$ExpectedPrefix)

    $message = $null
    try { & $Operation | Out-Null }
    catch { $message = [string]$_.Exception.Message }
    Assert-QualificationSelfTest -Condition (-not [string]::IsNullOrWhiteSpace($message) -and
        $message.StartsWith($ExpectedPrefix, [StringComparison]::Ordinal)) `
        -Message ('expected protocol failure ' + $ExpectedPrefix + ', observed ' + [string]$message)
}

function Copy-QualificationSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $Value | ConvertFrom-Json)
}

function New-QualificationSelfTestRequest {
    param(
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][ValidateSet('preview', 'execute')][string]$Mode,
        [Parameter(Mandatory)]$ProtectionPoint,
        [AllowNull()]$Parameters
    )
    return New-DysonQualificationShadowRequest -ShadowRoot $shadowRoot -RequestId $RequestId `
        -Action $Action -Mode $Mode -ProtectionPoint $ProtectionPoint -Parameters $Parameters
}

function Invoke-QualificationSelfTestHardExitChild {
    param([Parameter(Mandatory)][string]$RequestPath)

    $escape = {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }
    $command = @(
        '$ErrorActionPreference=''Stop''',
        ('. ' + (& $escape $executorPath)),
        ('. ' + (& $escape $shadowPath)),
        ('$request=[IO.File]::ReadAllText(' + (& $escape $RequestPath) + ',[Text.Encoding]::UTF8)|ConvertFrom-Json'),
        ('[void](Invoke-DysonQualificationAction -Request $request -Backend Shadow -ShadowRoot ' +
            (& $escape $shadowRoot) + ' -Injection HardExitAfterCheckpoint)')
    ) -join ';'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powerShell
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
    $info.WorkingDirectory = $testRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'DYSON_QUALIFICATION_SELFTEST_FAILED: hard-exit child did not start' }
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            try { $process.Kill() } catch { }
            throw 'DYSON_QUALIFICATION_SELFTEST_FAILED: hard-exit child timed out'
        }
        $process.WaitForExit()
        return [pscustomobject][ordered]@{
            exitCode = [int]$process.ExitCode
            stdout = [string]$stdoutTask.GetAwaiter().GetResult()
            stderr = [string]$stderrTask.GetAwaiter().GetResult()
        }
    }
    finally { $process.Dispose() }
}

function New-QualificationSelfTestExternalTranscript {
    param(
        [Parameter(Mandatory)][datetimeoffset]$StartUtc,
        [string]$JoinEvidenceType = 'server-authoritative-join',
        [switch]$SwapJoinInteraction
    )

    $events = @(
        'client-challenge-issued', 'game-address-resolved', 'game-authenticated', 'game-joined',
        'game-interaction-observed', 'save-requested', 'save-independently-acknowledged',
        'game-disconnected', 'reconnect-challenge-issued', 'game-rejoined',
        'external-sequence-complete'
    )
    if ($SwapJoinInteraction) {
        $joinEvent = $events[3]
        $events[3] = $events[4]
        $events[4] = $joinEvent
    }
    $types = @(
        'operator-client-challenge', 'game-protocol-resolution-observation',
        'server-authentication-observation', $JoinEvidenceType,
        'server-authoritative-interaction', 'server-save-request-observation',
        'independent-paired-save-observation', 'server-authoritative-disconnect',
        'operator-reconnect-challenge', 'server-authoritative-rejoin',
        'dual-party-sequence-attestation'
    )
    $classes = @(
        'operator-challenge', 'independent-network-observer', 'server-authoritative',
        'server-authoritative', 'server-authoritative', 'server-authoritative',
        'independent-save-observer', 'server-authoritative', 'operator-challenge',
        'server-authoritative', 'dual-party-attestation'
    )
    $firstChallenge = '80000000-0000-4000-8000-000000000001'
    $reconnectChallenge = '80000000-0000-4000-8000-000000000002'
    $runId = '40000000-0000-4000-8000-000000000001'
    $receipts = @()
    $predecessor = '0' * 64
    for ($index = 0; $index -lt 11; $index++) {
        $sequence = $index + 5
        $at = $StartUtc.AddSeconds(30 * $index)
        $challenge = if ($index -le 7) { $firstChallenge } else { $reconnectChallenge }
        $binding = $null
        if ($index -eq 10) {
            $binding = Get-DysonQualificationSha256 -InputObject ([ordered]@{
                protocol = 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1'
                firstChallengeId = $firstChallenge
                reconnectChallengeId = $reconnectChallenge
                predecessorSha256 = [string]$receipts[9].receiptSha256
            })
        }
        $suffix = '{0:d12}' -f ($index + 1)
        $receipt = New-DysonQualificationReceipt `
            -ReceiptId ('50000000-0000-4000-8000-' + $suffix) `
            -RunId $runId `
            -IdempotencyKey ('60000000-0000-4000-8000-' + $suffix) `
            -StepId 'external-client-e2e' -Sequence $sequence -Event $events[$index] `
            -Status $(if ($index -eq 10) { 'passed' } else { 'observed' }) `
            -IssuedAtUtc $at -ExpiresAtUtc $at.AddHours(1) -PredecessorSha256 $predecessor `
            -EvidenceOpaqueId ('70000000-0000-4000-8000-' + $suffix) `
            -EvidenceType $types[$index] `
            -EvidenceSha256 (Get-DysonQualificationSha256 -Text ('external-fixture-' + $index + '-' + $JoinEvidenceType)) `
            -EvidenceObservedAtUtc $at -EvidenceExpiresAtUtc $at.AddHours(1) `
            -AttestationClass $classes[$index] -CheckCodes @('external-observed') `
            -ChallengeId $challenge -TranscriptBindingSha256 $binding
        $receipts += ,$receipt
        $predecessor = [string]$receipt.receiptSha256
    }
    return ,$receipts
}

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $initialized = Initialize-DysonQualificationShadowFixture -ShadowRoot $shadowRoot `
        -FixtureId $fixtureId -TargetIdentity $targetIdentity -VirtualNow $virtualNow
    Assert-QualificationSelfTest -Condition ($initialized.shadowOnly -and -not $initialized.productionChanged) `
        -Message 'fixture initialization did not remain shadow-only'
    $protectionPoint = New-DysonQualificationShadowProtectionPoint -ShadowRoot $shadowRoot `
        -ProtectionPointId '22222222-3333-4444-8555-666666666666'

    $stage = 'preview-non-mutating'
    $statePath = Get-DysonQualificationShadowPath -ShadowRoot $shadowRoot -Kind State
    $stateBefore = [IO.File]::ReadAllBytes($statePath)
    $previewRequest = New-QualificationSelfTestRequest -Action 'windows-restart' `
        -RequestId '30000000-0000-4000-8000-000000000001' -Mode preview `
        -ProtectionPoint $protectionPoint -Parameters $null
    $preview = Invoke-DysonQualificationAction -Request $previewRequest -Backend Shadow -ShadowRoot $shadowRoot
    $stateAfter = [IO.File]::ReadAllBytes($statePath)
    Assert-QualificationSelfTest -Condition ($preview.status -ceq 'preview' -and -not $preview.executed -and
        -not $preview.productionChanged -and [Linq.Enumerable]::SequenceEqual($stateBefore, $stateAfter)) `
        -Message 'preview mutated the fixture or overstated execution'
    Add-QualificationSelfTestResult $stage

    $stage = 'canonical-array-shape'
    [object[]]$emptyRoot = @()
    [object[]]$singleRoot = @(1)
    [object[]]$multipleRoot = @(1, 2)
    $shapeValue = [pscustomobject][ordered]@{
        empty = @()
        single = @(1)
        multiple = @(1, 2)
    }
    $shapeRoundTrip = ConvertTo-DysonQualificationExecutorCanonicalJson -Value $shapeValue | ConvertFrom-Json
    Assert-QualificationSelfTest -Condition (
        (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $emptyRoot) -ceq '[]' -and
        (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $singleRoot) -ceq '[1]' -and
        (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $multipleRoot) -ceq '[1,2]' -and
        @($shapeRoundTrip.empty).Count -eq 0 -and @($shapeRoundTrip.single).Count -eq 1 -and
        @($shapeRoundTrip.multiple).Count -eq 2) `
        -Message 'canonical JSON did not preserve empty, singleton, and multiple array shapes'
    Add-QualificationSelfTestResult $stage

    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        $script:DysonQualificationExecutorEnvironmentValue,
        [EnvironmentVariableTarget]::Process
    )

    $stage = 'plan-state-checkpoint-resume'
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationProtocolExecuteEnvironmentName,
        $script:DysonQualificationProtocolExecuteEnvironmentValue,
        [EnvironmentVariableTarget]::Process
    )
    $protocolGateRequest = New-QualificationSelfTestRequest -Action 'control-plane-restart' `
        -RequestId '30000000-0000-4000-8000-000000000005' -Mode execute `
        -ProtectionPoint $protectionPoint -Parameters $null
    $protocolGateNow = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$protocolGateRequest.issuedAt) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    $protocolGate = Test-DysonQualificationExecutionGate -Request $protocolGateRequest `
        -ExpectedTargetIdentity $targetIdentity -NowUtc $protocolGateNow
    Assert-QualificationSelfTest -Condition ($protocolGate.enabled -and $protocolGate.allowed -and
        -not $protocolGate.productionChanged) -Message 'protocol and Shadow execution gates did not align'
    $plan = Import-DysonQualificationPlan -Path $planPath.Replace('Qualification.Plan.ps1', 'qualification-plan.v1.json')
    $planTest = Test-DysonQualificationPlan -Plan $plan
    Assert-QualificationSelfTest -Condition ($planTest.valid -and $planTest.stepCount -eq 13 -and
        @($planTest.acceptanceIds).Count -eq 9) `
        -Message 'fixed qualification plan did not cover 13 steps and 9 acceptance IDs'
    $planNow = [datetimeoffset]'2026-09-01T01:00:00Z'
    $run = New-DysonQualificationRun -Plan $plan `
        -RunId '90000000-0000-4000-8000-000000000001' -NowUtc $planNow
    $stepId = 'control-plane-restart-recovery'
    $definition = @($plan.steps | Where-Object { [string]$_.id -ceq $stepId })[0]
    $run = (Invoke-DysonQualificationTransition -Plan $plan -Run $run -StepId $stepId `
        -ToState ready -SatisfiedPrerequisites @($definition.prerequisites) -NowUtc $planNow).run
    $run = (Invoke-DysonQualificationTransition -Plan $plan -Run $run -StepId $stepId `
        -ToState previewed -NowUtc $planNow.AddSeconds(1)).run
    $run = (Invoke-DysonQualificationTransition -Plan $plan -Run $run -StepId $stepId `
        -ToState executing -NowUtc $planNow.AddSeconds(2)).run
    $run = (Invoke-DysonQualificationTransition -Plan $plan -Run $run -StepId $stepId `
        -ToState interrupted -InterruptionReason 'process-exit' -NowUtc $planNow.AddSeconds(3)).run
    $tamperedRun = Copy-QualificationSelfTestValue -Value $run
    $tamperedRun.steps[0].attempt = [int]$tamperedRun.steps[0].attempt + 1
    $tamperedTest = Test-DysonQualificationRun -Plan $plan -Run $tamperedRun -NowUtc $planNow.AddSeconds(4)
    Assert-QualificationSelfTest -Condition (-not $tamperedTest.valid -and
        'checkpoint-tampered' -cin @($tamperedTest.reasons)) `
        -Message 'tampered plan checkpoint was not rejected'
    Assert-QualificationSelfTestProtocolFailure -Operation {
        Resume-DysonQualificationRun -Plan $plan -Run $tamperedRun -NowUtc $planNow.AddSeconds(4)
    } -ExpectedPrefix 'DYSON_QUALIFICATION_RESUME_REJECTED:'
    $resumedRun = Resume-DysonQualificationRun -Plan $plan -Run $run -NowUtc $planNow.AddSeconds(4)
    Assert-QualificationSelfTest -Condition (-not $resumedRun.dangerousActionReplayed -and
        @($resumedRun.decisions).Count -eq 1 -and
        [string]$resumedRun.decisions[0].resumeState -ceq 'rollback-pending') `
        -Message 'interrupted dangerous step did not resume into safe reconciliation'
    $run = $resumedRun.run
    $checkpointReceipt = New-DysonQualificationReceipt `
        -ReceiptId '91000000-0000-4000-8000-000000000001' `
        -RunId ([string]$run.runId) `
        -IdempotencyKey '92000000-0000-4000-8000-000000000001' `
        -StepId $stepId -Sequence 1 -Event 'checkpoint-observed' -Status observed `
        -IssuedAtUtc $planNow.AddSeconds(5) -ExpiresAtUtc $planNow.AddHours(1) `
        -PredecessorSha256 $null `
        -EvidenceOpaqueId '93000000-0000-4000-8000-000000000001' `
        -EvidenceType 'pre-restart-checkpoint' `
        -EvidenceSha256 (Get-DysonQualificationSha256 -Text 'plan-checkpoint-fixture') `
        -EvidenceObservedAtUtc $planNow.AddSeconds(5) -EvidenceExpiresAtUtc $planNow.AddHours(1) `
        -AttestationClass 'private-checkpoint-observer' -CheckCodes @('checkpoint-verified')
    $firstAdd = Add-DysonQualificationCheckpointReceipt -Plan $plan -Run $run `
        -Receipt $checkpointReceipt -NowUtc $planNow.AddSeconds(5)
    $duplicateAdd = Add-DysonQualificationCheckpointReceipt -Plan $plan -Run $firstAdd.run `
        -Receipt $checkpointReceipt -NowUtc $planNow.AddSeconds(6)
    $finalRunTest = Test-DysonQualificationRun -Plan $plan -Run $duplicateAdd.run `
        -NowUtc $planNow.AddSeconds(6)
    Assert-QualificationSelfTest -Condition (-not $firstAdd.duplicate -and $duplicateAdd.duplicate -and
        @($duplicateAdd.run.receipts).Count -eq 1 -and $finalRunTest.valid) `
        -Message 'plan receipt duplicate was not idempotent'
    Add-QualificationSelfTestResult $stage

    $stage = 'external-client-dual-receipt'
    $externalStart = [datetimeoffset]'2026-09-01T02:00:00Z'
    $externalReceipts = New-QualificationSelfTestExternalTranscript -StartUtc $externalStart
    $externalResult = Test-DysonExternalClientTranscript -Receipts $externalReceipts `
        -NowUtc $externalStart.AddMinutes(10)
    Assert-QualificationSelfTest -Condition ($externalResult.valid -and $externalResult.realJoinProven -and
        $externalResult.independentSaveAcknowledgementProven -and $externalResult.reconnectProven -and
        -not $externalResult.productionChanged -and @($externalReceipts).Count -eq 11 -and
        [string]$externalReceipts[0].challengeId -cne [string]$externalReceipts[8].challengeId) `
        -Message 'dual-challenge external client transcript did not validate'
    Add-QualificationSelfTestResult $stage

    $stage = 'external-client-invalid'
    foreach ($substitute in @('http-status', 'tcp-port-open', 'client-self-report')) {
        $substituteReceipts = New-QualificationSelfTestExternalTranscript -StartUtc $externalStart `
            -JoinEvidenceType $substitute
        $substituteResult = Test-DysonExternalClientTranscript -Receipts $substituteReceipts `
            -NowUtc $externalStart.AddMinutes(10)
        Assert-QualificationSelfTest -Condition (-not $substituteResult.valid -and
            -not $substituteResult.realJoinProven) `
            -Message ('substitute evidence was accepted as a real join: ' + $substitute)
    }
    $wrongOrderReceipts = New-QualificationSelfTestExternalTranscript -StartUtc $externalStart `
        -SwapJoinInteraction
    $wrongOrderResult = Test-DysonExternalClientTranscript -Receipts $wrongOrderReceipts `
        -NowUtc $externalStart.AddMinutes(10)
    Assert-QualificationSelfTest -Condition (-not $wrongOrderResult.valid) `
        -Message 'wrong-order external transcript was accepted'
    $expiredExternal = Test-DysonExternalClientTranscript -Receipts $externalReceipts `
        -NowUtc $externalStart.AddHours(2)
    Assert-QualificationSelfTest -Condition (-not $expiredExternal.valid) `
        -Message 'expired external transcript was accepted'
    $tamperedExternal = @(Copy-QualificationSelfTestValue -Value $externalReceipts)
    $tamperedExternal[3].event = 'game-rejoined'
    $tamperedExternalResult = Test-DysonExternalClientTranscript -Receipts $tamperedExternal `
        -NowUtc $externalStart.AddMinutes(10)
    Assert-QualificationSelfTest -Condition (-not $tamperedExternalResult.valid) `
        -Message 'tampered external transcript was accepted'
    $brokenExternal = @(Copy-QualificationSelfTestValue -Value $externalReceipts)
    $brokenExternal[5].predecessorSha256 = 'f' * 64
    $brokenExternal[5].receiptSha256 = Get-DysonQualificationReceiptDigest -Receipt $brokenExternal[5]
    $brokenExternalResult = Test-DysonExternalClientTranscript -Receipts $brokenExternal `
        -NowUtc $externalStart.AddMinutes(10)
    Assert-QualificationSelfTest -Condition (-not $brokenExternalResult.valid) `
        -Message 'broken external receipt chain was accepted'
    $publicReceipt = Test-DysonQualificationPublicValue -InputObject $externalReceipts[0]
    Assert-QualificationSelfTest -Condition $publicReceipt.valid `
        -Message 'public-safe external receipt was rejected'
    foreach ($privateField in @('privatePath', 'targetHost', 'playerId', 'raw')) {
        $privateValue = [pscustomobject][ordered]@{ result = 'redacted' }
        $privateValue | Add-Member -NotePropertyName $privateField -NotePropertyValue 'redacted'
        $privateTest = Test-DysonQualificationPublicValue -InputObject $privateValue
        Assert-QualificationSelfTest -Condition (-not $privateTest.valid) `
            -Message ('private public-output field was accepted: ' + $privateField)
    }
    Add-QualificationSelfTestResult $stage

    $stage = 'normal-path'
    $normalActions = @(
        @('windows-restart', $null),
        @('control-plane-restart', $null),
        @('dsp-crash-recovery', $null),
        @('storage-interruption', [pscustomobject][ordered]@{ durationSeconds = 2 }),
        @('disk-pressure', [pscustomobject][ordered]@{ durationSeconds = 2; targetPercent = 80 }),
        @('update-rollback', $null),
        @('gsmanager-switch', $null),
        @('save-restore', $null)
    )
    $normalReceipts = @()
    for ($index = 0; $index -lt $normalActions.Count; $index++) {
        $requestId = '30000000-0000-4000-8000-' + (('{0:d12}' -f ($index + 10)))
        $request = New-QualificationSelfTestRequest -Action ([string]$normalActions[$index][0]) `
            -RequestId $requestId -Mode execute -ProtectionPoint $protectionPoint `
            -Parameters $normalActions[$index][1]
        $receipt = Invoke-DysonQualificationAction -Request $request -Backend Shadow -ShadowRoot $shadowRoot
        Assert-QualificationSelfTest -Condition ($receipt.status -ceq 'passed' -and $receipt.executedInShadow -and
            -not $receipt.productionChanged -and -not $receipt.reused) `
            -Message ('normal action did not pass: ' + [string]$normalActions[$index][0])
        $normalReceipts += $receipt
    }
    Assert-QualificationSelfTest -Condition ($normalReceipts.Count -eq 8) `
        -Message 'not every dangerous adapter ran in Shadow'
    Add-QualificationSelfTestResult $stage

    $stage = 'process-hard-exit'
    $hardExitRequestId = '30000000-0000-4000-8000-000000000100'
    $hardExitRequest = New-QualificationSelfTestRequest -Action 'control-plane-restart' `
        -RequestId $hardExitRequestId -Mode execute -ProtectionPoint $protectionPoint -Parameters $null
    $requestPath = Join-Path $testRoot 'hard-exit-request.json'
    Write-DysonQualificationShadowJson -Path $requestPath -Value $hardExitRequest
    $child = Invoke-QualificationSelfTestHardExitChild -RequestPath $requestPath
    $checkpointPath = Get-DysonQualificationShadowPath -ShadowRoot $shadowRoot -Kind Checkpoint `
        -RequestId $hardExitRequestId
    $receiptPath = Get-DysonQualificationShadowPath -ShadowRoot $shadowRoot -Kind Receipt `
        -RequestId $hardExitRequestId
    $hardExitStderrSafe = $child.stderr -ceq '' -or $child.stderr.Trim() -ceq '#< CLIXML'
    Assert-QualificationSelfTest -Condition ($child.exitCode -eq 93 -and $child.stdout -ceq '' -and
        $hardExitStderrSafe -and (Test-Path -LiteralPath $checkpointPath -PathType Leaf) -and
        -not (Test-Path -LiteralPath $receiptPath)) `
        -Message 'child process did not hard-exit after its durable checkpoint'
    Add-QualificationSelfTestResult $stage

    $stage = 'checkpoint-tamper-rejected'
    $checkpointBytes = [IO.File]::ReadAllBytes($checkpointPath)
    $tamperedCheckpoint = Read-DysonQualificationShadowJson -Path $checkpointPath -MaximumBytes 32768
    $tamperedCheckpoint | Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    Write-DysonQualificationShadowJson -Path $checkpointPath -Value $tamperedCheckpoint
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow `
            -ShadowRoot $shadowRoot -Resume
    } -ExpectedCode 'DYSON_QUALIFICATION_CHECKPOINT_INVALID'
    [IO.File]::WriteAllBytes($checkpointPath, $checkpointBytes)
    Add-QualificationSelfTestResult $stage

    $stage = 'checkpoint-resume'
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_CHECKPOINT_RESUME_REQUIRED'
    $resumed = Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow `
        -ShadowRoot $shadowRoot -Resume
    Assert-QualificationSelfTest -Condition ($resumed.status -ceq 'passed' -and
        -not (Test-Path -LiteralPath $checkpointPath) -and (Test-Path -LiteralPath $receiptPath)) `
        -Message 'checkpoint resume did not complete exactly once'
    Add-QualificationSelfTestResult $stage

    $stage = 'receipt-file-tamper-rejected'
    $receiptBytes = [IO.File]::ReadAllBytes($receiptPath)
    $tamperedReceiptFile = Read-DysonQualificationShadowJson -Path $receiptPath -MaximumBytes 65536
    $tamperedReceiptFile.outcome.recovered = $false
    Write-DysonQualificationShadowJson -Path $receiptPath -Value $tamperedReceiptFile
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    [IO.File]::WriteAllBytes($receiptPath, $receiptBytes)
    Add-QualificationSelfTestResult $stage

    $stage = 'receipt-unknown-field-rejected'
    $unknownReceiptFile = Read-DysonQualificationShadowJson -Path $receiptPath -MaximumBytes 65536
    $unknownReceiptFile | Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    Write-DysonQualificationShadowJson -Path $receiptPath -Value $unknownReceiptFile
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    [IO.File]::WriteAllBytes($receiptPath, $receiptBytes)
    Add-QualificationSelfTestResult $stage

    $stage = 'duplicate-request'
    $replayed = Invoke-DysonQualificationAction -Request $hardExitRequest -Backend Shadow -ShadowRoot $shadowRoot
    Assert-QualificationSelfTest -Condition ($replayed.reused -and
        [string]$replayed.evidenceDigest -ceq [string]$resumed.evidenceDigest) `
        -Message 'duplicate request did not replay the immutable receipt'
    $collision = Copy-QualificationSelfTestValue -Value $hardExitRequest
    $collision.confirmationPhrase = Get-DysonQualificationRequiredConfirmationPhrase `
        -Action 'dsp-crash-recovery' -RequestId $hardExitRequestId
    $collision.action = 'dsp-crash-recovery'
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $collision -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_REQUEST_COLLISION'
    Add-QualificationSelfTestResult $stage

    $stage = 'evidence-tamper'
    $state = Read-DysonQualificationShadowState -ShadowRoot $shadowRoot
    $validEvidence = @($state.evidence)
    [void](Test-DysonQualificationActionReceiptChain -Receipts $validEvidence `
        -NowUtc (ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
            -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID') -RequireFresh)
    $tampered = @(Copy-QualificationSelfTestValue -Value $validEvidence)
    $tampered[0].status = 'failed'
    Assert-QualificationSelfTestCode -Operation {
        Test-DysonQualificationActionReceiptChain -Receipts $tampered `
            -NowUtc ([datetimeoffset]'2026-09-01T00:10:00Z')
    } -ExpectedCode 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
    Add-QualificationSelfTestResult $stage

    $stage = 'evidence-expired'
    Assert-QualificationSelfTestCode -Operation {
        Test-DysonQualificationActionReceiptChain -Receipts $validEvidence `
            -NowUtc ([datetimeoffset]'2026-09-03T00:00:00Z') -RequireFresh
    } -ExpectedCode 'DYSON_QUALIFICATION_EVIDENCE_EXPIRED'
    Add-QualificationSelfTestResult $stage

    $stage = 'evidence-out-of-order'
    $reversed = @($validEvidence | Sort-Object -Property sequence -Descending)
    Assert-QualificationSelfTestCode -Operation {
        Test-DysonQualificationActionReceiptChain -Receipts $reversed `
            -NowUtc ([datetimeoffset]'2026-09-01T00:10:00Z')
    } -ExpectedCode 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
    Add-QualificationSelfTestResult $stage

    $gateRequest = New-QualificationSelfTestRequest -Action 'dsp-crash-recovery' `
        -RequestId '30000000-0000-4000-8000-000000000200' -Mode execute `
        -ProtectionPoint $protectionPoint -Parameters $null

    $stage = 'execution-disabled'
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        $null,
        [EnvironmentVariableTarget]::Process
    )
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $gateRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_EXECUTION_DISABLED'
    Add-QualificationSelfTestResult $stage

    $stage = 'canonical-uuid-rejected'
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        $script:DysonQualificationExecutorEnvironmentValue,
        [EnvironmentVariableTarget]::Process
    )
    $badGuid = Copy-QualificationSelfTestValue -Value $gateRequest
    $badGuid.requestId = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $badGuid -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_REQUEST_INVALID'
    Add-QualificationSelfTestResult $stage

    $stage = 'environment-gate-rejected'
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        'TRUE',
        [EnvironmentVariableTarget]::Process
    )
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $gateRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_EXECUTION_DISABLED'
    Add-QualificationSelfTestResult $stage
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        $script:DysonQualificationExecutorEnvironmentValue,
        [EnvironmentVariableTarget]::Process
    )

    $stage = 'confirmation-rejected'
    $wrongConfirmation = Copy-QualificationSelfTestValue -Value $gateRequest
    $wrongConfirmation.confirmationPhrase = 'EXECUTE DYSON QUALIFICATION'
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $wrongConfirmation -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_CONFIRMATION_INVALID'
    Add-QualificationSelfTestResult $stage

    $stage = 'target-mismatch-rejected'
    $wrongTarget = Copy-QualificationSelfTestValue -Value $gateRequest
    $wrongTarget.targetIdentity = 'sha256:' + ('b' * 64)
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $wrongTarget -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_TARGET_IDENTITY_MISMATCH'
    Add-QualificationSelfTestResult $stage

    $stage = 'maintenance-window-rejected'
    $wrongWindow = Copy-QualificationSelfTestValue -Value $gateRequest
    $wrongWindow.maintenanceWindow.startAt = '2026-08-31T20:00:00.000Z'
    $wrongWindow.maintenanceWindow.endAt = '2026-08-31T21:00:00.000Z'
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $wrongWindow -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_MAINTENANCE_WINDOW_INVALID'
    Add-QualificationSelfTestResult $stage

    $stage = 'stale-protection-point-rejected'
    $currentState = Read-DysonQualificationShadowState -ShadowRoot $shadowRoot
    $currentNow = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$currentState.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    $staleUnsigned = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationProtectionPointProtocol
        schemaVersion = 1
        protectionPointId = '22222222-3333-4444-8555-777777777777'
        targetIdentity = $targetIdentity
        createdAt = ConvertTo-DysonQualificationExecutorUtc -Value $currentNow.AddMinutes(-31)
        expiresAt = ConvertTo-DysonQualificationExecutorUtc -Value $currentNow.AddMinutes(20)
        savePairDigest = Get-DysonQualificationExecutorSha256 -Value 'stale-paired-save'
    }
    $stalePoint = [pscustomobject][ordered]@{
        protocol = $staleUnsigned.protocol
        schemaVersion = $staleUnsigned.schemaVersion
        protectionPointId = $staleUnsigned.protectionPointId
        targetIdentity = $staleUnsigned.targetIdentity
        createdAt = $staleUnsigned.createdAt
        expiresAt = $staleUnsigned.expiresAt
        savePairDigest = $staleUnsigned.savePairDigest
        evidenceDigest = Get-DysonQualificationExecutorObjectDigest -Value $staleUnsigned
    }
    $staleRequest = New-QualificationSelfTestRequest -Action 'dsp-crash-recovery' `
        -RequestId '30000000-0000-4000-8000-000000000201' -Mode execute `
        -ProtectionPoint $stalePoint -Parameters $null
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $staleRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_PROTECTION_POINT_STALE'
    Add-QualificationSelfTestResult $stage

    $stage = 'protection-point-tamper-rejected'
    $tamperedPoint = Copy-QualificationSelfTestValue -Value $protectionPoint
    $tamperedPoint.savePairDigest = 'sha256:' + ('c' * 64)
    $tamperedPointRequest = New-QualificationSelfTestRequest -Action 'dsp-crash-recovery' `
        -RequestId '30000000-0000-4000-8000-000000000202' -Mode execute `
        -ProtectionPoint $tamperedPoint -Parameters $null
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $tamperedPointRequest -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    Add-QualificationSelfTestResult $stage

    $stage = 'real-backend-unsupported'
    $contractStateBefore = [IO.File]::ReadAllBytes($statePath)
    $unsupported = Invoke-DysonQualificationAction -Request $gateRequest -Backend Contract
    $contractStateAfter = [IO.File]::ReadAllBytes($statePath)
    Assert-QualificationSelfTest -Condition ($unsupported.status -ceq 'unsupported' -and
        -not $unsupported.executed -and -not $unsupported.productionChanged -and
        [Linq.Enumerable]::SequenceEqual($contractStateBefore, $contractStateAfter)) `
        -Message 'real-backend contract attempted execution or changed Shadow state'
    Add-QualificationSelfTestResult $stage

    $stage = 'rollback-failure'
    $rollbackRequest = New-QualificationSelfTestRequest -Action 'update-rollback' `
        -RequestId '30000000-0000-4000-8000-000000000300' -Mode execute `
        -ProtectionPoint $protectionPoint -Parameters $null
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $rollbackRequest -Backend Shadow `
            -ShadowRoot $shadowRoot -Injection RollbackFailure
    } -ExpectedCode 'DYSON_QUALIFICATION_SHADOW_ROLLBACK_FAILED'
    $failedState = Read-DysonQualificationShadowState -ShadowRoot $shadowRoot
    $failedReceiptPath = Get-DysonQualificationShadowPath -ShadowRoot $shadowRoot -Kind Receipt `
        -RequestId ([string]$rollbackRequest.requestId)
    $failedReceipt = Read-DysonQualificationShadowJson -Path $failedReceiptPath -MaximumBytes 65536
    Assert-QualificationSelfTest -Condition ($failedState.manualRecoveryRequired -and
        [string]$failedReceipt.status -ceq 'failed' -and
        [string]$failedReceipt.rollback.status -ceq 'failed' -and -not $failedReceipt.productionChanged) `
        -Message 'rollback failure did not leave a bounded manual-recovery receipt'
    Add-QualificationSelfTestResult $stage

    $stage = 'manual-recovery-latched'
    $blockedAfterRollback = New-QualificationSelfTestRequest -Action 'control-plane-restart' `
        -RequestId '30000000-0000-4000-8000-000000000301' -Mode execute `
        -ProtectionPoint $protectionPoint -Parameters $null
    Assert-QualificationSelfTestCode -Operation {
        Invoke-DysonQualificationAction -Request $blockedAfterRollback -Backend Shadow -ShadowRoot $shadowRoot
    } -ExpectedCode 'DYSON_QUALIFICATION_MANUAL_RECOVERY_REQUIRED'
    $failedReplay = Invoke-DysonQualificationAction -Request $rollbackRequest -Backend Shadow -ShadowRoot $shadowRoot
    Assert-QualificationSelfTest -Condition ($failedReplay.reused -and [string]$failedReplay.status -ceq 'failed') `
        -Message 'manual recovery latch prevented immutable terminal receipt replay'
    Add-QualificationSelfTestResult $stage

    $stage = 'six-hour-soak-virtual-clock'
    $soakStateBefore = Read-DysonQualificationShadowState -ShadowRoot $shadowRoot
    $soakStart = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$soakStateBefore.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    $soak = Invoke-DysonQualificationShadowSoak -ShadowRoot $shadowRoot -Hours 6
    $soakEnd = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$soak.endedAt) `
        -Code 'DYSON_QUALIFICATION_SHADOW_CLOCK_INVALID'
    Assert-QualificationSelfTest -Condition ($soak.status -ceq 'passed' -and $soak.virtualClock -and
        $soak.sampleCount -eq 24 -and $soak.virtualElapsedHours -eq 6 -and
        $soakEnd.Subtract($soakStart).TotalHours -eq 6 -and
        -not $soak.qualifyingProductionEvidence -and -not $soak.productionChanged) `
        -Message 'virtual soak did not advance exactly six hours or was overstated as production evidence'
    $soakStateAfter = Read-DysonQualificationShadowState -ShadowRoot $shadowRoot
    Assert-QualificationSelfTest -Condition ([bool]$soakStateAfter.manualRecoveryRequired) `
        -Message 'virtual soak cleared the manual recovery latch'
    Add-QualificationSelfTestResult $stage

    $stage = 'isolated-side-effect-scan'
    $source = [IO.File]::ReadAllText($executorPath, [Text.Encoding]::UTF8) + "`n" +
        [IO.File]::ReadAllText($shadowPath, [Text.Encoding]::UTF8)
    $forbidden = @(
        'Restart-Computer', 'Stop-Computer', 'Start-Service', 'Stop-Service', 'Restart-Service',
        'Register-ScheduledTask', 'Start-ScheduledTask', 'Invoke-WebRequest', 'Invoke-RestMethod',
        'System.Net.Sockets.TcpClient', '.dsv', '.server'
    )
    foreach ($token in $forbidden) {
        Assert-QualificationSelfTest -Condition (-not $source.Contains($token)) `
            -Message ('isolated implementation contains prohibited production primitive: ' + $token)
    }
    Add-QualificationSelfTestResult $stage

    $scenarioFile = [IO.File]::ReadAllText($scenarioPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $expectedNames = @($scenarioFile.scenarios)
    $actualNames = @($results | ForEach-Object { [string]$_.name })
    Assert-QualificationSelfTest -Condition ($expectedNames.Count -eq $actualNames.Count) `
        -Message 'fixed scenario count changed'
    for ($index = 0; $index -lt $expectedNames.Count; $index++) {
        Assert-QualificationSelfTest -Condition ([string]$expectedNames[$index] -ceq [string]$actualNames[$index]) `
            -Message ('fixed scenario order changed at index ' + $index)
    }

    $stage = 'production-v2-fake-matrix'
    $v2Output = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $v2SelfTestPath 2>&1)
    $v2ExitCode = $LASTEXITCODE
    Assert-QualificationSelfTest -Condition ($v2ExitCode -eq 0) `
        -Message ('v2 self-test child failed: ' + ($v2Output -join ' '))
    try { $v2Result = ($v2Output -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw ('DYSON_QUALIFICATION_V2_SELFTEST_RESULT_INVALID: ' + [string]$_.Exception.Message) }
    Assert-QualificationSelfTest -Condition (
        [string]$v2Result.protocol -ceq 'DYSON_QUALIFICATION_V2_SELFTEST' -and
        [string]$v2Result.status -ceq 'passed' -and
        [int]$v2Result.testCount -ge 19 -and
        [int]$v2Result.testCount -eq [int]$v2Result.passedCount -and
        -not [bool]$v2Result.productionBackendInvoked -and
        -not [bool]$v2Result.productionProcessTouched -and
        -not [bool]$v2Result.productionStorageTouched -and
        -not [bool]$v2Result.productionDiskTouched -and
        -not [bool]$v2Result.networkTouched -and
        -not [bool]$v2Result.productionSaveTouched -and
        -not [bool]$v2Result.productionChanged
    ) -Message 'v2 fake matrix did not preserve the zero-production-mutation boundary'

    $stage = 'orchestration-v2-protected-receipt-matrix'
    $orchestrationOutput = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $orchestrationV2SelfTestPath 2>&1)
    $orchestrationExitCode = $LASTEXITCODE
    Assert-QualificationSelfTest -Condition ($orchestrationExitCode -eq 0) `
        -Message ('orchestration v2 self-test child failed: ' + ($orchestrationOutput -join ' '))
    try { $orchestrationResult = ($orchestrationOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw ('DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_RESULT_INVALID: ' + [string]$_.Exception.Message) }
    Assert-QualificationSelfTest -Condition (
        [string]$orchestrationResult.protocol -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST' -and
        [string]$orchestrationResult.result -ceq 'passed' -and
        [int]$orchestrationResult.testCount -ge 12 -and
        [int]$orchestrationResult.testCount -eq [int]$orchestrationResult.passedCount -and
        @($orchestrationResult.actionsCovered).Count -eq 11 -and
        -not [bool]$orchestrationResult.productionBackendInvoked -and
        -not [bool]$orchestrationResult.productionMutationImplemented -and
        -not [bool]$orchestrationResult.serviceControlTouched -and
        -not [bool]$orchestrationResult.taskSchedulerTouched -and
        -not [bool]$orchestrationResult.networkTouched -and
        -not [bool]$orchestrationResult.saveTouched -and
        -not [bool]$orchestrationResult.productionChanged
    ) -Message 'orchestration v2 matrix did not preserve the protected receipt-only boundary'

    $resultTests = @($results | ForEach-Object { $_ })
    $result = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SELFTEST_V1'
        schemaVersion = 1
        status = 'passed'
        runtime = 'Windows PowerShell 5.1'
        runtimeVersion = $PSVersionTable.PSVersion.ToString()
        executorProtocol = $script:DysonQualificationExecutorProtocol
        shadowProtocol = $script:DysonQualificationShadowProtocol
        requestProtocol = $script:DysonQualificationActionRequestProtocol
        receiptProtocol = $script:DysonQualificationActionReceiptProtocol
        planProtocol = $script:DysonQualificationProtocol
        planStepCount = 13
        acceptanceIdCount = 9
        externalClientReceiptCount = 11
        testCount = $results.Count
        passedCount = $results.Count
        tests = $resultTests
        hardExitCode = 93
        dangerousActionsCovered = @($script:DysonQualificationActions)
        virtualSoakHours = 6
        productionSchedulerTouched = $false
        serviceControlTouched = $false
        networkTouched = $false
        productionSaveTouched = $false
        productionChanged = $false
        productionV2Protocol = [string]$v2Result.protocol
        productionV2TestCount = [int]$v2Result.testCount
        productionV2ProductionBackendInvoked = [bool]$v2Result.productionBackendInvoked
        orchestrationV2Protocol = [string]$orchestrationResult.protocol
        orchestrationV2TestCount = [int]$orchestrationResult.testCount
        orchestrationV2ActionCount = @($orchestrationResult.actionsCovered).Count
        orchestrationV2ProductionBackendInvoked = [bool]$orchestrationResult.productionBackendInvoked
    }
}
catch {
    throw ('DYSON_QUALIFICATION_SELFTEST_STAGE_FAILED: stage=' + $stage +
        '; line=' + [string]$_.InvocationInfo.ScriptLineNumber +
        '; detail=' + [string]$_.Exception.Message)
}
finally {
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        $oldEnvironment,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationProtocolExecuteEnvironmentName,
        $oldProtocolEnvironment,
        [EnvironmentVariableTarget]::Process
    )
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        $fullTestRoot = [IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        $prefix = $temporary + [IO.Path]::DirectorySeparatorChar + 'dyson-qualification-selftest-'
        if (-not $fullTestRoot.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'DYSON_QUALIFICATION_SELFTEST_CLEANUP_TARGET_INVALID'
        }
        [IO.Directory]::Delete($fullTestRoot, $true)
    }
}

$result | ConvertTo-Json -Depth 16 -Compress
