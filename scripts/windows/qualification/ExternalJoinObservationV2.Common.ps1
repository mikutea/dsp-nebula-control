# Copyright (c) Dyson Control contributors.
# Strict, privacy-preserving external join observation protocol v2.

Set-StrictMode -Version 2.0

if ($null -eq (Get-Command -Name Get-DysonQualificationV2ObjectDigest -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')
}

$script:DysonExternalJoinObservationV2Protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2'
$script:DysonExternalJoinObservationV2InputProtocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_INPUT_V2'
$script:DysonExternalJoinObservationV2SchemaVersion = 2
$script:DysonExternalJoinObservationV2MaximumBytes = [int64](2MB)
$script:DysonExternalJoinObservationV2Events = @(
    'dns-resolved',
    'tls-established',
    'wss-established',
    'nebula-transport-established',
    'nebula-authenticated',
    'nebula-joined',
    'interaction-observed',
    'save-requested',
    'save-verified',
    'disconnected',
    'reconnect-transport-established',
    'nebula-rejoined'
)
$script:DysonExternalJoinObservationV2Observers = @(
    'external-network',
    'external-client',
    'external-client',
    'server-authoritative',
    'server-authoritative',
    'server-authoritative',
    'server-authoritative',
    'server-authoritative',
    'independent-save',
    'server-authoritative',
    'external-client',
    'server-authoritative'
)
$script:DysonExternalJoinObservationV2MaximumLegSeconds = @(0,300,120,120,300,300,300,300,600,300,600,600)

function New-DysonExternalJoinObservationV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonExternalJoinObservationV2Error {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonExternalJoinObservationV2Exception -Code $Code)
}

function Get-DysonExternalJoinObservationV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '(DYSON_EXTERNAL_JOIN_OBSERVATION_V2_[A-Z0-9_]+)') { return [string]$Matches[1] }
    return 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_UNEXPECTED_FAILURE'
}

function Assert-DysonExternalJoinObservationV2ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    try { Assert-DysonQualificationV2ExactProperties -Value $Value -Names $Names -Code $Code }
    catch { Throw-DysonExternalJoinObservationV2Error -Code $Code }
}

function Test-DysonExternalJoinObservationV2Integer {
    param([AllowNull()]$Value, [int64]$Minimum, [int64]$Maximum)
    if (-not (Test-DysonQualificationV2Integer -Value $Value)) { return $false }
    $number = [int64]$Value
    return $number -ge $Minimum -and $number -le $Maximum
}

function Test-DysonExternalJoinObservationV2Hostname {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value.Length -le 253 -and
        $Value -ceq $Value.ToLowerInvariant() -and
        $Value -cmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
}

function Test-DysonExternalJoinObservationV2Pseudonym {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^client:sha256:[0-9a-f]{64}$'
}

function ConvertFrom-DysonExternalJoinObservationV2Utc {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Code)
    try { return ConvertFrom-DysonQualificationV2Utc -Value $Value -Code $Code }
    catch { Throw-DysonExternalJoinObservationV2Error -Code $Code }
}

function Get-DysonExternalJoinObservationV2UnsignedValue {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$ExcludedName)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { [string]$_.Name -cne $ExcludedName } | Sort-Object -Property Name -CaseSensitive)) {
        $result[[string]$property.Name] = $property.Value
    }
    return [pscustomobject]$result
}

function Get-DysonExternalJoinObservationV2EventDigest {
    param([Parameter(Mandatory)]$EventValue)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonExternalJoinObservationV2UnsignedValue -Value $EventValue -ExcludedName 'eventSha256')
}

function Get-DysonExternalJoinObservationV2Digest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonExternalJoinObservationV2UnsignedValue -Value $Observation -ExcludedName 'observationSha256')
}

function Get-DysonExternalJoinObservationV2SessionBindingDigest {
    param(
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$ClientPseudonym,
        [Parameter(Mandatory)]$SessionBinding,
        [Parameter(Mandatory)][string]$ReleaseBindingSha256,
        [Parameter(Mandatory)][string]$EndpointBindingSha256
    )
    return Get-DysonQualificationV2ObjectDigest -Value ([ordered]@{
        domain = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SESSION_BINDING'
        runId = $RunId
        clientPseudonym = $ClientPseudonym
        initialQualificationSessionId = [string]$SessionBinding.initialQualificationSessionId
        reconnectQualificationSessionId = [string]$SessionBinding.reconnectQualificationSessionId
        initialChallengeId = [string]$SessionBinding.initialChallengeId
        reconnectChallengeId = [string]$SessionBinding.reconnectChallengeId
        worldBindingSha256 = [string]$SessionBinding.worldBindingSha256
        releaseBindingSha256 = $ReleaseBindingSha256
        endpointBindingSha256 = $EndpointBindingSha256
    })
}

function Assert-DysonExternalJoinObservationV2Input {
    param([Parameter(Mandatory)]$InputValue)
    $code = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_INPUT_INVALID'
    Assert-DysonExternalJoinObservationV2ExactProperties -Value $InputValue -Names @(
        'protocol','schemaVersion','observationId','runId','releaseIdentity','publicEndpoint','client',
        'sessionBinding','saveBinding','events','observedAtUtc','expiresAtUtc'
    ) -Code $code
    if ([string]$InputValue.protocol -cne $script:DysonExternalJoinObservationV2InputProtocol -or
        -not (Test-DysonExternalJoinObservationV2Integer -Value $InputValue.schemaVersion -Minimum 2 -Maximum 2) -or
        $InputValue.events -is [string] -or -not ($InputValue.events -is [System.Collections.IEnumerable])) {
        Throw-DysonExternalJoinObservationV2Error -Code $code
    }
}

function New-DysonExternalJoinObservationV2 {
    param([Parameter(Mandatory)]$InputValue)
    Assert-DysonExternalJoinObservationV2Input -InputValue $InputValue
    $releaseBindingSha256 = Get-DysonQualificationV2ObjectDigest -Value $InputValue.releaseIdentity
    $endpointBindingSha256 = Get-DysonQualificationV2ObjectDigest -Value $InputValue.publicEndpoint
    $sessionBinding = [pscustomobject][ordered]@{
        initialQualificationSessionId = [string]$InputValue.sessionBinding.initialQualificationSessionId
        reconnectQualificationSessionId = [string]$InputValue.sessionBinding.reconnectQualificationSessionId
        initialChallengeId = [string]$InputValue.sessionBinding.initialChallengeId
        reconnectChallengeId = [string]$InputValue.sessionBinding.reconnectChallengeId
        worldBindingSha256 = [string]$InputValue.sessionBinding.worldBindingSha256
        bindingSha256 = $null
    }
    $sessionBinding.bindingSha256 = Get-DysonExternalJoinObservationV2SessionBindingDigest -RunId ([string]$InputValue.runId) -ClientPseudonym ([string]$InputValue.client.clientPseudonym) -SessionBinding $sessionBinding -ReleaseBindingSha256 $releaseBindingSha256 -EndpointBindingSha256 $endpointBindingSha256
    $events = @()
    $predecessor = $null
    foreach ($sourceEvent in @($InputValue.events)) {
        $event = [pscustomobject][ordered]@{
            sequence = $sourceEvent.sequence
            event = [string]$sourceEvent.event
            observerClass = [string]$sourceEvent.observerClass
            qualificationSessionId = [string]$sourceEvent.qualificationSessionId
            clientPseudonym = [string]$sourceEvent.clientPseudonym
            observedAtUtc = [string]$sourceEvent.observedAtUtc
            expiresAtUtc = [string]$sourceEvent.expiresAtUtc
            releaseBindingSha256 = $releaseBindingSha256
            endpointBindingSha256 = $endpointBindingSha256
            sessionBindingSha256 = [string]$sessionBinding.bindingSha256
            evidence = $sourceEvent.evidence
            evidenceSha256 = Get-DysonQualificationV2ObjectDigest -Value $sourceEvent.evidence
            predecessorSha256 = $predecessor
            eventSha256 = $null
        }
        $event.eventSha256 = Get-DysonExternalJoinObservationV2EventDigest -EventValue $event
        $events += ,$event
        $predecessor = [string]$event.eventSha256
    }
    $observation = [pscustomobject][ordered]@{
        protocol = $script:DysonExternalJoinObservationV2Protocol
        schemaVersion = $script:DysonExternalJoinObservationV2SchemaVersion
        observationId = [string]$InputValue.observationId
        runId = [string]$InputValue.runId
        releaseIdentity = $InputValue.releaseIdentity
        releaseBindingSha256 = $releaseBindingSha256
        publicEndpoint = $InputValue.publicEndpoint
        endpointBindingSha256 = $endpointBindingSha256
        client = $InputValue.client
        sessionBinding = $sessionBinding
        saveBinding = $InputValue.saveBinding
        events = $events
        observedAtUtc = [string]$InputValue.observedAtUtc
        expiresAtUtc = [string]$InputValue.expiresAtUtc
        observationSha256 = $null
    }
    $observation.observationSha256 = Get-DysonExternalJoinObservationV2Digest -Observation $observation
    return $observation
}

function Assert-DysonExternalJoinObservationV2EventEvidence {
    param(
        [Parameter(Mandatory)][string]$EventName,
        [Parameter(Mandatory)]$Evidence,
        [Parameter(Mandatory)]$Observation
    )
    $code = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_EVENT_EVIDENCE_INVALID'
    $publicHost = [string]$Observation.publicEndpoint.publicHost
    $sessions = $Observation.sessionBinding
    $save = $Observation.saveBinding
    switch ($EventName) {
        'dns-resolved' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('publicHost','answerSetSha256','classification','externalResolverObserved') -Code $code
            if ([string]$Evidence.publicHost -cne $publicHost -or [string]$Evidence.answerSetSha256 -cne [string]$Observation.publicEndpoint.dnsAnswerSetSha256 -or
                [string]$Evidence.classification -cne 'public-routable' -or $Evidence.externalResolverObserved -isnot [bool] -or -not [bool]$Evidence.externalResolverObserved) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'tls-established' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('sniAuthority','negotiatedProtocol','certificateSha256','certificateValid','dnsNameMatched') -Code $code
            if ([string]$Evidence.sniAuthority -cne $publicHost -or @('tls12','tls13') -cnotcontains [string]$Evidence.negotiatedProtocol -or
                [string]$Evidence.certificateSha256 -cne [string]$Observation.publicEndpoint.tlsCertificateSha256 -or
                $Evidence.certificateValid -isnot [bool] -or -not [bool]$Evidence.certificateValid -or
                $Evidence.dnsNameMatched -isnot [bool] -or -not [bool]$Evidence.dnsNameMatched) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'wss-established' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('hostHeaderAuthority','path','httpStatusCode','transport') -Code $code
            $expectedAuthority = if ([int]$Observation.publicEndpoint.port -eq 443) { $publicHost } else { $publicHost + ':' + [string]$Observation.publicEndpoint.port }
            if ([string]$Evidence.hostHeaderAuthority -cne $expectedAuthority -or [string]$Evidence.path -cne [string]$Observation.publicEndpoint.websocketPath -or
                -not (Test-DysonExternalJoinObservationV2Integer -Value $Evidence.httpStatusCode -Minimum 101 -Maximum 101) -or [string]$Evidence.transport -cne 'wss') { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'nebula-transport-established' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('protocol','transportEstablished','serverHandshakeSha256') -Code $code
            if ([string]$Evidence.protocol -cne 'nebula' -or $Evidence.transportEstablished -isnot [bool] -or -not [bool]$Evidence.transportEstablished -or
                -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.serverHandshakeSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'nebula-authenticated' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('authenticated','authenticationReceiptSha256') -Code $code
            if ($Evidence.authenticated -isnot [bool] -or -not [bool]$Evidence.authenticated -or -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.authenticationReceiptSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'nebula-joined' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('joined','serverAuthoritative','worldBindingSha256','joinReceiptSha256') -Code $code
            if ($Evidence.joined -isnot [bool] -or -not [bool]$Evidence.joined -or $Evidence.serverAuthoritative -isnot [bool] -or -not [bool]$Evidence.serverAuthoritative -or
                [string]$Evidence.worldBindingSha256 -cne [string]$sessions.worldBindingSha256 -or -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.joinReceiptSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'interaction-observed' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('interactionClass','serverObserved','worldBindingSha256','interactionReceiptSha256') -Code $code
            if ([string]$Evidence.interactionClass -cne 'server-observed-gameplay' -or $Evidence.serverObserved -isnot [bool] -or -not [bool]$Evidence.serverObserved -or
                [string]$Evidence.worldBindingSha256 -cne [string]$sessions.worldBindingSha256 -or -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.interactionReceiptSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'save-requested' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('saveRequestId','requested','worldBindingSha256') -Code $code
            if ([string]$Evidence.saveRequestId -cne [string]$save.saveRequestId -or $Evidence.requested -isnot [bool] -or -not [bool]$Evidence.requested -or
                [string]$Evidence.worldBindingSha256 -cne [string]$sessions.worldBindingSha256) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'save-verified' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('saveRequestId','serverAcknowledged','saveReceiptSha256','savePairSha256','saveManifestSha256') -Code $code
            if ([string]$Evidence.saveRequestId -cne [string]$save.saveRequestId -or $Evidence.serverAcknowledged -isnot [bool] -or -not [bool]$Evidence.serverAcknowledged -or
                [string]$Evidence.saveReceiptSha256 -cne [string]$save.saveReceiptSha256 -or [string]$Evidence.savePairSha256 -cne [string]$save.savePairSha256 -or
                [string]$Evidence.saveManifestSha256 -cne [string]$save.saveManifestSha256) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'disconnected' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('cleanDisconnect','serverObserved','disconnectReceiptSha256') -Code $code
            if ($Evidence.cleanDisconnect -isnot [bool] -or -not [bool]$Evidence.cleanDisconnect -or $Evidence.serverObserved -isnot [bool] -or -not [bool]$Evidence.serverObserved -or
                -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.disconnectReceiptSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'reconnect-transport-established' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('publicHost','transportStack','freshQualificationSession','reconnectChallengeId') -Code $code
            if ([string]$Evidence.publicHost -cne $publicHost -or [string]$Evidence.transportStack -cne 'tls-wss-nebula' -or
                $Evidence.freshQualificationSession -isnot [bool] -or -not [bool]$Evidence.freshQualificationSession -or
                [string]$Evidence.reconnectChallengeId -cne [string]$sessions.reconnectChallengeId) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        'nebula-rejoined' {
            Assert-DysonExternalJoinObservationV2ExactProperties -Value $Evidence -Names @('rejoined','serverAuthoritative','worldBindingSha256','savePairSha256','rejoinReceiptSha256') -Code $code
            if ($Evidence.rejoined -isnot [bool] -or -not [bool]$Evidence.rejoined -or $Evidence.serverAuthoritative -isnot [bool] -or -not [bool]$Evidence.serverAuthoritative -or
                [string]$Evidence.worldBindingSha256 -cne [string]$sessions.worldBindingSha256 -or [string]$Evidence.savePairSha256 -cne [string]$save.savePairSha256 -or
                -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.rejoinReceiptSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }
        }
        default { Throw-DysonExternalJoinObservationV2Error -Code $code }
    }
}

function Assert-DysonExternalJoinObservationV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [AllowNull()][string]$ExpectedObservationId,
        [AllowNull()][string]$ExpectedRunId,
        [AllowNull()][string]$ExpectedSubjectCommit,
        [AllowNull()][string]$ExpectedRuntimePayloadSha256,
        [AllowNull()][string]$ExpectedReleaseManifestSha256,
        [AllowNull()][string]$ExpectedPublicHost,
        [AllowNull()][string]$ExpectedClientPseudonym,
        [AllowNull()][string]$ExpectedSaveReceiptSha256,
        [AllowNull()][string]$ExpectedSavePairSha256,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_INVALID'
    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation -Names @(
        'protocol','schemaVersion','observationId','runId','releaseIdentity','releaseBindingSha256','publicEndpoint',
        'endpointBindingSha256','client','sessionBinding','saveBinding','events','observedAtUtc','expiresAtUtc','observationSha256'
    ) -Code $code
    if ([string]$Observation.protocol -cne $script:DysonExternalJoinObservationV2Protocol -or
        -not (Test-DysonExternalJoinObservationV2Integer -Value $Observation.schemaVersion -Minimum 2 -Maximum 2) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.observationId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.runId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.releaseBindingSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.endpointBindingSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.observationSha256))) { Throw-DysonExternalJoinObservationV2Error -Code $code }

    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation.releaseIdentity -Names @('releaseVersion','subjectCommit','runtimePayloadSha256','releaseManifestSha256','serverManifestSha256','clientManifestSha256') -Code $code
    $release = $Observation.releaseIdentity
    if ([string]$release.releaseVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
        [string]$release.subjectCommit -cnotmatch '^[0-9a-f]{40}$') { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_RELEASE_INVALID' }
    foreach ($name in @('runtimePayloadSha256','releaseManifestSha256','serverManifestSha256','clientManifestSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$release.$name))) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_RELEASE_INVALID' }
    }
    if ([string]$Observation.releaseBindingSha256 -cne (Get-DysonQualificationV2ObjectDigest -Value $release)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_RELEASE_INVALID' }

    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation.publicEndpoint -Names @('scheme','publicHost','port','websocketPath','dnsAnswerSetSha256','tlsCertificateSha256') -Code $code
    $endpoint = $Observation.publicEndpoint
    if ([string]$endpoint.scheme -cne 'wss' -or -not (Test-DysonExternalJoinObservationV2Hostname -Value ([string]$endpoint.publicHost)) -or
        -not (Test-DysonExternalJoinObservationV2Integer -Value $endpoint.port -Minimum 1 -Maximum 65535) -or [string]$endpoint.websocketPath -cne '/socket' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$endpoint.dnsAnswerSetSha256)) -or -not (Test-DysonQualificationV2Digest -Value ([string]$endpoint.tlsCertificateSha256)) -or
        [string]$Observation.endpointBindingSha256 -cne (Get-DysonQualificationV2ObjectDigest -Value $endpoint)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_ENDPOINT_INVALID' }

    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation.client -Names @('clientPseudonym','pseudonymScope','networkClass','sourceAddressCollected','displayNameCollected','accountIdCollected','deviceIdCollected','clientBuildSha256','clientManifestSha256','externalNetworkAttestationSha256') -Code $code
    $client = $Observation.client
    if (-not (Test-DysonExternalJoinObservationV2Pseudonym -Value ([string]$client.clientPseudonym)) -or [string]$client.pseudonymScope -cne 'one-run' -or
        [string]$client.networkClass -cne 'public-external' -or $client.sourceAddressCollected -isnot [bool] -or [bool]$client.sourceAddressCollected -or
        $client.displayNameCollected -isnot [bool] -or [bool]$client.displayNameCollected -or $client.accountIdCollected -isnot [bool] -or [bool]$client.accountIdCollected -or
        $client.deviceIdCollected -isnot [bool] -or [bool]$client.deviceIdCollected -or -not (Test-DysonQualificationV2Digest -Value ([string]$client.clientBuildSha256)) -or
        [string]$client.clientManifestSha256 -cne [string]$release.clientManifestSha256 -or -not (Test-DysonQualificationV2Digest -Value ([string]$client.externalNetworkAttestationSha256))) {
        Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_CLIENT_INVALID'
    }

    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation.sessionBinding -Names @('initialQualificationSessionId','reconnectQualificationSessionId','initialChallengeId','reconnectChallengeId','worldBindingSha256','bindingSha256') -Code $code
    $sessions = $Observation.sessionBinding
    foreach ($name in @('initialQualificationSessionId','reconnectQualificationSessionId','initialChallengeId','reconnectChallengeId')) {
        if (-not (Test-DysonQualificationV2Uuid -Value ([string]$sessions.$name))) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SESSION_INVALID' }
    }
    if ([string]$sessions.initialQualificationSessionId -ceq [string]$sessions.reconnectQualificationSessionId -or [string]$sessions.initialChallengeId -ceq [string]$sessions.reconnectChallengeId -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$sessions.worldBindingSha256)) -or -not (Test-DysonQualificationV2Digest -Value ([string]$sessions.bindingSha256))) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SESSION_INVALID' }
    $expectedSessionBinding = Get-DysonExternalJoinObservationV2SessionBindingDigest -RunId ([string]$Observation.runId) -ClientPseudonym ([string]$client.clientPseudonym) -SessionBinding $sessions -ReleaseBindingSha256 ([string]$Observation.releaseBindingSha256) -EndpointBindingSha256 ([string]$Observation.endpointBindingSha256)
    if ([string]$sessions.bindingSha256 -cne $expectedSessionBinding) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SESSION_INVALID' }

    Assert-DysonExternalJoinObservationV2ExactProperties -Value $Observation.saveBinding -Names @('saveRequestId','worldBindingSha256','saveReceiptSha256','savePairSha256','saveManifestSha256') -Code $code
    $save = $Observation.saveBinding
    if (-not (Test-DysonQualificationV2Uuid -Value ([string]$save.saveRequestId)) -or [string]$save.worldBindingSha256 -cne [string]$sessions.worldBindingSha256) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SAVE_INVALID' }
    foreach ($name in @('saveReceiptSha256','savePairSha256','saveManifestSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$save.$name))) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SAVE_INVALID' }
    }

    $bindings = @(
        @($ExpectedObservationId, [string]$Observation.observationId), @($ExpectedRunId, [string]$Observation.runId),
        @($ExpectedSubjectCommit, [string]$release.subjectCommit), @($ExpectedRuntimePayloadSha256, [string]$release.runtimePayloadSha256),
        @($ExpectedReleaseManifestSha256, [string]$release.releaseManifestSha256), @($ExpectedPublicHost, [string]$endpoint.publicHost),
        @($ExpectedClientPseudonym, [string]$client.clientPseudonym), @($ExpectedSaveReceiptSha256, [string]$save.saveReceiptSha256),
        @($ExpectedSavePairSha256, [string]$save.savePairSha256)
    )
    foreach ($binding in $bindings) {
        if (-not [string]::IsNullOrWhiteSpace([string]$binding[0]) -and [string]$binding[0] -cne [string]$binding[1]) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_BINDING_INVALID' }
    }

    if ($Observation.events -is [string] -or -not ($Observation.events -is [System.Collections.IEnumerable]) -or @($Observation.events).Count -ne $script:DysonExternalJoinObservationV2Events.Count) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' }
    $observed = ConvertFrom-DysonExternalJoinObservationV2Utc -Value ([string]$Observation.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonExternalJoinObservationV2Utc -Value ([string]$Observation.expiresAtUtc) -Code $code
    if ($observed -gt $NowUtc.AddMinutes(1) -or $expires -le $observed -or $expires -gt $observed.AddHours(1) -or $NowUtc -ge $expires) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_STALE' }
    $firstObserved = $null
    $previousObserved = $null
    $previousDigest = $null
    for ($index = 0; $index -lt $script:DysonExternalJoinObservationV2Events.Count; $index++) {
        $event = $Observation.events[$index]
        Assert-DysonExternalJoinObservationV2ExactProperties -Value $event -Names @('sequence','event','observerClass','qualificationSessionId','clientPseudonym','observedAtUtc','expiresAtUtc','releaseBindingSha256','endpointBindingSha256','sessionBindingSha256','evidence','evidenceSha256','predecessorSha256','eventSha256') -Code $code
        $expectedSession = if ($index -le 9) { [string]$sessions.initialQualificationSessionId } else { [string]$sessions.reconnectQualificationSessionId }
        if (-not (Test-DysonExternalJoinObservationV2Integer -Value $event.sequence -Minimum ($index + 1) -Maximum ($index + 1)) -or
            [string]$event.event -cne $script:DysonExternalJoinObservationV2Events[$index] -or [string]$event.observerClass -cne $script:DysonExternalJoinObservationV2Observers[$index] -or
            [string]$event.qualificationSessionId -cne $expectedSession -or [string]$event.clientPseudonym -cne [string]$client.clientPseudonym -or
            [string]$event.releaseBindingSha256 -cne [string]$Observation.releaseBindingSha256 -or [string]$event.endpointBindingSha256 -cne [string]$Observation.endpointBindingSha256 -or
            [string]$event.sessionBindingSha256 -cne [string]$sessions.bindingSha256 -or -not (Test-DysonQualificationV2Digest -Value ([string]$event.evidenceSha256)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$event.eventSha256))) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_SEQUENCE_INVALID' }
        if (($index -eq 0 -and $null -ne $event.predecessorSha256) -or ($index -gt 0 -and [string]$event.predecessorSha256 -cne [string]$previousDigest)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_CHAIN_INVALID' }
        if ([string]$event.evidenceSha256 -cne (Get-DysonQualificationV2ObjectDigest -Value $event.evidence) -or [string]$event.eventSha256 -cne (Get-DysonExternalJoinObservationV2EventDigest -EventValue $event)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_DIGEST_INVALID' }
        $eventObserved = ConvertFrom-DysonExternalJoinObservationV2Utc -Value ([string]$event.observedAtUtc) -Code $code
        $eventExpires = ConvertFrom-DysonExternalJoinObservationV2Utc -Value ([string]$event.expiresAtUtc) -Code $code
        if ($eventExpires -ne $expires -or $eventObserved -gt $observed) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_TIMING_INVALID' }
        if ($null -eq $firstObserved) { $firstObserved = $eventObserved }
        if ($null -ne $previousObserved) {
            $delta = ($eventObserved - $previousObserved).TotalSeconds
            if ($delta -le 0 -or $delta -gt $script:DysonExternalJoinObservationV2MaximumLegSeconds[$index]) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_TIMING_INVALID' }
        }
        Assert-DysonExternalJoinObservationV2EventEvidence -EventName ([string]$event.event) -Evidence $event.evidence -Observation $Observation
        $previousObserved = $eventObserved
        $previousDigest = [string]$event.eventSha256
    }
    if ([Math]::Abs(($previousObserved - $observed).TotalSeconds) -gt 1 -or ($previousObserved - $firstObserved).TotalSeconds -gt 2400) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_TIMING_INVALID' }
    if ([string]$Observation.observationSha256 -cne (Get-DysonExternalJoinObservationV2Digest -Observation $Observation)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_DIGEST_INVALID' }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonExternalJoinObservationV2Protocol
        observationId = [string]$Observation.observationId
        runId = [string]$Observation.runId
        publicHost = [string]$endpoint.publicHost
        clientPseudonym = [string]$client.clientPseudonym
        saveReceiptSha256 = [string]$save.saveReceiptSha256
        terminalEventSha256 = [string]$previousDigest
        observedAtUtc = [string]$Observation.observedAtUtc
        expiresAtUtc = [string]$Observation.expiresAtUtc
        observationSha256 = [string]$Observation.observationSha256
        qualified = $true
        identityCollected = $false
        networkAddressCollected = $false
    }
}

function Assert-DysonExternalJoinObservationV2JsonKeysUnique {
    param([Parameter(Mandatory)][System.Xml.XmlNode]$Node)
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return }
    $typeAttribute = $Node.Attributes['type']
    if ($null -ne $typeAttribute -and [string]$typeAttribute.Value -ceq 'object') {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
            $itemAttribute = $child.Attributes['item']
            $name = if ($child.LocalName -ceq 'item' -and $child.NamespaceURI -ceq 'item' -and $null -ne $itemAttribute) { [string]$itemAttribute.Value } else { [string]$child.LocalName }
            if (-not $names.Add($name)) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_DUPLICATE_JSON_KEY' }
        }
    }
    foreach ($child in @($Node.ChildNodes)) { if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { Assert-DysonExternalJoinObservationV2JsonKeysUnique -Node $child } }
}

function ConvertFrom-DysonExternalJoinObservationV2StrictJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $bytes = $null
    $reader = $null
    try {
        Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
        $bytes = (New-Object System.Text.UTF8Encoding -ArgumentList $false, $true).GetBytes($Text)
        $quotas = New-Object System.Xml.XmlDictionaryReaderQuotas
        $quotas.MaxDepth = 64
        $quotas.MaxStringContentLength = [Math]::Max(1024, $bytes.Length)
        $quotas.MaxArrayLength = [Math]::Max(1024, $bytes.Length)
        $quotas.MaxBytesPerRead = [Math]::Min([Math]::Max(4096, $bytes.Length), 2097152)
        $quotas.MaxNameTableCharCount = [Math]::Max(16384, $bytes.Length)
        $reader = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes, $quotas)
        $document = New-Object System.Xml.XmlDocument
        $document.PreserveWhitespace = $false
        $document.Load($reader)
        Assert-DysonExternalJoinObservationV2JsonKeysUnique -Node $document.DocumentElement
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_JSON_INVALID'
    }
    finally {
        if ($null -ne $reader) { $reader.Close() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Read-DysonExternalJoinObservationV2JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [int64]$item.Length -le 0 -or [int64]$item.Length -gt $script:DysonExternalJoinObservationV2MaximumBytes) { throw 'invalid observation file' }
        $bytes = [IO.File]::ReadAllBytes($item.FullName)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw 'bom' }
        $text = (New-Object System.Text.UTF8Encoding -ArgumentList $false, $true).GetString($bytes)
        return ConvertFrom-DysonExternalJoinObservationV2StrictJson -Text $text
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_FILE_INVALID'
    }
    finally { if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) } }
}
