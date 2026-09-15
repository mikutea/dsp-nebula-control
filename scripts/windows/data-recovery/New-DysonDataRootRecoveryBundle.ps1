[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$RecoveryRoot,
    [string]$BundleId = ([guid]::NewGuid().ToString('D')),
    [string]$ControlTaskName = 'Dyson-Control-Plane',
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonDataRootRecovery.Common.ps1')

$preview = Invoke-DysonDataRootRecoveryBundleCreation -DataRoot $DataRoot -RecoveryRoot $RecoveryRoot `
    -BundleId $BundleId -ControlTaskName $ControlTaskName -Backend $Backend -ShadowRoot $ShadowRoot -Preview
if (-not $PSCmdlet.ShouldProcess('Dyson Control DataRoot', 'create a private, integrity-bound recovery bundle')) {
    $preview | ConvertTo-Json -Depth 8 -Compress
    return
}
$result = Invoke-DysonDataRootRecoveryBundleCreation -DataRoot $DataRoot -RecoveryRoot $RecoveryRoot `
    -BundleId $BundleId -ControlTaskName $ControlTaskName -Backend $Backend -ShadowRoot $ShadowRoot
$result | ConvertTo-Json -Depth 8 -Compress
