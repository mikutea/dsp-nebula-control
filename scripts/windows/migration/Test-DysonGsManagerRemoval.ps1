[CmdletBinding()]
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
    [string]$RestoreRequestId,
    [string]$RestoreReceiptSha256,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot '..\DysonHostMutationLease.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')
. (Join-Path $PSScriptRoot '..\cutover\DysonCutoverHost.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonGsManagerRemoval.Common.ps1')

try {
    $removalId = Assert-DysonGsRemovalGuid $RemovalRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    if ([string]::IsNullOrWhiteSpace($RestoreRequestId) -ne [string]::IsNullOrWhiteSpace($RestoreReceiptSha256)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ARGUMENT_CONFLICT'
    }
    $snapshotDigest = Assert-DysonGsRemovalDigest $SnapshotManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $protectionDigest = Assert-DysonGsRemovalDigest $PairedSaveProtectionManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $inventoryRevision = Assert-DysonGsRemovalDigest $AuthorityInventoryRevision 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $removalReceiptDigest = Assert-DysonGsRemovalDigest $RemovalReceiptSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $context = Initialize-DysonGsRemovalContext -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot `
        -DataRoot $DataRoot -TaskName $TaskName -ProfileFile $ProfileFile `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
        -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $inventoryRevision `
        -RequestId $removalId -Backend $Backend -ShadowRoot $ShadowRoot -GsManagerMayBeMissing
    [void](Assert-DysonGsRemovalNoOwnPending -DataRoot $context.layout.dataRoot)
    Assert-DysonGsRemovalNoPendingTransactions -DataRoot $context.layout.dataRoot `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
    $removalFingerprint = Get-DysonGsRemovalRequestFingerprint -Operation remove -Layout $context.layout `
        -TaskName $TaskName -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -AuthorityInventoryRevision $inventoryRevision -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest
    $storage = Get-DysonGsRemovalStorage -DataRoot $context.layout.dataRoot
    $paths = Get-DysonGsRemovalPaths -Storage $storage -RemovalRequestId $removalId -RestoreRequestId $RestoreRequestId
    $removalReceipt = Read-DysonGsRemovalReceipt -Path $paths.receipt -ExpectedSha256 $removalReceiptDigest
    Assert-DysonGsRemovalReceiptBinding -Receipt $removalReceipt -RequestId $removalId `
        -RequestFingerprint $removalFingerprint -SnapshotId $SnapshotId `
        -SnapshotManifestSha256 $snapshotDigest -AuthorityInventoryRevision $inventoryRevision -ExpectedStatus removed
    [void](Assert-DysonGsRemovalAuditBinding $storage remove $removalReceipt)
    $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
        -ExpectedGuardId ([string]$removalReceipt.value.guardId) `
        -ExpectedManifestSha256 ([string]$removalReceipt.value.guardManifestSha256) `
        -RootMayBeRestored:([bool](-not [string]::IsNullOrWhiteSpace($RestoreRequestId)))
    Assert-DysonGsRemovalGuardBinding -Guard $guard -Layout $context.layout -Profile $context.profile `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName
    [void](Get-DysonGsRemovalSnapshotVerification -Layout $context.layout -DataRoot $context.layout.dataRoot `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName `
        -Profile $context.profile -GsManagerMayBeMissing)

    $status = 'removed'
    $restoreReceiptDigest = $null
    if (-not [string]::IsNullOrWhiteSpace($RestoreRequestId)) {
        $restoreId = Assert-DysonGsRemovalGuid $RestoreRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        $expectedRestoreSha = Assert-DysonGsRemovalDigest $RestoreReceiptSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        $restoreFingerprint = Get-DysonGsRemovalRequestFingerprint -Operation restore -Layout $context.layout `
            -TaskName $TaskName -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
            -AuthorityInventoryRevision $inventoryRevision -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
            -PairedSaveProtectionManifestSha256 $protectionDigest -RemovalReceiptSha256 $removalReceiptDigest
        $restoreReceipt = Read-DysonGsRemovalRestoreReceipt -Path $paths.restoreReceipt -ExpectedSha256 $expectedRestoreSha
        Assert-DysonGsRemovalRestoreReceiptBinding -Receipt $restoreReceipt -RestoreRequestId $restoreId `
            -RemovalRequestId $removalId -RequestFingerprint $restoreFingerprint `
            -RemovalReceiptSha256 $removalReceiptDigest -GuardManifestSha256 ([string]$guard.manifestSha256) `
            -ExpectedStatus 'restored-disabled'
        [void](Assert-DysonGsRemovalAuditBinding $storage restore $restoreReceipt)
        Assert-DysonGsRemovalRestoredTerminal -Layout $context.layout -Profile $context.profile -Guard $guard
        $status = 'restored-disabled'
        $restoreReceiptDigest = [string]$restoreReceipt.sha256
    }
    else {
        $candidateStart = Get-CutoverHostTaskImage -TaskName $script:CutoverHostCandidateStartTask
        Assert-DysonGsRemovalRemovedTerminal -Layout $context.layout -Profile $context.profile -Guard $guard `
            -CandidateQuiesced:(-not [bool]$candidateStart.enabled)
    }

    [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalInspectionProtocol
        schemaVersion = 1
        status = $status
        removalRequestId = $removalId
        removalReceiptSha256 = [string]$removalReceipt.sha256
        restoreReceiptSha256 = $restoreReceiptDigest
        guardManifestSha256 = [string]$guard.manifestSha256
        activationRequired = ($status -ceq 'restored-disabled')
        verified = $true
    } | ConvertTo-Json -Depth 8 -Compress
}
catch {
    [Console]::Error.WriteLine((Get-DysonGsRemovalErrorCode $_.Exception))
    exit 1
}
