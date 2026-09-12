[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$GsManagerRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SnapshotId,
    [Parameter(Mandatory)][string]$SnapshotManifestSha256,
    [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
    [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ProfileFile,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
    [Parameter(Mandatory)][string]$ServiceUser,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$GamePort,
    [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
    [Parameter(Mandatory)][string]$RemovalRequestId,
    [Parameter(Mandatory)][string]$RemovalReceiptSha256,
    [Parameter(Mandatory)][string]$RestoreRequestId,
    [string]$ConfirmationToken,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot,
    [switch]$Recover
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot '..\DysonHostMutationLease.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')
. (Join-Path $PSScriptRoot '..\cutover\DysonCutoverHost.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonGsManagerRemoval.Common.ps1')

try {
    $removalId = Assert-DysonGsRemovalGuid $RemovalRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $restoreId = Assert-DysonGsRemovalGuid $RestoreRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    if ($removalId -ceq $restoreId) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ARGUMENT_CONFLICT' }
    $snapshotDigest = Assert-DysonGsRemovalDigest $SnapshotManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $protectionDigest = Assert-DysonGsRemovalDigest $PairedSaveProtectionManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $inventoryRevision = Assert-DysonGsRemovalDigest $AuthorityInventoryRevision 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $removalReceiptDigest = Assert-DysonGsRemovalDigest $RemovalReceiptSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $context = Initialize-DysonGsRemovalContext -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot `
        -DataRoot $DataRoot -TaskName $TaskName -ProfileFile $ProfileFile `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
        -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $inventoryRevision `
        -RequestId $restoreId -Backend $Backend -ShadowRoot $ShadowRoot -GsManagerMayBeMissing
    $removalFingerprint = Get-DysonGsRemovalRequestFingerprint -Operation remove -Layout $context.layout `
        -TaskName $TaskName -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -AuthorityInventoryRevision $inventoryRevision -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest
    $restoreFingerprint = Get-DysonGsRemovalRequestFingerprint -Operation restore -Layout $context.layout `
        -TaskName $TaskName -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -AuthorityInventoryRevision $inventoryRevision -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest -RemovalReceiptSha256 $removalReceiptDigest

    if ($WhatIfPreference) {
        if ($Recover) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ARGUMENT_CONFLICT' }
        $storage = Get-DysonGsRemovalStorage -DataRoot $context.layout.dataRoot
        $paths = Get-DysonGsRemovalPaths -Storage $storage -RemovalRequestId $removalId -RestoreRequestId $restoreId
        $receipt = Read-DysonGsRemovalReceipt -Path $paths.receipt -ExpectedSha256 $removalReceiptDigest
        Assert-DysonGsRemovalReceiptBinding -Receipt $receipt -RequestId $removalId `
            -RequestFingerprint $removalFingerprint -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $snapshotDigest -AuthorityInventoryRevision $inventoryRevision -ExpectedStatus removed
        $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard -ExpectedGuardId ([string]$receipt.value.guardId) `
            -ExpectedManifestSha256 ([string]$receipt.value.guardManifestSha256)
        Assert-DysonGsRemovalGuardBinding -Guard $guard -Layout $context.layout -Profile $context.profile `
            -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
            -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
            -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName
        Assert-DysonGsRemovalNoPendingTransactions -DataRoot $context.layout.dataRoot `
            -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
        [void](Assert-DysonGsRemovalNoOwnPending -DataRoot $context.layout.dataRoot)
        Assert-DysonGsRemovalCandidateHealthy -Profile $context.profile -PreviousAbsent -CandidateQuiesced
        Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $context.layout.gsManagerRoot
        [pscustomobject][ordered]@{
            protocol = $script:DysonGsRemovalProtocol
            status = 'restore-preview'
            dryRun = $true
            removalRequestId = $removalId
            restoreRequestId = $restoreId
            requestFingerprint = $restoreFingerprint
            activationRequired = $true
            productionChanged = $false
        } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    if ($ConfirmationToken -cne 'RESTORE_GSMANAGER_REMOVAL') {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CONFIRMATION_REQUIRED'
    }
    if ($Backend -ceq 'Windows' -and -not (Test-DysonGsAdministrator)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ADMIN_REQUIRED'
    }
    if (-not $PSCmdlet.ShouldProcess('private GSManager recovery guard', 'restore disabled previous installation without activation')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CONFIRMATION_REQUIRED'
    }
    Invoke-DysonGsManagerRemovalRestoreCore -Context $context -RemovalRequestId $removalId `
        -RestoreRequestId $restoreId -RemovalRequestFingerprint $removalFingerprint `
        -RestoreRequestFingerprint $restoreFingerprint -RemovalReceiptSha256 $removalReceiptDigest `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot -Recover:$Recover |
        ConvertTo-Json -Depth 8 -Compress
}
catch {
    [Console]::Error.WriteLine((Get-DysonGsRemovalErrorCode $_.Exception))
    exit 1
}
