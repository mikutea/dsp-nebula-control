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
    [Parameter(Mandatory)][string]$RequestId,
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
    $requestIdNormalized = Assert-DysonGsRemovalGuid $RequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $snapshotDigest = Assert-DysonGsRemovalDigest $SnapshotManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $protectionDigest = Assert-DysonGsRemovalDigest $PairedSaveProtectionManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $inventoryRevision = Assert-DysonGsRemovalDigest $AuthorityInventoryRevision 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $context = Initialize-DysonGsRemovalContext -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot `
        -DataRoot $DataRoot -TaskName $TaskName -ProfileFile $ProfileFile `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
        -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $inventoryRevision `
        -RequestId $requestIdNormalized -Backend $Backend -ShadowRoot $ShadowRoot -GsManagerMayBeMissing
    $fingerprint = Get-DysonGsRemovalRequestFingerprint -Operation remove -Layout $context.layout `
        -TaskName $TaskName -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -AuthorityInventoryRevision $inventoryRevision -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest

    if ($WhatIfPreference) {
        if ($Recover) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ARGUMENT_CONFLICT' }
        [void](Get-DysonGsRemovalValidatedPreimage -Context $context -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $snapshotDigest -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
            -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName `
            -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot)
        [pscustomobject][ordered]@{
            protocol = $script:DysonGsRemovalProtocol
            status = 'preview'
            dryRun = $true
            requestId = $requestIdNormalized
            requestFingerprint = $fingerprint
            productionChanged = $false
        } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    if ($ConfirmationToken -cne 'REMOVE_GSMANAGER_INSTALLATION') {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CONFIRMATION_REQUIRED'
    }
    if ($Backend -ceq 'Windows' -and -not (Test-DysonGsAdministrator)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ADMIN_REQUIRED'
    }
    if (-not $PSCmdlet.ShouldProcess('fixed GSManager installation', 'move to private recovery guard and unregister disabled task')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CONFIRMATION_REQUIRED'
    }
    Invoke-DysonGsManagerRemovalCore -Context $context -RemovalRequestId $requestIdNormalized `
        -RequestFingerprint $fingerprint -SnapshotId $SnapshotId -SnapshotManifestSha256 $snapshotDigest `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $protectionDigest -TaskName $TaskName `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot -Recover:$Recover |
        ConvertTo-Json -Depth 8 -Compress
}
catch {
    [Console]::Error.WriteLine((Get-DysonGsRemovalErrorCode $_.Exception))
    exit 1
}
