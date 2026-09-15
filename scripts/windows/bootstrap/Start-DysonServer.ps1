[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(5, 240)][int]$Ups = 60,
    [ValidateSet('Normal', 'AboveNormal')][string]$ProcessPriority = 'AboveNormal'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$protocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_V1'
$attemptId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$startedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
$publishedAt = $null
$version = $null
$bindingId = $null
$context = $null
$project = $null
$releaseCompleted = $false
$startLease = $null
$stateLease = $null
$startInvocation = $null
$errorCode = 'BOOTSTRAP_START_FAILED'
try {
    $commonPath = [System.IO.Path]::Combine($PSScriptRoot, 'DysonGameLifecycleBootstrap.Common.ps1')
    $commonItem = [System.IO.FileInfo]::new($commonPath)
    $commonItem.Refresh()
    if (-not $commonItem.Exists -or ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'bootstrap common unavailable'
    }
    . $commonItem.FullName
    $context = Get-DysonGameBootstrapContext -BootstrapRoot $PSScriptRoot
    $project = Get-DysonGameBootstrapProjectIdentity -ProjectRoot $ProjectRoot
    $startLease = Enter-DysonGameBootstrapLock -Path $context.startLockPath -TimeoutSeconds 10

    $errorCode = 'BOOTSTRAP_PREVIOUS_BINDING_RECOVERY_FAILED'
    $stateLease = Enter-DysonGameBootstrapLock -Path $context.stateLockPath -TimeoutSeconds 10
    $previousBinding = Read-DysonGameBootstrapBinding -Context $context
    $staleExpectedExit = Read-DysonGameBootstrapExpectedExit -Context $context -AllowMissing
    if ($null -eq $previousBinding) {
        if ($null -ne $staleExpectedExit) {
            if ([string]$staleExpectedExit.value.projectRootSha256 -cne [string]$project.sha256 -or
                [string]$staleExpectedExit.value.dataRootIdentity -cne [string]$context.dataRootIdentity -or
                [string]$staleExpectedExit.value.state -cne 'completed') {
                throw 'orphaned expected exit is not safely complete'
            }
            [void](Remove-DysonGameBootstrapExpectedExit -Context $context `
                -BindingId ([string]$staleExpectedExit.value.bindingId) -RequireCompleted)
        }
    }
    else {
        if ([string]$previousBinding.projectRootSha256 -cne [string]$project.sha256 -or
            [string]$previousBinding.dataRootIdentity -cne [string]$context.dataRootIdentity) {
            throw 'project binding mismatch'
        }
        if ($null -ne $staleExpectedExit) {
            Assert-DysonGameBootstrapExpectedExitMatchesBinding `
                -ExpectedExit $staleExpectedExit -Binding $previousBinding -Context $context
        }
        $previousRelease = Resolve-DysonGameBootstrapBoundRelease -Context $context -Binding $previousBinding
        [void](Invoke-DysonGameBootstrapReleaseScript `
            -ScriptPath $previousRelease.stopScriptPath `
            -Arguments @('-ProjectRoot', $project.projectRoot, '-TimeoutSeconds', '150') `
            -WorkingDirectory $project.projectRoot)
        if ($null -ne $staleExpectedExit) {
            [void](Remove-DysonGameBootstrapExpectedExit -Context $context `
                -BindingId ([string]$previousBinding.bindingId))
        }
        Remove-DysonGameBootstrapBinding -Context $context -BindingId ([string]$previousBinding.bindingId)
    }
    $stateLease.Dispose()
    $stateLease = $null

    $errorCode = 'BOOTSTRAP_ACTIVE_RELEASE_INVALID'
    $release = Resolve-DysonGameBootstrapActiveRelease -Context $context
    $version = [string]$release.version
    $binding = New-DysonGameBootstrapBinding -Release $release `
        -ProjectRootSha256 $project.sha256 -DataRootIdentity $context.dataRootIdentity
    $bindingId = [string]$binding.bindingId
    $stateLease = Enter-DysonGameBootstrapLock -Path $context.stateLockPath -TimeoutSeconds 10
    $pidPath = Assert-DysonGameBootstrapStartPublicationClear -Project $project
    Write-DysonGameBootstrapBinding -Context $context -Binding $binding
    $persisted = Read-DysonGameBootstrapBinding -Context $context
    if ($null -eq $persisted -or [string]$persisted.bindingId -cne $bindingId) {
        throw 'binding publication failed'
    }
    $boundRelease = Resolve-DysonGameBootstrapBoundRelease -Context $context -Binding $persisted

    $errorCode = 'BOOTSTRAP_RELEASE_START_FAILED'
    $startInvocation = Start-DysonGameBootstrapReleaseScriptProcess `
        -ScriptPath $boundRelease.startScriptPath `
        -Arguments @(
            '-ProjectRoot', $project.projectRoot,
            '-Ups', [string]$Ups,
            '-ProcessPriority', $ProcessPriority
        ) `
        -WorkingDirectory $project.projectRoot
    $published = Wait-DysonGameBootstrapStartPublication `
        -Invocation $startInvocation -Project $project -PidPath $pidPath -TimeoutSeconds 15
    if ($published) {
        $publishedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
        $stateLease.Dispose()
        $stateLease = $null
    }
    [void](Complete-DysonGameBootstrapReleaseScriptProcess -Invocation $startInvocation)
    $startInvocation = $null

    if (-not $stateLease) {
        $stateLease = Enter-DysonGameBootstrapLock -Path $context.stateLockPath -TimeoutSeconds 10
    }
    $errorCode = 'BOOTSTRAP_UNEXPECTED_CLEAN_EXIT'
    $expectedExit = Read-DysonGameBootstrapExpectedExit -Context $context -AllowMissing
    if ($null -eq $expectedExit) {
        throw 'managed game exited without a completed stop intent'
    }
    Assert-DysonGameBootstrapExpectedExitMatchesBinding `
        -ExpectedExit $expectedExit -Binding $persisted -Context $context
    if ([string]$expectedExit.value.state -cne 'completed') {
        throw 'managed game exited without a completed stop intent'
    }
    $finalSaveProof = $null
    try {
        . (Join-Path $PSScriptRoot 'DysonStoppedSaveCapture.ps1')
        $finalPair = Get-DysonStoppedSavePair -ProjectRoot $project.projectRoot
        $finalSaveProof = [ordered]@{
            protocol = 'DYSON_CONTROL_STOPPED_SAVE_PROOF_V1'
            stopIntentSha256 = [string]$expectedExit.sha256
            capturedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
            saveName = $finalPair.saveName
            dsvBytes = $finalPair.dsvBytes
            dsvSha256 = $finalPair.dsvSha256
            serverBytes = $finalPair.serverBytes
            serverSha256 = $finalPair.serverSha256
        }
    }
    catch {
        # Evidence failure must not restart an intentionally stopped game.
        # The receipt remains auditable but cannot authorize an update baseline.
        $finalSaveProof = $null
    }
    [void](Remove-DysonGameBootstrapExpectedExit -Context $context `
        -BindingId $bindingId -RequireCompleted)
    $releaseCompleted = $true

    $errorCode = 'BOOTSTRAP_BINDING_FINALIZE_FAILED'
    Remove-DysonGameBootstrapBinding -Context $context -BindingId $bindingId
    $receiptSha256 = $null
    $receiptErrorCode = $null
    try {
        $runtimeReceipt = Write-DysonGameBootstrapRuntimeReceipt -Context $context `
            -AttemptId $attemptId -BindingId $bindingId -Version $version -Outcome 'clean-exit' `
            -ErrorCode $null -RestartExpected $false -StartedAt $startedAt -PublishedAt $publishedAt `
            -CompletedAt ([System.DateTimeOffset]::UtcNow.ToString('o')) -ProjectRootSha256 ([string]$project.sha256) `
            -FinalSaveProof $finalSaveProof
        $receiptSha256 = [string]$runtimeReceipt.receiptSha256
    }
    catch {
        # Never turn an intentional clean stop into a Task Scheduler restart.
        # Missing evidence remains visible through receiptPersisted=false.
        $receiptSha256 = $null
        $receiptErrorCode = if ([string]$_.Exception.Message -match '^BOOTSTRAP_[A-Z0-9_]{1,96}$') {
            [string]$_.Exception.Message
        }
        else { 'BOOTSTRAP_RUNTIME_RECEIPT_WRITE_FAILED' }
    }
    $stateLease.Dispose()
    $stateLease = $null
    [ordered]@{
        protocol = $protocol
        operation = 'start'
        state = 'completed'
        outcome = 'server-exited'
        runtimeOutcome = 'clean-exit'
        attemptId = $attemptId
        version = $version
        bindingId = $bindingId
        receiptPersisted = $null -ne $receiptSha256
        receiptErrorCode = $receiptErrorCode
        receiptSha256 = $receiptSha256
    } | ConvertTo-DysonGameBootstrapJsonLine
    exit 0
}
catch {
    $runtimeOutcome = if ($releaseCompleted) { 'finalization-failure' } `
        elseif ($null -ne $publishedAt) { 'abnormal-exit' } else { 'startup-failure' }
    $receiptSha256 = $null
    $receiptErrorCode = $null
    if ($null -ne $context) {
        try {
            $runtimeReceipt = Write-DysonGameBootstrapRuntimeReceipt -Context $context `
                -AttemptId $attemptId -BindingId $bindingId -Version $version -Outcome $runtimeOutcome `
                -ErrorCode $errorCode -RestartExpected $true -StartedAt $startedAt -PublishedAt $publishedAt `
                -CompletedAt ([System.DateTimeOffset]::UtcNow.ToString('o')) `
                -ProjectRootSha256 $(if ($null -ne $project) { [string]$project.sha256 } else { $null })
            $receiptSha256 = [string]$runtimeReceipt.receiptSha256
        }
        catch {
            $receiptSha256 = $null
            $receiptErrorCode = if ([string]$_.Exception.Message -match '^BOOTSTRAP_[A-Z0-9_]{1,96}$') {
                [string]$_.Exception.Message
            }
            else { 'BOOTSTRAP_RUNTIME_RECEIPT_WRITE_FAILED' }
        }
    }
    [ordered]@{
        protocol = $protocol
        operation = 'start'
        state = 'failed'
        errorCode = $errorCode
        runtimeOutcome = $runtimeOutcome
        restartExpected = $true
        attemptId = $attemptId
        version = $version
        bindingId = $bindingId
        receiptPersisted = $null -ne $receiptSha256
        receiptErrorCode = $receiptErrorCode
        receiptSha256 = $receiptSha256
    } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
    exit 1
}
finally {
    if ($stateLease) { $stateLease.Dispose() }
    if ($startLease) { $startLease.Dispose() }
    if ($startInvocation) { try { $startInvocation.process.Dispose() } catch { } }
}
