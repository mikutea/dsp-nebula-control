[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$')]
    [string]$DeploymentVersion,
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')]
    [string]$SnapshotId,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')

$contract = Get-DysonConfigurationContract
$dataFull = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
$dataDirectory = Assert-DysonConfigurationPlainDirectoryChain (Join-Path $dataFull 'data')
$scriptFull = Assert-DysonConfigurationPlainDirectoryChain $ScriptRoot
$runtimeFull = Assert-DysonConfigurationPlainDirectoryChain $RuntimeBootstrapRoot
$serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
[void](Assert-DysonConfigurationParentAcl -Path $dataFull -ServiceSid $serviceSid)
$bindings = @{
    NODE_ENV = 'production'
    DYSON_HOST = '127.0.0.1'
    DYSON_DATA_DIR = $dataDirectory
    DYSON_SCRIPT_ROOT = $scriptFull
    DYSON_RUNTIME_BOOTSTRAP_ROOT = $runtimeFull
    DYSON_DEPLOYMENT_VERSION = $DeploymentVersion
}
Assert-DysonConfigurationExpectedBindings -Contract $contract `
    -ExpectedLauncherBindings $bindings
$storage = Get-DysonConfigurationStoragePaths -DataRoot $dataFull
foreach ($directory in @(
        $storage.configRoot, $storage.transactionRoot, $storage.intentsRoot,
        $storage.receiptsRoot, $storage.snapshotRoot
    )) {
    [void](Assert-DysonConfigurationPlainDirectoryChain $directory)
}
$configuration = Read-DysonControlEnvironmentFile -Path $storage.configurationPath `
    -Contract $contract -ExpectedLauncherBindings $bindings -SkipSourceAcl
[void](Assert-DysonConfigurationAcl -Path $storage.configurationPath `
    -Kind ConfigFile -ServiceSid $serviceSid)
$transactionState = Get-DysonConfigurationTransactionState -Storage $storage `
    -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings
if (-not $transactionState.clean) { throw 'DYSON_CONFIGURATION_TRANSACTION_NOT_CLEAN' }
$existingSnapshotCount = Assert-DysonConfigurationSnapshotInventory -Storage $storage `
    -Contract $contract -ServiceSid $serviceSid

if ($WhatIfPreference) {
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_SNAPSHOT_RESULT_V1'
        mode = 'what-if'
        configurationSha256 = [string]$configuration.sha256
        configurationLength = [int64]$configuration.length
        contractSha256 = [string]$contract.sha256
        bindingsSha256 = [string]$configuration.bindingsSha256
        completedTransactionCount = [int]$transactionState.receipts.Count
        existingSnapshotCount = [int]$existingSnapshotCount
        mutationPerformed = $false
    }
    return
}

if (-not $PSCmdlet.ShouldProcess($dataFull, 'Create protected preimage configuration snapshot')) {
    return
}

$lock = Enter-DysonConfigurationMutationLock -Storage $storage `
    -TimeoutSeconds $LockTimeoutSeconds
try {
    $underLock = Get-DysonConfigurationTransactionState -Storage $storage `
        -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings -LockHeld
    if (-not $underLock.clean -or
        [string]$underLock.chainHeadSha256 -cne [string]$transactionState.chainHeadSha256) {
        throw 'DYSON_CONFIGURATION_TRANSACTION_CHANGED'
    }
    $before = Get-DysonConfigurationFileEvidence -Path $storage.configurationPath `
        -ServiceSid $serviceSid
    if ([string]$before.sha256 -cne [string]$configuration.sha256 -or
        [int64]$before.length -ne [int64]$configuration.length) {
        throw 'DYSON_CONFIGURATION_TARGET_CHANGED'
    }
    $parameters = @{
        Storage = $storage
        Contract = $contract
        ExpectedLauncherBindings = $bindings
        ServiceSid = $serviceSid
    }
    if (-not [string]::IsNullOrWhiteSpace($SnapshotId)) {
        $parameters.SnapshotId = $SnapshotId
    }
    $snapshot = New-DysonConfigurationProtectedSnapshot @parameters
    $after = Get-DysonConfigurationFileEvidence -Path $storage.configurationPath `
        -ServiceSid $serviceSid
    if ([string]$after.sha256 -cne [string]$before.sha256 -or
        [int64]$after.length -ne [int64]$before.length -or
        [string]$after.aclFingerprint -cne [string]$before.aclFingerprint) {
        throw 'DYSON_CONFIGURATION_TARGET_CHANGED'
    }
}
finally { $lock.Dispose() }

[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_SNAPSHOT_RESULT_V1'
    mode = 'apply'
    state = 'created'
    snapshotId = [string]$snapshot.snapshotId
    snapshotPath = [string]$snapshot.snapshotPath
    snapshotPathSha256 = [string]$snapshot.snapshotPathSha256
    configurationSha256 = [string]$snapshot.configurationSha256
    configurationLength = [int64]$snapshot.configurationLength
    configurationAclFingerprint = [string]$snapshot.configurationAclFingerprint
    manifestSha256 = [string]$snapshot.manifestSha256
    bindingsSha256 = [string]$snapshot.bindingsSha256
    contractSha256 = [string]$contract.sha256
    mutationPerformed = $true
}
