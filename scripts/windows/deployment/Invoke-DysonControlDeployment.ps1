[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidateSet('Stage', 'Activate', 'Upgrade', 'Rollback')][string]$Operation,
    [string]$SourcePath,
    [string]$Version,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArtifactPayloadSha256,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [string]$RuntimeRoot,
    [string]$NodeExecutable,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [string]$EntryPointRelativePath = 'apps\api\dist\index.js',
    [string]$SnapshotId = 'latest',
    [switch]$RestartControlTask,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$ControlTaskName = 'Dyson-Control-Plane',
    [uri]$ReadinessUri,
    [ValidateRange(1, 300)][int]$ReadinessTimeoutSeconds = 30,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][System.IO.FileStream]$ExistingDeploymentLock,
    [Parameter(DontShow)][switch]$PreserveProtectedConfiguration
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$runtimeBindingCount = @($RuntimeRoot, $NodeExecutable, $ExpectedNodeSha256 |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
if ($runtimeBindingCount -notin @(0, 3)) {
    throw 'RuntimeRoot, NodeExecutable, and ExpectedNodeSha256 must be supplied together.'
}
if (($RestartControlTask -or $ReadinessUri) -and $runtimeBindingCount -ne 3) {
    throw 'A control-task restart or readiness check requires the protected Node.js runtime binding.'
}
$nodeProtection = if ($runtimeBindingCount -eq 3) {
    Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $installFull -DataRoot $dataFull
}
else { $null }
function Assert-DysonDeploymentNodeRuntimeUnchanged {
    if (-not $nodeProtection) { throw 'The protected Node.js runtime binding is unavailable.' }
    $current = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $installFull -DataRoot $dataFull
    if ([string]$current.runtimeRootIdentity -cne [string]$nodeProtection.runtimeRootIdentity -or
        [string]$current.nodeExecutableSha256 -cne [string]$nodeProtection.nodeExecutableSha256) {
        throw 'The Node.js runtime identity changed during the deployment operation.'
    }
}
function Restart-DysonRuntimeBoundControlTask {
    Assert-DysonDeploymentNodeRuntimeUnchanged
    Restart-DysonControlTask -TaskName $ControlTaskName
}
function Test-DysonRuntimeBoundReadiness {
    param([Parameter(Mandatory)][string]$ExpectedVersion)
    Assert-DysonDeploymentNodeRuntimeUnchanged
    [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri `
        -ExpectedVersion $ExpectedVersion -TimeoutSeconds $ReadinessTimeoutSeconds)
    Assert-DysonDeploymentNodeRuntimeUnchanged
}
if ([string]::Equals($installFull, $dataFull, [System.StringComparison]::OrdinalIgnoreCase) -or
    (Test-DysonPathWithin -Candidate $dataFull -Parent $installFull -AllowEqual) -or
    (Test-DysonPathWithin -Candidate $installFull -Parent $dataFull -AllowEqual)) {
    throw 'InstallRoot and DataRoot must be separate directory trees.'
}
Assert-DysonRelativePath -Path $EntryPointRelativePath -Name 'EntryPointRelativePath'

$brokerProfileCandidates = @(
    (Join-Path $dataFull 'data\lifecycle-broker\broker-profile.json'),
    (Join-Path $dataFull 'data\cutover-broker\broker-profile.json')
)
$brokerProfilePresent = @($brokerProfileCandidates | Where-Object {
    Test-Path -LiteralPath $_
}).Count -gt 0
if ($brokerProfilePresent) {
    if ($null -eq $ExistingDeploymentLock) {
        throw 'Direct deployment operations are forbidden while a fixed broker profile exists; use the orchestrating installer or uninstaller.'
    }
    Assert-DysonDeploymentLockLease -Lease $ExistingDeploymentLock -DataRoot $dataFull
}

if ($Operation -in @('Stage', 'Activate', 'Upgrade')) {
    if ([string]::IsNullOrWhiteSpace($Version)) { throw "Version is required for $Operation." }
    Assert-DysonVersion -Version $Version
}
if ($Operation -in @('Stage', 'Upgrade')) {
    if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw "SourcePath is required for $Operation." }
    if ([string]::IsNullOrWhiteSpace($ExpectedArtifactPayloadSha256)) {
        throw "ExpectedArtifactPayloadSha256 is required for $Operation."
    }
    $sourceFull = Assert-DysonPlainDirectory -Path $SourcePath
    $sourceEntry = Get-DysonFullPath -Path (Join-Path $sourceFull $EntryPointRelativePath)
    if (-not (Test-DysonPathWithin -Candidate $sourceEntry -Parent $sourceFull) -or
        -not (Test-Path -LiteralPath $sourceEntry -PathType Leaf)) {
        throw 'The source payload does not contain the requested entry point.'
    }
    $sourceArtifactVerification = Test-DysonSourceArtifact -SourcePath $sourceFull `
        -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath `
        -ExpectedPayloadSha256 $ExpectedArtifactPayloadSha256
}
else {
    if (-not [string]::IsNullOrWhiteSpace($ExpectedArtifactPayloadSha256)) {
        throw 'ExpectedArtifactPayloadSha256 is valid only for Stage or Upgrade.'
    }
    $sourceFull = $null
    $sourceArtifactVerification = $null
}
if ($ReadinessUri) {
    if ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
        $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
    }
}
if ($RestartControlTask -and -not $ReadinessUri) {
    throw 'RestartControlTask requires a loopback ReadinessUri so activation can be verified and rolled back.'
}
if ($PreserveProtectedConfiguration -and
    ($Operation -cne 'Rollback' -or $null -eq $ExistingDeploymentLock)) {
    throw 'PreserveProtectedConfiguration is reserved for an orchestrated rollback under the existing deployment lease.'
}

$rollbackPreview = $null
if ($Operation -eq 'Rollback') {
    $rollbackPreview = Get-DysonDeploymentSnapshot -DataRoot $dataFull -SnapshotId $SnapshotId
    $SnapshotId = [string]$rollbackPreview.metadata.snapshotId
}

$description = switch ($Operation) {
    'Stage' { "stage immutable Dyson Control release $Version" }
    'Activate' { "snapshot current state and activate Dyson Control release $Version" }
    'Upgrade' { "snapshot current state, stage, activate, and verify Dyson Control release $Version" }
    'Rollback' { "create a rollback guard and restore deployment snapshot $SnapshotId" }
}
if (-not $PSCmdlet.ShouldProcess("$installFull; $dataFull", $description)) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        operation = $Operation.ToLowerInvariant()
        version = if ($Version) { $Version } else { $null }
        sourceValidated = [bool]($sourceArtifactVerification)
        artifactPayloadSha256 = if ($sourceArtifactVerification) {
            [string]$sourceArtifactVerification.payloadSha256
        } else { $null }
        artifactProvenanceBound = [bool]($sourceArtifactVerification -and
            [bool]$sourceArtifactVerification.provenancePayloadBound)
        sourceArtifactScriptsExecuted = $false
        runtimeRootIdentity = if ($nodeProtection) { [string]$nodeProtection.runtimeRootIdentity } else { $null }
        nodeExecutableSha256 = if ($nodeProtection) { [string]$nodeProtection.nodeExecutableSha256 } else { $null }
        nodeRuntimeProtected = [bool]($nodeProtection)
        snapshotId = if ($Operation -eq 'Rollback') { $SnapshotId } else { $null }
        restartControlTask = [bool]$RestartControlTask
        readinessCheck = if ($ReadinessUri) { $ReadinessUri.AbsoluteUri } else { $null }
        rollbackDefined = $Operation -in @('Activate', 'Upgrade', 'Rollback')
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](New-DysonDirectory -Path $installFull)
[void](New-DysonDirectory -Path $dataFull)
$ownsDeploymentLock = $false
if ($ExistingDeploymentLock) {
    Assert-DysonDeploymentLockLease -Lease $ExistingDeploymentLock -DataRoot $dataFull
    $deploymentLock = $ExistingDeploymentLock
}
else {
    $deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
    $ownsDeploymentLock = $true
}
$snapshot = $null
$result = $null
$operationCode = $Operation.ToUpperInvariant()
try {
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation $Operation.ToLowerInvariant() -Outcome 'started' -Version $Version -SnapshotId $SnapshotId -Code ($operationCode + '_STARTED')
    switch ($Operation) {
        'Stage' {
            $staged = Invoke-DysonStageReleaseCore -SourcePath $sourceFull -Version $Version `
                -InstallRoot $installFull -EntryPointRelativePath $EntryPointRelativePath `
                -SourceArtifactVerification $sourceArtifactVerification
            $result = [ordered]@{
                protocol = $script:DysonDeploymentProtocol
                state = $staged.state
                operation = 'stage'
                version = $Version
                payloadSha256 = $staged.payloadSha256
                fileCount = $staged.fileCount
                artifactProvenanceBound = $true
                sourceArtifactScriptsExecuted = $false
                rollback = 'Delete the inactive immutable release only after confirming no snapshot references it.'
            }
        }
        'Activate' {
            $snapshot = New-DysonDeploymentSnapshotCore -InstallRoot $installFull -DataRoot $dataFull -Reason ('before-activate-' + $Version)
            try {
                $pointer = Invoke-DysonActivateCore -Version $Version -InstallRoot $installFull -DataRoot $dataFull -EntryPointRelativePath $EntryPointRelativePath
                if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                if ($ReadinessUri) { Test-DysonRuntimeBoundReadiness -ExpectedVersion $Version }
            }
            catch {
                $activationError = $_
                try {
                    [void](Restore-DysonDeploymentSnapshotCore -InstallRoot $installFull -DataRoot $dataFull -SnapshotId $snapshot.snapshotId)
                    if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                    if ($ReadinessUri -and $snapshot.hadActivePointer) {
                        Test-DysonRuntimeBoundReadiness -ExpectedVersion ([string]$snapshot.activeVersion)
                    }
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'activate' -Outcome 'failed-rolled-back' -Version $Version -SnapshotId $snapshot.snapshotId -Code 'ACTIVATE_ROLLED_BACK'
                }
                catch {
                    $automaticRollbackError = $_
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'activate' -Outcome 'failed-rollback-failed' -Version $Version -SnapshotId $snapshot.snapshotId -Code 'ACTIVATE_ROLLBACK_FAILED'
                    throw ('Activation failed ({0}); automatic rollback also failed ({1}).' -f $activationError.Exception.Message, $automaticRollbackError.Exception.Message)
                }
                throw $activationError
            }
            $result = [ordered]@{
                protocol = $script:DysonDeploymentProtocol
                state = 'activated'
                operation = 'activate'
                version = $Version
                snapshotId = $snapshot.snapshotId
                payloadSha256 = $pointer.payloadSha256
                readinessVerified = [bool]$ReadinessUri
                rollback = "Rollback snapshot $($snapshot.snapshotId)."
            }
        }
        'Upgrade' {
            $snapshot = New-DysonDeploymentSnapshotCore -InstallRoot $installFull -DataRoot $dataFull -Reason ('before-upgrade-' + $Version)
            try {
                $staged = Invoke-DysonStageReleaseCore -SourcePath $sourceFull -Version $Version `
                    -InstallRoot $installFull -EntryPointRelativePath $EntryPointRelativePath `
                    -SourceArtifactVerification $sourceArtifactVerification
                $pointer = Invoke-DysonActivateCore -Version $Version -InstallRoot $installFull -DataRoot $dataFull -EntryPointRelativePath $EntryPointRelativePath
                if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                if ($ReadinessUri) { Test-DysonRuntimeBoundReadiness -ExpectedVersion $Version }
            }
            catch {
                $upgradeError = $_
                try {
                    [void](Restore-DysonDeploymentSnapshotCore -InstallRoot $installFull -DataRoot $dataFull -SnapshotId $snapshot.snapshotId)
                    if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                    if ($ReadinessUri -and $snapshot.hadActivePointer) {
                        Test-DysonRuntimeBoundReadiness -ExpectedVersion ([string]$snapshot.activeVersion)
                    }
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'upgrade' -Outcome 'failed-rolled-back' -Version $Version -SnapshotId $snapshot.snapshotId -Code 'UPGRADE_ROLLED_BACK'
                }
                catch {
                    $automaticRollbackError = $_
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'upgrade' -Outcome 'failed-rollback-failed' -Version $Version -SnapshotId $snapshot.snapshotId -Code 'UPGRADE_ROLLBACK_FAILED'
                    throw ('Upgrade failed ({0}); automatic rollback also failed ({1}).' -f $upgradeError.Exception.Message, $automaticRollbackError.Exception.Message)
                }
                throw $upgradeError
            }
            $result = [ordered]@{
                protocol = $script:DysonDeploymentProtocol
                state = 'upgraded'
                operation = 'upgrade'
                version = $Version
                stageState = $staged.state
                snapshotId = $snapshot.snapshotId
                payloadSha256 = $pointer.payloadSha256
                artifactProvenanceBound = $true
                sourceArtifactScriptsExecuted = $false
                readinessVerified = [bool]$ReadinessUri
                rollback = "Rollback snapshot $($snapshot.snapshotId)."
            }
        }
        'Rollback' {
            $guardSnapshot = New-DysonDeploymentSnapshotCore -InstallRoot $installFull -DataRoot $dataFull -Reason ('before-rollback-' + $SnapshotId)
            try {
                $restored = Restore-DysonDeploymentSnapshotCore -InstallRoot $installFull `
                    -DataRoot $dataFull -SnapshotId $SnapshotId `
                    -PreserveProtectedConfiguration:$PreserveProtectedConfiguration
                if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                if ($ReadinessUri -and $restored.restoredVersion) {
                    Test-DysonRuntimeBoundReadiness -ExpectedVersion ([string]$restored.restoredVersion)
                }
            }
            catch {
                $rollbackError = $_
                try {
                    [void](Restore-DysonDeploymentSnapshotCore -InstallRoot $installFull `
                        -DataRoot $dataFull -SnapshotId $guardSnapshot.snapshotId `
                        -PreserveProtectedConfiguration:$PreserveProtectedConfiguration)
                    if ($RestartControlTask) { Restart-DysonRuntimeBoundControlTask }
                    if ($ReadinessUri -and $guardSnapshot.hadActivePointer) {
                        Test-DysonRuntimeBoundReadiness -ExpectedVersion ([string]$guardSnapshot.activeVersion)
                    }
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'rollback' -Outcome 'failed-restored-guard' -SnapshotId $guardSnapshot.snapshotId -Code 'ROLLBACK_GUARD_RESTORED'
                }
                catch {
                    $guardRestoreError = $_
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'rollback' -Outcome 'failed-guard-restore-failed' -SnapshotId $guardSnapshot.snapshotId -Code 'ROLLBACK_GUARD_FAILED'
                    throw ('Rollback failed ({0}); rollback-guard restore also failed ({1}).' -f $rollbackError.Exception.Message, $guardRestoreError.Exception.Message)
                }
                throw $rollbackError
            }
            $result = [ordered]@{
                protocol = $script:DysonDeploymentProtocol
                state = 'rolled-back'
                operation = 'rollback'
                snapshotId = $restored.snapshotId
                restoredVersion = $restored.restoredVersion
                configRestored = $restored.configRestored
                guardSnapshotId = $guardSnapshot.snapshotId
                readinessVerified = [bool]($ReadinessUri -and $restored.restoredVersion)
                rollback = "Restore guard snapshot $($guardSnapshot.snapshotId)."
            }
        }
    }
    if ($nodeProtection) { Assert-DysonDeploymentNodeRuntimeUnchanged }
    $result['runtimeRootIdentity'] = if ($nodeProtection) { [string]$nodeProtection.runtimeRootIdentity } else { $null }
    $result['nodeExecutableSha256'] = if ($nodeProtection) { [string]$nodeProtection.nodeExecutableSha256 } else { $null }
    $result['nodeRuntimeProtected'] = [bool]($nodeProtection)
    $result['runtimeChanged'] = $false
    $resultSnapshotId = if ($result.Contains('snapshotId')) { [string]$result['snapshotId'] } else { $null }
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation $Operation.ToLowerInvariant() -Outcome 'succeeded' -Version $Version -SnapshotId $resultSnapshotId -Code ($operationCode + '_SUCCEEDED')
    $result | ConvertTo-DysonJsonLine
}
catch {
    try {
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation $Operation.ToLowerInvariant() -Outcome 'failed' -Version $Version -SnapshotId $(
            if ($snapshot) { [string]$snapshot.snapshotId } elseif ($Operation -eq 'Rollback') { $SnapshotId } else { $null }
        ) -Code ($operationCode + '_FAILED')
    }
    catch { }
    throw
}
finally {
    if ($ownsDeploymentLock -and $deploymentLock) { $deploymentLock.Dispose() }
}
