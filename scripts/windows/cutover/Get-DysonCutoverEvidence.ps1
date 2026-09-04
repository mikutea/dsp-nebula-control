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
    Initialize-CutoverHostContext -ProjectRoot $ProjectRoot -ProfileFile $ProfileFile `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
        -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $AuthorityInventoryRevision `
        -RequestId $RequestId -Backend $Backend -ShadowRoot $ShadowRoot
    $evidence = Get-CutoverHostEvidence
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1'
        schemaVersion = 1
        requestId = $script:CutoverHostRequestId
        authorityInventoryRevision = $script:CutoverHostExpectedInventoryRevision
        evidence = $evidence
    } | ConvertTo-Json -Depth 8 -Compress
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
