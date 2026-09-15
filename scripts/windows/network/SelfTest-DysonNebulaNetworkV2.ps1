[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Assert-DysonNetworkV2SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('DYSON_NETWORK_V2_SELFTEST_FAILED: ' + $Message) }
}

function Assert-DysonNetworkV2SelfTestProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    Assert-DysonNetworkV2SelfTest `
        -Condition ([string]::Equals(
            [string]::Join("`n", $actual),
            [string]::Join("`n", $wanted),
            [System.StringComparison]::Ordinal
        )) -Message $Message
}

function Assert-DysonNetworkV2Rejected {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$ExpectedCode,
        [Parameter(Mandatory)][string]$Message
    )
    $caught = $null
    try { & $Action | Out-Null }
    catch { $caught = [string]$_.Exception.Message }
    Assert-DysonNetworkV2SelfTest -Condition (
        $null -ne $caught -and $caught.Contains($ExpectedCode)
    ) -Message $Message
}

function Get-DysonNetworkV2SelfTestFixedFile {
    param([Parameter(Mandatory)][string]$Name)
    $path = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Name))
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    Assert-DysonNetworkV2SelfTest -Condition (
        -not $item.PSIsContainer -and
        -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath($item.DirectoryName).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) -Message ('fixed dependency redirected: ' + $Name)
    return $item
}

function Get-DysonNetworkV2SelfTestFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = $null
    $sha = $null
    $digestBytes = $null
    try {
        $stream = New-Object System.IO.FileStream(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $digestBytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digestBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        if ($null -ne $digestBytes) { [Array]::Clear($digestBytes, 0, $digestBytes.Length) }
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

$commonItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'DysonNetworkV2.Common.ps1'
$testItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'Test-DysonNebulaNetworkV2.ps1'
$schemaItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'dyson-nebula-network-assessment-v2.schema.json'
$hostnameVerifierItem = Get-DysonNetworkV2SelfTestFixedFile `
    -Name 'Test-DysonHostnameWssQualification.ps1'
$v1CommonItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'DysonNetwork.Common.ps1'
$v1TestItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'Test-DysonNebulaNetwork.ps1'
$v1SelfTestItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'SelfTest-DysonNebulaNetwork.ps1'
$v1SchemaItem = Get-DysonNetworkV2SelfTestFixedFile -Name 'dyson-nebula-network-assessment-v1.schema.json'
$v1DigestsBefore = @{}
foreach ($item in @($v1CommonItem, $v1TestItem, $v1SelfTestItem, $v1SchemaItem)) {
    $v1DigestsBefore[$item.Name] = Get-DysonNetworkV2SelfTestFileSha256 -Path $item.FullName
}

. $commonItem.FullName

$now = [DateTimeOffset]::ParseExact(
    '2030-01-01T00:00:00.000Z',
    'yyyy-MM-ddTHH:mm:ss.fffZ',
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
        [System.Globalization.DateTimeStyles]::AdjustToUniversal
)
$qualificationId = '11111111-1111-4111-8111-111111111111'
$runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$binding = 'sha256:' + ('a' * 64)

function New-DysonNetworkV2SelfTestProjection {
    param(
        [string]$Id = $qualificationId,
        [string]$Expiry = '2030-01-01T01:00:00.000Z',
        [ValidateSet('qualified', 'blocked', 'preview-valid')][string]$Decision = 'qualified',
        [string[]]$BlockerCodes = @()
    )
    return [pscustomobject][ordered]@{
        qualificationId = $Id
        runId = $runId
        bindingSha256 = $binding
        expiresAtUtc = $Expiry
        decision = $Decision
        blockerCodes = @($BlockerCodes)
    }
}

function New-DysonNetworkV2SelfTestListener {
    param([ValidateSet('matched', 'not-listening')][string]$State = 'matched')
    if ($State -ceq 'not-listening') {
        return [pscustomobject][ordered]@{
            state = 'not-listening'; bindingCount = 0
            bindingClassCounts = New-DysonNetworkAddressClassCounts
            processIdentity = [pscustomobject][ordered]@{
                state = 'not-listening'; observedProcessCount = 0; observedProcessNames = @()
                expectedNameMatched = $false; singleOwner = $false
                executablePathsEmitted = $false; processIdsEmitted = $false
            }
        }
    }
    $addresses = @([System.Net.IPAddress]::Parse('192.0.2.44'))
    return [pscustomobject][ordered]@{
        state = 'listening'; bindingCount = 1
        bindingClassCounts = New-DysonNetworkAddressClassCounts -Addresses $addresses
        processIdentity = [pscustomobject][ordered]@{
            state = 'matched'; observedProcessCount = 1; observedProcessNames = @('DSPGAME')
            expectedNameMatched = $true; singleOwner = $true
            executablePathsEmitted = $false; processIdsEmitted = $false
        }
    }
}

$qualified = ConvertFrom-DysonNetworkV2QualificationProjection `
    -Projection (New-DysonNetworkV2SelfTestProjection) `
    -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
$target = Resolve-DysonNetworkTarget -Value 'edge.example.com'
$calls = @{
    listener = 0; dns = 0; tcp = 0; websocket = 0
    websocketArgumentsMatched = $false
}
$listenerResult = New-DysonNetworkV2SelfTestListener
$listenerProbe = {
    param([int]$Port, [string[]]$Names)
    $calls.listener += 1
    return $listenerResult
}.GetNewClosure()
$dnsProbe = {
    param([object]$Target)
    $calls.dns += 1
    return [pscustomobject]@{
        status = 'resolved'
        addresses = @(
            [System.Net.IPAddress]::Parse('192.0.2.10'),
            [System.Net.IPAddress]::Parse('2001:db8::10')
        )
    }
}.GetNewClosure()
$tcpProbe = {
    param([System.Net.IPAddress]$Address, [int]$Port)
    $calls.tcp += 1
    return [pscustomobject]@{ outcome = 'reachable' }
}.GetNewClosure()
$expectedWebSocketAuthority = 'edge.example.com'
$webSocketProbe = {
    param([System.Net.IPAddress]$Address, [string]$Authority, [int]$Port)
    $calls.websocket += 1
    $calls.websocketArgumentsMatched = $Authority -ceq $expectedWebSocketAuthority -and $Port -eq 443
    return [pscustomobject]@{
        outcome = 'upgrade-accepted'; statusCode = 101; upgradeHeaderPresent = $true
        connectionHeaderUpgrade = $true; acceptHeaderPresent = $true; acceptHeaderValid = $true
        tlsCertificateValidated = $true
    }
}.GetNewClosure()
$shadowPublicAddressClassProbe = {
    param([System.Net.IPAddress]$Address)
    # Unit-test the readiness branch without embedding or contacting a real public endpoint.
    if ($Address.ToString() -ceq '192.0.2.10') { return 'public' }
    return Get-DysonNetworkAddressClass -Address $Address
}

$ready = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
    -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
    -ManagementTransport https -LocalGamePort 8469 `
    -Qualification $qualified -NowUtc $now -LocalListenerProbe $listenerProbe `
    -DnsProbe $dnsProbe -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe `
    -AddressClassProbe $shadowPublicAddressClassProbe

Assert-DysonNetworkV2SelfTestProperties -Value $ready -Expected @(
    'protocol', 'schemaVersion', 'mode', 'generatedAt', 'productionChanged',
    'remoteProbeEnabled', 'networkMutationImplemented', 'networkMutationAuthorized',
    'qualificationValidationOperation', 'qualificationAcceptanceState', 'privacy',
    'qualification', 'nebulaClientSemantics', 'localListener', 'planes',
    'passWallBypassEvidence', 'decision', 'findings'
) -Message 'top-level exact property contract drifted'
$qualifiedSemanticsDiagnostic = [ordered]@{
    protocol = [string]$ready.protocol
    schemaVersion = [int]$ready.schemaVersion
    decisionReady = [bool]$ready.decision.ready
    decisionState = [string]$ready.decision.state
    qualificationValidationOperation = [string]$ready.qualificationValidationOperation
    qualificationAcceptanceState = [string]$ready.qualificationAcceptanceState
    qualificationDerived = [bool]$ready.nebulaClientSemantics.qualificationDerived
    topology = [string]$ready.nebulaClientSemantics.topology
    transport = [string]$ready.nebulaClientSemantics.transport
    port = [int]$ready.nebulaClientSemantics.port
    websocketPath = [string]$ready.nebulaClientSemantics.websocketPath
    authoritySemantics = [string]$ready.nebulaClientSemantics.authoritySemantics
    passWallDecision = [string]$ready.passWallBypassEvidence.decision
    rawPassWallEnumsAccepted = [bool]$ready.passWallBypassEvidence.rawPassWallEnumsAccepted
    productionChanged = [bool]$ready.productionChanged
    networkMutationImplemented = [bool]$ready.networkMutationImplemented
    findingCodes = @($ready.findings | ForEach-Object { [string]$_.code })
}
Assert-DysonNetworkV2SelfTest -Condition (
    [string]$ready.protocol -ceq 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2' -and
    [int]$ready.schemaVersion -eq 2 -and [bool]$ready.decision.ready -and
    [string]$ready.decision.state -ceq 'ready' -and
    [string]$ready.qualificationValidationOperation -ceq 'consume' -and
    [string]$ready.qualificationAcceptanceState -ceq 'consumed-or-idempotently-confirmed' -and
    [string]$ready.nebulaClientSemantics.topology -ceq 'http-websocket-tunnel' -and
    [string]$ready.nebulaClientSemantics.transport -ceq 'wss' -and
    [int]$ready.nebulaClientSemantics.port -eq 443 -and
    [string]$ready.nebulaClientSemantics.websocketPath -ceq '/socket' -and
    [string]$ready.nebulaClientSemantics.authoritySemantics -ceq 'hostname-preserved' -and
    [string]$ready.passWallBypassEvidence.decision -ceq 'receipt-chain-bound' -and
    -not [bool]$ready.passWallBypassEvidence.rawPassWallEnumsAccepted -and
    -not [bool]$ready.productionChanged -and -not [bool]$ready.networkMutationImplemented
) -Message ('qualified fixed semantics were not derived exclusively from the consumed projection: ' +
    ($qualifiedSemanticsDiagnostic | ConvertTo-Json -Depth 4 -Compress))
Assert-DysonNetworkV2SelfTest -Condition (
    [int]$calls.listener -eq 1 -and [int]$calls.dns -eq 1 -and
    [int]$calls.tcp -eq 1 -and [int]$calls.websocket -eq 1
) -Message 'ready scenario did not use exactly the injected read-only probe adapters'
Assert-DysonNetworkV2SelfTest -Condition ([bool]$calls.websocketArgumentsMatched) `
    -Message 'qualified hostname was not preserved into the WSS probe adapter'

$readyJson = ConvertTo-DysonNetworkV2Json -Value $ready
$systemDriveSentinel = ([string][char]67) + ([string][char]58) + ([string][char]92)
$userPathSentinel = ([string][char]92) + 'Users' + ([string][char]92)
foreach ($forbidden in @(
    'edge.example.com', '192.0.2.10', '2001:db8::10', 'BuildHarvestRootA',
    'KeyRingRoot', 'ReplayRoot', 'private-key', $systemDriveSentinel, $userPathSentinel
)) {
    Assert-DysonNetworkV2SelfTest -Condition (-not $readyJson.Contains($forbidden)) `
        -Message ('privacy projection emitted forbidden input: ' + $forbidden)
}

$noListenerCalls = @{ websocket = 0 }
$noListener = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
    -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
    -ManagementTransport https -LocalGamePort 8469 `
    -Qualification $qualified -NowUtc $now `
    -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener -State not-listening } `
    -DnsProbe $dnsProbe -TcpProbe $tcpProbe -WebSocketProbe {
        param($Address, $Authority, $Port)
        $noListenerCalls.websocket += 1
        return [pscustomobject]@{
            outcome = 'upgrade-accepted'; statusCode = 101; upgradeHeaderPresent = $true
            connectionHeaderUpgrade = $true; acceptHeaderPresent = $true; acceptHeaderValid = $true
            tlsCertificateValidated = $true
        }
    }.GetNewClosure() -AddressClassProbe $shadowPublicAddressClassProbe
$noListenerCodes = @($noListener.findings | ForEach-Object { [string]$_.code })
Assert-DysonNetworkV2SelfTest -Condition (
    -not [bool]$noListener.decision.ready -and
    $noListenerCodes -contains 'LOCAL_LISTENER_NOT_VERIFIED'
) -Message 'a qualified remote route became ready without a local listener'

$addressClassNegativeCases = 0
foreach ($badClass in @('private', 'link-local', 'documentation')) {
    $badClassProbe = { param([System.Net.IPAddress]$Address) return $badClass }.GetNewClosure()
    $badAddress = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
        -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
        -ManagementTransport https -LocalGamePort 8469 -Qualification $qualified -NowUtc $now `
        -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener } `
        -DnsProbe $dnsProbe -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe `
        -AddressClassProbe $badClassProbe
    $badCodes = @($badAddress.findings | ForEach-Object { [string]$_.code })
    Assert-DysonNetworkV2SelfTest -Condition (
        -not [bool]$badAddress.decision.ready -and
        $badCodes -contains 'GAME_DATA_SELECTED_ADDRESS_NOT_PUBLIC'
    ) -Message ('selected ' + $badClass + ' address became ready')
    $addressClassNegativeCases += 1
}
$literalStatusDnsProbe = {
    param([object]$Target)
    return [pscustomobject]@{
        status = 'literal-address'
        addresses = @([System.Net.IPAddress]::Parse('192.0.2.10'))
    }
}
$literalStatus = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
    -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
    -ManagementTransport https -LocalGamePort 8469 -Qualification $qualified -NowUtc $now `
    -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener } `
    -DnsProbe $literalStatusDnsProbe -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe `
    -AddressClassProbe $shadowPublicAddressClassProbe
$literalStatusCodes = @($literalStatus.findings | ForEach-Object { [string]$_.code })
Assert-DysonNetworkV2SelfTest -Condition (
    -not [bool]$literalStatus.decision.ready -and
    $literalStatusCodes -contains 'GAME_DATA_DNS_NOT_RESOLVED'
) -Message 'literal-address DNS observation became ready for a qualified hostname'
$addressClassNegativeCases += 1

$strictPublicUnicastCases = 0
foreach ($addressText in @(
    '10.0.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '0.0.0.0',
    '240.0.0.1',
    '255.255.255.255',
    '::ffff:192.168.1.10',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    'ff02::1',
    '::',
    '2001::1',
    '2002::1',
    '3fff::1'
)) {
    $strictAddress = [System.Net.IPAddress]::Parse($addressText)
    $strictClass = Get-DysonNetworkV2AddressClass -Address $strictAddress
    Assert-DysonNetworkV2SelfTest -Condition ($strictClass -cne 'public') `
        -Message ('special-use address was classified public: ' + $addressText)
    $strictDnsProbe = {
        param([object]$Target)
        return [pscustomobject]@{ status = 'resolved'; addresses = @($strictAddress) }
    }.GetNewClosure()
    $strictResult = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
        -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
        -ManagementTransport https -LocalGamePort 8469 -Qualification $qualified -NowUtc $now `
        -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener } `
        -DnsProbe $strictDnsProbe -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe `
        -AddressClassProbe { param([System.Net.IPAddress]$Address) Get-DysonNetworkV2AddressClass $Address }
    $strictCodes = @($strictResult.findings | ForEach-Object { [string]$_.code })
    Assert-DysonNetworkV2SelfTest -Condition (
        -not [bool]$strictResult.decision.ready -and
        $strictCodes -contains 'GAME_DATA_SELECTED_ADDRESS_NOT_PUBLIC'
    ) -Message ('special-use first DNS answer became ready: ' + $addressText)
    $strictPublicUnicastCases += 1
}

$stockCalls = @{ dns = 0; tcp = 0; websocket = 0 }
$stock = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
    -GameDataTarget $null -ManagementTarget $null -ManagementPort 443 `
    -ManagementTransport https -LocalGamePort 8469 `
    -Qualification (New-DysonNetworkV2StockQualification) -NowUtc $now `
    -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener } `
    -DnsProbe { param($Target) $stockCalls.dns += 1; throw 'unexpected' }.GetNewClosure() `
    -TcpProbe { param($Address, $Port) $stockCalls.tcp += 1; throw 'unexpected' }.GetNewClosure() `
    -WebSocketProbe { param($Address, $Authority, $Port) $stockCalls.websocket += 1; throw 'unexpected' }.GetNewClosure() `
    -AddressClassProbe $shadowPublicAddressClassProbe
$stockCodes = @($stock.findings | ForEach-Object { [string]$_.code })
Assert-DysonNetworkV2SelfTest -Condition (
    -not [bool]$stock.decision.ready -and
    $stockCodes -contains 'HOSTNAME_WSS_QUALIFICATION_REQUIRED' -and
    [string]$stock.nebulaClientSemantics.authoritySemantics -ceq 'resolved-ip-endpoint' -and
    [string]$stock.nebulaClientSemantics.transport -ceq 'not-qualified' -and
    [int]$stockCalls.dns -eq 0 -and [int]$stockCalls.tcp -eq 0 -and
    [int]$stockCalls.websocket -eq 0
) -Message 'stock Nebula semantics were not kept blocked without remote probing'

$previewProjection = New-DysonNetworkV2SelfTestProjection -Decision preview-valid `
    -BlockerCodes @('DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED')
$previewQualification = ConvertFrom-DysonNetworkV2QualificationProjection `
    -Projection $previewProjection -ExpectedQualificationId $qualificationId `
    -NowUtc $now -ValidationMode preview
$previewCalls = @{ dns = 0; tcp = 0; websocket = 0 }
$preview = Invoke-DysonNetworkAssessmentV2 -Mode shadow -RemoteProbesEnabled $true `
    -GameDataTarget $target -ManagementTarget $null -ManagementPort 443 `
    -ManagementTransport https -LocalGamePort 8469 `
    -Qualification $previewQualification -NowUtc $now `
    -LocalListenerProbe { param($Port, $Names) New-DysonNetworkV2SelfTestListener } `
    -DnsProbe { param($Target) $previewCalls.dns += 1; throw 'unexpected' }.GetNewClosure() `
    -TcpProbe { param($Address, $Port) $previewCalls.tcp += 1; throw 'unexpected' }.GetNewClosure() `
    -WebSocketProbe { param($Address, $Authority, $Port) $previewCalls.websocket += 1; throw 'unexpected' }.GetNewClosure() `
    -AddressClassProbe $shadowPublicAddressClassProbe
Assert-DysonNetworkV2SelfTest -Condition (
    -not [bool]$preview.decision.ready -and
    [string]$preview.qualificationAcceptanceState -ceq 'preview-only' -and
    [string]$preview.nebulaClientSemantics.transport -ceq 'not-qualified' -and
    [int]$previewCalls.dns -eq 0 -and [int]$previewCalls.tcp -eq 0 -and
    [int]$previewCalls.websocket -eq 0
) -Message 'preview produced qualified semantics or performed remote game probes'

$tamperedProjection = New-DysonNetworkV2SelfTestProjection
$tamperedProjection | Add-Member -NotePropertyName callerVerified -NotePropertyValue $true
Assert-DysonNetworkV2Rejected -Action {
    ConvertFrom-DysonNetworkV2QualificationProjection -Projection $tamperedProjection `
        -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
} -ExpectedCode 'DYSON_NETWORK_V2_INVALID_QUALIFICATION_PROJECTION_PROPERTIES' `
    -Message 'caller supplied verified/tampered projection was accepted'
$missingRunIdProjection = New-DysonNetworkV2SelfTestProjection
$missingRunIdProjection.PSObject.Properties.Remove('runId')
Assert-DysonNetworkV2Rejected -Action {
    ConvertFrom-DysonNetworkV2QualificationProjection -Projection $missingRunIdProjection `
        -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
} -ExpectedCode 'DYSON_NETWORK_V2_INVALID_QUALIFICATION_PROJECTION_PROPERTIES' `
    -Message 'projection missing runId was accepted'
$invalidRunIdProjection = New-DysonNetworkV2SelfTestProjection
$invalidRunIdProjection.runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbx'
Assert-DysonNetworkV2Rejected -Action {
    ConvertFrom-DysonNetworkV2QualificationProjection -Projection $invalidRunIdProjection `
        -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
} -ExpectedCode 'DYSON_NETWORK_V2_RUN_ID_INVALID' `
    -Message 'projection with invalid runId was accepted'
Assert-DysonNetworkV2Rejected -Action {
    ConvertFrom-DysonNetworkV2QualificationProjection `
        -Projection (New-DysonNetworkV2SelfTestProjection -Expiry '2029-12-31T23:59:59.999Z') `
        -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
} -ExpectedCode 'DYSON_NETWORK_V2_QUALIFICATION_STALE' `
    -Message 'stale qualification projection was accepted'
Assert-DysonNetworkV2Rejected -Action {
    ConvertFrom-DysonNetworkV2QualificationProjection `
        -Projection (New-DysonNetworkV2SelfTestProjection -Id '22222222-2222-4222-8222-222222222222') `
        -ExpectedQualificationId $qualificationId -NowUtc $now -ValidationMode consume
} -ExpectedCode 'DYSON_NETWORK_V2_QUALIFICATION_ID_MISMATCH' `
    -Message 'wrong qualification ID projection was accepted'

$commandParameters = (Get-Command -Name $testItem.FullName -CommandType ExternalScript).Parameters.Keys
foreach ($forbiddenParameter in @(
    'PassWallEvidencePath', 'ExpectedRoute', 'ActualRouteClass', 'Verified', 'Qualified',
    'ExpectedProcessNames'
)) {
    Assert-DysonNetworkV2SelfTest -Condition ($commandParameters -notcontains $forbiddenParameter) `
        -Message ('production CLI accepts forbidden caller assertion: ' + $forbiddenParameter)
}
$verifierParameters = (Get-Command -Name $hostnameVerifierItem.FullName `
    -CommandType ExternalScript).Parameters.Keys
foreach ($requiredVerifierParameter in @(
    'EvidenceRoot', 'BuildHarvestRootA', 'BuildHarvestRootB', 'KeyRingRoot',
    'ReplayRoot', 'ExpectedQualificationId', 'ExpectedAuthority', 'ExpectedPort',
    'Consume', 'Confirmation'
)) {
    Assert-DysonNetworkV2SelfTest -Condition (
        $verifierParameters -contains $requiredVerifierParameter
    ) -Message ('fixed protected verifier parameter missing: ' + $requiredVerifierParameter)
}

if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
    throw 'DYSON_NETWORK_V2_SELFTEST_FAILED: TEMP must point to a workspace-owned non-system cache root'
}
$tempBase = [System.IO.Path]::GetFullPath($env:TEMP)
$selfTestRoot = Join-Path $tempBase ('network-v2-selftest-' + [guid]::NewGuid().ToString('N'))
$resolvedSelfTestRoot = [System.IO.Path]::GetFullPath($selfTestRoot)
if (-not $resolvedSelfTestRoot.StartsWith(
    $tempBase.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
)) { throw 'DYSON_NETWORK_V2_SELFTEST_FAILED: isolated root escaped TEMP' }

$fixedBoundaryCases = 0
try {
    [void](New-Item -ItemType Directory -Path $resolvedSelfTestRoot -Force)
    foreach ($sourceItem in @($commonItem, $testItem, $v1CommonItem)) {
        Copy-Item -LiteralPath $sourceItem.FullName -Destination (Join-Path $resolvedSelfTestRoot $sourceItem.Name)
    }
    $probeOverrides = @'

function global:Invoke-DysonNetworkV2FixtureLocalListener {
    param([int]$Port, [string[]]$ExpectedProcessNames)
    return [pscustomobject][ordered]@{
        state = 'listening'; bindingCount = 1
        bindingClassCounts = New-DysonNetworkAddressClassCounts
        processIdentity = [pscustomobject][ordered]@{
            state = 'matched'; observedProcessCount = 1; observedProcessNames = @('DSPGAME')
            expectedNameMatched = $true; singleOwner = $true
            executablePathsEmitted = $false; processIdsEmitted = $false
        }
    }
}
function global:Invoke-DysonNetworkV2FixtureDns {
    param([object]$Target)
    return [pscustomobject]@{
        status = 'resolved'
        addresses = @([System.Net.IPAddress]::Parse('192.0.2.10'))
    }
}
function global:Invoke-DysonNetworkV2FixtureTcp {
    param([System.Net.IPAddress]$Address, [int]$Port, [int]$TimeoutMilliseconds)
    return [pscustomobject]@{ outcome = 'reachable' }
}
function global:Invoke-DysonNetworkV2FixtureWebSocket {
    param([System.Net.IPAddress]$Address, [string]$Authority, [int]$Port, [int]$TimeoutMilliseconds)
    if ($Authority -cne 'edge.example.com' -or $Port -ne 443) {
        throw 'DYSON_NETWORK_V2_SELFTEST_PROBE_BINDING_INVALID'
    }
    return [pscustomobject]@{
        outcome = 'upgrade-accepted'; statusCode = 101; upgradeHeaderPresent = $true
        connectionHeaderUpgrade = $true; acceptHeaderPresent = $true; acceptHeaderValid = $true
        tlsCertificateValidated = $true
    }
}
function global:Invoke-DysonNetworkV2FixtureAddressClass {
    param([System.Net.IPAddress]$Address)
    if ($Address.ToString() -ceq '192.0.2.10') { return 'public' }
    return 'unknown'
}
'@
    $copiedTestWithOverrides = Join-Path $resolvedSelfTestRoot $testItem.Name
    $copiedTestText = [System.IO.File]::ReadAllText($copiedTestWithOverrides)
    foreach ($replacement in @(
        @('Get-DysonLocalListenerObservation', 'Invoke-DysonNetworkV2FixtureLocalListener'),
        @('Get-DysonRawDnsObservation', 'Invoke-DysonNetworkV2FixtureDns'),
        @('Get-DysonRawTcpObservation', 'Invoke-DysonNetworkV2FixtureTcp'),
        @('Get-DysonRawHostnamePreservedWebSocketObservationV2', 'Invoke-DysonNetworkV2FixtureWebSocket'),
        @('Get-DysonNetworkV2AddressClass', 'Invoke-DysonNetworkV2FixtureAddressClass')
    )) {
        $copiedTestText = $copiedTestText.Replace([string]$replacement[0], [string]$replacement[1])
    }
    $overrideMarker = '. $commonItem.FullName'
    Assert-DysonNetworkV2SelfTest -Condition (
        $copiedTestText.IndexOf($overrideMarker, [System.StringComparison]::Ordinal) -ge 0
    ) -Message 'fixed wrapper injection marker unavailable'
    $copiedTestText = $copiedTestText.Replace(
        $overrideMarker,
        $overrideMarker + $probeOverrides
    )
    [System.IO.File]::WriteAllText(
        $copiedTestWithOverrides,
        $copiedTestText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $verifierScript = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string]$BuildHarvestRootA,
    [Parameter(Mandatory)][string]$BuildHarvestRootB,
    [Parameter(Mandatory)][string]$KeyRingRoot,
    [Parameter(Mandatory)][string]$ReplayRoot,
    [Parameter(Mandatory)][string]$ExpectedQualificationId,
    [Parameter(Mandatory)][string]$ExpectedAuthority,
    [Parameter(Mandatory)][ValidateRange(443,443)][int]$ExpectedPort,
    [switch]$Consume,
    [AllowEmptyString()][string]$Confirmation = ''
)
$mode = [System.IO.File]::ReadAllText((Join-Path $EvidenceRoot 'mode-v2.txt')).Trim()
if ($ExpectedAuthority -cne 'edge.example.com' -or $ExpectedPort -ne 443) {
    throw 'DYSON_HOSTNAME_WSS_EXPECTED_AUTHORITY_MISMATCH'
}
if ($Consume -and $Confirmation -cne 'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1') {
    throw 'DYSON_HOSTNAME_WSS_CONSUME_CONFIRMATION_INVALID'
}
if ($mode -ceq 'replay-conflict') { throw 'DYSON_HOSTNAME_WSS_QUALIFICATION_REPLAY_CONFLICT' }
$id = if ($mode -ceq 'wrong-id') { '22222222-2222-4222-8222-222222222222' } else { $ExpectedQualificationId }
$expiry = if ($mode -ceq 'stale') { '2000-01-01T00:00:00.000Z' } else { '2099-01-01T00:00:00.000Z' }
$decision = if ($Consume) { 'qualified' } else { 'preview-valid' }
$blockers = if ($Consume) { @() } else { @('DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED') }
$result = [pscustomobject][ordered]@{
    qualificationId = $id
    runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    bindingSha256 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expiresAtUtc = $expiry
    decision = $decision
    blockerCodes = @($blockers)
}
if ($mode -ceq 'tamper') { $result | Add-Member callerVerified $true }
$result | ConvertTo-Json -Depth 4 -Compress
if ($decision -ceq 'qualified') { exit 0 }
if ($decision -ceq 'preview-valid') { exit 3 }
exit 2
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $resolvedSelfTestRoot 'Test-DysonHostnameWssQualification.ps1'),
        $verifierScript,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $evidenceRoot = Join-Path $resolvedSelfTestRoot 'evidence-v2'
    $harvestA = Join-Path $resolvedSelfTestRoot 'harvest-a-v2'
    $harvestB = Join-Path $resolvedSelfTestRoot 'harvest-b-v2'
    $keyRoot = Join-Path $resolvedSelfTestRoot 'keys-v2'
    $replayRoot = Join-Path $resolvedSelfTestRoot 'replay-v2'
    foreach ($directory in @($evidenceRoot, $harvestA, $harvestB, $keyRoot, $replayRoot)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    $modePath = Join-Path $evidenceRoot 'mode-v2.txt'
    $copiedTest = Join-Path $resolvedSelfTestRoot $testItem.Name
    $baseArguments = @{
        QualificationId = $qualificationId
        EvidenceRoot = $evidenceRoot
        BuildHarvestRootA = $harvestA
        BuildHarvestRootB = $harvestB
        KeyRingRoot = $keyRoot
        ReplayRoot = $replayRoot
        GameDataHost = 'edge.example.com'
        LocalGamePort = 65002
    }

    $consumeWithoutRemote = @{} + $baseArguments
    $consumeWithoutRemote['QualificationMode'] = 'CONSUME'
    $consumeWithoutRemote['QualificationConsumeConfirmation'] = 'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1'
    Assert-DysonNetworkV2Rejected -Action { & $copiedTest @consumeWithoutRemote } `
        -ExpectedCode 'DYSON_NETWORK_V2_CONSUME_REQUIRES_REMOTE_PROBES' `
        -Message 'consume ran without the required remote probe gate'
    $fixedBoundaryCases += 1
    $baseArguments['EnableRemoteProbes'] = $true
    $baseArguments['RemoteProbeConfirmation'] = 'I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES'

    foreach ($case in @(
        [pscustomobject]@{ mode = 'tamper'; code = 'DYSON_NETWORK_V2_INVALID_QUALIFICATION_PROJECTION_PROPERTIES' },
        [pscustomobject]@{ mode = 'stale'; code = 'DYSON_NETWORK_V2_QUALIFICATION_STALE' },
        [pscustomobject]@{ mode = 'wrong-id'; code = 'DYSON_NETWORK_V2_QUALIFICATION_ID_MISMATCH' },
        [pscustomobject]@{ mode = 'replay-conflict'; code = 'DYSON_HOSTNAME_WSS_QUALIFICATION_REPLAY_CONFLICT' }
    )) {
        [System.IO.File]::WriteAllText($modePath, [string]$case.mode)
        $arguments = @{} + $baseArguments
        $arguments['QualificationMode'] = 'consume'
        $arguments['QualificationConsumeConfirmation'] = 'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1'
        Assert-DysonNetworkV2Rejected -Action { & $copiedTest @arguments } `
            -ExpectedCode ([string]$case.code) `
            -Message ('fixed verifier boundary did not reject ' + [string]$case.mode)
        $fixedBoundaryCases += 1
    }

    [System.IO.File]::WriteAllText($modePath, 'valid-consume')
    $consumeArguments = @{} + $baseArguments
    $consumeArguments['QualificationMode'] = 'consume'
    $consumeArguments['QualificationConsumeConfirmation'] = 'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1'
    $consumeOutput = [string]::Join("`n", @(& $copiedTest @consumeArguments)) | ConvertFrom-Json
    Assert-DysonNetworkV2SelfTest -Condition (
        [string]$consumeOutput.qualification.decision -ceq 'qualified' -and
        [string]$consumeOutput.qualificationValidationOperation -ceq 'consume' -and
        [string]$consumeOutput.qualificationAcceptanceState -ceq 'consumed-or-idempotently-confirmed' -and
        [bool]$consumeOutput.decision.ready -and
        [string]$consumeOutput.decision.state -ceq 'ready'
    ) -Message ('fixed verifier consume projection did not use the bounded probe adapters: state=' +
        [string]$consumeOutput.decision.state + ', blockers=' +
        [string]::Join(',', @($consumeOutput.findings | ForEach-Object { [string]$_.code })))
    $consumeJson = $consumeOutput | ConvertTo-Json -Depth 20 -Compress
    foreach ($privateValue in @(
        $resolvedSelfTestRoot, $evidenceRoot, $harvestA, $harvestB, $keyRoot, $replayRoot,
        'edge.example.com', '192.0.2.10'
    )) {
        Assert-DysonNetworkV2SelfTest -Condition (-not $consumeJson.Contains([string]$privateValue)) `
            -Message 'fixed verifier wrapper emitted a private root, authority or address'
    }
    $fixedBoundaryCases += 1

    [System.IO.File]::WriteAllText($modePath, 'valid-preview')
    $previewArguments = @{} + $baseArguments
    $previewArguments['QualificationMode'] = 'preview'
    $previewOutput = [string]::Join("`n", @(& $copiedTest @previewArguments)) | ConvertFrom-Json
    Assert-DysonNetworkV2SelfTest -Condition (
        [string]$previewOutput.qualification.decision -ceq 'preview-valid' -and
        [string]$previewOutput.qualificationValidationOperation -ceq 'preview' -and
        [string]$previewOutput.qualificationAcceptanceState -ceq 'preview-only' -and
        -not [bool]$previewOutput.decision.ready
    ) -Message 'fixed verifier preview was treated as consumed or ready'
    $fixedBoundaryCases += 1

    $canonicalOutput = [string]::Join("`n", @(
        & $copiedTest -QualificationMode STOCK -ManagementTransport HTTPS
    )) | ConvertFrom-Json
    Assert-DysonNetworkV2SelfTest -Condition (
        [string]$canonicalOutput.qualification.validationMode -ceq 'stock' -and
        [string]$canonicalOutput.planes.management.transport -ceq 'https'
    ) -Message 'case-insensitive CLI enum input was emitted without canonicalization'
}
finally {
    if (Test-Path -LiteralPath $resolvedSelfTestRoot) {
        $actual = [System.IO.Path]::GetFullPath($resolvedSelfTestRoot)
        if (-not $actual.StartsWith(
            $tempBase.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )) { throw 'DYSON_NETWORK_V2_SELFTEST_FAILED: cleanup target escaped TEMP' }
        Remove-Item -LiteralPath $actual -Recurse -Force
    }
}

try { $schema = [System.IO.File]::ReadAllText($schemaItem.FullName) | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'DYSON_NETWORK_V2_SELFTEST_FAILED: v2 schema JSON invalid' }
Assert-DysonNetworkV2SelfTest -Condition (
    [string]$schema.title -ceq 'Dyson Nebula network assessment v2' -and
    [bool]$schema.additionalProperties -eq $false -and @($schema.required).Count -eq 18 -and
    @($schema.allOf).Count -ge 10 -and
    @($schema.'$defs'.qualification.allOf).Count -ge 4 -and
    @($schema.'$defs'.passWallEvidence.allOf).Count -ge 1 -and
    @($schema.'$defs'.decision.allOf).Count -ge 3
) -Message 'versioned v2 schema root contract drifted'
$schemaGateText = $schema.allOf | ConvertTo-Json -Depth 20 -Compress
foreach ($requiredGate in @(
    '#/$defs/stockState', '#/$defs/previewState', '#/$defs/blockedState',
    '#/$defs/qualifiedState', '#/$defs/readyEvidenceState',
    'qualificationDerived', 'qualificationBound', 'consumed-or-idempotently-confirmed'
)) {
    Assert-DysonNetworkV2SelfTest -Condition ($schemaGateText.Contains($requiredGate)) `
        -Message ('schema consistency gate missing: ' + $requiredGate)
}

foreach ($item in @($v1CommonItem, $v1TestItem, $v1SelfTestItem, $v1SchemaItem)) {
    $after = Get-DysonNetworkV2SelfTestFileSha256 -Path $item.FullName
    Assert-DysonNetworkV2SelfTest -Condition (
        [string]$after -ceq [string]$v1DigestsBefore[$item.Name]
    ) -Message ('v1 file changed during v2 self-test: ' + $item.Name)
}

[ordered]@{
    protocol = 'DYSON_NEBULA_NETWORK_V2_SELFTEST_V1'
    state = 'passed'
    assessmentProtocol = 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2'
    assessmentSchemaVersion = 2
    readyScenario = $true
    stockBlocked = $true
    previewBlocked = $true
    noListenerBlocked = $true
    nonPublicAddressCasesBlocked = $addressClassNegativeCases
    strictPublicUnicastCasesBlocked = $strictPublicUnicastCases
    tamperRejected = $true
    staleRejected = $true
    wrongIdRejected = $true
    replayConflictRejected = $true
    fixedVerifierBoundaryCases = $fixedBoundaryCases
    rawPassWallEnumsAccepted = $false
    callerQualifiedBooleanAccepted = $false
    outputPrivacyValidated = $true
    schemaConsistencyGatesValidated = $true
    v1FilesUnchangedDuringSelfTest = $true
    productionChanged = $false
    networkMutationImplemented = $false
} | ConvertTo-Json -Depth 5 -Compress
