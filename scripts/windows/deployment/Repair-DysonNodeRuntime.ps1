[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [ValidateRange(1, 600)][int]$LeaseTimeoutSeconds = 120,
    [Parameter(DontShow)][switch]$SelfTestAllowCurrentUserAsAdministrator
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonNodeRuntime.Transaction.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
[void](Assert-DysonNodeRuntimeContainerProtection -RuntimeRoot $runtimeFull `
    -InstallRoot $installFull -DataRoot $dataFull)
$storage = Get-DysonNodeRuntimeTransactionStorage -RuntimeRoot $runtimeFull
[void](Assert-DysonNodeRuntimeTransactionStorageProtection -Storage $storage `
    -InstallRoot $installFull -DataRoot $dataFull)

if (-not $PSCmdlet.ShouldProcess(
        [string]$storage.transactionRoot,
        'reconcile protected Node.js runtime transaction intents under an exclusive lease'
    )) {
    [ordered]@{
        protocol = 'DYSON_CONTROL_NODE_RUNTIME_REPAIR_V1'
        state = 'preview'
        runtimeRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path $runtimeFull
        transactionRootIdentity = Get-DysonNodeRuntimePathIdentityDigest `
            -Path ([string]$storage.transactionRoot)
        mutationPerformed = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

if ($SelfTestAllowCurrentUserAsAdministrator) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}
elseif (-not ([System.Security.Principal.WindowsPrincipal]::new(
    [System.Security.Principal.WindowsIdentity]::GetCurrent()
)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator rights are required to repair protected Node.js runtime transactions.'
}

$lease = $null
try {
    $lease = Enter-DysonNodeRuntimeTransactionLease -Storage $storage `
        -TimeoutSeconds $LeaseTimeoutSeconds
    [void](Assert-DysonNodeRuntimeContainerProtection -RuntimeRoot $runtimeFull `
        -InstallRoot $installFull -DataRoot $dataFull)
    [void](Assert-DysonNodeRuntimeTransactionStorageProtection -Storage $storage `
        -InstallRoot $installFull -DataRoot $dataFull)
    $recoveries = @(Invoke-DysonNodeRuntimeTransactionRecovery -Storage $storage `
        -InstallRoot $installFull -DataRoot $dataFull `
        -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator)
    $safeRecoveries = @($recoveries | ForEach-Object {
        [ordered]@{
            operationId = [string]$_.operationId
            state = [string]$_.state
            recovered = [bool]$_.recovered
            receipt = $_.receipt
        }
    })
    [ordered]@{
        protocol = 'DYSON_CONTROL_NODE_RUNTIME_REPAIR_V1'
        state = 'completed'
        runtimeRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path $runtimeFull
        transactionRootIdentity = Get-DysonNodeRuntimePathIdentityDigest `
            -Path ([string]$storage.transactionRoot)
        recoveryCount = $safeRecoveries.Count
        recoveries = $safeRecoveries
        mutationPerformed = [bool]($safeRecoveries.Count -ne 0)
    } | ConvertTo-DysonJsonLine
}
finally { if ($lease) { $lease.Dispose() } }
