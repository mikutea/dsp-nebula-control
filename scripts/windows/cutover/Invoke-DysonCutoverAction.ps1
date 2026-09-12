[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$ProfileFile,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
    [Parameter(Mandatory)][string]$ServiceUser,
    [Parameter(Mandatory)][int]$GamePort,
    [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$Action,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$LeaseInstanceId,
    [Parameter(Mandatory)][string]$LeaseToken,
    [string]$Confirm,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$PreviousStopScriptSha256,
    [switch]$PreviousStopReconcileOnly,
    [switch]$WhatIf,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $leaseCommon = Join-Path (Split-Path $PSScriptRoot -Parent) 'DysonHostMutationLease.Common.ps1'
    $hostCommon = Join-Path $PSScriptRoot 'DysonCutoverHost.Common.ps1'
    if (-not (Test-Path -LiteralPath $leaseCommon -PathType Leaf) -or
        -not (Test-Path -LiteralPath $hostCommon -PathType Leaf)) {
        throw 'dependency'
    }
    . $leaseCommon
    . $hostCommon
    $script:CutoverHostPreviousStopScriptSha256 = $PreviousStopScriptSha256
    $script:CutoverHostPreviousStopReconcileOnly = [bool]$PreviousStopReconcileOnly
    if ($PreviousStopReconcileOnly -and $Action -cne 'StopPreviousRuntime') { throw 'invalid reconcile action' }
    Initialize-CutoverHostContext -ProjectRoot $ProjectRoot -ProfileFile $ProfileFile `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
        -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $AuthorityInventoryRevision `
        -RequestId $RequestId -Backend $Backend -ShadowRoot $ShadowRoot -DataRoot $DataRoot `
        -LeaseInstanceId $LeaseInstanceId -LeaseToken $LeaseToken
    if ($Confirm -notmatch '^\$?false$') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_MUTATION_NOT_CONFIRMED'
    }
    if ($Action -notin @(
        'DisablePreviousAuthority', 'StopPreviousRuntime', 'EnablePreviousAuthority',
        'StartPreviousRuntime', 'StartCandidateRuntime', 'StopCandidateRuntime'
    )) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_INVALID'
    }
    if ($WhatIf) {
        [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_ACTION_PREVIEW_V1'; schemaVersion = 1
            requestId = $script:CutoverHostRequestId; action = $Action; dryRun = $true
        } | ConvertTo-Json -Depth 4 -Compress
        exit 0
    }
    Invoke-CutoverHostFixedAction $Action
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'
        schemaVersion = 1
        requestId = $script:CutoverHostRequestId
        authorityInventoryRevision = $script:CutoverHostExpectedInventoryRevision
        action = $(if ($PreviousStopReconcileOnly) { 'ReconcilePreviousStop' } else { $Action })
        status = 'succeeded'
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
catch {
    $code = 'DYSON_CONTROL_CUTOVER_HOST_FAILED'
    if (Get-Command -Name Get-CutoverHostErrorCode -ErrorAction SilentlyContinue) {
        $code = Get-CutoverHostErrorCode $_.Exception
    }
    [pscustomobject][ordered]@{ ok = $false; error = [pscustomobject][ordered]@{ code = $code } } |
        ConvertTo-Json -Depth 4 -Compress
    exit 1
}
