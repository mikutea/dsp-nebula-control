[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ProtectedSnapshotPath,
    [Parameter(Mandatory)][string]$CurrentProtectedSnapshotPath,
    [Parameter(Mandatory)][string]$DataRoot,
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [ValidateSet('Auto', 'Abort')][string]$RecoveryAction = 'Auto',
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')

$contract = Get-DysonConfigurationContract
$dataFull = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
$serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
[void](Assert-DysonConfigurationParentAcl -Path $dataFull -ServiceSid $serviceSid)
$sourceSnapshot = Read-DysonConfigurationSnapshotInternal `
    -SnapshotPath $ProtectedSnapshotPath -Contract $contract -ServiceSid $serviceSid `
    -ExpectedDataRoot $dataFull -IncludePrivateBytes
$currentSnapshot = Read-DysonConfigurationSnapshotInternal `
    -SnapshotPath $CurrentProtectedSnapshotPath -Contract $contract -ServiceSid $serviceSid `
    -ExpectedDataRoot $dataFull
if ([string]$sourceSnapshot.snapshotId -ceq [string]$currentSnapshot.snapshotId -or
    [string]$sourceSnapshot.snapshotPathSha256 -ceq [string]$currentSnapshot.snapshotPathSha256) {
    throw 'DYSON_CONFIGURATION_RESTORE_SNAPSHOTS_MUST_BE_DISTINCT'
}
$bindings = [hashtable]$sourceSnapshot.privateBindings
$storage = Get-DysonConfigurationStoragePaths -DataRoot $dataFull
$state = Get-DysonConfigurationTransactionState -Storage $storage -ServiceSid $serviceSid `
    -Contract $contract -ExpectedLauncherBindings $bindings `
    -ExpectedPreimageSnapshot $currentSnapshot -ExpectedSourceSnapshot $sourceSnapshot
$recovery = Get-DysonConfigurationRecoveryPlan -Storage $storage -ServiceSid $serviceSid `
    -Contract $contract -ExpectedLauncherBindings $bindings `
    -ExpectedPreimageSnapshot $currentSnapshot -ExpectedSourceSnapshot $sourceSnapshot
$target = Get-DysonConfigurationFileEvidence -Path $storage.configurationPath `
    -ServiceSid $serviceSid
if ([string]$recovery.state -ceq 'clean' -and
    ([string]$target.sha256 -cne [string]$currentSnapshot.configurationSha256 -or
        [int64]$target.length -ne [int64]$currentSnapshot.configurationLength -or
        [string]$target.aclFingerprint -cne
            [string]$currentSnapshot.configurationAclFingerprint)) {
    throw 'DYSON_CONFIGURATION_RESTORE_PREIMAGE_MISMATCH'
}

if ($WhatIfPreference) {
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_RESTORE_RESULT_V1'
        mode = 'what-if'
        recoveryState = [string]$recovery.state
        sourceSnapshotId = [string]$sourceSnapshot.snapshotId
        preimageSnapshotId = [string]$currentSnapshot.snapshotId
        sourceConfigurationSha256 = [string]$sourceSnapshot.configurationSha256
        targetConfigurationSha256 = [string]$target.sha256
        sourceBindingsSha256 = [string]$sourceSnapshot.bindingsSha256
        contractSha256 = [string]$contract.sha256
        wouldReplace = [string]$target.sha256 -cne [string]$sourceSnapshot.configurationSha256
        mutationPerformed = $false
    }
    return
}

if (-not $PSCmdlet.ShouldProcess($dataFull, 'Atomically restore protected Dyson Control configuration snapshot')) {
    return
}

$source = [pscustomobject][ordered]@{
    sha256 = [string]$sourceSnapshot.configurationSha256
    length = [int64]$sourceSnapshot.configurationLength
    bindingsSha256 = [string]$sourceSnapshot.bindingsSha256
    privateBytes = [byte[]]$sourceSnapshot.privateBytes
}
$transaction = Invoke-DysonConfigurationMutationTransaction -Storage $storage `
    -Source $source -Contract $contract -ExpectedLauncherBindings $bindings `
    -ServiceSid $serviceSid -Operation restore -SourceKind protected-snapshot `
    -SourcePathSha256 ([string]$sourceSnapshot.payloadPathSha256) `
    -PreimageSnapshot $currentSnapshot -SourceSnapshot $sourceSnapshot `
    -RecoveryAction $RecoveryAction -LockTimeoutSeconds $LockTimeoutSeconds

[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_RESTORE_RESULT_V1'
    mode = 'apply'
    state = [string]$transaction.state
    operation = 'restore'
    transactionId = [string]$transaction.transactionId
    sequence = [int64]$transaction.sequence
    sourceSnapshotId = [string]$sourceSnapshot.snapshotId
    preimageSnapshotId = [string]$currentSnapshot.snapshotId
    configurationSha256 = [string]$transaction.configurationSha256
    configurationLength = [int64]$transaction.configurationLength
    configurationAclFingerprint = [string]$transaction.configurationAclFingerprint
    bindingsSha256 = [string]$sourceSnapshot.bindingsSha256
    contractSha256 = [string]$contract.sha256
    chainHeadSha256 = [string]$transaction.chainHeadSha256
    completedTransactionCount = [int]$transaction.completedTransactionCount
    mutationPerformed = $true
}
