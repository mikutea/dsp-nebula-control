Set-StrictMode -Version Latest

$script:DysonNetworkProtocol = 'DYSON_NEBULA_NETWORK_ASSESSMENT_V1'
$script:DysonNetworkSchemaVersion = 1
$script:DysonNetworkRemoteProbeConfirmation = 'I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES'
$script:DysonNetworkMutationConfirmation = 'I_CONFIRM_NETWORK_MUTATION_IS_NOT_IMPLEMENTED'
$script:DysonNetworkAddressClasses = @(
    'loopback',
    'private',
    'documentation',
    'link-local',
    'public',
    'unspecified',
    'multicast',
    'unknown'
)

function Assert-DysonNetworkRemoteProbeGate {
    param(
        [Parameter(Mandatory)][bool]$Enabled,
        [AllowEmptyString()][string]$Confirmation = ''
    )

    if (-not $Enabled) {
        if (-not [string]::IsNullOrEmpty($Confirmation)) {
            throw 'A remote-probe confirmation was supplied while remote probes are disabled.'
        }
        return
    }
    if (-not [string]::Equals(
        $Confirmation,
        $script:DysonNetworkRemoteProbeConfirmation,
        [System.StringComparison]::Ordinal
    )) {
        throw 'Remote probes are disabled until the exact read-only confirmation phrase is supplied.'
    }
}

function Assert-DysonNetworkMutationDenied {
    param(
        [Parameter(Mandatory)][bool]$Requested,
        [AllowEmptyString()][string]$Confirmation = ''
    )

    if (-not $Requested) {
        if (-not [string]::IsNullOrEmpty($Confirmation)) {
            throw 'A mutation confirmation was supplied while mutation is not requested.'
        }
        return
    }
    if (-not [string]::Equals(
        $Confirmation,
        $script:DysonNetworkMutationConfirmation,
        [System.StringComparison]::Ordinal
    )) {
        throw 'Network mutation is fail-closed and requires the exact confirmation phrase.'
    }
    throw 'Network mutation is not implemented by this toolchain.'
}

function Resolve-DysonNetworkTarget {
    param([Parameter(Mandatory)][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 253 -or
        $Value -match '[\x00-\x20\x7f/@\\]') {
        throw 'The remote target must be a DNS hostname or IP literal without a scheme, port, path, credentials, or control characters.'
    }

    $address = $null
    if ([System.Net.IPAddress]::TryParse($Value, [ref]$address)) {
        return [pscustomobject][ordered]@{
            kind = 'ip-literal'
            value = $address.ToString()
        }
    }

    try { $ascii = ([System.Globalization.IdnMapping]::new()).GetAscii($Value.TrimEnd('.')) }
    catch {
        throw 'The remote target must be a DNS hostname or IP literal without a scheme, port, path, credentials, or control characters.'
    }
    if ($ascii.Length -gt 253 -or $ascii -notmatch '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
        throw 'The remote target must be a DNS hostname or IP literal without a scheme, port, path, credentials, or control characters.'
    }
    return [pscustomobject][ordered]@{
        kind = 'hostname'
        value = $ascii.ToLowerInvariant()
    }
}

function Get-DysonNetworkAddressClass {
    param([Parameter(Mandatory)][System.Net.IPAddress]$Address)

    $bytes = $Address.GetAddressBytes()
    if ([System.Net.IPAddress]::IsLoopback($Address)) { return 'loopback' }

    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        if ($bytes[0] -eq 0) { return 'unspecified' }
        if ($bytes[0] -ge 224 -and $bytes[0] -le 239) { return 'multicast' }
        if ($bytes[0] -eq 169 -and $bytes[1] -eq 254) { return 'link-local' }
        if ($bytes[0] -eq 10 -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168)) { return 'private' }
        if (($bytes[0] -eq 192 -and $bytes[1] -eq 0 -and $bytes[2] -eq 2) -or
            ($bytes[0] -eq 198 -and $bytes[1] -eq 51 -and $bytes[2] -eq 100) -or
            ($bytes[0] -eq 203 -and $bytes[1] -eq 0 -and $bytes[2] -eq 113)) {
            return 'documentation'
        }
        return 'public'
    }

    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        if ($Address.Equals([System.Net.IPAddress]::IPv6Any)) { return 'unspecified' }
        if ($Address.IsIPv6Multicast) { return 'multicast' }
        if ($Address.IsIPv6LinkLocal) { return 'link-local' }
        if (($bytes[0] -band 0xfe) -eq 0xfc) { return 'private' }
        if ($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and
            $bytes[2] -eq 0x0d -and $bytes[3] -eq 0xb8) { return 'documentation' }
        return 'public'
    }

    return 'unknown'
}

function New-DysonNetworkAddressClassCounts {
    param([object[]]$Addresses = @())

    $counts = [ordered]@{}
    foreach ($name in $script:DysonNetworkAddressClasses) { $counts[$name] = 0 }
    foreach ($address in @($Addresses)) {
        if ($address -isnot [System.Net.IPAddress]) { continue }
        $class = Get-DysonNetworkAddressClass -Address $address
        $counts[$class] = [int]$counts[$class] + 1
    }
    return [pscustomobject]$counts
}

function Get-DysonNetworkAddressFamilyName {
    param([System.Net.IPAddress]$Address)

    if ($null -eq $Address) { return 'none' }
    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { return 'ipv4' }
    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { return 'ipv6' }
    return 'unknown'
}

function Get-DysonRawDnsObservation {
    param([Parameter(Mandatory)][object]$Target)

    if ([string]$Target.kind -ceq 'ip-literal') {
        $address = $null
        if (-not [System.Net.IPAddress]::TryParse([string]$Target.value, [ref]$address)) {
            return [pscustomobject]@{ status = 'error'; addresses = @() }
        }
        return [pscustomobject]@{ status = 'literal-address'; addresses = @($address) }
    }

    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses([string]$Target.value))
        if ($addresses.Count -eq 0) {
            return [pscustomobject]@{ status = 'no-address'; addresses = @() }
        }
        return [pscustomobject]@{ status = 'resolved'; addresses = $addresses }
    }
    catch [System.Net.Sockets.SocketException] {
        $status = switch ($_.Exception.SocketErrorCode) {
            ([System.Net.Sockets.SocketError]::HostNotFound) { 'nxdomain'; break }
            ([System.Net.Sockets.SocketError]::NoData) { 'no-address'; break }
            ([System.Net.Sockets.SocketError]::TryAgain) { 'temporary-failure'; break }
            ([System.Net.Sockets.SocketError]::TimedOut) { 'timeout'; break }
            default { 'error' }
        }
        return [pscustomobject]@{ status = $status; addresses = @() }
    }
    catch {
        return [pscustomobject]@{ status = 'error'; addresses = @() }
    }
}

function ConvertTo-DysonPublicDnsObservation {
    param([Parameter(Mandatory)][object]$Raw)

    $addresses = @()
    if ($Raw.PSObject.Properties.Name -contains 'addresses') {
        $addresses = @($Raw.addresses | Where-Object { $_ -is [System.Net.IPAddress] })
    }
    $ipv4Count = @($addresses | Where-Object {
        $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
    }).Count
    $ipv6Count = @($addresses | Where-Object {
        $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6
    }).Count
    $selected = if ($addresses.Count -gt 0) { $addresses[0] } else { $null }
    return [pscustomobject][ordered]@{
        status = [string]$Raw.status
        addressCount = [int]$addresses.Count
        ipv4Count = [int]$ipv4Count
        ipv6Count = [int]$ipv6Count
        addressClassCounts = New-DysonNetworkAddressClassCounts -Addresses $addresses
        clientSelectionSemantics = 'first-address-only'
        selectedFirstClass = if ($null -eq $selected) { 'none' } else { Get-DysonNetworkAddressClass $selected }
        selectedFirstFamily = Get-DysonNetworkAddressFamilyName $selected
        rawAnswersEmitted = $false
    }
}

function New-DysonDisabledDnsObservation {
    param([Parameter(Mandatory)][ValidateSet('not-configured', 'remote-probes-disabled')][string]$Status)

    return [pscustomobject][ordered]@{
        status = $Status
        addressCount = 0
        ipv4Count = 0
        ipv6Count = 0
        addressClassCounts = New-DysonNetworkAddressClassCounts
        clientSelectionSemantics = 'first-address-only'
        selectedFirstClass = 'none'
        selectedFirstFamily = 'none'
        rawAnswersEmitted = $false
    }
}

function Get-DysonRawTcpObservation {
    param(
        [Parameter(Mandatory)][System.Net.IPAddress]$Address,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][ValidateRange(250, 30000)][int]$TimeoutMilliseconds
    )

    $client = [System.Net.Sockets.TcpClient]::new($Address.AddressFamily)
    try {
        $async = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return [pscustomobject]@{ outcome = 'timeout' }
        }
        try { $client.EndConnect($async) }
        catch [System.Net.Sockets.SocketException] {
            return [pscustomobject]@{ outcome = ConvertTo-DysonTcpSocketOutcome $_.Exception.SocketErrorCode }
        }
        if (-not $client.Connected) { return [pscustomobject]@{ outcome = 'error' } }
        return [pscustomobject]@{ outcome = 'reachable' }
    }
    catch [System.Net.Sockets.SocketException] {
        return [pscustomobject]@{ outcome = ConvertTo-DysonTcpSocketOutcome $_.Exception.SocketErrorCode }
    }
    catch {
        return [pscustomobject]@{ outcome = 'error' }
    }
    finally { $client.Dispose() }
}

function ConvertTo-DysonTcpSocketOutcome {
    param([Parameter(Mandatory)][System.Net.Sockets.SocketError]$SocketError)

    switch ($SocketError) {
        ([System.Net.Sockets.SocketError]::ConnectionRefused) { return 'connection-refused' }
        ([System.Net.Sockets.SocketError]::TimedOut) { return 'timeout' }
        ([System.Net.Sockets.SocketError]::NetworkUnreachable) { return 'network-unreachable' }
        ([System.Net.Sockets.SocketError]::HostUnreachable) { return 'address-unreachable' }
        ([System.Net.Sockets.SocketError]::AddressNotAvailable) { return 'address-unreachable' }
        default { return 'error' }
    }
}

function New-DysonTcpObservation {
    param([Parameter(Mandatory)][string]$Outcome)

    return [pscustomobject][ordered]@{
        outcome = $Outcome
        endpointEmitted = $false
    }
}

function Read-DysonWebSocketResponseBytes {
    param(
        [Parameter(Mandatory)][System.IO.Stream]$Stream,
        [Parameter(Mandatory)][ValidateRange(250, 30000)][int]$TimeoutMilliseconds
    )

    $Stream.ReadTimeout = $TimeoutMilliseconds
    $buffer = New-Object byte[] 8192
    $used = 0
    while ($used -lt $buffer.Length) {
        $read = $Stream.Read($buffer, $used, $buffer.Length - $used)
        if ($read -le 0) { break }
        $used += $read
        if ($used -ge 4) {
            for ($index = [Math]::Max(0, $used - $read - 3); $index -le $used - 4; $index += 1) {
                if ($buffer[$index] -eq 13 -and $buffer[$index + 1] -eq 10 -and
                    $buffer[$index + 2] -eq 13 -and $buffer[$index + 3] -eq 10) {
                    $copy = New-Object byte[] ($index + 4)
                    [Array]::Copy($buffer, $copy, $copy.Length)
                    return $copy
                }
            }
        }
    }
    $result = New-Object byte[] $used
    if ($used -gt 0) { [Array]::Copy($buffer, $result, $used) }
    return $result
}

function Get-DysonWebSocketHostHeader {
    param(
        [Parameter(Mandatory)][System.Net.IPAddress]$Address,
        [Parameter(Mandatory)][int]$Port
    )

    $value = $Address.ToString()
    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        $value = '[' + $value + ']'
    }
    return $value + ':' + $Port
}

function Get-DysonRawWebSocketObservation {
    param(
        [Parameter(Mandatory)][System.Net.IPAddress]$Address,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][ValidateSet('ws', 'wss')][string]$Transport,
        [Parameter(Mandatory)][ValidateRange(250, 30000)][int]$TimeoutMilliseconds
    )

    $client = [System.Net.Sockets.TcpClient]::new($Address.AddressFamily)
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
        $client.ReceiveTimeout = $TimeoutMilliseconds
        $client.SendTimeout = $TimeoutMilliseconds
        $transportStream = $client.GetStream()
        $tlsValidated = $false
        if ($Transport -ceq 'wss') {
            try {
                $sslStream = [System.Net.Security.SslStream]::new($transportStream, $false)
                # Nebula resolves the hostname first, then builds the WebSocket URI from the selected IP endpoint.
                $sslStream.AuthenticateAsClient($Address.ToString())
                $transportStream = $sslStream
                $tlsValidated = $true
            }
            catch {
                return [pscustomobject]@{
                    outcome = 'tls-failure'; statusCode = $null; upgradeHeaderPresent = $false
                    connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                    tlsCertificateValidated = $false
                }
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
        $hostHeader = Get-DysonWebSocketHostHeader -Address $Address -Port $Port
        $request = @(
            'GET /socket HTTP/1.1',
            ('Host: ' + $hostHeader),
            'Upgrade: websocket',
            'Connection: Upgrade',
            ('Sec-WebSocket-Key: ' + $webSocketKey),
            'Sec-WebSocket-Version: 13',
            'User-Agent: Dyson-Network-Preflight/1',
            '',
            ''
        ) -join "`r`n"
        $requestBytes = [System.Text.Encoding]::ASCII.GetBytes($request)
        $transportStream.Write($requestBytes, 0, $requestBytes.Length)
        $transportStream.Flush()
        try { $responseBytes = @(Read-DysonWebSocketResponseBytes -Stream $transportStream -TimeoutMilliseconds $TimeoutMilliseconds) }
        catch [System.IO.IOException] {
            return [pscustomobject]@{
                outcome = 'timeout'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $tlsValidated
            }
        }
        if ($responseBytes.Count -eq 0) {
            return [pscustomobject]@{
                outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $tlsValidated
            }
        }
        if ($Transport -ceq 'ws' -and $responseBytes.Count -ge 3 -and
            ($responseBytes[0] -eq 0x15 -or $responseBytes[0] -eq 0x16) -and
            $responseBytes[1] -eq 0x03) {
            return [pscustomobject]@{
                outcome = 'plaintext-on-tls-port'; statusCode = $null; upgradeHeaderPresent = $false
                connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                tlsCertificateValidated = $false
            }
        }

        $response = [System.Text.Encoding]::ASCII.GetString([byte[]]$responseBytes)
        return ConvertFrom-DysonWebSocketHttpResponse -Response $response `
            -ExpectedAccept $expectedAccept -TlsCertificateValidated $tlsValidated
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

function ConvertFrom-DysonWebSocketHttpResponse {
    param(
        [Parameter(Mandatory)][string]$Response,
        [Parameter(Mandatory)][string]$ExpectedAccept,
        [Parameter(Mandatory)][bool]$TlsCertificateValidated
    )

    $lines = @($Response -split "`r?`n")
    if ($lines.Count -eq 0 -or $lines[0] -notmatch '^HTTP/1\.[01]\s+(?<status>[1-5][0-9]{2})(?:\s|$)') {
        return [pscustomobject]@{
            outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
            connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
            tlsCertificateValidated = $TlsCertificateValidated
        }
    }
    $statusCode = [int]$Matches['status']
    $upgrade = $false
    $connection = $false
    $accept = $false
    $acceptValid = $false
    foreach ($line in $lines[1..($lines.Count - 1)]) {
        if ($line -match '^(?<name>[^:]+):\s*(?<value>.*)$') {
            $name = $Matches['name'].Trim().ToLowerInvariant()
            $value = $Matches['value'].Trim()
            if ($name -ceq 'upgrade' -and $value -match '(?i)(?:^|,)\s*websocket\s*(?:,|$)') { $upgrade = $true }
            if ($name -ceq 'connection' -and $value -match '(?i)(?:^|,)\s*upgrade\s*(?:,|$)') { $connection = $true }
            if ($name -ceq 'sec-websocket-accept' -and -not [string]::IsNullOrWhiteSpace($value)) {
                $accept = $true
                $acceptValid = [string]::Equals($value, $ExpectedAccept, [System.StringComparison]::Ordinal)
            }
        }
    }
    $outcome = if ($statusCode -eq 101 -and $upgrade -and $connection -and $acceptValid) {
        'upgrade-accepted'
    }
    elseif ($statusCode -eq 401 -or $statusCode -eq 403) {
        'auth-required'
    }
    elseif ($statusCode -eq 404) {
        'wrong-path'
    }
    elseif ($statusCode -eq 101) {
        'invalid-upgrade'
    }
    else {
        'non-101'
    }
    return [pscustomobject]@{
        outcome = $outcome
        statusCode = $statusCode
        upgradeHeaderPresent = $upgrade
        connectionHeaderUpgrade = $connection
        acceptHeaderPresent = $accept
        acceptHeaderValid = $acceptValid
        tlsCertificateValidated = $TlsCertificateValidated
    }
}

function New-DysonPublicWebSocketObservation {
    param([Parameter(Mandatory)][object]$Raw)

    return [pscustomobject][ordered]@{
        path = '/socket'
        outcome = [string]$Raw.outcome
        statusCode = if ($null -eq $Raw.statusCode) { $null } else { [int]$Raw.statusCode }
        upgradeHeaderPresent = [bool]$Raw.upgradeHeaderPresent
        connectionHeaderUpgrade = [bool]$Raw.connectionHeaderUpgrade
        acceptHeaderPresent = [bool]$Raw.acceptHeaderPresent
        acceptHeaderValid = [bool]$Raw.acceptHeaderValid
        tlsCertificateValidated = [bool]$Raw.tlsCertificateValidated
        authoritySemantics = 'resolved-ip-endpoint'
        responseHeadersEmitted = $false
    }
}

function New-DysonDisabledWebSocketObservation {
    param([Parameter(Mandatory)][ValidateSet('not-applicable', 'remote-probes-disabled', 'dns-unavailable')][string]$Outcome)

    return [pscustomobject][ordered]@{
        path = '/socket'
        outcome = $Outcome
        statusCode = $null
        upgradeHeaderPresent = $false
        connectionHeaderUpgrade = $false
        acceptHeaderPresent = $false
        acceptHeaderValid = $false
        tlsCertificateValidated = $false
        authoritySemantics = 'resolved-ip-endpoint'
        responseHeadersEmitted = $false
    }
}

function Get-DysonLocalListenerObservation {
    param(
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][string[]]$ExpectedProcessNames
    )

    $emptyCounts = New-DysonNetworkAddressClassCounts
    try {
        $command = Get-Command -Name 'Get-NetTCPConnection' -CommandType Function, Cmdlet -ErrorAction Stop |
            Select-Object -First 1
        if ($null -eq $command) { throw 'unavailable' }
        $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    }
    catch {
        return [pscustomobject][ordered]@{
            state = 'query-unavailable'
            bindingCount = 0
            bindingClassCounts = $emptyCounts
            processIdentity = [pscustomobject][ordered]@{
                state = 'query-unavailable'; observedProcessCount = 0
                observedProcessNames = @(); expectedNameMatched = $false; singleOwner = $false
                executablePathsEmitted = $false; processIdsEmitted = $false
            }
        }
    }

    if ($connections.Count -eq 0) {
        return [pscustomobject][ordered]@{
            state = 'not-listening'
            bindingCount = 0
            bindingClassCounts = $emptyCounts
            processIdentity = [pscustomobject][ordered]@{
                state = 'not-listening'; observedProcessCount = 0
                observedProcessNames = @(); expectedNameMatched = $false; singleOwner = $false
                executablePathsEmitted = $false; processIdsEmitted = $false
            }
        }
    }

    $bindingAddresses = New-Object 'System.Collections.Generic.List[object]'
    $ownerIds = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($connection in $connections) {
        $address = $null
        if ([System.Net.IPAddress]::TryParse([string]$connection.LocalAddress, [ref]$address)) {
            [void]$bindingAddresses.Add($address)
        }
        if ($null -ne $connection.OwningProcess) { [void]$ownerIds.Add([int]$connection.OwningProcess) }
    }
    $processNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $processQueryFailed = $false
    foreach ($ownerId in $ownerIds) {
        try {
            $process = Get-Process -Id $ownerId -ErrorAction Stop
            if (-not [string]::IsNullOrWhiteSpace([string]$process.ProcessName)) {
                [void]$processNames.Add([string]$process.ProcessName)
            }
        }
        catch { $processQueryFailed = $true }
    }
    $observedNames = @($processNames | Sort-Object)
    $expectedMatched = $false
    foreach ($expected in $ExpectedProcessNames) {
        foreach ($observed in $observedNames) {
            if ([string]::Equals($expected, $observed, [System.StringComparison]::OrdinalIgnoreCase)) {
                $expectedMatched = $true
            }
        }
    }
    $identityState = if ($processQueryFailed -or $observedNames.Count -eq 0) {
        'query-unavailable'
    }
    elseif ($ownerIds.Count -ne 1) {
        'ambiguous'
    }
    elseif ($expectedMatched) {
        'matched'
    }
    else {
        'mismatched'
    }
    return [pscustomobject][ordered]@{
        state = 'listening'
        bindingCount = [int]$connections.Count
        bindingClassCounts = New-DysonNetworkAddressClassCounts -Addresses @(
            $bindingAddresses | ForEach-Object { $_ }
        )
        processIdentity = [pscustomobject][ordered]@{
            state = $identityState
            observedProcessCount = [int]$ownerIds.Count
            observedProcessNames = @($observedNames)
            expectedNameMatched = $expectedMatched
            singleOwner = ($ownerIds.Count -eq 1)
            executablePathsEmitted = $false
            processIdsEmitted = $false
        }
    }
}

function New-DysonPassWallEvidence {
    param(
        [ValidateSet('direct', 'proxy', 'block', 'unknown')][string]$ExpectedRoute = 'unknown',
        [ValidateSet('verified', 'failed', 'not-observed')][string]$RuleRendered = 'not-observed',
        [ValidateSet('verified', 'failed', 'not-observed')][string]$RuleValidated = 'not-observed',
        [ValidateSet('verified', 'failed', 'not-observed')][string]$RuleActive = 'not-observed',
        [ValidateSet('verified', 'failed', 'not-observed')][string]$RealFlowCounterDelta = 'not-observed',
        [ValidateSet('loopback', 'private', 'documentation', 'link-local', 'public', 'unspecified', 'multicast', 'unknown')][string]$SelectedDestinationClass = 'unknown',
        [ValidateSet('lan', 'wan', 'tunnel', 'loopback', 'unknown')][string]$ActualIngressInterfaceClass = 'unknown',
        [ValidateSet('direct', 'proxy', 'block', 'unknown')][string]$ActualRouteClass = 'unknown',
        [ValidateSet('verified', 'failed', 'not-observed')][string]$ExternalPathWitness = 'not-observed'
    )

    $required = $ExpectedRoute -cne 'unknown'
    $verified = $required -and
        $RuleRendered -ceq 'verified' -and
        $RuleValidated -ceq 'verified' -and
        $RuleActive -ceq 'verified' -and
        $RealFlowCounterDelta -ceq 'verified' -and
        $SelectedDestinationClass -cne 'unknown' -and
        $ActualIngressInterfaceClass -cne 'unknown' -and
        $ActualRouteClass -ceq $ExpectedRoute -and
        $ExternalPathWitness -ceq 'verified'
    $failed = @($RuleRendered, $RuleValidated, $RuleActive, $RealFlowCounterDelta, $ExternalPathWitness) -contains 'failed'
    if ($required -and $ActualRouteClass -cne 'unknown' -and $ActualRouteClass -cne $ExpectedRoute) { $failed = $true }
    $decision = if ($verified) { 'verified' } elseif ($failed) { 'contradicted' } else { 'insufficient-evidence' }
    return [pscustomobject][ordered]@{
        requiredForAcceptance = $required
        expectedRoute = $ExpectedRoute
        ruleRendered = $RuleRendered
        ruleValidated = $RuleValidated
        ruleActive = $RuleActive
        realFlowCounterDelta = $RealFlowCounterDelta
        selectedDestinationClass = $SelectedDestinationClass
        actualIngressInterfaceClass = $ActualIngressInterfaceClass
        actualRouteClass = $ActualRouteClass
        externalPathWitness = $ExternalPathWitness
        rawRuleTextEmitted = $false
        rawInterfaceNameEmitted = $false
        decision = $decision
    }
}

function Assert-DysonExactObjectProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Context
    )

    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    if (-not [string]::Equals(
        [string]::Join("`n", $actual),
        [string]::Join("`n", $wanted),
        [System.StringComparison]::Ordinal
    )) {
        throw ($Context + ' does not have the fixed property set.')
    }
}

function ConvertTo-DysonValidatedPassWallEvidence {
    param([Parameter(Mandatory)][object]$Raw)

    Assert-DysonExactObjectProperties -Value $Raw -Expected @(
        'protocol', 'schemaVersion', 'expectedRoute', 'ruleRendered', 'ruleValidated', 'ruleActive',
        'realFlowCounterDelta', 'selectedDestinationClass', 'actualIngressInterfaceClass',
        'actualRouteClass', 'externalPathWitness'
    ) -Context 'PassWall evidence'
    if ([string]$Raw.protocol -cne 'DYSON_PASSWALL_BYPASS_EVIDENCE_V1' -or [int]$Raw.schemaVersion -ne 1) {
        throw 'PassWall evidence uses an unsupported protocol or schema version.'
    }
    return New-DysonPassWallEvidence -ExpectedRoute ([string]$Raw.expectedRoute) `
        -RuleRendered ([string]$Raw.ruleRendered) -RuleValidated ([string]$Raw.ruleValidated) `
        -RuleActive ([string]$Raw.ruleActive) -RealFlowCounterDelta ([string]$Raw.realFlowCounterDelta) `
        -SelectedDestinationClass ([string]$Raw.selectedDestinationClass) `
        -ActualIngressInterfaceClass ([string]$Raw.actualIngressInterfaceClass) `
        -ActualRouteClass ([string]$Raw.actualRouteClass) `
        -ExternalPathWitness ([string]$Raw.externalPathWitness)
}

function Read-DysonPassWallEvidenceFile {
    param([Parameter(Mandatory)][string]$Path)

    try { $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
    catch { throw 'The PassWall evidence file could not be read.' }
    if ($text.Length -gt 65536) { throw 'The PassWall evidence file exceeds the fixed size limit.' }
    try { $raw = $text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'The PassWall evidence file is not valid JSON.' }
    return ConvertTo-DysonValidatedPassWallEvidence -Raw $raw
}

function New-DysonFinding {
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][ValidateSet('blocker', 'warning', 'info')][string]$Severity,
        [Parameter(Mandatory)][ValidateSet('local-listener', 'game-data', 'management', 'passwall', 'tool')][string]$Plane
    )

    return [pscustomobject][ordered]@{ code = $Code; severity = $Severity; plane = $Plane }
}

function Invoke-DysonNetworkPlaneProbe {
    param(
        [Parameter(Mandatory)][ValidateSet('game-data', 'management')][string]$Role,
        [AllowNull()][object]$Target,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [Parameter(Mandatory)][string]$Transport,
        [Parameter(Mandatory)][bool]$RemoteProbesEnabled,
        [Parameter(Mandatory)][scriptblock]$DnsProbe,
        [Parameter(Mandatory)][scriptblock]$TcpProbe,
        [Parameter(Mandatory)][scriptblock]$WebSocketProbe
    )

    $configured = $null -ne $Target
    $targetKind = if ($configured) { [string]$Target.kind } else { 'none' }
    $dnsRaw = $null
    if (-not $configured) {
        $dns = New-DysonDisabledDnsObservation -Status 'not-configured'
        $tcp = New-DysonTcpObservation -Outcome 'not-configured'
        $webSocket = New-DysonDisabledWebSocketObservation -Outcome 'not-applicable'
    }
    elseif (-not $RemoteProbesEnabled) {
        $dns = New-DysonDisabledDnsObservation -Status 'remote-probes-disabled'
        $tcp = New-DysonTcpObservation -Outcome 'remote-probes-disabled'
        $webSocket = if ($Role -ceq 'game-data' -and $Transport -in @('ws', 'wss')) {
            New-DysonDisabledWebSocketObservation -Outcome 'remote-probes-disabled'
        }
        else { New-DysonDisabledWebSocketObservation -Outcome 'not-applicable' }
    }
    else {
        try { $dnsRaw = & $DnsProbe $Target }
        catch { $dnsRaw = [pscustomobject]@{ status = 'error'; addresses = @() } }
        $dns = ConvertTo-DysonPublicDnsObservation -Raw $dnsRaw
        $addresses = @($dnsRaw.addresses | Where-Object { $_ -is [System.Net.IPAddress] })
        if ($addresses.Count -eq 0) {
            $tcp = New-DysonTcpObservation -Outcome 'dns-unavailable'
            $webSocket = if ($Role -ceq 'game-data' -and $Transport -in @('ws', 'wss')) {
                New-DysonDisabledWebSocketObservation -Outcome 'dns-unavailable'
            }
            else { New-DysonDisabledWebSocketObservation -Outcome 'not-applicable' }
        }
        else {
            try { $tcpRaw = & $TcpProbe $addresses[0] $Port }
            catch { $tcpRaw = [pscustomobject]@{ outcome = 'error' } }
            $tcp = New-DysonTcpObservation -Outcome ([string]$tcpRaw.outcome)
            if ($Role -ceq 'game-data' -and $Transport -in @('ws', 'wss')) {
                try { $webSocketRaw = & $WebSocketProbe $addresses[0] $Port $Transport }
                catch {
                    $webSocketRaw = [pscustomobject]@{
                        outcome = 'protocol-error'; statusCode = $null; upgradeHeaderPresent = $false
                        connectionHeaderUpgrade = $false; acceptHeaderPresent = $false; acceptHeaderValid = $false
                        tlsCertificateValidated = $false
                    }
                }
                $webSocket = New-DysonPublicWebSocketObservation -Raw $webSocketRaw
            }
            else { $webSocket = New-DysonDisabledWebSocketObservation -Outcome 'not-applicable' }
        }
    }
    return [pscustomobject][ordered]@{
        role = $Role
        configured = $configured
        targetRef = $Role + '-plane'
        targetKind = $targetKind
        targetValueEmitted = $false
        port = $Port
        transport = $Transport
        dns = $dns
        tcp = $tcp
        websocket = $webSocket
    }
}

function Invoke-DysonNetworkAssessment {
    param(
        [Parameter(Mandatory)][ValidateSet('local-read-only', 'remote-read-only', 'shadow')][string]$Mode,
        [Parameter(Mandatory)][bool]$RemoteProbesEnabled,
        [AllowNull()][object]$GameDataTarget,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$GameDataPort,
        [Parameter(Mandatory)][ValidateSet('tcp', 'ws', 'wss')][string]$GameDataTransport,
        [AllowNull()][object]$ManagementTarget,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$ManagementPort,
        [Parameter(Mandatory)][ValidateSet('tcp', 'http', 'https')][string]$ManagementTransport,
        [Parameter(Mandatory)][string[]]$ExpectedProcessNames,
        [Parameter(Mandatory)][object]$PassWallEvidence,
        [Parameter(Mandatory)][scriptblock]$LocalListenerProbe,
        [Parameter(Mandatory)][scriptblock]$DnsProbe,
        [Parameter(Mandatory)][scriptblock]$TcpProbe,
        [Parameter(Mandatory)][scriptblock]$WebSocketProbe
    )

    try { $listener = & $LocalListenerProbe $GameDataPort $ExpectedProcessNames }
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
    $game = Invoke-DysonNetworkPlaneProbe -Role 'game-data' -Target $GameDataTarget `
        -Port $GameDataPort -Transport $GameDataTransport -RemoteProbesEnabled $RemoteProbesEnabled `
        -DnsProbe $DnsProbe -TcpProbe $TcpProbe -WebSocketProbe $WebSocketProbe
    $management = Invoke-DysonNetworkPlaneProbe -Role 'management' -Target $ManagementTarget `
        -Port $ManagementPort -Transport $ManagementTransport -RemoteProbesEnabled $RemoteProbesEnabled `
        -DnsProbe $DnsProbe -TcpProbe $TcpProbe -WebSocketProbe $WebSocketProbe

    $sameAuthority = $false
    if ($null -ne $GameDataTarget -and $null -ne $ManagementTarget) {
        $sameAuthority = [string]::Equals(
            [string]$GameDataTarget.value,
            [string]$ManagementTarget.value,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and $GameDataPort -eq $ManagementPort
    }

    $findings = New-Object 'System.Collections.Generic.List[object]'
    if ([string]$listener.state -cne 'listening') {
        [void]$findings.Add((New-DysonFinding -Code 'LOCAL_LISTENER_NOT_VERIFIED' -Severity 'blocker' -Plane 'local-listener'))
    }
    elseif ([string]$listener.processIdentity.state -cne 'matched') {
        [void]$findings.Add((New-DysonFinding -Code 'LOCAL_LISTENER_PROCESS_IDENTITY_NOT_VERIFIED' -Severity 'blocker' -Plane 'local-listener'))
    }

    if (-not $RemoteProbesEnabled) {
        [void]$findings.Add((New-DysonFinding -Code 'REMOTE_PROBES_DISABLED' -Severity 'info' -Plane 'tool'))
    }
    elseif (-not [bool]$game.configured) {
        [void]$findings.Add((New-DysonFinding -Code 'GAME_DATA_TARGET_NOT_CONFIGURED' -Severity 'blocker' -Plane 'game-data'))
    }
    else {
        if ([string]$game.dns.status -notin @('resolved', 'literal-address')) {
            [void]$findings.Add((New-DysonFinding -Code 'GAME_DATA_DNS_NOT_RESOLVED' -Severity 'blocker' -Plane 'game-data'))
        }
        if ([string]$game.tcp.outcome -cne 'reachable') {
            [void]$findings.Add((New-DysonFinding -Code 'GAME_DATA_TCP_NOT_REACHABLE' -Severity 'blocker' -Plane 'game-data'))
        }
        if ($GameDataTransport -in @('ws', 'wss') -and [string]$game.websocket.outcome -cne 'upgrade-accepted') {
            [void]$findings.Add((New-DysonFinding -Code ('GAME_DATA_WEBSOCKET_' + ([string]$game.websocket.outcome).ToUpperInvariant().Replace('-', '_')) -Severity 'blocker' -Plane 'game-data'))
        }
        if ($GameDataTransport -ceq 'wss' -and [string]$game.targetKind -ceq 'hostname') {
            [void]$findings.Add((New-DysonFinding -Code 'NEBULA_WSS_HOSTNAME_AUTHORITY_NOT_PRESERVED' -Severity 'blocker' -Plane 'game-data'))
        }
    }

    if ($RemoteProbesEnabled -and [bool]$management.configured) {
        if ([string]$management.dns.status -notin @('resolved', 'literal-address')) {
            [void]$findings.Add((New-DysonFinding -Code 'MANAGEMENT_DNS_NOT_RESOLVED' -Severity 'blocker' -Plane 'management'))
        }
        if ([string]$management.tcp.outcome -cne 'reachable') {
            [void]$findings.Add((New-DysonFinding -Code 'MANAGEMENT_TCP_NOT_REACHABLE' -Severity 'blocker' -Plane 'management'))
        }
    }
    if ($sameAuthority) {
        [void]$findings.Add((New-DysonFinding -Code 'PLANES_SHARE_AUTHORITY' -Severity 'warning' -Plane 'management'))
    }
    if ([bool]$PassWallEvidence.requiredForAcceptance -and [string]$PassWallEvidence.decision -cne 'verified') {
        [void]$findings.Add((New-DysonFinding -Code 'PASSWALL_BYPASS_EVIDENCE_INCOMPLETE' -Severity 'blocker' -Plane 'passwall'))
    }
    elseif (-not [bool]$PassWallEvidence.requiredForAcceptance) {
        [void]$findings.Add((New-DysonFinding -Code 'PASSWALL_ROUTE_EXPECTATION_NOT_DECLARED' -Severity 'info' -Plane 'passwall'))
    }
    if ([bool]$PassWallEvidence.requiredForAcceptance -and
        [string]$PassWallEvidence.selectedDestinationClass -cne 'unknown' -and
        [string]$game.dns.selectedFirstClass -notin @('none', [string]$PassWallEvidence.selectedDestinationClass)) {
        [void]$findings.Add((New-DysonFinding -Code 'PASSWALL_DESTINATION_CLASS_MISMATCH' -Severity 'blocker' -Plane 'passwall'))
    }

    $blockerCount = @($findings | Where-Object { [string]$_.severity -ceq 'blocker' }).Count
    $ready = $RemoteProbesEnabled -and [bool]$game.configured -and $blockerCount -eq 0
    $state = if ($ready) { 'ready' } elseif ($blockerCount -gt 0) { 'blocked' } else { 'incomplete' }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonNetworkProtocol
        schemaVersion = $script:DysonNetworkSchemaVersion
        mode = $Mode
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        productionChanged = $false
        remoteProbeEnabled = $RemoteProbesEnabled
        mutationImplemented = $false
        mutationAuthorized = $false
        privacy = [pscustomobject][ordered]@{
            targetValuesEmitted = $false
            addressesEmitted = $false
            pathsEmitted = $false
            credentialsAccepted = $false
            processIdsEmitted = $false
            executablePathsEmitted = $false
        }
        nebulaClientSemantics = [pscustomobject][ordered]@{
            sourceContract = 'current-official-source'
            protocolWithoutPrefix = 'ws'
            recognizedPrefixes = @('ws', 'wss')
            missingPortUsesConfiguredHostPort = $true
            hostnameResolution = 'dns-first-address-only'
            websocketAuthority = 'resolved-ip-endpoint'
            websocketPath = '/socket'
            wssHostnameRouteReadyByPrefixOnly = $false
        }
        localListener = $listener
        planes = [pscustomobject][ordered]@{
            logicalRolesSeparated = $true
            sameAuthority = $sameAuthority
            management = $management
            gameData = $game
        }
        passWallBypassEvidence = $PassWallEvidence
        decision = [pscustomobject][ordered]@{
            state = $state
            ready = $ready
            blockerCount = [int]$blockerCount
            findingCount = [int]$findings.Count
        }
        findings = @($findings | ForEach-Object { $_ })
    }
}

function ConvertTo-DysonNetworkJson {
    param([Parameter(Mandatory)][object]$Value)

    return $Value | ConvertTo-Json -Depth 12 -Compress
}
