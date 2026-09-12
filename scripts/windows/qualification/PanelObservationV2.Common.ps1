# Copyright (c) Dyson Control contributors.
# Strict, read-only evidence contract for the authenticated production panel.

Set-StrictMode -Version 2.0

if ($null -eq (Get-Command -Name Get-DysonQualificationV2ObjectDigest -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')
}

$script:DysonControlPanelObservationV2Protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_V2'
$script:DysonControlPanelObservationV2InputProtocol = 'DYSON_CONTROL_PANEL_OBSERVATION_INPUT_V2'
$script:DysonControlPanelObservationV2SchemaVersion = 2
$script:DysonControlPanelObservationV2MaximumBytes = [int64](1MB)

function New-DysonControlPanelObservationV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonControlPanelObservationV2Error {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonControlPanelObservationV2Exception -Code $Code)
}

function Get-DysonControlPanelObservationV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '(DYSON_CONTROL_PANEL_OBSERVATION_V2_[A-Z0-9_]+)') {
        return [string]$Matches[1]
    }
    return 'DYSON_CONTROL_PANEL_OBSERVATION_V2_UNEXPECTED_FAILURE'
}

function Assert-DysonControlPanelObservationV2ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    try { Assert-DysonQualificationV2ExactProperties -Value $Value -Names $Names -Code $Code }
    catch { Throw-DysonControlPanelObservationV2Error -Code $Code }
}

function Test-DysonControlPanelObservationV2Integer {
    param([AllowNull()]$Value, [int64]$Minimum, [int64]$Maximum)
    if (-not (Test-DysonQualificationV2Integer -Value $Value)) { return $false }
    $number = [int64]$Value
    return $number -ge $Minimum -and $number -le $Maximum
}

function Test-DysonControlPanelObservationV2Hostname {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 253 -or $Value -cne $Value.ToLowerInvariant() -or
        $Value -cnotmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
        return $false
    }
    return $Value -cne 'localhost' -and $Value -cnotmatch '\.localhost$'
}

function Test-DysonControlPanelObservationV2Route {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value.Length -le 256 -and
        $Value -cmatch '^/api(?:/[A-Za-z0-9._~-]+)*$'
}

function Test-DysonControlPanelObservationV2CertificateDnsIdentity {
    param(
        [AllowNull()][string]$CertificateDnsName,
        [Parameter(Mandatory)][string]$PublicHost
    )
    if ([string]::IsNullOrWhiteSpace($CertificateDnsName)) { return $false }
    if ($CertificateDnsName -ceq $PublicHost) { return $true }
    if ($CertificateDnsName -cnotmatch '^\*\.(.+)$') { return $false }
    $suffix = [string]$Matches[1]
    if (-not (Test-DysonControlPanelObservationV2Hostname -Value $suffix) -or
        -not $PublicHost.EndsWith('.' + $suffix, [StringComparison]::Ordinal)) { return $false }
    $prefixLength = $PublicHost.Length - $suffix.Length - 1
    return $prefixLength -gt 0 -and $PublicHost.Substring(0, $prefixLength) -cnotmatch '\.'
}

function Test-DysonControlPanelObservationV2EndpointAddress {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value.Length -le 253 -and
        $Value -cmatch '^[A-Za-z0-9.:%_-]+$'
}

function Get-DysonControlPanelObservationV2UnsignedValue {
    param([Parameter(Mandatory)]$Value)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { [string]$_.Name -cne 'receiptSha256' } | Sort-Object -Property Name -CaseSensitive)) {
        $result[[string]$property.Name] = $property.Value
    }
    return [pscustomobject]$result
}

function Get-DysonControlPanelObservationV2Digest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonControlPanelObservationV2UnsignedValue -Value $Observation)
}

function Get-DysonControlPanelObservationV2SessionBindingDigest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonQualificationV2ObjectDigest -Value ([ordered]@{
        domain = 'DYSON_CONTROL_PANEL_OBSERVATION_V2_SESSION_BINDING'
        runId = [string]$Observation.runId
        publicHost = [string]$Observation.endpoint.publicHost
        principalRole = [string]$Observation.authenticatedSession.principalRole
        sessionId = [string]$Observation.authenticatedSession.sessionId
        subjectCommit = [string]$Observation.subjectCommit
        runtimePayloadSha256 = [string]$Observation.runtimePayloadSha256
    })
}

function ConvertFrom-DysonControlPanelObservationV2Utc {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Code)
    try { return ConvertFrom-DysonQualificationV2Utc -Value $Value -Code $Code }
    catch { Throw-DysonControlPanelObservationV2Error -Code $Code }
}

function Assert-DysonControlPanelObservationV2Input {
    param([Parameter(Mandatory)]$InputValue)
    $code = 'DYSON_CONTROL_PANEL_OBSERVATION_V2_INPUT_INVALID'
    Assert-DysonControlPanelObservationV2ExactProperties -Value $InputValue -Names @(
        'protocol','schemaVersion','receiptId','runId','actionTargetId','targetIdentity','subjectCommit',
        'runtimePayloadSha256','releaseIdentity','endpoint','tls','authenticatedSession','authorization',
        'nodeListener','routeSeparation','observedAtUtc','expiresAtUtc'
    ) -Code $code
    if ([string]$InputValue.protocol -cne $script:DysonControlPanelObservationV2InputProtocol -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $InputValue.schemaVersion -Minimum 2 -Maximum 2)) {
        Throw-DysonControlPanelObservationV2Error -Code $code
    }
}

function New-DysonControlPanelObservationV2 {
    param([Parameter(Mandatory)]$InputValue)
    Assert-DysonControlPanelObservationV2Input -InputValue $InputValue
    $observation = [pscustomobject][ordered]@{
        protocol = $script:DysonControlPanelObservationV2Protocol
        schemaVersion = $script:DysonControlPanelObservationV2SchemaVersion
        receiptId = [string]$InputValue.receiptId
        runId = [string]$InputValue.runId
        action = 'authenticated-panel'
        actionTargetId = [string]$InputValue.actionTargetId
        targetIdentity = [string]$InputValue.targetIdentity
        subjectCommit = [string]$InputValue.subjectCommit
        runtimePayloadSha256 = [string]$InputValue.runtimePayloadSha256
        releaseIdentity = $InputValue.releaseIdentity
        endpoint = $InputValue.endpoint
        tls = $InputValue.tls
        authenticatedSession = $InputValue.authenticatedSession
        authorization = $InputValue.authorization
        nodeListener = $InputValue.nodeListener
        routeSeparation = $InputValue.routeSeparation
        observedAtUtc = [string]$InputValue.observedAtUtc
        expiresAtUtc = [string]$InputValue.expiresAtUtc
        receiptSha256 = $null
    }
    $observation.receiptSha256 = Get-DysonControlPanelObservationV2Digest -Observation $observation
    return $observation
}

function Assert-DysonControlPanelObservationV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [AllowNull()][string]$ExpectedReceiptId,
        [AllowNull()][string]$ExpectedRunId,
        [AllowNull()][string]$ExpectedActionTargetId,
        [AllowNull()][string]$ExpectedTargetIdentity,
        [AllowNull()][string]$ExpectedSubjectCommit,
        [AllowNull()][string]$ExpectedRuntimePayloadSha256,
        [AllowNull()][string]$ExpectedPublicHost,
        [AllowNull()][string]$ExpectedReleaseVersion,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_CONTROL_PANEL_OBSERVATION_V2_INVALID'
    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation -Names @(
        'protocol','schemaVersion','receiptId','runId','action','actionTargetId','targetIdentity','subjectCommit',
        'runtimePayloadSha256','releaseIdentity','endpoint','tls','authenticatedSession','authorization',
        'nodeListener','routeSeparation','observedAtUtc','expiresAtUtc','receiptSha256'
    ) -Code $code
    if ([string]$Observation.protocol -cne $script:DysonControlPanelObservationV2Protocol -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $Observation.schemaVersion -Minimum 2 -Maximum 2) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.receiptId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.runId)) -or
        [string]$Observation.action -cne 'authenticated-panel' -or
        [string]::IsNullOrWhiteSpace([string]$Observation.actionTargetId) -or
        [string]::IsNullOrWhiteSpace([string]$Observation.targetIdentity) -or
        [string]$Observation.subjectCommit -cnotmatch '^[0-9a-f]{40}$' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.runtimePayloadSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.receiptSha256))) {
        Throw-DysonControlPanelObservationV2Error -Code $code
    }
    foreach ($binding in @(
        @($ExpectedReceiptId, [string]$Observation.receiptId),
        @($ExpectedRunId, [string]$Observation.runId),
        @($ExpectedActionTargetId, [string]$Observation.actionTargetId),
        @($ExpectedTargetIdentity, [string]$Observation.targetIdentity),
        @($ExpectedSubjectCommit, [string]$Observation.subjectCommit),
        @($ExpectedRuntimePayloadSha256, [string]$Observation.runtimePayloadSha256)
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$binding[0]) -and [string]$binding[0] -cne [string]$binding[1]) {
            Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_BINDING_INVALID'
        }
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.releaseIdentity -Names @(
        'releaseVersion','releaseManifestSha256','subjectCommit','runtimePayloadSha256'
    ) -Code $code
    if ([string]$Observation.releaseIdentity.releaseVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.releaseIdentity.releaseManifestSha256)) -or
        [string]$Observation.releaseIdentity.subjectCommit -cne [string]$Observation.subjectCommit -or
        [string]$Observation.releaseIdentity.runtimePayloadSha256 -cne [string]$Observation.runtimePayloadSha256) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_RELEASE_IDENTITY_INVALID'
    }
    if ((-not [string]::IsNullOrWhiteSpace($ExpectedReleaseVersion)) -and
        [string]$Observation.releaseIdentity.releaseVersion -cne $ExpectedReleaseVersion) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_BINDING_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.endpoint -Names @(
        'scheme','publicHost','port','sniAuthority','hostHeaderAuthority'
    ) -Code $code
    $publicHost = [string]$Observation.endpoint.publicHost
    if ((-not [string]::IsNullOrWhiteSpace($ExpectedPublicHost)) -and $publicHost -cne $ExpectedPublicHost) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_BINDING_INVALID'
    }
    if (-not (Test-DysonControlPanelObservationV2Hostname -Value $publicHost) -or
        [string]$Observation.endpoint.scheme -cne 'https' -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $Observation.endpoint.port -Minimum 1 -Maximum 65535) -or
        [string]$Observation.endpoint.sniAuthority -cne $publicHost) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ENDPOINT_INVALID'
    }
    $expectedHostHeader = if ([int]$Observation.endpoint.port -eq 443) { $publicHost } else { $publicHost + ':' + [string]$Observation.endpoint.port }
    if ([string]$Observation.endpoint.hostHeaderAuthority -cne $expectedHostHeader) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ENDPOINT_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.tls -Names @(
        'negotiatedProtocol','certificateDnsName','certificateSha256','chainTrusted','dnsNameMatched',
        'notBeforeUtc','notAfterUtc','negotiatedAtUtc'
    ) -Code $code
    if (@('tls12','tls13') -cnotcontains [string]$Observation.tls.negotiatedProtocol -or
        -not (Test-DysonControlPanelObservationV2CertificateDnsIdentity -CertificateDnsName ([string]$Observation.tls.certificateDnsName) -PublicHost $publicHost) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.tls.certificateSha256)) -or
        $Observation.tls.chainTrusted -isnot [bool] -or -not [bool]$Observation.tls.chainTrusted -or
        $Observation.tls.dnsNameMatched -isnot [bool] -or -not [bool]$Observation.tls.dnsNameMatched) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID'
    }

    $observed = ConvertFrom-DysonControlPanelObservationV2Utc -Value ([string]$Observation.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonControlPanelObservationV2Utc -Value ([string]$Observation.expiresAtUtc) -Code $code
    $notBefore = ConvertFrom-DysonControlPanelObservationV2Utc -Value ([string]$Observation.tls.notBeforeUtc) -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID'
    $notAfter = ConvertFrom-DysonControlPanelObservationV2Utc -Value ([string]$Observation.tls.notAfterUtc) -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID'
    $negotiated = ConvertFrom-DysonControlPanelObservationV2Utc -Value ([string]$Observation.tls.negotiatedAtUtc) -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID'
    if ($observed -gt $NowUtc.AddMinutes(1) -or $observed -lt $NowUtc.AddHours(-1) -or
        $expires -le $observed -or $expires -gt $observed.AddHours(1) -or $NowUtc -ge $expires) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_STALE'
    }
    if ($notBefore -gt $negotiated -or $notBefore -gt $observed -or $notAfter -lt $negotiated -or
        $notAfter -lt $expires -or [Math]::Abs(($negotiated - $observed).TotalMinutes) -gt 5) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.authenticatedSession -Names @(
        'authenticated','authenticationMethod','sessionStore','sessionCookieOpaque','sessionCookieSecure',
        'sessionCookieHttpOnly','principalRole','sessionId','sessionBindingSha256'
    ) -Code $code
    if ($Observation.authenticatedSession.authenticated -isnot [bool] -or -not [bool]$Observation.authenticatedSession.authenticated -or
        [string]$Observation.authenticatedSession.authenticationMethod -cne 'password' -or
        [string]$Observation.authenticatedSession.sessionStore -cne 'server-side' -or
        $Observation.authenticatedSession.sessionCookieOpaque -isnot [bool] -or -not [bool]$Observation.authenticatedSession.sessionCookieOpaque -or
        $Observation.authenticatedSession.sessionCookieSecure -isnot [bool] -or -not [bool]$Observation.authenticatedSession.sessionCookieSecure -or
        $Observation.authenticatedSession.sessionCookieHttpOnly -isnot [bool] -or -not [bool]$Observation.authenticatedSession.sessionCookieHttpOnly -or
        [string]$Observation.authenticatedSession.principalRole -cne 'Administrator' -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.authenticatedSession.sessionId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.authenticatedSession.sessionBindingSha256))) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHENTICATION_INVALID'
    }
    $sessionBinding = Get-DysonControlPanelObservationV2SessionBindingDigest -Observation $Observation
    if ([string]$Observation.authenticatedSession.sessionBindingSha256 -cne $sessionBinding) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHENTICATION_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.authorization -Names @(
        'viewerMutation','administratorRead'
    ) -Code $code
    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.authorization.viewerMutation -Names @(
        'role','method','route','expectedStatusCode','actualStatusCode','mutationObserved','auditOutcome'
    ) -Code $code
    $viewer = $Observation.authorization.viewerMutation
    if ([string]$viewer.role -cne 'Viewer' -or @('POST','PUT','PATCH','DELETE') -cnotcontains [string]$viewer.method -or
        -not (Test-DysonControlPanelObservationV2Route -Value ([string]$viewer.route)) -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $viewer.expectedStatusCode -Minimum 403 -Maximum 403) -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $viewer.actualStatusCode -Minimum 403 -Maximum 403) -or
        $viewer.mutationObserved -isnot [bool] -or [bool]$viewer.mutationObserved -or
        [string]$viewer.auditOutcome -cne 'denied') {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHORIZATION_INVALID'
    }
    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.authorization.administratorRead -Names @(
        'role','method','route','expectedStatusCode','actualStatusCode','authenticatedResponse'
    ) -Code $code
    $administrator = $Observation.authorization.administratorRead
    if ([string]$administrator.role -cne 'Administrator' -or [string]$administrator.method -cne 'GET' -or
        -not (Test-DysonControlPanelObservationV2Route -Value ([string]$administrator.route)) -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $administrator.expectedStatusCode -Minimum 200 -Maximum 200) -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $administrator.actualStatusCode -Minimum 200 -Maximum 200) -or
        $administrator.authenticatedResponse -isnot [bool] -or -not [bool]$administrator.authenticatedResponse) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHORIZATION_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.nodeListener -Names @(
        'address','port','loopbackOnly','processIdentitySha256','runtimePayloadSha256'
    ) -Code $code
    if (@('127.0.0.1','::1') -cnotcontains [string]$Observation.nodeListener.address -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $Observation.nodeListener.port -Minimum 1 -Maximum 65535) -or
        $Observation.nodeListener.loopbackOnly -isnot [bool] -or -not [bool]$Observation.nodeListener.loopbackOnly -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.nodeListener.processIdentitySha256)) -or
        [string]$Observation.nodeListener.runtimePayloadSha256 -cne [string]$Observation.runtimePayloadSha256) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_LISTENER_INVALID'
    }

    Assert-DysonControlPanelObservationV2ExactProperties -Value $Observation.routeSeparation -Names @(
        'managementPublicTransport','managementApplicationProtocol','managementOriginAddress','managementOriginPort',
        'managementRouteIdentitySha256','managementHttpObserved','gamePublicTransport','gameApplicationProtocol',
        'gameOriginAddress','gameOriginPort','gameRouteIdentitySha256','gameTcpObserved','sharedOrigin','routeSeparationObserved'
    ) -Code $code
    $routes = $Observation.routeSeparation
    if ([string]$routes.managementPublicTransport -cne 'https' -or
        [string]$routes.managementApplicationProtocol -cne 'http' -or
        [string]$routes.managementOriginAddress -cne [string]$Observation.nodeListener.address -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $routes.managementOriginPort -Minimum 1 -Maximum 65535) -or
        [int]$routes.managementOriginPort -ne [int]$Observation.nodeListener.port -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$routes.managementRouteIdentitySha256)) -or
        $routes.managementHttpObserved -isnot [bool] -or -not [bool]$routes.managementHttpObserved -or
        [string]$routes.gamePublicTransport -cne 'tcp' -or [string]$routes.gameApplicationProtocol -cne 'nebula-tcp' -or
        -not (Test-DysonControlPanelObservationV2EndpointAddress -Value ([string]$routes.gameOriginAddress)) -or
        -not (Test-DysonControlPanelObservationV2Integer -Value $routes.gameOriginPort -Minimum 1 -Maximum 65535) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$routes.gameRouteIdentitySha256)) -or
        [string]$routes.managementRouteIdentitySha256 -ceq [string]$routes.gameRouteIdentitySha256 -or
        $routes.gameTcpObserved -isnot [bool] -or -not [bool]$routes.gameTcpObserved -or
        $routes.sharedOrigin -isnot [bool] -or [bool]$routes.sharedOrigin -or
        $routes.routeSeparationObserved -isnot [bool] -or -not [bool]$routes.routeSeparationObserved -or
        ([string]$routes.gameOriginAddress -ceq [string]$routes.managementOriginAddress -and
            [int]$routes.gameOriginPort -eq [int]$routes.managementOriginPort)) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ROUTE_SEPARATION_INVALID'
    }

    $expectedDigest = Get-DysonControlPanelObservationV2Digest -Observation $Observation
    if ([string]$Observation.receiptSha256 -cne $expectedDigest) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_DIGEST_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonControlPanelObservationV2Protocol
        receiptId = [string]$Observation.receiptId
        runId = [string]$Observation.runId
        publicHost = $publicHost
        observedAtUtc = [string]$Observation.observedAtUtc
        expiresAtUtc = [string]$Observation.expiresAtUtc
        receiptSha256 = [string]$Observation.receiptSha256
        qualified = $true
    }
}

function Assert-DysonControlPanelObservationV2JsonKeysUnique {
    param([Parameter(Mandatory)][System.Xml.XmlNode]$Node)
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return }
    $typeAttribute = $Node.Attributes['type']
    if ($null -ne $typeAttribute -and [string]$typeAttribute.Value -ceq 'object') {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
            $itemAttribute = $child.Attributes['item']
            $name = if ($child.LocalName -ceq 'item' -and $child.NamespaceURI -ceq 'item' -and $null -ne $itemAttribute) { [string]$itemAttribute.Value } else { [string]$child.LocalName }
            if (-not $names.Add($name)) { Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_DUPLICATE_JSON_KEY' }
        }
    }
    foreach ($child in @($Node.ChildNodes)) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { Assert-DysonControlPanelObservationV2JsonKeysUnique -Node $child }
    }
}

function ConvertFrom-DysonControlPanelObservationV2StrictJson {
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
        $quotas.MaxBytesPerRead = [Math]::Min([Math]::Max(4096, $bytes.Length), 1048576)
        $quotas.MaxNameTableCharCount = [Math]::Max(16384, $bytes.Length)
        $reader = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes, $quotas)
        $document = New-Object System.Xml.XmlDocument
        $document.PreserveWhitespace = $false
        $document.Load($reader)
        Assert-DysonControlPanelObservationV2JsonKeysUnique -Node $document.DocumentElement
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_JSON_INVALID'
    }
    finally {
        if ($null -ne $reader) { $reader.Close() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Read-DysonControlPanelObservationV2JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            [int64]$item.Length -le 0 -or [int64]$item.Length -gt $script:DysonControlPanelObservationV2MaximumBytes) {
            throw 'invalid evidence file'
        }
        $bytes = [IO.File]::ReadAllBytes($item.FullName)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw 'bom' }
        $text = (New-Object System.Text.UTF8Encoding -ArgumentList $false, $true).GetString($bytes)
        return ConvertFrom-DysonControlPanelObservationV2StrictJson -Text $text
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_FILE_INVALID'
    }
    finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}
