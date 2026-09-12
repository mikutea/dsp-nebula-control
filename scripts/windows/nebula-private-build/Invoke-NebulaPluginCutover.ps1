[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$GameRoot,
    [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
    [Parameter(Mandatory)][string]$PlanPath,
    [Parameter(Mandatory)][string]$CandidateManifestPath,
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
    [ValidateSet('None','StageContentTamperAfterIntent','StageIdentitySwapAfterIntent',
        'StageContentTamperAfterQuarantineMove','LeaseLossAfterIntent')]
    [string]$TestAdversaryAction = 'None',
    [ValidateRange(0,10000)][int]$TestDelayAfterIntentMilliseconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

function Read-ApplyPreimage {
    param([string]$JobRoot, $Plan)
    $path = Join-Path $JobRoot 'evidence\plugin-cutover-preimage-inventory.json'
    $value = Read-NebulaPluginJson -Path $path
    [void](Assert-NebulaPluginInventoryValue -Inventory $value -Code 'NEBULA_PLUGIN_PREIMAGE_INVENTORY_INVALID')
    if ([string]$value.inventoryDigest -cne [string]$Plan.preimage.inventoryDigest -or
        [string]$value.contentTreeSha256 -cne [string]$Plan.preimage.treeSha256 -or
        [string]$value.aclDigest -cne [string]$Plan.preimage.aclDigest -or
        [int]$value.fileCount -ne [int]$Plan.preimage.files) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PREIMAGE_INVENTORY_INVALID'
    }
    return $value
}

function Assert-ApplyPlanBindings {
    param($Plan, $Candidate, $Preimage, $Layout, [string]$TargetRole, [string]$Backend, [string]$ShadowEvidencePath)
    if ([string]$Plan.candidate.manifestDigest -cne [string]$Candidate.manifest.manifestDigest -or
        [string]$Plan.candidate.treeSha256 -cne [string]$Candidate.result.candidateTreeSha256 -or
        [int]$Plan.candidate.files -ne 44 -or [string]$Plan.compatibility.gameVersion -cne
            [string]$script:NebulaPrivateContract.game.gameVersion -or
        [string]$Plan.compatibility.gameLibVersion -cne [string]$script:NebulaPrivateContract.game.gameLibVersion -or
        [string]$Plan.compatibility.assemblyCSharpMvid -cne [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_BINDING_INVALID'
    }
    $live = Get-NebulaPluginPreflightEvidence -GameRoot $Layout.gameRoot -TargetRole $TargetRole `
        -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
    [void](Assert-NebulaPluginPreflightCompatible -Evidence $live)
    Assert-NebulaPluginTreeUnlocked -Root $Layout.pluginsRoot
    [void](Assert-NebulaPluginParentBoundaryMatches -Expected $Plan.target.bepInExBoundary -Path $Layout.bepInExRoot)
    [void](Assert-NebulaPluginBoundTree -Path $Layout.pluginsRoot -ExpectedInventory $Preimage `
        -ExpectedIdentity $Plan.preimage.directoryIdentity `
        -TargetBindingDigest ([string]$Plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_PREIMAGE_CHANGED')
    $start = [datetimeoffset]::ParseExact([string]$Plan.maintenanceWindow.startUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $end = [datetimeoffset]::ParseExact([string]$Plan.maintenanceWindow.endUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    Assert-NebulaPluginMaintenanceWindow -StartUtc $start -EndUtc $end -RequireCurrent
    $head = Get-NebulaPluginReceiptChainHead -ReceiptsRoot (Join-Path $Layout.stateRoot 'receipts') `
        -PhysicalTargetDigest ([string]$Plan.target.physicalTargetDigest)
    if ($head -cne [string]$Plan.receiptChain.previousReceiptDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
    }
}

function New-ApplyReceipt {
    param($Plan, $Intent, $Preimage, $StageInventory, [string]$Status, [string]$ActiveTreeSha256)
    return New-NebulaPluginReceiptValue -RequestId ([string]$Plan.requestId) -Operation apply -Status $Status `
        -TargetRole ([string]$Plan.target.targetRole) -TargetBindingDigest ([string]$Plan.target.targetBindingDigest) `
        -PhysicalTargetDigest ([string]$Plan.target.physicalTargetDigest) `
        -IntentDigest ([string]$Intent.intentDigest) `
        -PreviousReceiptDigest ([string]$Plan.receiptChain.previousReceiptDigest) `
        -CandidateManifestDigest ([string]$Plan.candidate.manifestDigest) `
        -CandidateTreeSha256 ([string]$Plan.candidate.treeSha256) `
        -PreimageInventoryDigest ([string]$Preimage.inventoryDigest) `
        -PreimageTreeSha256 ([string]$Preimage.contentTreeSha256) `
        -PreimageAclDigest ([string]$Preimage.aclDigest) `
        -CandidateInventoryDigest ([string]$StageInventory.inventoryDigest) `
        -CandidateAclDigest ([string]$StageInventory.aclDigest) -ActiveTreeSha256 $ActiveTreeSha256 `
        -BepInExBoundaryDigest ([string]$Intent.bepInExBoundary.boundaryDigest) `
        -PreimageDirectoryIdentityDigest ([string]$Intent.preimageDirectoryIdentity.identityDigest) `
        -CandidateDirectoryIdentityDigest ([string]$Intent.candidateDirectoryIdentity.identityDigest)
}

function Get-ApplyMaintenanceWindow {
    param($Plan)
    return [pscustomobject][ordered]@{
        start = [datetimeoffset]::ParseExact([string]$Plan.maintenanceWindow.startUtc, 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        end = [datetimeoffset]::ParseExact([string]$Plan.maintenanceWindow.endUtc, 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    }
}

function Assert-ApplyMutationBoundary {
    param($Layout, $Plan, $Intent, $LeaseContext, [string]$TargetRole, [string]$Backend,
        [string]$ShadowEvidencePath)
    [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $LeaseContext)
    [void](Assert-NebulaPluginCurrentChainHead -Layout $Layout `
        -PhysicalTargetDigest ([string]$Plan.target.physicalTargetDigest) `
        -ExpectedDigest ([string]$Intent.previousReceiptDigest))
    $window = Get-ApplyMaintenanceWindow -Plan $Plan
    Assert-NebulaPluginMaintenanceWindow -StartUtc $window.start -EndUtc $window.end -RequireCurrent
    $live = Get-NebulaPluginPreflightEvidence -GameRoot $Layout.gameRoot -TargetRole $TargetRole `
        -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
    [void](Assert-NebulaPluginPreflightCompatible -Evidence $live)
    [void](Assert-NebulaPluginParentBoundaryMatches -Expected $Intent.bepInExBoundary -Path $Layout.bepInExRoot)
}

function Assert-ExistingApplyTerminalContext {
    param($Layout, $Plan, $Candidate, $Preimage, [string]$RequestId)
    if (-not (Test-Path -LiteralPath $Layout.intentPath -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TERMINAL_EVIDENCE_MISSING'
    }
    $intent = Read-NebulaPluginIntent -Path $Layout.intentPath
    $receipt = Assert-NebulaPluginReceipt -Receipt (Read-NebulaPluginJson -Path $Layout.receiptPath)
    [void](Assert-NebulaPluginApplyIntentContext -Intent $intent -Plan $Plan -Preimage $Preimage `
        -Layout $Layout -Code 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID')
    if ([string]$intent.candidateManifestDigest -cne [string]$Candidate.manifest.manifestDigest -or
        [string]$intent.candidateTreeSha256 -cne [string]$Candidate.result.candidateTreeSha256) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID'
    }
    [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $receipt -Intent $intent)
    $state = Assert-NebulaPluginRootPendingIntentGate -Layout $Layout `
        -PhysicalTargetDigest ([string]$Plan.target.physicalTargetDigest)
    if ([string]$state.chainHead -cne [string]$receipt.receiptDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
    }
    [void](Assert-NebulaPluginReceiptTerminalState -Receipt $receipt -Intent $intent `
        -PreimageInventory $Preimage -ActiveRoot $Layout.pluginsRoot -CandidateStageRoot $Layout.stageRoot `
        -PreimageQuarantineRoot $Layout.quarantineRoot -BepInExRoot $Layout.bepInExRoot)
    return $receipt
}

function Invoke-ApplyCompensation {
    param($Layout, $Plan, $Intent, $Preimage, $StageInventory, [string]$Status, $LeaseContext,
        [string]$TargetRole, [string]$Backend, [string]$ShadowEvidencePath)
    $binding = [string]$Plan.target.targetBindingDigest
    $activeExists = Test-Path -LiteralPath $Layout.pluginsRoot -PathType Container
    $stageExists = Test-Path -LiteralPath $Layout.stageRoot -PathType Container
    $quarantineExists = Test-Path -LiteralPath $Layout.quarantineRoot -PathType Container
    $activeIsPreimage = $activeExists -and (Test-NebulaPluginBoundTree -Path $Layout.pluginsRoot `
        -ExpectedInventory $Preimage -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding)
    $activeIsCandidate = $activeExists -and (Test-NebulaPluginBoundTree -Path $Layout.pluginsRoot `
        -ExpectedInventory $StageInventory -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding)
    $stageIsCandidate = $stageExists -and (Test-NebulaPluginBoundTree -Path $Layout.stageRoot `
        -ExpectedInventory $StageInventory -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding)
    $quarantineIsPreimage = $quarantineExists -and (Test-NebulaPluginBoundTree -Path $Layout.quarantineRoot `
        -ExpectedInventory $Preimage -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding)
    if ($activeIsPreimage -and $stageIsCandidate -and -not $quarantineExists) {
        # No active-tree mutation occurred. The verified stage is deliberately retained.
    }
    elseif (-not $activeExists -and $quarantineIsPreimage) {
        # The preimage is independently content/ACL/identity-bound.  Restore it
        # even if the retained candidate stage was altered after the first
        # rename; the later exact-stage check will keep the intent pending.
        Assert-ApplyMutationBoundary -Layout $Layout -Plan $Plan -Intent $Intent -LeaseContext $LeaseContext `
            -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
        [void](Assert-NebulaPluginBoundTree -Path $Layout.quarantineRoot -ExpectedInventory $Preimage `
            -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding `
            -MismatchCode 'NEBULA_PLUGIN_RECOVERY_STATE_AMBIGUOUS')
        Move-NebulaPluginDirectory -Source $Layout.quarantineRoot -Destination $Layout.pluginsRoot
    }
    elseif ($activeIsCandidate -and -not $stageExists -and $quarantineIsPreimage) {
        Assert-ApplyMutationBoundary -Layout $Layout -Plan $Plan -Intent $Intent -LeaseContext $LeaseContext `
            -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
        [void](Assert-NebulaPluginBoundTree -Path $Layout.pluginsRoot -ExpectedInventory $StageInventory `
            -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding `
            -MismatchCode 'NEBULA_PLUGIN_RECOVERY_STATE_AMBIGUOUS')
        Move-NebulaPluginDirectory -Source $Layout.pluginsRoot -Destination $Layout.stageRoot
        Assert-ApplyMutationBoundary -Layout $Layout -Plan $Plan -Intent $Intent -LeaseContext $LeaseContext `
            -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
        [void](Assert-NebulaPluginBoundTree -Path $Layout.quarantineRoot -ExpectedInventory $Preimage `
            -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding `
            -MismatchCode 'NEBULA_PLUGIN_RECOVERY_STATE_AMBIGUOUS')
        Move-NebulaPluginDirectory -Source $Layout.quarantineRoot -Destination $Layout.pluginsRoot
    }
    else { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECOVERY_STATE_AMBIGUOUS' }
    [void](Assert-NebulaPluginBoundTree -Path $Layout.pluginsRoot -ExpectedInventory $Preimage `
        -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding `
        -MismatchCode 'NEBULA_PLUGIN_COMPENSATION_VERIFY_FAILED')
    if (-not (Test-Path -LiteralPath $Layout.stageRoot -PathType Container)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_COMPENSATION_VERIFY_FAILED'
    }
    [void](Assert-NebulaPluginBoundTree -Path $Layout.stageRoot -ExpectedInventory $StageInventory `
        -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding `
        -MismatchCode 'NEBULA_PLUGIN_COMPENSATION_VERIFY_FAILED')
    if (Test-Path -LiteralPath $Layout.quarantineRoot) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_COMPENSATION_VERIFY_FAILED'
    }
    Assert-ApplyMutationBoundary -Layout $Layout -Plan $Plan -Intent $Intent -LeaseContext $LeaseContext `
        -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
    $receipt = New-ApplyReceipt -Plan $Plan -Intent $Intent -Preimage $Preimage `
        -StageInventory $StageInventory -Status $Status -ActiveTreeSha256 ([string]$Preimage.contentTreeSha256)
    [void](Write-NebulaPluginJsonNew -Path $Layout.receiptPath -Value $receipt -AllowedRoot $Layout.stateRoot)
    return $receipt
}

try {
    $hasTestHook = -not [string]::IsNullOrWhiteSpace($TestFailurePoint) -or
        -not [string]::IsNullOrWhiteSpace($TestCrashPoint) -or $TestAdversaryAction -cne 'None' -or
        $TestDelayAfterIntentMilliseconds -ne 0
    if (($Recover -or $hasTestHook) -and -not $Apply) { Throw-NebulaPluginError 'NEBULA_PLUGIN_ARGUMENT_CONFLICT' }
    if ($hasTestHook -and $Backend -cne 'Shadow') { Throw-NebulaPluginError 'NEBULA_PLUGIN_TEST_HOOK_FORBIDDEN' }
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $layout = Get-NebulaPluginLayout -GameRoot $GameRoot -RequestId $RequestId -Backend $Backend
    $plan = Read-NebulaPluginPlan -Path $PlanPath -JobRoot $jobRoot -RequestId $RequestId `
        -GameRoot $layout.gameRoot -TargetRole $TargetRole -Backend $Backend
    $candidate = Assert-NebulaPluginCandidateForJob -JobRoot $jobRoot -CandidateManifestPath $CandidateManifestPath
    $preimage = Read-ApplyPreimage -JobRoot $jobRoot -Plan $plan

    if (-not $Apply) {
        [void](Assert-NebulaPluginRootPendingIntentGate -Layout $layout `
            -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest))
        Assert-ApplyPlanBindings -Plan $plan -Candidate $candidate -Preimage $preimage -Layout $layout `
            -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
        [pscustomobject][ordered]@{
            protocol = $script:NebulaPluginPlanProtocol; status='preview'; mode='dry-run'
            requestId=$RequestId; targetRole=$TargetRole; planDigest=[string]$plan.planDigest
            confirmationRequired=$true; productionChanged=$false
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($ConfirmationPhrase -cne [string]$plan.confirmation.exactPhrase) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CONFIRMATION_REQUIRED'
    }
    if (-not $PSCmdlet.ShouldProcess(($TargetRole + ' plugin tree identity ' + [string]$plan.target.gamePathIdentity),
        'atomically apply exact qualified 44-file Nebula candidate while retaining quarantine')) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CONFIRMATION_REQUIRED'
    }
    $leaseContext = New-NebulaPluginBorrowedLeaseContext -DataRoot $HostMutationDataRoot `
        -InstanceId $HostMutationLeaseInstanceId -Token $HostMutationLeaseToken `
        -ExpectedKind $(if ($Recover) { 'recovery' } else { 'mutation' })
    [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)

    $lock = Enter-NebulaPluginLock -Layout $layout
    try {
        if (Test-Path -LiteralPath $layout.receiptPath -PathType Leaf) {
            $existing = Assert-ExistingApplyTerminalContext -Layout $layout -Plan $plan -Candidate $candidate `
                -Preimage $preimage -RequestId $RequestId
            [pscustomobject][ordered]@{
                protocol=$script:NebulaPluginReceiptProtocol; status=[string]$existing.status
                requestId=$RequestId; receiptDigest=[string]$existing.receiptDigest; reused=$true
            } | ConvertTo-Json -Compress
            exit 0
        }

        if ($Recover) {
            if (-not (Test-Path -LiteralPath $layout.intentPath -PathType Leaf)) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECOVERY_INTENT_MISSING'
            }
            $intent = Read-NebulaPluginIntent -Path $layout.intentPath
            [void](Assert-NebulaPluginApplyIntentContext -Intent $intent -Plan $plan -Preimage $preimage `
                -Layout $layout -Code 'NEBULA_PLUGIN_RECOVERY_INTENT_MISMATCH')
            if ([string]$intent.candidateManifestDigest -cne [string]$candidate.manifest.manifestDigest -or
                [string]$intent.candidateTreeSha256 -cne [string]$candidate.result.candidateTreeSha256) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECOVERY_INTENT_MISMATCH'
            }
            $state = Assert-NebulaPluginRootPendingIntentGate -Layout $layout `
                -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest) -AllowedPendingRequestId $RequestId
            if ([string]$state.chainHead -cne [string]$intent.previousReceiptDigest) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
            }
            Assert-ApplyMutationBoundary -Layout $layout -Plan $plan -Intent $intent -LeaseContext $leaseContext `
                -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
            $stageInventory = $intent.stageInventory
            $receipt = Invoke-ApplyCompensation -Layout $layout -Plan $plan -Intent $intent -Preimage $preimage `
                -StageInventory $stageInventory -Status 'rolled-back-recovery' -LeaseContext $leaseContext `
                -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
            [pscustomobject][ordered]@{
                protocol=$script:NebulaPluginReceiptProtocol; status='rolled-back-recovery'
                requestId=$RequestId; receiptDigest=[string]$receipt.receiptDigest; reused=$false
            } | ConvertTo-Json -Compress
            exit 0
        }

        $rootState = Assert-NebulaPluginRootPendingIntentGate -Layout $layout `
            -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest)
        if ([string]$rootState.chainHead -cne [string]$plan.receiptChain.previousReceiptDigest) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED'
        }
        Assert-ApplyPlanBindings -Plan $plan -Candidate $candidate -Preimage $preimage -Layout $layout `
            -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
        if ((Test-Path -LiteralPath $layout.stageRoot) -or (Test-Path -LiteralPath $layout.quarantineRoot)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_REQUEST_STATE_ALREADY_EXISTS'
        }
        [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
        Assert-NebulaPluginTreeUnlocked -Root $layout.pluginsRoot
        $stageInventory = Copy-NebulaPluginCandidateToStage -CandidateRoot $candidate.candidateRoot `
            -StageRoot $layout.stageRoot -TargetBindingDigest ([string]$plan.target.targetBindingDigest)
        $stageDirectoryIdentity = Get-NebulaPluginDirectoryIdentity -Path $layout.stageRoot
        if ([string]$stageInventory.contentTreeSha256 -cne [string]$plan.candidate.treeSha256 -or
            [int]$stageInventory.fileCount -ne 44) { Throw-NebulaPluginError 'NEBULA_PLUGIN_STAGE_VERIFY_FAILED' }
        Test-NebulaPluginFault -Configured $TestFailurePoint -Point 'AfterStage' -Backend $Backend
        Test-NebulaPluginFault -Configured $TestCrashPoint -Point 'AfterStage' -Backend $Backend -Crash
        [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
        [void](Assert-NebulaPluginCurrentChainHead -Layout $layout `
            -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest) `
            -ExpectedDigest ([string]$plan.receiptChain.previousReceiptDigest))
        [void](Assert-NebulaPluginParentBoundaryMatches -Expected $plan.target.bepInExBoundary -Path $layout.bepInExRoot)
        [void](Assert-NebulaPluginBoundTree -Path $layout.pluginsRoot -ExpectedInventory $preimage `
            -ExpectedIdentity $plan.preimage.directoryIdentity `
            -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_PREIMAGE_CHANGED')
        [void](Assert-NebulaPluginBoundTree -Path $layout.stageRoot -ExpectedInventory $stageInventory `
            -ExpectedIdentity $stageDirectoryIdentity -TargetBindingDigest ([string]$plan.target.targetBindingDigest) `
            -MismatchCode 'NEBULA_PLUGIN_STAGE_VERIFY_FAILED')
        $intentCore = [ordered]@{
            protocol=$script:NebulaPluginIntentProtocol; schemaVersion=3; requestId=$RequestId; operation='apply'
            targetRole=$TargetRole; targetBindingDigest=[string]$plan.target.targetBindingDigest
            physicalTargetDigest=[string]$plan.target.physicalTargetDigest
            planDigest=[string]$plan.planDigest; candidateManifestDigest=[string]$plan.candidate.manifestDigest
            candidateTreeSha256=[string]$plan.candidate.treeSha256
            preimageInventoryDigest=[string]$preimage.inventoryDigest
            preimageTreeSha256=[string]$preimage.contentTreeSha256; preimageAclDigest=[string]$preimage.aclDigest
            stageInventory=$stageInventory; bepInExBoundary=$plan.target.bepInExBoundary
            preimageDirectoryIdentity=$plan.preimage.directoryIdentity
            candidateDirectoryIdentity=$stageDirectoryIdentity
            previousReceiptDigest=[string]$plan.receiptChain.previousReceiptDigest
            stageLeaf=[IO.Path]::GetFileName([string]$layout.stageRoot)
            quarantineLeaf=[IO.Path]::GetFileName([string]$layout.quarantineRoot)
            candidateSourcePathPersisted=$false; createdUtc=[datetimeoffset]::UtcNow.ToString('o')
        }
        $intentValue = [ordered]@{}; foreach ($key in $intentCore.Keys) { $intentValue[$key]=$intentCore[$key] }
        $intentValue.intentDigest = Get-NebulaPrivateObjectSha256 -Value $intentCore
        [void](Assert-NebulaPluginBorrowedLeaseBoundary -LeaseContext $leaseContext)
        [void](Write-NebulaPluginJsonNew -Path $layout.intentPath -Value $intentValue -AllowedRoot $layout.stateRoot)
        $intent = Read-NebulaPluginIntent -Path $layout.intentPath
        try {
            Test-NebulaPluginFault -Configured $TestFailurePoint -Point 'AfterIntent' -Backend $Backend
            Test-NebulaPluginFault -Configured $TestCrashPoint -Point 'AfterIntent' -Backend $Backend -Crash
            if ($TestAdversaryAction -ceq 'StageContentTamperAfterIntent') {
                [IO.File]::AppendAllText((Join-Path $layout.stageRoot 'nebula-NebulaMultiplayerMod\README.md'),'tamper')
            }
            elseif ($TestAdversaryAction -ceq 'StageIdentitySwapAfterIntent') {
                $displaced = $layout.stageRoot + '.displaced'
                [IO.Directory]::Move($layout.stageRoot, $displaced)
                [void](Copy-NebulaPluginCandidateToStage -CandidateRoot $candidate.candidateRoot `
                    -StageRoot $layout.stageRoot -TargetBindingDigest ([string]$plan.target.targetBindingDigest))
            }
            elseif ($TestAdversaryAction -ceq 'LeaseLossAfterIntent') {
                # Shadow-only adversarial seam: invalidate only the in-memory borrowed
                # credential after the durable intent.  The next mutation boundary must
                # re-borrow and fail closed; no token is persisted or printed.
                $leaseContext.token = ('_' * 43)
            }
            if ($TestDelayAfterIntentMilliseconds -gt 0) {
                Start-Sleep -Milliseconds $TestDelayAfterIntentMilliseconds
            }
            Assert-ApplyMutationBoundary -Layout $layout -Plan $plan -Intent $intent -LeaseContext $leaseContext `
                -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
            Assert-NebulaPluginTreeUnlocked -Root $layout.pluginsRoot
            [void](Assert-NebulaPluginBoundTree -Path $layout.pluginsRoot -ExpectedInventory $preimage `
                -ExpectedIdentity $intent.preimageDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_PREIMAGE_CHANGED')
            [void](Assert-NebulaPluginBoundTree -Path $layout.stageRoot -ExpectedInventory $stageInventory `
                -ExpectedIdentity $intent.candidateDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_STAGE_CHANGED_AFTER_INTENT')
            if (Test-Path -LiteralPath $layout.quarantineRoot) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_REQUEST_STATE_ALREADY_EXISTS'
            }
            Move-NebulaPluginDirectory -Source $layout.pluginsRoot -Destination $layout.quarantineRoot
            Test-NebulaPluginFault -Configured $TestFailurePoint -Point 'AfterQuarantineMove' -Backend $Backend
            Test-NebulaPluginFault -Configured $TestCrashPoint -Point 'AfterQuarantineMove' -Backend $Backend -Crash
            if ($TestAdversaryAction -ceq 'StageContentTamperAfterQuarantineMove') {
                [IO.File]::AppendAllText((Join-Path $layout.stageRoot 'nebula-NebulaMultiplayerMod\README.md'),'tamper')
            }
            Assert-ApplyMutationBoundary -Layout $layout -Plan $plan -Intent $intent -LeaseContext $leaseContext `
                -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
            [void](Assert-NebulaPluginBoundTree -Path $layout.stageRoot -ExpectedInventory $stageInventory `
                -ExpectedIdentity $intent.candidateDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_STAGE_CHANGED_AFTER_INTENT')
            [void](Assert-NebulaPluginBoundTree -Path $layout.quarantineRoot -ExpectedInventory $preimage `
                -ExpectedIdentity $intent.preimageDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_PREIMAGE_CHANGED')
            Move-NebulaPluginDirectory -Source $layout.stageRoot -Destination $layout.pluginsRoot
            Test-NebulaPluginFault -Configured $TestFailurePoint -Point 'AfterActivateMove' -Backend $Backend
            Test-NebulaPluginFault -Configured $TestCrashPoint -Point 'AfterActivateMove' -Backend $Backend -Crash
            [void](Assert-NebulaPluginBoundTree -Path $layout.pluginsRoot -ExpectedInventory $stageInventory `
                -ExpectedIdentity $intent.candidateDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_ACTIVE_VERIFY_FAILED')
            [void](Assert-NebulaPluginBoundTree -Path $layout.quarantineRoot -ExpectedInventory $preimage `
                -ExpectedIdentity $intent.preimageDirectoryIdentity `
                -TargetBindingDigest ([string]$plan.target.targetBindingDigest) -MismatchCode 'NEBULA_PLUGIN_QUARANTINE_VERIFY_FAILED')
            Test-NebulaPluginFault -Configured $TestFailurePoint -Point 'BeforeReceipt' -Backend $Backend
            Test-NebulaPluginFault -Configured $TestCrashPoint -Point 'BeforeReceipt' -Backend $Backend -Crash
            Assert-ApplyMutationBoundary -Layout $layout -Plan $plan -Intent $intent -LeaseContext $leaseContext `
                -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
            $receipt = New-ApplyReceipt -Plan $plan -Intent $intent -Preimage $preimage `
                -StageInventory $stageInventory -Status applied -ActiveTreeSha256 ([string]$plan.candidate.treeSha256)
            [void](Write-NebulaPluginJsonNew -Path $layout.receiptPath -Value $receipt -AllowedRoot $layout.stateRoot)
        }
        catch {
            if ((Get-NebulaPrivateErrorCode -Exception $_.Exception) -ceq 'NEBULA_PLUGIN_SIMULATED_CRASH') { throw }
            try {
                [void](Invoke-ApplyCompensation -Layout $layout -Plan $plan -Intent $intent -Preimage $preimage `
                    -StageInventory $stageInventory -Status 'rolled-back-automatic' -LeaseContext $leaseContext `
                    -TargetRole $TargetRole -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath)
            }
            catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_COMPENSATION_FAILED' }
            Throw-NebulaPluginError 'NEBULA_PLUGIN_APPLY_FAILED_ROLLED_BACK'
        }
        [pscustomobject][ordered]@{
            protocol=$script:NebulaPluginReceiptProtocol; status='applied'; requestId=$RequestId
            targetRole=$TargetRole; receiptDigest=[string]$receipt.receiptDigest
            quarantineRetained=$true; reused=$false
        } | ConvertTo-Json -Compress
    }
    finally { $lock.Dispose() }
}
catch {
    [Console]::Error.WriteLine((Get-NebulaPrivateErrorCode -Exception $_.Exception))
    exit 1
}
