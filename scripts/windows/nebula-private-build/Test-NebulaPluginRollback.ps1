[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OriginalRequestId,
    [Parameter(Mandatory)][string]$RollbackRequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$GameRoot,
    [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
    [Parameter(Mandatory)][string]$OriginalPlanPath,
    [ValidateSet('Windows','Shadow')][string]$Backend = 'Windows'
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

try {
    $jobRoot=Assert-NebulaPrivateJobRoot (Join-Path $JobBase $OriginalRequestId) $JobBase $OriginalRequestId
    $original=Get-NebulaPluginLayout $GameRoot $OriginalRequestId $Backend
    $rollback=Get-NebulaPluginLayout $GameRoot $RollbackRequestId $Backend
    $plan=Read-NebulaPluginPlan $OriginalPlanPath $jobRoot $OriginalRequestId $GameRoot $TargetRole $Backend
    $originalReceipt=Assert-NebulaPluginReceipt (Read-NebulaPluginJson $original.receiptPath)
    $rollbackIntent=Read-NebulaPluginIntent $rollback.intentPath
    $rollbackReceipt=Assert-NebulaPluginReceipt (Read-NebulaPluginJson $rollback.receiptPath)
    $preimage=Read-NebulaPluginJson (Join-Path $jobRoot 'evidence\plugin-cutover-preimage-inventory.json')
    [void](Assert-NebulaPluginInventoryValue $preimage 'NEBULA_PLUGIN_PREIMAGE_INVENTORY_INVALID')
    $originalIntent=Read-NebulaPluginIntent $original.intentPath
    $candidateInventory=$originalIntent.stageInventory
    [void](Assert-NebulaPluginApplyIntentContext $originalIntent $plan $preimage $original `
        'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    [void](Assert-NebulaPluginReceiptMatchesIntent $originalReceipt $originalIntent `
        'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    [void](Assert-NebulaPluginReceiptMatchesIntent $rollbackReceipt $rollbackIntent `
        'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID')
    if ([string]$originalIntent.operation -cne 'apply' -or
        [string]$originalIntent.planDigest -cne [string]$plan.planDigest -or
        [string]$originalIntent.targetRole -cne $TargetRole -or
        [string]$originalIntent.physicalTargetDigest -cne [string]$plan.target.physicalTargetDigest -or
        [string]$rollbackIntent.operation -cne 'rollback' -or
        [string]$rollbackIntent.requestId -cne $RollbackRequestId -or
        [string]$rollbackIntent.originalRequestId -cne $OriginalRequestId -or
        [string]$rollbackIntent.originalReceiptDigest -cne [string]$originalReceipt.receiptDigest -or
        [string]$rollbackIntent.targetRole -cne $TargetRole -or
        [string]$rollbackIntent.targetBindingDigest -cne [string]$plan.target.targetBindingDigest -or
        [string]$rollbackIntent.physicalTargetDigest -cne [string]$plan.target.physicalTargetDigest -or
        [string]$rollbackIntent.planDigest -cne [string]$plan.planDigest -or
        [string]$rollbackIntent.candidateManifestDigest -cne [string]$plan.candidate.manifestDigest -or
        [string]$rollbackIntent.candidateTreeSha256 -cne [string]$plan.candidate.treeSha256 -or
        [string]$rollbackIntent.preimageInventoryDigest -cne [string]$preimage.inventoryDigest -or
        [string]$rollbackIntent.preimageTreeSha256 -cne [string]$preimage.contentTreeSha256 -or
        [string]$rollbackIntent.preimageAclDigest -cne [string]$preimage.aclDigest -or
        [string]$rollbackIntent.stageInventory.inventoryDigest -cne [string]$candidateInventory.inventoryDigest -or
        [string]$rollbackIntent.bepInExBoundary.boundaryDigest -cne
            [string]$originalIntent.bepInExBoundary.boundaryDigest -or
        [string]$rollbackIntent.preimageDirectoryIdentity.identityDigest -cne
            [string]$originalIntent.preimageDirectoryIdentity.identityDigest -or
        [string]$rollbackIntent.candidateDirectoryIdentity.identityDigest -cne
            [string]$originalIntent.candidateDirectoryIdentity.identityDigest -or
        [string]$rollbackIntent.stageLeaf -cne [IO.Path]::GetFileName([string]$rollback.stageRoot) -or
        [string]$rollbackIntent.quarantineLeaf -cne [IO.Path]::GetFileName([string]$original.quarantineRoot) -or
        [string]$rollbackReceipt.previousReceiptDigest -cne [string]$originalReceipt.receiptDigest -or
        [string]$rollbackReceipt.targetBindingDigest -cne [string]$plan.target.targetBindingDigest -or
        [string]$rollbackReceipt.physicalTargetDigest -cne [string]$plan.target.physicalTargetDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ROLLBACK_TERMINAL_BINDING_INVALID'
    }
    $state = Assert-NebulaPluginRootPendingIntentGate -Layout $rollback `
        -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest)
    if ([string]$state.chainHead -cne [string]$rollbackReceipt.receiptDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
    }
    [void](Assert-NebulaPluginReceiptTerminalState -Receipt $rollbackReceipt -Intent $rollbackIntent `
        -PreimageInventory $preimage -ActiveRoot $original.pluginsRoot -CandidateStageRoot $rollback.stageRoot `
        -PreimageQuarantineRoot $original.quarantineRoot -BepInExRoot $original.bepInExRoot `
        -Code 'NEBULA_PLUGIN_ROLLBACK_VERIFY_FAILED')
    [pscustomobject][ordered]@{
        protocol=$script:NebulaPluginReceiptProtocol; status='verified'; operation='rollback'
        originalRequestId=$OriginalRequestId; rollbackRequestId=$RollbackRequestId
        transactionStatus=[string]$rollbackReceipt.status; receiptDigest=[string]$rollbackReceipt.receiptDigest
        contentAndAclExact=$true; rollbackMaterialRetained=$true
    } | ConvertTo-Json -Compress
}
catch { [Console]::Error.WriteLine((Get-NebulaPrivateErrorCode $_.Exception)); exit 1 }
