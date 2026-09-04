[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$OriginalRequestId,
    [Parameter(Mandatory)][string]$RollbackRequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$GameRoot,
    [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
    [Parameter(Mandatory)][string]$OriginalPlanPath,
    [Parameter(Mandatory)][string]$OriginalReceiptSha256,
    [Parameter(Mandatory)][datetimeoffset]$MaintenanceWindowStartUtc,
    [Parameter(Mandatory)][datetimeoffset]$MaintenanceWindowEndUtc,
    [ValidateSet('Windows','Shadow')][string]$Backend = 'Windows',
    [string]$ShadowEvidencePath,
    [switch]$Apply,
    [string]$ConfirmationPhrase,
    [switch]$Recover,
    [string]$HostMutationDataRoot,
    [string]$HostMutationLeaseInstanceId,
    [string]$HostMutationLeaseToken,
    [string]$TestFailurePoint,
    [string]$TestCrashPoint,
    [ValidateRange(0,10000)][int]$TestDelayAfterIntentMilliseconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

function Get-RollbackContext {
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $OriginalRequestId) -JobBase $JobBase `
        -RequestId $OriginalRequestId
    $original = Get-NebulaPluginLayout -GameRoot $GameRoot -RequestId $OriginalRequestId -Backend $Backend
    $rollback = Get-NebulaPluginLayout -GameRoot $GameRoot -RequestId $RollbackRequestId -Backend $Backend
    $plan = Read-NebulaPluginPlan -Path $OriginalPlanPath -JobRoot $jobRoot -RequestId $OriginalRequestId `
        -GameRoot $original.gameRoot -TargetRole $TargetRole -Backend $Backend
    $intent = Read-NebulaPluginIntent -Path $original.intentPath
    $receipt = Assert-NebulaPluginReceipt -Receipt (Read-NebulaPluginJson -Path $original.receiptPath)
    if ([string]$receipt.status -cne 'applied' -or [string]$receipt.receiptDigest -cne $OriginalReceiptSha256 -or
        [string]$intent.operation -cne 'apply' -or
        [string]$receipt.targetBindingDigest -cne [string]$plan.target.targetBindingDigest -or
        [string]$receipt.physicalTargetDigest -cne [string]$plan.target.physicalTargetDigest -or
        [string]$intent.planDigest -cne [string]$plan.planDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_SOURCE_INVALID'
    }
    [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $receipt -Intent $intent `
        -Code 'NEBULA_PLUGIN_ROLLBACK_SOURCE_INVALID')
    $preimage = Read-NebulaPluginJson -Path (Join-Path $jobRoot 'evidence\plugin-cutover-preimage-inventory.json')
    [void](Assert-NebulaPluginInventoryValue -Inventory $preimage -Code 'NEBULA_PLUGIN_PREIMAGE_INVENTORY_INVALID')
    if ([string]$preimage.inventoryDigest -cne [string]$plan.preimage.inventoryDigest -or
        [string]$preimage.contentTreeSha256 -cne [string]$plan.preimage.treeSha256 -or
        [string]$intent.preimageDirectoryIdentity.identityDigest -cne
            [string]$plan.preimage.directoryIdentity.identityDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_SOURCE_INVALID'
    }
    [void](Assert-NebulaPluginApplyIntentContext -Intent $intent -Plan $plan -Preimage $preimage `
        -Layout $original -Code 'NEBULA_PLUGIN_ROLLBACK_SOURCE_INVALID')
    $stageInventory = $intent.stageInventory
    $binding = [string]$plan.target.targetBindingDigest
    $rollbackReceiptExists = Test-Path -LiteralPath $rollback.receiptPath -PathType Leaf
    if (-not $Recover -and -not $rollbackReceiptExists) {
        [void](Assert-NebulaPluginParentBoundaryMatches -Expected $intent.bepInExBoundary -Path $original.bepInExRoot)
        [void](Assert-NebulaPluginBoundTree -Path $original.pluginsRoot -ExpectedInventory $stageInventory `
            -ExpectedIdentity $intent.candidateDirectoryIdentity -TargetBindingDigest $binding `
            -MismatchCode 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
        [void](Assert-NebulaPluginBoundTree -Path $original.quarantineRoot -ExpectedInventory $preimage `
            -ExpectedIdentity $intent.preimageDirectoryIdentity -TargetBindingDigest $binding `
            -MismatchCode 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
    }
    if ((Test-Path -LiteralPath $rollback.stageRoot) -or (Test-Path -LiteralPath $rollback.intentPath) -or
        $rollbackReceiptExists -or (Test-Path -LiteralPath $rollback.quarantineRoot)) {
        if (-not $Recover -and -not $rollbackReceiptExists) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_REQUEST_STATE_EXISTS'
        }
    }
    $head = Get-NebulaPluginReceiptChainHead -ReceiptsRoot (Join-Path $original.stateRoot 'receipts') `
        -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest)
    return [pscustomobject][ordered]@{
        jobRoot=$jobRoot; original=$original; rollback=$rollback; plan=$plan; originalIntent=$intent
        originalReceipt=$receipt; preimage=$preimage; stageInventory=$stageInventory; binding=$binding
        physicalTargetDigest=[string]$plan.target.physicalTargetDigest; chainHead=$head
    }
}

function Get-RollbackPreview {
    param($Context)
    $core = [ordered]@{
        protocol='DYSON_NEBULA_PLUGIN_ROLLBACK_PREVIEW_V3'; schemaVersion=3
        rollbackRequestId=$RollbackRequestId; originalRequestId=$OriginalRequestId; targetRole=$TargetRole
        targetBindingDigest=[string]$Context.binding; originalReceiptDigest=[string]$Context.originalReceipt.receiptDigest
        physicalTargetDigest=[string]$Context.physicalTargetDigest
        previousReceiptDigest=[string]$Context.chainHead
        candidateTreeSha256=[string]$Context.plan.candidate.treeSha256
        preimageTreeSha256=[string]$Context.preimage.contentTreeSha256
        preimageInventoryDigest=[string]$Context.preimage.inventoryDigest
        candidateInventoryDigest=[string]$Context.stageInventory.inventoryDigest
        maintenanceWindow=[ordered]@{ startUtc=$MaintenanceWindowStartUtc.ToString('o'); endUtc=$MaintenanceWindowEndUtc.ToString('o') }
        defaultMode='dry-run'; deleteIsNeverAutomatic=$true; candidateRetainedInStage=$true
    }
    $digest = Get-NebulaPrivateObjectSha256 -Value $core
    return [pscustomobject][ordered]@{
        core=$core; previewDigest=$digest
        exactPhrase=('CONFIRM NEBULA PLUGIN ROLLBACK ' + $RollbackRequestId + ' ' + $digest)
    }
}

function New-RollbackReceipt {
    param($Context, $Intent, [string]$Status, [string]$ActiveTree)
    return New-NebulaPluginReceiptValue -RequestId $RollbackRequestId -Operation rollback -Status $Status `
        -TargetRole $TargetRole -TargetBindingDigest ([string]$Context.binding) `
        -PhysicalTargetDigest ([string]$Context.physicalTargetDigest) `
        -IntentDigest ([string]$Intent.intentDigest) -PreviousReceiptDigest ([string]$Context.chainHead) `
        -CandidateManifestDigest ([string]$Context.plan.candidate.manifestDigest) `
        -CandidateTreeSha256 ([string]$Context.plan.candidate.treeSha256) `
        -PreimageInventoryDigest ([string]$Context.preimage.inventoryDigest) `
        -PreimageTreeSha256 ([string]$Context.preimage.contentTreeSha256) `
        -PreimageAclDigest ([string]$Context.preimage.aclDigest) `
        -CandidateInventoryDigest ([string]$Context.stageInventory.inventoryDigest) `
        -CandidateAclDigest ([string]$Context.stageInventory.aclDigest) -ActiveTreeSha256 $ActiveTree `
        -BepInExBoundaryDigest ([string]$Intent.bepInExBoundary.boundaryDigest) `
        -PreimageDirectoryIdentityDigest ([string]$Intent.preimageDirectoryIdentity.identityDigest) `
        -CandidateDirectoryIdentityDigest ([string]$Intent.candidateDirectoryIdentity.identityDigest)
}

function Assert-RollbackMutationBoundary {
    param($Context, $Intent, $LeaseContext)
    [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $LeaseContext)
    [void](Assert-NebulaPluginCurrentChainHead -Layout $Context.rollback `
        -PhysicalTargetDigest ([string]$Context.physicalTargetDigest) `
        -ExpectedDigest ([string]$Intent.previousReceiptDigest))
    Assert-NebulaPluginMaintenanceWindow $MaintenanceWindowStartUtc $MaintenanceWindowEndUtc -RequireCurrent
    $live = Get-NebulaPluginPreflightEvidence $Context.original.gameRoot $TargetRole $Backend $ShadowEvidencePath
    [void](Assert-NebulaPluginPreflightCompatible $live)
    [void](Assert-NebulaPluginParentBoundaryMatches -Expected $Intent.bepInExBoundary `
        -Path $Context.original.bepInExRoot)
}

function Assert-RollbackIntentContext {
    param($Context, $Intent, [string]$ExpectedPreviewDigest,
        [string]$Code = 'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    if ([string]$Intent.operation -cne 'rollback' -or
        [string]$Intent.requestId -cne $RollbackRequestId -or
        [string]$Intent.originalRequestId -cne $OriginalRequestId -or
        [string]$Intent.originalReceiptDigest -cne $OriginalReceiptSha256 -or
        [string]$Intent.targetRole -cne $TargetRole -or
        [string]$Intent.targetBindingDigest -cne [string]$Context.binding -or
        [string]$Intent.physicalTargetDigest -cne [string]$Context.physicalTargetDigest -or
        [string]$Intent.planDigest -cne [string]$Context.plan.planDigest -or
        [string]$Intent.candidateManifestDigest -cne [string]$Context.plan.candidate.manifestDigest -or
        [string]$Intent.candidateTreeSha256 -cne [string]$Context.plan.candidate.treeSha256 -or
        [string]$Intent.preimageInventoryDigest -cne [string]$Context.preimage.inventoryDigest -or
        [string]$Intent.preimageTreeSha256 -cne [string]$Context.preimage.contentTreeSha256 -or
        [string]$Intent.preimageAclDigest -cne [string]$Context.preimage.aclDigest -or
        [string]$Intent.stageInventory.inventoryDigest -cne [string]$Context.stageInventory.inventoryDigest -or
        [string]$Intent.bepInExBoundary.boundaryDigest -cne
            [string]$Context.originalIntent.bepInExBoundary.boundaryDigest -or
        [string]$Intent.preimageDirectoryIdentity.identityDigest -cne
            [string]$Context.originalIntent.preimageDirectoryIdentity.identityDigest -or
        [string]$Intent.candidateDirectoryIdentity.identityDigest -cne
            [string]$Context.originalIntent.candidateDirectoryIdentity.identityDigest -or
        [string]$Intent.previousReceiptDigest -cne $OriginalReceiptSha256 -or
        [string]$Intent.stageLeaf -cne [IO.Path]::GetFileName([string]$Context.rollback.stageRoot) -or
        [string]$Intent.quarantineLeaf -cne [IO.Path]::GetFileName([string]$Context.original.quarantineRoot) -or
        (-not [string]::IsNullOrWhiteSpace($ExpectedPreviewDigest) -and
            [string]$Intent.previewDigest -cne $ExpectedPreviewDigest)) {
        Throw-NebulaPluginError $Code
    }
    return $Intent
}

function Assert-ExistingRollbackTerminalContext {
    param($Context)
    if (-not (Test-Path -LiteralPath $Context.rollback.intentPath -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TERMINAL_EVIDENCE_MISSING'
    }
    $intent = Read-NebulaPluginIntent $Context.rollback.intentPath
    $receipt = Assert-NebulaPluginReceipt (Read-NebulaPluginJson $Context.rollback.receiptPath)
    [void](Assert-RollbackIntentContext $Context $intent $null 'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $receipt -Intent $intent `
        -Code 'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    $state = Assert-NebulaPluginRootPendingIntentGate -Layout $Context.rollback `
        -PhysicalTargetDigest ([string]$Context.physicalTargetDigest)
    if ([string]$state.chainHead -cne [string]$receipt.receiptDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
    }
    [void](Assert-NebulaPluginReceiptTerminalState -Receipt $receipt -Intent $intent `
        -PreimageInventory $Context.preimage -ActiveRoot $Context.original.pluginsRoot `
        -CandidateStageRoot $Context.rollback.stageRoot `
        -PreimageQuarantineRoot $Context.original.quarantineRoot -BepInExRoot $Context.original.bepInExRoot `
        -Code 'NEBULA_PLUGIN_ROLLBACK_TERMINAL_STATE_INVALID')
    return $receipt
}

function Restore-AppliedStateAfterRollbackFailure {
    param($Context, $Intent, [string]$Status, $LeaseContext)
    $original=$Context.original; $rollback=$Context.rollback; $binding=[string]$Context.binding
    $activeExists=Test-Path -LiteralPath $original.pluginsRoot -PathType Container
    $stageExists=Test-Path -LiteralPath $rollback.stageRoot -PathType Container
    $quarantineExists=Test-Path -LiteralPath $original.quarantineRoot -PathType Container
    $activeCandidate=$activeExists -and (Test-NebulaPluginBoundTree $original.pluginsRoot `
        $Context.stageInventory $Intent.candidateDirectoryIdentity $binding)
    $activePreimage=$activeExists -and (Test-NebulaPluginBoundTree $original.pluginsRoot `
        $Context.preimage $Intent.preimageDirectoryIdentity $binding)
    $stageCandidate=$stageExists -and (Test-NebulaPluginBoundTree $rollback.stageRoot `
        $Context.stageInventory $Intent.candidateDirectoryIdentity $binding)
    $quarantinePreimage=$quarantineExists -and (Test-NebulaPluginBoundTree $original.quarantineRoot `
        $Context.preimage $Intent.preimageDirectoryIdentity $binding)
    if ($activeCandidate -and -not $stageExists -and $quarantinePreimage) { }
    elseif (-not $activeExists -and $stageCandidate) {
        # Candidate identity is independent of the quarantined preimage.  Put
        # the previously applied candidate back even if the other retained
        # tree drifted; terminal verification will then fail closed and leave
        # the rollback intent pending for inspection.
        Assert-RollbackMutationBoundary $Context $Intent $LeaseContext
        [void](Assert-NebulaPluginBoundTree $rollback.stageRoot $Context.stageInventory `
            $Intent.candidateDirectoryIdentity $binding 'NEBULA_PLUGIN_ROLLBACK_RECOVERY_AMBIGUOUS')
        Move-NebulaPluginDirectory $rollback.stageRoot $original.pluginsRoot
    }
    elseif ($activePreimage -and $stageCandidate -and -not $quarantineExists) {
        Assert-RollbackMutationBoundary $Context $Intent $LeaseContext
        [void](Assert-NebulaPluginBoundTree $original.pluginsRoot $Context.preimage `
            $Intent.preimageDirectoryIdentity $binding 'NEBULA_PLUGIN_ROLLBACK_RECOVERY_AMBIGUOUS')
        Move-NebulaPluginDirectory $original.pluginsRoot $original.quarantineRoot
        Assert-RollbackMutationBoundary $Context $Intent $LeaseContext
        [void](Assert-NebulaPluginBoundTree $rollback.stageRoot $Context.stageInventory `
            $Intent.candidateDirectoryIdentity $binding 'NEBULA_PLUGIN_ROLLBACK_RECOVERY_AMBIGUOUS')
        Move-NebulaPluginDirectory $rollback.stageRoot $original.pluginsRoot
    }
    else { Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_RECOVERY_AMBIGUOUS' }
    [void](Assert-NebulaPluginBoundTree $original.pluginsRoot $Context.stageInventory `
        $Intent.candidateDirectoryIdentity $binding 'NEBULA_PLUGIN_ROLLBACK_COMPENSATION_FAILED')
    [void](Assert-NebulaPluginBoundTree $original.quarantineRoot $Context.preimage `
        $Intent.preimageDirectoryIdentity $binding 'NEBULA_PLUGIN_ROLLBACK_COMPENSATION_FAILED')
    if (Test-Path -LiteralPath $rollback.stageRoot) { Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_COMPENSATION_FAILED' }
    Assert-RollbackMutationBoundary $Context $Intent $LeaseContext
    $receipt=New-RollbackReceipt -Context $Context -Intent $Intent -Status $Status `
        -ActiveTree ([string]$Context.plan.candidate.treeSha256)
    [void](Write-NebulaPluginJsonNew $rollback.receiptPath $receipt $rollback.stateRoot)
    return $receipt
}

try {
    if (-not (Test-NebulaPrivateUuid -Value $RollbackRequestId) -or $RollbackRequestId -ceq $OriginalRequestId -or
        -not (Test-NebulaPrivateSha256 -Value $OriginalReceiptSha256)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_INPUT_INVALID'
    }
    Assert-NebulaPluginMaintenanceWindow $MaintenanceWindowStartUtc $MaintenanceWindowEndUtc
    $hasTestHook = -not [string]::IsNullOrWhiteSpace($TestFailurePoint) -or
        -not [string]::IsNullOrWhiteSpace($TestCrashPoint) -or $TestDelayAfterIntentMilliseconds -ne 0
    if (($Recover -or $hasTestHook) -and -not $Apply) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ARGUMENT_CONFLICT'
    }
    if ($hasTestHook -and $Backend -cne 'Shadow') { Throw-NebulaPluginError 'NEBULA_PLUGIN_TEST_HOOK_FORBIDDEN' }
    $context=Get-RollbackContext
    $live=Get-NebulaPluginPreflightEvidence $context.original.gameRoot $TargetRole $Backend $ShadowEvidencePath
    [void](Assert-NebulaPluginPreflightCompatible $live)
    $preview=Get-RollbackPreview $context
    if (-not $Apply) {
        $state = Assert-NebulaPluginRootPendingIntentGate -Layout $context.rollback `
            -PhysicalTargetDigest ([string]$context.physicalTargetDigest)
        if ([string]$state.chainHead -cne $OriginalReceiptSha256) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
        }
        [pscustomobject][ordered]@{
            protocol='DYSON_NEBULA_PLUGIN_ROLLBACK_PREVIEW_V3'; status='preview'; mode='dry-run'
            rollbackRequestId=$RollbackRequestId; originalRequestId=$OriginalRequestId
            previewDigest=[string]$preview.previewDigest; exactConfirmationPhrase=[string]$preview.exactPhrase
            productionChanged=$false
        } | ConvertTo-Json -Compress
        exit 0
    }
    Assert-NebulaPluginMaintenanceWindow $MaintenanceWindowStartUtc $MaintenanceWindowEndUtc -RequireCurrent
    if ($ConfirmationPhrase -cne [string]$preview.exactPhrase) { Throw-NebulaPluginError 'NEBULA_PLUGIN_CONFIRMATION_REQUIRED' }
    if (-not $PSCmdlet.ShouldProcess(($TargetRole + ' plugin tree identity ' + [string]$context.plan.target.gamePathIdentity),
        'restore exact quarantined preimage and retain candidate in rollback stage')) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CONFIRMATION_REQUIRED'
    }
    $leaseContext = New-NebulaPluginBorrowedLeaseContext -DataRoot $HostMutationDataRoot `
        -InstanceId $HostMutationLeaseInstanceId -Token $HostMutationLeaseToken `
        -ExpectedKind $(if ($Recover) { 'recovery' } else { 'mutation' })
    [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
    $lock=Enter-NebulaPluginLock $context.rollback
    try {
        if (Test-Path -LiteralPath $context.rollback.receiptPath -PathType Leaf) {
            $existing=Assert-ExistingRollbackTerminalContext $context
            [pscustomobject][ordered]@{ protocol=$script:NebulaPluginReceiptProtocol; status=[string]$existing.status
                requestId=$RollbackRequestId; receiptDigest=[string]$existing.receiptDigest; reused=$true } |
                ConvertTo-Json -Compress
            exit 0
        }
        if ($Recover) {
            if (-not (Test-Path -LiteralPath $context.rollback.intentPath -PathType Leaf)) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECOVERY_INTENT_MISSING'
            }
            $intent=Read-NebulaPluginIntent $context.rollback.intentPath
            [void](Assert-RollbackIntentContext $context $intent ([string]$preview.previewDigest) `
                'NEBULA_PLUGIN_RECOVERY_INTENT_MISMATCH')
            $state = Assert-NebulaPluginRootPendingIntentGate -Layout $context.rollback `
                -PhysicalTargetDigest ([string]$context.physicalTargetDigest) -AllowedPendingRequestId $RollbackRequestId
            if ([string]$state.chainHead -cne [string]$intent.previousReceiptDigest) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
            }
            Assert-RollbackMutationBoundary $context $intent $leaseContext
            $receipt=Restore-AppliedStateAfterRollbackFailure $context $intent `
                'rollback-recovery-restored-candidate' $leaseContext
            [pscustomobject][ordered]@{ protocol=$script:NebulaPluginReceiptProtocol
                status='rollback-recovery-restored-candidate'; requestId=$RollbackRequestId
                receiptDigest=[string]$receipt.receiptDigest; reused=$false } | ConvertTo-Json -Compress
            exit 0
        }
        $state = Assert-NebulaPluginRootPendingIntentGate -Layout $context.rollback `
            -PhysicalTargetDigest ([string]$context.physicalTargetDigest)
        if ([string]$state.chainHead -cne $OriginalReceiptSha256 -or
            $context.chainHead -cne $OriginalReceiptSha256) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
        }
        [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
        Assert-NebulaPluginMaintenanceWindow $MaintenanceWindowStartUtc $MaintenanceWindowEndUtc -RequireCurrent
        $immediate=Get-NebulaPluginPreflightEvidence $context.original.gameRoot $TargetRole $Backend $ShadowEvidencePath
        [void](Assert-NebulaPluginPreflightCompatible $immediate)
        [void](Assert-NebulaPluginParentBoundaryMatches $context.originalIntent.bepInExBoundary `
            $context.original.bepInExRoot)
        Assert-NebulaPluginTreeUnlocked $context.original.pluginsRoot
        Assert-NebulaPluginTreeUnlocked $context.original.quarantineRoot
        [void](Assert-NebulaPluginBoundTree $context.original.pluginsRoot $context.stageInventory `
            $context.originalIntent.candidateDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
        [void](Assert-NebulaPluginBoundTree $context.original.quarantineRoot $context.preimage `
            $context.originalIntent.preimageDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
        $intentCore=[ordered]@{
            protocol=$script:NebulaPluginIntentProtocol; schemaVersion=3; requestId=$RollbackRequestId; operation='rollback'
            originalRequestId=$OriginalRequestId; originalReceiptDigest=$OriginalReceiptSha256; targetRole=$TargetRole
            targetBindingDigest=[string]$context.binding; physicalTargetDigest=[string]$context.physicalTargetDigest
            planDigest=[string]$context.plan.planDigest
            candidateManifestDigest=[string]$context.plan.candidate.manifestDigest
            candidateTreeSha256=[string]$context.plan.candidate.treeSha256
            preimageInventoryDigest=[string]$context.preimage.inventoryDigest
            preimageTreeSha256=[string]$context.preimage.contentTreeSha256; preimageAclDigest=[string]$context.preimage.aclDigest
            stageInventory=$context.stageInventory; bepInExBoundary=$context.originalIntent.bepInExBoundary
            preimageDirectoryIdentity=$context.originalIntent.preimageDirectoryIdentity
            candidateDirectoryIdentity=$context.originalIntent.candidateDirectoryIdentity
            previousReceiptDigest=[string]$context.chainHead
            stageLeaf=[IO.Path]::GetFileName([string]$context.rollback.stageRoot)
            quarantineLeaf=[IO.Path]::GetFileName([string]$context.original.quarantineRoot)
            candidateSourcePathPersisted=$false; previewDigest=[string]$preview.previewDigest
            createdUtc=[datetimeoffset]::UtcNow.ToString('o')
        }
        $intentValue=[ordered]@{}; foreach($key in $intentCore.Keys){$intentValue[$key]=$intentCore[$key]}
        $intentValue.intentDigest=Get-NebulaPrivateObjectSha256 $intentCore
        [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
        [void](Write-NebulaPluginJsonNew $context.rollback.intentPath $intentValue $context.rollback.stateRoot)
        $intent=Read-NebulaPluginIntent $context.rollback.intentPath
        try {
            Test-NebulaPluginFault $TestFailurePoint 'AfterRollbackIntent' $Backend
            Test-NebulaPluginFault $TestCrashPoint 'AfterRollbackIntent' $Backend -Crash
            if ($TestDelayAfterIntentMilliseconds -gt 0) { Start-Sleep -Milliseconds $TestDelayAfterIntentMilliseconds }
            Assert-RollbackMutationBoundary $context $intent $leaseContext
            Assert-NebulaPluginTreeUnlocked $context.original.pluginsRoot
            Assert-NebulaPluginTreeUnlocked $context.original.quarantineRoot
            [void](Assert-NebulaPluginBoundTree $context.original.pluginsRoot $context.stageInventory `
                $intent.candidateDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
            [void](Assert-NebulaPluginBoundTree $context.original.quarantineRoot $context.preimage `
                $intent.preimageDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
            Move-NebulaPluginDirectory $context.original.pluginsRoot $context.rollback.stageRoot
            Test-NebulaPluginFault $TestFailurePoint 'AfterCandidateMoved' $Backend
            Test-NebulaPluginFault $TestCrashPoint 'AfterCandidateMoved' $Backend -Crash
            Assert-RollbackMutationBoundary $context $intent $leaseContext
            [void](Assert-NebulaPluginBoundTree $context.rollback.stageRoot $context.stageInventory `
                $intent.candidateDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
            [void](Assert-NebulaPluginBoundTree $context.original.quarantineRoot $context.preimage `
                $intent.preimageDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED')
            Move-NebulaPluginDirectory $context.original.quarantineRoot $context.original.pluginsRoot
            Test-NebulaPluginFault $TestFailurePoint 'AfterPreimageRestored' $Backend
            Test-NebulaPluginFault $TestCrashPoint 'AfterPreimageRestored' $Backend -Crash
            [void](Assert-NebulaPluginBoundTree $context.original.pluginsRoot $context.preimage `
                $intent.preimageDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_VERIFY_FAILED')
            [void](Assert-NebulaPluginBoundTree $context.rollback.stageRoot $context.stageInventory `
                $intent.candidateDirectoryIdentity $context.binding 'NEBULA_PLUGIN_ROLLBACK_VERIFY_FAILED')
            Assert-RollbackMutationBoundary $context $intent $leaseContext
            $receipt=New-RollbackReceipt $context $intent 'rolled-back-manual' ([string]$context.preimage.contentTreeSha256)
            [void](Write-NebulaPluginJsonNew $context.rollback.receiptPath $receipt $context.rollback.stateRoot)
        }
        catch {
            if ((Get-NebulaPrivateErrorCode $_.Exception) -ceq 'NEBULA_PLUGIN_SIMULATED_CRASH') { throw }
            try { [void](Restore-AppliedStateAfterRollbackFailure $context $intent `
                'rollback-failed-restored-candidate' $leaseContext) }
            catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_COMPENSATION_FAILED' }
            Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_FAILED_RESTORED_CANDIDATE'
        }
        [pscustomobject][ordered]@{ protocol=$script:NebulaPluginReceiptProtocol; status='rolled-back-manual'
            requestId=$RollbackRequestId; originalRequestId=$OriginalRequestId
            receiptDigest=[string]$receipt.receiptDigest; candidateStageRetained=$true; reused=$false } |
            ConvertTo-Json -Compress
    }
    finally { $lock.Dispose() }
}
catch {
    [Console]::Error.WriteLine((Get-NebulaPrivateErrorCode -Exception $_.Exception))
    exit 1
}
