[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$RecoveryRoot,
    [Parameter(Mandatory)][string]$BundleId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [string]$OperationId = ([guid]::NewGuid().ToString('D')),
    [string]$Confirmation,
    [string]$ControlTaskName = 'Dyson-Control-Plane',
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonDataRootRecovery.Common.ps1')

$preview = Invoke-DysonDataRootRecoveryRestore -DataRoot $DataRoot -RecoveryRoot $RecoveryRoot `
    -BundleId $BundleId -ExpectedManifestSha256 $ExpectedManifestSha256 -OperationId $OperationId `
    -ControlTaskName $ControlTaskName -Backend $Backend -ShadowRoot $ShadowRoot -Preview
if (-not $WhatIfPreference -and $Confirmation -cne 'RESTORE_DYSON_CONTROL_DATA_ROOT') {
    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_CONFIRMATION_REQUIRED'
}
if (-not $PSCmdlet.ShouldProcess('Dyson Control DataRoot', 'create a protection point and atomically restore the validated recovery bundle')) {
    $preview | ConvertTo-Json -Depth 8 -Compress
    return
}
$result = Invoke-DysonDataRootRecoveryRestore -DataRoot $DataRoot -RecoveryRoot $RecoveryRoot `
    -BundleId $BundleId -ExpectedManifestSha256 $ExpectedManifestSha256 -OperationId $OperationId `
    -ControlTaskName $ControlTaskName -Backend $Backend -ShadowRoot $ShadowRoot
$result | ConvertTo-Json -Depth 8 -Compress
