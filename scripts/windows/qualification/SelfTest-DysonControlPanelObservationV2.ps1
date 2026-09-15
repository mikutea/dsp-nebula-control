# Copyright (c) Dyson Control contributors.
# Fictional, local-only protocol and tamper tests for panel observation v2.

[CmdletBinding()]
param(
    [AllowNull()][string]$TestRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PanelObservationV2.Common.ps1')

if ([string]::IsNullOrWhiteSpace($TestRoot)) {
    $TestRoot = Join-Path $PSScriptRoot '..\..\..\..\.codex-temp\qualification'
}

$results = New-Object System.Collections.Generic.List[string]
function Add-PanelObservationSelfTestResult {
    param([Parameter(Mandatory)][string]$Name)
    [void]$results.Add($Name)
}

function Assert-PanelObservationSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-PanelObservationSelfTestFailure {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$ExpectedCode,
        [Parameter(Mandatory)][string]$Message
    )
    $actualCode = $null
    try { [void](& $Action) }
    catch { $actualCode = Get-DysonControlPanelObservationV2ErrorCode -Exception $_.Exception }
    if ([string]$actualCode -cne $ExpectedCode) { throw ($Message + '; expected=' + $ExpectedCode + '; actual=' + [string]$actualCode) }
}

function Copy-PanelObservationSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) | ConvertFrom-Json
}

function Get-PanelObservationSelfTestDigest {
    param([Parameter(Mandatory)][char]$Character)
    return 'sha256:' + [string]::new($Character, 64)
}

function New-PanelObservationSelfTestInput {
    param([Parameter(Mandatory)][datetimeoffset]$NowUtc)
    $subjectCommit = [string]::new('a', 40)
    $runtimePayloadSha256 = Get-PanelObservationSelfTestDigest -Character '1'
    $value = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_INPUT_V2'
        schemaVersion = 2
        receiptId = '41000000-0000-0000-0000-000000000001'
        runId = '42000000-0000-0000-0000-000000000001'
        actionTargetId = 'fixture-panel-observation'
        targetIdentity = 'fixture-dyson-vm'
        subjectCommit = $subjectCommit
        runtimePayloadSha256 = $runtimePayloadSha256
        releaseIdentity = [pscustomobject][ordered]@{
            releaseVersion = '0.1.0-rc.1'
            releaseManifestSha256 = Get-PanelObservationSelfTestDigest -Character '2'
            subjectCommit = $subjectCommit
            runtimePayloadSha256 = $runtimePayloadSha256
        }
        endpoint = [pscustomobject][ordered]@{
            scheme = 'https'
            publicHost = 'panel.example.com'
            port = 443
            sniAuthority = 'panel.example.com'
            hostHeaderAuthority = 'panel.example.com'
        }
        tls = [pscustomobject][ordered]@{
            negotiatedProtocol = 'tls13'
            certificateDnsName = 'panel.example.com'
            certificateSha256 = Get-PanelObservationSelfTestDigest -Character '3'
            chainTrusted = $true
            dnsNameMatched = $true
            notBeforeUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddDays(-30)
            notAfterUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddDays(30)
            negotiatedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(-2)
        }
        authenticatedSession = [pscustomobject][ordered]@{
            authenticated = $true
            authenticationMethod = 'password'
            sessionStore = 'server-side'
            sessionCookieOpaque = $true
            sessionCookieSecure = $true
            sessionCookieHttpOnly = $true
            principalRole = 'Administrator'
            sessionId = '43000000-0000-0000-0000-000000000001'
            sessionBindingSha256 = Get-PanelObservationSelfTestDigest -Character '0'
        }
        authorization = [pscustomobject][ordered]@{
            viewerMutation = [pscustomobject][ordered]@{
                role = 'Viewer'
                method = 'POST'
                route = '/api/server/start'
                expectedStatusCode = 403
                actualStatusCode = 403
                mutationObserved = $false
                auditOutcome = 'denied'
            }
            administratorRead = [pscustomobject][ordered]@{
                role = 'Administrator'
                method = 'GET'
                route = '/api/health'
                expectedStatusCode = 200
                actualStatusCode = 200
                authenticatedResponse = $true
            }
        }
        nodeListener = [pscustomobject][ordered]@{
            address = '127.0.0.1'
            port = 3001
            loopbackOnly = $true
            processIdentitySha256 = Get-PanelObservationSelfTestDigest -Character '4'
            runtimePayloadSha256 = $runtimePayloadSha256
        }
        routeSeparation = [pscustomobject][ordered]@{
            managementPublicTransport = 'https'
            managementApplicationProtocol = 'http'
            managementOriginAddress = '127.0.0.1'
            managementOriginPort = 3001
            managementRouteIdentitySha256 = Get-PanelObservationSelfTestDigest -Character '5'
            managementHttpObserved = $true
            gamePublicTransport = 'tcp'
            gameApplicationProtocol = 'nebula-tcp'
            gameOriginAddress = '192.0.2.10'
            gameOriginPort = 8469
            gameRouteIdentitySha256 = Get-PanelObservationSelfTestDigest -Character '6'
            gameTcpObserved = $true
            sharedOrigin = $false
            routeSeparationObserved = $true
        }
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(-2)
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(28)
    }
    $draft = New-DysonControlPanelObservationV2 -InputValue $value
    $value.authenticatedSession.sessionBindingSha256 = Get-DysonControlPanelObservationV2SessionBindingDigest -Observation $draft
    return $value
}

function Update-PanelObservationSelfTestDigest {
    param([Parameter(Mandatory)]$Observation)
    $Observation.receiptSha256 = Get-DysonControlPanelObservationV2Digest -Observation $Observation
    return $Observation
}

$allowedRoot = [IO.Path]::GetFullPath($TestRoot)
[void][IO.Directory]::CreateDirectory($allowedRoot)
$fullTestRoot = [IO.Path]::GetFullPath((Join-Path $allowedRoot ('dyson-panel-observation-selftest-' + [guid]::NewGuid().ToString('N'))))
if (-not $fullTestRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'self-test path escaped the allowed root'
}
[void][IO.Directory]::CreateDirectory($fullTestRoot)

try {
    $now = [datetimeoffset]::ParseExact('2026-09-05T10:00:00.000Z', 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    $fixtureInput = New-PanelObservationSelfTestInput -NowUtc $now
    $observation = New-DysonControlPanelObservationV2 -InputValue $fixtureInput
    $validated = Assert-DysonControlPanelObservationV2 -Observation $observation -ExpectedReceiptId $fixtureInput.receiptId -ExpectedRunId $fixtureInput.runId -ExpectedActionTargetId $fixtureInput.actionTargetId -ExpectedTargetIdentity $fixtureInput.targetIdentity -ExpectedSubjectCommit $fixtureInput.subjectCommit -ExpectedRuntimePayloadSha256 $fixtureInput.runtimePayloadSha256 -ExpectedPublicHost 'panel.example.com' -ExpectedReleaseVersion '0.1.0-rc.1' -NowUtc $now
    Assert-PanelObservationSelfTest -Condition ([bool]$validated.qualified) -Message 'valid fixture did not qualify'
    Add-PanelObservationSelfTestResult 'strict-domain-observation-accepted'

    $statusOnly = Copy-PanelObservationSelfTestValue -Value $observation
    $statusOnly | Add-Member -NotePropertyName status -NotePropertyValue 'verified'
    [void](Update-PanelObservationSelfTestDigest -Observation $statusOnly)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $statusOnly -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_INVALID' -Message 'a generic status=verified escape hatch was accepted'
    Add-PanelObservationSelfTestResult 'status-only-escape-hatch-rejected'

    $badSni = Copy-PanelObservationSelfTestValue -Value $observation
    $badSni.endpoint.sniAuthority = 'other.example.com'
    [void](Update-PanelObservationSelfTestDigest -Observation $badSni)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badSni -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ENDPOINT_INVALID' -Message 'SNI substitution was accepted'
    Add-PanelObservationSelfTestResult 'public-host-sni-host-binding-enforced'

    $badCertificate = Copy-PanelObservationSelfTestValue -Value $observation
    $badCertificate.tls.certificateDnsName = 'other.example.com'
    [void](Update-PanelObservationSelfTestDigest -Observation $badCertificate)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badCertificate -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID' -Message 'certificate DNS substitution was accepted'
    $wildcardCertificate = Copy-PanelObservationSelfTestValue -Value $observation
    $wildcardCertificate.tls.certificateDnsName = '*.example.com'
    [void](Update-PanelObservationSelfTestDigest -Observation $wildcardCertificate)
    [void](Assert-DysonControlPanelObservationV2 -Observation $wildcardCertificate -NowUtc $now)
    Add-PanelObservationSelfTestResult 'exact-or-single-label-wildcard-certificate-bound-to-public-host'

    $expiredCertificate = Copy-PanelObservationSelfTestValue -Value $observation
    $expiredCertificate.tls.notAfterUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddMinutes(10)
    [void](Update-PanelObservationSelfTestDigest -Observation $expiredCertificate)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $expiredCertificate -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_TLS_INVALID' -Message 'certificate expiring before the observation was accepted'
    Add-PanelObservationSelfTestResult 'certificate-validity-window-enforced'

    $badSession = Copy-PanelObservationSelfTestValue -Value $observation
    $badSession.authenticatedSession.authenticated = $false
    [void](Update-PanelObservationSelfTestDigest -Observation $badSession)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badSession -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHENTICATION_INVALID' -Message 'unauthenticated session was accepted'
    Add-PanelObservationSelfTestResult 'authenticated-server-session-required'

    $badViewer = Copy-PanelObservationSelfTestValue -Value $observation
    $badViewer.authorization.viewerMutation.actualStatusCode = 200
    $badViewer.authorization.viewerMutation.mutationObserved = $true
    [void](Update-PanelObservationSelfTestDigest -Observation $badViewer)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badViewer -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHORIZATION_INVALID' -Message 'Viewer mutation was accepted'
    Add-PanelObservationSelfTestResult 'viewer-mutation-denial-required'

    $badAdministrator = Copy-PanelObservationSelfTestValue -Value $observation
    $badAdministrator.authorization.administratorRead.actualStatusCode = 403
    [void](Update-PanelObservationSelfTestDigest -Observation $badAdministrator)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badAdministrator -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_AUTHORIZATION_INVALID' -Message 'failed Administrator read was accepted'
    Add-PanelObservationSelfTestResult 'administrator-authenticated-read-required'

    $publicListener = Copy-PanelObservationSelfTestValue -Value $observation
    $publicListener.nodeListener.address = '0.0.0.0'
    $publicListener.routeSeparation.managementOriginAddress = '0.0.0.0'
    [void](Update-PanelObservationSelfTestDigest -Observation $publicListener)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $publicListener -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_LISTENER_INVALID' -Message 'public Node listener was accepted'
    Add-PanelObservationSelfTestResult 'node-listener-loopback-only-required'

    $badRoutes = Copy-PanelObservationSelfTestValue -Value $observation
    $badRoutes.routeSeparation.gamePublicTransport = 'https'
    [void](Update-PanelObservationSelfTestDigest -Observation $badRoutes)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $badRoutes -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ROUTE_SEPARATION_INVALID' -Message 'HTTP and game TCP route collapse was accepted'
    Add-PanelObservationSelfTestResult 'management-http-game-tcp-separation-required'

    $sameRoutes = Copy-PanelObservationSelfTestValue -Value $observation
    $sameRoutes.routeSeparation.gameRouteIdentitySha256 = [string]$sameRoutes.routeSeparation.managementRouteIdentitySha256
    [void](Update-PanelObservationSelfTestDigest -Observation $sameRoutes)
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $sameRoutes -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ROUTE_SEPARATION_INVALID' -Message 'identical route identities were accepted'
    Add-PanelObservationSelfTestResult 'distinct-route-identities-required'

    $stale = Copy-PanelObservationSelfTestValue -Value $observation
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $stale -NowUtc $now.AddHours(2) } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_STALE' -Message 'expired observation was accepted'
    Add-PanelObservationSelfTestResult 'observation-expiry-enforced'

    $digestTamper = Copy-PanelObservationSelfTestValue -Value $observation
    $digestTamper.endpoint.publicHost = 'other.example.com'
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $digestTamper -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_ENDPOINT_INVALID' -Message 'content tamper was accepted'
    $digestOnly = Copy-PanelObservationSelfTestValue -Value $observation
    $digestOnly.receiptSha256 = Get-PanelObservationSelfTestDigest -Character 'f'
    Assert-PanelObservationSelfTestFailure -Action { Assert-DysonControlPanelObservationV2 -Observation $digestOnly -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_DIGEST_INVALID' -Message 'digest tamper was accepted'
    Add-PanelObservationSelfTestResult 'semantic-and-digest-tamper-rejected'

    Assert-PanelObservationSelfTestFailure -Action { ConvertFrom-DysonControlPanelObservationV2StrictJson -Text '{"protocol":"one","\u0070rotocol":"two"}' } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_DUPLICATE_JSON_KEY' -Message 'escaped duplicate JSON key was accepted'
    Add-PanelObservationSelfTestResult 'duplicate-json-key-rejected'

    $inputPath = Join-Path $fullTestRoot 'panel-input.json'
    $outputPath = Join-Path $fullTestRoot 'panel-observation.json'
    [IO.File]::WriteAllText($inputPath, (ConvertTo-DysonQualificationV2CanonicalJson -Value $fixtureInput), (New-Object Text.UTF8Encoding -ArgumentList $false))
    $generatorResult = & (Join-Path $PSScriptRoot 'New-DysonControlPanelObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now | ConvertFrom-Json
    Assert-PanelObservationSelfTest -Condition ([bool]$generatorResult.qualified -and (Test-Path -LiteralPath $outputPath -PathType Leaf)) -Message 'generator did not create qualified canonical evidence'
    $outputText = [IO.File]::ReadAllText($outputPath)
    $outputValue = ConvertFrom-DysonControlPanelObservationV2StrictJson -Text $outputText
    Assert-PanelObservationSelfTest -Condition ($outputText -ceq (ConvertTo-DysonQualificationV2CanonicalJson -Value $outputValue)) -Message 'generator output was not canonical'
    $validatorResult = & (Join-Path $PSScriptRoot 'Test-DysonControlPanelObservationV2.ps1') -ObservationPath $outputPath -ExpectedReceiptId $fixtureInput.receiptId -ExpectedRunId $fixtureInput.runId -ExpectedActionTargetId $fixtureInput.actionTargetId -ExpectedTargetIdentity $fixtureInput.targetIdentity -ExpectedSubjectCommit $fixtureInput.subjectCommit -ExpectedRuntimePayloadSha256 $fixtureInput.runtimePayloadSha256 -ExpectedPublicHost 'panel.example.com' -ExpectedReleaseVersion '0.1.0-rc.1' -NowUtc $now | ConvertFrom-Json
    Assert-PanelObservationSelfTest -Condition ([bool]$validatorResult.qualified -and -not [bool]$validatorResult.networkTouched -and -not [bool]$validatorResult.productionChanged) -Message 'standalone validator did not remain read-only'
    Assert-PanelObservationSelfTestFailure -Action { & (Join-Path $PSScriptRoot 'New-DysonControlPanelObservationV2.ps1') -InputPath $inputPath -OutputPath $outputPath -NowUtc $now } -ExpectedCode 'DYSON_CONTROL_PANEL_OBSERVATION_V2_OUTPUT_EXISTS' -Message 'generator overwrote existing evidence'
    Add-PanelObservationSelfTestResult 'canonical-create-new-generator-and-read-only-validator'

    $schema = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'dyson-control-panel-observation-v2.schema.json') -Encoding UTF8 | ConvertFrom-Json
    Assert-PanelObservationSelfTest -Condition ([string]$schema.properties.protocol.const -ceq 'DYSON_CONTROL_PANEL_OBSERVATION_V2') -Message 'schema protocol drifted'
    Assert-PanelObservationSelfTest -Condition (-not [bool]$schema.additionalProperties) -Message 'schema allows unknown top-level fields'
    Assert-PanelObservationSelfTest -Condition ($null -eq $schema.properties.PSObject.Properties['status']) -Message 'schema exposes a status-only shortcut'
    Add-PanelObservationSelfTestResult 'schema-exact-and-status-free'

    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_SELFTEST_V2'
        schemaVersion = 2
        status = 'passed'
        runtime = 'Windows PowerShell 5.1 compatible'
        runtimeVersion = $PSVersionTable.PSVersion.ToString()
        testCount = $results.Count
        passedCount = $results.Count
        tests = @($results | ForEach-Object { $_ })
        fixturePublicHost = 'panel.example.com'
        fixtureGameAddress = '192.0.2.10'
        networkTouched = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
finally {
    if (Test-Path -LiteralPath $fullTestRoot) {
        $resolved = [IO.Path]::GetFullPath($fullTestRoot)
        if ($resolved.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolved) -cmatch '^dyson-panel-observation-selftest-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
