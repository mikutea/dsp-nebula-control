[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SnapshotId,
    [Parameter(Mandatory)][string]$ExpectedSnapshotManifestSha256
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')

$normalizedId = Normalize-DysonGsSnapshotId -SnapshotId $SnapshotId
$snapshotRoot = Get-DysonGsSnapshotRoot -DataRoot $DataRoot -SnapshotId $normalizedId
$verified = Test-DysonGsSnapshotCore -SnapshotRoot $snapshotRoot -ExpectedSnapshotId $normalizedId `
    -ExpectedManifestSha256 $ExpectedSnapshotManifestSha256
[ordered]@{
    protocol = $script:DysonGsMigrationProtocol
    state = 'verified'
    snapshotId = $normalizedId
    snapshotManifestSha256 = $verified.manifestSha256
    fileCount = $verified.gsManagerInventory.fileCount
    totalBytes = $verified.gsManagerInventory.totalBytes
    treeSha256 = $verified.gsManagerInventory.treeSha256
    payloadSha256 = [string]$verified.manifest.payloadSha256
    taskStatus = if ([bool]$verified.taskCapture.present) { 'captured' } else { 'absent' }
    pairedSaveProtectionPointId = [string]$verified.manifest.pairedSaveProtection.id
    pairedSaveProtectionManifestSha256 = [string]$verified.manifest.pairedSaveProtection.manifestSha256
    schemaStrict = $true
    productionChanged = $false
} | ConvertTo-DysonGsJsonLine
