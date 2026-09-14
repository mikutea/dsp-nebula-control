[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -cne 'Desktop') {
    throw 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_REQUIRES_WINDOWS_POWERSHELL_5_1'
}

. (Join-Path $PSScriptRoot 'Qualification.OrchestrationV2.ps1')
. (Join-Path $PSScriptRoot 'Qualification.Protocol.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-qualification-orchestration-v2-selftest-' + [guid]::NewGuid().ToString('N'))
$stateRoot = Join-Path $testRoot 'state'
$evidenceRoot = Join-Path $testRoot 'evidence'
$oldFixtureGate = [Environment]::GetEnvironmentVariable($script:DysonOrchestrationV2FixtureGateName, [EnvironmentVariableTarget]::Process)
$oldProductionGate = [Environment]::GetEnvironmentVariable($script:DysonOrchestrationV2ProductionGateName, [EnvironmentVariableTarget]::Process)
$results = New-Object 'System.Collections.Generic.List[string]'
$keys = @{}
$stage = 'initialize'

function Assert-OrchestrationSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_FAILED: ' + $Message) }
}

function Add-OrchestrationSelfTestResult {
    param([Parameter(Mandatory)][string]$Name)
    $results.Add($Name)
}

function Copy-OrchestrationSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value | ConvertFrom-Json)
}

function Write-OrchestrationSelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { [void][IO.Directory]::CreateDirectory($parent) }
    [IO.File]::WriteAllText($Path, (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) + "`n", [Text.UTF8Encoding]::new($false))
}

function Get-OrchestrationSelfTestKey {
    param([Parameter(Mandatory)][string]$KeyId)
    if (-not $keys.ContainsKey($KeyId)) { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEY_INVALID' }
    $source = [byte[]]$keys[$KeyId]
    $copy = New-Object 'byte[]' $source.Length
    [Array]::Copy($source, $copy, $source.Length)
    return $copy
}

function Protect-OrchestrationSelfTestEvidence {
    param([Parameter(Mandatory)]$Evidence)
    $Evidence.evidenceSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonOrchestrationV2UnsignedValue -Value $Evidence -Excluded @('evidenceSha256','protection'))
    $key = Get-OrchestrationSelfTestKey -KeyId ([string]$Evidence.protection.keyId)
    try {
        $payload = ConvertTo-DysonQualificationV2CanonicalJson -Value ([pscustomobject][ordered]@{
            domain = 'DYSON_QUALIFICATION_CONTROLLED_EVIDENCE_HMAC_V2'
            evidenceSha256 = [string]$Evidence.evidenceSha256
            keyId = [string]$Evidence.protection.keyId
        })
        $Evidence.protection.hmacSha256 = Get-DysonOrchestrationV2HmacValue -Key $key -Text $payload
    }
    finally { [Array]::Clear($key, 0, $key.Length) }
    return $Evidence
}

function New-OrchestrationSelfTestLegacyExternalTranscript {
    param([Parameter(Mandatory)][datetimeoffset]$StartUtc)
    $events = @(
        'client-challenge-issued','game-address-resolved','game-authenticated','game-joined',
        'game-interaction-observed','save-requested','save-independently-acknowledged','game-disconnected',
        'reconnect-challenge-issued','game-rejoined','external-sequence-complete'
    )
    $types = @(
        'operator-client-challenge','game-protocol-resolution-observation','server-authentication-observation',
        'server-authoritative-join','server-authoritative-interaction','server-save-request-observation',
        'independent-paired-save-observation','server-authoritative-disconnect','operator-reconnect-challenge',
        'server-authoritative-rejoin','dual-party-sequence-attestation'
    )
    $classes = @(
        'operator-challenge','independent-network-observer','server-authoritative','server-authoritative',
        'server-authoritative','server-authoritative','independent-save-observer','server-authoritative',
        'operator-challenge','server-authoritative','dual-party-attestation'
    )
    $firstChallenge = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $reconnectChallenge = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $runId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $receipts = @()
    $predecessor = $null
    for ($index = 0; $index -lt 11; $index++) {
        $at = $StartUtc.AddSeconds(30 * $index)
        $binding = $null
        if ($index -eq 10) {
            $binding = Get-DysonQualificationSha256 -InputObject ([ordered]@{
                protocol = 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1'
                firstChallengeId = $firstChallenge
                reconnectChallengeId = $reconnectChallenge
                predecessorSha256 = [string]$receipts[9].receiptSha256
            })
        }
        $receipt = New-DysonQualificationReceipt `
            -ReceiptId ([guid]::NewGuid().ToString('D').ToLowerInvariant()) -RunId $runId `
            -IdempotencyKey ([guid]::NewGuid().ToString('D').ToLowerInvariant()) `
            -StepId 'external-client-e2e' -Sequence ($index + 1) -Event $events[$index] `
            -Status $(if ($index -eq 10) { 'passed' } else { 'observed' }) `
            -IssuedAtUtc $at -ExpiresAtUtc $at.AddHours(1) -PredecessorSha256 $predecessor `
            -EvidenceOpaqueId ([guid]::NewGuid().ToString('D').ToLowerInvariant()) `
            -EvidenceType $types[$index] -EvidenceSha256 (Get-DysonQualificationSha256 -Text ('fixture-' + $index)) `
            -EvidenceObservedAtUtc $at -EvidenceExpiresAtUtc $at.AddHours(1) `
            -AttestationClass $classes[$index] -CheckCodes @('external-observed') `
            -ChallengeId $(if ($index -le 7) { $firstChallenge } else { $reconnectChallenge }) `
            -TranscriptBindingSha256 $binding
        $receipts += ,$receipt
        $predecessor = [string]$receipt.receiptSha256
    }
    return ,$receipts
}

function New-OrchestrationSelfTestExternalJoinObservation {
    param(
        [Parameter(Mandatory)][string]$ObservationId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt
    )
    $digest = { param([char]$Character) 'sha256:' + [string]::new($Character, 64) }
    $clientPseudonym = 'client:sha256:' + [string]::new('d', 64)
    $initialSessionId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $reconnectSessionId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $initialChallengeId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $reconnectChallengeId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $saveRequestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $worldBinding = & $digest '9'
    $saveReceipt = & $digest 'a'
    $savePair = & $digest 'b'
    $saveManifest = & $digest 'c'
    $expiresAt = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddHours(1)
    $evidenceValues = @(
        [pscustomobject][ordered]@{ publicHost='join.example.com'; answerSetSha256=(& $digest '7'); classification='public-routable'; externalResolverObserved=$true },
        [pscustomobject][ordered]@{ sniAuthority='join.example.com'; negotiatedProtocol='tls13'; certificateSha256=(& $digest '8'); certificateValid=$true; dnsNameMatched=$true },
        [pscustomobject][ordered]@{ hostHeaderAuthority='join.example.com'; path='/socket'; httpStatusCode=101; transport='wss' },
        [pscustomobject][ordered]@{ protocol='nebula'; transportEstablished=$true; serverHandshakeSha256=(& $digest 'e') },
        [pscustomobject][ordered]@{ authenticated=$true; authenticationReceiptSha256=(& $digest 'f') },
        [pscustomobject][ordered]@{ joined=$true; serverAuthoritative=$true; worldBindingSha256=$worldBinding; joinReceiptSha256=(& $digest '0') },
        [pscustomobject][ordered]@{ interactionClass='server-observed-gameplay'; serverObserved=$true; worldBindingSha256=$worldBinding; interactionReceiptSha256=(& $digest '1') },
        [pscustomobject][ordered]@{ saveRequestId=$saveRequestId; requested=$true; worldBindingSha256=$worldBinding },
        [pscustomobject][ordered]@{ saveRequestId=$saveRequestId; serverAcknowledged=$true; saveReceiptSha256=$saveReceipt; savePairSha256=$savePair; saveManifestSha256=$saveManifest },
        [pscustomobject][ordered]@{ cleanDisconnect=$true; serverObserved=$true; disconnectReceiptSha256=(& $digest '2') },
        [pscustomobject][ordered]@{ publicHost='join.example.com'; transportStack='tls-wss-nebula'; freshQualificationSession=$true; reconnectChallengeId=$reconnectChallengeId },
        [pscustomobject][ordered]@{ rejoined=$true; serverAuthoritative=$true; worldBindingSha256=$worldBinding; savePairSha256=$savePair; rejoinReceiptSha256=(& $digest '3') }
    )
    $events = @()
    for ($index = 0; $index -lt $script:DysonExternalJoinObservationV2Events.Count; $index++) {
        $events += ,[pscustomobject][ordered]@{
            sequence = $index + 1
            event = $script:DysonExternalJoinObservationV2Events[$index]
            observerClass = $script:DysonExternalJoinObservationV2Observers[$index]
            qualificationSessionId = if ($index -le 9) { $initialSessionId } else { $reconnectSessionId }
            clientPseudonym = $clientPseudonym
            observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddSeconds(-330 + (30 * $index))
            expiresAtUtc = $expiresAt
            evidence = $evidenceValues[$index]
        }
    }
    $inputValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        observationId = $ObservationId
        runId = $RunId
        releaseIdentity = [pscustomobject][ordered]@{
            releaseVersion = '0.1.0-rc.1'
            subjectCommit = [string]$profile.subjectCommit
            runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
            releaseManifestSha256 = & $digest '4'
            serverManifestSha256 = & $digest '5'
            clientManifestSha256 = & $digest '6'
        }
        publicEndpoint = [pscustomobject][ordered]@{
            scheme = 'wss'; publicHost = 'join.example.com'; port = 443; websocketPath = '/socket'
            dnsAnswerSetSha256 = & $digest '7'; tlsCertificateSha256 = & $digest '8'
        }
        client = [pscustomobject][ordered]@{
            clientPseudonym = $clientPseudonym; pseudonymScope = 'one-run'; networkClass = 'public-external'
            sourceAddressCollected = $false; displayNameCollected = $false; accountIdCollected = $false; deviceIdCollected = $false
            clientBuildSha256 = & $digest '5'; clientManifestSha256 = & $digest '6'
            externalNetworkAttestationSha256 = & $digest '7'
        }
        sessionBinding = [pscustomobject][ordered]@{
            initialQualificationSessionId = $initialSessionId; reconnectQualificationSessionId = $reconnectSessionId
            initialChallengeId = $initialChallengeId; reconnectChallengeId = $reconnectChallengeId
            worldBindingSha256 = $worldBinding
        }
        saveBinding = [pscustomobject][ordered]@{
            saveRequestId = $saveRequestId; worldBindingSha256 = $worldBinding; saveReceiptSha256 = $saveReceipt
            savePairSha256 = $savePair; saveManifestSha256 = $saveManifest
        }
        events = $events
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        expiresAtUtc = $expiresAt
    }
    return New-DysonExternalJoinObservationV2 -InputValue $inputValue
}

function Update-OrchestrationSelfTestExternalJoinBindings {
    param([Parameter(Mandatory)]$Observation)
    $Observation.releaseBindingSha256 = Get-DysonQualificationV2ObjectDigest -Value $Observation.releaseIdentity
    $Observation.endpointBindingSha256 = Get-DysonQualificationV2ObjectDigest -Value $Observation.publicEndpoint
    $Observation.sessionBinding.bindingSha256 = Get-DysonExternalJoinObservationV2SessionBindingDigest `
        -RunId ([string]$Observation.runId) -ClientPseudonym ([string]$Observation.client.clientPseudonym) `
        -SessionBinding $Observation.sessionBinding -ReleaseBindingSha256 ([string]$Observation.releaseBindingSha256) `
        -EndpointBindingSha256 ([string]$Observation.endpointBindingSha256)
    $predecessor = $null
    for ($index = 0; $index -lt @($Observation.events).Count; $index++) {
        $event = $Observation.events[$index]
        $event.releaseBindingSha256 = [string]$Observation.releaseBindingSha256
        $event.endpointBindingSha256 = [string]$Observation.endpointBindingSha256
        $event.sessionBindingSha256 = [string]$Observation.sessionBinding.bindingSha256
        $event.evidenceSha256 = Get-DysonQualificationV2ObjectDigest -Value $event.evidence
        $event.predecessorSha256 = $predecessor
        $event.eventSha256 = Get-DysonExternalJoinObservationV2EventDigest -EventValue $event
        $predecessor = [string]$event.eventSha256
    }
    $Observation.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $Observation
    return $Observation
}

function Update-OrchestrationSelfTestExternalJoinDigest {
    param([Parameter(Mandatory)]$Observation)
    $Observation.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $Observation
    return $Observation
}

function New-OrchestrationSelfTestControlledObservation {
    param(
        [Parameter(Mandatory)]$ArtifactContract,
        [Parameter(Mandatory)][string]$ReceiptId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ActionTargetId,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt
    )
    $value = [pscustomobject][ordered]@{
        protocol = [string]$ArtifactContract.protocol
        schemaVersion = [int]$ArtifactContract.schemaVersion
        receiptId = $ReceiptId
        runId = $RunId
        action = $Action
        actionTargetId = $ActionTargetId
        targetIdentity = [string]$profile.targetIdentity
        subjectCommit = [string]$profile.subjectCommit
        runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        status = 'verified'
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        receiptSha256 = $null
    }
    $value.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonOrchestrationV2UnsignedValue -Value $value -Excluded @('receiptSha256'))
    return $value
}

function New-OrchestrationSelfTestPanelObservation {
    param(
        [Parameter(Mandatory)][string]$ReceiptId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$ActionTargetId,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt
    )
    $digest = { param([char]$Character) 'sha256:' + [string]::new($Character, 64) }
    $inputValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        receiptId = $ReceiptId
        runId = $RunId
        actionTargetId = $ActionTargetId
        targetIdentity = [string]$profile.targetIdentity
        subjectCommit = [string]$profile.subjectCommit
        runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        releaseIdentity = [pscustomobject][ordered]@{
            releaseVersion = '0.1.0-rc.1'
            releaseManifestSha256 = & $digest '1'
            subjectCommit = [string]$profile.subjectCommit
            runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        }
        endpoint = [pscustomobject][ordered]@{
            scheme = 'https'; publicHost = 'panel.example.com'; port = 443
            sniAuthority = 'panel.example.com'; hostHeaderAuthority = 'panel.example.com'
        }
        tls = [pscustomobject][ordered]@{
            negotiatedProtocol = 'tls13'; certificateDnsName = 'panel.example.com'
            certificateSha256 = & $digest '2'; chainTrusted = $true; dnsNameMatched = $true
            notBeforeUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddDays(-30)
            notAfterUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddDays(30)
            negotiatedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        }
        authenticatedSession = [pscustomobject][ordered]@{
            authenticated = $true; authenticationMethod = 'password'; sessionStore = 'server-side'
            sessionCookieOpaque = $true; sessionCookieSecure = $true; sessionCookieHttpOnly = $true
            principalRole = 'Administrator'; sessionId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
            sessionBindingSha256 = & $digest '0'
        }
        authorization = [pscustomobject][ordered]@{
            viewerMutation = [pscustomobject][ordered]@{
                role = 'Viewer'; method = 'POST'; route = '/api/server/start'
                expectedStatusCode = 403; actualStatusCode = 403; mutationObserved = $false; auditOutcome = 'denied'
            }
            administratorRead = [pscustomobject][ordered]@{
                role = 'Administrator'; method = 'GET'; route = '/api/health'
                expectedStatusCode = 200; actualStatusCode = 200; authenticatedResponse = $true
            }
        }
        nodeListener = [pscustomobject][ordered]@{
            address = '127.0.0.1'; port = 3001; loopbackOnly = $true
            processIdentitySha256 = & $digest '3'; runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        }
        routeSeparation = [pscustomobject][ordered]@{
            managementPublicTransport = 'https'; managementApplicationProtocol = 'http'
            managementOriginAddress = '127.0.0.1'; managementOriginPort = 3001
            managementRouteIdentitySha256 = & $digest '4'; managementHttpObserved = $true
            gamePublicTransport = 'tcp'; gameApplicationProtocol = 'nebula-tcp'
            gameOriginAddress = '192.0.2.10'; gameOriginPort = 8469
            gameRouteIdentitySha256 = & $digest '5'; gameTcpObserved = $true
            sharedOrigin = $false; routeSeparationObserved = $true
        }
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddHours(1)
    }
    $draft = New-DysonControlPanelObservationV2 -InputValue $inputValue
    $inputValue.authenticatedSession.sessionBindingSha256 = Get-DysonControlPanelObservationV2SessionBindingDigest -Observation $draft
    return New-DysonControlPanelObservationV2 -InputValue $inputValue
}





function New-OrchestrationSelfTestPairedSaveLoadObservation {
    param(
        [Parameter(Mandatory)][string]$ObservationId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt,
        [Parameter(Mandatory)]$RestoreReceipt,
        [Parameter(Mandatory)][string]$RestoreSourceSha256,
        [Parameter(Mandatory)]$RollbackReceipt,
        [Parameter(Mandatory)][string]$RollbackSourceSha256
    )
    $rawDigest = { param([string]$Value) if ($Value.StartsWith('sha256:', [StringComparison]::Ordinal)) { $Value.Substring(7) } else { $Value } }
    $dsvSha256 = '8' * 64
    $serverSha256 = '9' * 64
    $dsvTicks = 640290530400000000L
    $serverTicks = 640290530410000000L
    $saveStarted = $ObservedAt.AddMinutes(-6).ToUnixTimeMilliseconds()
    $saveFinished = $ObservedAt.AddMinutes(-5).ToUnixTimeMilliseconds()
    $loadedObserved = $ObservedAt.AddMinutes(-4).ToUnixTimeMilliseconds()
    $loadedWritten = $ObservedAt.AddMinutes(-4).AddSeconds(1).ToUnixTimeMilliseconds()
    $save = [pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_RECEIPT_V2'; sourceSha256=('a'*64)
        requestId=[guid]::NewGuid().ToString('D').ToLowerInvariant()
        startedAtUnixMs=$saveStarted; finishedAtUnixMs=$saveFinished; saveTimeBefore=100L; saveTimeAfter=101L
        dsvBytes=4096L; dsvWriteTimeUtcTicks=$dsvTicks; serverBytes=2048L
        serverWriteTimeUtcTicks=$serverTicks; saveGenerationId=$null
    }
    $save.saveGenerationId = Get-DysonPairedSaveLoadGenerationId $save
    $pair = [pscustomobject][ordered]@{
        protocol='DYSON_QUALIFICATION_PAIRED_SAVE_PAIR_V2'; saveName='_lastexit_'
        dsvLength=4096L; dsvWriteTimeUtcTicks=$dsvTicks; dsvSha256=$dsvSha256
        serverLength=2048L; serverWriteTimeUtcTicks=$serverTicks; serverSha256=$serverSha256; pairSha256=$null
    }
    $pair.pairSha256 = Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson ([pscustomobject][ordered]@{
        protocol=$pair.protocol; saveName=$pair.saveName; dsvLength=$pair.dsvLength
        dsvWriteTimeUtcTicks=$pair.dsvWriteTimeUtcTicks; dsvSha256=$pair.dsvSha256
        serverLength=$pair.serverLength; serverWriteTimeUtcTicks=$pair.serverWriteTimeUtcTicks; serverSha256=$pair.serverSha256
    }))
    $value = [pscustomobject][ordered]@{
        protocol='DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'; schemaVersion=2
        observationId=$ObservationId; qualificationRunId=$RunId; controlRelease='v0.1.0-rc.1'
        subjectCommit=[string]$profile.subjectCommit
        restoreReceipt=[pscustomobject][ordered]@{
            protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'; schemaVersion=1
            sourceSha256=(& $rawDigest $RestoreSourceSha256); operationId=[string]$RestoreReceipt.operationId
            requestFingerprint=[string]$RestoreReceipt.requestFingerprint; dataRootIdentity=[string]$RestoreReceipt.dataRootIdentity
            bundleId=[string]$RestoreReceipt.bundleId; manifestSha256=[string]$RestoreReceipt.manifestSha256
            protectionManifestSha256=[string]$RestoreReceipt.protectionManifestSha256
            completedAtUtc=ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddMinutes(-7)
        }
        protectionPoint=[pscustomobject][ordered]@{
            protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_BUNDLE_V1'; schemaVersion=1
            sourceSha256=[string]$RestoreReceipt.protectionManifestSha256
            protectionPointId=[string]$RestoreReceipt.operationId; dataRootIdentity=[string]$RestoreReceipt.dataRootIdentity
            createdAtUtc=ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddMinutes(-8)
            inventorySha256=('b'*64); fileCount=2L; totalBytes=6144L
        }
        bridgeLoadedSave=[pscustomobject][ordered]@{
            protocol='DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1'; sourceSha256=('c'*64)
            sessionId=[guid]::NewGuid().ToString('D').ToLowerInvariant(); pluginVersion='1.2.3-fixture'; processId=4242L
            processStartedAtUnixMs=$ObservedAt.AddMinutes(-20).ToUnixTimeMilliseconds()
            bridgeStartedAtUnixMs=$ObservedAt.AddMinutes(-19).ToUnixTimeMilliseconds()
            observationGeneration=17L; observedAtUnixMs=$loadedObserved; writtenAtUnixMs=$loadedWritten; saveName='_lastexit_'
            dsvBytes=4096L; dsvWriteTimeUtcTicks=$dsvTicks; dsvSha256=$dsvSha256
            serverBytes=2048L; serverWriteTimeUtcTicks=$serverTicks; serverSha256=$serverSha256
        }
        newSaveAcknowledgement=$save; stableSavePair=$pair
        rollbackReceipt=[pscustomobject][ordered]@{
            protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'; schemaVersion=1
            sourceSha256=(& $rawDigest $RollbackSourceSha256); operationId=[string]$RollbackReceipt.operationId
            requestFingerprint=[string]$RollbackReceipt.requestFingerprint; dataRootIdentity=[string]$RollbackReceipt.dataRootIdentity
            bundleId=[string]$RollbackReceipt.bundleId; manifestSha256=[string]$RollbackReceipt.manifestSha256
            protectionManifestSha256=[string]$RollbackReceipt.protectionManifestSha256
            completedAtUtc=ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddMinutes(-1)
        }
        observedAtUtc=ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        expiresAtUtc=ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddHours(4)
        observationSha256=$null
    }
    $value.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $value
    return $value
}







function New-OrchestrationSelfTestSoakObservation {
    param(
        [Parameter(Mandatory)][string]$ObservationId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][ValidateSet('six-hour-soak','seventy-two-hour-soak')][string]$Action,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt
    )
    $kind = if ($Action -ceq 'six-hour-soak') { 'six-hour' } else { 'seventy-two-hour' }
    $policy = Get-DysonSoakV2Policy -Kind $kind
    $elapsed = [int64]$policy.minimumElapsedSeconds
    $samples = [int64]$policy.minimumSampleCount
    $started = $ObservedAt.AddSeconds(-$elapsed)
    $frequency = [int64]1000000
    $firstTicks = [int64]1000000000000
    $lastTicks = $firstTicks + ($elapsed * $frequency)
    $segments = New-Object 'System.Collections.Generic.List[object]'
    $segmentCount = [int64]($elapsed / 3600)
    for ($index = 0; $index -lt $segmentCount; $index++) {
        $firstSequence = if ($index -eq 0) { [int64]0 } else { [int64]($index * 240 + 1) }
        $lastSequence = [int64](($index + 1) * 240)
        $segmentCharacter = [char]('0123456789abcdef'[$index % 16])
        [void]$segments.Add([pscustomobject][ordered]@{
            segmentIndex = [int64]$index
            firstSampleSequence = $firstSequence
            lastSampleSequence = $lastSequence
            sampleCount = [int64]($lastSequence - $firstSequence + 1)
            firstMonotonicTicks = [int64]($firstTicks + ($firstSequence * 15 * $frequency))
            lastMonotonicTicks = [int64]($firstTicks + ($lastSequence * 15 * $frequency))
            maximumGapSeconds = [int64]15
            segmentPayloadSha256 = 'sha256:' + [string]::new($segmentCharacter, 64)
        })
    }
    $digest = { param([char]$Character) 'sha256:' + [string]::new($Character, 64) }
    $worldBinding = & $digest '6'
    $savePair = & $digest '7'
    $inputValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_SOAK_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        observationId = $ObservationId
        kind = $kind
        runId = $RunId
        targetIdentity = [string]$profile.targetIdentity
        releaseIdentity = [pscustomobject][ordered]@{
            releaseVersion = '0.1.0-rc.1'
            subjectCommit = [string]$profile.subjectCommit
            runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
            releaseManifestSha256 = & $digest '2'
        }
        workloadProfile = [pscustomobject][ordered]@{
            profileId = 'late-game-6h-v1'; profileSha256 = (& $digest '3')
            representativeLateGame = $true; normalMultiplayer = $true
            simulationPaused = $false; workloadReduced = $false; targetUps = 60
            modLockSha256 = (& $digest '4'); vmAllocationSha256 = (& $digest '5')
        }
        saveBaseline = [pscustomobject][ordered]@{
            worldBindingSha256 = $worldBinding; savePairSha256 = $savePair
            saveManifestSha256 = (& $digest '8'); pairedFilesIntact = $true
            representativeLateGame = $true
        }
        observationWindow = [pscustomobject][ordered]@{
            observerClass = 'independent-monotonic-observer'; clockClass = 'real-monotonic'
            clockSource = 'host-monotonic-counter'; clockMode = 'real-elapsed'
            virtualClock = $false; boundedClock = $false; continuousObserver = $true
            startedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $started
            completedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
            monotonicFrequencyHz = $frequency; firstMonotonicTicks = $firstTicks
            lastMonotonicTicks = $lastTicks; accumulatedMonotonicTicks = ($lastTicks - $firstTicks)
            elapsedMonotonicSeconds = $elapsed; clockAttestationSha256 = (& $digest '9')
        }
        telemetry = [pscustomobject][ordered]@{
            sampleCount = $samples; firstSampleSequence = 0; lastSampleSequence = ($samples - 1)
            firstMonotonicTicks = $firstTicks; lastMonotonicTicks = $lastTicks
            maximumGapSeconds = 15; segments = $segments.ToArray()
        }
        health = [pscustomobject][ordered]@{
            ups = [pscustomobject][ordered]@{ coveredSamples=$samples; runningSamples=$samples; atOrAbove55UpsSamples=$samples; targetUps=60; minimumQualifiedUps=55 }
            cpu = [pscustomobject][ordered]@{ coveredSamples=$samples; hostCpuP95BasisPoints=7500; hottestCoreAtOrAbove97Samples=0; eligibleBottleneckSamples=$samples; singleCoreBottleneckSamples=0 }
            memory = [pscustomobject][ordered]@{ coveredSamples=$samples; peakUsedBasisPoints=7000 }
            disk = [pscustomobject][ordered]@{ coveredSamples=$samples; projectPeakUsedBasisPoints=7000; projectMinimumFreeMiB=20480; savePeakUsedBasisPoints=7000; saveMinimumFreeMiB=20480 }
            gameProcess = [pscustomobject][ordered]@{ coveredSamples=$samples; healthySamples=$samples; presentSamples=$samples; unexpectedRestartCount=0 }
            controlPlane = [pscustomobject][ordered]@{ coveredSamples=$samples; healthySamples=$samples; unexpectedRestartCount=0 }
            bridge = [pscustomobject][ordered]@{ coveredSamples=$samples; healthySamples=$samples; generationStable=$true; unexpectedRestartCount=0 }
        }
        externalSession = [pscustomobject][ordered]@{
            publicHost = 'join.example.com'; networkClass = 'public-external'; protocol = 'nebula'
            reachabilityOnly = $false; clientPseudonym = 'client:sha256:' + ('c' * 64)
            initialJoinReceiptSha256 = (& $digest 'a'); reconnectReceiptSha256 = (& $digest 'b')
            initialJoinAtUtc = ConvertTo-DysonQualificationV2Utc -Value $started.AddMinutes(15)
            reconnectAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddMinutes(-15)
            sameWorld = $true; worldBindingSha256 = $worldBinding; savePairSha256 = $savePair
        }
        saves = [pscustomobject][ordered]@{
            acknowledgementCount = [int64]$policy.minimumSaveAcknowledgements
            maximumAcknowledgementGapSeconds = 600
            firstAcknowledgementAtUtc = ConvertTo-DysonQualificationV2Utc -Value $started
            lastAcknowledgementAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
            firstAcknowledgementSha256 = (& $digest 'c'); lastAcknowledgementSha256 = (& $digest 'd')
            acknowledgementChainSha256 = (& $digest 'e'); allAcknowledged = $true; pairStable = $true
            worldBindingSha256 = $worldBinding; savePairSha256 = $savePair
        }
        outcome = [pscustomobject][ordered]@{
            crashCount=0; recoveryRequiredCount=0; dataLossEventCount=0; workloadInterruptionCount=0
            clockAnomalyCount=0; criticalHealthSamples=0; mandatoryHealthChecksPassed=$true
        }
        alerts = [pscustomobject][ordered]@{
            criticalAlertCount=0; unresolvedAlertCount=0; conclusion='no-actionable-alerts'
            alertLedgerSha256 = & $digest 'f'
        }
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAt.AddHours(1)
    }
    return New-DysonSoakObservationV2 -InputValue $inputValue
}

function Update-OrchestrationSelfTestSoakBindings {
    param([Parameter(Mandatory)]$Observation)
    $subjectBinding = Get-DysonSoakV2SubjectBindingDigest -Value $Observation
    $Observation.subjectBindingSha256 = $subjectBinding
    foreach ($name in @('workloadProfile','saveBaseline','observationWindow','health','externalSession','saves','outcome','alerts')) {
        $Observation.$name.subjectBindingSha256 = $subjectBinding
    }
    $previous = $null
    foreach ($segment in @($Observation.telemetry.segments)) {
        $segment.subjectBindingSha256 = $subjectBinding
        $segment.previousSegmentSha256 = $previous
        $segment.segmentSha256 = Get-DysonSoakV2SegmentDigest -Segment $segment
        $previous = [string]$segment.segmentSha256
    }
    $Observation.telemetry.subjectBindingSha256 = $subjectBinding
    $Observation.telemetry.segmentsRootSha256 = Get-DysonSoakV2SegmentsRootDigest `
        -SubjectBindingSha256 $subjectBinding -Segments @($Observation.telemetry.segments)
    $Observation.observationSha256 = Get-DysonSoakV2ObservationDigest -Observation $Observation
    return $Observation
}

function Update-OrchestrationSelfTestSoakDigest {
    param([Parameter(Mandatory)]$Observation)
    $Observation.observationSha256 = Get-DysonSoakV2ObservationDigest -Observation $Observation
    return $Observation
}





function New-OrchestrationSelfTestSourceValue {
    param(
        [Parameter(Mandatory)]$ArtifactContract,
        [Parameter(Mandatory)][string]$ReceiptId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ActionTargetId,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAt
    )
    $role = [string]$ArtifactContract.role
    if ($role -ceq 'panel-observation') {
        return New-OrchestrationSelfTestPanelObservation -ReceiptId $ReceiptId -RunId $RunId `
            -ActionTargetId $ActionTargetId -ObservedAt $ObservedAt
    }

    if ($role -ceq 'external-join-observation') {
        return New-OrchestrationSelfTestExternalJoinObservation -ObservationId $ReceiptId -RunId $RunId `
            -ObservedAt $ObservedAt
    }
    if ($role -ceq 'soak-observation') {
        return New-OrchestrationSelfTestSoakObservation -ObservationId $ReceiptId -RunId $RunId `
            -Action $Action -ObservedAt $ObservedAt
    }
    if ($role -in @('restored-world-observation','reboot-resume-observation')) {
        return New-OrchestrationSelfTestControlledObservation -ArtifactContract $ArtifactContract -ReceiptId $ReceiptId `
            -RunId $RunId -Action $Action -ActionTargetId $ActionTargetId -ObservedAt $ObservedAt
    }
    switch ($role) {
        'restore-receipt' {
            return [pscustomobject][ordered]@{ protocol=[string]$ArtifactContract.protocol; schemaVersion=1; recordKind='receipt'; operation='restore'; operationId=$ReceiptId; requestFingerprint=('1'*64); dataRootIdentity=('sha256:'+('2'*64)); bundleId=[guid]::NewGuid().ToString('D').ToLowerInvariant(); outcome='succeeded'; manifestSha256=('3'*64); protectionManifestSha256=('4'*64); errorCode=$null; completedAt=$ObservedAt.ToString('o') }
        }
        'restore-rollback-receipt' {
            return [pscustomobject][ordered]@{ protocol=[string]$ArtifactContract.protocol; schemaVersion=1; recordKind='receipt'; operation='restore'; operationId=$ReceiptId; requestFingerprint=('5'*64); dataRootIdentity=('sha256:'+('2'*64)); bundleId=[guid]::NewGuid().ToString('D').ToLowerInvariant(); outcome='succeeded'; manifestSha256=('6'*64); protectionManifestSha256=('7'*64); errorCode=$null; completedAt=$ObservedAt.ToString('o') }
        }
        'reboot-checkpoint' {
            return [pscustomobject][ordered]@{ protocol=[string]$ArtifactContract.protocol; schemaVersion=3; state='pre-reboot-checkpoint'; checkpointId=$ReceiptId; checkpointSha256=('sha256:'+('8'*64)) }
        }
        'update-rollback-receipt' {
            return [pscustomobject][ordered]@{ format=[string]$ArtifactContract.protocol; schemaVersion=1; requestId=$ReceiptId; status='rolled-back'; rollbackVerified=$true; recoveryRequired=$false }
        }
        'deployment-receipt' {
            $deploymentSnapshotId = $ObservedAt.ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + $RunId.Substring(0,8)
            return [pscustomobject][ordered]@{
                protocol=[string]$ArtifactContract.protocol; state='installed'; version='0.1.0-rc.1'
                artifactPayloadSha256=([string]$profile.runtimePayloadSha256).Substring(7); artifactProvenanceBound=$true
                sourceArtifactScriptsExecuted=$false; runtimeRootIdentity=('sha256:'+('1'*64)); nodeExecutableSha256=('2'*64)
                nodeRuntimeProtected=$true; runtimeChanged=$false; deploymentSnapshotId=$deploymentSnapshotId
                configurationCreated=$false; configurationReplaced=$true; configurationReady=$true
                configurationSha256=('3'*64); configurationLength=2048; configurationNamesSha256=('4'*64)
                configurationBindingsSha256=('5'*64); configurationContractSha256=('6'*64)
                configurationAclFingerprint=('7'*64); configurationParentAclFingerprint=('8'*64)
                configurationReplacementSupported=$true; qualifiedClientStorageConfigured=$true
                qualifiedClientProfileEnabled=$true; qualifiedClientStorageReady=$true
                qualifiedClientStorageLayoutSha256=('9'*64); qualifiedClientStorageDirectoryCount=2
                startupTaskInstalled=$true; readinessVerified=$true; loopbackForcedByLauncher=$true
                persistentDataReady=$true; lifecycleBrokerTaskRequested=$true; lifecycleBrokerOperation='installed'
                lifecycleBrokerTaskInstalled=$true; lifecycleBrokerTaskName='Dyson-Control-Lifecycle-Broker'
                lifecycleBrokerProfileHash=('a'*64); lifecycleBrokerReused=$false; lifecycleBrokerUpgraded=$false
                lifecycleBrokerDataReady=$true; gameTasksChanged=$false
            }
        }
        'deployment-rollback-receipt' {
            $deploymentSnapshotId = $ObservedAt.ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + $RunId.Substring(0,8)
            $guardSnapshotId = $ObservedAt.AddMilliseconds(1).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + $ReceiptId.Substring(0,8)
            return [pscustomobject][ordered]@{
                protocol=[string]$ArtifactContract.protocol; state='rolled-back'; operation='rollback'
                snapshotId=$deploymentSnapshotId; restoredVersion='0.1.0-rc.0'; configRestored=$true; guardSnapshotId=$guardSnapshotId
                readinessVerified=$true; rollback=('Restore guard snapshot ' + $guardSnapshotId + '.')
                runtimeRootIdentity=('sha256:'+('1'*64)); nodeExecutableSha256=('2'*64)
                nodeRuntimeProtected=$true; runtimeChanged=$false
            }
        }





        'hostname-wss-qualification' {
            return [pscustomobject][ordered]@{ protocol=[string]$ArtifactContract.protocol; schemaVersion=1; qualificationId=$ReceiptId; documentSha256=('sha256:'+('9'*64)) }
        }
        default { throw ('Unknown fixture artifact role: ' + $role) }
    }
}

function New-OrchestrationSelfTestCase {
    param(
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$PredecessorReceiptSha256,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [string]$CaseSuffix = 'main'
    )
    $contract = Get-DysonOrchestrationV2ActionContract -Action $Action
    $configuration = Get-DysonOrchestrationV2ActionConfiguration -Profile $profile -Action $Action
    $requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $approvalId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $runId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $caseRoot = ($Action + '-' + $CaseSuffix + '-' + $requestId.Substring(0,8))
    $observedAt = $NowUtc.AddMinutes(-1)
    $elapsed = [int64]$contract.minimumElapsedSeconds
    if ($Action -ceq 'external-client-e2e') { $elapsed = 330 }
    if ($Action -ceq 'paired-save-restore') { $elapsed = 480 }


    $artifacts = @()
    $externalObservation = $null
    $pairedObservation = $null
    $soakObservation = $null
    $artifactValues = @{}
    $artifactPaths = @{}
    foreach ($artifactContract in @($contract.artifacts)) {
        $receiptId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        $relativePath = $caseRoot + '/' + [string]$artifactContract.role + '.json'
        $path = Join-Path $evidenceRoot ($relativePath.Replace('/','\'))
        if ([string]$artifactContract.role -match 'external-transcript$') {
            $value = New-OrchestrationSelfTestLegacyExternalTranscript -StartUtc $NowUtc.AddMinutes(-10)
            $receiptId = [string]$value[10].receiptId
            $receiptSha256 = 'sha256:' + [string]$value[10].receiptSha256
        }
        else {
            $value = New-OrchestrationSelfTestSourceValue -ArtifactContract $artifactContract -ReceiptId $receiptId `
                -RunId $runId -Action $Action -ActionTargetId ([string]$configuration.actionTargetId) -ObservedAt $observedAt
            if ([string]$artifactContract.role -ceq 'external-join-observation') { $externalObservation = $value }
            if ([string]$artifactContract.role -ceq 'soak-observation') { $soakObservation = $value }
            $internal = Get-DysonOrchestrationV2ArtifactDigest -Value $value
            $receiptSha256 = $internal
        }
        Write-OrchestrationSelfTestJson -Path $path -Value $value
        $artifactValues[[string]$artifactContract.role] = $value
        $artifactPaths[[string]$artifactContract.role] = $path
        $fileSha256 = Get-DysonOrchestrationV2FileDigest -Path $path
        if ($null -eq $receiptSha256) { $receiptSha256 = $fileSha256 }
        $artifacts += ,[pscustomobject][ordered]@{
            role = [string]$artifactContract.role
            relativePath = $relativePath
            fileSha256 = $fileSha256
            protocol = [string]$artifactContract.protocol
            schemaVersion = [int]$artifactContract.schemaVersion
            receiptId = $receiptId
            receiptSha256 = $receiptSha256
        }
    }
    if ($Action -ceq 'paired-save-restore') {
        $restoreValue = $artifactValues['restore-receipt']
        $rollbackValue = $artifactValues['restore-rollback-receipt']
        $restoreValue.completedAt = ConvertTo-DysonQualificationV2Utc -Value $observedAt.AddMinutes(-7)
        $rollbackValue.completedAt = ConvertTo-DysonQualificationV2Utc -Value $observedAt.AddMinutes(-1)
        $rollbackValue.bundleId = [string]$restoreValue.operationId
        $rollbackValue.manifestSha256 = [string]$restoreValue.protectionManifestSha256
        foreach ($role in @('restore-receipt','restore-rollback-receipt')) {
            $artifact = @($artifacts | Where-Object { [string]$_.role -ceq $role })[0]
            Write-OrchestrationSelfTestJson -Path ([string]$artifactPaths[$role]) -Value $artifactValues[$role]
            $artifact.fileSha256 = Get-DysonOrchestrationV2FileDigest -Path ([string]$artifactPaths[$role])
            $artifact.receiptSha256 = [string]$artifact.fileSha256
        }
        $restoreArtifact = @($artifacts | Where-Object { [string]$_.role -ceq 'restore-receipt' })[0]
        $rollbackArtifact = @($artifacts | Where-Object { [string]$_.role -ceq 'restore-rollback-receipt' })[0]
        $pairedArtifact = @($artifacts | Where-Object { [string]$_.role -ceq 'restored-world-observation' })[0]
        $pairedObservation = New-OrchestrationSelfTestPairedSaveLoadObservation `
            -ObservationId ([string]$pairedArtifact.receiptId) -RunId $runId -ObservedAt $observedAt `
            -RestoreReceipt $restoreValue -RestoreSourceSha256 ([string]$restoreArtifact.fileSha256) `
            -RollbackReceipt $rollbackValue -RollbackSourceSha256 ([string]$rollbackArtifact.fileSha256)
        $artifactValues['restored-world-observation'] = $pairedObservation
        Write-OrchestrationSelfTestJson -Path ([string]$artifactPaths['restored-world-observation']) -Value $pairedObservation
        $pairedArtifact.fileSha256 = Get-DysonOrchestrationV2FileDigest -Path ([string]$artifactPaths['restored-world-observation'])
        $pairedArtifact.receiptSha256 = 'sha256:' + [string]$pairedObservation.observationSha256
    }


    $rollback = $script:DysonOrchestrationV2ZeroDigest
    if ($null -ne $contract.rollbackRole) {
        $rollback = [string]@($artifacts | Where-Object { [string]$_.role -ceq [string]$contract.rollbackRole })[0].receiptSha256
    }
    $protection = if ($Action -ceq 'paired-save-restore') {
        'sha256:' + [string]$pairedObservation.protectionPoint.sourceSha256
    }  elseif ([bool]$contract.requiresProtectionPoint) {
        Get-DysonQualificationV2Sha256 -Value ('protection-' + $requestId)
    } else { $script:DysonOrchestrationV2ZeroDigest }
    $initialJoin = $script:DysonOrchestrationV2ZeroDigest
    $reconnect = $script:DysonOrchestrationV2ZeroDigest
    $terminal = $script:DysonOrchestrationV2ZeroDigest
    $sampleCount = [int64]$contract.minimumSampleCount
    $maximumSampleGapSeconds = [int64]$contract.maximumSampleGapSeconds
    if ($Action -ceq 'external-client-e2e') {
        $initialJoin = [string]$externalObservation.events[5].evidence.joinReceiptSha256
        $reconnect = [string]$externalObservation.events[11].evidence.rejoinReceiptSha256
        $terminal = [string]$externalObservation.observationSha256
        $sampleCount = @($externalObservation.events).Count
        $maximumSampleGapSeconds = 30
    }
    elseif ($Action -ceq 'paired-save-restore') {
        $terminal = 'sha256:' + [string]$pairedObservation.observationSha256
    }


    elseif ($Action -in @('six-hour-soak','seventy-two-hour-soak')) {
        $initialJoin = [string]$soakObservation.externalSession.initialJoinReceiptSha256
        $reconnect = [string]$soakObservation.externalSession.reconnectReceiptSha256
        $terminal = [string]$soakObservation.observationSha256
        $sampleCount = [int64]$soakObservation.telemetry.sampleCount
        $maximumSampleGapSeconds = [int64]$soakObservation.telemetry.maximumGapSeconds
    }
    $evidence = [pscustomobject][ordered]@{
        protocol = $script:DysonOrchestrationV2EvidenceProtocol
        schemaVersion = 2
        evidenceId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        runId = $runId
        requestId = $requestId
        approvalId = $approvalId
        profileId = [string]$profile.profileId
        profileSha256 = Get-DysonOrchestrationV2ProfileDigest -Profile $profile
        action = $Action
        actionTargetId = [string]$configuration.actionTargetId
        targetIdentity = [string]$profile.targetIdentity
        subjectCommit = [string]$profile.subjectCommit
        runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        adapterId = [string]$configuration.adapterId
        verifierId = [string]$configuration.verifierId
        nonce = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observedAt
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observedAt.AddSeconds([int]$contract.maximumEvidenceAgeSeconds)
        artifacts = $artifacts
        assertions = [pscustomobject][ordered]@{
            status = 'verified'
            checkCodes = @($contract.requiredCheckCodes)
            startedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observedAt.AddSeconds(-$elapsed)
            completedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observedAt
            clockClass = if ($Action -in @('six-hour-soak','seventy-two-hour-soak')) { 'real-monotonic' } else { 'bounded-monotonic' }
            elapsedMonotonicSeconds = $elapsed
            sampleCount = [int64]$sampleCount
            maximumSampleGapSeconds = [int64]$maximumSampleGapSeconds
            protectionPointSha256 = $protection
            rollbackReceiptSha256 = $rollback
            subjectBindingSha256 = $null
            initialJoinReceiptSha256 = $initialJoin
            reconnectReceiptSha256 = $reconnect
            terminalReceiptSha256 = $terminal
        }
        evidenceSha256 = $null
        protection = [pscustomobject][ordered]@{
            keyId = [string]$configuration.keyId
            hmacSha256 = $null
        }
    }
    $evidence.assertions.subjectBindingSha256 = Get-DysonOrchestrationV2SubjectBindingDigest -Evidence $evidence
    $evidence = Protect-OrchestrationSelfTestEvidence -Evidence $evidence
    $evidenceRelativePath = $caseRoot + '/evidence.json'
    $evidencePath = Join-Path $evidenceRoot ($evidenceRelativePath.Replace('/','\'))
    Write-OrchestrationSelfTestJson -Path $evidencePath -Value $evidence
    $request = [pscustomobject][ordered]@{
        protocol = $script:DysonOrchestrationV2RequestProtocol
        schemaVersion = 2
        requestId = $requestId
        approvalId = $approvalId
        runId = $runId
        profileId = [string]$profile.profileId
        profileSha256 = Get-DysonOrchestrationV2ProfileDigest -Profile $profile
        action = $Action
        actionTargetId = [string]$configuration.actionTargetId
        mode = 'preview'
        executionScope = 'fixture'
        targetIdentity = [string]$profile.targetIdentity
        subjectCommit = [string]$profile.subjectCommit
        runtimePayloadSha256 = [string]$profile.runtimePayloadSha256
        issuedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
        deadlineAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddSeconds([Math]::Min(900, [int]$contract.timeoutSeconds))
        evidenceRelativePath = $evidenceRelativePath
        evidenceFileSha256 = Get-DysonOrchestrationV2FileDigest -Path $evidencePath
        predecessorReceiptSha256 = $PredecessorReceiptSha256
        confirmationPhrase = ''
        previewSha256 = $null
    }
    $request.previewSha256 = Get-DysonOrchestrationV2PreviewDigest -Request $request
    return [pscustomobject][ordered]@{
        contract = $contract
        request = $request
        evidence = $evidence
        evidencePath = $evidencePath
        artifacts = $artifacts
        externalObservation = $externalObservation
        soakObservation = $soakObservation
    }
}

function Convert-OrchestrationSelfTestToConsume {
    param([Parameter(Mandatory)]$Request)
    $Request.mode = 'consume'
    $Request.confirmationPhrase = Get-DysonOrchestrationV2ConfirmationPhrase `
        -ExecutionScope ([string]$Request.executionScope) -Action ([string]$Request.action) `
        -ProfileId ([string]$Request.profileId) -RunId ([string]$Request.runId) `
        -RequestId ([string]$Request.requestId) -PreviewSha256 ([string]$Request.previewSha256)
    return $Request
}

function Reset-OrchestrationSelfTestRequestForEvidence {
    param([Parameter(Mandatory)]$Case)
    Write-OrchestrationSelfTestJson -Path $Case.evidencePath -Value $Case.evidence
    $Case.request.evidenceFileSha256 = Get-DysonOrchestrationV2FileDigest -Path $Case.evidencePath
    $Case.request.previewSha256 = Get-DysonOrchestrationV2PreviewDigest -Request $Case.request
    if ([string]$Case.request.mode -ceq 'consume') {
        $Case.request.confirmationPhrase = Get-DysonOrchestrationV2ConfirmationPhrase `
            -ExecutionScope ([string]$Case.request.executionScope) -Action ([string]$Case.request.action) `
            -ProfileId ([string]$Case.request.profileId) -RunId ([string]$Case.request.runId) `
            -RequestId ([string]$Case.request.requestId) -PreviewSha256 ([string]$Case.request.previewSha256)
    }
}

function Set-OrchestrationSelfTestArtifactValue {
    param(
        [Parameter(Mandatory)]$Case,
        [Parameter(Mandatory)][string]$Role,
        [Parameter(Mandatory)]$Value
    )
    $matches = @($Case.evidence.artifacts | Where-Object { [string]$_.role -ceq $Role })
    if ($matches.Count -ne 1) { throw ('Fixture artifact role missing: ' + $Role) }
    $artifact = $matches[0]
    $relativePath = ([string]$artifact.relativePath).Replace('/','\')
    $path = Join-Path $evidenceRoot $relativePath
    Write-OrchestrationSelfTestJson -Path $path -Value $Value
    $artifact.fileSha256 = Get-DysonOrchestrationV2FileDigest -Path $path
    $internal = Get-DysonOrchestrationV2ArtifactDigest -Value $Value
    $artifact.receiptSha256 = if ($null -ne $internal) { $internal } else { [string]$artifact.fileSha256 }
    $Case.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $Case.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $Case
}

function Get-OrchestrationSelfTestArtifactValue {
    param([Parameter(Mandatory)]$Case, [Parameter(Mandatory)][string]$Role)
    $matches = @($Case.evidence.artifacts | Where-Object { [string]$_.role -ceq $Role })
    if ($matches.Count -ne 1) { throw ('Fixture artifact role missing: ' + $Role) }
    $relativePath = ([string]$matches[0].relativePath).Replace('/','\')
    $path = Join-Path $evidenceRoot $relativePath
    return ConvertFrom-DysonOrchestrationV2StrictJson -Text ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)) `
        -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
}



function Assert-OrchestrationSelfTestExternalJoinRejected {
    param(
        [Parameter(Mandatory)]$Case,
        [Parameter(Mandatory)][string]$Message,
        [string]$ExpectedCode = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    )
    $actualCode = $null
    try {
        [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $Case.request `
            -KeyResolver $resolver -NowUtc $now)
    }
    catch { $actualCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($actualCode -ceq $ExpectedCode) ($Message + '; actual=' + [string]$actualCode)
}

function Assert-OrchestrationSelfTestDeploymentRejected {
    param(
        [Parameter(Mandatory)]$Case,
        [Parameter(Mandatory)][string]$Message,
        [string]$ExpectedCode = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    )
    $actualCode = $null
    try {
        [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $Case.request `
            -KeyResolver $resolver -NowUtc $now)
    }
    catch { $actualCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($actualCode -ceq $ExpectedCode) ($Message + '; actual=' + [string]$actualCode)
}

function Set-OrchestrationSelfTestPairedSaveObservation {
    param(
        [Parameter(Mandatory)]$Case,
        [Parameter(Mandatory)]$Value
    )
    Set-OrchestrationSelfTestArtifactValue -Case $Case -Role 'restored-world-observation' -Value $Value
    $Case.evidence.assertions.terminalReceiptSha256 = 'sha256:' + [string]$Value.observationSha256
    $Case.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $Case.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $Case
}

function Assert-OrchestrationSelfTestPairedSaveRejected {
    param([Parameter(Mandatory)]$Case, [Parameter(Mandatory)][string]$Message)
    $actualCode = $null
    try {
        [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $Case.request `
            -KeyResolver $resolver -NowUtc $now)
    }
    catch { $actualCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($actualCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID') `
        ($Message + '; actual=' + [string]$actualCode)
}









function Set-OrchestrationSelfTestSoakObservation {
    param([Parameter(Mandatory)]$Case, [Parameter(Mandatory)]$Value)
    Set-OrchestrationSelfTestArtifactValue -Case $Case -Role 'soak-observation' -Value $Value
    $Case.evidence.observedAtUtc = [string]$Value.observedAtUtc
    $Case.evidence.expiresAtUtc = [string]$Value.expiresAtUtc
    $Case.evidence.assertions.startedAtUtc = [string]$Value.observationWindow.startedAtUtc
    $Case.evidence.assertions.completedAtUtc = [string]$Value.observationWindow.completedAtUtc
    $Case.evidence.assertions.elapsedMonotonicSeconds = [int64]$Value.observationWindow.elapsedMonotonicSeconds
    $Case.evidence.assertions.sampleCount = [int64]$Value.telemetry.sampleCount
    $Case.evidence.assertions.maximumSampleGapSeconds = [int64]$Value.telemetry.maximumGapSeconds
    $Case.evidence.assertions.initialJoinReceiptSha256 = [string]$Value.externalSession.initialJoinReceiptSha256
    $Case.evidence.assertions.reconnectReceiptSha256 = [string]$Value.externalSession.reconnectReceiptSha256
    $Case.evidence.assertions.terminalReceiptSha256 = [string]$Value.observationSha256
    $Case.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $Case.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $Case
}

function Assert-OrchestrationSelfTestSoakRejected {
    param(
        [Parameter(Mandatory)]$Case,
        [Parameter(Mandatory)][string]$Message,
        [string]$ExpectedCode = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    )
    $actualCode = $null
    try {
        [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $Case.request `
            -KeyResolver $resolver -NowUtc $now)
    }
    catch { $actualCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($actualCode -ceq $ExpectedCode) ($Message + '; actual=' + [string]$actualCode)
}

try {
    [void][IO.Directory]::CreateDirectory($stateRoot)
    [void][IO.Directory]::CreateDirectory($evidenceRoot)
    $contract = Get-DysonOrchestrationV2Contract
    foreach ($entry in @($contract.actions)) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $keys[[string]$entry.keyId] = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$entry.keyId)) }
        finally { $sha.Dispose() }
    }
    $resolver = ${function:Get-OrchestrationSelfTestKey}
    $adapterValues = [ordered]@{}
    $ordinal = 0
    foreach ($entry in @($contract.actions)) {
        $ordinal++
        $adapterValues[[string]$entry.actionKey] = [pscustomobject][ordered]@{
            enabled = $true
            actionTargetId = ('target-{0:d2}-{1}' -f $ordinal, [string]$entry.action)
            adapterId = [string]$entry.adapterId
            verifierId = [string]$entry.verifierId
            keyId = [string]$entry.keyId
        }
    }
    $profile = [pscustomobject][ordered]@{
        protocol = $script:DysonOrchestrationV2ProfileProtocol
        schemaVersion = 2
        profileId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        profileLabel = 'fixture-profile-v2'
        enabled = $true
        targetIdentity = 'sha256:' + ('a' * 64)
        subjectCommit = 'b' * 40
        runtimePayloadSha256 = 'sha256:' + ('c' * 64)
        expiresAtUtc = '2026-09-30T00:00:00.000Z'
        stateRoot = [IO.Path]::GetFullPath($stateRoot).TrimEnd('\')
        evidenceRoot = [IO.Path]::GetFullPath($evidenceRoot).TrimEnd('\')
        adapters = [pscustomobject]$adapterValues
    }
    $now = [datetimeoffset]'2026-09-04T04:00:00.000Z'

    $stage = 'contract-and-schema-coverage'
    [void](Assert-DysonOrchestrationV2Profile -Profile $profile -NowUtc $now)
    Assert-OrchestrationSelfTest (@($contract.actions).Count -eq 9 -and
        @($contract.actions | Where-Object { [string]$_.action -eq 'six-hour-soak' -and [int64]$_.minimumElapsedSeconds -eq 21600 -and [int64]$_.maximumEvidenceAgeSeconds -eq 3600 -and [string]$_.artifacts[0].protocol -ceq 'DYSON_SOAK_OBSERVATION_V2' }).Count -eq 1 -and
        @($contract.actions | Where-Object { [string]$_.action -eq 'seventy-two-hour-soak' -and [int64]$_.minimumElapsedSeconds -eq 259200 -and [int64]$_.maximumEvidenceAgeSeconds -eq 3600 -and [string]$_.artifacts[0].protocol -ceq 'DYSON_SOAK_OBSERVATION_V2' }).Count -eq 1) `
        'the fixed contract did not retain all 9 actions and real soak floors'
    foreach ($schemaName in @('qualification-orchestration-profile.v2.schema.json',
            'qualification-orchestration-request.v2.schema.json','qualification-controlled-evidence.v2.schema.json')) {
        $schema = Get-Content -LiteralPath (Join-Path $PSScriptRoot $schemaName) -Raw | ConvertFrom-Json
        Assert-OrchestrationSelfTest ($schema.additionalProperties -is [bool] -and -not [bool]$schema.additionalProperties) `
            ('schema is not exact-property: ' + $schemaName)
    }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'duplicate-json-keys-rejected'
    $duplicateCode = $null
    try {
        [void](ConvertFrom-DysonOrchestrationV2StrictJson `
            -Text '{"action":"authenticated-panel","\u0061ction":"external-client-e2e"}' `
            -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID')
    }
    catch { $duplicateCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($duplicateCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DUPLICATE_JSON_KEY') `
        'escaped duplicate JSON object keys were accepted before exact-property validation'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'preview-is-read-only'
    $first = New-OrchestrationSelfTestCase -Action 'paired-save-restore' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now
    $storePath = Join-Path $stateRoot $script:DysonOrchestrationV2StoreDirectory
    $preview = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $first.request `
        -KeyResolver $resolver -NowUtc $now
    Assert-OrchestrationSelfTest ([string]$preview.decision -ceq 'preview-valid' -and
        -not [bool]$preview.qualificationStateChanged -and -not [bool]$preview.productionChanged -and
        -not (Test-Path -LiteralPath $storePath)) 'preview created state or reported a production change'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'whatif-is-read-only'
    $whatIfRequest = Convert-OrchestrationSelfTestToConsume -Request `
        (Copy-OrchestrationSelfTestValue -Value $first.request)
    # Windows PowerShell 5.1 writes ShouldProcess's WhatIf notice directly to the
    # host, outside the redirectable streams.  Exercise the real common
    # parameter in an isolated runspace so this self-test retains a single JSON
    # stdout record for the aggregate test runner.
    $whatIfPowerShell = [PowerShell]::Create()
    try {
        $whatIfPowerShell.Runspace.SessionStateProxy.SetVariable(
            'orchestrationModulePath', (Join-Path $PSScriptRoot 'Qualification.OrchestrationV2.ps1'))
        $whatIfPowerShell.Runspace.SessionStateProxy.SetVariable('whatIfProfile', $profile)
        $whatIfPowerShell.Runspace.SessionStateProxy.SetVariable('whatIfRequest', $whatIfRequest)
        $whatIfPowerShell.Runspace.SessionStateProxy.SetVariable('whatIfKeys', $keys)
        $whatIfPowerShell.Runspace.SessionStateProxy.SetVariable('whatIfNowUtc', $now)
        [void]$whatIfPowerShell.AddScript(@'
. $orchestrationModulePath
$whatIfResolver = {
    param([string]$KeyId)
    if (-not $whatIfKeys.ContainsKey($KeyId)) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEY_INVALID'
    }
    $source = [byte[]]$whatIfKeys[$KeyId]
    $copy = New-Object 'byte[]' $source.Length
    [Array]::Copy($source, $copy, $source.Length)
    return $copy
}
Invoke-DysonQualificationOrchestrationV2 -Profile $whatIfProfile -Request $whatIfRequest `
    -KeyResolver $whatIfResolver -NowUtc $whatIfNowUtc -WhatIf
'@)
        $whatIfOutput = @($whatIfPowerShell.Invoke())
        if ($whatIfPowerShell.HadErrors -or $whatIfOutput.Count -ne 1) {
            throw ('DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_FAILED: isolated WhatIf invocation failed: ' +
                (@($whatIfPowerShell.Streams.Error) -join '; '))
        }
        $whatIf = $whatIfOutput[0]
    }
    finally { $whatIfPowerShell.Dispose() }
    Assert-OrchestrationSelfTest ([string]$whatIf.decision -ceq 'what-if' -and
        -not [bool]$whatIf.qualificationStateChanged -and -not [bool]$whatIf.productionChanged -and
        -not (Test-Path -LiteralPath $storePath)) 'WhatIf created qualification state or reported a production change'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'fixture-gate-default-closed'
    $consumeFirst = Convert-OrchestrationSelfTestToConsume -Request $first.request
    $closedCode = $null
    try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $consumeFirst -KeyResolver $resolver -NowUtc $now) }
    catch { $closedCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($closedCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_FIXTURE_GATE_CLOSED' -and
        -not (Test-Path -LiteralPath $storePath)) 'the fixture consume gate was not default-closed before state creation'
    Add-OrchestrationSelfTestResult $stage

    [Environment]::SetEnvironmentVariable($script:DysonOrchestrationV2FixtureGateName,
        $script:DysonOrchestrationV2FixtureGateValue, [EnvironmentVariableTarget]::Process)

    $stage = 'all-nine-protected-adapters'
    $adapterStage = $stage
    $predecessor = $script:DysonOrchestrationV2ZeroDigest
    $cases = @{}
    $receipts = @()
    foreach ($action in $script:DysonOrchestrationV2Actions) {
        $stage = $adapterStage + ':' + $action
        $case = if ($action -ceq 'paired-save-restore') { $first } else {
            New-OrchestrationSelfTestCase -Action $action -PredecessorReceiptSha256 $predecessor -NowUtc $now
        }
        if ($action -ceq 'paired-save-restore') { $case.request.predecessorReceiptSha256 = $predecessor; $case.request.previewSha256 = Get-DysonOrchestrationV2PreviewDigest -Request $case.request }
        $case.request = Convert-OrchestrationSelfTestToConsume -Request $case.request
        $accepted = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $case.request `
            -KeyResolver $resolver -NowUtc $now
        Assert-OrchestrationSelfTest ([string]$accepted.decision -ceq 'qualified' -and
            -not [bool]$accepted.reused -and [bool]$accepted.qualificationStateChanged -and
            -not [bool]$accepted.productionChanged -and [string]$accepted.receipt.action -ceq $action) `
            ('protected adapter did not qualify: ' + $action)
        $predecessor = [string]$accepted.receipt.receiptSha256
        $receipts += ,$accepted.receipt
        $cases[$action] = $case
    }
    Assert-OrchestrationSelfTest ($receipts.Count -eq 9 -and [int64]$receipts[8].sequence -eq 9) `
        'the 9-action receipt chain was incomplete'
    $stage = $adapterStage
    Add-OrchestrationSelfTestResult $stage

    $stage = 'idempotent-replay'
    $last = $cases['external-client-e2e']
    $replay = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $last.request `
        -KeyResolver $resolver -NowUtc $now
    Assert-OrchestrationSelfTest ([bool]$replay.reused -and -not [bool]$replay.qualificationStateChanged -and
        [string]$replay.receipt.receiptSha256 -ceq [string]$receipts[-1].receiptSha256) `
        'an exact replay did not return the immutable receipt'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'request-collision'
    $collisionRequest = Copy-OrchestrationSelfTestValue -Value $last.request
    $collisionRequest.deadlineAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddSeconds(899)
    $collisionRequest.previewSha256 = Get-DysonOrchestrationV2PreviewDigest -Request $collisionRequest
    $collisionRequest.confirmationPhrase = Get-DysonOrchestrationV2ConfirmationPhrase `
        -ExecutionScope fixture -Action ([string]$collisionRequest.action) -ProfileId ([string]$collisionRequest.profileId) `
        -RunId ([string]$collisionRequest.runId) -RequestId ([string]$collisionRequest.requestId) `
        -PreviewSha256 ([string]$collisionRequest.previewSha256)
    $collisionCode = $null
    try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $collisionRequest -KeyResolver $resolver -NowUtc $now) }
    catch { $collisionCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($collisionCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REQUEST_COLLISION') `
        'a reused request UUID with changed content did not collide'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'source-byte-tamper'
    $panel = $cases['authenticated-panel']
    $panelArtifactPath = Join-Path $evidenceRoot ($panel.artifacts[0].relativePath.Replace('/','\'))
    $panelBytes = [IO.File]::ReadAllBytes($panelArtifactPath)
    try {
        [IO.File]::AppendAllText($panelArtifactPath, " ", [Text.Encoding]::UTF8)
        $tamperCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $panel.request -KeyResolver $resolver -NowUtc $now) }
        catch { $tamperCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($tamperCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH') `
            'changed source bytes were not independently rehashed'
    }
    finally { [IO.File]::WriteAllBytes($panelArtifactPath, $panelBytes) }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'protected-envelope-tamper'
    $originalEvidence = Copy-OrchestrationSelfTestValue -Value $panel.evidence
    try {
        $panel.evidence.protection.hmacSha256 = 'sha256:' + ('0' * 64)
        Reset-OrchestrationSelfTestRequestForEvidence -Case $panel
        $hmacCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $panel.request -KeyResolver $resolver -NowUtc $now) }
        catch { $hmacCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($hmacCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_HMAC_INVALID') `
            'an invalid controlled-evidence HMAC was accepted'
    }
    finally {
        $panel.evidence = $originalEvidence
        Reset-OrchestrationSelfTestRequestForEvidence -Case $panel
    }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'subject-and-observation-time-binding'
    $originalPanelBinding = Copy-OrchestrationSelfTestValue -Value $panel.evidence
    try {
        $panel.evidence.assertions.subjectBindingSha256 = 'sha256:' + ('d' * 64)
        $panel.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $panel.evidence
        Reset-OrchestrationSelfTestRequestForEvidence -Case $panel
        $subjectCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $panel.request -KeyResolver $resolver -NowUtc $now) }
        catch { $subjectCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($subjectCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SUBJECT_BINDING_INVALID') `
            'a re-signed envelope with a forged subject binding was accepted'

        $panel.evidence = Copy-OrchestrationSelfTestValue -Value $originalPanelBinding
        $panel.evidence.assertions.completedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddMinutes(-10)
        $panel.evidence.assertions.startedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddMinutes(-10).AddSeconds(-1)
        $panel.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $panel.evidence
        Reset-OrchestrationSelfTestRequestForEvidence -Case $panel
        $timeCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $panel.request -KeyResolver $resolver -NowUtc $now) }
        catch { $timeCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($timeCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_BOUNDS_INVALID') `
            'a fresh envelope was allowed to relabel a stale completed observation'
    }
    finally {
        $panel.evidence = $originalPanelBinding
        Reset-OrchestrationSelfTestRequestForEvidence -Case $panel
    }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'strict-check-set-and-soak-bounds'
    $soak = $cases['seventy-two-hour-soak']
    $originalSoak = Copy-OrchestrationSelfTestValue -Value $soak.evidence
    try {
        $soak.evidence.assertions.elapsedMonotonicSeconds = 259199
        $soak.evidence.assertions.startedAtUtc = ConvertTo-DysonQualificationV2Utc -Value `
            ((ConvertFrom-DysonQualificationV2Utc -Value ([string]$soak.evidence.assertions.completedAtUtc) -Code 'X').AddSeconds(-259199))
        $soak.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $soak.evidence
        Reset-OrchestrationSelfTestRequestForEvidence -Case $soak
        $soakCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $soak.request -KeyResolver $resolver -NowUtc $now) }
        catch { $soakCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($soakCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_BOUNDS_INVALID') `
            'a 72-hour receipt below 259200 real monotonic seconds was accepted'
    }
    finally {
        $soak.evidence = $originalSoak
        Reset-OrchestrationSelfTestRequestForEvidence -Case $soak
    }
    $checkCase = $cases['game-protocol-path']
    $originalCheck = Copy-OrchestrationSelfTestValue -Value $checkCase.evidence
    try {
        $checkCase.evidence.assertions.checkCodes = @($checkCase.evidence.assertions.checkCodes | Select-Object -Skip 1)
        $checkCase.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $checkCase.evidence
        Reset-OrchestrationSelfTestRequestForEvidence -Case $checkCase
        $checkCode = $null
        try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $checkCase.request -KeyResolver $resolver -NowUtc $now) }
        catch { $checkCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
        Assert-OrchestrationSelfTest ($checkCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CHECK_SET_INVALID') `
            'a controlled receipt with a missing required check was accepted'
    }
    finally {
        $checkCase.evidence = $originalCheck
        Reset-OrchestrationSelfTestRequestForEvidence -Case $checkCase
    }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'independent-deployment-real-receipt-binding'
    $syntheticDeployment = New-OrchestrationSelfTestCase -Action 'independent-deployment' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'synthetic-install'
    Set-OrchestrationSelfTestArtifactValue -Case $syntheticDeployment -Role 'deployment-receipt' -Value `
        ([pscustomobject][ordered]@{ protocol='DYSON_CONTROL_DEPLOYMENT_V1'; state='installed'; operation='install'; candidateHealthy=$true })
    Assert-OrchestrationSelfTestDeploymentRejected -Case $syntheticDeployment `
        -Message 'a synthetic self-reported deployment object was accepted'

    $payloadSplice = New-OrchestrationSelfTestCase -Action 'independent-deployment' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'payload-splice'
    $payloadValue = Get-OrchestrationSelfTestArtifactValue -Case $payloadSplice -Role 'deployment-receipt'
    $payloadValue.artifactPayloadSha256 = 'e' * 64
    Set-OrchestrationSelfTestArtifactValue -Case $payloadSplice -Role 'deployment-receipt' -Value $payloadValue
    Assert-OrchestrationSelfTestDeploymentRejected -Case $payloadSplice `
        -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DEPLOYMENT_BINDING_INVALID' `
        -Message 'a deployment receipt for another runtime payload was accepted'

    $versionSplice = New-OrchestrationSelfTestCase -Action 'independent-deployment' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'version-splice'
    $versionValue = Get-OrchestrationSelfTestArtifactValue -Case $versionSplice -Role 'deployment-receipt'
    $versionValue.version = '0.1.1-rc.1'
    Set-OrchestrationSelfTestArtifactValue -Case $versionSplice -Role 'deployment-receipt' -Value $versionValue
    Assert-OrchestrationSelfTestDeploymentRejected -Case $versionSplice `
        -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DEPLOYMENT_BINDING_INVALID' `
        -Message 'a deployment receipt for another panel release was accepted'

    $snapshotSplice = New-OrchestrationSelfTestCase -Action 'independent-deployment' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'snapshot-splice'
    $snapshotValue = Get-OrchestrationSelfTestArtifactValue -Case $snapshotSplice -Role 'deployment-rollback-receipt'
    $snapshotValue.snapshotId = $now.AddMilliseconds(-2).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-eeeeeeee'
    Set-OrchestrationSelfTestArtifactValue -Case $snapshotSplice -Role 'deployment-rollback-receipt' -Value $snapshotValue
    $snapshotRollbackArtifact = @($snapshotSplice.evidence.artifacts | Where-Object { [string]$_.role -ceq 'deployment-rollback-receipt' })[0]
    $snapshotSplice.evidence.assertions.rollbackReceiptSha256 = [string]$snapshotRollbackArtifact.receiptSha256
    $snapshotSplice.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $snapshotSplice.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $snapshotSplice
    Assert-OrchestrationSelfTestDeploymentRejected -Case $snapshotSplice `
        -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DEPLOYMENT_BINDING_INVALID' `
        -Message 'a rollback receipt for another deployment snapshot was accepted'

    $unverifiedRollback = New-OrchestrationSelfTestCase -Action 'independent-deployment' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'unverified-rollback'
    $unverifiedRollbackValue = Get-OrchestrationSelfTestArtifactValue -Case $unverifiedRollback -Role 'deployment-rollback-receipt'
    $unverifiedRollbackValue.readinessVerified = $false
    Set-OrchestrationSelfTestArtifactValue -Case $unverifiedRollback -Role 'deployment-rollback-receipt' -Value $unverifiedRollbackValue
    Assert-OrchestrationSelfTestDeploymentRejected -Case $unverifiedRollback `
        -Message 'a rollback receipt without restored readiness was accepted'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'soak-v2-strict-observation-binding'
    foreach ($soakAction in @('six-hour-soak','seventy-two-hour-soak')) {
        $validSoak = New-OrchestrationSelfTestCase -Action $soakAction `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now `
            -CaseSuffix ('strict-valid-' + $soakAction)
        $validSoakPreview = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $validSoak.request `
            -KeyResolver $resolver -NowUtc $now
        Assert-OrchestrationSelfTest ([string]$validSoakPreview.decision -ceq 'preview-valid' -and
            -not [bool]$validSoakPreview.productionChanged) ('a valid ' + $soakAction + ' strict observation did not pass preview')
    }

    $genericSoak = New-OrchestrationSelfTestCase -Action 'six-hour-soak' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'generic-status'
    $genericSoakArtifact = @($genericSoak.evidence.artifacts | Where-Object { [string]$_.role -ceq 'soak-observation' })[0]
    $genericSoakValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_SOAK_OBSERVATION_V2'; schemaVersion = 2
        observationId = [string]$genericSoakArtifact.receiptId; kind = 'six-hour'
        runId = [string]$genericSoak.request.runId; targetIdentity = [string]$profile.targetIdentity
        status = 'verified'; observedAtUtc = [string]$genericSoak.evidence.observedAtUtc
        observationSha256 = $null
    }
    $genericSoakValue.observationSha256 = Get-DysonSoakV2ObservationDigest -Observation $genericSoakValue
    Set-OrchestrationSelfTestArtifactValue -Case $genericSoak -Role 'soak-observation' -Value $genericSoakValue
    $genericSoak.evidence.assertions.terminalReceiptSha256 = [string]$genericSoakValue.observationSha256
    $genericSoak.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $genericSoak.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $genericSoak
    Assert-OrchestrationSelfTestSoakRejected -Case $genericSoak `
        -Message 'a generic re-digested status=verified soak object bypassed the strict observation validator'

    foreach ($mutation in @(
        [pscustomobject]@{ suffix='cross-kind'; kind='kind'; message='another soak action kind' },
        [pscustomobject]@{ suffix='cross-run'; kind='run'; message='another qualification run' },
        [pscustomobject]@{ suffix='cross-target'; kind='target'; message='another target identity' },
        [pscustomobject]@{ suffix='cross-commit'; kind='commit'; message='another subject commit' },
        [pscustomobject]@{ suffix='cross-runtime'; kind='runtime'; message='another runtime payload' },
        [pscustomobject]@{ suffix='virtual-clock'; kind='clock'; message='a virtual clock' },
        [pscustomobject]@{ suffix='segment-sequence'; kind='segment'; message='a re-digested sample sequence splice' },
        [pscustomobject]@{ suffix='segment-gap'; kind='gap'; message='a re-digested segment gap above the declared maximum' },
        [pscustomobject]@{ suffix='http-only'; kind='external'; message='an HTTP-only external check' },
        [pscustomobject]@{ suffix='save-floor'; kind='save'; message='insufficient periodic save acknowledgements' },
        [pscustomobject]@{ suffix='cpu-threshold'; kind='health'; message='a CPU threshold violation' },
        [pscustomobject]@{ suffix='crash'; kind='outcome'; message='a crash outcome' },
        [pscustomobject]@{ suffix='alert'; kind='alert'; message='an unresolved alert' }
    )) {
        $case = New-OrchestrationSelfTestCase -Action 'six-hour-soak' `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix $mutation.suffix
        $value = Get-OrchestrationSelfTestArtifactValue -Case $case -Role 'soak-observation'
        switch ([string]$mutation.kind) {
            'kind' { $value.kind = 'seventy-two-hour' }
            'run' { $value.runId = [guid]::NewGuid().ToString('D').ToLowerInvariant() }
            'target' { $value.targetIdentity = 'sha256:' + ('e' * 64) }
            'commit' { $value.releaseIdentity.subjectCommit = 'd' * 40 }
            'runtime' { $value.releaseIdentity.runtimePayloadSha256 = 'sha256:' + ('e' * 64) }
            'clock' { $value.observationWindow.virtualClock = $true }
            'segment' {
                $value.telemetry.segments[0].lastSampleSequence = [int64]$value.telemetry.segments[0].lastSampleSequence - 1
                $value.telemetry.segments[0].sampleCount = [int64]$value.telemetry.segments[0].sampleCount - 1
            }
            'gap' { $value.telemetry.segments[0].maximumGapSeconds = 16 }
            'external' { $value.externalSession.protocol = 'https' }
            'save' { $value.saves.acknowledgementCount = 36 }
            'health' { $value.health.cpu.hostCpuP95BasisPoints = 9001 }
            'outcome' { $value.outcome.crashCount = 1 }
            'alert' { $value.alerts.unresolvedAlertCount = 1 }
        }
        $value = Update-OrchestrationSelfTestSoakBindings -Observation $value
        Set-OrchestrationSelfTestSoakObservation -Case $case -Value $value
        Assert-OrchestrationSelfTestSoakRejected -Case $case `
            -Message ('a fully re-digested soak observation with ' + [string]$mutation.message + ' was accepted')
    }

    foreach ($splice in @('release','save')) {
        $case = New-OrchestrationSelfTestCase -Action 'six-hour-soak' `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix ('cross-' + $splice)
        $value = Get-OrchestrationSelfTestArtifactValue -Case $case -Role 'soak-observation'
        if ($splice -ceq 'release') { $value.releaseIdentity.releaseVersion = '0.1.1-rc.1' }
        else { $value.externalSession.savePairSha256 = 'sha256:' + ('e' * 64) }
        $value = Update-OrchestrationSelfTestSoakDigest -Observation $value
        Set-OrchestrationSelfTestSoakObservation -Case $case -Value $value
        Assert-OrchestrationSelfTestSoakRejected -Case $case `
            -Message ('a re-signed cross-' + $splice + ' subject splice was accepted')
    }

    $topSoak = New-OrchestrationSelfTestCase -Action 'six-hour-soak' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'top-terminal'
    $topSoak.evidence.assertions.terminalReceiptSha256 = 'sha256:' + ('e' * 64)
    $topSoak.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $topSoak.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $topSoak
    Assert-OrchestrationSelfTestSoakRejected -Case $topSoak `
        -Message 'a re-signed top-level soak terminal splice was accepted'

    $crossSoakKey = New-OrchestrationSelfTestCase -Action 'six-hour-soak' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'cross-key'
    $crossSoakKey.evidence.protection.keyId = 'seventy-two-hour-soak-key-v2'
    $crossSoakKey.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $crossSoakKey.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $crossSoakKey
    Assert-OrchestrationSelfTestSoakRejected -Case $crossSoakKey `
        -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROTECTION_INVALID' `
        -Message 'a soak evidence envelope re-signed under another configured key was accepted'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'paired-save-v2-strict-observation-binding'
    $validPaired = New-OrchestrationSelfTestCase -Action 'paired-save-restore' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'strict-valid'
    $validPairedPreview = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $validPaired.request `
        -KeyResolver $resolver -NowUtc $now
    Assert-OrchestrationSelfTest ([string]$validPairedPreview.decision -ceq 'preview-valid' -and
        -not [bool]$validPairedPreview.productionChanged) 'a valid strict paired-save observation did not pass preview'

    $genericPaired = New-OrchestrationSelfTestCase -Action 'paired-save-restore' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'status-only'
    $genericArtifact = @($genericPaired.evidence.artifacts | Where-Object {
        [string]$_.role -ceq 'restored-world-observation'
    })[0]
    $genericValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'
        schemaVersion = 2
        observationId = [string]$genericArtifact.receiptId
        qualificationRunId = [string]$genericPaired.request.runId
        controlRelease = 'v0.1.0-rc.1'
        subjectCommit = [string]$profile.subjectCommit
        restoreReceipt = $null
        protectionPoint = $null
        bridgeLoadedSave = $null
        newSaveAcknowledgement = $null
        stableSavePair = $null
        rollbackReceipt = $null
        status = 'verified'
        observedAtUtc = [string]$genericPaired.evidence.observedAtUtc
        expiresAtUtc = [string]$genericPaired.evidence.expiresAtUtc
        observationSha256 = $null
    }
    $genericValue.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $genericValue
    Set-OrchestrationSelfTestPairedSaveObservation -Case $genericPaired -Value $genericValue
    Assert-OrchestrationSelfTestPairedSaveRejected -Case $genericPaired `
        -Message 'a re-digested status=verified object bypassed the strict paired-save validator'

    foreach ($mutation in @(
        [pscustomobject]@{ suffix='cross-run'; kind='run'; message='another qualification run' },
        [pscustomobject]@{ suffix='cross-commit'; kind='commit'; message='another subject commit' },
        [pscustomobject]@{ suffix='cross-save'; kind='save'; message='another stable save pair' },
        [pscustomobject]@{ suffix='cross-rollback'; kind='rollback'; message='another rollback receipt' }
    )) {
        $case = New-OrchestrationSelfTestCase -Action 'paired-save-restore' `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix $mutation.suffix
        $value = Get-OrchestrationSelfTestArtifactValue -Case $case -Role 'restored-world-observation'
        switch ([string]$mutation.kind) {
            'run' { $value.qualificationRunId = [guid]::NewGuid().ToString('D').ToLowerInvariant() }
            'commit' { $value.subjectCommit = 'd' * 40 }
            'save' {
                $value.stableSavePair.dsvSha256 = 'd' * 64
                $value.stableSavePair.pairSha256 = Get-DysonPairedSaveLoadTextSha256 `
                    (ConvertTo-DysonPairedSaveLoadCanonicalJson ([pscustomobject][ordered]@{
                        protocol = [string]$value.stableSavePair.protocol
                        saveName = [string]$value.stableSavePair.saveName
                        dsvLength = [int64]$value.stableSavePair.dsvLength
                        dsvWriteTimeUtcTicks = [int64]$value.stableSavePair.dsvWriteTimeUtcTicks
                        dsvSha256 = [string]$value.stableSavePair.dsvSha256
                        serverLength = [int64]$value.stableSavePair.serverLength
                        serverWriteTimeUtcTicks = [int64]$value.stableSavePair.serverWriteTimeUtcTicks
                        serverSha256 = [string]$value.stableSavePair.serverSha256
                    }))
            }
            'rollback' { $value.rollbackReceipt.sourceSha256 = 'e' * 64 }
        }
        $value.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $value
        Set-OrchestrationSelfTestPairedSaveObservation -Case $case -Value $value
        Assert-OrchestrationSelfTestPairedSaveRejected -Case $case `
            -Message ('a fully re-digested paired-save record from ' + [string]$mutation.message + ' was accepted')
    }
    Add-OrchestrationSelfTestResult $stage

    $stage = 'external-join-v2-strict-observation-binding'
    $validExternal = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'strict-valid'
    $validExternalPreview = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $validExternal.request `
        -KeyResolver $resolver -NowUtc $now
    Assert-OrchestrationSelfTest ([string]$validExternalPreview.decision -ceq 'preview-valid' -and
        -not [bool]$validExternalPreview.productionChanged) 'a valid strict external join observation did not pass preview'

    $genericExternal = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'status-only'
    $genericArtifact = $genericExternal.evidence.artifacts[0]
    $genericValue = [pscustomobject][ordered]@{
        protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2'; schemaVersion = 2
        observationId = [string]$genericArtifact.receiptId; runId = [string]$genericExternal.request.runId
        status = 'verified'; observedAtUtc = [string]$genericExternal.evidence.observedAtUtc
        expiresAtUtc = [string]$genericExternal.evidence.expiresAtUtc; observationSha256 = $null
    }
    $genericValue.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $genericValue
    Set-OrchestrationSelfTestArtifactValue -Case $genericExternal -Role 'external-join-observation' -Value $genericValue
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $genericExternal `
        -Message 'a recomputed status=verified object bypassed the strict external join validator'

    $legacyExternal = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'legacy-v1'
    $legacyValue = New-OrchestrationSelfTestLegacyExternalTranscript -StartUtc $now.AddMinutes(-10)
    Set-OrchestrationSelfTestArtifactValue -Case $legacyExternal -Role 'external-join-observation' -Value $legacyValue
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $legacyExternal `
        -Message 'a legacy v1 11-receipt transcript was accepted as an external join v2 observation'

    $crossRun = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'cross-run'
    $crossRunValue = Get-OrchestrationSelfTestArtifactValue -Case $crossRun -Role 'external-join-observation'
    $crossRunValue.runId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $crossRunValue = Update-OrchestrationSelfTestExternalJoinBindings -Observation $crossRunValue
    Set-OrchestrationSelfTestArtifactValue -Case $crossRun -Role 'external-join-observation' -Value $crossRunValue
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $crossRun -Message 'a fully rebound observation from another run was accepted'

    $crossTarget = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'cross-target'
    $crossTarget.request.actionTargetId = 'target-foreign-external-client-e2e'
    $crossTarget.evidence.actionTargetId = [string]$crossTarget.request.actionTargetId
    $crossTarget.evidence.assertions.subjectBindingSha256 = Get-DysonOrchestrationV2SubjectBindingDigest -Evidence $crossTarget.evidence
    $crossTarget.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $crossTarget.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $crossTarget
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $crossTarget -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TARGET_MISMATCH' `
        -Message 'a re-signed envelope for another action target was accepted'

    foreach ($mutation in @(
        [pscustomobject]@{ suffix='cross-commit'; property='subjectCommit'; value=('d' * 40); message='another commit' },
        [pscustomobject]@{ suffix='cross-runtime'; property='runtimePayloadSha256'; value=('sha256:' + ('e' * 64)); message='another runtime payload' }
    )) {
        $case = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix $mutation.suffix
        $value = Get-OrchestrationSelfTestArtifactValue -Case $case -Role 'external-join-observation'
        $value.releaseIdentity.([string]$mutation.property) = [string]$mutation.value
        $value = Update-OrchestrationSelfTestExternalJoinBindings -Observation $value
        Set-OrchestrationSelfTestArtifactValue -Case $case -Role 'external-join-observation' -Value $value
        Assert-OrchestrationSelfTestExternalJoinRejected -Case $case -Message ('a fully rebound observation from ' + $mutation.message + ' was accepted')
    }

    $crossKey = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 'cross-key'
    $crossKey.evidence.protection.keyId = [string](Get-DysonOrchestrationV2ActionConfiguration `
        -Profile $profile -Action 'authenticated-panel').keyId
    $crossKey.evidence = Protect-OrchestrationSelfTestEvidence -Evidence $crossKey.evidence
    Reset-OrchestrationSelfTestRequestForEvidence -Case $crossKey
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $crossKey `
        -ExpectedCode 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROTECTION_INVALID' `
        -Message 'a controlled evidence envelope re-signed under another configured key was accepted'

    foreach ($splice in @('session','client','release','save','host')) {
        $case = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
            -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix ('cross-' + $splice)
        $value = Get-OrchestrationSelfTestArtifactValue -Case $case -Role 'external-join-observation'
        switch ($splice) {
            'session' { $value.sessionBinding.initialQualificationSessionId = [guid]::NewGuid().ToString('D').ToLowerInvariant() }
            'client' { $value.client.clientPseudonym = 'client:sha256:' + ('e' * 64) }
            'release' { $value.releaseIdentity.releaseVersion = '0.1.1-rc.1' }
            'save' { $value.saveBinding.saveReceiptSha256 = 'sha256:' + ('e' * 64) }
            'host' { $value.publicEndpoint.publicHost = 'foreign.example.com' }
        }
        $value = Update-OrchestrationSelfTestExternalJoinDigest -Observation $value
        Set-OrchestrationSelfTestArtifactValue -Case $case -Role 'external-join-observation' -Value $value
        Assert-OrchestrationSelfTestExternalJoinRejected -Case $case `
            -Message ('a re-signed cross-' + $splice + ' splice was accepted')
    }

    $reSignedTamper = New-OrchestrationSelfTestCase -Action 'external-client-e2e' `
        -PredecessorReceiptSha256 $script:DysonOrchestrationV2ZeroDigest -NowUtc $now -CaseSuffix 're-signed-tamper'
    $reSignedValue = Get-OrchestrationSelfTestArtifactValue -Case $reSignedTamper -Role 'external-join-observation'
    $reSignedValue.events[5].evidence.joined = $false
    $reSignedValue = Update-OrchestrationSelfTestExternalJoinBindings -Observation $reSignedValue
    Set-OrchestrationSelfTestArtifactValue -Case $reSignedTamper -Role 'external-join-observation' -Value $reSignedValue
    Assert-OrchestrationSelfTestExternalJoinRejected -Case $reSignedTamper `
        -Message 'a fully re-digested and envelope-re-signed failed join was accepted'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'hard-exit-resume-without-reingestion-replay'
    $resumeCase = New-OrchestrationSelfTestCase -Action 'authenticated-panel' `
        -PredecessorReceiptSha256 $predecessor -NowUtc $now -CaseSuffix 'resume'
    $resumeCase.request = Convert-OrchestrationSelfTestToConsume -Request $resumeCase.request
    $exitCode = $null
    try {
        [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $resumeCase.request `
            -KeyResolver $resolver -NowUtc $now -Injection IntentAfterRename)
    }
    catch { $exitCode = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($exitCode -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TEST_EXIT') `
        'the intent hard-exit fixture did not stop after durable intent publication'
    $resumeRequired = $null
    try { [void](Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $resumeCase.request -KeyResolver $resolver -NowUtc $now) }
    catch { $resumeRequired = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception }
    Assert-OrchestrationSelfTest ($resumeRequired -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RESUME_REQUIRED') `
        'a persisted orphan intent did not require explicit resume'
    $resumed = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $resumeCase.request `
        -KeyResolver $resolver -NowUtc $now -Resume
    Assert-OrchestrationSelfTest ([string]$resumed.decision -ceq 'qualified' -and
        [int64]$resumed.receipt.sequence -eq ($receipts.Count + 1) -and -not [bool]$resumed.productionChanged) `
        'explicit resume did not finish the validated receipt without a production mutation'
    Add-OrchestrationSelfTestResult $stage

    $stage = 'production-gate-never-invoked'
    Assert-OrchestrationSelfTest ([Environment]::GetEnvironmentVariable($script:DysonOrchestrationV2ProductionGateName,
            [EnvironmentVariableTarget]::Process) -cne $script:DysonOrchestrationV2ProductionGateValue) `
        'the production environment gate was opened by the self-test'
    Add-OrchestrationSelfTestResult $stage

    [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST'
        schemaVersion = 2
        result = 'passed'
        testCount = $results.Count
        passedCount = $results.Count
        tests = @($results)
        actionsCovered = @($script:DysonOrchestrationV2Actions)
        productionBackendInvoked = $false
        productionMutationImplemented = $false
        qualificationStateOnly = $true
        serviceControlTouched = $false
        taskSchedulerTouched = $false
        networkTouched = $false
        saveTouched = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
catch {
    throw ('DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_STAGE_FAILED: stage=' + $stage +
        '; line=' + [string]$_.InvocationInfo.ScriptLineNumber + '; detail=' + [string]$_.Exception.Message)
}
finally {
    [Environment]::SetEnvironmentVariable($script:DysonOrchestrationV2FixtureGateName, $oldFixtureGate, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable($script:DysonOrchestrationV2ProductionGateName, $oldProductionGate, [EnvironmentVariableTarget]::Process)
    foreach ($key in @($keys.Values)) {
        if ($null -ne $key) { [Array]::Clear([byte[]]$key, 0, ([byte[]]$key).Length) }
    }
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        $full = [IO.Path]::GetFullPath($testRoot).TrimEnd('\','/')
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $full.StartsWith($temporary + 'dyson-qualification-orchestration-v2-selftest-', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST_CLEANUP_TARGET_INVALID'
        }
        [IO.Directory]::Delete($full, $true)
    }
}
