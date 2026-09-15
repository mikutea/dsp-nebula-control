[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RecoveryRoot,
    [Parameter(Mandatory)][string]$BundleId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [string]$ExpectedDataRootIdentity
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonDataRootRecovery.Common.ps1')

$root = Assert-DysonDataRootRecoveryPlainDirectory $RecoveryRoot
$id = Assert-DysonDataRootRecoveryGuid $BundleId
$bundle = Test-DysonDataRootRecoveryBundleCore (Join-Path (Join-Path $root 'bundles') $id) `
    $ExpectedManifestSha256 $ExpectedDataRootIdentity recovery
[pscustomobject][ordered]@{
    protocol = $script:DysonDataRootRecoveryBundleProtocol
    schemaVersion = 1
    valid = $true
    bundleId = [string]$bundle.manifest.bundleId
    dataRootIdentity = [string]$bundle.manifest.dataRootIdentity
    manifestSha256 = [string]$bundle.manifestSha256
    inventorySha256 = [string]$bundle.manifest.inventorySha256
    fileCount = [int64]$bundle.manifest.fileCount
    directoryCount = [int64]$bundle.manifest.directoryCount
    totalBytes = [int64]$bundle.manifest.totalBytes
} | ConvertTo-Json -Depth 8 -Compress
