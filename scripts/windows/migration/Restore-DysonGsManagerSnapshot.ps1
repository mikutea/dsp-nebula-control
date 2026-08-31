[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$GsManagerRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SnapshotId,
    [Parameter(Mandatory)][string]$ExpectedSnapshotManifestSha256,
    [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
    [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
    [Parameter(Mandatory)][string]$Confirmation,
    [string]$TaskName = 'Dyson-GSManager',
    [string]$DysonControlTaskName = 'Dyson-Control-Plane'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')

if (-not [string]::Equals($Confirmation, 'RESTORE_GSMANAGER_SNAPSHOT', [System.StringComparison]::Ordinal)) {
    throw 'Restore requires the exact RESTORE_GSMANAGER_SNAPSHOT confirmation token.'
}
Assert-DysonGsTaskName -TaskName $TaskName
Assert-DysonGsTaskName -TaskName $DysonControlTaskName
$normalizedId = Normalize-DysonGsSnapshotId -SnapshotId $SnapshotId
$expectedDigest = Normalize-DysonGsDigest -Digest $ExpectedSnapshotManifestSha256 -Name 'The snapshot manifest digest'
$layout = Resolve-DysonGsLayout -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot -DataRoot $DataRoot `
    -GsManagerMayBeMissing
$snapshotRoot = Get-DysonGsSnapshotRoot -DataRoot $layout.dataRoot -SnapshotId $normalizedId
$verified = Test-DysonGsSnapshotCore -SnapshotRoot $snapshotRoot -ExpectedSnapshotId $normalizedId -ExpectedManifestSha256 $expectedDigest
if ([string]$verified.manifest.projectBindingSha256 -cne (Get-DysonGsProjectBindingSha256 -ProjectRoot $layout.projectRoot) -or
    -not [string]::Equals([string]$verified.manifest.gsManagerRelativeRoot, [string]$layout.gsManagerRelativeRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals([string]$verified.manifest.taskName, $TaskName, [System.StringComparison]::Ordinal)) {
    throw 'The migration snapshot is bound to a different project, GSManager root, or task.'
}
$protection = Test-DysonGsProtectionPointBinding -ProjectRoot $layout.projectRoot `
    -ProtectionPointId $PairedSaveProtectionPointId -ManifestSha256 $PairedSaveProtectionManifestSha256
if ([string]$verified.manifest.pairedSaveProtection.id -cne $protection.protectionPointId -or
    [string]$verified.manifest.pairedSaveProtection.manifestSha256 -cne $protection.manifestSha256) {
    throw 'Restore protection-point binding does not match the snapshot.'
}
$disposition = Get-DysonGsRestoreDisposition -Layout $layout -SnapshotVerification $verified
$preview = [ordered]@{
    protocol = $script:DysonGsMigrationProtocol
    state = 'preview'
    dryRun = $true
    snapshotId = $normalizedId
    snapshotManifestSha256 = $verified.manifestSha256
    rootStatus = $disposition
    taskStatus = if ([bool]$verified.taskCapture.present) { 'restorable' } else { 'restore-absent' }
    pairedSaveProtectionPointId = $protection.protectionPointId
    pairedSaveProtectionManifestSha256 = $protection.manifestSha256
    restoreGuardPublished = $false
    gameStarted = $false
    gsManagerStarted = $false
    saveFilesTouched = $false
    productionChanged = $false
}
if ($WhatIfPreference -or -not $PSCmdlet.ShouldProcess($normalizedId, 'restore a verified GSManager snapshot with compensation guard')) {
    $preview | ConvertTo-DysonGsJsonLine
    exit 0
}
if (-not (Test-DysonGsAdministrator)) { throw 'GSManager restore requires an elevated Administrator PowerShell process.' }
Assert-DysonGsControlTaskStopped -TaskName $DysonControlTaskName
Assert-DysonGsExactProcessStopped -ProjectRoot $layout.projectRoot
$currentTask = Get-DysonGsTaskCapture -TaskName $TaskName -IncludeXml
Assert-DysonGsManagerTaskStopped -Capture $currentTask
$selectedProjectRoot = $layout.projectRoot
$selectedTaskName = $TaskName
$selectedControlTaskName = $DysonControlTaskName
$preMutationCheck = {
    param($expectedTaskCapture)
    Assert-DysonGsControlTaskStopped -TaskName $selectedControlTaskName
    Assert-DysonGsExactProcessStopped -ProjectRoot $selectedProjectRoot
    $latestTaskCapture = Get-DysonGsTaskCapture -TaskName $selectedTaskName -IncludeXml
    Assert-DysonGsManagerTaskStopped -Capture $latestTaskCapture
    if (-not (Test-DysonGsTaskCapturesEqual -Left $expectedTaskCapture -Right $latestTaskCapture)) {
        throw 'The GSManager scheduled task changed after its restore guard was prepared.'
    }
}.GetNewClosure()
$restored = Invoke-DysonGsRestoreCore -Layout $layout -SnapshotVerification $verified -DataRoot $layout.dataRoot `
    -Disposition $disposition -CurrentTaskCapture $currentTask -PreMutationCheck $preMutationCheck
[ordered]@{
    protocol = $script:DysonGsMigrationProtocol
    state = 'restored'
    dryRun = $false
    snapshotId = $normalizedId
    snapshotManifestSha256 = $verified.manifestSha256
    restoreGuardId = $restored.guardId
    rootStatus = if ([bool]$restored.rootChanged) { 'restored' } else { 'already-matched' }
    taskStatus = if ([bool]$verified.taskCapture.present) { 'restored' } else { 'restored-absent' }
    fileCount = $verified.gsManagerInventory.fileCount
    totalBytes = $verified.gsManagerInventory.totalBytes
    treeSha256 = $verified.gsManagerInventory.treeSha256
    pairedSaveProtectionPointId = $protection.protectionPointId
    pairedSaveProtectionManifestSha256 = $protection.manifestSha256
    restoreGuardPublished = $true
    gameStarted = $false
    gsManagerStarted = $false
    saveFilesTouched = $false
    productionChanged = $false
} | ConvertTo-DysonGsJsonLine
