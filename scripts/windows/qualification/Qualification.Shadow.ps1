Set-StrictMode -Version 2.0

if ($null -eq (Get-Command Invoke-DysonQualificationAction -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Qualification.Executor.ps1')
}

$script:DysonQualificationShadowProtocol = 'DYSON_QUALIFICATION_SHADOW_V1'
$script:DysonQualificationShadowMarker = 'DYSON_QUALIFICATION_SHADOW_ROOT_V1'
$script:DysonQualificationShadowStateFile = 'state.json'

function Write-DysonQualificationShadowText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )

    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($parent)
    }
    $temporary = Join-Path $parent ('.shadow-write-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $backup = Join-Path $parent ('.shadow-backup-' + [guid]::NewGuid().ToString('N'))
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) }
            finally { if (Test-Path -LiteralPath $backup -PathType Leaf) { [IO.File]::Delete($backup) } }
        }
        else { [IO.File]::Move($temporary, $Path) }
    }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } }
}

function Write-DysonQualificationShadowJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Write-DysonQualificationShadowText -Path $Path -Text (
        (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $Value) + "`n"
    )
}

function Assert-DysonQualificationShadowRootLocation {
    param([Parameter(Mandatory)][string]$ShadowRoot, [switch]$RequireMarker)

    try {
        $full = [IO.Path]::GetFullPath($ShadowRoot).TrimEnd('\', '/')
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        $prefix = $temporary + [IO.Path]::DirectorySeparatorChar
        if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'outside temporary root' }
        $relative = $full.Substring($prefix.Length)
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
            throw 'invalid relative root'
        }
        $current = $temporary
        foreach ($part in @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })) {
            $current = Join-Path $current $part
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
                if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw 'redirected root'
                }
            }
        }
        if ($RequireMarker) {
            $markerPath = Join-Path $full '.dyson-qualification-shadow'
            $marker = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
            if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $marker.Length -gt 128 -or
                [IO.File]::ReadAllText($marker.FullName, [Text.Encoding]::UTF8).Trim() -cne $script:DysonQualificationShadowMarker) {
                throw 'marker invalid'
            }
        }
        return $full
    }
    catch { Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_ROOT_INVALID' }
}

function Get-DysonQualificationShadowPath {
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [Parameter(Mandatory)][ValidateSet('State', 'Checkpoint', 'Receipt')][string]$Kind,
        [string]$RequestId
    )

    $root = Assert-DysonQualificationShadowRootLocation -ShadowRoot $ShadowRoot -RequireMarker
    switch ($Kind) {
        'State' { return Join-Path $root $script:DysonQualificationShadowStateFile }
        'Checkpoint' {
            if (-not (Test-DysonQualificationExecutorGuid -Value $RequestId)) {
                Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
            }
            return Join-Path (Join-Path $root 'checkpoints') ($RequestId + '.json')
        }
        'Receipt' {
            if (-not (Test-DysonQualificationExecutorGuid -Value $RequestId)) {
                Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
            }
            return Join-Path (Join-Path $root 'receipts') ($RequestId + '.json')
        }
    }
}

function Read-DysonQualificationShadowJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$MaximumBytes)

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt $MaximumBytes) { throw 'invalid file' }
        return ([IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop)
    }
    catch { Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID' }
}

function Read-DysonQualificationShadowState {
    param([Parameter(Mandatory)][string]$ShadowRoot)

    $path = Get-DysonQualificationShadowPath -ShadowRoot $ShadowRoot -Kind State
    $state = Read-DysonQualificationShadowJson -Path $path -MaximumBytes 1048576
    if ([string]$state.protocol -cne $script:DysonQualificationShadowProtocol -or
        [int]$state.schemaVersion -ne 1 -or
        -not (Test-DysonQualificationExecutorGuid -Value ([string]$state.fixtureId)) -or
        -not (Test-DysonQualificationExecutorIdentity -Value ([string]$state.targetIdentity)) -or
        [int64]$state.sequence -lt 0 -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$state.lastEvidenceDigest))) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    }
    [void](ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID')
    return $state
}

function Assert-DysonQualificationShadowCheckpoint {
    param(
        [Parameter(Mandatory)]$Checkpoint,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$RequestDigest
    )

    $required = @(
        'protocol', 'schemaVersion', 'checkpointId', 'requestId', 'requestDigest', 'action',
        'targetIdentity', 'state', 'createdAt', 'productionChanged'
    )
    $names = @($Checkpoint.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $required) {
        if ($names -cnotcontains $name) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_CHECKPOINT_INVALID'
        }
    }
    if ($names.Count -ne $required.Count -or
        [string]$Checkpoint.protocol -cne 'DYSON_QUALIFICATION_ACTION_CHECKPOINT_V1' -or
        [int]$Checkpoint.schemaVersion -ne 1 -or
        -not (Test-DysonQualificationExecutorGuid -Value ([string]$Checkpoint.checkpointId)) -or
        [string]$Checkpoint.checkpointId -cne [string]$Checkpoint.requestId -or
        [string]$Checkpoint.requestId -cne [string]$Request.requestId -or
        [string]$Checkpoint.requestDigest -cne $RequestDigest -or
        [string]$Checkpoint.action -cne [string]$Request.action -or
        [string]$Checkpoint.targetIdentity -cne [string]$State.targetIdentity -or
        [string]$Checkpoint.state -cne 'prepared' -or
        [bool]$Checkpoint.productionChanged) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_CHECKPOINT_INVALID'
    }
    [void](ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$Checkpoint.createdAt) `
        -Code 'DYSON_QUALIFICATION_CHECKPOINT_INVALID')
    return $true
}

function Write-DysonQualificationShadowState {
    param([Parameter(Mandatory)][string]$ShadowRoot, [Parameter(Mandatory)]$State)
    $path = Get-DysonQualificationShadowPath -ShadowRoot $ShadowRoot -Kind State
    Write-DysonQualificationShadowJson -Path $path -Value $State
}

function Initialize-DysonQualificationShadowFixture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [Parameter(Mandatory)][string]$FixtureId,
        [Parameter(Mandatory)][string]$TargetIdentity,
        [Parameter(Mandatory)][string]$VirtualNow
    )

    if (-not (Test-DysonQualificationExecutorGuid -Value $FixtureId) -or
        -not (Test-DysonQualificationExecutorIdentity -Value $TargetIdentity)) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_FIXTURE_INVALID'
    }
    [void](ConvertFrom-DysonQualificationExecutorUtc -Value $VirtualNow `
        -Code 'DYSON_QUALIFICATION_SHADOW_FIXTURE_INVALID')
    $root = Assert-DysonQualificationShadowRootLocation -ShadowRoot $ShadowRoot
    if (Test-Path -LiteralPath $root) {
        if (@(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop).Count -gt 0) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_ROOT_NOT_EMPTY'
        }
    }
    else { [void][IO.Directory]::CreateDirectory($root) }
    Write-DysonQualificationShadowText -Path (Join-Path $root '.dyson-qualification-shadow') `
        -Text ($script:DysonQualificationShadowMarker + "`n")
    foreach ($name in @('checkpoints', 'receipts')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $root $name))
    }
    $state = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationShadowProtocol
        schemaVersion = 1
        fixtureId = $FixtureId
        targetIdentity = $TargetIdentity
        virtualNow = $VirtualNow
        sequence = [int64]0
        lastEvidenceDigest = 'sha256:' + ('0' * 64)
        processGeneration = [int64]1
        controlState = 'running'
        gameState = 'running'
        storageState = 'available'
        diskPressurePercent = 0
        activeRelease = 'candidate'
        previousRelease = 'stable'
        gsManagerState = 'recoverable-disabled'
        savePairRevision = [int64]1
        manualRecoveryRequired = $false
        evidence = @()
        lastVirtualSoak = $null
    }
    Write-DysonQualificationShadowState -ShadowRoot $root -State $state
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationShadowProtocol
        schemaVersion = 1
        fixtureId = $FixtureId
        targetIdentity = $TargetIdentity
        state = 'initialized'
        virtualNow = $VirtualNow
        shadowOnly = $true
        productionChanged = $false
    }
}

function New-DysonQualificationShadowProtectionPoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [Parameter(Mandatory)][string]$ProtectionPointId,
        [int]$ValidityMinutes = 20
    )

    if (-not (Test-DysonQualificationExecutorGuid -Value $ProtectionPointId) -or
        $ValidityMinutes -lt 1 -or $ValidityMinutes -gt 60) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    }
    $state = Read-DysonQualificationShadowState -ShadowRoot $ShadowRoot
    $now = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    $unsigned = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationProtectionPointProtocol
        schemaVersion = 1
        protectionPointId = $ProtectionPointId
        targetIdentity = [string]$state.targetIdentity
        createdAt = ConvertTo-DysonQualificationExecutorUtc -Value $now
        expiresAt = ConvertTo-DysonQualificationExecutorUtc -Value $now.AddMinutes($ValidityMinutes)
        savePairDigest = Get-DysonQualificationExecutorSha256 -Value (
            [string]$state.fixtureId + ':' + [string]$state.savePairRevision + ':paired-save'
        )
    }
    return [pscustomobject][ordered]@{
        protocol = $unsigned.protocol
        schemaVersion = $unsigned.schemaVersion
        protectionPointId = $unsigned.protectionPointId
        targetIdentity = $unsigned.targetIdentity
        createdAt = $unsigned.createdAt
        expiresAt = $unsigned.expiresAt
        savePairDigest = $unsigned.savePairDigest
        evidenceDigest = Get-DysonQualificationExecutorObjectDigest -Value $unsigned
    }
}

function New-DysonQualificationShadowRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][ValidateSet('preview', 'execute')][string]$Mode,
        [Parameter(Mandatory)]$ProtectionPoint,
        [AllowNull()]$Parameters
    )

    if (-not (Test-DysonQualificationExecutorGuid -Value $RequestId) -or
        $script:DysonQualificationActions -cnotcontains $Action) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
    }
    $state = Read-DysonQualificationShadowState -ShadowRoot $ShadowRoot
    $now = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    if ($null -eq $Parameters) { $Parameters = [pscustomobject][ordered]@{} }
    $phrase = if ($Mode -ceq 'execute') {
        Get-DysonQualificationRequiredConfirmationPhrase -Action $Action -RequestId $RequestId
    }
    else { '' }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationActionRequestProtocol
        schemaVersion = 1
        requestId = $RequestId
        action = $Action
        mode = $Mode
        targetIdentity = [string]$state.targetIdentity
        issuedAt = ConvertTo-DysonQualificationExecutorUtc -Value $now
        maintenanceWindow = [pscustomobject][ordered]@{
            startAt = ConvertTo-DysonQualificationExecutorUtc -Value $now.AddMinutes(-5)
            endAt = ConvertTo-DysonQualificationExecutorUtc -Value $now.AddHours(1)
        }
        protectionPoint = $ProtectionPoint
        confirmationPhrase = $phrase
        parameters = $Parameters
    }
}

function Copy-DysonQualificationShadowValue {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $Value | ConvertFrom-Json)
}

function Invoke-DysonQualificationShadowEffect {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][string]$Injection
    )

    $durationSeconds = 1
    $summary = [ordered]@{}
    switch ([string]$Request.action) {
        'windows-restart' {
            $State.controlState = 'running'
            $State.gameState = 'running'
            $State.processGeneration = [int64]$State.processGeneration + 1
            $durationSeconds = 45
            $summary['recovered'] = $true
            $summary['bootIdentityChanged'] = $true
        }
        'control-plane-restart' {
            $State.controlState = 'running'
            $State.processGeneration = [int64]$State.processGeneration + 1
            $durationSeconds = 10
            $summary['recovered'] = $true
        }
        'dsp-crash-recovery' {
            $State.gameState = 'running'
            $State.processGeneration = [int64]$State.processGeneration + 1
            $durationSeconds = 20
            $summary['recovered'] = $true
            $summary['pairedSaveRevision'] = [int64]$State.savePairRevision
        }
        'storage-interruption' {
            $durationSeconds = [int]$Request.parameters.durationSeconds
            $State.storageState = 'available'
            $summary['recovered'] = $true
            $summary['interruptionSeconds'] = $durationSeconds
        }
        'disk-pressure' {
            $durationSeconds = [int]$Request.parameters.durationSeconds
            $State.diskPressurePercent = 0
            $summary['relieved'] = $true
            $summary['peakPercent'] = [int]$Request.parameters.targetPercent
        }
        'update-rollback' {
            $prior = [string]$State.activeRelease
            $State.activeRelease = [string]$State.previousRelease
            $State.previousRelease = $prior
            $durationSeconds = 30
            if ($Injection -ceq 'RollbackFailure') {
                $State.activeRelease = 'manual-recovery-required'
                $State.manualRecoveryRequired = $true
                return [pscustomobject][ordered]@{
                    success = $false
                    now = $NowUtc.AddSeconds($durationSeconds)
                    outcome = [pscustomobject][ordered]@{
                        code = 'DYSON_QUALIFICATION_SHADOW_ROLLBACK_FAILED'
                        manualRecoveryRequired = $true
                    }
                }
            }
            $summary['previousReleaseActivated'] = $true
        }
        'gsmanager-switch' {
            if ([string]$State.gsManagerState -ceq 'recoverable-disabled') {
                $State.gsManagerState = 'shadow-active'
            }
            else { $State.gsManagerState = 'recoverable-disabled' }
            $durationSeconds = 30
            $summary['recoverable'] = $true
            $summary['state'] = [string]$State.gsManagerState
        }
        'save-restore' {
            $State.savePairRevision = [int64]$State.savePairRevision + 1
            $durationSeconds = 15
            $summary['pairedSaveRestored'] = $true
            $summary['pairedSaveRevision'] = [int64]$State.savePairRevision
        }
    }
    return [pscustomobject][ordered]@{
        success = $true
        now = $NowUtc.AddSeconds($durationSeconds)
        outcome = [pscustomobject]$summary
    }
}

function New-DysonQualificationShadowReceipt {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Checkpoint,
        [Parameter(Mandatory)]$Effect
    )

    $observedAt = ConvertTo-DysonQualificationExecutorUtc -Value $Effect.now
    $unsigned = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationActionReceiptProtocol
        schemaVersion = 1
        requestId = [string]$Request.requestId
        requestDigest = [string]$Checkpoint.requestDigest
        action = [string]$Request.action
        mode = 'execute'
        status = if ([bool]$Effect.success) { 'passed' } else { 'failed' }
        targetIdentity = [string]$State.targetIdentity
        executedInShadow = $true
        productionChanged = $false
        sequence = [int64]$State.sequence + 1
        observedAt = $observedAt
        expiresAt = ConvertTo-DysonQualificationExecutorUtc -Value $Effect.now.AddHours(24)
        checkpointId = [string]$Checkpoint.checkpointId
        previousEvidenceDigest = [string]$State.lastEvidenceDigest
        rollback = [pscustomobject][ordered]@{
            defined = $true
            status = if ([bool]$Effect.success) { 'not-required' } else { 'failed' }
        }
        outcome = $Effect.outcome
    }
    $receipt = [pscustomobject][ordered]@{
        protocol = $unsigned.protocol
        schemaVersion = $unsigned.schemaVersion
        requestId = $unsigned.requestId
        requestDigest = $unsigned.requestDigest
        action = $unsigned.action
        mode = $unsigned.mode
        status = $unsigned.status
        reused = $false
        targetIdentity = $unsigned.targetIdentity
        executedInShadow = $unsigned.executedInShadow
        productionChanged = $unsigned.productionChanged
        sequence = $unsigned.sequence
        observedAt = $unsigned.observedAt
        expiresAt = $unsigned.expiresAt
        checkpointId = $unsigned.checkpointId
        previousEvidenceDigest = $unsigned.previousEvidenceDigest
        rollback = $unsigned.rollback
        outcome = $unsigned.outcome
        evidenceDigest = Get-DysonQualificationExecutorObjectDigest -Value $unsigned
    }
    return $receipt
}

function Invoke-DysonQualificationShadowAdapter {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][string]$ShadowRoot,
        [switch]$Resume,
        [Parameter(Mandatory)][ValidateSet('None', 'HardExitAfterCheckpoint', 'RollbackFailure')][string]$Injection
    )

    $root = Assert-DysonQualificationShadowRootLocation -ShadowRoot $ShadowRoot -RequireMarker
    $state = Read-DysonQualificationShadowState -ShadowRoot $root
    $now = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    [void](Assert-DysonQualificationExecutionGate -Request $Request `
        -ExpectedTargetIdentity ([string]$state.targetIdentity) -NowUtc $now)
    $requestDigest = Get-DysonQualificationActionRequestDigest -Request $Request
    $receiptPath = Get-DysonQualificationShadowPath -ShadowRoot $root -Kind Receipt `
        -RequestId ([string]$Request.requestId)
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        $existing = Read-DysonQualificationShadowJson -Path $receiptPath -MaximumBytes 65536
        [void](Assert-DysonQualificationActionReceipt -Receipt $existing)
        if ([string]$existing.requestDigest -cne $requestDigest) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_COLLISION'
        }
        $stateMatches = @(@($state.evidence) | Where-Object {
            $null -ne $_ -and [int64]$_.sequence -eq [int64]$existing.sequence -and
            [string]$_.evidenceDigest -ceq [string]$existing.evidenceDigest
        })
        if ($stateMatches.Count -ne 1 -or
            (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $stateMatches[0]) -cne
            (ConvertTo-DysonQualificationExecutorCanonicalJson -Value $existing)) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_STATE_MISMATCH'
        }
        $copy = Copy-DysonQualificationShadowValue -Value $existing
        $copy.reused = $true
        return $copy
    }
    if ([bool]$state.manualRecoveryRequired) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_MANUAL_RECOVERY_REQUIRED'
    }
    $checkpointPath = Get-DysonQualificationShadowPath -ShadowRoot $root -Kind Checkpoint `
        -RequestId ([string]$Request.requestId)
    $checkpoint = $null
    if (Test-Path -LiteralPath $checkpointPath -PathType Leaf) {
        if (-not $Resume) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_CHECKPOINT_RESUME_REQUIRED'
        }
        $checkpoint = Read-DysonQualificationShadowJson -Path $checkpointPath -MaximumBytes 32768
        [void](Assert-DysonQualificationShadowCheckpoint -Checkpoint $checkpoint -Request $Request `
            -State $state -RequestDigest $requestDigest)
    }
    else {
        if ($Resume) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_CHECKPOINT_NOT_FOUND'
        }
        $checkpoint = [pscustomobject][ordered]@{
            protocol = 'DYSON_QUALIFICATION_ACTION_CHECKPOINT_V1'
            schemaVersion = 1
            checkpointId = [string]$Request.requestId
            requestId = [string]$Request.requestId
            requestDigest = $requestDigest
            action = [string]$Request.action
            targetIdentity = [string]$state.targetIdentity
            state = 'prepared'
            createdAt = [string]$state.virtualNow
            productionChanged = $false
        }
        Write-DysonQualificationShadowJson -Path $checkpointPath -Value $checkpoint
    }
    if ($Injection -ceq 'HardExitAfterCheckpoint') {
        [Environment]::Exit(93)
    }
    $effect = Invoke-DysonQualificationShadowEffect -State $state -Request $Request `
        -NowUtc $now -Injection $Injection
    $receipt = New-DysonQualificationShadowReceipt -State $state -Request $Request `
        -Checkpoint $checkpoint -Effect $effect
    $state.virtualNow = [string]$receipt.observedAt
    $state.sequence = [int64]$receipt.sequence
    $state.lastEvidenceDigest = [string]$receipt.evidenceDigest
    $state.evidence = @(@($state.evidence) | Where-Object { $null -ne $_ }) + @($receipt)
    Write-DysonQualificationShadowJson -Path $receiptPath -Value $receipt
    Write-DysonQualificationShadowState -ShadowRoot $root -State $state
    [IO.File]::Delete($checkpointPath)
    if (-not [bool]$effect.success) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_ROLLBACK_FAILED'
    }
    return $receipt
}

function Set-DysonQualificationShadowVirtualNow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [Parameter(Mandatory)][string]$VirtualNow
    )

    $newNow = ConvertFrom-DysonQualificationExecutorUtc -Value $VirtualNow `
        -Code 'DYSON_QUALIFICATION_SHADOW_CLOCK_INVALID'
    $state = Read-DysonQualificationShadowState -ShadowRoot $ShadowRoot
    $oldNow = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    if ($newNow -lt $oldNow) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_CLOCK_INVALID'
    }
    $state.virtualNow = ConvertTo-DysonQualificationExecutorUtc -Value $newNow
    Write-DysonQualificationShadowState -ShadowRoot $ShadowRoot -State $state
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SHADOW_CLOCK_V1'
        virtualNow = [string]$state.virtualNow
        productionChanged = $false
    }
}

function Invoke-DysonQualificationShadowSoak {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ShadowRoot,
        [int]$Hours = 6
    )

    if ($Hours -ne 6) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_SOAK_DURATION_INVALID'
    }
    $state = Read-DysonQualificationShadowState -ShadowRoot $ShadowRoot
    $start = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$state.virtualNow) `
        -Code 'DYSON_QUALIFICATION_SHADOW_STATE_INVALID'
    $sampleDigests = @()
    for ($index = 1; $index -le 24; $index++) {
        $at = $start.AddMinutes(15 * $index)
        $sampleDigests += Get-DysonQualificationExecutorObjectDigest -Value ([pscustomobject][ordered]@{
            protocol = 'DYSON_QUALIFICATION_SHADOW_SOAK_SAMPLE_V1'
            sequence = $index
            observedAt = ConvertTo-DysonQualificationExecutorUtc -Value $at
            controlState = [string]$state.controlState
            gameState = [string]$state.gameState
            storageState = [string]$state.storageState
            virtualClock = $true
        })
    }
    $end = $start.AddHours(6)
    $report = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SHADOW_SOAK_V1'
        schemaVersion = 1
        status = 'passed'
        requestedHours = 6
        virtualElapsedHours = 6
        realElapsedSeconds = 0
        sampleCount = 24
        startedAt = ConvertTo-DysonQualificationExecutorUtc -Value $start
        endedAt = ConvertTo-DysonQualificationExecutorUtc -Value $end
        sampleChainDigest = Get-DysonQualificationExecutorObjectDigest -Value $sampleDigests
        virtualClock = $true
        qualifyingProductionEvidence = $false
        productionChanged = $false
    }
    $state.virtualNow = [string]$report.endedAt
    $state.lastVirtualSoak = $report
    Write-DysonQualificationShadowState -ShadowRoot $ShadowRoot -State $state
    return $report
}
