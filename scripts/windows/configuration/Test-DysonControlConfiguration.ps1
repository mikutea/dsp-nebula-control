[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$')][string]$DeploymentVersion,
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [string]$ProtectedSnapshotPath,
    [switch]$PlanSnapshotRestore,
    [switch]$RuntimeOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')

$contract = Get-DysonConfigurationContract
$resolvedDataRoot = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
$resolvedDataDirectory = Assert-DysonConfigurationPlainDirectoryChain (Join-Path $resolvedDataRoot 'data')
$resolvedScriptRoot = Assert-DysonConfigurationPlainDirectoryChain $ScriptRoot
$resolvedRuntimeBootstrapRoot = Assert-DysonConfigurationPlainDirectoryChain $RuntimeBootstrapRoot
$serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
$dataRootAcl = Assert-DysonConfigurationParentAcl -Path $resolvedDataRoot -ServiceSid $serviceSid
$bindings = @{
    NODE_ENV = 'production'
    DYSON_HOST = '127.0.0.1'
    DYSON_DATA_DIR = $resolvedDataDirectory
    DYSON_SCRIPT_ROOT = $resolvedScriptRoot
    DYSON_RUNTIME_BOOTSTRAP_ROOT = $resolvedRuntimeBootstrapRoot
    DYSON_DEPLOYMENT_VERSION = $DeploymentVersion
}
Assert-DysonConfigurationExpectedBindings -Contract $contract -ExpectedLauncherBindings $bindings

$storage = Get-DysonConfigurationStoragePaths -DataRoot $resolvedDataRoot
if ($RuntimeOnly) {
    if ($ProtectedSnapshotPath -or $PlanSnapshotRestore) { throw 'DYSON_CONFIGURATION_RUNTIME_RESTORE_FORBIDDEN' }
    Test-DysonConfigurationRuntimeApproval -Storage $storage -Contract $contract `
        -ExpectedLauncherBindings $bindings -ServiceSid $serviceSid -ParentAcl $dataRootAcl
    return
}
foreach ($directory in @(
        $storage.configRoot, $storage.transactionRoot, $storage.intentsRoot,
        $storage.receiptsRoot, $storage.snapshotRoot
    )) {
    [void](Assert-DysonConfigurationPlainDirectoryChain $directory)
}
[void](Assert-DysonConfigurationAcl -Path $storage.configRoot -Kind ConfigDirectory -ServiceSid $serviceSid)
foreach ($directory in @($storage.transactionRoot, $storage.intentsRoot, $storage.receiptsRoot)) {
    [void](Assert-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory)
}
[void](Assert-DysonConfigurationAcl -Path $storage.snapshotRoot -Kind PrivateDirectory)
$lockPath = Assert-DysonConfigurationPlainFilePath -Path $storage.lockPath -MaximumBytes 64
[void](Assert-DysonConfigurationAcl -Path $lockPath -Kind PrivateFile)
$healthLock = Enter-DysonConfigurationMutationLock -Storage $storage
try {
    $configuration = Read-DysonControlEnvironmentFile -Path $storage.configurationPath `
        -Contract $contract -ExpectedLauncherBindings $bindings -SkipSourceAcl
    $configurationAcl = Assert-DysonConfigurationAcl -Path $storage.configurationPath `
        -Kind ConfigFile -ServiceSid $serviceSid
    $transactionState = Get-DysonConfigurationTransactionState -Storage $storage `
        -ServiceSid $serviceSid -Contract $contract -ExpectedLauncherBindings $bindings -LockHeld
    if (-not $transactionState.clean) { throw 'DYSON_CONFIGURATION_TRANSACTION_NOT_CLEAN' }
    if ($transactionState.receipts.Count -lt 1 -or
        -not [bool]$transactionState.terminalTargetPresent -or
        [string]$transactionState.terminalTargetSha256 -cne [string]$configuration.sha256 -or
        [int64]$transactionState.terminalTargetLength -ne [int64]$configuration.length -or
        [string]$transactionState.terminalTargetAclFingerprint -cne
            [string]$configurationAcl.fingerprint -or
        [string]$transactionState.terminalBindingsSha256 -cne
            [string]$configuration.bindingsSha256 -or
        [string]$transactionState.terminalContractSha256 -cne [string]$contract.sha256 -or
        [string]$transactionState.terminalTargetPathSha256 -cne
            (Get-DysonConfigurationPathBindingSha256 $storage.configurationPath)) {
        throw 'DYSON_CONFIGURATION_TERMINAL_EVIDENCE_MISMATCH'
    }
    $snapshotCount = Assert-DysonConfigurationSnapshotInventory -Storage $storage `
        -Contract $contract -ServiceSid $serviceSid

    $snapshotEvidence = $null
    $restorePlan = $null
    if (-not [string]::IsNullOrWhiteSpace($ProtectedSnapshotPath)) {
        $snapshotEvidence = Assert-DysonConfigurationSnapshot -SnapshotPath $ProtectedSnapshotPath `
            -Contract $contract -ServiceSid $serviceSid -ExpectedDataRoot $resolvedDataRoot
        if ($PlanSnapshotRestore) {
            $restorePlan = Get-DysonConfigurationSnapshotRestorePlan `
                -SnapshotPath $ProtectedSnapshotPath -DataRoot $resolvedDataRoot `
                -Contract $contract -ExpectedLauncherBindings $bindings -ServiceSid $serviceSid
        }
    }
    elseif ($PlanSnapshotRestore) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_REQUIRED'
    }

    $result = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_TEST_RESULT_V1'
        healthy = $true
        configurationSha256 = [string]$configuration.sha256
        configurationLength = [int64]$configuration.length
        namesSha256 = [string]$configuration.namesSha256
        bindingsSha256 = [string]$configuration.bindingsSha256
        contractSha256 = [string]$contract.sha256
        configurationAclFingerprint = [string]$configurationAcl.fingerprint
        parentAclFingerprint = [string]$dataRootAcl.fingerprint
        completedTransactionCount = [int]$transactionState.receipts.Count
        transactionChainHeadSha256 = [string]$transactionState.chainHeadSha256
        protectedSnapshotCount = [int]$snapshotCount
        snapshot = $snapshotEvidence
        restorePlan = $restorePlan
        mutationPerformed = $false
    }
}
finally { $healthLock.Dispose() }
$result
