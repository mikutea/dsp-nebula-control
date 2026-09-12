[CmdletBinding()]
param([AllowNull()][string]$TestRoot)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SoakObservationV2.Common.ps1')
if ([string]::IsNullOrWhiteSpace($TestRoot)) { $TestRoot = Join-Path $PSScriptRoot '..\..\..\..\.codex-temp\qualification' }

$results = New-Object System.Collections.Generic.List[string]
function Add-SoakSelfTestResult { param([Parameter(Mandatory)][string]$Name) [void]$results.Add($Name) }
function Assert-SoakSelfTest { param([Parameter(Mandatory)][bool]$Condition,[Parameter(Mandatory)][string]$Message) if (-not $Condition) { throw $Message } }
function Assert-SoakSelfTestFailure {
    param([Parameter(Mandatory)][scriptblock]$Action,[Parameter(Mandatory)][string]$ExpectedCode,[Parameter(Mandatory)][string]$Message)
    $actual = $null
    try { [void](& $Action) } catch { $actual = Get-DysonSoakV2ErrorCode -Exception $_.Exception }
    if ([string]$actual -cne $ExpectedCode) { throw ($Message+'; expected='+$ExpectedCode+'; actual='+[string]$actual) }
}
function Copy-SoakSelfTestValue { param([Parameter(Mandatory)]$Value) return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) | ConvertFrom-Json }
function Get-SoakSelfTestDigest { param([Parameter(Mandatory)][char]$Character) return 'sha256:'+([string]::new($Character,64)) }
function Update-SoakSelfTestObservationDigest { param([Parameter(Mandatory)]$Observation) $Observation.observationSha256=Get-DysonSoakV2ObservationDigest -Observation $Observation; return $Observation }
function Update-SoakSelfTestTelemetryDigests {
    param([Parameter(Mandatory)]$Observation)
    $previous = $null
    foreach ($segment in @($Observation.telemetry.segments)) {
        $segment.previousSegmentSha256 = $previous
        $segment.segmentSha256 = Get-DysonSoakV2SegmentDigest -Segment $segment
        $previous = [string]$segment.segmentSha256
    }
    $Observation.telemetry.segmentsRootSha256 = Get-DysonSoakV2SegmentsRootDigest -SubjectBindingSha256 ([string]$Observation.subjectBindingSha256) -Segments @($Observation.telemetry.segments)
    return Update-SoakSelfTestObservationDigest -Observation $Observation
}
function New-SoakSelfTestInput {
    param([Parameter(Mandatory)][string]$Kind,[Parameter(Mandatory)][datetimeoffset]$NowUtc)
    $policy = Get-DysonSoakV2Policy -Kind $Kind
    $elapsed = [int64]$policy.minimumElapsedSeconds
    $samples = [int64]$policy.minimumSampleCount
    $completed = $NowUtc.AddMinutes(-1)
    $started = $completed.AddSeconds(-$elapsed)
    $frequency = [int64]1000000
    $firstTicks = [int64]1000000000000
    $lastTicks = $firstTicks+($elapsed*$frequency)
    $segments = New-Object System.Collections.Generic.List[object]
    $segmentCount = [int64]($elapsed/3600)
    for ($index=0; $index -lt $segmentCount; $index++) {
        $firstSequence = if ($index -eq 0) { [int64]0 } else { [int64]($index*240+1) }
        $lastSequence = [int64](($index+1)*240)
        [void]$segments.Add([pscustomobject][ordered]@{
            segmentIndex = [int64]$index
            firstSampleSequence = $firstSequence
            lastSampleSequence = $lastSequence
            sampleCount = [int64]($lastSequence-$firstSequence+1)
            firstMonotonicTicks = [int64]($firstTicks+($firstSequence*15*$frequency))
            lastMonotonicTicks = [int64]($firstTicks+($lastSequence*15*$frequency))
            maximumGapSeconds = [int64]15
            segmentPayloadSha256 = Get-SoakSelfTestDigest -Character ([char]('0123456789abcdef'[$index%16]))
        })
    }
    $d = [ordered]@{}
    foreach ($pair in @(@('runtime','1'),@('manifest','2'),@('profile','3'),@('mod','4'),@('vm','5'),@('world','6'),@('pair','7'),@('saveManifest','8'),@('clock','9'),@('join','a'),@('reconnect','b'),@('firstSave','c'),@('lastSave','d'),@('saveChain','e'),@('alerts','f'))) { $d[[string]$pair[0]] = Get-SoakSelfTestDigest -Character ([char][string]$pair[1]) }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_SOAK_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        observationId = if ($Kind -ceq 'six-hour') { '71000000-0000-0000-0000-000000000001' } else { '71000000-0000-0000-0000-000000000002' }
        kind = $Kind
        runId = if ($Kind -ceq 'six-hour') { '72000000-0000-0000-0000-000000000001' } else { '72000000-0000-0000-0000-000000000002' }
        targetIdentity = 'fixture-dyson-vm'
        releaseIdentity = [pscustomobject][ordered]@{ releaseVersion='0.1.0-rc.1';subjectCommit=[string]::new('a',40);runtimePayloadSha256=$d.runtime;releaseManifestSha256=$d.manifest }
        workloadProfile = [pscustomobject][ordered]@{ profileId='late-game-6h-v1';profileSha256=$d.profile;representativeLateGame=$true;normalMultiplayer=$true;simulationPaused=$false;workloadReduced=$false;targetUps=60;modLockSha256=$d.mod;vmAllocationSha256=$d.vm }
        saveBaseline = [pscustomobject][ordered]@{ worldBindingSha256=$d.world;savePairSha256=$d.pair;saveManifestSha256=$d.saveManifest;pairedFilesIntact=$true;representativeLateGame=$true }
        observationWindow = [pscustomobject][ordered]@{ observerClass='independent-monotonic-observer';clockClass='real-monotonic';clockSource='host-monotonic-counter';clockMode='real-elapsed';virtualClock=$false;boundedClock=$false;continuousObserver=$true;startedAtUtc=ConvertTo-DysonQualificationV2Utc -Value $started;completedAtUtc=ConvertTo-DysonQualificationV2Utc -Value $completed;monotonicFrequencyHz=$frequency;firstMonotonicTicks=$firstTicks;lastMonotonicTicks=$lastTicks;accumulatedMonotonicTicks=($lastTicks-$firstTicks);elapsedMonotonicSeconds=$elapsed;clockAttestationSha256=$d.clock }
        telemetry = [pscustomobject][ordered]@{ sampleCount=$samples;firstSampleSequence=0;lastSampleSequence=($samples-1);firstMonotonicTicks=$firstTicks;lastMonotonicTicks=$lastTicks;maximumGapSeconds=15;segments=$segments.ToArray() }
        health = [pscustomobject][ordered]@{
            ups = [pscustomobject][ordered]@{ coveredSamples=$samples;runningSamples=$samples;atOrAbove55UpsSamples=$samples;targetUps=60;minimumQualifiedUps=55 }
            cpu = [pscustomobject][ordered]@{ coveredSamples=$samples;hostCpuP95BasisPoints=7500;hottestCoreAtOrAbove97Samples=0;eligibleBottleneckSamples=$samples;singleCoreBottleneckSamples=0 }
            memory = [pscustomobject][ordered]@{ coveredSamples=$samples;peakUsedBasisPoints=7000 }
            disk = [pscustomobject][ordered]@{ coveredSamples=$samples;projectPeakUsedBasisPoints=7000;projectMinimumFreeMiB=20480;savePeakUsedBasisPoints=7000;saveMinimumFreeMiB=20480 }
            gameProcess = [pscustomobject][ordered]@{ coveredSamples=$samples;healthySamples=$samples;presentSamples=$samples;unexpectedRestartCount=0 }
            controlPlane = [pscustomobject][ordered]@{ coveredSamples=$samples;healthySamples=$samples;unexpectedRestartCount=0 }
            bridge = [pscustomobject][ordered]@{ coveredSamples=$samples;healthySamples=$samples;generationStable=$true;unexpectedRestartCount=0 }
        }
        externalSession = [pscustomobject][ordered]@{ publicHost='join.example.com';networkClass='public-external';protocol='nebula';reachabilityOnly=$false;clientPseudonym='client:sha256:'+([string]::new('c',64));initialJoinReceiptSha256=$d.join;reconnectReceiptSha256=$d.reconnect;initialJoinAtUtc=ConvertTo-DysonQualificationV2Utc -Value $started.AddMinutes(15);reconnectAtUtc=ConvertTo-DysonQualificationV2Utc -Value $completed.AddMinutes(-15);sameWorld=$true;worldBindingSha256=$d.world;savePairSha256=$d.pair }
        saves = [pscustomobject][ordered]@{ acknowledgementCount=[int64]$policy.minimumSaveAcknowledgements;maximumAcknowledgementGapSeconds=600;firstAcknowledgementAtUtc=ConvertTo-DysonQualificationV2Utc -Value $started;lastAcknowledgementAtUtc=ConvertTo-DysonQualificationV2Utc -Value $completed;firstAcknowledgementSha256=$d.firstSave;lastAcknowledgementSha256=$d.lastSave;acknowledgementChainSha256=$d.saveChain;allAcknowledged=$true;pairStable=$true;worldBindingSha256=$d.world;savePairSha256=$d.pair }
        outcome = [pscustomobject][ordered]@{ crashCount=0;recoveryRequiredCount=0;dataLossEventCount=0;workloadInterruptionCount=0;clockAnomalyCount=0;criticalHealthSamples=0;mandatoryHealthChecksPassed=$true }
        alerts = [pscustomobject][ordered]@{ criticalAlertCount=0;unresolvedAlertCount=0;conclusion='no-actionable-alerts';alertLedgerSha256=$d.alerts }
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $completed
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(29)
    }
}

$allowedRoot = [IO.Path]::GetFullPath($TestRoot)
[void][IO.Directory]::CreateDirectory($allowedRoot)
$fullTestRoot = [IO.Path]::GetFullPath((Join-Path $allowedRoot ('dyson-soak-selftest-'+[guid]::NewGuid().ToString('N'))))
if (-not $fullTestRoot.StartsWith($allowedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'self-test path escaped' }
[void][IO.Directory]::CreateDirectory($fullTestRoot)
try {
    $now = [datetimeoffset]::ParseExact('2026-09-05T14:00:00.000Z','yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
    $sixInput = New-SoakSelfTestInput -Kind 'six-hour' -NowUtc $now
    $six = New-DysonSoakObservationV2 -InputValue $sixInput
    $sixResult = Assert-DysonSoakObservationV2 -Observation $six -ExpectedObservationId $sixInput.observationId -ExpectedKind $sixInput.kind -ExpectedRunId $sixInput.runId -ExpectedTargetIdentity $sixInput.targetIdentity -ExpectedReleaseVersion $sixInput.releaseIdentity.releaseVersion -ExpectedSubjectCommit $sixInput.releaseIdentity.subjectCommit -ExpectedRuntimePayloadSha256 $sixInput.releaseIdentity.runtimePayloadSha256 -ExpectedReleaseManifestSha256 $sixInput.releaseIdentity.releaseManifestSha256 -ExpectedWorkloadProfileSha256 $sixInput.workloadProfile.profileSha256 -ExpectedSavePairSha256 $sixInput.saveBaseline.savePairSha256 -NowUtc $now
    Assert-SoakSelfTest -Condition ([bool]$sixResult.qualified -and [int64]$six.telemetry.sampleCount -eq 1441) -Message 'six-hour minimum failed'
    Add-SoakSelfTestResult 'six-hour-exact-minimum-accepted'

    $seventyTwoInput = New-SoakSelfTestInput -Kind 'seventy-two-hour' -NowUtc $now
    $seventyTwo = New-DysonSoakObservationV2 -InputValue $seventyTwoInput
    $seventyTwoResult = Assert-DysonSoakObservationV2 -Observation $seventyTwo -ExpectedKind 'seventy-two-hour' -NowUtc $now
    Assert-SoakSelfTest -Condition ([bool]$seventyTwoResult.qualified -and [int64]$seventyTwo.telemetry.sampleCount -eq 17281 -and @($seventyTwo.telemetry.segments).Count -eq 72) -Message 'seventy-two-hour minimum failed'
    Add-SoakSelfTestResult 'seventy-two-hour-exact-minimum-accepted-with-compact-segments'

    $statusOnly = Copy-SoakSelfTestValue $six
    $statusOnly | Add-Member -NotePropertyName status -NotePropertyValue 'verified'
    [void](Update-SoakSelfTestObservationDigest -Observation $statusOnly)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $statusOnly -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_INVALID' 'status shortcut accepted'
    Add-SoakSelfTestResult 'status-only-rejected'

    foreach ($clockProperty in @('virtualClock','boundedClock')) {
        $badClock = Copy-SoakSelfTestValue $six
        $badClock.observationWindow.$clockProperty = $true
        [void](Update-SoakSelfTestObservationDigest -Observation $badClock)
        Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $badClock -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID' ('clock mode accepted: '+$clockProperty)
    }
    Add-SoakSelfTestResult 'virtual-and-bounded-clocks-rejected'

    $short = Copy-SoakSelfTestValue $six
    $short.observationWindow.elapsedMonotonicSeconds = 21599
    [void](Update-SoakSelfTestObservationDigest -Observation $short)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $short -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_CLOCK_INVALID' 'one-second-short soak accepted'
    Add-SoakSelfTestResult 'one-second-short-rejected'

    $oneSampleShort = Copy-SoakSelfTestValue $six
    $oneSampleShort.telemetry.sampleCount = 1440
    [void](Update-SoakSelfTestObservationDigest -Observation $oneSampleShort)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $oneSampleShort -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID' 'one-sample-short soak accepted'
    Add-SoakSelfTestResult 'one-sample-short-rejected'

    $declaredGap = Copy-SoakSelfTestValue $six
    $declaredGap.telemetry.maximumGapSeconds = 31
    [void](Update-SoakSelfTestObservationDigest -Observation $declaredGap)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $declaredGap -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_TELEMETRY_INVALID' '31-second maximum gap accepted'
    Add-SoakSelfTestResult 'declared-gap-over-thirty-rejected'

    $boundaryGap = Copy-SoakSelfTestValue $six
    $boundaryGap.telemetry.segments[1].firstMonotonicTicks = [int64]$boundaryGap.telemetry.segments[0].lastMonotonicTicks+31000000
    [void](Update-SoakSelfTestTelemetryDigests -Observation $boundaryGap)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $boundaryGap -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_GAP_INVALID' 're-digested segment boundary gap accepted'
    Add-SoakSelfTestResult 'segment-gap-over-thirty-rejected-after-redigest'

    $sequenceTamper = Copy-SoakSelfTestValue $six
    $sequenceTamper.telemetry.segments[2].firstSampleSequence = [int64]$sequenceTamper.telemetry.segments[2].firstSampleSequence+1
    [void](Update-SoakSelfTestTelemetryDigests -Observation $sequenceTamper)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $sequenceTamper -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_SEGMENT_INVALID' 're-digested sample sequence tamper accepted'
    Add-SoakSelfTestResult 'segment-sequence-tamper-rejected-after-redigest'

    $crossRun = Copy-SoakSelfTestValue $six
    $crossRun.externalSession.subjectBindingSha256 = Get-SoakSelfTestDigest '0'
    [void](Update-SoakSelfTestObservationDigest -Observation $crossRun)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $crossRun -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID' 'cross-run external session accepted'
    Add-SoakSelfTestResult 'cross-run-splice-rejected'

    $crossRelease = Copy-SoakSelfTestValue $six
    $crossRelease.health.subjectBindingSha256 = Get-SoakSelfTestDigest '0'
    [void](Update-SoakSelfTestObservationDigest -Observation $crossRelease)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $crossRelease -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' 'cross-release health accepted'
    Add-SoakSelfTestResult 'cross-release-splice-rejected'

    $crossSave = Copy-SoakSelfTestValue $six
    $crossSave.saves.savePairSha256 = Get-SoakSelfTestDigest '0'
    [void](Update-SoakSelfTestObservationDigest -Observation $crossSave)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $crossSave -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID' 'cross-save splice accepted'
    Add-SoakSelfTestResult 'cross-save-splice-rejected'

    $reachability = Copy-SoakSelfTestValue $six
    $reachability.externalSession.networkClass = 'private-lan'
    $reachability.externalSession.protocol = 'tcp'
    $reachability.externalSession.reachabilityOnly = $true
    [void](Update-SoakSelfTestObservationDigest -Observation $reachability)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $reachability -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_EXTERNAL_INVALID' 'HTTP/TCP-only result accepted'
    Add-SoakSelfTestResult 'non-external-http-tcp-only-rejected'

    foreach ($outcomeName in @('crashCount','recoveryRequiredCount','dataLossEventCount')) {
        $badOutcome = Copy-SoakSelfTestValue $six
        $badOutcome.outcome.$outcomeName = 1
        [void](Update-SoakSelfTestObservationDigest -Observation $badOutcome)
        Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $badOutcome -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_OUTCOME_INVALID' ('nonzero outcome accepted: '+$outcomeName)
    }
    Add-SoakSelfTestResult 'crash-recovery-required-and-data-loss-rejected'

    $sparseSaves = Copy-SoakSelfTestValue $six
    $sparseSaves.saves.acknowledgementCount = 36
    [void](Update-SoakSelfTestObservationDigest -Observation $sparseSaves)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $sparseSaves -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_SAVE_INVALID' 'insufficient periodic save acknowledgements accepted'
    Add-SoakSelfTestResult 'periodic-save-floor-enforced'

    $cpuHot = Copy-SoakSelfTestValue $six
    $cpuHot.health.cpu.hostCpuP95BasisPoints = 9001
    [void](Update-SoakSelfTestObservationDigest -Observation $cpuHot)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $cpuHot -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_HEALTH_INVALID' 'CPU threshold violation accepted'
    Add-SoakSelfTestResult 'health-thresholds-enforced'

    $badAlerts = Copy-SoakSelfTestValue $six
    $badAlerts.alerts.unresolvedAlertCount = 1
    [void](Update-SoakSelfTestObservationDigest -Observation $badAlerts)
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $badAlerts -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_ALERT_INVALID' 'unresolved alert accepted'
    Add-SoakSelfTestResult 'alert-conclusion-enforced'

    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $six -NowUtc $now.AddHours(2) } 'DYSON_SOAK_OBSERVATION_V2_STALE' 'expired soak accepted'
    Add-SoakSelfTestResult 'expiry-enforced'

    $digestTamper = Copy-SoakSelfTestValue $six
    $digestTamper.observationSha256 = Get-SoakSelfTestDigest '0'
    Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 -Observation $digestTamper -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_DIGEST_INVALID' 'self digest tamper accepted'
    Add-SoakSelfTestResult 'self-digest-enforced'

    foreach ($case in @(@('ExpectedRunId','72000000-0000-0000-0000-000000000099'),@('ExpectedTargetIdentity','other-fixture-target'),@('ExpectedReleaseVersion','9.9.9'),@('ExpectedSubjectCommit',[string]::new('b',40)),@('ExpectedRuntimePayloadSha256',(Get-SoakSelfTestDigest '0')))) {
        $splat = @{ Observation=$six;NowUtc=$now }
        $splat[[string]$case[0]] = [string]$case[1]
        Assert-SoakSelfTestFailure { Assert-DysonSoakObservationV2 @splat } 'DYSON_SOAK_OBSERVATION_V2_BINDING_INVALID' ('expected binding accepted: '+$case[0])
    }
    Add-SoakSelfTestResult 'independent-expected-bindings-enforced'

    Assert-SoakSelfTestFailure { ConvertFrom-DysonSoakV2StrictJson -Text '{"protocol":"one","\u0070rotocol":"two"}' } 'DYSON_SOAK_OBSERVATION_V2_DUPLICATE_JSON_KEY' 'duplicate JSON key accepted'
    Add-SoakSelfTestResult 'duplicate-json-key-rejected'

    $inputPath = Join-Path $fullTestRoot 'input.json'
    $outputPath = Join-Path $fullTestRoot 'observation.json'
    [IO.File]::WriteAllText($inputPath,(ConvertTo-DysonQualificationV2CanonicalJson -Value $sixInput),(New-Object Text.UTF8Encoding -ArgumentList $false))
    $generator = & (Join-Path $PSScriptRoot 'New-DysonSoakObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now | ConvertFrom-Json
    $validator = & (Join-Path $PSScriptRoot 'Test-DysonSoakObservationV2.ps1') -ObservationPath $outputPath -ExpectedKind 'six-hour' -ExpectedRunId $sixInput.runId -ExpectedTargetIdentity $sixInput.targetIdentity -ExpectedReleaseVersion $sixInput.releaseIdentity.releaseVersion -ExpectedSubjectCommit $sixInput.releaseIdentity.subjectCommit -ExpectedRuntimePayloadSha256 $sixInput.releaseIdentity.runtimePayloadSha256 -ExpectedReleaseManifestSha256 $sixInput.releaseIdentity.releaseManifestSha256 -ExpectedWorkloadProfileSha256 $sixInput.workloadProfile.profileSha256 -ExpectedSavePairSha256 $sixInput.saveBaseline.savePairSha256 -NowUtc $now | ConvertFrom-Json
    Assert-SoakSelfTest -Condition ([bool]$generator.qualified -and [bool]$validator.qualified -and -not [bool]$validator.networkTouched -and -not [bool]$validator.productionChanged) -Message 'wrapper behavior failed'
    Assert-SoakSelfTestFailure { & (Join-Path $PSScriptRoot 'New-DysonSoakObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now } 'DYSON_SOAK_OBSERVATION_V2_OUTPUT_EXISTS' 'existing output overwritten'
    Add-SoakSelfTestResult 'canonical-create-new-and-read-only-validator'

    $schema = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'dyson-soak-observation-v2.schema.json') | ConvertFrom-Json
    Assert-SoakSelfTest -Condition ([string]$schema.properties.protocol.const -ceq $script:DysonSoakV2Protocol -and -not [bool]$schema.additionalProperties -and $null -eq $schema.properties.PSObject.Properties['status'] -and [int64]$schema.allOf[1].then.properties.telemetry.properties.sampleCount.minimum -eq 17281) -Message 'schema drift'
    Add-SoakSelfTestResult 'schema-exact-status-free-and-two-kind-bounds'

    [pscustomobject][ordered]@{
        protocol = 'DYSON_SOAK_OBSERVATION_SELFTEST_V2'
        schemaVersion = 2
        status = 'passed'
        runtime = 'Windows PowerShell 5.1 compatible'
        runtimeVersion = $PSVersionTable.PSVersion.ToString()
        testCount = $results.Count
        passedCount = $results.Count
        tests = @($results | ForEach-Object { $_ })
        sixHourFixtureSegments = 6
        seventyTwoHourFixtureSegments = 72
        fixturePublicHost = 'join.example.com'
        fixtureOnly = $true
        actualWaitPerformed = $false
        networkTouched = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
} finally {
    if (Test-Path -LiteralPath $fullTestRoot) {
        $resolved = [IO.Path]::GetFullPath($fullTestRoot)
        if ($resolved.StartsWith($allowedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -cmatch '^dyson-soak-selftest-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
