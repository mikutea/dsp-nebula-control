# Copyright (c) Dyson Control contributors.
# PowerShell 5.1 focused tests for the private hostname-preserving WSS qualification contract.

[CmdletBinding()]
param([string]$TestRoot)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'DysonHostnameWssQualification.Common.ps1')

$results = New-Object 'System.Collections.Generic.List[object]'

function Add-TestResult {
    param([Parameter(Mandatory)][string]$Name)
    $results.Add([pscustomobject][ordered]@{ name = $Name; status = 'passed' }) | Out-Null
}

function Assert-TestCondition {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('SELFTEST_ASSERTION_FAILED: ' + $Message) }
}

function Assert-TestFailure {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$ExpectedCode,
        [Parameter(Mandatory)][string]$Message
    )
    try { & $Action; throw ('SELFTEST_EXPECTED_FAILURE_NOT_RAISED: ' + $Message) }
    catch {
        if ($_.Exception.Message -cmatch '^SELFTEST_EXPECTED_FAILURE_NOT_RAISED') { throw }
        $actual = Get-DysonHostnameWssErrorCode -Exception $_.Exception
        if ($actual -cne $ExpectedCode) {
            throw ('SELFTEST_WRONG_FAILURE: ' + $Message + ': expected=' + $ExpectedCode + ',actual=' + $actual)
        }
    }
}

function Copy-TestValue {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 64 -Compress | ConvertFrom-Json)
}

function Get-TestBytes {
    param([Parameter(Mandatory)][int]$Seed)
    [byte[]]$bytes = New-Object byte[] 32
    for ($index = 0; $index -lt $bytes.Length; $index++) { $bytes[$index] = [byte](($Seed + $index) -band 0xff) }
    return $bytes
}

function Get-TestNonce {
    param([Parameter(Mandatory)][int]$Seed)
    return [Convert]::ToBase64String((Get-TestBytes -Seed $Seed)).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function New-TestExternalReceipts {
    param(
        [Parameter(Mandatory)][datetimeoffset]$StartUtc,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$InitialChallengeId,
        [Parameter(Mandatory)][string]$ReconnectChallengeId
    )
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
    $receipts = @()
    $previous = $null
    for ($index = 0; $index -lt 11; $index++) {
        $at = $StartUtc.AddSeconds(20 * $index)
        $challenge = if ($index -le 7) { $InitialChallengeId } else { $ReconnectChallengeId }
        $binding = $null
        if ($index -eq 10) {
            $binding = Get-DysonQualificationSha256 -InputObject ([ordered]@{
                protocol = 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1'
                firstChallengeId = $InitialChallengeId
                reconnectChallengeId = $ReconnectChallengeId
                predecessorSha256 = [string]$receipts[9].receiptSha256
            })
        }
        $suffix = '{0:d12}' -f ($index + 1)
        $receipt = New-DysonQualificationReceipt `
            -ReceiptId ('71000000-0000-0000-0000-' + $suffix) `
            -RunId $RunId -IdempotencyKey ('72000000-0000-0000-0000-' + $suffix) `
            -StepId 'external-client-e2e' -Sequence ($index + 1) -Event $events[$index] `
            -Status $(if ($index -eq 10) { 'passed' } else { 'observed' }) `
            -IssuedAtUtc $at -ExpiresAtUtc $at.AddMinutes(20) -PredecessorSha256 $previous `
            -EvidenceOpaqueId ('73000000-0000-0000-0000-' + $suffix) -EvidenceType $types[$index] `
            -EvidenceSha256 (Get-DysonQualificationSha256 -Text ('hostname-wss-external-' + $index)) `
            -EvidenceObservedAtUtc $at -EvidenceExpiresAtUtc $at.AddMinutes(20) `
            -AttestationClass $classes[$index] -CheckCodes @('external-observed') `
            -ChallengeId $challenge -TranscriptBindingSha256 $binding
        $receipts += ,$receipt
        $previous = [string]$receipt.receiptSha256
    }
    return ,$receipts
}

function Get-TestKeyResolver {
    param([Parameter(Mandatory)]$KeyMap)
    $resolver = {
        param($keyId)
        if (-not $KeyMap.ContainsKey([string]$keyId)) { throw 'unknown test key' }
        [byte[]]$source = $KeyMap[[string]$keyId]
        [byte[]]$copy = New-Object byte[] $source.Length
        [Array]::Copy($source, $copy, $source.Length)
        return $copy
    }.GetNewClosure()
    return $resolver
}

if ([string]::IsNullOrWhiteSpace($TestRoot)) {
    $TestRoot = Join-Path $env:TEMP ('dyson-hostname-wss-selftest-' + [guid]::NewGuid().ToString('N'))
}
$fullTestRoot = [IO.Path]::GetFullPath($TestRoot)
$allowedRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if (-not $fullTestRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($fullTestRoot) -cnotmatch '^dyson-hostname-wss-selftest-[0-9a-f]{32}$') {
    throw 'SELFTEST_ROOT_OUTSIDE_ALLOWED_WORKSPACE_TEMP'
}

try {
    [void][IO.Directory]::CreateDirectory($fullTestRoot)
    $fixturePath = Join-Path $PSScriptRoot 'fixtures\hostname-wss-canonical-v1.fixture.json'
    $fixture = (Read-DysonHostnameWssJsonFile -Path $fixturePath).value
    [byte[]]$fixtureKey = New-Object byte[] 32
    for ($index = 0; $index -lt 32; $index++) {
        $fixtureKey[$index] = [Convert]::ToByte(([string]$fixture.testKeyHex).Substring($index * 2, 2), 16)
    }
    Assert-TestCondition -Condition ([string]$fixture.projectionBindingSha256Source -ceq
        'qualification.documentSha256') -Message 'projection binding digest source drifted'
    foreach ($case in @($fixture.cases)) {
        Assert-TestCondition -Condition ((ConvertTo-DysonQualificationV2CanonicalJson -Value $case.input) -ceq [string]$case.canonicalJson) `
            -Message ('canonical mismatch for ' + [string]$case.id)
        Assert-TestCondition -Condition ((Get-DysonHostnameWssObjectDigest -Value $case.input) -ceq [string]$case.sha256) `
            -Message ('digest mismatch for ' + [string]$case.id)
        Assert-TestCondition -Condition ((Get-DysonHostnameWssHmac -Value $case.input -Key $fixtureKey) -ceq [string]$case.hmacSha256) `
            -Message ('HMAC mismatch for ' + [string]$case.id)
    }
    [Array]::Clear($fixtureKey, 0, $fixtureKey.Length)
    Add-TestResult 'cross-runtime-canonical-vectors'

    $manifestFixturePath = Join-Path $PSScriptRoot 'fixtures\hostname-wss-mod-manifest-digests-v1.fixture.json'
    $manifestFixture = (Read-DysonHostnameWssJsonFile -Path $manifestFixturePath).value
    $manifestDigests = Get-DysonHostnameWssProfileManifestDigests `
        -ServerLock $manifestFixture.serverLock -ClientParity $manifestFixture.clientParity
    Assert-TestCondition -Condition ([string]$manifestDigests.serverLockSha256 -ceq
        [string]$manifestFixture.serverLockSha256) -Message 'server lock digest differs from Node fixture'
    Assert-TestCondition -Condition ([string]$manifestDigests.clientParitySha256 -ceq
        [string]$manifestFixture.clientParitySha256) -Message 'client parity digest differs from Node fixture'
    Assert-TestCondition -Condition (((ConvertTo-DysonHostnameWssPrettyJsonValue $manifestDigests.serverLock) + "`n") -ceq
        [string]$manifestFixture.expectedServerText) -Message 'server lock pretty JSON differs from JSON.stringify'
    Assert-TestCondition -Condition (((ConvertTo-DysonHostnameWssPrettyJsonValue $manifestDigests.clientParity) + "`n") -ceq
        [string]$manifestFixture.expectedClientText) -Message 'client parity pretty JSON differs from JSON.stringify'
    $tamperedParity = Copy-TestValue $manifestFixture.clientParity
    $tamperedParity.mods[0].sha256 = 'b' * 64
    Assert-TestFailure { [void](Get-DysonHostnameWssProfileManifestDigests `
        -ServerLock $manifestFixture.serverLock -ClientParity $tamperedParity) } `
        'DYSON_HOSTNAME_WSS_PROFILE_MANIFEST_INVALID' 'mismatched client parity bytes were accepted'
    Add-TestResult 'cross-runtime-mod-manifest-digests-and-tamper'

    Assert-TestCondition (Test-DysonHostnameWssIdentifier 'abcdefgh') 'minimum identifier rejected'
    Assert-TestCondition (-not (Test-DysonHostnameWssIdentifier 'abcdefg')) 'short identifier accepted'
    Assert-TestCondition (-not (Test-DysonHostnameWssIdentifier 'alpha..beta')) 'double dot accepted'
    Assert-TestCondition (-not (Test-DysonHostnameWssIdentifier 'con.test1')) 'reserved Windows stem accepted'
    Assert-TestCondition (-not (Test-DysonHostnameWssIdentifier 'abcdefgh-')) 'punctuation endpoint accepted'
    Add-TestResult 'identifier-strong-grammar'

    $now = [datetimeoffset]::ParseExact('2035-01-01T00:00:00.000Z','yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
    $qualificationId = '11000000-0000-0000-0000-000000000001'
    $runId = '12000000-0000-0000-0000-000000000001'
    $sessionId = '13000000-0000-0000-0000-000000000001'
    $initialChallenge = '14000000-0000-0000-0000-000000000001'
    $reconnectChallenge = '14000000-0000-0000-0000-000000000002'
    $externalReceipts = New-TestExternalReceipts -StartUtc $now.AddMinutes(-10) -RunId $runId `
        -InitialChallengeId $initialChallenge -ReconnectChallengeId $reconnectChallenge
    $externalPath = Join-Path $fullTestRoot 'external-client-receipts.json'
    [IO.File]::WriteAllText($externalPath, (ConvertTo-DysonQualificationV2CanonicalJson -Value $externalReceipts),
        (New-Object Text.UTF8Encoding -ArgumentList $false))

    $digest = { param([char]$character) 'sha256:' + ([string]$character * 64) }
    $document = [pscustomobject][ordered]@{
        protocol = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1'
        schemaVersion = 1
        qualificationId = $qualificationId
        runId = $runId
        issuedAtUtc = ConvertTo-DysonQualificationV2Utc $now.AddMinutes(-15)
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc $now.AddMinutes(15)
        subject = [pscustomobject][ordered]@{
            topology = 'http-websocket-tunnel'; transport = 'wss'; authority = 'example.com'; port = 443
            websocketPath = '/socket'; authoritySemantics = 'hostname-preserved'
        }
        contractBinding = [pscustomobject][ordered]@{
            sourcePatchContractSha256 = & $digest 'a'; privateBuildContractSha256 = & $digest 'b'
            upstreamCommit = '3cdf95c594a2f8010b0e87a43be828e6ba2f657f'; patchSha256 = & $digest 'c'
            binaryMetadataASha256 = & $digest 'd'; binaryMetadataBSha256 = & $digest 'e'
            candidateManifestSha256 = & $digest 'f'; candidateTreeSha256 = & $digest '1'
            clientManifestSha256 = & $digest '2'; clientPackageSha256 = & $digest '3'
            profileInputSha256 = & $digest '4'; serverLockSha256 = & $digest '5'
            clientParitySha256 = & $digest '6'; compatibilityPolicySha256 = & $digest '7'
        }
        binaryBinding = [pscustomobject][ordered]@{
            candidate = @(
                [pscustomobject][ordered]@{ role='nebula-network';fileName='NebulaNetwork.dll';sha256=(& $digest '8');mvid='15000000-0000-0000-0000-000000000001' },
                [pscustomobject][ordered]@{ role='nebula-patcher';fileName='NebulaPatcher.dll';sha256=(& $digest '9');mvid='15000000-0000-0000-0000-000000000002' }
            )
            client = @(
                [pscustomobject][ordered]@{ role='nebula-network';fileName='NebulaNetwork.dll';sha256=(& $digest '8');mvid='15000000-0000-0000-0000-000000000001' },
                [pscustomobject][ordered]@{ role='nebula-patcher';fileName='NebulaPatcher.dll';sha256=(& $digest '9');mvid='15000000-0000-0000-0000-000000000002' }
            )
        }
        transportBinding = [pscustomobject][ordered]@{
            sniAuthority='example.com';hostHeaderAuthority='example.com:443';websocketPath='/socket';tlsProtocol='tls13'
            httpStatusCode=101;ingressProvider='cloudflare-tunnel';ingressConfigSha256=(& $digest 'a')
            originBindingSha256=(& $digest 'b');websocketTranscriptSha256=(& $digest 'c');sessionBindingSha256=(& $digest 'd')
        }
        routeBinding = [pscustomobject][ordered]@{
            ruleRevisionBefore=42;ruleRevisionAfter=42;ruleIdentitySha256=(& $digest 'd')
            flowBindingSha256=(& $digest 'e');sessionBindingSha256=(& $digest 'd')
            directCounters=[pscustomobject][ordered]@{packetsBefore=100;packetsAfter=103;bytesBefore=1000;bytesAfter=1400}
            proxyCounters=[pscustomobject][ordered]@{packetsBefore=10;packetsAfter=10;bytesBefore=500;bytesAfter=500}
        }
        externalClientBinding = [pscustomobject][ordered]@{
            receiptChainSha256=(& $digest 'a');receiptCount=11;terminalReceiptSha256=(& $digest 'b')
            joinReceiptSha256=(& $digest 'c');reconnectReceiptSha256=(& $digest 'd')
            initialChallengeId=$initialChallenge;reconnectChallengeId=$reconnectChallenge
            transcriptBindingSha256=(& $digest 'e');sessionBindingSha256=(& $digest 'd')
            observedAtUtc=ConvertTo-DysonQualificationV2Utc $now.AddMinutes(-10)
            expiresAtUtc=ConvertTo-DysonQualificationV2Utc $now.AddMinutes(10)
        }
        receiptChain = @()
        documentSha256 = & $digest 'f'
        protection = [pscustomobject][ordered]@{ algorithm='hmac-sha256';keyId='coordinator-key-01';hmacSha256=(& $digest 'a') }
    }
    $external = Get-DysonHostnameWssExternalClientMaterial -Path $externalPath -Document $document `
        -SessionId $sessionId -NowUtc $now
    $document.externalClientBinding = $external.binding
    $sessionBinding = Get-DysonHostnameWssSessionBindingDigest -Document $document -SessionId $sessionId
    $document.transportBinding.sessionBindingSha256 = $sessionBinding
    $document.routeBinding.sessionBindingSha256 = $sessionBinding
    $document.routeBinding.flowBindingSha256 = Get-DysonHostnameWssFlowBindingDigest -Document $document `
        -SessionId $sessionId -SessionBindingSha256 $sessionBinding

    $keyIds = @('collector-build-key-01','collector-wss-key-01','collector-route-key-01','collector-external-key-01')
    $keyMap = @{}
    for ($index = 0; $index -lt 4; $index++) { $keyMap[$keyIds[$index]] = Get-TestBytes -Seed (10 + $index) }
    $keyMap['coordinator-key-01'] = Get-TestBytes -Seed 20
    $keyResolver = Get-TestKeyResolver -KeyMap $keyMap
    $evidenceDigests = @(
        (Get-DysonHostnameWssObjectDigest ([ordered]@{contractBinding=$document.contractBinding;binaryBinding=$document.binaryBinding})),
        (Get-DysonHostnameWssObjectDigest $document.transportBinding),
        (Get-DysonHostnameWssObjectDigest $document.routeBinding),
        (Get-DysonHostnameWssObjectDigest $document.externalClientBinding)
    )
    $previous = $null
    for ($index = 0; $index -lt 4; $index++) {
        [byte[]]$receiptKey = & $keyResolver $keyIds[$index]
        $receipt = New-DysonHostnameWssCollectorReceipt `
            -ReceiptId ('21000000-0000-0000-0000-00000000000' + ($index + 1)) `
            -QualificationId $qualificationId -RunId $runId -CollectorId $script:DysonHostnameWssCollectorIds[$index] `
            -KeyId $keyIds[$index] -Sequence ($index + 1) -EvidenceType $script:DysonHostnameWssEvidenceTypes[$index] `
            -ChallengeIds ([pscustomobject][ordered]@{initial=$initialChallenge;reconnect=$reconnectChallenge}) `
            -SessionId $sessionId -Nonce (Get-TestNonce -Seed (30 + $index)) `
            -ObservedAtUtc $now.AddMinutes(-4 + $index) -ExpiresAtUtc $now.AddMinutes(10) `
            -PreviousReceiptSha256 $previous -EvidenceSha256 $evidenceDigests[$index] -Key $receiptKey
        [Array]::Clear($receiptKey, 0, $receiptKey.Length)
        $document.receiptChain += ,$receipt
        $previous = [string]$receipt.receiptSha256
    }
    $documentCore = Get-DysonHostnameWssUnsignedValue -Value $document -ExcludedNames @('documentSha256','protection')
    $document.documentSha256 = Get-DysonHostnameWssObjectDigest $documentCore
    [byte[]]$coordinatorKey = & $keyResolver 'coordinator-key-01'
    $document.protection.hmacSha256 = Get-DysonHostnameWssHmac -Value ([ordered]@{
        domain='DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1_DOCUMENT'
        keyId='coordinator-key-01';documentSha256=$document.documentSha256
    }) -Key $coordinatorKey
    [Array]::Clear($coordinatorKey, 0, $coordinatorKey.Length)

    $timing = Assert-DysonHostnameWssDocumentStructure -Document $document -ExpectedQualificationId $qualificationId `
        -ExpectedAuthority 'example.com' -ExpectedPort 443 -NowUtc $now
    Assert-DysonHostnameWssDocumentProtection -Document $document -KeyResolver $keyResolver
    $buildMaterial = [pscustomobject][ordered]@{contractBinding=$document.contractBinding;binaryBinding=$document.binaryBinding}
    [void](Assert-DysonHostnameWssActualBindings -Document $document -BuildMaterial $buildMaterial `
        -ExternalMaterial $external -SessionId $sessionId)
    [void](Assert-DysonHostnameWssCollectorReceiptChain -Receipts @($document.receiptChain) -Document $document `
        -ExpectedSessionBindingSha256 $sessionBinding -DocumentIssuedAtUtc $timing.issuedAtUtc `
        -DocumentExpiresAtUtc $timing.expiresAtUtc -NowUtc $now -KeyResolver $keyResolver)
    Add-TestResult 'valid-protected-document-and-receipt-chain'
    Add-TestResult 'external-eleven-step-server-authoritative-sequence'

    $extra = Copy-TestValue $document
    $extra | Add-Member -NotePropertyName verified -NotePropertyValue $true
    Assert-TestFailure { Assert-DysonHostnameWssDocumentStructure -Document $extra -ExpectedQualificationId $qualificationId `
        -ExpectedAuthority 'example.com' -ExpectedPort 443 -NowUtc $now } `
        'DYSON_HOSTNAME_WSS_DOCUMENT_INVALID' 'self-reported verified flag was accepted'
    Add-TestResult 'self-reported-boolean-rejected'

    $badHmac = Copy-TestValue $document
    $badHmac.protection.hmacSha256 = & $digest '0'
    Assert-TestFailure { Assert-DysonHostnameWssDocumentProtection -Document $badHmac -KeyResolver $keyResolver } `
        'DYSON_HOSTNAME_WSS_DOCUMENT_HMAC_INVALID' 'document HMAC tamper was accepted'
    Add-TestResult 'document-hmac-tamper-rejected'

    $badTransport = Copy-TestValue $document
    $badTransport.transportBinding.sniAuthority = 'other.example.com'
    Assert-TestFailure { Assert-DysonHostnameWssTransportBinding -Document $badTransport } `
        'DYSON_HOSTNAME_WSS_TRANSPORT_BINDING_INVALID' 'SNI substitution was accepted'
    Add-TestResult 'sni-host-path-binding-enforced'

    $badRoute = Copy-TestValue $document.routeBinding
    $badRoute.proxyCounters.bytesAfter = 501
    Assert-TestFailure { Assert-DysonHostnameWssRouteBinding -Binding $badRoute } `
        'DYSON_HOSTNAME_WSS_ROUTE_BINDING_INVALID' 'proxy counter delta was accepted as direct'
    Add-TestResult 'passwall-counter-delta-derived'

    $sameSigner = Copy-TestValue $document
    $sameSigner.protection.keyId = [string]$sameSigner.receiptChain[0].keyId
    Assert-TestFailure { Assert-DysonHostnameWssCollectorReceiptChain -Receipts @($sameSigner.receiptChain) `
        -Document $sameSigner -ExpectedSessionBindingSha256 $sessionBinding `
        -DocumentIssuedAtUtc $timing.issuedAtUtc -DocumentExpiresAtUtc $timing.expiresAtUtc `
        -NowUtc $now -KeyResolver $keyResolver } 'DYSON_HOSTNAME_WSS_SIGNER_ROLE_NOT_SEPARATED' `
        'document signer reused a collector key'
    Add-TestResult 'five-signer-key-separation'

    $stale = Copy-TestValue $document
    Assert-TestFailure { Assert-DysonHostnameWssDocumentStructure -Document $stale -ExpectedQualificationId $qualificationId `
        -ExpectedAuthority 'example.com' -ExpectedPort 443 -NowUtc $now.AddHours(1) } `
        'DYSON_HOSTNAME_WSS_DOCUMENT_STALE' 'stale document was accepted'
    Add-TestResult 'stale-document-rejected'

    $badExternal = Copy-TestValue $externalReceipts
    $badExternal[3].evidenceRef.type = 'client-self-report'
    $badExternal[3].receiptSha256 = Get-DysonQualificationReceiptDigest $badExternal[3]
    Assert-TestFailure { [void](Assert-DysonExternalClientReceiptSequence -Receipts @($badExternal) -NowUtc $now) } `
        'DYSON_HOSTNAME_WSS_VALIDATION_FAILED' 'external client self-report was accepted'
    Add-TestResult 'external-self-report-rejected'

    $badSession = Copy-TestValue $document
    $badSession.routeBinding.sessionBindingSha256 = & $digest '0'
    Assert-TestFailure { [void](Assert-DysonHostnameWssActualBindings -Document $badSession -BuildMaterial $buildMaterial `
        -ExternalMaterial $external -SessionId $sessionId) } 'DYSON_HOSTNAME_WSS_SESSION_BINDING_INVALID' `
        'session substitution was accepted'
    Add-TestResult 'session-and-flow-binding-derived'

    $projection = New-DysonHostnameWssProjection -QualificationId $qualificationId -RunId $runId `
        -BindingSha256 $document.documentSha256 -ExpiresAtUtc $document.expiresAtUtc `
        -Decision 'preview-valid' -BlockerCodes @('DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED')
    Assert-TestCondition -Condition ((@($projection.PSObject.Properties.Name) -join ',') -ceq
        'qualificationId,runId,bindingSha256,expiresAtUtc,decision,blockerCodes') `
        -Message 'redacted projection fields drifted'
    Add-TestResult 'redacted-six-field-projection'

    $atomicPath = Join-Path $fullTestRoot 'atomic-create.json'
    $atomicValue = [pscustomobject][ordered]@{ protocol='DYSON_TEST_ATOMIC_V1'; value=1 }
    Assert-TestCondition (Write-DysonHostnameWssCanonicalCreateNew -Path $atomicPath -Value $atomicValue) `
        'first atomic create did not win'
    Assert-TestCondition (-not (Write-DysonHostnameWssCanonicalCreateNew -Path $atomicPath -Value $atomicValue)) `
        'second atomic create unexpectedly won'
    Assert-TestCondition (([IO.File]::ReadAllText($atomicPath) -ceq (ConvertTo-DysonQualificationV2CanonicalJson $atomicValue))) `
        'atomic file is not canonical'
    Add-TestResult 'atomic-create-new-winner'

    [byte[]]$claimKey = & $keyResolver 'coordinator-key-01'
    $receiptMaterial = Get-DysonHostnameWssReceiptMaterial -Receipts @($document.receiptChain)
    $claim = New-DysonHostnameWssReplayClaim -ClaimType 'receipt-id' `
        -ClaimId ([string]$document.receiptChain[0].receiptId) -Document $document `
        -ReceiptMaterialSha256 $receiptMaterial.sha256 -Key $claimKey
    Assert-DysonHostnameWssReplayClaim -Claim $claim -Expected $claim -Key $claimKey
    $conflict = Copy-TestValue $claim
    $conflict.runId = '12000000-0000-0000-0000-000000000002'
    Assert-TestFailure { Assert-DysonHostnameWssReplayClaim -Claim $conflict -Expected $claim -Key $claimKey } `
        'DYSON_HOSTNAME_WSS_RECEIPT_REPLAYED' 'replay claim substitution was accepted'
    $acceptance = New-DysonHostnameWssAcceptance -Document $document -ReceiptMaterialSha256 $receiptMaterial.sha256 `
        -AcceptedAtUtc $now -Key $claimKey
    Assert-DysonHostnameWssAcceptance -Acceptance $acceptance -Document $document `
        -ReceiptMaterialSha256 $receiptMaterial.sha256 -NowUtc $now -Key $claimKey
    [Array]::Clear($claimKey, 0, $claimKey.Length)
    Add-TestResult 'signed-idempotent-acceptance-and-replay-claim'

    $replayRoot = Join-Path $fullTestRoot 'replay'
    $replayLayout = [pscustomobject][ordered]@{
        root = $replayRoot
        acceptances = Join-Path $replayRoot 'acceptances'
        receiptClaims = Join-Path $replayRoot 'claims\receipt-id'
        nonceClaims = Join-Path $replayRoot 'claims\nonce'
    }
    foreach ($directory in @($replayLayout.acceptances,$replayLayout.receiptClaims,$replayLayout.nonceClaims)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }
    $firstAcceptance = Acquire-DysonHostnameWssAcceptanceCore -Document $document -Layout $replayLayout `
        -NowUtc $now -KeyResolver $keyResolver
    $secondAcceptance = Acquire-DysonHostnameWssAcceptanceCore -Document $document -Layout $replayLayout `
        -NowUtc $now.AddSeconds(1) -KeyResolver $keyResolver
    Assert-TestCondition ($firstAcceptance.qualified -and $firstAcceptance.created) 'first acceptance did not atomically win'
    Assert-TestCondition ($secondAcceptance.qualified -and -not $secondAcceptance.created) 'same binding was not idempotent'
    $replayedDocument = Copy-TestValue $document
    $replayedDocument.qualificationId = '11000000-0000-0000-0000-000000000002'
    $replayedDocument.documentSha256 = & $digest '0'
    Assert-TestFailure { [void](Acquire-DysonHostnameWssAcceptanceCore -Document $replayedDocument `
        -Layout $replayLayout -NowUtc $now.AddSeconds(2) -KeyResolver $keyResolver) } `
        'DYSON_HOSTNAME_WSS_RECEIPT_REPLAYED' 'cross-document receipt replay was accepted'
    Add-TestResult 'multi-consumer-idempotent-acceptance-and-cross-document-replay'

    $clientRoot = Join-Path $fullTestRoot 'client'
    [void][IO.Directory]::CreateDirectory((Join-Path $clientRoot 'plugins'))
    [IO.File]::WriteAllBytes((Join-Path $clientRoot 'plugins\NebulaNetwork.dll'), [byte[]](1,2,3,4))
    [IO.File]::WriteAllBytes((Join-Path $clientRoot 'plugins\NebulaPatcher.dll'), [byte[]](5,6,7,8))
    $clientFiles = @()
    foreach ($name in @('NebulaNetwork.dll','NebulaPatcher.dll')) {
        $path = 'plugins/' + $name
        $full = Join-Path $clientRoot ($path.Replace('/','\'))
        $clientFiles += ,[pscustomobject][ordered]@{path=$path;size=[int64](Get-Item $full).Length;sha256=Get-DysonHostnameWssFileDigest $full}
    }
    $treeBuilder = New-Object Text.StringBuilder
    foreach ($file in $clientFiles) {
        [void]$treeBuilder.Append($file.path).Append([char]0).Append([string]$file.size).Append([char]0).Append(
            ([string]$file.sha256).Substring(7)).Append("`n")
    }
    $clientManifest = [pscustomobject][ordered]@{
        protocol='DYSON_QUALIFIED_CLIENT_MANIFEST_V1';schemaVersion=1;qualificationId=$qualificationId
        createdAtUtc=ConvertTo-DysonQualificationV2Utc $now;files=$clientFiles
        treeSha256=Get-DysonQualificationV2Sha256 $treeBuilder.ToString();packageSha256=(& $digest 'a');manifestSha256=$null
    }
    $clientManifest.manifestSha256 = Get-DysonHostnameWssObjectDigest `
        (Get-DysonHostnameWssUnsignedValue -Value $clientManifest -ExcludedNames @('manifestSha256'))
    [void](Assert-DysonHostnameWssClientManifest -Manifest $clientManifest -ManifestSha256 (& $digest 'b') `
        -ClientRoot $clientRoot -ExpectedQualificationId $qualificationId -ExpectedPackageSha256 (& $digest 'a'))
    [IO.File]::WriteAllBytes((Join-Path $clientRoot 'plugins\NebulaNetwork.dll'), [byte[]](9,9,9,9))
    Assert-TestFailure { [void](Assert-DysonHostnameWssClientManifest -Manifest $clientManifest `
        -ManifestSha256 (& $digest 'b') -ClientRoot $clientRoot -ExpectedQualificationId $qualificationId `
        -ExpectedPackageSha256 (& $digest 'a')) } 'DYSON_HOSTNAME_WSS_CLIENT_FILES_INVALID' `
        'changed client bytes were accepted'
    Add-TestResult 'client-actual-bytes-rehashed'

    Assert-TestFailure { [void](Get-DysonHostnameWssFixedChildPath -Root $fullTestRoot -RelativePath '../escape') } `
        'DYSON_HOSTNAME_WSS_EVIDENCE_PATH_INVALID' 'path traversal was accepted'
    Add-TestResult 'path-escape-rejected'

    $schema = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dyson-nebula-hostname-wss-qualification-v1.schema.json') `
        -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-TestCondition ([string]$schema.properties.protocol.const -ceq 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1') `
        'schema protocol drifted'
    Assert-TestCondition ([bool]$schema.additionalProperties -eq $false) 'schema top-level is not exact-properties'
    Add-TestResult 'schema-parses-and-is-top-level-exact'

    [pscustomobject][ordered]@{
        protocol = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_SELFTEST_V1'
        schemaVersion = 1
        status = 'passed'
        runtime = 'Windows PowerShell 5.1 compatible'
        runtimeVersion = $PSVersionTable.PSVersion.ToString()
        testCount = $results.Count
        passedCount = $results.Count
        tests = @($results | ForEach-Object { $_ })
        exampleAuthorityOnly = [string]$fixture.authority
        productionEvidenceTouched = $false
        networkTouched = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
finally {
    if (Test-Path -LiteralPath $fullTestRoot) {
        $resolved = [IO.Path]::GetFullPath($fullTestRoot)
        if ($resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolved) -cmatch '^dyson-hostname-wss-selftest-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
