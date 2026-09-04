# Copyright (c) Dyson Control contributors.
# Fictional local-only tests for external join observation v2.

[CmdletBinding()]
param([AllowNull()][string]$TestRoot)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ExternalJoinObservationV2.Common.ps1')

if ([string]::IsNullOrWhiteSpace($TestRoot)) { $TestRoot = Join-Path $PSScriptRoot '..\..\..\..\.codex-temp\qualification' }
$results = New-Object System.Collections.Generic.List[string]

function Add-ExternalJoinSelfTestResult {
    param([Parameter(Mandatory)][string]$Name)
    [void]$results.Add($Name)
}

function Assert-ExternalJoinSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ExternalJoinSelfTestFailure {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$ExpectedCode, [Parameter(Mandatory)][string]$Message)
    $actualCode = $null
    try { [void](& $Action) }
    catch { $actualCode = Get-DysonExternalJoinObservationV2ErrorCode -Exception $_.Exception }
    if ([string]$actualCode -cne $ExpectedCode) { throw ($Message + '; expected=' + $ExpectedCode + '; actual=' + [string]$actualCode) }
}

function Copy-ExternalJoinSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) | ConvertFrom-Json
}

function Get-ExternalJoinSelfTestDigest {
    param([Parameter(Mandatory)][char]$Character)
    return 'sha256:' + [string]::new($Character, 64)
}

function Update-ExternalJoinSelfTestChain {
    param([Parameter(Mandatory)]$Observation)
    $predecessor = $null
    foreach ($event in @($Observation.events)) {
        $event.evidenceSha256 = Get-DysonQualificationV2ObjectDigest -Value $event.evidence
        $event.predecessorSha256 = $predecessor
        $event.eventSha256 = Get-DysonExternalJoinObservationV2EventDigest -EventValue $event
        $predecessor = [string]$event.eventSha256
    }
    $Observation.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $Observation
    return $Observation
}

function New-ExternalJoinSelfTestInput {
    param([Parameter(Mandatory)][datetimeoffset]$NowUtc)
    $digests = @{}
    foreach ($pair in @(@('runtime','1'),@('release','2'),@('server','3'),@('clientManifest','4'),@('clientBuild','5'),@('network','6'),@('dns','7'),@('certificate','8'),@('world','9'),@('saveReceipt','a'),@('savePair','b'),@('saveManifest','c'))) {
        $digests[[string]$pair[0]] = Get-ExternalJoinSelfTestDigest -Character ([char][string]$pair[1])
    }
    $pseudonym = 'client:sha256:' + [string]::new('d', 64)
    $initialSession = '51000000-0000-0000-0000-000000000001'
    $reconnectSession = '51000000-0000-0000-0000-000000000002'
    $initialChallenge = '52000000-0000-0000-0000-000000000001'
    $reconnectChallenge = '52000000-0000-0000-0000-000000000002'
    $saveRequestId = '53000000-0000-0000-0000-000000000001'
    $expires = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(29)
    $evidenceValues = @(
        [pscustomobject][ordered]@{ publicHost='join.example.com'; answerSetSha256=$digests.dns; classification='public-routable'; externalResolverObserved=$true },
        [pscustomobject][ordered]@{ sniAuthority='join.example.com'; negotiatedProtocol='tls13'; certificateSha256=$digests.certificate; certificateValid=$true; dnsNameMatched=$true },
        [pscustomobject][ordered]@{ hostHeaderAuthority='join.example.com'; path='/socket'; httpStatusCode=101; transport='wss' },
        [pscustomobject][ordered]@{ protocol='nebula'; transportEstablished=$true; serverHandshakeSha256=(Get-ExternalJoinSelfTestDigest -Character 'e') },
        [pscustomobject][ordered]@{ authenticated=$true; authenticationReceiptSha256=(Get-ExternalJoinSelfTestDigest -Character 'f') },
        [pscustomobject][ordered]@{ joined=$true; serverAuthoritative=$true; worldBindingSha256=$digests.world; joinReceiptSha256=(Get-ExternalJoinSelfTestDigest -Character '0') },
        [pscustomobject][ordered]@{ interactionClass='server-observed-gameplay'; serverObserved=$true; worldBindingSha256=$digests.world; interactionReceiptSha256=(Get-ExternalJoinSelfTestDigest -Character '1') },
        [pscustomobject][ordered]@{ saveRequestId=$saveRequestId; requested=$true; worldBindingSha256=$digests.world },
        [pscustomobject][ordered]@{ saveRequestId=$saveRequestId; serverAcknowledged=$true; saveReceiptSha256=$digests.saveReceipt; savePairSha256=$digests.savePair; saveManifestSha256=$digests.saveManifest },
        [pscustomobject][ordered]@{ cleanDisconnect=$true; serverObserved=$true; disconnectReceiptSha256=(Get-ExternalJoinSelfTestDigest -Character '2') },
        [pscustomobject][ordered]@{ publicHost='join.example.com'; transportStack='tls-wss-nebula'; freshQualificationSession=$true; reconnectChallengeId=$reconnectChallenge },
        [pscustomobject][ordered]@{ rejoined=$true; serverAuthoritative=$true; worldBindingSha256=$digests.world; savePairSha256=$digests.savePair; rejoinReceiptSha256=(Get-ExternalJoinSelfTestDigest -Character '3') }
    )
    $events = @()
    for ($index = 0; $index -lt $script:DysonExternalJoinObservationV2Events.Count; $index++) {
        $events += ,[pscustomobject][ordered]@{
            sequence = $index + 1
            event = $script:DysonExternalJoinObservationV2Events[$index]
            observerClass = $script:DysonExternalJoinObservationV2Observers[$index]
            qualificationSessionId = if ($index -le 9) { $initialSession } else { $reconnectSession }
            clientPseudonym = $pseudonym
            observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(-12 + $index)
            expiresAtUtc = $expires
            evidence = $evidenceValues[$index]
        }
    }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        observationId = '50000000-0000-0000-0000-000000000001'
        runId = '50000000-0000-0000-0000-000000000002'
        releaseIdentity = [pscustomobject][ordered]@{
            releaseVersion = '0.1.0-rc.1'; subjectCommit = [string]::new('a',40)
            runtimePayloadSha256 = $digests.runtime; releaseManifestSha256 = $digests.release
            serverManifestSha256 = $digests.server; clientManifestSha256 = $digests.clientManifest
        }
        publicEndpoint = [pscustomobject][ordered]@{
            scheme = 'wss'; publicHost = 'join.example.com'; port = 443; websocketPath = '/socket'
            dnsAnswerSetSha256 = $digests.dns; tlsCertificateSha256 = $digests.certificate
        }
        client = [pscustomobject][ordered]@{
            clientPseudonym = $pseudonym; pseudonymScope = 'one-run'; networkClass = 'public-external'
            sourceAddressCollected = $false; displayNameCollected = $false; accountIdCollected = $false; deviceIdCollected = $false
            clientBuildSha256 = $digests.clientBuild; clientManifestSha256 = $digests.clientManifest
            externalNetworkAttestationSha256 = $digests.network
        }
        sessionBinding = [pscustomobject][ordered]@{
            initialQualificationSessionId = $initialSession; reconnectQualificationSessionId = $reconnectSession
            initialChallengeId = $initialChallenge; reconnectChallengeId = $reconnectChallenge; worldBindingSha256 = $digests.world
        }
        saveBinding = [pscustomobject][ordered]@{
            saveRequestId = $saveRequestId; worldBindingSha256 = $digests.world; saveReceiptSha256 = $digests.saveReceipt
            savePairSha256 = $digests.savePair; saveManifestSha256 = $digests.saveManifest
        }
        events = $events
        observedAtUtc = [string]$events[11].observedAtUtc
        expiresAtUtc = $expires
    }
}

$allowedRoot = [IO.Path]::GetFullPath($TestRoot)
[void][IO.Directory]::CreateDirectory($allowedRoot)
$fullTestRoot = [IO.Path]::GetFullPath((Join-Path $allowedRoot ('dyson-external-join-selftest-' + [guid]::NewGuid().ToString('N'))))
if (-not $fullTestRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'self-test path escaped the allowed root' }
[void][IO.Directory]::CreateDirectory($fullTestRoot)

try {
    $now = [datetimeoffset]::ParseExact('2026-09-05T12:00:00.000Z','yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
    $fixtureInput = New-ExternalJoinSelfTestInput -NowUtc $now
    $observation = New-DysonExternalJoinObservationV2 -InputValue $fixtureInput
    $validated = Assert-DysonExternalJoinObservationV2 -Observation $observation -ExpectedObservationId $fixtureInput.observationId -ExpectedRunId $fixtureInput.runId -ExpectedSubjectCommit $fixtureInput.releaseIdentity.subjectCommit -ExpectedRuntimePayloadSha256 $fixtureInput.releaseIdentity.runtimePayloadSha256 -ExpectedReleaseManifestSha256 $fixtureInput.releaseIdentity.releaseManifestSha256 -ExpectedPublicHost 'join.example.com' -ExpectedClientPseudonym $fixtureInput.client.clientPseudonym -ExpectedSaveReceiptSha256 $fixtureInput.saveBinding.saveReceiptSha256 -ExpectedSavePairSha256 $fixtureInput.saveBinding.savePairSha256 -NowUtc $now
    Assert-ExternalJoinSelfTest -Condition ([bool]$validated.qualified -and @($observation.events).Count -eq 12) -Message 'valid external sequence did not qualify'
    Add-ExternalJoinSelfTestResult 'complete-strict-sequence-accepted'

    $statusOnly = Copy-ExternalJoinSelfTestValue -Value $observation
    $statusOnly | Add-Member -NotePropertyName status -NotePropertyValue 'verified'
    $statusOnly.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $statusOnly
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $statusOnly -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_INVALID' -Message 'status=verified escape hatch was accepted'
    Add-ExternalJoinSelfTestResult 'status-only-escape-hatch-rejected'

    $internalClient = Copy-ExternalJoinSelfTestValue -Value $observation
    $internalClient.client.networkClass = 'private-lan'
    $internalClient.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $internalClient
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $internalClient -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_CLIENT_INVALID' -Message 'internal-network client was accepted'
    Add-ExternalJoinSelfTestResult 'internal-client-rejected'

    $sensitive = Copy-ExternalJoinSelfTestValue -Value $observation
    $sensitive.client | Add-Member -NotePropertyName displayName -NotePropertyValue 'fictional-player'
    $sensitive.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $sensitive
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $sensitive -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_INVALID' -Message 'sensitive player identifier field was accepted'
    Add-ExternalJoinSelfTestResult 'raw-player-identity-field-rejected'

    $missing = Copy-ExternalJoinSelfTestValue -Value $observation
    $missing.events[1].evidence.PSObject.Properties.Remove('certificateValid')
    [void](Update-ExternalJoinSelfTestChain -Observation $missing)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $missing -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_EVENT_EVIDENCE_INVALID' -Message 'missing TLS evidence field was accepted'
    Add-ExternalJoinSelfTestResult 'missing-domain-field-rejected'

    $duplicate = Copy-ExternalJoinSelfTestValue -Value $observation
    $duplicate.events[5] = Copy-ExternalJoinSelfTestValue -Value $duplicate.events[4]
    [void](Update-ExternalJoinSelfTestChain -Observation $duplicate)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $duplicate -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' -Message 'duplicate sequence event was accepted'
    Add-ExternalJoinSelfTestResult 'duplicate-event-rejected'

    $outOfOrder = Copy-ExternalJoinSelfTestValue -Value $observation
    $swap = $outOfOrder.events[5]
    $outOfOrder.events[5] = $outOfOrder.events[6]
    $outOfOrder.events[6] = $swap
    [void](Update-ExternalJoinSelfTestChain -Observation $outOfOrder)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $outOfOrder -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' -Message 'out-of-order events were accepted'
    Add-ExternalJoinSelfTestResult 'out-of-order-event-rejected'

    $crossSession = Copy-ExternalJoinSelfTestValue -Value $observation
    $crossSession.events[6].qualificationSessionId = [string]$crossSession.sessionBinding.reconnectQualificationSessionId
    [void](Update-ExternalJoinSelfTestChain -Observation $crossSession)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $crossSession -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' -Message 'cross-session transcript splice was accepted'
    Add-ExternalJoinSelfTestResult 'cross-session-splice-rejected'

    $crossClient = Copy-ExternalJoinSelfTestValue -Value $observation
    $crossClient.events[6].clientPseudonym = 'client:sha256:' + [string]::new('e',64)
    [void](Update-ExternalJoinSelfTestChain -Observation $crossClient)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $crossClient -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' -Message 'cross-client transcript splice was accepted'
    Add-ExternalJoinSelfTestResult 'cross-client-splice-rejected'

    $crossRelease = Copy-ExternalJoinSelfTestValue -Value $observation
    $crossRelease.events[6].releaseBindingSha256 = Get-ExternalJoinSelfTestDigest -Character 'f'
    [void](Update-ExternalJoinSelfTestChain -Observation $crossRelease)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $crossRelease -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' -Message 'cross-release transcript splice was accepted'
    Add-ExternalJoinSelfTestResult 'cross-release-splice-rejected'

    $badSave = Copy-ExternalJoinSelfTestValue -Value $observation
    $badSave.events[8].evidence.saveReceiptSha256 = Get-ExternalJoinSelfTestDigest -Character '0'
    [void](Update-ExternalJoinSelfTestChain -Observation $badSave)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $badSave -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_EVENT_EVIDENCE_INVALID' -Message 'substituted save receipt was accepted'
    Add-ExternalJoinSelfTestResult 'save-receipt-and-pair-binding-enforced'

    $badReconnect = Copy-ExternalJoinSelfTestValue -Value $observation
    $badReconnect.events[10].evidence.reconnectChallengeId = [string]$badReconnect.sessionBinding.initialChallengeId
    [void](Update-ExternalJoinSelfTestChain -Observation $badReconnect)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $badReconnect -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_EVENT_EVIDENCE_INVALID' -Message 'reused reconnect challenge was accepted'
    Add-ExternalJoinSelfTestResult 'fresh-reconnect-session-and-challenge-required'

    $badHost = Copy-ExternalJoinSelfTestValue -Value $observation
    $badHost.events[1].evidence.sniAuthority = 'other.example.com'
    [void](Update-ExternalJoinSelfTestChain -Observation $badHost)
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $badHost -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_EVENT_EVIDENCE_INVALID' -Message 'public host/SNI substitution was accepted'
    Add-ExternalJoinSelfTestResult 'dns-tls-wss-public-host-binding-enforced'

    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $observation -NowUtc $now.AddHours(2) } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_STALE' -Message 'expired observation was accepted'
    Add-ExternalJoinSelfTestResult 'expiry-enforced'

    $digestTamper = Copy-ExternalJoinSelfTestValue -Value $observation
    $digestTamper.observationSha256 = Get-ExternalJoinSelfTestDigest -Character 'f'
    Assert-ExternalJoinSelfTestFailure -Action { Assert-DysonExternalJoinObservationV2 -Observation $digestTamper -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_DIGEST_INVALID' -Message 'observation digest tamper was accepted'
    Add-ExternalJoinSelfTestResult 'chain-and-observation-digests-enforced'

    Assert-ExternalJoinSelfTestFailure -Action { ConvertFrom-DysonExternalJoinObservationV2StrictJson -Text '{"protocol":"one","\u0070rotocol":"two"}' } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_DUPLICATE_JSON_KEY' -Message 'duplicate JSON key was accepted'
    Add-ExternalJoinSelfTestResult 'duplicate-json-key-rejected'

    $inputPath = Join-Path $fullTestRoot 'external-input.json'
    $outputPath = Join-Path $fullTestRoot 'external-observation.json'
    [IO.File]::WriteAllText($inputPath,(ConvertTo-DysonQualificationV2CanonicalJson -Value $fixtureInput),(New-Object Text.UTF8Encoding -ArgumentList $false))
    $generatorResult = & (Join-Path $PSScriptRoot 'New-DysonExternalJoinObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now | ConvertFrom-Json
    Assert-ExternalJoinSelfTest -Condition ([bool]$generatorResult.qualified -and [int]$generatorResult.eventCount -eq 12) -Message 'create-new generator failed'
    $validatorResult = & (Join-Path $PSScriptRoot 'Test-DysonExternalJoinObservationV2.ps1') -ObservationPath $outputPath -ExpectedObservationId $fixtureInput.observationId -ExpectedRunId $fixtureInput.runId -ExpectedSubjectCommit $fixtureInput.releaseIdentity.subjectCommit -ExpectedRuntimePayloadSha256 $fixtureInput.releaseIdentity.runtimePayloadSha256 -ExpectedReleaseManifestSha256 $fixtureInput.releaseIdentity.releaseManifestSha256 -ExpectedPublicHost 'join.example.com' -ExpectedClientPseudonym $fixtureInput.client.clientPseudonym -ExpectedSaveReceiptSha256 $fixtureInput.saveBinding.saveReceiptSha256 -ExpectedSavePairSha256 $fixtureInput.saveBinding.savePairSha256 -NowUtc $now | ConvertFrom-Json
    Assert-ExternalJoinSelfTest -Condition ([bool]$validatorResult.qualified -and -not [bool]$validatorResult.identityCollected -and -not [bool]$validatorResult.networkAddressCollected -and -not [bool]$validatorResult.networkTouched -and -not [bool]$validatorResult.productionChanged) -Message 'read-only validator result was unsafe'
    Assert-ExternalJoinSelfTestFailure -Action { & (Join-Path $PSScriptRoot 'New-DysonExternalJoinObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now } -ExpectedCode 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_OUTPUT_EXISTS' -Message 'generator overwrote existing evidence'
    Add-ExternalJoinSelfTestResult 'canonical-create-new-and-read-only-validation'

    $schema = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'dyson-external-join-observation-v2.schema.json') -Encoding UTF8 | ConvertFrom-Json
    Assert-ExternalJoinSelfTest -Condition ([string]$schema.properties.protocol.const -ceq 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2' -and -not [bool]$schema.additionalProperties) -Message 'schema top-level contract drifted'
    Assert-ExternalJoinSelfTest -Condition ($null -eq $schema.properties.PSObject.Properties['status'] -and [int]$schema.properties.events.minItems -eq 12 -and [int]$schema.properties.events.maxItems -eq 12) -Message 'schema exposes status shortcut or sequence cardinality drifted'
    Add-ExternalJoinSelfTestResult 'schema-exact-status-free-and-twelve-stage'

    [pscustomobject][ordered]@{
        protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_SELFTEST_V2'
        schemaVersion = 2
        status = 'passed'
        runtime = 'Windows PowerShell 5.1 compatible'
        runtimeVersion = $PSVersionTable.PSVersion.ToString()
        testCount = $results.Count
        passedCount = $results.Count
        tests = @($results | ForEach-Object { $_ })
        fixturePublicHost = 'join.example.com'
        externalFixtureOnly = $true
        identityCollected = $false
        networkAddressCollected = $false
        networkTouched = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
finally {
    if (Test-Path -LiteralPath $fullTestRoot) {
        $resolved = [IO.Path]::GetFullPath($fullTestRoot)
        if ($resolved.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -cmatch '^dyson-external-join-selftest-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
