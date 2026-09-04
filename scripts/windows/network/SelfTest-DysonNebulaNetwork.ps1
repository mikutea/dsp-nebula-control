[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$commonPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'DysonNetwork.Common.ps1'))
try {
    $scriptRootItem = Get-Item -LiteralPath $PSScriptRoot -Force -ErrorAction Stop
    $commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
}
catch { throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixed dependency unavailable' }
if (-not $scriptRootItem.PSIsContainer -or
    ($scriptRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixed dependency redirected'
}
. $commonItem.FullName

function Assert-NetworkShadow {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('NETWORK_SHADOW_SELFTEST_FAILED: ' + $Message) }
}

function Assert-NetworkShadowRejected {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$Message)
    $rejected = $false
    try { & $Action | Out-Null }
    catch { $rejected = $true }
    Assert-NetworkShadow -Condition $rejected -Message $Message
}

function Assert-NetworkShadowProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Message
    )

    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    Assert-NetworkShadow -Condition ([string]::Equals(
        [string]::Join("`n", $actual),
        [string]::Join("`n", $wanted),
        [System.StringComparison]::Ordinal
    )) -Message $Message
}

function Read-NetworkShadowFixture {
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]{1,96}\.json$')][string]$Name)

    $fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'fixtures')).TrimEnd('\', '/')
    $fixturePath = [System.IO.Path]::GetFullPath((Join-Path $fixtureRoot $Name))
    if (-not $fixturePath.StartsWith(
        $fixtureRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) { throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixture escaped the fixed root' }
    try { $item = Get-Item -LiteralPath $fixturePath -Force -ErrorAction Stop }
    catch { throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixture unavailable' }
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixture redirected'
    }
    try { return ([System.IO.File]::ReadAllText($fixturePath) | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixture JSON invalid' }
}

function ConvertTo-NetworkShadowAddresses {
    param([Parameter(Mandatory)][object[]]$Values)

    [System.Net.IPAddress[]]$addresses = @()
    foreach ($value in $Values) {
        $address = $null
        if (-not [System.Net.IPAddress]::TryParse([string]$value, [ref]$address)) {
            throw 'NETWORK_SHADOW_SELFTEST_FAILED: fixture address invalid'
        }
        $addresses += $address
    }
    return $addresses
}

function Assert-NetworkAssessmentSchema {
    param([Parameter(Mandatory)][object]$Value)

    Assert-NetworkShadowProperties $Value @(
        'protocol', 'schemaVersion', 'mode', 'generatedAt', 'productionChanged',
        'remoteProbeEnabled', 'mutationImplemented', 'mutationAuthorized', 'privacy',
        'nebulaClientSemantics', 'localListener', 'planes', 'passWallBypassEvidence',
        'decision', 'findings'
    ) 'top-level assessment schema drifted'
    Assert-NetworkShadowProperties $Value.privacy @(
        'targetValuesEmitted', 'addressesEmitted', 'pathsEmitted', 'credentialsAccepted',
        'processIdsEmitted', 'executablePathsEmitted'
    ) 'privacy schema drifted'
    Assert-NetworkShadowProperties $Value.nebulaClientSemantics @(
        'sourceContract', 'protocolWithoutPrefix', 'recognizedPrefixes',
        'missingPortUsesConfiguredHostPort', 'hostnameResolution', 'websocketAuthority',
        'websocketPath', 'wssHostnameRouteReadyByPrefixOnly'
    ) 'Nebula client-semantics schema drifted'
    Assert-NetworkShadowProperties $Value.localListener @(
        'state', 'bindingCount', 'bindingClassCounts', 'processIdentity'
    ) 'listener schema drifted'
    Assert-NetworkShadowProperties $Value.localListener.bindingClassCounts @(
        'loopback', 'private', 'documentation', 'link-local', 'public', 'unspecified',
        'multicast', 'unknown'
    ) 'listener address-class schema drifted'
    Assert-NetworkShadowProperties $Value.localListener.processIdentity @(
        'state', 'observedProcessCount', 'observedProcessNames', 'expectedNameMatched',
        'singleOwner', 'executablePathsEmitted', 'processIdsEmitted'
    ) 'process-identity schema drifted'
    Assert-NetworkShadowProperties $Value.planes @(
        'logicalRolesSeparated', 'sameAuthority', 'management', 'gameData'
    ) 'plane container schema drifted'
    foreach ($plane in @($Value.planes.management, $Value.planes.gameData)) {
        Assert-NetworkShadowProperties $plane @(
            'role', 'configured', 'targetRef', 'targetKind', 'targetValueEmitted', 'port',
            'transport', 'dns', 'tcp', 'websocket'
        ) 'plane schema drifted'
        Assert-NetworkShadowProperties $plane.dns @(
            'status', 'addressCount', 'ipv4Count', 'ipv6Count', 'addressClassCounts',
            'clientSelectionSemantics', 'selectedFirstClass', 'selectedFirstFamily',
            'rawAnswersEmitted'
        ) 'DNS schema drifted'
        Assert-NetworkShadowProperties $plane.dns.addressClassCounts @(
            'loopback', 'private', 'documentation', 'link-local', 'public', 'unspecified',
            'multicast', 'unknown'
        ) 'DNS address-class schema drifted'
        Assert-NetworkShadowProperties $plane.tcp @('outcome', 'endpointEmitted') 'TCP schema drifted'
        Assert-NetworkShadowProperties $plane.websocket @(
            'path', 'outcome', 'statusCode', 'upgradeHeaderPresent',
            'connectionHeaderUpgrade', 'acceptHeaderPresent', 'acceptHeaderValid',
            'tlsCertificateValidated', 'authoritySemantics', 'responseHeadersEmitted'
        ) 'WebSocket schema drifted'
    }
    Assert-NetworkShadowProperties $Value.passWallBypassEvidence @(
        'requiredForAcceptance', 'expectedRoute', 'ruleRendered', 'ruleValidated',
        'ruleActive', 'realFlowCounterDelta', 'selectedDestinationClass',
        'actualIngressInterfaceClass', 'actualRouteClass', 'externalPathWitness',
        'rawRuleTextEmitted', 'rawInterfaceNameEmitted', 'decision'
    ) 'PassWall evidence schema drifted'
    Assert-NetworkShadowProperties $Value.decision @(
        'state', 'ready', 'blockerCount', 'findingCount'
    ) 'decision schema drifted'
    foreach ($finding in @($Value.findings)) {
        Assert-NetworkShadowProperties $finding @('code', 'severity', 'plane') 'finding schema drifted'
    }
}

function Assert-NetworkOutputPrivate {
    param(
        [Parameter(Mandatory)][string]$Json,
        [Parameter(Mandatory)][object]$Fixture
    )

    $needles = New-Object 'System.Collections.Generic.List[string]'
    foreach ($value in @($Fixture.gameData.target, $Fixture.management.target)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) { [void]$needles.Add([string]$value) }
    }
    foreach ($value in @($Fixture.gameData.addresses) + @($Fixture.management.addresses)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) { [void]$needles.Add([string]$value) }
    }
    foreach ($value in @($Fixture.localListener.bindingAddresses)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) { [void]$needles.Add([string]$value) }
    }
    [void]$needles.Add($PSScriptRoot)
    foreach ($needle in $needles) {
        Assert-NetworkShadow -Condition ($Json.IndexOf(
            $needle,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -lt 0) -Message 'public JSON disclosed a raw target, address, or host path'
    }
    Assert-NetworkShadow -Condition ($Json -notmatch '"(?:pid|processId|executablePath|targetHost|rawAddress|credential|password|secret|token)"\s*:') `
        -Message 'public JSON added a forbidden sensitive field'
}

function Invoke-NetworkShadowFixture {
    param([Parameter(Mandatory)][object]$Fixture)

    Assert-NetworkShadowProperties $Fixture @(
        'protocol', 'schemaVersion', 'gameData', 'management', 'localListener',
        'passWallEvidence', 'expectedState', 'expectedFinding'
    ) 'assessment fixture schema drifted'
    Assert-NetworkShadowProperties $Fixture.gameData @(
        'target', 'port', 'transport', 'dnsStatus', 'addresses', 'tcpOutcome',
        'websocketOutcome', 'websocketStatusCode'
    ) 'game-data fixture schema drifted'
    Assert-NetworkShadowProperties $Fixture.management @(
        'target', 'port', 'transport', 'dnsStatus', 'addresses', 'tcpOutcome'
    ) 'management fixture schema drifted'
    Assert-NetworkShadowProperties $Fixture.localListener @(
        'state', 'bindingAddresses', 'processNames', 'processCount', 'identityState'
    ) 'listener fixture schema drifted'

    $gameTarget = Resolve-DysonNetworkTarget -Value ([string]$Fixture.gameData.target)
    $managementTarget = Resolve-DysonNetworkTarget -Value ([string]$Fixture.management.target)
    $gameAddresses = @(ConvertTo-NetworkShadowAddresses -Values @($Fixture.gameData.addresses))
    $managementAddresses = @(ConvertTo-NetworkShadowAddresses -Values @($Fixture.management.addresses))
    $bindingAddresses = @(ConvertTo-NetworkShadowAddresses -Values @($Fixture.localListener.bindingAddresses))
    $bindingClassCounts = New-DysonNetworkAddressClassCounts -Addresses $bindingAddresses
    $passWall = ConvertTo-DysonValidatedPassWallEvidence -Raw $Fixture.passWallEvidence
    $calls = [ordered]@{ localListener = 0; dns = 0; tcp = 0; websocket = 0 }

    $localListenerProbe = {
        param([int]$Port, [string[]]$ExpectedNames)
        $calls.localListener += 1
        $observedNames = @($Fixture.localListener.processNames)
        return [pscustomobject][ordered]@{
            state = [string]$Fixture.localListener.state
            bindingCount = [int]$bindingAddresses.Count
            bindingClassCounts = $bindingClassCounts
            processIdentity = [pscustomobject][ordered]@{
                state = [string]$Fixture.localListener.identityState
                observedProcessCount = [int]$Fixture.localListener.processCount
                observedProcessNames = $observedNames
                expectedNameMatched = ([string]$Fixture.localListener.identityState -ceq 'matched')
                singleOwner = ([int]$Fixture.localListener.processCount -eq 1)
                executablePathsEmitted = $false
                processIdsEmitted = $false
            }
        }
    }.GetNewClosure()
    $dnsProbe = {
        param([object]$Target)
        $calls.dns += 1
        if ([string]::Equals(
            [string]$Target.value,
            [string]$gameTarget.value,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return [pscustomobject]@{
                status = [string]$Fixture.gameData.dnsStatus
                addresses = @($gameAddresses)
            }
        }
        return [pscustomobject]@{
            status = [string]$Fixture.management.dnsStatus
            addresses = @($managementAddresses)
        }
    }.GetNewClosure()
    $tcpProbe = {
        param([System.Net.IPAddress]$Address, [int]$Port)
        $calls.tcp += 1
        if ($Port -eq [int]$Fixture.gameData.port) {
            return [pscustomobject]@{ outcome = [string]$Fixture.gameData.tcpOutcome }
        }
        return [pscustomobject]@{ outcome = [string]$Fixture.management.tcpOutcome }
    }.GetNewClosure()
    $webSocketProbe = {
        param([System.Net.IPAddress]$Address, [int]$Port, [string]$Transport)
        $calls.websocket += 1
        $accepted = [string]$Fixture.gameData.websocketOutcome -ceq 'upgrade-accepted'
        return [pscustomobject]@{
            outcome = [string]$Fixture.gameData.websocketOutcome
            statusCode = if ($null -eq $Fixture.gameData.websocketStatusCode) {
                $null
            }
            else { [int]$Fixture.gameData.websocketStatusCode }
            upgradeHeaderPresent = $accepted
            connectionHeaderUpgrade = $accepted
            acceptHeaderPresent = $accepted
            acceptHeaderValid = $accepted
            tlsCertificateValidated = ($Transport -ceq 'wss' -and $accepted)
        }
    }.GetNewClosure()

    $result = Invoke-DysonNetworkAssessment -Mode 'shadow' -RemoteProbesEnabled $true `
        -GameDataTarget $gameTarget -GameDataPort ([int]$Fixture.gameData.port) `
        -GameDataTransport ([string]$Fixture.gameData.transport) -ManagementTarget $managementTarget `
        -ManagementPort ([int]$Fixture.management.port) `
        -ManagementTransport ([string]$Fixture.management.transport) `
        -ExpectedProcessNames @('DSPGAME') -PassWallEvidence $passWall `
        -LocalListenerProbe $localListenerProbe -DnsProbe $dnsProbe -TcpProbe $tcpProbe `
        -WebSocketProbe $webSocketProbe
    return [pscustomobject]@{ result = $result; calls = [pscustomobject]$calls }
}

function Get-ShadowFixtureWithExpectedFinding {
    param([Parameter(Mandatory)][object]$Fixture)

    if ($Fixture.PSObject.Properties.Name -notcontains 'expectedFinding') {
        Add-Member -InputObject $Fixture -MemberType NoteProperty -Name expectedFinding -Value $null
    }
    return $Fixture
}

$readyFixture = Get-ShadowFixtureWithExpectedFinding (
    Read-NetworkShadowFixture -Name 'shadow-ready-direct-ws.json'
)
$wssFixture = Get-ShadowFixtureWithExpectedFinding (
    Read-NetworkShadowFixture -Name 'shadow-wss-hostname-boundary.json'
)
$classificationFixture = Read-NetworkShadowFixture -Name 'shadow-websocket-classification.json'

$readyRun = Invoke-NetworkShadowFixture -Fixture $readyFixture
Assert-NetworkAssessmentSchema -Value $readyRun.result
Assert-NetworkShadow -Condition ([string]$readyRun.result.decision.state -ceq [string]$readyFixture.expectedState -and
    [bool]$readyRun.result.decision.ready) -Message 'healthy direct ws fixture was not ready'
Assert-NetworkShadow -Condition ([int]$readyRun.calls.localListener -eq 1 -and
    [int]$readyRun.calls.dns -eq 2 -and [int]$readyRun.calls.tcp -eq 2 -and
    [int]$readyRun.calls.websocket -eq 1) -Message 'healthy fixture did not use only the injected probe adapters'
Assert-NetworkShadow -Condition ([int]$readyRun.result.planes.gameData.dns.addressCount -eq 2 -and
    [int]$readyRun.result.planes.gameData.dns.ipv4Count -eq 1 -and
    [int]$readyRun.result.planes.gameData.dns.ipv6Count -eq 1 -and
    [string]$readyRun.result.planes.gameData.dns.selectedFirstClass -ceq 'documentation' -and
    [string]$readyRun.result.planes.gameData.dns.clientSelectionSemantics -ceq 'first-address-only') `
    -Message 'DNS all-answer counts or Nebula first-address semantics drifted'
Assert-NetworkShadow -Condition ([string]$readyRun.result.passWallBypassEvidence.decision -ceq 'verified' -and
    [string]$readyRun.result.passWallBypassEvidence.actualIngressInterfaceClass -ceq 'lan' -and
    [string]$readyRun.result.passWallBypassEvidence.externalPathWitness -ceq 'verified') `
    -Message 'complete PassWall direct-path evidence was not verified'
$readyJson = ConvertTo-DysonNetworkJson $readyRun.result
Assert-NetworkOutputPrivate -Json $readyJson -Fixture $readyFixture

$wssRun = Invoke-NetworkShadowFixture -Fixture $wssFixture
Assert-NetworkAssessmentSchema -Value $wssRun.result
$wssFindingCodes = @($wssRun.result.findings | ForEach-Object { [string]$_.code })
Assert-NetworkShadow -Condition ([string]$wssRun.result.decision.state -ceq [string]$wssFixture.expectedState -and
    -not [bool]$wssRun.result.decision.ready -and
    $wssFindingCodes -contains [string]$wssFixture.expectedFinding -and
    [string]$wssRun.result.planes.gameData.websocket.outcome -ceq 'upgrade-accepted') `
    -Message 'wss hostname routing was accepted merely because the prefix and 101 response existed'
Assert-NetworkShadow -Condition ([bool]$wssRun.result.planes.sameAuthority -and
    [bool]$wssRun.result.planes.logicalRolesSeparated -and
    [string]$wssRun.result.planes.management.websocket.outcome -ceq 'not-applicable') `
    -Message 'management and game data planes were conflated'
$wssJson = ConvertTo-DysonNetworkJson $wssRun.result
Assert-NetworkOutputPrivate -Json $wssJson -Fixture $wssFixture

Assert-NetworkShadowProperties $classificationFixture @(
    'protocol', 'schemaVersion', 'cases', 'passthroughOutcomes'
) 'WebSocket classification fixture schema drifted'
foreach ($case in @($classificationFixture.cases)) {
    Assert-NetworkShadowProperties $case @('name', 'response', 'expectedOutcome') `
        'WebSocket classification case schema drifted'
    $classification = ConvertFrom-DysonWebSocketHttpResponse -Response ([string]$case.response) `
        -ExpectedAccept 'fixture-value' -TlsCertificateValidated $false
    Assert-NetworkShadow -Condition ([string]$classification.outcome -ceq [string]$case.expectedOutcome) `
        -Message ('WebSocket classification failed for ' + [string]$case.name)
    if ([string]$case.name -ceq 'upgrade-accepted') {
        Assert-NetworkShadow -Condition ([bool]$classification.acceptHeaderValid) `
            -Message 'matching Sec-WebSocket-Accept was not validated'
    }
    if ([string]$case.name -ceq 'mismatched-accept') {
        Assert-NetworkShadow -Condition (-not [bool]$classification.acceptHeaderValid) `
            -Message 'mismatched Sec-WebSocket-Accept was accepted'
    }
}
foreach ($outcome in @($classificationFixture.passthroughOutcomes)) {
    $public = New-DysonPublicWebSocketObservation ([pscustomobject]@{
        outcome = [string]$outcome
        statusCode = $null
        upgradeHeaderPresent = $false
        connectionHeaderUpgrade = $false
        acceptHeaderPresent = $false
        acceptHeaderValid = $false
        tlsCertificateValidated = $false
    })
    Assert-NetworkShadow -Condition ([string]$public.outcome -ceq [string]$outcome) `
        -Message ('WebSocket passthrough classification failed for ' + [string]$outcome)
}

$incompletePassWall = New-DysonPassWallEvidence -ExpectedRoute direct
Assert-NetworkShadow -Condition ([string]$incompletePassWall.decision -ceq 'insufficient-evidence' -and
    [string]$incompletePassWall.ruleRendered -ceq 'not-observed' -and
    [string]$incompletePassWall.realFlowCounterDelta -ceq 'not-observed' -and
    [string]$incompletePassWall.actualIngressInterfaceClass -ceq 'unknown' -and
    [string]$incompletePassWall.externalPathWitness -ceq 'not-observed') `
    -Message 'missing PassWall evidence did not fail closed'

Assert-NetworkShadowRejected {
    Assert-DysonNetworkRemoteProbeGate -Enabled $true -Confirmation ''
} 'remote probes were enabled without exact confirmation'
Assert-NetworkShadowRejected {
    Assert-DysonNetworkRemoteProbeGate -Enabled $false `
        -Confirmation 'I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES'
} 'a stale confirmation was accepted while remote probes were disabled'
Assert-DysonNetworkRemoteProbeGate -Enabled $true `
    -Confirmation 'I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES'
Assert-NetworkShadowRejected {
    Assert-DysonNetworkMutationDenied -Requested $true -Confirmation ''
} 'mutation was accepted without exact confirmation'
Assert-NetworkShadowRejected {
    Assert-DysonNetworkMutationDenied -Requested $true `
        -Confirmation 'I_CONFIRM_NETWORK_MUTATION_IS_NOT_IMPLEMENTED'
} 'mutation was implemented despite the permanent fail-closed boundary'

$schemaPath = Join-Path $PSScriptRoot 'dyson-nebula-network-assessment-v1.schema.json'
try { $schema = [System.IO.File]::ReadAllText($schemaPath) | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'NETWORK_SHADOW_SELFTEST_FAILED: assessment schema JSON invalid' }
Assert-NetworkShadow -Condition ([string]$schema.title -ceq 'Dyson Nebula network assessment v1' -and
    [bool]$schema.additionalProperties -eq $false -and
    @($schema.required).Count -eq 15) -Message 'versioned JSON schema contract drifted'

[ordered]@{
    protocol = 'DYSON_NEBULA_NETWORK_SHADOW_SELFTEST_V1'
    state = 'passed'
    assessmentSchemaVersion = 1
    assessmentScenarios = 2
    websocketClassificationCases = @($classificationFixture.cases).Count +
        @($classificationFixture.passthroughOutcomes).Count
    injectedLocalListenerCalls = [int]$readyRun.calls.localListener + [int]$wssRun.calls.localListener
    injectedDnsCalls = [int]$readyRun.calls.dns + [int]$wssRun.calls.dns
    injectedTcpCalls = [int]$readyRun.calls.tcp + [int]$wssRun.calls.tcp
    injectedWebSocketCalls = [int]$readyRun.calls.websocket + [int]$wssRun.calls.websocket
    nativeDnsCalls = 0
    nativeTcpCalls = 0
    nativeWebSocketCalls = 0
    remoteProbeGateValidated = $true
    mutationPermanentlyDisabled = $true
    outputPrivacyValidated = $true
    productionChanged = $false
} | ConvertTo-Json -Depth 5 -Compress
