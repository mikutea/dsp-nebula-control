[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$GameRoot,
    [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
    [Parameter(Mandatory)][string]$PlanPath,
    [ValidateSet('Windows','Shadow')][string]$Backend = 'Windows'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

try {
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $layout = Get-NebulaPluginLayout -GameRoot $GameRoot -RequestId $RequestId -Backend $Backend
    $plan = Read-NebulaPluginPlan -Path $PlanPath -JobRoot $jobRoot -RequestId $RequestId `
        -GameRoot $layout.gameRoot -TargetRole $TargetRole -Backend $Backend
    if (-not (Test-Path -LiteralPath $layout.intentPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $layout.receiptPath -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TERMINAL_EVIDENCE_MISSING'
    }
    $intent = Read-NebulaPluginIntent -Path $layout.intentPath
    $receipt = Assert-NebulaPluginReceipt -Receipt (Read-NebulaPluginJson -Path $layout.receiptPath)
    $preimage = Read-NebulaPluginJson -Path (Join-Path $jobRoot 'evidence\plugin-cutover-preimage-inventory.json')
    [void](Assert-NebulaPluginInventoryValue -Inventory $preimage -Code 'NEBULA_PLUGIN_PREIMAGE_INVENTORY_INVALID')
    [void](Assert-NebulaPluginApplyIntentContext -Intent $intent -Plan $plan -Preimage $preimage `
        -Layout $layout -Code 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID')
    if ([string]$receipt.requestId -cne $RequestId -or
        [string]$receipt.targetBindingDigest -cne [string]$plan.target.targetBindingDigest -or
        [string]$receipt.physicalTargetDigest -cne [string]$plan.target.physicalTargetDigest -or
        [string]$receipt.candidateManifestDigest -cne [string]$plan.candidate.manifestDigest -or
        [string]$receipt.candidateTreeSha256 -cne [string]$plan.candidate.treeSha256) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID'
    }
    [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $receipt -Intent $intent)
    $state = Assert-NebulaPluginRootPendingIntentGate -Layout $layout `
        -PhysicalTargetDigest ([string]$plan.target.physicalTargetDigest)
    if ([string]$state.chainHead -cne [string]$receipt.receiptDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
    }
    $terminalCode = if ([string]$receipt.status -ceq 'applied') {
        'NEBULA_PLUGIN_ACTIVE_VERIFY_FAILED'
    }
    else { 'NEBULA_PLUGIN_ROLLBACK_VERIFY_FAILED' }
    [void](Assert-NebulaPluginReceiptTerminalState -Receipt $receipt -Intent $intent `
        -PreimageInventory $preimage -ActiveRoot $layout.pluginsRoot -CandidateStageRoot $layout.stageRoot `
        -PreimageQuarantineRoot $layout.quarantineRoot -BepInExRoot $layout.bepInExRoot -Code $terminalCode)
    $candidateAbsolute = Get-NebulaPrivateFullPath -Path (Join-Path $jobRoot 'candidate')
    $persisted = (ConvertTo-NebulaPrivateCanonicalJson -Value $intent) +
        (ConvertTo-NebulaPrivateCanonicalJson -Value $receipt)
    if ($persisted.IndexOf($candidateAbsolute, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PERSISTED_PATH_DISCLOSURE'
    }
    [pscustomobject][ordered]@{
        protocol=$script:NebulaPluginReceiptProtocol; status='verified'; requestId=$RequestId
        targetRole=$TargetRole; transactionStatus=[string]$receipt.status
        receiptDigest=[string]$receipt.receiptDigest; contentAndAclExact=$true
        rollbackMaterialRetained=$true
    } | ConvertTo-Json -Compress
}
catch {
    [Console]::Error.WriteLine((Get-NebulaPrivateErrorCode -Exception $_.Exception))
    exit 1
}
