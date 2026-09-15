[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$GameRoot,
    [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
    [Parameter(Mandatory)][string]$CurrentPluginsTreeSha256,
    [Parameter(Mandatory)][string]$CandidateManifestPath,
    [Parameter(Mandatory)][datetimeoffset]$MaintenanceWindowStartUtc,
    [Parameter(Mandatory)][datetimeoffset]$MaintenanceWindowEndUtc,
    [ValidateSet('Windows','Shadow')][string]$Backend = 'Windows',
    [string]$ShadowEvidencePath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

try {
    if (-not (Test-NebulaPrivateSha256 -Value $CurrentPluginsTreeSha256)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CURRENT_TREE_HASH_INVALID'
    }
    [void](Assert-NebulaPluginRole -Role $TargetRole)
    [void](Assert-NebulaPluginBackend -Backend $Backend)
    Assert-NebulaPluginMaintenanceWindow -StartUtc $MaintenanceWindowStartUtc -EndUtc $MaintenanceWindowEndUtc
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $layout = Get-NebulaPluginLayout -GameRoot $GameRoot -RequestId $RequestId -Backend $Backend
    if ((Test-Path -LiteralPath $layout.stageRoot) -or (Test-Path -LiteralPath $layout.quarantineRoot) -or
        (Test-Path -LiteralPath $layout.intentPath) -or (Test-Path -LiteralPath $layout.receiptPath)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_REQUEST_STATE_ALREADY_EXISTS'
    }
    $binding = Get-NebulaPluginTargetBinding -GameRoot $layout.gameRoot -TargetRole $TargetRole
    $parentBoundary = Get-NebulaPluginParentBoundary -Path $layout.bepInExRoot
    [void](Assert-NebulaPluginParentBoundarySafe -Boundary $parentBoundary)
    [void](Assert-NebulaPluginRootPendingIntentGate -Layout $layout `
        -PhysicalTargetDigest ([string]$binding.physicalTargetDigest))
    $candidate = Assert-NebulaPluginCandidateForJob -JobRoot $jobRoot -CandidateManifestPath $CandidateManifestPath
    $preflight = Get-NebulaPluginPreflightEvidence -GameRoot $layout.gameRoot -TargetRole $TargetRole `
        -Backend $Backend -ShadowEvidencePath $ShadowEvidencePath
    [void](Assert-NebulaPluginPreflightCompatible -Evidence $preflight)
    $preimage = Get-NebulaPluginTreeInventory -Root $layout.pluginsRoot -TargetBindingDigest $binding.digest
    $preimageDirectoryIdentity = Get-NebulaPluginDirectoryIdentity -Path $layout.pluginsRoot
    if ([string]$preimage.contentTreeSha256 -cne $CurrentPluginsTreeSha256) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CURRENT_TREE_HASH_MISMATCH'
    }
    $receiptsRoot = Join-Path $layout.stateRoot 'receipts'
    $previousReceiptDigest = Get-NebulaPluginReceiptChainHead -ReceiptsRoot $receiptsRoot `
        -PhysicalTargetDigest ([string]$binding.physicalTargetDigest)

    $inventoryPath = Join-Path $jobRoot 'evidence\plugin-cutover-preimage-inventory.json'
    [void](Write-NebulaPrivateJsonAtomic -Path $inventoryPath -Value $preimage -JobRoot $jobRoot)
    $planCore = [ordered]@{
        protocol = $script:NebulaPluginPlanProtocol
        schemaVersion = 3
        requestId = $RequestId
        defaultMode = 'dry-run'
        executionEnabledByPlan = $false
        target = [ordered]@{
            targetRole = $TargetRole
            backend = $Backend
            gamePathIdentity = [string]$binding.value.gamePathIdentity
            gameDirectoryIdentity = $binding.gameDirectoryIdentity
            bepInExDirectoryIdentity = $binding.bepInExDirectoryIdentity
            physicalTargetDigest = [string]$binding.physicalTargetDigest
            targetBindingDigest = [string]$binding.digest
            bepInExBoundary = $parentBoundary
            gameDirectoryLeaf = 'Dyson Sphere Program'
            pluginTreeLeaf = 'plugins'
        }
        compatibility = [ordered]@{
            gameVersion = [string]$script:NebulaPrivateContract.game.gameVersion
            gameLibVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            assemblyCSharpMvid = [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid
        }
        processStopProof = [ordered]@{
            observedUtc = [string]$preflight.observedUtc
            validUntilUtc = [string]$preflight.validUntilUtc
            enumerationComplete = [bool]$preflight.processEnumerationComplete
            processesStopped = [bool]$preflight.processesStopped
            matchingProcessCount = @($preflight.matchingProcessIds).Count
            evidenceDigest = [string]$preflight.evidenceDigest
            mandatoryLiveRecheckAtApply = $true
        }
        candidate = [ordered]@{
            manifestDigest = [string]$candidate.manifest.manifestDigest
            treeSha256 = [string]$candidate.result.candidateTreeSha256
            files = 44
            stockFilesExact = 40
            customFiles = 4
        }
        preimage = [ordered]@{
            inventoryDigest = [string]$preimage.inventoryDigest
            treeSha256 = [string]$preimage.contentTreeSha256
            aclDigest = [string]$preimage.aclDigest
            files = [int]$preimage.fileCount
            directoryIdentity = $preimageDirectoryIdentity
        }
        receiptChain = [ordered]@{ previousReceiptDigest = $previousReceiptDigest }
        maintenanceWindow = [ordered]@{
            startUtc = $MaintenanceWindowStartUtc.ToString('o')
            endUtc = $MaintenanceWindowEndUtc.ToString('o')
            requireCurrentTimeInsideWindowAtApply = $true
        }
        transaction = [ordered]@{
            candidateSourcePathPersisted = $false
            targetAbsolutePathPersisted = $false
            sameVolumeStageAndQuarantineRequired = $true
            exactInventoryHashAndAclRequired = $true
            stageVerifiedBeforeIntent = $true
            stageRevalidatedAfterIntentImmediatelyBeforeRename = $true
            intentPersistedBeforeActiveTreeMutation = $true
            processStopProofRequired = $true
            maintenanceWindowRequiredAtEveryMutationBoundary = $true
            lockProbeRequiredImmediatelyBeforeSwap = $true
            rootWidePendingIntentGateRequired = $true
            physicalReceiptChainRequired = $true
            operationOwnedDirectoryIdentityRequired = $true
            protectedParentDeleteChildBoundaryRequired = $true
            borrowedHostMutationLeaseRequiredAtEveryBoundary = $true
            quarantineRetainedAfterSuccess = $true
            deleteIsNeverAutomatic = $true
            orderedOperations = @(
                'validate borrowed global host-mutation lease and physical root pending-intent gate',
                'live compatibility process-stop maintenance parent and preimage preflight',
                'copy exact qualified candidate into same-volume stage',
                'verify exact stage content ACL and operation-owned directory identity',
                'persist immutable intent with write-through semantics',
                'revalidate lease window stop proof parent active stage ACL content and identities',
                'atomically rename current tree to quarantine',
                'revalidate lease window stop proof parent and stage identity',
                'atomically rename candidate stage to active tree',
                'verify exact active quarantine inventories and operation-owned identities',
                'persist immutable receipt on the single physical-target chain'
            )
        }
        recovery = [ordered]@{
            defaultAction = 'restore-preimage'
            failClosedOnAmbiguity = $true
            automaticDeletion = $false
            requiresCurrentReceiptChainHead = $true
            requiresRecoveryLeaseAndFreshStopProof = $true
            states = @(
                [ordered]@{ active='preimage'; stage='candidate'; quarantine='absent'; receipt='absent'; action='record-rolled-back-with-stage-retained' },
                [ordered]@{ active='absent'; stage='candidate'; quarantine='preimage'; receipt='absent'; action='rename-quarantine-to-active' },
                [ordered]@{ active='candidate'; stage='absent'; quarantine='preimage'; receipt='absent'; action='rename-active-to-stage-then-quarantine-to-active' },
                [ordered]@{ active='candidate'; stage='absent'; quarantine='preimage'; receipt='applied'; action='verify-completed-only-when-current-head' },
                [ordered]@{ active='any-other'; stage='any-other'; quarantine='any-other'; receipt='any'; action='lock-and-require-manual-inspection' }
            )
        }
    }
    $planDigest = Get-NebulaPrivateObjectSha256 -Value $planCore
    $plan = [ordered]@{}
    foreach ($key in $planCore.Keys) { $plan[$key] = $planCore[$key] }
    $plan.planDigest = $planDigest
    $plan.confirmation = [ordered]@{
        exactPhrase = 'CONFIRM NEBULA PLUGIN CUTOVER ' + $RequestId + ' ' + $planDigest
        granted = $false
    }
    $planText = ConvertTo-NebulaPrivateCanonicalJson -Value $plan
    $candidateAbsolute = Get-NebulaPrivateFullPath -Path $candidate.candidateRoot
    if ($planText.IndexOf($candidateAbsolute, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $planText.IndexOf((Get-NebulaPrivateFullPath -Path $layout.gameRoot), [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_PATH_DISCLOSURE'
    }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $OutputPath = Join-Path $jobRoot 'evidence\plugin-cutover-plan.json'
    }
    [void](Write-NebulaPrivateJsonAtomic -Path $OutputPath -Value $plan -JobRoot $jobRoot)
    [pscustomobject][ordered]@{
        protocol = $script:NebulaPluginPlanProtocol
        requestId = $RequestId
        targetRole = $TargetRole
        mode = 'dry-run'
        executionEnabled = $false
        planDigest = $planDigest
        productionChanged = $false
    } | ConvertTo-Json -Compress
}
catch {
    [Console]::Error.WriteLine((Get-NebulaPrivateErrorCode -Exception $_.Exception))
    exit 1
}
