# Isolated fake backend for qualification protocol v2 self-tests.

Set-StrictMode -Version 2.0

if ($null -eq (Get-Command Throw-DysonQualificationV2Error -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')
}

$script:DysonQualificationV2FakeMarker = 'DYSON_QUALIFICATION_FAKE_ROOT_V2'
$script:DysonQualificationV2FakeStateProtocol = 'DYSON_QUALIFICATION_FAKE_STATE_V2'

function New-DysonQualificationV2FixtureProtectionPoint {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$ProtectionPointId,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )
    if (-not (Test-DysonQualificationV2Uuid -Value $ProtectionPointId)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROTECTION_POINT_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2ProtectionProtocol
        schemaVersion = 2
        protectionPointId = $ProtectionPointId
        targetIdentity = [string]$Profile.targetIdentity
        createdAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(20)
        savePairSha256 = Get-DysonQualificationV2Sha256 -Value ('fake-pair:' + [string]$Profile.profileId)
        evidenceSha256 = Get-DysonQualificationV2Sha256 -Value ('fake-evidence:' + [string]$Profile.profileId)
    }
}

function Assert-DysonQualificationV2FakeRoot {
    param([Parameter(Mandatory)][string]$FakeRoot, [switch]$RequireMarker)
    try {
        $full = [IO.Path]::GetFullPath($FakeRoot).TrimEnd('\', '/')
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if (-not $full.StartsWith($temporary + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) { throw 'outside temp' }
        $relative = $full.Substring($temporary.Length + 1)
        if ($relative -cnotmatch '^dyson-qualification-v2-selftest-[0-9a-f]{32}(?:[\\/][A-Za-z0-9_.-]+)*$') {
            throw 'invalid root'
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
            $marker = Get-Item -LiteralPath (Join-Path $full '.dyson-qualification-v2-fake') -Force -ErrorAction Stop
            if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $marker.Length -gt 128 -or
                [IO.File]::ReadAllText($marker.FullName, [Text.Encoding]::UTF8).Trim() -cne $script:DysonQualificationV2FakeMarker) {
                throw 'invalid marker'
            }
        }
        return $full
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_ROOT_INVALID' }
}

function Write-DysonQualificationV2FakeText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [switch]$CreateNew
    )
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($parent)
    }
    if ($CreateNew) {
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        return
    }
    $temporary = Join-Path $parent ('.fake-write-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $backup = Join-Path $parent ('.fake-backup-' + [guid]::NewGuid().ToString('N'))
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) }
            finally { if (Test-Path -LiteralPath $backup -PathType Leaf) { [IO.File]::Delete($backup) } }
        }
        else { [IO.File]::Move($temporary, $Path) }
    }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } }
}

function Get-DysonQualificationV2FakeStatePath {
    param([Parameter(Mandatory)][string]$FakeRoot)
    $root = Assert-DysonQualificationV2FakeRoot -FakeRoot $FakeRoot -RequireMarker
    return Join-Path $root 'fake-state.json'
}

function Read-DysonQualificationV2FakeState {
    param([Parameter(Mandatory)][string]$FakeRoot)
    try {
        $path = Get-DysonQualificationV2FakeStatePath -FakeRoot $FakeRoot
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt 131072) { throw 'invalid state' }
        $state = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        if ([string]$state.protocol -cne $script:DysonQualificationV2FakeStateProtocol -or
            [int]$state.schemaVersion -ne 2 -or
            [int]$state.controlPid -lt 4 -or [int]$state.dspPid -lt 4) { throw 'invalid state' }
        return $state
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_STATE_INVALID' }
}

function Write-DysonQualificationV2FakeState {
    param([Parameter(Mandatory)][string]$FakeRoot, [Parameter(Mandatory)]$State)
    Write-DysonQualificationV2FakeText -Path (Get-DysonQualificationV2FakeStatePath -FakeRoot $FakeRoot) `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $State) + "`n")
}

function Initialize-DysonQualificationV2FakeFixture {
    param(
        [Parameter(Mandatory)][string]$FakeRoot,
        [Parameter(Mandatory)][string]$TargetIdentity
    )
    if (-not (Test-DysonQualificationV2Digest -Value $TargetIdentity)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_STATE_INVALID'
    }
    $root = Assert-DysonQualificationV2FakeRoot -FakeRoot $FakeRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { [void][IO.Directory]::CreateDirectory($root) }
    if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_ROOT_NOT_EMPTY'
    }
    Write-DysonQualificationV2FakeText -Path (Join-Path $root '.dyson-qualification-v2-fake') `
        -Text ($script:DysonQualificationV2FakeMarker + "`n") -CreateNew
    foreach ($name in @('state','protected-system','protected-app','protected-data','protected-save',
        'protected-backup','disposable')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $root $name))
    }
    Write-DysonQualificationV2FakeText -Path (Join-Path (Join-Path $root 'disposable') '.dyson-qualification-disposable') `
        -Text ('DYSON_QUALIFICATION_DISPOSABLE_V2' + "`n") -CreateNew
    $state = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2FakeStateProtocol
        schemaVersion = 2
        targetIdentity = $TargetIdentity
        controlPid = 4101
        dspPid = 5101
        controlGeneration = 1
        dspGeneration = 1
        storageAvailable = $true
        pressureFilePresent = $false
        otherProcessGeneration = 1
        otherVolumeGeneration = 1
        networkMutationCount = 0
        saveMutationCount = 0
        broadPathMutationCount = 0
        compensationCount = 0
        actionCounts = [pscustomobject][ordered]@{
            controlPlaneRestart = 0
            dspCrashRecovery = 0
            storageInterruption = 0
            diskPressure = 0
        }
    }
    Write-DysonQualificationV2FakeState -FakeRoot $root -State $state
    return $state
}

function Invoke-DysonQualificationV2FakeInspect {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][string]$FakeRoot,
        [Parameter(Mandatory)][datetimeoffset]$IntentCreatedAtUtc
    )
    $state = Read-DysonQualificationV2FakeState -FakeRoot $FakeRoot
    switch ([string]$Request.action) {
        'control-plane-restart' {
            if ([int]$state.controlPid -ne [int]$Request.parameters.expectedPid) {
                return [pscustomobject]@{ state = 'completed'; outcomeCode = 'CONTROL_PLANE_RESTART_VERIFIED' }
            }
            return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'ACTION_NOT_APPLIED_SAFE' }
        }
        'dsp-crash-recovery' {
            if ([int]$state.dspPid -ne [int]$Request.parameters.expectedPid) {
                return [pscustomobject]@{ state = 'completed'; outcomeCode = 'DSP_CRASH_RECOVERY_VERIFIED' }
            }
            return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'ACTION_NOT_APPLIED_SAFE' }
        }
        'storage-interruption' {
            if ([bool]$state.storageAvailable) {
                return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'STORAGE_AVAILABLE' }
            }
            return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'STORAGE_RECOVERY_REQUIRED' }
        }
        'disk-pressure' {
            if ([bool]$state.pressureFilePresent) {
                return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'DISK_PRESSURE_CLEANUP_REQUIRED' }
            }
            return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'DISK_PRESSURE_ABSENT' }
        }
    }
}

function Invoke-DysonQualificationV2FakeExecute {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][string]$FakeRoot,
        [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc,
        [Parameter(Mandatory)][datetimeoffset]$IntentCreatedAtUtc,
        [Parameter(Mandatory)][ValidateSet('None','Timeout','EffectThenExit','CompensationFailure')][string]$Injection
    )
    $state = Read-DysonQualificationV2FakeState -FakeRoot $FakeRoot
    if ($Injection -in @('Timeout','CompensationFailure')) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_TIMEOUT'
    }
    switch ([string]$Request.action) {
        'control-plane-restart' {
            if ([int]$state.controlPid -ne [int]$Request.parameters.expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
            }
            $state.controlGeneration = [int]$state.controlGeneration + 1
            $state.controlPid = [int]$state.controlPid + 100
            $state.actionCounts.controlPlaneRestart = [int]$state.actionCounts.controlPlaneRestart + 1
            $outcome = 'CONTROL_PLANE_RESTART_VERIFIED'
        }
        'dsp-crash-recovery' {
            if ([int]$state.dspPid -ne [int]$Request.parameters.expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
            }
            $state.dspGeneration = [int]$state.dspGeneration + 1
            $state.dspPid = [int]$state.dspPid + 100
            $state.actionCounts.dspCrashRecovery = [int]$state.actionCounts.dspCrashRecovery + 1
            $outcome = 'DSP_CRASH_RECOVERY_VERIFIED'
        }
        'storage-interruption' {
            $state.storageAvailable = $false
            $state.actionCounts.storageInterruption = [int]$state.actionCounts.storageInterruption + 1
            if ($Injection -cne 'EffectThenExit') { $state.storageAvailable = $true }
            $outcome = 'STORAGE_INTERRUPTION_RECOVERED'
        }
        'disk-pressure' {
            $state.pressureFilePresent = $true
            $state.actionCounts.diskPressure = [int]$state.actionCounts.diskPressure + 1
            if ($Injection -cne 'EffectThenExit') { $state.pressureFilePresent = $false }
            $outcome = 'DISK_PRESSURE_RELIEVED'
        }
    }
    Write-DysonQualificationV2FakeState -FakeRoot $FakeRoot -State $state
    if ($Injection -ceq 'EffectThenExit') {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT'
    }
    return [pscustomobject]@{ success = $true; outcomeCode = $outcome }
}

function Invoke-DysonQualificationV2FakeCompensate {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][string]$FakeRoot,
        [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc,
        [Parameter(Mandatory)][datetimeoffset]$IntentCreatedAtUtc,
        [Parameter(Mandatory)][ValidateSet('None','Timeout','EffectThenExit','CompensationFailure')][string]$Injection
    )
    if ($Injection -ceq 'CompensationFailure') {
        return [pscustomobject]@{ success = $false; outcomeCode = 'COMPENSATION_FAILED' }
    }
    $state = Read-DysonQualificationV2FakeState -FakeRoot $FakeRoot
    switch ([string]$Request.action) {
        'control-plane-restart' {
            if ([int]$state.controlPid -eq [int]$Request.parameters.expectedPid) {
                $state.controlGeneration = [int]$state.controlGeneration + 1
                $state.controlPid = [int]$state.controlPid + 100
            }
            $outcome = 'CONTROL_PLANE_COMPENSATION_VERIFIED'
        }
        'dsp-crash-recovery' {
            if ([int]$state.dspPid -eq [int]$Request.parameters.expectedPid) {
                $state.dspGeneration = [int]$state.dspGeneration + 1
                $state.dspPid = [int]$state.dspPid + 100
            }
            $outcome = 'DSP_COMPENSATION_VERIFIED'
        }
        'storage-interruption' {
            $state.storageAvailable = $true
            $outcome = 'STORAGE_COMPENSATION_VERIFIED'
        }
        'disk-pressure' {
            $state.pressureFilePresent = $false
            $outcome = 'DISK_PRESSURE_COMPENSATION_VERIFIED'
        }
    }
    $state.compensationCount = [int]$state.compensationCount + 1
    Write-DysonQualificationV2FakeState -FakeRoot $FakeRoot -State $state
    return [pscustomobject]@{ success = $true; outcomeCode = $outcome }
}
