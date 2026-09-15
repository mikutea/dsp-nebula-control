[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ConfigurationSource,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$')][string]$DeploymentVersion,
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [string]$ProtectedPreimageSnapshotPath,
    [ValidateSet('Auto', 'Abort')][string]$RecoveryAction = 'Auto',
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')

function New-ExpectedLauncherBindings {
    param(
        [Parameter(Mandatory)][string]$ResolvedDataDirectory,
        [Parameter(Mandatory)][string]$ResolvedScriptRoot,
        [Parameter(Mandatory)][string]$ResolvedRuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$Version
    )

    return @{
        NODE_ENV = 'production'
        DYSON_HOST = '127.0.0.1'
        DYSON_DATA_DIR = $ResolvedDataDirectory
        DYSON_SCRIPT_ROOT = $ResolvedScriptRoot
        DYSON_RUNTIME_BOOTSTRAP_ROOT = $ResolvedRuntimeBootstrapRoot
        DYSON_DEPLOYMENT_VERSION = $Version
    }
}

$contract = Get-DysonConfigurationContract
$resolvedDataRoot = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
$resolvedDataDirectory = Assert-DysonConfigurationPlainDirectoryChain (Join-Path $resolvedDataRoot 'data')
$resolvedScriptRoot = Assert-DysonConfigurationPlainDirectoryChain $ScriptRoot
$resolvedRuntimeBootstrapRoot = Assert-DysonConfigurationPlainDirectoryChain $RuntimeBootstrapRoot
$serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
$dataRootAcl = Assert-DysonConfigurationParentAcl -Path $resolvedDataRoot -ServiceSid $serviceSid
$bindings = New-ExpectedLauncherBindings -ResolvedDataDirectory $resolvedDataDirectory `
    -ResolvedScriptRoot $resolvedScriptRoot `
    -ResolvedRuntimeBootstrapRoot $resolvedRuntimeBootstrapRoot -Version $DeploymentVersion
$source = Read-DysonControlEnvironmentFile -Path $ConfigurationSource -Contract $contract `
    -ExpectedLauncherBindings $bindings
$sourcePathSha256 = Get-DysonConfigurationPathBindingSha256 $ConfigurationSource
$storageView = Get-DysonConfigurationStoragePaths -DataRoot $resolvedDataRoot
$preimageSnapshot = $null
if (-not [string]::IsNullOrWhiteSpace($ProtectedPreimageSnapshotPath)) {
    $preimageSnapshot = Read-DysonConfigurationSnapshotInternal `
        -SnapshotPath $ProtectedPreimageSnapshotPath -Contract $contract `
        -ServiceSid $serviceSid -ExpectedDataRoot $resolvedDataRoot
}

function Get-RequestedOperation {
    param([Parameter(Mandatory)]$Storage)
    if (-not (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf)) { return 'create' }
    $target = Get-DysonConfigurationFileEvidence -Path $Storage.configurationPath -ServiceSid $serviceSid
    if ([string]$target.sha256 -ceq [string]$source.sha256 -and
        [int64]$target.length -eq [int64]$source.length) {
        [void](Read-DysonControlEnvironmentFile -Path $Storage.configurationPath `
            -Contract $contract -ExpectedLauncherBindings $bindings -SkipSourceAcl)
        return 'reuse'
    }
    if ($null -eq $preimageSnapshot -or
        [string]$target.sha256 -cne [string]$preimageSnapshot.configurationSha256 -or
        [int64]$target.length -ne [int64]$preimageSnapshot.configurationLength -or
        [string]$target.aclFingerprint -cne [string]$preimageSnapshot.configurationAclFingerprint) {
        throw 'DYSON_CONFIGURATION_REPLACEMENT_REQUIRES_MATCHING_PROTECTED_SNAPSHOT'
    }
    return 'replace'
}

if ($WhatIfPreference) {
    $requiredStorage = @(
        $storageView.configRoot, $storageView.transactionRoot, $storageView.intentsRoot,
        $storageView.receiptsRoot, $storageView.snapshotRoot, $storageView.lockPath
    )
    $presentCount = @($requiredStorage | Where-Object { Test-Path -LiteralPath $_ }).Count
    if ($presentCount -ne 0 -and $presentCount -ne $requiredStorage.Count) {
        throw 'DYSON_CONFIGURATION_PARTIAL_STORAGE_INVALID'
    }
    $operation = if ($presentCount -eq 0) { 'create' } else { Get-RequestedOperation $storageView }
    $recoveryState = 'new-storage'
    if ($presentCount -eq $requiredStorage.Count) {
        $recovery = Get-DysonConfigurationRecoveryPlan -Storage $storageView `
            -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings `
            -ExpectedPreimageSnapshot $preimageSnapshot
        $recoveryState = [string]$recovery.state
        if ($recoveryState -cne 'clean') {
            $state = Get-DysonConfigurationTransactionState -Storage $storageView `
                -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings `
                -ExpectedPreimageSnapshot $preimageSnapshot
            $operation = [string]$state.pending[0].record.operation
        }
    }
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_INSTALL_RESULT_V1'
        mode = 'what-if'
        operation = $operation
        targetState = if ($operation -ceq 'create') { 'absent' }
            elseif ($operation -ceq 'reuse') { 'identical' } else { 'different-protected' }
        recoveryState = $recoveryState
        sourceSha256 = [string]$source.sha256
        sourceLength = [int64]$source.length
        contractSha256 = [string]$contract.sha256
        bindingsSha256 = [string]$source.bindingsSha256
        parentAclFingerprint = [string]$dataRootAcl.fingerprint
        preimageSnapshotId = if ($preimageSnapshot) { [string]$preimageSnapshot.snapshotId } else { $null }
        mutationPerformed = $false
    }
    return
}

if (-not $PSCmdlet.ShouldProcess($resolvedDataRoot, 'Install or replace protected Dyson Control configuration')) {
    return
}

$storage = Initialize-DysonConfigurationStorage -DataRoot $resolvedDataRoot -ServiceSid $serviceSid
$pendingState = Get-DysonConfigurationTransactionState -Storage $storage `
    -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings `
    -ExpectedPreimageSnapshot $preimageSnapshot
$operation = if ($pendingState.pending.Count -eq 1) {
    [string]$pendingState.pending[0].record.operation
} else { Get-RequestedOperation $storage }
if ($operation -notin @('create', 'reuse', 'replace')) {
    throw 'DYSON_CONFIGURATION_PENDING_OPERATION_INVALID'
}
$transaction = Invoke-DysonConfigurationMutationTransaction -Storage $storage `
    -Source $source -Contract $contract -ExpectedLauncherBindings $bindings `
    -ServiceSid $serviceSid -Operation $operation -SourceKind configuration-source `
    -SourcePathSha256 $sourcePathSha256 -PreimageSnapshot $preimageSnapshot `
    -RecoveryAction $RecoveryAction -LockTimeoutSeconds $LockTimeoutSeconds

[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_INSTALL_RESULT_V1'
    mode = 'apply'
    state = [string]$transaction.state
    operation = [string]$transaction.operation
    transactionId = [string]$transaction.transactionId
    sequence = [int64]$transaction.sequence
    configurationSha256 = [string]$transaction.configurationSha256
    configurationLength = [int64]$transaction.configurationLength
    contractSha256 = [string]$contract.sha256
    bindingsSha256 = [string]$source.bindingsSha256
    aclFingerprint = [string]$transaction.configurationAclFingerprint
    parentAclFingerprint = [string]$dataRootAcl.fingerprint
    preimageSnapshotId = if ($preimageSnapshot) { [string]$preimageSnapshot.snapshotId } else { $null }
    chainHeadSha256 = [string]$transaction.chainHeadSha256
    completedTransactionCount = [int]$transaction.completedTransactionCount
    mutationPerformed = $true
}
