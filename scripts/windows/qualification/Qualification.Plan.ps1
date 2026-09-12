# In-memory, resumable state machine for the fixed qualification plan.

. (Join-Path $PSScriptRoot 'Qualification.Protocol.ps1')

$script:DysonQualificationRequiredAcceptanceIds = @(
    'SAV-005','PRD-001','PRD-002','PRD-003','PRD-004','PRD-005','CUT-001','CUT-002','CUT-003'
)
$script:DysonQualificationStepStates = @(
    'pending','ready','previewed','awaiting-human','executing','verifying','passed','failed',
    'rollback-pending','rolled-back','interrupted','blocked'
)

function Get-DysonQualificationPlanPath {
    [CmdletBinding()]
    param()
    return (Join-Path $PSScriptRoot 'qualification-plan.v1.json')
}

function Test-DysonQualificationPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan)

    $reasons = New-Object System.Collections.Generic.List[string]
    if ([string]$Plan.protocol -cne 'DYSON_PRODUCTION_QUALIFICATION_V1' -or [int]$Plan.schemaVersion -ne 1) {
        $reasons.Add('protocol-mismatch')
    }
    if ([string]$Plan.planId -cne 'dyson-production-qualification-v1') { $reasons.Add('plan-id-invalid') }
    if ([bool]$Plan.productionDefaults.productionWritesEnabled) { $reasons.Add('production-default-is-not-fail-closed') }
    if ([string]$Plan.productionDefaults.mode -cne 'preview') { $reasons.Add('default-mode-is-not-preview') }
    if ([string]$Plan.productionDefaults.executeEnvironmentName -cne 'DYSON_QUALIFICATION_EXECUTE_ENABLED' -or
        [string]$Plan.productionDefaults.executeEnvironmentValue -cne 'ALLOW_BOUNDED_PRODUCTION_QUALIFICATION_V1') {
        $reasons.Add('execution-switch-invalid')
    }
    if ([string]$Plan.productionDefaults.confirmationPhraseTemplate -cne
        'EXECUTE DYSON QUALIFICATION SHADOW {UPPERCASE-ALLOWLISTED-ACTION} {canonical-request-id}') {
        $reasons.Add('confirmation-template-invalid')
    }
    if (@($Plan.productionDefaults.pairedSaveUnit).Count -ne 2 -or
        [string]$Plan.productionDefaults.pairedSaveUnit[0] -cne 'dsv' -or
        [string]$Plan.productionDefaults.pairedSaveUnit[1] -cne 'server') {
        $reasons.Add('paired-save-unit-invalid')
    }

    $stepIds = @{}
    $acceptance = New-Object System.Collections.Generic.List[string]
    foreach ($step in @($Plan.steps)) {
        if ([string]$step.id -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$') { $reasons.Add('step-id-invalid') }
        elseif ($stepIds.ContainsKey([string]$step.id)) { $reasons.Add('duplicate-step:' + [string]$step.id) }
        else { $stepIds[[string]$step.id] = $true }
        foreach ($field in @('acceptanceIds','prerequisites','timeoutSeconds','riskClass','actionAdapter','idempotency','checkpointStates','resumeStrategy','interruptible','privateEvidenceReferenceRequired','evidenceTypes')) {
            if ($null -eq $step.PSObject.Properties[$field]) { $reasons.Add('missing-' + $field + ':' + [string]$step.id) }
        }
        if ([int]$step.timeoutSeconds -lt 1) { $reasons.Add('timeout-invalid:' + [string]$step.id) }
        if (@($step.prerequisites).Count -lt 1) { $reasons.Add('prerequisites-empty:' + [string]$step.id) }
        if (@($step.checkpointStates).Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$step.resumeStrategy)) { $reasons.Add('checkpoint-invalid:' + [string]$step.id) }
        if (@($step.evidenceTypes).Count -lt 1) { $reasons.Add('evidence-empty:' + [string]$step.id) }
        if (-not [bool]$step.privateEvidenceReferenceRequired) { $reasons.Add('private-evidence-reference-not-required:' + [string]$step.id) }
        if ([string]$step.riskClass -eq 'dangerous' -and [string]$step.idempotency -cne 'canonical-request-id') { $reasons.Add('dangerous-idempotency-invalid:' + [string]$step.id) }
        foreach ($acceptanceId in @($step.acceptanceIds)) { $acceptance.Add([string]$acceptanceId) }
    }
    foreach ($required in $script:DysonQualificationRequiredAcceptanceIds) {
        if ($required -cnotin @($acceptance)) { $reasons.Add('acceptance-unmapped:' + $required) }
    }
    foreach ($actual in @($acceptance | Sort-Object -Unique)) {
        if ($actual -cnotin $script:DysonQualificationRequiredAcceptanceIds) { $reasons.Add('acceptance-unknown:' + $actual) }
    }
    $external = @($Plan.steps | Where-Object { [string]$_.id -ceq 'external-client-e2e' })
    if ($external.Count -ne 1 -or @($Plan.externalClientProtocol.events).Count -ne 11 -or
        [bool]$Plan.externalClientProtocol.collectsIdentity -or [bool]$Plan.externalClientProtocol.collectsNetworkAddress) {
        $reasons.Add('external-client-protocol-invalid')
    }
    $soak = @($Plan.steps | Where-Object { [string]$_.id -ceq 'six-hour-soak' })
    if ($soak.Count -ne 1 -or [int]$soak[0].minimumRealElapsedSeconds -lt 21600 -or
        [bool]$soak[0].virtualClockAllowedForProductionEvidence) {
        $reasons.Add('soak-duration-policy-invalid')
    }

    [pscustomobject][ordered]@{
        valid = ($reasons.Count -eq 0)
        planId = [string]$Plan.planId
        stepCount = @($Plan.steps).Count
        acceptanceIds = @($acceptance | Sort-Object -Unique)
        reasons = @($reasons | Sort-Object -Unique)
        productionChanged = $false
    }
}

function Import-DysonQualificationPlan {
    [CmdletBinding()]
    param([string]$Path = (Get-DysonQualificationPlanPath))

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PLAN_NOT_FOUND' 'Qualification plan was not found.'
    }
    $plan = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
    $test = Test-DysonQualificationPlan -Plan $plan
    if (-not $test.valid) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PLAN_INVALID' ($test.reasons -join ',')
    }
    return $plan
}

function Get-DysonQualificationCheckpointDigest {
    param([Parameter(Mandatory)]$Run)

    $unsigned = [ordered]@{}
    foreach ($property in @($Run.PSObject.Properties | Where-Object { $_.Name -cne 'checkpointSha256' } | Sort-Object Name)) {
        $unsigned[$property.Name] = $property.Value
    }
    return Get-DysonQualificationSha256 -InputObject $unsigned
}

function Update-DysonQualificationCheckpointDigest {
    param([Parameter(Mandatory)]$Run)
    $Run.checkpointSha256 = Get-DysonQualificationCheckpointDigest -Run $Run
    return $Run
}

function New-DysonQualificationRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$RunId,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $planTest = Test-DysonQualificationPlan -Plan $Plan
    if (-not $planTest.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PLAN_INVALID' ($planTest.reasons -join ',') }
    if (-not (Test-DysonQualificationUuid -Value $RunId)) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_UUID_INVALID' 'runId must be a canonical lower-case D UUID.' }
    $steps = @()
    foreach ($definition in @($Plan.steps)) {
        $steps += ,[pscustomobject][ordered]@{
            stepId = [string]$definition.id
            acceptanceIds = @($definition.acceptanceIds)
            state = 'pending'
            attempt = 0
            interruptedFrom = $null
            resultReceiptSha256 = $null
            evidenceDigests = @()
            checkCodes = @()
        }
    }
    $now = $NowUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $run = [pscustomobject][ordered]@{
        protocol = 'DYSON_PRODUCTION_QUALIFICATION_V1'
        schemaVersion = 1
        planId = [string]$Plan.planId
        planSha256 = Get-DysonQualificationSha256 -InputObject $Plan
        runId = $RunId
        state = 'active'
        createdAtUtc = $now
        updatedAtUtc = $now
        nextSequence = 1
        lastReceiptSha256 = $null
        receipts = @()
        steps = $steps
        checkpointSha256 = $null
        productionChanged = $false
    }
    return Update-DysonQualificationCheckpointDigest -Run $run
}

function Get-DysonQualificationRunStep {
    param([Parameter(Mandatory)]$Run, [Parameter(Mandatory)][string]$StepId)
    $matches = @($Run.steps | Where-Object { [string]$_.stepId -ceq $StepId })
    if ($matches.Count -ne 1) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_STEP_NOT_FOUND' 'The requested step does not exist in the checkpoint.' }
    return $matches[0]
}

function Test-DysonQualificationRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Run,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [switch]$AllowExpiredReceipts
    )

    $reasons = New-Object System.Collections.Generic.List[string]
    if ([string]$Run.protocol -cne 'DYSON_PRODUCTION_QUALIFICATION_V1' -or [int]$Run.schemaVersion -ne 1) { $reasons.Add('run-protocol-invalid') }
    if (-not (Test-DysonQualificationUuid -Value ([string]$Run.runId))) { $reasons.Add('run-id-invalid') }
    if ([string]$Run.planId -cne [string]$Plan.planId -or [string]$Run.planSha256 -cne (Get-DysonQualificationSha256 -InputObject $Plan)) { $reasons.Add('plan-identity-mismatch') }
    if ([bool]$Run.productionChanged) { $reasons.Add('production-changed-flag-invalid') }
    $expectedCheckpoint = Get-DysonQualificationCheckpointDigest -Run $Run
    if ([string]$Run.checkpointSha256 -cne $expectedCheckpoint) { $reasons.Add('checkpoint-tampered') }
    $chain = Test-DysonQualificationReceiptChain -Receipts @($Run.receipts) -NowUtc $NowUtc -AllowExpired:$AllowExpiredReceipts
    foreach ($reason in @($chain.reasons)) { $reasons.Add('receipt:' + $reason) }
    if ([int]$Run.nextSequence -ne (@($Run.receipts).Count + 1)) { $reasons.Add('next-sequence-invalid') }
    if ([string]$Run.lastReceiptSha256 -cne [string]$chain.lastReceiptSha256) { $reasons.Add('last-receipt-invalid') }
    $definitionIds = @($Plan.steps | ForEach-Object { [string]$_.id })
    if (@($Run.steps).Count -ne $definitionIds.Count) { $reasons.Add('step-count-invalid') }
    foreach ($step in @($Run.steps)) {
        if ([string]$step.stepId -cnotin $definitionIds) { $reasons.Add('unknown-step:' + [string]$step.stepId) }
        if ([string]$step.state -cnotin $script:DysonQualificationStepStates) { $reasons.Add('step-state-invalid:' + [string]$step.stepId) }
        foreach ($digest in @($step.evidenceDigests)) { if (-not (Test-DysonQualificationDigest ([string]$digest))) { $reasons.Add('evidence-digest-invalid:' + [string]$step.stepId) } }
    }
    [pscustomobject][ordered]@{
        valid = ($reasons.Count -eq 0)
        reasons = @($reasons | Sort-Object -Unique)
        runId = [string]$Run.runId
        checkpointSha256 = [string]$Run.checkpointSha256
        productionChanged = $false
    }
}

function Add-DysonQualificationCheckpointReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Run,
        [Parameter(Mandatory)]$Receipt,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $before = Test-DysonQualificationRun -Plan $Plan -Run $Run -NowUtc $NowUtc -AllowExpiredReceipts
    if (-not $before.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHECKPOINT_INVALID' ($before.reasons -join ',') }
    if ([string]$Receipt.runId -cne [string]$Run.runId) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RUN_MISMATCH' 'Receipt belongs to a different run.' }
    [void](Get-DysonQualificationRunStep -Run $Run -StepId ([string]$Receipt.stepId))
    $added = Add-DysonQualificationReceipt -Receipts @($Run.receipts) -Receipt $Receipt -NowUtc $NowUtc
    if (-not $added.duplicate) {
        $Run.receipts = @($added.receipts)
        $Run.nextSequence = @($Run.receipts).Count + 1
        $Run.lastReceiptSha256 = [string]$Receipt.receiptSha256
        $step = Get-DysonQualificationRunStep -Run $Run -StepId ([string]$Receipt.stepId)
        $step.evidenceDigests = @($step.evidenceDigests) + @([string]$Receipt.evidenceRef.sha256)
        $Run.updatedAtUtc = $NowUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        [void](Update-DysonQualificationCheckpointDigest -Run $Run)
    }
    [pscustomobject][ordered]@{ run = $Run; duplicate = [bool]$added.duplicate; accepted = $true; productionChanged = $false }
}

function Invoke-DysonQualificationTransition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Run,
        [Parameter(Mandatory)][string]$StepId,
        [Parameter(Mandatory)][string]$ToState,
        [string[]]$SatisfiedPrerequisites = @(),
        [AllowNull()]$Receipt,
        [AllowNull()][ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$InterruptionReason,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $runTest = Test-DysonQualificationRun -Plan $Plan -Run $Run -NowUtc $NowUtc -AllowExpiredReceipts
    if (-not $runTest.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHECKPOINT_INVALID' ($runTest.reasons -join ',') }
    if ($ToState -cnotin $script:DysonQualificationStepStates) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_STATE_INVALID' 'Requested state is not supported.' }
    $step = Get-DysonQualificationRunStep -Run $Run -StepId $StepId
    if ([string]$step.state -ceq $ToState) {
        return [pscustomobject][ordered]@{ run = $Run; duplicate = $true; transitioned = $false; productionChanged = $false }
    }
    $allowed = @{
        'pending' = @('ready','blocked','interrupted')
        'ready' = @('previewed','blocked','interrupted')
        'previewed' = @('awaiting-human','executing','verifying','blocked','interrupted')
        'awaiting-human' = @('verifying','blocked','interrupted')
        'executing' = @('verifying','failed','rollback-pending','interrupted')
        'verifying' = @('passed','failed','rollback-pending','interrupted')
        'failed' = @('rollback-pending','ready','blocked')
        'rollback-pending' = @('rolled-back','failed','interrupted')
        'rolled-back' = @('ready','blocked')
        'interrupted' = @('ready','verifying','rollback-pending','blocked')
        'blocked' = @('ready','interrupted')
        'passed' = @()
    }
    $fromState = [string]$step.state
    if ($ToState -cnotin @($allowed[$fromState])) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_TRANSITION_INVALID' ($fromState + ' cannot transition to ' + $ToState + '.')
    }
    $definition = @($Plan.steps | Where-Object { [string]$_.id -ceq $StepId })[0]
    if ($ToState -eq 'ready') {
        $missing = @($definition.prerequisites | Where-Object { [string]$_ -cnotin @($SatisfiedPrerequisites) })
        if ($missing.Count -gt 0) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PREREQUISITE_MISSING' ($missing -join ',') }
    }
    if ($ToState -eq 'executing' -and [string]$definition.riskClass -eq 'read-only') {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_TRANSITION_INVALID' 'Read-only steps do not enter executing state.'
    }
    if ($null -ne $Receipt) {
        if ([string]$Receipt.stepId -cne $StepId) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_STEP_MISMATCH' 'Transition receipt belongs to a different step.' }
        if ($ToState -in @('passed','failed','rolled-back') -and [string]$Receipt.status -cne ($(if ($ToState -eq 'rolled-back') { 'rolled-back' } else { $ToState }))) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_STATUS_INVALID' 'Terminal transition receipt status does not match the target state.'
        }
        if ($ToState -eq 'passed' -and [string]$Receipt.evidenceRef.type -cnotin @($definition.evidenceTypes)) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Passing receipt evidence type is not allowlisted for this step.'
        }
        if ($ToState -eq 'passed' -and $StepId -eq 'six-hour-soak' -and
            ([string]$Receipt.evidenceRef.type -cne 'elapsed-time-attestation' -or
             [string]$Receipt.evidenceRef.attestationClass -cne 'monotonic-private-observer' -or
             'real-elapsed-at-least-21600-seconds' -cnotin @($Receipt.publicSummary.checkCodes))) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_SOAK_EVIDENCE_INVALID' 'A production soak pass requires a private monotonic real-elapsed attestation of at least 21600 seconds.'
        }
        $added = Add-DysonQualificationCheckpointReceipt -Plan $Plan -Run $Run -Receipt $Receipt -NowUtc $NowUtc
        $Run = $added.run
        $step = Get-DysonQualificationRunStep -Run $Run -StepId $StepId
        if ($ToState -in @('passed','failed','rolled-back')) { $step.resultReceiptSha256 = [string]$Receipt.receiptSha256 }
    }
    elseif ($ToState -in @('passed','failed','rolled-back')) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_REQUIRED' 'A terminal transition requires a verified receipt.'
    }
    if ($ToState -eq 'interrupted') {
        if ([string]::IsNullOrEmpty($InterruptionReason)) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_INTERRUPTION_REASON_REQUIRED' 'Interruption requires a bounded reason code.' }
        $step.interruptedFrom = $fromState
        $step.checkCodes = @($step.checkCodes) + @('interrupted-' + $InterruptionReason)
    }
    elseif ($fromState -eq 'interrupted') { $step.interruptedFrom = $null }
    if ($fromState -eq 'pending' -and $ToState -eq 'ready') { $step.attempt = [int]$step.attempt + 1 }
    elseif ($ToState -eq 'ready' -and $fromState -in @('failed','rolled-back','blocked')) { $step.attempt = [int]$step.attempt + 1 }
    $step.state = $ToState
    $Run.updatedAtUtc = $NowUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    if (@($Run.steps | Where-Object { [string]$_.state -eq 'failed' }).Count -gt 0) { $Run.state = 'attention-required' }
    elseif (@($Run.steps | Where-Object { [string]$_.state -eq 'passed' }).Count -eq @($Run.steps).Count) { $Run.state = 'passed' }
    else { $Run.state = 'active' }
    [void](Update-DysonQualificationCheckpointDigest -Run $Run)
    [pscustomobject][ordered]@{ run = $Run; duplicate = $false; transitioned = $true; fromState = $fromState; toState = $ToState; productionChanged = $false }
}

function Resume-DysonQualificationRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Run,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $test = Test-DysonQualificationRun -Plan $Plan -Run $Run -NowUtc $NowUtc
    if (-not $test.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RESUME_REJECTED' ($test.reasons -join ',') }
    $decisions = @()
    foreach ($step in @($Run.steps | Where-Object { [string]$_.state -eq 'interrupted' })) {
        $resumeState = switch ([string]$step.interruptedFrom) {
            'verifying' { 'verifying' }
            'awaiting-human' { 'blocked' }
            'executing' { 'rollback-pending' }
            'rollback-pending' { 'rollback-pending' }
            default { 'blocked' }
        }
        $step.state = $resumeState
        $step.checkCodes = @($step.checkCodes) + @($(if ($resumeState -eq 'rollback-pending') { 'manual-reconciliation-required' } else { 'fresh-prerequisite-check-required' }))
        $decisions += ,[pscustomobject][ordered]@{ stepId = [string]$step.stepId; interruptedFrom = [string]$step.interruptedFrom; resumeState = $resumeState }
        $step.interruptedFrom = $null
    }
    $Run.updatedAtUtc = $NowUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    if ($decisions.Count -gt 0) { $Run.state = 'attention-required' }
    [void](Update-DysonQualificationCheckpointDigest -Run $Run)
    [pscustomobject][ordered]@{ run = $Run; decisions = $decisions; dangerousActionReplayed = $false; productionChanged = $false }
}

function Get-DysonQualificationPublicProjection {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)]$Run)

    $steps = @()
    foreach ($step in @($Run.steps)) {
        $timeClassification = if ([string]$step.state -eq 'pending') { 'not-started' }
            elseif ([string]$step.state -in @('passed','failed','rolled-back')) { 'completed' }
            elseif ([string]$step.state -in @('interrupted','blocked','rollback-pending')) { 'attention-required' }
            else { 'in-progress' }
        $steps += ,[pscustomobject][ordered]@{
            stepId = [string]$step.stepId
            acceptanceIds = @($step.acceptanceIds)
            result = [string]$step.state
            timeClassification = $timeClassification
            evidenceDigests = @($step.evidenceDigests)
            resultDigest = [string]$step.resultReceiptSha256
        }
    }
    $projection = [pscustomobject][ordered]@{
        protocol = 'DYSON_PRODUCTION_QUALIFICATION_PUBLIC_V1'
        schemaVersion = 1
        acceptanceIds = @($script:DysonQualificationRequiredAcceptanceIds)
        result = [string]$Run.state
        timeClassification = if ([string]$Run.state -eq 'passed') { 'completed' } else { 'in-progress' }
        steps = $steps
        checkpointDigest = [string]$Run.checkpointSha256
        planDigest = [string]$Run.planSha256
    }
    $public = Test-DysonQualificationPublicValue -InputObject $projection
    if (-not $public.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PUBLIC_DATA_REJECTED' ($public.reasons -join ',') }
    return $projection
}
