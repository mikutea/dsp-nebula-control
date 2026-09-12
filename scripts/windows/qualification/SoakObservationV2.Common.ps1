# Copyright (c) Dyson Control contributors.
# Strict read-only six-hour and seventy-two-hour soak observation v2.

Set-StrictMode -Version 2.0
if ($null -eq (Get-Command -Name Get-DysonQualificationV2ObjectDigest -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1') }

$script:DysonSoakV2Protocol = 'DYSON_SOAK_OBSERVATION_V2'
$script:DysonSoakV2InputProtocol = 'DYSON_SOAK_OBSERVATION_INPUT_V2'
$script:DysonSoakV2MaximumBytes = [int64](4MB)

function New-DysonSoakV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}
function Throw-DysonSoakV2Error { param([Parameter(Mandatory)][string]$Code) throw (New-DysonSoakV2Exception -Code $Code) }
function Get-DysonSoakV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '(DYSON_SOAK_OBSERVATION_V2_[A-Z0-9_]+)') { return [string]$Matches[1] }
    return 'DYSON_SOAK_OBSERVATION_V2_UNEXPECTED_FAILURE'
}
function Assert-DysonSoakV2Exact {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string[]]$Names,[Parameter(Mandatory)][string]$Code)
    try { Assert-DysonQualificationV2ExactProperties -Value $Value -Names $Names -Code $Code }
    catch { Throw-DysonSoakV2Error -Code $Code }
}
function Test-DysonSoakV2Integer {
    param([AllowNull()]$Value,[int64]$Minimum,[int64]$Maximum)
    if (-not (Test-DysonQualificationV2Integer -Value $Value)) { return $false }
    return [int64]$Value -ge $Minimum -and [int64]$Value -le $Maximum
}
function Test-DysonSoakV2Hostname {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value.Length -le 253 -and $Value -ceq $Value.ToLowerInvariant() -and $Value -cmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
}
function ConvertFrom-DysonSoakV2Utc {
    param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][string]$Code)
    try { return ConvertFrom-DysonQualificationV2Utc -Value $Value -Code $Code }
    catch { Throw-DysonSoakV2Error -Code $Code }
}
function Get-DysonSoakV2UnsignedValue {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$ExcludedName)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { [string]$_.Name -cne $ExcludedName } | Sort-Object -Property Name -CaseSensitive)) { $result[[string]$property.Name] = $property.Value }
    return [pscustomobject]$result
}
function Get-DysonSoakV2ObservationDigest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonSoakV2UnsignedValue -Value $Observation -ExcludedName 'observationSha256')
}
function Get-DysonSoakV2SegmentDigest {
    param([Parameter(Mandatory)]$Segment)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonSoakV2UnsignedValue -Value $Segment -ExcludedName 'segmentSha256')
}
function Get-DysonSoakV2SegmentsRootDigest {
    param([Parameter(Mandatory)][string]$SubjectBindingSha256,[Parameter(Mandatory)][object[]]$Segments)
    return Get-DysonQualificationV2ObjectDigest -Value ([ordered]@{ domain='DYSON_SOAK_OBSERVATION_V2_SEGMENTS_ROOT'; subjectBindingSha256=$SubjectBindingSha256; segmentSha256=@($Segments | ForEach-Object { [string]$_.segmentSha256 }) })
}
function Get-DysonSoakV2SubjectBindingDigest {
    param([Parameter(Mandatory)]$Value)
    return Get-DysonQualificationV2ObjectDigest -Value ([ordered]@{
        domain = 'DYSON_SOAK_OBSERVATION_V2_SUBJECT'
        kind = [string]$Value.kind
        runId = [string]$Value.runId
        targetIdentity = [string]$Value.targetIdentity
        releaseVersion = [string]$Value.releaseIdentity.releaseVersion
        subjectCommit = [string]$Value.releaseIdentity.subjectCommit
        runtimePayloadSha256 = [string]$Value.releaseIdentity.runtimePayloadSha256
        releaseManifestSha256 = [string]$Value.releaseIdentity.releaseManifestSha256
        workloadProfileSha256 = [string]$Value.workloadProfile.profileSha256
        representativeSavePairSha256 = [string]$Value.saveBaseline.savePairSha256
        worldBindingSha256 = [string]$Value.saveBaseline.worldBindingSha256
    })
}
function Copy-DysonSoakV2Value {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) | ConvertFrom-Json
}
function Add-DysonSoakV2SubjectBinding {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$SubjectBindingSha256)
    $copy = Copy-DysonSoakV2Value -Value $Value
    $copy | Add-Member -NotePropertyName subjectBindingSha256 -NotePropertyValue $SubjectBindingSha256
    return $copy
}
function Get-DysonSoakV2Policy {
    param([Parameter(Mandatory)][string]$Kind)
    switch -CaseSensitive ($Kind) {
        'six-hour' { return [pscustomobject][ordered]@{ minimumElapsedSeconds=[int64]21600; minimumSampleCount=[int64]1441; minimumSaveAcknowledgements=[int64]37 } }
        'seventy-two-hour' { return [pscustomobject][ordered]@{ minimumElapsedSeconds=[int64]259200; minimumSampleCount=[int64]17281; minimumSaveAcknowledgements=[int64]433 } }
        default { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_KIND_INVALID' }
    }
}

function Assert-DysonSoakV2Input {
    param([Parameter(Mandatory)]$InputValue)
    $code = 'DYSON_SOAK_OBSERVATION_V2_INPUT_INVALID'
    Assert-DysonSoakV2Exact -Value $InputValue -Names @('protocol','schemaVersion','observationId','kind','runId','targetIdentity','releaseIdentity','workloadProfile','saveBaseline','observationWindow','telemetry','health','externalSession','saves','outcome','alerts','observedAtUtc','expiresAtUtc') -Code $code
    if ([string]$InputValue.protocol -cne $script:DysonSoakV2InputProtocol -or -not (Test-DysonSoakV2Integer -Value $InputValue.schemaVersion -Minimum 2 -Maximum 2)) { Throw-DysonSoakV2Error -Code $code }
    [void](Get-DysonSoakV2Policy -Kind ([string]$InputValue.kind))
}

function New-DysonSoakObservationV2 {
    param([Parameter(Mandatory)]$InputValue)
    Assert-DysonSoakV2Input -InputValue $InputValue
    $subjectBindingSha256 = Get-DysonSoakV2SubjectBindingDigest -Value $InputValue
    $telemetryInput = $InputValue.telemetry
    $segments = New-Object System.Collections.Generic.List[object]
    $previousSegmentSha256 = $null
    foreach ($sourceSegment in @($telemetryInput.segments)) {
        $segment = Add-DysonSoakV2SubjectBinding -Value $sourceSegment -SubjectBindingSha256 $subjectBindingSha256
        $segment | Add-Member -NotePropertyName previousSegmentSha256 -NotePropertyValue $previousSegmentSha256
        $segment | Add-Member -NotePropertyName segmentSha256 -NotePropertyValue $null
        $segment.segmentSha256 = Get-DysonSoakV2SegmentDigest -Segment $segment
        [void]$segments.Add($segment)
        $previousSegmentSha256 = [string]$segment.segmentSha256
    }
    $telemetry = [pscustomobject][ordered]@{
        sampleCount = $telemetryInput.sampleCount
        firstSampleSequence = $telemetryInput.firstSampleSequence
        lastSampleSequence = $telemetryInput.lastSampleSequence
        firstMonotonicTicks = $telemetryInput.firstMonotonicTicks
        lastMonotonicTicks = $telemetryInput.lastMonotonicTicks
        maximumGapSeconds = $telemetryInput.maximumGapSeconds
        segmentCount = $segments.Count
        segments = $segments.ToArray()
        segmentsRootSha256 = $null
        subjectBindingSha256 = $subjectBindingSha256
    }
    $telemetry.segmentsRootSha256 = Get-DysonSoakV2SegmentsRootDigest -SubjectBindingSha256 $subjectBindingSha256 -Segments $segments.ToArray()
    $observation = [pscustomobject][ordered]@{
        protocol = $script:DysonSoakV2Protocol
        schemaVersion = 2
        observationId = [string]$InputValue.observationId
        kind = [string]$InputValue.kind
        runId = [string]$InputValue.runId
        targetIdentity = [string]$InputValue.targetIdentity
        releaseIdentity = $InputValue.releaseIdentity
        subjectBindingSha256 = $subjectBindingSha256
        workloadProfile = Add-DysonSoakV2SubjectBinding -Value $InputValue.workloadProfile -SubjectBindingSha256 $subjectBindingSha256
        saveBaseline = Add-DysonSoakV2SubjectBinding -Value $InputValue.saveBaseline -SubjectBindingSha256 $subjectBindingSha256
        observationWindow = Add-DysonSoakV2SubjectBinding -Value $InputValue.observationWindow -SubjectBindingSha256 $subjectBindingSha256
        telemetry = $telemetry
        health = Add-DysonSoakV2SubjectBinding -Value $InputValue.health -SubjectBindingSha256 $subjectBindingSha256
        externalSession = Add-DysonSoakV2SubjectBinding -Value $InputValue.externalSession -SubjectBindingSha256 $subjectBindingSha256
        saves = Add-DysonSoakV2SubjectBinding -Value $InputValue.saves -SubjectBindingSha256 $subjectBindingSha256
        outcome = Add-DysonSoakV2SubjectBinding -Value $InputValue.outcome -SubjectBindingSha256 $subjectBindingSha256
        alerts = Add-DysonSoakV2SubjectBinding -Value $InputValue.alerts -SubjectBindingSha256 $subjectBindingSha256
        observedAtUtc = [string]$InputValue.observedAtUtc
        expiresAtUtc = [string]$InputValue.expiresAtUtc
        observationSha256 = $null
    }
    $observation.observationSha256 = Get-DysonSoakV2ObservationDigest -Observation $observation
    return $observation
}

function Assert-DysonSoakV2BoundGroup {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$ExpectedSubjectBindingSha256,[Parameter(Mandatory)][string]$Code)
    if ([string]$Value.subjectBindingSha256 -cne $ExpectedSubjectBindingSha256) { Throw-DysonSoakV2Error -Code $Code }
}
function Assert-DysonSoakV2DigestFields {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string[]]$Names,[Parameter(Mandatory)][string]$Code)
    foreach ($name in $Names) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$Value.$name))) { Throw-DysonSoakV2Error -Code $Code } }
}
function Assert-DysonSoakV2Coverage {
    param([Parameter(Mandatory)][int64]$Covered,[Parameter(Mandatory)][int64]$Total,[Parameter(Mandatory)][int64]$MinimumPercent,[Parameter(Mandatory)][string]$Code)
    if ($Covered -lt 0 -or $Covered -gt $Total -or ($Covered * 100) -lt ($Total * $MinimumPercent)) { Throw-DysonSoakV2Error -Code $Code }
}
function Assert-DysonSoakV2TimeInWindow {
    param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][datetimeoffset]$Started,[Parameter(Mandatory)][datetimeoffset]$Completed,[Parameter(Mandatory)][string]$Code)
    $time = ConvertFrom-DysonSoakV2Utc -Value $Value -Code $Code
    if ($time -lt $Started -or $time -gt $Completed) { Throw-DysonSoakV2Error -Code $Code }
    return $time
}

function Assert-DysonSoakObservationV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [AllowNull()][string]$ExpectedObservationId,
        [AllowNull()][string]$ExpectedKind,
        [AllowNull()][string]$ExpectedRunId,
        [AllowNull()][string]$ExpectedTargetIdentity,
        [AllowNull()][string]$ExpectedReleaseVersion,
        [AllowNull()][string]$ExpectedSubjectCommit,
        [AllowNull()][string]$ExpectedRuntimePayloadSha256,
        [AllowNull()][string]$ExpectedReleaseManifestSha256,
        [AllowNull()][string]$ExpectedWorkloadProfileSha256,
        [AllowNull()][string]$ExpectedSavePairSha256,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $invalid = 'DYSON_SOAK_OBSERVATION_V2_INVALID'
    Assert-DysonSoakV2Exact -Value $Observation -Names @('protocol','schemaVersion','observationId','kind','runId','targetIdentity','releaseIdentity','subjectBindingSha256','workloadProfile','saveBaseline','observationWindow','telemetry','health','externalSession','saves','outcome','alerts','observedAtUtc','expiresAtUtc','observationSha256') -Code $invalid
    if ([string]$Observation.protocol -cne $script:DysonSoakV2Protocol -or -not (Test-DysonSoakV2Integer -Value $Observation.schemaVersion -Minimum 2 -Maximum 2) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.observationId)) -or -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.runId)) -or
        [string]::IsNullOrWhiteSpace([string]$Observation.targetIdentity) -or -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.subjectBindingSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.observationSha256))) { Throw-DysonSoakV2Error -Code $invalid }
    $policy = Get-DysonSoakV2Policy -Kind ([string]$Observation.kind)

    Assert-DysonSoakV2Exact -Value $Observation.releaseIdentity -Names @('releaseVersion','subjectCommit','runtimePayloadSha256','releaseManifestSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_RELEASE_INVALID'
    $release = $Observation.releaseIdentity
    if ([string]$release.releaseVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or [string]$release.subjectCommit -cnotmatch '^[0-9a-f]{40}$') { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_RELEASE_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $release -Names @('runtimePayloadSha256','releaseManifestSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_RELEASE_INVALID'

    $subjectBinding = Get-DysonSoakV2SubjectBindingDigest -Value $Observation
    if ([string]$Observation.subjectBindingSha256 -cne $subjectBinding) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SUBJECT_INVALID' }
    foreach ($binding in @(
        @($ExpectedObservationId,[string]$Observation.observationId),@($ExpectedKind,[string]$Observation.kind),@($ExpectedRunId,[string]$Observation.runId),@($ExpectedTargetIdentity,[string]$Observation.targetIdentity),
        @($ExpectedReleaseVersion,[string]$release.releaseVersion),@($ExpectedSubjectCommit,[string]$release.subjectCommit),@($ExpectedRuntimePayloadSha256,[string]$release.runtimePayloadSha256),
        @($ExpectedReleaseManifestSha256,[string]$release.releaseManifestSha256),@($ExpectedWorkloadProfileSha256,[string]$Observation.workloadProfile.profileSha256),@($ExpectedSavePairSha256,[string]$Observation.saveBaseline.savePairSha256))) {
        if (-not [string]::IsNullOrWhiteSpace([string]$binding[0]) -and [string]$binding[0] -cne [string]$binding[1]) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_BINDING_INVALID' }
    }

    Assert-DysonSoakV2Exact -Value $Observation.workloadProfile -Names @('profileId','profileSha256','representativeLateGame','normalMultiplayer','simulationPaused','workloadReduced','targetUps','modLockSha256','vmAllocationSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_WORKLOAD_INVALID'
    $workload = $Observation.workloadProfile
    Assert-DysonSoakV2BoundGroup -Value $workload -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_WORKLOAD_INVALID'
    if ([string]$workload.profileId -cne 'late-game-6h-v1' -or $workload.representativeLateGame -isnot [bool] -or -not [bool]$workload.representativeLateGame -or
        $workload.normalMultiplayer -isnot [bool] -or -not [bool]$workload.normalMultiplayer -or $workload.simulationPaused -isnot [bool] -or [bool]$workload.simulationPaused -or
        $workload.workloadReduced -isnot [bool] -or [bool]$workload.workloadReduced -or -not (Test-DysonSoakV2Integer -Value $workload.targetUps -Minimum 60 -Maximum 60)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_WORKLOAD_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $workload -Names @('profileSha256','modLockSha256','vmAllocationSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_WORKLOAD_INVALID'

    Assert-DysonSoakV2Exact -Value $Observation.saveBaseline -Names @('worldBindingSha256','savePairSha256','saveManifestSha256','pairedFilesIntact','representativeLateGame','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    $baseline = $Observation.saveBaseline
    Assert-DysonSoakV2BoundGroup -Value $baseline -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    if ($baseline.pairedFilesIntact -isnot [bool] -or -not [bool]$baseline.pairedFilesIntact -or $baseline.representativeLateGame -isnot [bool] -or -not [bool]$baseline.representativeLateGame) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $baseline -Names @('worldBindingSha256','savePairSha256','saveManifestSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'

    Assert-DysonSoakV2Exact -Value $Observation.observationWindow -Names @('observerClass','clockClass','clockSource','clockMode','virtualClock','boundedClock','continuousObserver','startedAtUtc','completedAtUtc','monotonicFrequencyHz','firstMonotonicTicks','lastMonotonicTicks','accumulatedMonotonicTicks','elapsedMonotonicSeconds','clockAttestationSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID'
    $window = $Observation.observationWindow
    Assert-DysonSoakV2BoundGroup -Value $window -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID'
    $started = ConvertFrom-DysonSoakV2Utc -Value ([string]$window.startedAtUtc) -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID'
    $completed = ConvertFrom-DysonSoakV2Utc -Value ([string]$window.completedAtUtc) -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID'
    if ([string]$window.observerClass -cne 'independent-monotonic-observer' -or [string]$window.clockClass -cne 'real-monotonic' -or [string]$window.clockSource -cne 'host-monotonic-counter' -or
        [string]$window.clockMode -cne 'real-elapsed' -or $window.virtualClock -isnot [bool] -or [bool]$window.virtualClock -or $window.boundedClock -isnot [bool] -or [bool]$window.boundedClock -or
        $window.continuousObserver -isnot [bool] -or -not [bool]$window.continuousObserver -or -not (Test-DysonSoakV2Integer -Value $window.monotonicFrequencyHz -Minimum 1000 -Maximum 1000000000) -or
        -not (Test-DysonSoakV2Integer -Value $window.firstMonotonicTicks -Minimum 0 -Maximum ([int64]::MaxValue)) -or -not (Test-DysonSoakV2Integer -Value $window.lastMonotonicTicks -Minimum 1 -Maximum ([int64]::MaxValue)) -or -not (Test-DysonSoakV2Integer -Value $window.accumulatedMonotonicTicks -Minimum 1 -Maximum ([int64]::MaxValue)) -or
        -not (Test-DysonSoakV2Integer -Value $window.elapsedMonotonicSeconds -Minimum $policy.minimumElapsedSeconds -Maximum 1209600) -or $completed -le $started) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $window -Names @('clockAttestationSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID'
    $frequency = [int64]$window.monotonicFrequencyHz
    $elapsed = [int64]$window.elapsedMonotonicSeconds
    $firstTicks = [int64]$window.firstMonotonicTicks
    $lastTicks = [int64]$window.lastMonotonicTicks
    if (($lastTicks - $firstTicks) -ne [int64]$window.accumulatedMonotonicTicks -or [int64]$window.accumulatedMonotonicTicks -ne ($elapsed * $frequency) -or [Math]::Abs(($completed-$started).TotalSeconds-$elapsed) -gt 5) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID' }

    Assert-DysonSoakV2Exact -Value $Observation.telemetry -Names @('sampleCount','firstSampleSequence','lastSampleSequence','firstMonotonicTicks','lastMonotonicTicks','maximumGapSeconds','segmentCount','segments','segmentsRootSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID'
    $telemetry = $Observation.telemetry
    Assert-DysonSoakV2BoundGroup -Value $telemetry -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID'
    if (-not (Test-DysonSoakV2Integer -Value $telemetry.sampleCount -Minimum $policy.minimumSampleCount -Maximum 1000000) -or
        -not (Test-DysonSoakV2Integer -Value $telemetry.firstSampleSequence -Minimum 0 -Maximum 0) -or -not (Test-DysonSoakV2Integer -Value $telemetry.lastSampleSequence -Minimum 0 -Maximum 999999) -or
        [int64]$telemetry.lastSampleSequence -ne ([int64]$telemetry.sampleCount-1) -or [int64]$telemetry.firstMonotonicTicks -ne $firstTicks -or [int64]$telemetry.lastMonotonicTicks -ne $lastTicks -or
        -not (Test-DysonSoakV2Integer -Value $telemetry.maximumGapSeconds -Minimum 1 -Maximum 30) -or -not (Test-DysonSoakV2Integer -Value $telemetry.segmentCount -Minimum 1 -Maximum 512) -or
        @($telemetry.segments).Count -ne [int64]$telemetry.segmentCount -or -not (Test-DysonQualificationV2Digest -Value ([string]$telemetry.segmentsRootSha256))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID' }
    $expectedSequence = [int64]0
    $expectedSegmentIndex = [int64]0
    $previousEndTicks = $null
    $previousSegmentSha256 = $null
    $countedSamples = [int64]0
    foreach ($segment in @($telemetry.segments)) {
        Assert-DysonSoakV2Exact -Value $segment -Names @('segmentIndex','firstSampleSequence','lastSampleSequence','sampleCount','firstMonotonicTicks','lastMonotonicTicks','maximumGapSeconds','segmentPayloadSha256','subjectBindingSha256','previousSegmentSha256','segmentSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID'
        Assert-DysonSoakV2BoundGroup -Value $segment -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID'
        if (-not (Test-DysonSoakV2Integer -Value $segment.segmentIndex -Minimum $expectedSegmentIndex -Maximum $expectedSegmentIndex) -or
            -not (Test-DysonSoakV2Integer -Value $segment.firstSampleSequence -Minimum $expectedSequence -Maximum $expectedSequence) -or
            -not (Test-DysonSoakV2Integer -Value $segment.lastSampleSequence -Minimum $expectedSequence -Maximum 999999) -or
            -not (Test-DysonSoakV2Integer -Value $segment.sampleCount -Minimum 1 -Maximum 100000) -or [int64]$segment.sampleCount -ne ([int64]$segment.lastSampleSequence-[int64]$segment.firstSampleSequence+1) -or
            -not (Test-DysonSoakV2Integer -Value $segment.firstMonotonicTicks -Minimum $firstTicks -Maximum $lastTicks) -or -not (Test-DysonSoakV2Integer -Value $segment.lastMonotonicTicks -Minimum $firstTicks -Maximum $lastTicks) -or
            [int64]$segment.lastMonotonicTicks -lt [int64]$segment.firstMonotonicTicks -or -not (Test-DysonSoakV2Integer -Value $segment.maximumGapSeconds -Minimum 1 -Maximum ([int64]$telemetry.maximumGapSeconds))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID' }
        Assert-DysonSoakV2DigestFields -Value $segment -Names @('segmentPayloadSha256','segmentSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID'
        if ($expectedSegmentIndex -eq 0) {
            if ($null -ne $segment.previousSegmentSha256 -or [int64]$segment.firstMonotonicTicks -ne $firstTicks) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID' }
        } else {
            if ([string]$segment.previousSegmentSha256 -cne [string]$previousSegmentSha256 -or -not (Test-DysonQualificationV2Digest -Value ([string]$segment.previousSegmentSha256))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID' }
            $boundaryTicks = [int64]$segment.firstMonotonicTicks - [int64]$previousEndTicks
            if ($boundaryTicks -le 0 -or $boundaryTicks -gt ([int64]$telemetry.maximumGapSeconds*$frequency)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_GAP_INVALID' }
        }
        $segmentIntervals = [int64]$segment.sampleCount-1
        $segmentTickSpan = [int64]$segment.lastMonotonicTicks-[int64]$segment.firstMonotonicTicks
        if ($segmentIntervals -eq 0 -and $segmentTickSpan -ne 0) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID' }
        if ($segmentIntervals -gt 0 -and ($segmentTickSpan -le 0 -or $segmentTickSpan -gt ($segmentIntervals*[int64]$segment.maximumGapSeconds*$frequency))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_GAP_INVALID' }
        if ([string]$segment.segmentSha256 -cne (Get-DysonSoakV2SegmentDigest -Segment $segment)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_DIGEST_INVALID' }
        $countedSamples += [int64]$segment.sampleCount
        $expectedSequence = [int64]$segment.lastSampleSequence+1
        $expectedSegmentIndex++
        $previousEndTicks = [int64]$segment.lastMonotonicTicks
        $previousSegmentSha256 = [string]$segment.segmentSha256
    }
    if ($countedSamples -ne [int64]$telemetry.sampleCount -or [int64]$previousEndTicks -ne $lastTicks -or [string]$telemetry.segmentsRootSha256 -cne (Get-DysonSoakV2SegmentsRootDigest -SubjectBindingSha256 $subjectBinding -Segments @($telemetry.segments))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID' }

    Assert-DysonSoakV2Exact -Value $Observation.health -Names @('ups','cpu','memory','disk','gameProcess','controlPlane','bridge','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    $health = $Observation.health
    Assert-DysonSoakV2BoundGroup -Value $health -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    $samples = [int64]$telemetry.sampleCount
    Assert-DysonSoakV2Exact -Value $health.ups -Names @('coveredSamples','runningSamples','atOrAbove55UpsSamples','targetUps','minimumQualifiedUps') -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    foreach ($name in @('coveredSamples','runningSamples','atOrAbove55UpsSamples')) { if (-not (Test-DysonSoakV2Integer -Value $health.ups.$name -Minimum 0 -Maximum $samples)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' } }
    if ([int64]$health.ups.runningSamples -gt [int64]$health.ups.coveredSamples -or [int64]$health.ups.atOrAbove55UpsSamples -gt [int64]$health.ups.runningSamples -or [int64]$health.ups.targetUps -ne 60 -or [int64]$health.ups.minimumQualifiedUps -ne 55) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.ups.coveredSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.ups.runningSamples) -Total $samples -MinimumPercent 99 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.ups.atOrAbove55UpsSamples) -Total ([int64]$health.ups.runningSamples) -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'

    Assert-DysonSoakV2Exact -Value $health.cpu -Names @('coveredSamples','hostCpuP95BasisPoints','hottestCoreAtOrAbove97Samples','eligibleBottleneckSamples','singleCoreBottleneckSamples') -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    foreach ($name in @('coveredSamples','hottestCoreAtOrAbove97Samples','eligibleBottleneckSamples','singleCoreBottleneckSamples')) { if (-not (Test-DysonSoakV2Integer -Value $health.cpu.$name -Minimum 0 -Maximum $samples)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' } }
    if (-not (Test-DysonSoakV2Integer -Value $health.cpu.hostCpuP95BasisPoints -Minimum 0 -Maximum 9000) -or [int64]$health.cpu.singleCoreBottleneckSamples -gt [int64]$health.cpu.eligibleBottleneckSamples -or
        ([int64]$health.cpu.hottestCoreAtOrAbove97Samples*100) -gt ($samples*10) -or ([int64]$health.cpu.singleCoreBottleneckSamples*100) -gt ([int64]$health.cpu.eligibleBottleneckSamples*5)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.cpu.coveredSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.cpu.eligibleBottleneckSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'

    Assert-DysonSoakV2Exact -Value $health.memory -Names @('coveredSamples','peakUsedBasisPoints') -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    if (-not (Test-DysonSoakV2Integer -Value $health.memory.coveredSamples -Minimum 0 -Maximum $samples) -or -not (Test-DysonSoakV2Integer -Value $health.memory.peakUsedBasisPoints -Minimum 0 -Maximum 9000)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.memory.coveredSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'

    Assert-DysonSoakV2Exact -Value $health.disk -Names @('coveredSamples','projectPeakUsedBasisPoints','projectMinimumFreeMiB','savePeakUsedBasisPoints','saveMinimumFreeMiB') -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
    if (-not (Test-DysonSoakV2Integer -Value $health.disk.coveredSamples -Minimum 0 -Maximum $samples) -or -not (Test-DysonSoakV2Integer -Value $health.disk.projectPeakUsedBasisPoints -Minimum 0 -Maximum 9000) -or
        -not (Test-DysonSoakV2Integer -Value $health.disk.savePeakUsedBasisPoints -Minimum 0 -Maximum 9000) -or -not (Test-DysonSoakV2Integer -Value $health.disk.projectMinimumFreeMiB -Minimum 10240 -Maximum ([int64]::MaxValue)) -or
        -not (Test-DysonSoakV2Integer -Value $health.disk.saveMinimumFreeMiB -Minimum 10240 -Maximum ([int64]::MaxValue))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
    Assert-DysonSoakV2Coverage -Covered ([int64]$health.disk.coveredSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'

    foreach ($componentName in @('gameProcess','controlPlane','bridge')) {
        $component = $health.$componentName
        $names = if ($componentName -ceq 'gameProcess') { @('coveredSamples','healthySamples','presentSamples','unexpectedRestartCount') } elseif ($componentName -ceq 'bridge') { @('coveredSamples','healthySamples','generationStable','unexpectedRestartCount') } else { @('coveredSamples','healthySamples','unexpectedRestartCount') }
        Assert-DysonSoakV2Exact -Value $component -Names $names -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
        foreach ($name in @('coveredSamples','healthySamples')) { if (-not (Test-DysonSoakV2Integer -Value $component.$name -Minimum 0 -Maximum $samples)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' } }
        if ([int64]$component.healthySamples -gt [int64]$component.coveredSamples -or -not (Test-DysonSoakV2Integer -Value $component.unexpectedRestartCount -Minimum 0 -Maximum 0)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
        Assert-DysonSoakV2Coverage -Covered ([int64]$component.coveredSamples) -Total $samples -MinimumPercent 95 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
        Assert-DysonSoakV2Coverage -Covered ([int64]$component.healthySamples) -Total ([int64]$component.coveredSamples) -MinimumPercent 99 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
        if ($componentName -ceq 'gameProcess') {
            if (-not (Test-DysonSoakV2Integer -Value $component.presentSamples -Minimum 0 -Maximum $samples)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
            Assert-DysonSoakV2Coverage -Covered ([int64]$component.presentSamples) -Total $samples -MinimumPercent 99 -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID'
        }
        if ($componentName -ceq 'bridge' -and ($component.generationStable -isnot [bool] -or -not [bool]$component.generationStable)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' }
    }

    Assert-DysonSoakV2Exact -Value $Observation.externalSession -Names @('publicHost','networkClass','protocol','reachabilityOnly','clientPseudonym','initialJoinReceiptSha256','reconnectReceiptSha256','initialJoinAtUtc','reconnectAtUtc','sameWorld','worldBindingSha256','savePairSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID'
    $external = $Observation.externalSession
    Assert-DysonSoakV2BoundGroup -Value $external -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID'
    if (-not (Test-DysonSoakV2Hostname -Value ([string]$external.publicHost)) -or [string]$external.networkClass -cne 'public-external' -or [string]$external.protocol -cne 'nebula' -or $external.reachabilityOnly -isnot [bool] -or [bool]$external.reachabilityOnly -or
        [string]$external.clientPseudonym -cnotmatch '^client:sha256:[0-9a-f]{64}$' -or $external.sameWorld -isnot [bool] -or -not [bool]$external.sameWorld -or
        [string]$external.worldBindingSha256 -cne [string]$baseline.worldBindingSha256 -or [string]$external.savePairSha256 -cne [string]$baseline.savePairSha256) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $external -Names @('initialJoinReceiptSha256','reconnectReceiptSha256','worldBindingSha256','savePairSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID'
    $joinAt = Assert-DysonSoakV2TimeInWindow -Value ([string]$external.initialJoinAtUtc) -Started $started -Completed $completed -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID'
    $reconnectAt = Assert-DysonSoakV2TimeInWindow -Value ([string]$external.reconnectAtUtc) -Started $started -Completed $completed -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID'
    if ($joinAt -ge $reconnectAt -or ($joinAt-$started).TotalSeconds -gt 3600 -or ($completed-$reconnectAt).TotalSeconds -gt 3600) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID' }

    Assert-DysonSoakV2Exact -Value $Observation.saves -Names @('acknowledgementCount','maximumAcknowledgementGapSeconds','firstAcknowledgementAtUtc','lastAcknowledgementAtUtc','firstAcknowledgementSha256','lastAcknowledgementSha256','acknowledgementChainSha256','allAcknowledged','pairStable','worldBindingSha256','savePairSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    $saves = $Observation.saves
    Assert-DysonSoakV2BoundGroup -Value $saves -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    if (-not (Test-DysonSoakV2Integer -Value $saves.acknowledgementCount -Minimum $policy.minimumSaveAcknowledgements -Maximum 100000) -or -not (Test-DysonSoakV2Integer -Value $saves.maximumAcknowledgementGapSeconds -Minimum 1 -Maximum 600) -or
        $saves.allAcknowledged -isnot [bool] -or -not [bool]$saves.allAcknowledged -or $saves.pairStable -isnot [bool] -or -not [bool]$saves.pairStable -or
        [string]$saves.worldBindingSha256 -cne [string]$baseline.worldBindingSha256 -or [string]$saves.savePairSha256 -cne [string]$baseline.savePairSha256) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID' }
    Assert-DysonSoakV2DigestFields -Value $saves -Names @('firstAcknowledgementSha256','lastAcknowledgementSha256','acknowledgementChainSha256','worldBindingSha256','savePairSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    $firstSaveAt = Assert-DysonSoakV2TimeInWindow -Value ([string]$saves.firstAcknowledgementAtUtc) -Started $started -Completed $completed -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    $lastSaveAt = Assert-DysonSoakV2TimeInWindow -Value ([string]$saves.lastAcknowledgementAtUtc) -Started $started -Completed $completed -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID'
    if ($firstSaveAt -ge $lastSaveAt -or ($firstSaveAt-$started).TotalSeconds -gt 600 -or ($completed-$lastSaveAt).TotalSeconds -gt 600 -or
        ($lastSaveAt-$firstSaveAt).TotalSeconds -gt (([int64]$saves.acknowledgementCount-1)*[int64]$saves.maximumAcknowledgementGapSeconds)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID' }

    Assert-DysonSoakV2Exact -Value $Observation.outcome -Names @('crashCount','recoveryRequiredCount','dataLossEventCount','workloadInterruptionCount','clockAnomalyCount','criticalHealthSamples','mandatoryHealthChecksPassed','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_OUTCOME_INVALID'
    $outcome = $Observation.outcome
    Assert-DysonSoakV2BoundGroup -Value $outcome -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_OUTCOME_INVALID'
    foreach ($name in @('crashCount','recoveryRequiredCount','dataLossEventCount','workloadInterruptionCount','clockAnomalyCount')) { if (-not (Test-DysonSoakV2Integer -Value $outcome.$name -Minimum 0 -Maximum 0)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_OUTCOME_INVALID' } }
    if (-not (Test-DysonSoakV2Integer -Value $outcome.criticalHealthSamples -Minimum 0 -Maximum $samples) -or ([int64]$outcome.criticalHealthSamples*100) -gt ($samples*1) -or
        $outcome.mandatoryHealthChecksPassed -isnot [bool] -or -not [bool]$outcome.mandatoryHealthChecksPassed) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_OUTCOME_INVALID' }

    Assert-DysonSoakV2Exact -Value $Observation.alerts -Names @('criticalAlertCount','unresolvedAlertCount','conclusion','alertLedgerSha256','subjectBindingSha256') -Code 'DYSON_SOAK_OBSERVATION_V2_ALERT_INVALID'
    $alerts = $Observation.alerts
    Assert-DysonSoakV2BoundGroup -Value $alerts -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_SOAK_OBSERVATION_V2_ALERT_INVALID'
    if (-not (Test-DysonSoakV2Integer -Value $alerts.criticalAlertCount -Minimum 0 -Maximum 0) -or -not (Test-DysonSoakV2Integer -Value $alerts.unresolvedAlertCount -Minimum 0 -Maximum 0) -or
        [string]$alerts.conclusion -cne 'no-actionable-alerts' -or -not (Test-DysonQualificationV2Digest -Value ([string]$alerts.alertLedgerSha256))) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_ALERT_INVALID' }

    $observed = ConvertFrom-DysonSoakV2Utc -Value ([string]$Observation.observedAtUtc) -Code $invalid
    $expires = ConvertFrom-DysonSoakV2Utc -Value ([string]$Observation.expiresAtUtc) -Code $invalid
    if ([Math]::Abs(($observed-$completed).TotalSeconds) -gt 1 -or $observed -gt $NowUtc.AddMinutes(1) -or $expires -le $observed -or $expires -gt $observed.AddHours(1) -or $NowUtc -ge $expires) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_STALE' }
    if ([string]$Observation.observationSha256 -cne (Get-DysonSoakV2ObservationDigest -Observation $Observation)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_DIGEST_INVALID' }
    return [pscustomobject][ordered]@{ protocol=$script:DysonSoakV2Protocol; observationId=[string]$Observation.observationId; kind=[string]$Observation.kind; runId=[string]$Observation.runId; targetIdentity=[string]$Observation.targetIdentity; releaseVersion=[string]$release.releaseVersion; subjectBindingSha256=$subjectBinding; observedAtUtc=[string]$Observation.observedAtUtc; expiresAtUtc=[string]$Observation.expiresAtUtc; observationSha256=[string]$Observation.observationSha256; qualified=$true }
}

function Assert-DysonSoakV2JsonKeysUnique {
    param([Parameter(Mandatory)][System.Xml.XmlNode]$Node)
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return }
    $typeAttribute = $Node.Attributes['type']
    if ($null -ne $typeAttribute -and [string]$typeAttribute.Value -ceq 'object') {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
            $itemAttribute = $child.Attributes['item']
            $name = if ($child.LocalName -ceq 'item' -and $child.NamespaceURI -ceq 'item' -and $null -ne $itemAttribute) { [string]$itemAttribute.Value } else { [string]$child.LocalName }
            if (-not $names.Add($name)) { Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_DUPLICATE_JSON_KEY' }
        }
    }
    foreach ($child in @($Node.ChildNodes)) { if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { Assert-DysonSoakV2JsonKeysUnique -Node $child } }
}
function ConvertFrom-DysonSoakV2StrictJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $bytes = $null
    $reader = $null
    try {
        Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
        $bytes = (New-Object System.Text.UTF8Encoding -ArgumentList $false,$true).GetBytes($Text)
        $quotas = New-Object System.Xml.XmlDictionaryReaderQuotas
        $quotas.MaxDepth = 96
        $quotas.MaxStringContentLength = [Math]::Max(1024,$bytes.Length)
        $quotas.MaxArrayLength = [Math]::Max(1024,$bytes.Length)
        $quotas.MaxBytesPerRead = [Math]::Min([Math]::Max(4096,$bytes.Length),4194304)
        $quotas.MaxNameTableCharCount = [Math]::Max(16384,$bytes.Length)
        $reader = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes,$quotas)
        $document = New-Object System.Xml.XmlDocument
        $document.PreserveWhitespace = $false
        $document.Load($reader)
        Assert-DysonSoakV2JsonKeysUnique -Node $document.DocumentElement
        return $Text | ConvertFrom-Json -ErrorAction Stop
    } catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_JSON_INVALID'
    } finally {
        if ($null -ne $reader) { $reader.Close() }
        if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    }
}
function Read-DysonSoakV2JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [int64]$item.Length -le 0 -or [int64]$item.Length -gt $script:DysonSoakV2MaximumBytes -or [IO.Path]::GetExtension($item.FullName) -cne '.json') { throw 'invalid file' }
        $bytes = [IO.File]::ReadAllBytes($item.FullName)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw 'bom' }
        $text = (New-Object System.Text.UTF8Encoding -ArgumentList $false,$true).GetString($bytes)
        return ConvertFrom-DysonSoakV2StrictJson -Text $text
    } catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonSoakV2Error -Code 'DYSON_SOAK_OBSERVATION_V2_FILE_INVALID'
    } finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    }
}
