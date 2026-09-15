Set-StrictMode -Version Latest

$script:DysonNetworkV2Protocol = 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2'
$script:DysonNetworkV2SchemaVersion = 2
$script:DysonNetworkV2RemoteProbeConfirmation = 'I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES'
$script:DysonNetworkV2AddressClasses = @(
    'loopback', 'private', 'documentation', 'link-local', 'public',
    'unspecified', 'multicast', 'unknown'
)

function Get-DysonNetworkV2AddressClass {
    param([Parameter(Mandatory)][System.Net.IPAddress]$Address)

    # V2 readiness needs a globally routable unicast address, not merely an
    # address which is absent from the V1 private/documentation allowlist.
    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6 -and
        $Address.IsIPv4MappedToIPv6) {
        return Get-DysonNetworkV2AddressClass -Address $Address.MapToIPv4()
    }

    $bytes = $Address.GetAddressBytes()
    if ([System.Net.IPAddress]::IsLoopback($Address)) { return 'loopback' }

    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        if ($bytes[0] -eq 0) { return 'unspecified' }
        if ($bytes[0] -eq 127) { return 'loopback' }
        if ($bytes[0] -ge 224 -and $bytes[0] -le 239) { return 'multicast' }
        if ($bytes[0] -ge 240) { return 'unknown' }
        if ($bytes[0] -eq 169 -and $bytes[1] -eq 254) { return 'link-local' }
        if ($bytes[0] -eq 10 -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168)) { return 'private' }
        if ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127) {
            return 'unknown'
        }
        if (($bytes[0] -eq 192 -and $bytes[1] -eq 0 -and $bytes[2] -eq 2) -or
            ($bytes[0] -eq 198 -and $bytes[1] -eq 51 -and $bytes[2] -eq 100) -or
            ($bytes[0] -eq 203 -and $bytes[1] -eq 0 -and $bytes[2] -eq 113)) {
            return 'documentation'
        }
        if (($bytes[0] -eq 192 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 88 -and $bytes[2] -eq 99) -or
            ($bytes[0] -eq 198 -and $bytes[1] -ge 18 -and $bytes[1] -le 19)) {
            return 'unknown'
        }
        return 'public'
    }

    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        if ($Address.Equals([System.Net.IPAddress]::IPv6Any)) { return 'unspecified' }
        if ($Address.IsIPv6Multicast) { return 'multicast' }
        if ($Address.IsIPv6LinkLocal) { return 'link-local' }
        if (($bytes[0] -band 0xfe) -eq 0xfc) { return 'private' }
        if ($bytes[0] -eq 0xfe -and ($bytes[1] -band 0xc0) -eq 0xc0) { return 'private' }
        if (($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and
                $bytes[2] -eq 0x0d -and $bytes[3] -eq 0xb8) -or
            ($bytes[0] -eq 0x3f -and $bytes[1] -eq 0xff -and
                ($bytes[2] -band 0xf0) -eq 0)) {
            return 'documentation'
        }
        if (($bytes[0] -eq 0x01 -and $bytes[1] -eq 0 -and
                @($bytes[2..7] | Where-Object { $_ -ne 0 }).Count -eq 0) -or
            ($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and
                ($bytes[2] -band 0xfe) -eq 0) -or
            ($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x02)) {
            return 'unknown'
        }
        if (($bytes[0] -band 0xe0) -ne 0x20) { return 'unknown' }
        return 'public'
    }

    return 'unknown'
}

function Get-DysonNetworkV1ProbeDependencyV2 {
    $dependencyPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'DysonNetwork.Common.ps1'))
    try {
        $rootItem = Get-Item -LiteralPath $PSScriptRoot -Force -ErrorAction Stop
        $dependencyItem = Get-Item -LiteralPath $dependencyPath -Force -ErrorAction Stop
    }
    catch { throw 'DYSON_NETWORK_V2_FIXED_PROBE_DEPENDENCY_UNAVAILABLE' }

    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $dependencyItem.PSIsContainer -or
        ($dependencyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath($dependencyItem.DirectoryName).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'DYSON_NETWORK_V2_FIXED_PROBE_DEPENDENCY_REDIRECTED'
    }

    return $dependencyItem.FullName
}

$v1ProbeDependencyV2 = Get-DysonNetworkV1ProbeDependencyV2
. $v1ProbeDependencyV2

function Assert-DysonNetworkV2ExactProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Context
    )

    if ($null -eq $Value) { throw ('DYSON_NETWORK_V2_INVALID_' + $Context.ToUpperInvariant()) }
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    if (-not [string]::Equals(
        [string]::Join("`n", $actual),
        [string]::Join("`n", $wanted),
        [System.StringComparison]::Ordinal
    )) {
        throw ('DYSON_NETWORK_V2_INVALID_' + $Context.ToUpperInvariant() + '_PROPERTIES')
    }
}

function Assert-DysonNetworkV2CanonicalUuid {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Code
    )

    $parsed = [guid]::Empty
    if ($Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        -not [guid]::TryParseExact($Value, 'D', [ref]$parsed) -or
        $parsed.ToString('D') -cne $Value) {
        throw $Code
    }
}

function ConvertFrom-DysonNetworkV2UtcTimestamp {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Code
    )

    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { throw $Code }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact(
        $Value,
        'yyyy-MM-ddTHH:mm:ss.fffZ',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
            [System.Globalization.DateTimeStyles]::AdjustToUniversal,
        [ref]$parsed
    )) { throw $Code }
    if ($parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -cne $Value) { throw $Code }
    return $parsed
}

function Assert-DysonNetworkV2CanonicalQualificationId {
    param([Parameter(Mandatory)][string]$QualificationId)

    Assert-DysonNetworkV2CanonicalUuid -Value $QualificationId `
        -Code 'DYSON_NETWORK_V2_QUALIFICATION_ID_INVALID'
}

function ConvertFrom-DysonNetworkV2QualificationProjection {
    param(
        [Parameter(Mandatory)][object]$Projection,
        [Parameter(Mandatory)][string]$ExpectedQualificationId,
        [Parameter(Mandatory)][DateTimeOffset]$NowUtc,
        [Parameter(Mandatory)][ValidateSet('preview', 'consume')][string]$ValidationMode
    )

    $ValidationMode = $ValidationMode.ToLowerInvariant()

    # This exact set is deliberately kept at the only V2 projection boundary.
    # The protected verifier performs the private contract, digest, route,
    # binary, client, authority and receipt-chain verification before returning it.
    Assert-DysonNetworkV2ExactProperties -Value $Projection -Expected @(
        'qualificationId', 'runId', 'bindingSha256', 'expiresAtUtc',
        'decision', 'blockerCodes'
    ) -Context 'qualification_projection'

    $qualificationId = [string]$Projection.qualificationId
    $runId = [string]$Projection.runId
    Assert-DysonNetworkV2CanonicalQualificationId -QualificationId $qualificationId
    Assert-DysonNetworkV2CanonicalUuid -Value $runId -Code 'DYSON_NETWORK_V2_RUN_ID_INVALID'
    if (-not [string]::Equals(
        $qualificationId,
        $ExpectedQualificationId,
        [System.StringComparison]::Ordinal
    )) { throw 'DYSON_NETWORK_V2_QUALIFICATION_ID_MISMATCH' }

    $bindingSha256 = [string]$Projection.bindingSha256
    if ($bindingSha256 -cnotmatch '^sha256:[0-9a-f]{64}$') {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_BINDING_INVALID'
    }
    $decision = [string]$Projection.decision
    if ($decision -cnotin @('qualified', 'blocked', 'preview-valid')) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_DECISION_INVALID'
    }
    $expiresAt = ConvertFrom-DysonNetworkV2UtcTimestamp -Value ([string]$Projection.expiresAtUtc) `
        -Code 'DYSON_NETWORK_V2_QUALIFICATION_EXPIRY_INVALID'
    if ($decision -ne 'blocked' -and $expiresAt -le $NowUtc.ToUniversalTime()) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_STALE'
    }
    if ($Projection.blockerCodes -is [string] -or $Projection.blockerCodes -isnot [System.Collections.IEnumerable]) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_BLOCKERS_INVALID'
    }
    $blockers = @($Projection.blockerCodes)
    if ($blockers.Count -gt 64) { throw 'DYSON_NETWORK_V2_QUALIFICATION_BLOCKERS_INVALID' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($rawCode in $blockers) {
        $code = [string]$rawCode
        if ($code -cnotmatch '^[A-Z0-9_]{1,128}$' -or -not $seen.Add($code)) {
            throw 'DYSON_NETWORK_V2_QUALIFICATION_BLOCKERS_INVALID'
        }
    }
    if (($decision -ceq 'qualified' -and $blockers.Count -ne 0) -or
        ($decision -ceq 'blocked' -and $blockers.Count -eq 0) -or
        ($decision -ceq 'preview-valid' -and
            ($blockers.Count -ne 1 -or
                [string]$blockers[0] -cne 'DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED'))) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_DECISION_CONTRADICTED'
    }

    if (($decision -ceq 'qualified' -and $ValidationMode -cne 'consume') -or
        ($decision -ceq 'preview-valid' -and $ValidationMode -cne 'preview')) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_STATE_CHANGE_CONTRADICTED'
    }
    if ($ValidationMode -ceq 'preview' -and $decision -ceq 'qualified') {
        throw 'DYSON_NETWORK_V2_PREVIEW_CANNOT_QUALIFY'
    }
    return [pscustomobject][ordered]@{
        qualificationId = $qualificationId
        runId = $runId
        bindingSha256 = $bindingSha256
        expiresAtUtc = $expiresAt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        decision = $decision
        blockerCodes = @($blockers | ForEach-Object { [string]$_ })
        validationMode = $ValidationMode
    }
}

function New-DysonNetworkV2StockQualification {
    return [pscustomobject][ordered]@{
        qualificationId = $null
        runId = $null
        bindingSha256 = $null
        expiresAtUtc = $null
        decision = 'not-provided'
        blockerCodes = @()
        validationMode = 'stock'
    }
}

function New-DysonNetworkV2Finding {
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][ValidateSet('blocker', 'warning', 'info')][string]$Severity,
        [Parameter(Mandatory)][ValidateSet('qualification', 'local-listener', 'game-data', 'management', 'passwall', 'tool')][string]$Plane
    )

    $Severity = $Severity.ToLowerInvariant()
    $Plane = $Plane.ToLowerInvariant()

    if ($Code -cnotmatch '^[A-Z0-9_]{1,128}$') { throw 'DYSON_NETWORK_V2_FINDING_CODE_INVALID' }
    return [pscustomobject][ordered]@{ code = $Code; severity = $Severity; plane = $Plane }
}

function New-DysonNetworkV2TcpObservation {
    param([Parameter(Mandatory)][string]$Outcome)

    return [pscustomobject][ordered]@{ outcome = $Outcome; endpointEmitted = $false }
}

function ConvertTo-DysonNetworkV2PublicDnsObservation {
    param(
        [Parameter(Mandatory)][object]$Raw,
        [Parameter(Mandatory)][scriptblock]$AddressClassProbe
    )

    $addresses = @()
    if ($Raw.PSObject.Properties.Name -contains 'addresses') {
        $addresses = @($Raw.addresses | Where-Object { $_ -is [System.Net.IPAddress] })
    }
    $counts = [ordered]@{}
    foreach ($name in $script:DysonNetworkV2AddressClasses) { $counts[$name] = 0 }
    foreach ($address in $addresses) {
        $class = [string](& $AddressClassProbe $address)
        if ($class -notin $script:DysonNetworkV2AddressClasses) {
            throw 'DYSON_NETWORK_V2_ADDRESS_CLASS_PROBE_INVALID'
        }
        $counts[$class] = [int]$counts[$class] + 1
    }
    $selected = if ($addresses.Count -gt 0) { $addresses[0] } else { $null }
    $selectedClass = if ($null -eq $selected) { 'none' } else { [string](& $AddressClassProbe $selected) }
    if ($selectedClass -ne 'none' -and $selectedClass -notin $script:DysonNetworkV2AddressClasses) {
        throw 'DYSON_NETWORK_V2_ADDRESS_CLASS_PROBE_INVALID'
    }
    return [pscustomobject][ordered]@{
        status = [string]$Raw.status
        addressCount = [int]$addresses.Count
        ipv4Count = [int]@($addresses | Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
        }).Count
        ipv6Count = [int]@($addresses | Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6
        }).Count
        addressClassCounts = [pscustomobject]$counts
        clientSelectionSemantics = 'first-address-only'
        selectedFirstClass = $selectedClass
        selectedFirstFamily = Get-DysonNetworkAddressFamilyName $selected
        rawAnswersEmitted = $false
    }
}

function New-DysonNetworkV2DisabledWebSocketObservation {
    param(
        [Parameter(Mandatory)][ValidateSet('not-qualified', 'remote-probes-disabled', 'dns-unavailable')][string]$Outcome,
        [Parameter(Mandatory)][bool]$QualifiedSemantics
    )

    $Outcome = $Outcome.ToLowerInvariant()

    return [pscustomobject][ordered]@{
        path = if ($QualifiedSemantics) { '/socket' } else { $null }
        transport = if ($QualifiedSemantics) { 'wss' } else { 'not-qualified' }
        outcome = $Outcome
        statusCode = $null
        upgradeHeaderPresent = $false
        connectionHeaderUpgrade = $false
        acceptHeaderPresent = $false
        acceptHeaderValid = $false
        tlsCertificateValidated = $false
        authoritySemantics = if ($QualifiedSemantics) { 'hostname-preserved' } else { 'resolved-ip-endpoint' }
        requestAuthorityEmitted = $false
        responseHeadersEmitted = $false
    }
}

function New-DysonNetworkV2PublicWebSocketObservation {
    param([Parameter(Mandatory)][object]$Raw)

    return [pscustomobject][ordered]@{
        path = '/socket'
        transport = 'wss'
        outcome = [string]$Raw.outcome
        statusCode = if ($null -eq $Raw.statusCode) { $null } else { [int]$Raw.statusCode }
        upgradeHeaderPresent = [bool]$Raw.upgradeHeaderPresent
        connectionHeaderUpgrade = [bool]$Raw.connectionHeaderUpgrade
        acceptHeaderPresent = [bool]$Raw.acceptHeaderPresent
        acceptHeaderValid = [bool]$Raw.acceptHeaderValid
        tlsCertificateValidated = [bool]$Raw.tlsCertificateValidated
        authoritySemantics = 'hostname-preserved'
        requestAuthorityEmitted = $false
        responseHeadersEmitted = $false
    }
}

function Get-DysonRawHostnamePreservedWebSocketObservationV2 {
    param(
        [Parameter(Mandatory)][System.Net.IPAddress]$Address,
        [Parameter(Mandatory)][string]$Authority,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][ValidateRange(250, 30000)][int]$TimeoutMilliseconds
    )

    $target = Resolve-DysonNetworkTarget -Value $Authority
    if ([string]$target.kind -cne 'hostname' -or [string]$target.value -cne $Authority -or $Port -ne 443) {
        throw 'DYSON_NETWORK_V2_AUTHORITY_BINDING_INVALID'
    }

    $client = New-Object System.Net.Sockets.TcpClient($Address.AddressFamily)
    $transportStream = $null
    $sslStream = $null
    try {
        $async = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return [pscustomobject]@{
                outcome = 'timeout'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $false
            }
        }
        try { $client.EndConnect($async) }
        catch [System.Net.Sockets.SocketException] {
            return [pscustomobject]@{
                outcome = ConvertTo-DysonTcpSocketOutcome $_.Exception.SocketErrorCode
                statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $false
            }
        }
        if (-not $client.Connected) { throw 'DYSON_NETWORK_V2_TCP_CONNECT_FAILED' }
        $client.ReceiveTimeout = $TimeoutMilliseconds
        $client.SendTimeout = $TimeoutMilliseconds
        $transportStream = $client.GetStream()
        try {
            $sslStream = New-Object System.Net.Security.SslStream($transportStream, $false)
            # Connect to the selected IP while preserving the qualified hostname for SNI.
            $sslStream.AuthenticateAsClient($Authority)
            $transportStream = $sslStream
        }
        catch {
            return [pscustomobject]@{
                outcome = 'tls-failure'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $false
            }
        }

        $keyBytes = New-Object byte[] 16
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($keyBytes) }
        finally { $random.Dispose() }
        $webSocketKey = [Convert]::ToBase64String($keyBytes)
        $acceptInput = [System.Text.Encoding]::ASCII.GetBytes(
            $webSocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        )
        $sha1 = [System.Security.Cryptography.SHA1]::Create()
        try { $expectedAccept = [Convert]::ToBase64String($sha1.ComputeHash($acceptInput)) }
        finally { $sha1.Dispose() }

        $request = @(
            'GET /socket HTTP/1.1',
            ('Host: ' + $Authority + ':' + $Port),
            'Upgrade: websocket',
            'Connection: Upgrade',
            ('Sec-WebSocket-Key: ' + $webSocketKey),
            'Sec-WebSocket-Version: 13',
            'User-Agent: Dyson-Network-Preflight/2',
            '',
            ''
        ) -join "`r`n"
        $requestBytes = [System.Text.Encoding]::ASCII.GetBytes($request)
        $transportStream.Write($requestBytes, 0, $requestBytes.Length)
        $transportStream.Flush()
        try {
            $responseBytes = @(Read-DysonWebSocketResponseBytes -Stream $transportStream `
                -TimeoutMilliseconds $TimeoutMilliseconds)
        }
        catch [System.IO.IOException] {
            return [pscustomobject]@{
                outcome = 'timeout'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $true
            }
        }
        if ($responseBytes.Count -eq 0) {
            return [pscustomobject]@{
                outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $true
            }
        }
        $response = [System.Text.Encoding]::ASCII.GetString([byte[]]$responseBytes)
        return ConvertFrom-DysonWebSocketHttpResponse -Response $response `
            -ExpectedAccept $expectedAccept -TlsCertificateValidated $true
    }
    catch [System.Net.Sockets.SocketException] {
        return [pscustomobject]@{
            outcome = ConvertTo-DysonTcpSocketOutcome $_.Exception.SocketErrorCode
            statusCode = $null; upgradeHeaderPresent = $false
            connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
            tlsCertificateValidated = $false
        }
    }
    catch {
        return [pscustomobject]@{
            outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
            connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
            tlsCertificateValidated = $false
        }
    }
    finally {
        if ($null -ne $sslStream) { $sslStream.Dispose() }
        elseif ($null -ne $transportStream) { $transportStream.Dispose() }
        $client.Dispose()
    }
}

function New-DysonNetworkV2ManagementPlane {
    param(
        [AllowNull()][object]$Target,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][ValidateSet('tcp', 'http', 'https')][string]$Transport,
        [Parameter(Mandatory)][bool]$RemoteProbesEnabled,
        [Parameter(Mandatory)][scriptblock]$DnsProbe,
        [Parameter(Mandatory)][scriptblock]$TcpProbe,
        [Parameter(Mandatory)][scriptblock]$AddressClassProbe
    )

    $Transport = $Transport.ToLowerInvariant()

    $configured = $null -ne $Target
    if (-not $configured) {
        $dns = New-DysonDisabledDnsObservation -Status 'not-configured'
        $tcp = New-DysonNetworkV2TcpObservation -Outcome 'not-configured'
    }
    elseif (-not $RemoteProbesEnabled) {
        $dns = New-DysonDisabledDnsObservation -Status 'remote-probes-disabled'
        $tcp = New-DysonNetworkV2TcpObservation -Outcome 'remote-probes-disabled'
    }
    else {
        try { $dnsRaw = & $DnsProbe $Target }
        catch { $dnsRaw = [pscustomobject]@{ status = 'error'; addresses = @() } }
        $dns = ConvertTo-DysonNetworkV2PublicDnsObservation -Raw $dnsRaw `
            -AddressClassProbe $AddressClassProbe
        $addresses = @($dnsRaw.addresses | Where-Object { $_ -is [System.Net.IPAddress] })
        if ($addresses.Count -eq 0) {
            $tcp = New-DysonNetworkV2TcpObservation -Outcome 'dns-unavailable'
        }
        else {
            try { $tcpRaw = & $TcpProbe $addresses[0] $Port }
            catch { $tcpRaw = [pscustomobject]@{ outcome = 'error' } }
            $tcp = New-DysonNetworkV2TcpObservation -Outcome ([string]$tcpRaw.outcome)
        }
    }
    return [pscustomobject][ordered]@{
        role = 'management'
        configured = $configured
        targetRef = 'management-plane'
        targetKind = if ($configured) { [string]$Target.kind } else { 'none' }
        targetValueEmitted = $false
        port = $Port
        transport = $Transport
        dns = $dns
        tcp = $tcp
    }
}

function New-DysonNetworkV2GamePlane {
    param(
        [AllowNull()][object]$Target,
        [Parameter(Mandatory)][bool]$QualifiedSemantics,
        [Parameter(Mandatory)][bool]$RemoteProbesEnabled,
        [Parameter(Mandatory)][scriptblock]$DnsProbe,
        [Parameter(Mandatory)][scriptblock]$TcpProbe,
        [Parameter(Mandatory)][scriptblock]$WebSocketProbe,
        [Parameter(Mandatory)][scriptblock]$AddressClassProbe
    )

    $configured = $null -ne $Target
    if (-not $QualifiedSemantics) {
        $dns = if ($configured) {
            New-DysonDisabledDnsObservation -Status 'remote-probes-disabled'
        } else { New-DysonDisabledDnsObservation -Status 'not-configured' }
        return [pscustomobject][ordered]@{
            role = 'game-data'; configured = $configured; targetRef = 'game-data-plane'
            targetKind = if ($configured) { [string]$Target.kind } else { 'none' }
            targetValueEmitted = $false; port = 443; transport = 'not-qualified'
            dns = $dns; tcp = New-DysonNetworkV2TcpObservation -Outcome 'remote-probes-disabled'
            websocket = New-DysonNetworkV2DisabledWebSocketObservation -Outcome 'not-qualified' `
                -QualifiedSemantics $false
        }
    }
    if (-not $configured) { throw 'DYSON_NETWORK_V2_QUALIFIED_TARGET_REQUIRED' }
    if ([string]$Target.kind -cne 'hostname') { throw 'DYSON_NETWORK_V2_QUALIFIED_TARGET_MUST_BE_HOSTNAME' }

    if (-not $RemoteProbesEnabled) {
        return [pscustomobject][ordered]@{
            role = 'game-data'; configured = $true; targetRef = 'game-data-plane'
            targetKind = 'hostname'; targetValueEmitted = $false; port = 443; transport = 'wss'
            dns = New-DysonDisabledDnsObservation -Status 'remote-probes-disabled'
            tcp = New-DysonNetworkV2TcpObservation -Outcome 'remote-probes-disabled'
            websocket = New-DysonNetworkV2DisabledWebSocketObservation `
                -Outcome 'remote-probes-disabled' -QualifiedSemantics $true
        }
    }

    try { $dnsRaw = & $DnsProbe $Target }
    catch { $dnsRaw = [pscustomobject]@{ status = 'error'; addresses = @() } }
    $dns = ConvertTo-DysonNetworkV2PublicDnsObservation -Raw $dnsRaw `
        -AddressClassProbe $AddressClassProbe
    $addresses = @($dnsRaw.addresses | Where-Object { $_ -is [System.Net.IPAddress] })
    if ($addresses.Count -eq 0) {
        $tcp = New-DysonNetworkV2TcpObservation -Outcome 'dns-unavailable'
        $websocket = New-DysonNetworkV2DisabledWebSocketObservation `
            -Outcome 'dns-unavailable' -QualifiedSemantics $true
    }
    else {
        try { $tcpRaw = & $TcpProbe $addresses[0] 443 }
        catch { $tcpRaw = [pscustomobject]@{ outcome = 'error' } }
        $tcp = New-DysonNetworkV2TcpObservation -Outcome ([string]$tcpRaw.outcome)
        try { $webSocketRaw = & $WebSocketProbe $addresses[0] ([string]$Target.value) 443 }
        catch {
            $webSocketRaw = [pscustomobject]@{
                outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $false
            }
        }
        $websocket = New-DysonNetworkV2PublicWebSocketObservation -Raw $webSocketRaw
    }
    return [pscustomobject][ordered]@{
        role = 'game-data'; configured = $true; targetRef = 'game-data-plane'
        targetKind = 'hostname'; targetValueEmitted = $false; port = 443; transport = 'wss'
        dns = $dns; tcp = $tcp; websocket = $websocket
    }
}

function Invoke-DysonNetworkAssessmentV2 {
    param(
        [Parameter(Mandatory)][ValidateSet('local-read-only', 'remote-read-only', 'shadow')][string]$Mode,
        [Parameter(Mandatory)][bool]$RemoteProbesEnabled,
        [AllowNull()][object]$GameDataTarget,
        [AllowNull()][object]$ManagementTarget,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$ManagementPort,
        [Parameter(Mandatory)][ValidateSet('tcp', 'http', 'https')][string]$ManagementTransport,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$LocalGamePort,
        [Parameter(Mandatory)][object]$Qualification,
        [Parameter(Mandatory)][DateTimeOffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$LocalListenerProbe,
        [Parameter(Mandatory)][scriptblock]$DnsProbe,
        [Parameter(Mandatory)][scriptblock]$TcpProbe,
        [Parameter(Mandatory)][scriptblock]$WebSocketProbe,
        [Parameter(Mandatory)][scriptblock]$AddressClassProbe
    )

    $Mode = $Mode.ToLowerInvariant()
    $ManagementTransport = $ManagementTransport.ToLowerInvariant()

    Assert-DysonNetworkV2ExactProperties -Value $Qualification -Expected @(
        'qualificationId', 'runId', 'bindingSha256', 'expiresAtUtc', 'decision', 'blockerCodes',
        'validationMode'
    ) -Context 'normalized_qualification'
    $qualificationDecision = [string]$Qualification.decision
    $qualificationMode = [string]$Qualification.validationMode
    if ($qualificationDecision -ceq 'not-provided') {
        if ($qualificationMode -cne 'stock' -or
            $null -ne $Qualification.qualificationId -or
            $null -ne $Qualification.runId -or
            $null -ne $Qualification.bindingSha256 -or
            $null -ne $Qualification.expiresAtUtc -or
            @($Qualification.blockerCodes).Count -ne 0) {
            throw 'DYSON_NETWORK_V2_NORMALIZED_QUALIFICATION_INVALID'
        }
    }
    elseif ($qualificationDecision -cin @('qualified', 'blocked', 'preview-valid')) {
        if ($qualificationMode -cnotin @('preview', 'consume')) {
            throw 'DYSON_NETWORK_V2_NORMALIZED_QUALIFICATION_INVALID'
        }
        $projection = [pscustomobject][ordered]@{
            qualificationId = $Qualification.qualificationId
            runId = $Qualification.runId
            bindingSha256 = $Qualification.bindingSha256
            expiresAtUtc = $Qualification.expiresAtUtc
            decision = $qualificationDecision
            blockerCodes = @($Qualification.blockerCodes)
        }
        [void](ConvertFrom-DysonNetworkV2QualificationProjection -Projection $projection `
            -ExpectedQualificationId ([string]$Qualification.qualificationId) `
            -NowUtc $NowUtc -ValidationMode $qualificationMode)
    }
    else {
        throw 'DYSON_NETWORK_V2_NORMALIZED_QUALIFICATION_INVALID'
    }
    if ($qualificationDecision -ceq 'qualified' -and -not $RemoteProbesEnabled) {
        throw 'DYSON_NETWORK_V2_QUALIFIED_SEMANTICS_REQUIRE_REMOTE_PROBES'
    }
    $qualifiedSemantics = [string]$Qualification.decision -ceq 'qualified' -and
        [string]$Qualification.validationMode -ceq 'consume'

    try { $listener = & $LocalListenerProbe $LocalGamePort @('DSPGAME') }
    catch {
        $listener = [pscustomobject][ordered]@{
            state = 'query-unavailable'; bindingCount = 0
            bindingClassCounts = New-DysonNetworkAddressClassCounts
            processIdentity = [pscustomobject][ordered]@{
                state = 'query-unavailable'; observedProcessCount = 0; observedProcessNames = @()
                expectedNameMatched = $false; singleOwner = $false
                executablePathsEmitted = $false; processIdsEmitted = $false
            }
        }
    }
    $listenerOutput = [pscustomobject][ordered]@{
        originPort = $LocalGamePort
        state = [string]$listener.state
        bindingCount = [int]$listener.bindingCount
        bindingClassCounts = $listener.bindingClassCounts
        processIdentity = $listener.processIdentity
    }

    $game = New-DysonNetworkV2GamePlane -Target $GameDataTarget `
        -QualifiedSemantics $qualifiedSemantics -RemoteProbesEnabled $RemoteProbesEnabled `
        -DnsProbe $DnsProbe -TcpProbe $TcpProbe -WebSocketProbe $WebSocketProbe `
        -AddressClassProbe $AddressClassProbe
    $management = New-DysonNetworkV2ManagementPlane -Target $ManagementTarget `
        -Port $ManagementPort -Transport $ManagementTransport -RemoteProbesEnabled $RemoteProbesEnabled `
        -DnsProbe $DnsProbe -TcpProbe $TcpProbe -AddressClassProbe $AddressClassProbe

    $sameAuthority = $false
    if ($null -ne $GameDataTarget -and $null -ne $ManagementTarget) {
        $sameAuthority = [string]::Equals(
            [string]$GameDataTarget.value,
            [string]$ManagementTarget.value,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and $ManagementPort -eq 443
    }

    $findings = New-Object 'System.Collections.Generic.List[object]'
    if ([string]$listener.state -cne 'listening') {
        [void]$findings.Add((New-DysonNetworkV2Finding -Code 'LOCAL_LISTENER_NOT_VERIFIED' `
            -Severity 'blocker' -Plane 'local-listener'))
    }
    elseif ([string]$listener.processIdentity.state -cne 'matched') {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code 'LOCAL_LISTENER_PROCESS_IDENTITY_NOT_VERIFIED' -Severity 'blocker' -Plane 'local-listener'))
    }
    elseif (-not [bool]$listener.processIdentity.singleOwner) {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code 'LOCAL_LISTENER_SINGLE_OWNER_NOT_VERIFIED' -Severity 'blocker' -Plane 'local-listener'))
    }

    if ([string]$Qualification.decision -ceq 'not-provided') {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code 'HOSTNAME_WSS_QUALIFICATION_REQUIRED' -Severity 'blocker' -Plane 'qualification'))
    }
    elseif ([string]$Qualification.decision -in @('blocked', 'preview-valid')) {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code $(if ([string]$Qualification.decision -ceq 'preview-valid') {
                'HOSTNAME_WSS_QUALIFICATION_PREVIEW_ONLY'
            } else { 'HOSTNAME_WSS_QUALIFICATION_BLOCKED' }) `
            -Severity 'blocker' -Plane 'qualification'))
        foreach ($code in @($Qualification.blockerCodes)) {
            [void]$findings.Add((New-DysonNetworkV2Finding -Code ([string]$code) `
                -Severity 'blocker' -Plane 'qualification'))
        }
    }

    if (-not $RemoteProbesEnabled) {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code 'REMOTE_PROBES_DISABLED' -Severity 'info' -Plane 'tool'))
    }
    elseif ($qualifiedSemantics) {
        if (-not [bool]$game.configured) {
            [void]$findings.Add((New-DysonNetworkV2Finding `
                -Code 'GAME_DATA_TARGET_NOT_CONFIGURED' -Severity 'blocker' -Plane 'game-data'))
        }
        else {
            if ([string]$game.dns.status -cne 'resolved') {
                [void]$findings.Add((New-DysonNetworkV2Finding `
                    -Code 'GAME_DATA_DNS_NOT_RESOLVED' -Severity 'blocker' -Plane 'game-data'))
            }
            if ([string]$game.targetKind -cne 'hostname' -or
                [string]$game.dns.selectedFirstClass -cne 'public') {
                [void]$findings.Add((New-DysonNetworkV2Finding `
                    -Code 'GAME_DATA_SELECTED_ADDRESS_NOT_PUBLIC' -Severity 'blocker' -Plane 'game-data'))
            }
            if ([string]$game.tcp.outcome -cne 'reachable') {
                [void]$findings.Add((New-DysonNetworkV2Finding `
                    -Code 'GAME_DATA_TCP_NOT_REACHABLE' -Severity 'blocker' -Plane 'game-data'))
            }
            if ([string]$game.websocket.outcome -cne 'upgrade-accepted') {
                $outcomeCode = ([string]$game.websocket.outcome).ToUpperInvariant().Replace('-', '_')
                [void]$findings.Add((New-DysonNetworkV2Finding `
                    -Code ('GAME_DATA_WEBSOCKET_' + $outcomeCode) -Severity 'blocker' -Plane 'game-data'))
            }
            if (-not [bool]$game.websocket.tlsCertificateValidated) {
                [void]$findings.Add((New-DysonNetworkV2Finding `
                    -Code 'GAME_DATA_TLS_CERTIFICATE_NOT_VALIDATED' -Severity 'blocker' -Plane 'game-data'))
            }
        }
    }

    if ($RemoteProbesEnabled -and [bool]$management.configured) {
        if ([string]$management.dns.status -notin @('resolved', 'literal-address')) {
            [void]$findings.Add((New-DysonNetworkV2Finding `
                -Code 'MANAGEMENT_DNS_NOT_RESOLVED' -Severity 'blocker' -Plane 'management'))
        }
        if ([string]$management.tcp.outcome -cne 'reachable') {
            [void]$findings.Add((New-DysonNetworkV2Finding `
                -Code 'MANAGEMENT_TCP_NOT_REACHABLE' -Severity 'blocker' -Plane 'management'))
        }
    }
    if ($sameAuthority) {
        [void]$findings.Add((New-DysonNetworkV2Finding `
            -Code 'PLANES_SHARE_AUTHORITY' -Severity 'warning' -Plane 'management'))
    }

    $blockerCount = @($findings | Where-Object { [string]$_.severity -ceq 'blocker' }).Count
    $ready = $qualifiedSemantics -and $RemoteProbesEnabled -and [bool]$game.configured -and
        $blockerCount -eq 0
    $state = if ($ready) { 'ready' } elseif ($blockerCount -gt 0) { 'blocked' } else { 'incomplete' }
    $qualificationSource = if ([string]$Qualification.decision -ceq 'not-provided') {
        'none'
    } else { 'protected-hostname-wss-verifier-v1' }
    $qualificationBound = $qualifiedSemantics

    return [pscustomobject][ordered]@{
        protocol = $script:DysonNetworkV2Protocol
        schemaVersion = $script:DysonNetworkV2SchemaVersion
        mode = $Mode
        generatedAt = $NowUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        productionChanged = $false
        remoteProbeEnabled = $RemoteProbesEnabled
        networkMutationImplemented = $false
        networkMutationAuthorized = $false
        qualificationValidationOperation = switch ([string]$Qualification.validationMode) {
            'preview' { 'preview'; break }
            'consume' { 'consume'; break }
            default { 'none' }
        }
        qualificationAcceptanceState = if ($qualifiedSemantics) {
            'consumed-or-idempotently-confirmed'
        }
        elseif ([string]$Qualification.decision -ceq 'preview-valid') { 'preview-only' }
        else { 'not-established' }
        privacy = [pscustomobject][ordered]@{
            targetValuesEmitted = $false; addressesEmitted = $false; pathsEmitted = $false
            credentialsAccepted = $false; processIdsEmitted = $false; executablePathsEmitted = $false
            authorityEmitted = $false; keyMaterialEmitted = $false; rawEvidenceEmitted = $false
        }
        qualification = [pscustomobject][ordered]@{
            source = $qualificationSource
            verifierProtocol = if ($qualificationSource -ceq 'none') {
                $null
            } else { 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1' }
            qualificationId = $Qualification.qualificationId
            runId = $Qualification.runId
            bindingSha256 = $Qualification.bindingSha256
            expiresAtUtc = $Qualification.expiresAtUtc
            decision = [string]$Qualification.decision
            blockerCodes = @($Qualification.blockerCodes | ForEach-Object { [string]$_ })
            exactProjectionValidated = ($qualificationSource -cne 'none')
            validationMode = [string]$Qualification.validationMode
            contractDigestBinding = if ($qualificationBound) { 'verifier-validated' } else { 'not-established' }
        }
        nebulaClientSemantics = [pscustomobject][ordered]@{
            profile = if ($qualificationBound) { 'hostname-preserving-wss' } else { 'stock' }
            qualificationDerived = $qualificationBound
            sourceContract = if ($qualificationBound) {
                'protected-hostname-wss-qualification-v1'
            } else { 'current-official-source' }
            topology = if ($qualificationBound) { 'http-websocket-tunnel' } else { 'not-qualified' }
            transport = if ($qualificationBound) { 'wss' } else { 'not-qualified' }
            port = if ($qualificationBound) { 443 } else { 0 }
            websocketPath = if ($qualificationBound) { '/socket' } else { $null }
            hostnameResolution = 'dns-first-address-only'
            authoritySemantics = if ($qualificationBound) { 'hostname-preserved' } else { 'resolved-ip-endpoint' }
            wssHostnameRouteReadyByPrefixOnly = $false
        }
        localListener = $listenerOutput
        planes = [pscustomobject][ordered]@{
            logicalRolesSeparated = $true; sameAuthority = $sameAuthority
            management = $management; gameData = $game
        }
        passWallBypassEvidence = [pscustomobject][ordered]@{
            source = if ($qualificationBound) { 'protected-qualification-receipt-chain' } else { 'none' }
            requiredForAcceptance = $true
            qualificationBound = $qualificationBound
            rawPassWallEnumsAccepted = $false
            rawRuleTextEmitted = $false
            rawInterfaceNameEmitted = $false
            decision = if ($qualificationBound) { 'receipt-chain-bound' } else { 'not-established' }
        }
        decision = [pscustomobject][ordered]@{
            state = $state; ready = $ready; blockerCount = [int]$blockerCount
            findingCount = [int]$findings.Count
        }
        findings = @($findings | ForEach-Object { $_ })
    }
}

function ConvertTo-DysonNetworkV2Json {
    param([Parameter(Mandatory)][object]$Value)

    return $Value | ConvertTo-Json -Depth 14 -Compress
}
