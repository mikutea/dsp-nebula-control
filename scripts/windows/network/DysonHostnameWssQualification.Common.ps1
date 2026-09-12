# Copyright (c) Dyson Control contributors.
# Strict validation and protected acceptance consumption for hostname-preserving Nebula WSS qualification.

Set-StrictMode -Version 2.0

$script:DysonHostnameWssProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1'
$script:DysonHostnameWssReceiptProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_COLLECTOR_RECEIPT_V1'
$script:DysonHostnameWssAcceptanceProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_ACCEPTANCE_V1'
$script:DysonHostnameWssClaimProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_REPLAY_CLAIM_V1'
$script:DysonHostnameWssSessionBindingProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_SESSION_BINDING_V1'
$script:DysonHostnameWssFlowBindingProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_FLOW_BINDING_V1'
$script:DysonHostnameWssConfirmation = 'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1'
$script:DysonHostnameWssSchemaVersion = 1
$script:DysonHostnameWssEvidenceTypes = @(
    'build-binary',
    'wss-transport',
    'passwall-route',
    'external-client'
)
$script:DysonHostnameWssCollectorIds = @(
    'nebula-private-build',
    'wss-edge-observer',
    'passwall-route-observer',
    'external-client-coordinator'
)
$script:DysonHostnameWssMaximumDocumentBytes = [int64](8MB)
$script:DysonHostnameWssMaximumArtifactBytes = [int64](1GB)
$script:DysonHostnameWssProjectionProperties = @(
    'qualificationId','runId','bindingSha256','expiresAtUtc','decision','blockerCodes'
)

# Bootstrap only fixed files from this release tree. Path and ACL semantics after
# bootstrap come from DysonPrivateEvidence.Common.ps1; they are not redefined here.
$script:DysonHostnameWssRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script:DysonHostnameWssDependencyPaths = [ordered]@{
    evidence = [IO.Path]::GetFullPath((Join-Path $script:DysonHostnameWssRepositoryRoot `
        'scripts\windows\evidence\DysonPrivateEvidence.Common.ps1'))
    qualificationV2 = [IO.Path]::GetFullPath((Join-Path $script:DysonHostnameWssRepositoryRoot `
        'scripts\windows\qualification\Qualification.ProtocolV2.ps1'))
    qualificationV1 = [IO.Path]::GetFullPath((Join-Path $script:DysonHostnameWssRepositoryRoot `
        'scripts\windows\qualification\Qualification.Protocol.ps1'))
    privateBuild = [IO.Path]::GetFullPath((Join-Path $script:DysonHostnameWssRepositoryRoot `
        'scripts\windows\nebula-private-build\NebulaPrivateBuild.Common.ps1'))
    privateBuildContract = [IO.Path]::GetFullPath((Join-Path $script:DysonHostnameWssRepositoryRoot `
        'scripts\windows\nebula-private-build\private-build-contract.v1.json'))
}
foreach ($dependencyPath in @($script:DysonHostnameWssDependencyPaths.Values)) {
    try { $dependencyItem = Get-Item -LiteralPath $dependencyPath -Force -ErrorAction Stop }
    catch { throw 'DYSON_HOSTNAME_WSS_FIXED_DEPENDENCY_INVALID' }
    if ($dependencyItem.PSIsContainer -or ($dependencyItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_HOSTNAME_WSS_FIXED_DEPENDENCY_INVALID'
    }
}
. $script:DysonHostnameWssDependencyPaths.evidence
foreach ($dependencyPath in @($script:DysonHostnameWssDependencyPaths.Values)) {
    try { [void](Assert-DysonPrivateEvidencePlainFile -Path $dependencyPath -MaximumBytes ([int64](4MB))) }
    catch { throw 'DYSON_HOSTNAME_WSS_FIXED_DEPENDENCY_INVALID' }
}
. $script:DysonHostnameWssDependencyPaths.qualificationV2
. $script:DysonHostnameWssDependencyPaths.qualificationV1
. $script:DysonHostnameWssDependencyPaths.privateBuild

function New-DysonHostnameWssException {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonHostnameWssError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonHostnameWssException -Code $Code)
}

function Get-DysonHostnameWssErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '(DYSON_HOSTNAME_WSS_[A-Z0-9_]+)') { return [string]$Matches[1] }
    return 'DYSON_HOSTNAME_WSS_VALIDATION_FAILED'
}

function Assert-DysonHostnameWssExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    try { Assert-DysonPrivateEvidenceExactProperties -Value $Value -Expected $Names -Name 'hostname-wss value' }
    catch { Throw-DysonHostnameWssError -Code $Code }
}

function Test-DysonHostnameWssUuid {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        return $false
    }
    return Test-DysonQualificationV2Uuid -Value $Value
}

function Test-DysonHostnameWssDigest {
    param([AllowNull()][string]$Value)
    return Test-DysonQualificationV2Digest -Value $Value
}

function Test-DysonHostnameWssIdentifier {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cnotmatch '^[a-z0-9][a-z0-9._-]{6,126}[a-z0-9]$' -or
        $Value.Contains('..')) { return $false }
    try { [void](Assert-DysonPrivateEvidenceIdentifier -Value $Value -Name 'hostname-wss identifier'); return $true }
    catch { return $false }
}

function Test-DysonHostnameWssJsonInteger {
    param([AllowNull()]$Value, [int64]$Minimum = 0, [int64]$Maximum = 9007199254740991)
    if (-not (Test-DysonQualificationV2Integer -Value $Value)) { return $false }
    $number = [int64]$Value
    return $number -ge $Minimum -and $number -le $Maximum
}

function ConvertFrom-DysonHostnameWssUtc {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Code)
    try { return ConvertFrom-DysonQualificationV2Utc -Value $Value -Code $Code }
    catch { Throw-DysonHostnameWssError -Code $Code }
}

function Get-DysonHostnameWssUnsignedValue {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$ExcludedNames)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object -Property Name -CaseSensitive)) {
        if ($ExcludedNames -cnotcontains [string]$property.Name) { $result[$property.Name] = $property.Value }
    }
    return [pscustomobject]$result
}

function Get-DysonHostnameWssObjectDigest {
    param([Parameter(Mandatory)]$Value)
    return Get-DysonQualificationV2ObjectDigest -Value $Value
}

function Get-DysonHostnameWssFileDigest {
    param([Parameter(Mandatory)][string]$Path)
    return 'sha256:' + (Get-DysonPrivateEvidenceFileSha256 -Path $Path)
}

function Get-DysonHostnameWssHmac {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][byte[]]$Key
    )
    if ($Key.Length -ne 32) { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID' }
    $text = ConvertTo-DysonQualificationV2CanonicalJson -Value $Value
    $bytes = (New-Object System.Text.UTF8Encoding -ArgumentList $false).GetBytes($text)
    $algorithm = New-Object System.Security.Cryptography.HMACSHA256
    try {
        $algorithm.Key = $Key
        return 'sha256:' + ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Test-DysonHostnameWssFixedTimeDigest {
    param([AllowNull()][string]$Actual, [AllowNull()][string]$Expected)
    if (-not (Test-DysonHostnameWssDigest -Value $Actual) -or
        -not (Test-DysonHostnameWssDigest -Value $Expected)) { return $false }
    $actualBytes = New-Object byte[] 32
    $expectedBytes = New-Object byte[] 32
    try {
        for ($index = 0; $index -lt 32; $index++) {
            $actualBytes[$index] = [Convert]::ToByte($Actual.Substring(7 + ($index * 2), 2), 16)
            $expectedBytes[$index] = [Convert]::ToByte($Expected.Substring(7 + ($index * 2), 2), 16)
        }
    }
    catch { return $false }
    $difference = 0
    for ($index = 0; $index -lt 32; $index++) {
        $difference = $difference -bor ($actualBytes[$index] -bxor $expectedBytes[$index])
    }
    return $difference -eq 0
}

function Read-DysonHostnameWssJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = $script:DysonHostnameWssMaximumDocumentBytes,
        [switch]$RequireCanonical
    )
    try {
        $item = Assert-DysonPrivateEvidencePlainFile -Path $Path -MaximumBytes $MaximumBytes
        $bytes = [IO.File]::ReadAllBytes($item.FullName)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
            throw 'bom'
        }
        $strictUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
        $text = $strictUtf8.GetString($bytes)
        if ($text -match '[\x00-\x08\x0b\x0c\x0e-\x1f]') { throw 'control character' }
        $value = $text | ConvertFrom-Json -ErrorAction Stop
        if ($RequireCanonical) {
            if ($text -cne (ConvertTo-DysonQualificationV2CanonicalJson -Value $value)) { throw 'not canonical' }
        }
        return [pscustomobject][ordered]@{
            path = $item.FullName
            value = $value
            sha256 = Get-DysonHostnameWssFileDigest -Path $item.FullName
        }
    }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EVIDENCE_FILE_INVALID' }
}

function Get-DysonHostnameWssKeyFromRing {
    param(
        [Parameter(Mandatory)][string]$KeyRingRoot,
        [Parameter(Mandatory)][string]$KeyId
    )
    if (-not (Test-DysonHostnameWssIdentifier -Value $KeyId)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID'
    }
    try {
        $root = Assert-DysonPrivateEvidenceSafeRoot -Path $KeyRingRoot -Name 'KeyRingRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $root)
        [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $root)
        $path = [IO.Path]::GetFullPath((Join-Path $root ($KeyId + '.key')))
        $relative = Get-DysonPrivateEvidenceRelativePath -Root $root -File $path
        if ($relative -cne ($KeyId + '.key')) { throw 'key escaped' }
        $item = Assert-DysonPrivateEvidencePlainFile -Path $path -MaximumBytes 32
        if ([int64]$item.Length -ne 32) { throw 'key length' }
        return [IO.File]::ReadAllBytes($item.FullName)
    }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID' }
}

function New-DysonHostnameWssCollectorReceipt {
    param(
        [Parameter(Mandatory)][string]$ReceiptId,
        [Parameter(Mandatory)][string]$QualificationId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$CollectorId,
        [Parameter(Mandatory)][string]$KeyId,
        [Parameter(Mandatory)][int]$Sequence,
        [Parameter(Mandatory)][string]$EvidenceType,
        [Parameter(Mandatory)]$ChallengeIds,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$ExpiresAtUtc,
        [AllowNull()][string]$PreviousReceiptSha256,
        [Parameter(Mandatory)][string]$EvidenceSha256,
        [Parameter(Mandatory)][byte[]]$Key
    )
    $receipt = [pscustomobject][ordered]@{
        protocol = $script:DysonHostnameWssReceiptProtocol
        schemaVersion = 1
        receiptId = $ReceiptId
        qualificationId = $QualificationId
        runId = $RunId
        collectorId = $CollectorId
        keyId = $KeyId
        sequence = $Sequence
        evidenceType = $EvidenceType
        challengeIds = $ChallengeIds
        sessionId = $SessionId
        nonce = $Nonce
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ObservedAtUtc
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $ExpiresAtUtc
        previousReceiptSha256 = if ($Sequence -eq 1) { $null } else { $PreviousReceiptSha256 }
        evidenceSha256 = $EvidenceSha256
        receiptSha256 = $null
        hmacSha256 = $null
    }
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $receipt -ExcludedNames @('receiptSha256','hmacSha256')
    $receipt.receiptSha256 = Get-DysonHostnameWssObjectDigest -Value $unsigned
    $receipt.hmacSha256 = Get-DysonHostnameWssHmac -Value $unsigned -Key $Key
    return $receipt
}

function Assert-DysonHostnameWssChallengeIds {
    param([Parameter(Mandatory)]$ChallengeIds)
    $code = 'DYSON_HOSTNAME_WSS_CHALLENGE_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $ChallengeIds -Names @('initial','reconnect') -Code $code
    if (-not (Test-DysonHostnameWssUuid -Value ([string]$ChallengeIds.initial)) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$ChallengeIds.reconnect)) -or
        [string]$ChallengeIds.initial -ceq [string]$ChallengeIds.reconnect) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssNonce {
    param([Parameter(Mandatory)][string]$Nonce)
    if ($Nonce -cnotmatch '^[A-Za-z0-9_-]{43}$') {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_NONCE_INVALID'
    }
    try {
        $bytes = [Convert]::FromBase64String($Nonce.Replace('-', '+').Replace('_', '/') + '=')
        if ($bytes.Length -ne 32) { throw 'invalid nonce length' }
    }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_NONCE_INVALID' }
}

function Assert-DysonHostnameWssCollectorReceipt {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][int]$ExpectedSequence,
        [Parameter(Mandatory)][string]$ExpectedEvidenceType,
        [Parameter(Mandatory)][string]$ExpectedCollectorId,
        [Parameter(Mandatory)][string]$ExpectedQualificationId,
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)]$ExpectedChallengeIds,
        [Parameter(Mandatory)][string]$ExpectedSessionId,
        [AllowNull()][string]$ExpectedPreviousReceiptSha256,
        [Parameter(Mandatory)][string]$ExpectedEvidenceSha256,
        [Parameter(Mandatory)][datetimeoffset]$DocumentIssuedAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$DocumentExpiresAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$KeyResolver
    )
    $code = 'DYSON_HOSTNAME_WSS_COLLECTOR_RECEIPT_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Receipt -Names @(
        'protocol','schemaVersion','receiptId','qualificationId','runId','collectorId','keyId',
        'sequence','evidenceType','challengeIds','sessionId','nonce','observedAtUtc','expiresAtUtc',
        'previousReceiptSha256','evidenceSha256','receiptSha256','hmacSha256'
    ) -Code $code
    if ([string]$Receipt.protocol -cne $script:DysonHostnameWssReceiptProtocol -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Receipt.schemaVersion -Minimum 1 -Maximum 1) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Receipt.receiptId)) -or
        [string]$Receipt.qualificationId -cne $ExpectedQualificationId -or
        [string]$Receipt.runId -cne $ExpectedRunId -or
        [string]$Receipt.collectorId -cne $ExpectedCollectorId -or
        -not (Test-DysonHostnameWssIdentifier -Value ([string]$Receipt.keyId)) -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Receipt.sequence -Minimum $ExpectedSequence -Maximum $ExpectedSequence) -or
        [string]$Receipt.evidenceType -cne $ExpectedEvidenceType -or
        [string]$Receipt.sessionId -cne $ExpectedSessionId -or
        [string]$Receipt.evidenceSha256 -cne $ExpectedEvidenceSha256 -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Receipt.receiptSha256)) -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Receipt.hmacSha256))) {
        Throw-DysonHostnameWssError -Code $code
    }
    Assert-DysonHostnameWssChallengeIds -ChallengeIds $Receipt.challengeIds
    if ([string]$Receipt.challengeIds.initial -cne [string]$ExpectedChallengeIds.initial -or
        [string]$Receipt.challengeIds.reconnect -cne [string]$ExpectedChallengeIds.reconnect) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CHALLENGE_INVALID'
    }
    Assert-DysonHostnameWssNonce -Nonce ([string]$Receipt.nonce)
    if ($ExpectedSequence -eq 1) {
        if ($null -ne $Receipt.previousReceiptSha256) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_CHAIN_INVALID'
        }
    }
    elseif ([string]$Receipt.previousReceiptSha256 -cne [string]$ExpectedPreviousReceiptSha256) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_CHAIN_INVALID'
    }
    $observed = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Receipt.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Receipt.expiresAtUtc) -Code $code
    if ($observed -lt $DocumentIssuedAtUtc -or $observed -gt $NowUtc -or
        $expires -le $observed -or $expires -gt $observed.AddHours(2) -or
        $expires -gt $DocumentExpiresAtUtc -or $NowUtc -ge $expires) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EVIDENCE_STALE'
    }
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $Receipt -ExcludedNames @('receiptSha256','hmacSha256')
    $expectedDigest = Get-DysonHostnameWssObjectDigest -Value $unsigned
    if (-not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Receipt.receiptSha256) -Expected $expectedDigest)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_DIGEST_INVALID'
    }
    try { [byte[]]$key = & $KeyResolver ([string]$Receipt.keyId) }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID' }
    try {
        $expectedHmac = Get-DysonHostnameWssHmac -Value $unsigned -Key $key
        if (-not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Receipt.hmacSha256) -Expected $expectedHmac)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_HMAC_INVALID'
        }
    }
    finally { if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) } }
    return [pscustomobject][ordered]@{ observedAtUtc = $observed; expiresAtUtc = $expires }
}

function Assert-DysonHostnameWssCollectorReceiptChain {
    param(
        [Parameter(Mandatory)][object[]]$Receipts,
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ExpectedSessionBindingSha256,
        [Parameter(Mandatory)][datetimeoffset]$DocumentIssuedAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$DocumentExpiresAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$KeyResolver
    )
    if (@($Receipts).Count -ne 4) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_CHAIN_INVALID'
    }
    $challengeIds = [pscustomobject][ordered]@{
        initial = [string]$Document.externalClientBinding.initialChallengeId
        reconnect = [string]$Document.externalClientBinding.reconnectChallengeId
    }
    $sessionId = [string]$Receipts[0].sessionId
    if (-not (Test-DysonHostnameWssUuid -Value $sessionId)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_SESSION_INVALID'
    }
    $expectedEvidence = @(
        (Get-DysonHostnameWssObjectDigest -Value ([ordered]@{
            contractBinding = $Document.contractBinding
            binaryBinding = $Document.binaryBinding
        })),
        (Get-DysonHostnameWssObjectDigest -Value $Document.transportBinding),
        (Get-DysonHostnameWssObjectDigest -Value $Document.routeBinding),
        (Get-DysonHostnameWssObjectDigest -Value $Document.externalClientBinding)
    )
    $receiptIds = @{}
    $nonces = @{}
    $keyIds = @{}
    $previous = $null
    $previousObserved = [datetimeoffset]::MinValue
    for ($index = 0; $index -lt 4; $index++) {
        $receipt = $Receipts[$index]
        $timing = Assert-DysonHostnameWssCollectorReceipt -Receipt $receipt `
            -ExpectedSequence ($index + 1) -ExpectedEvidenceType $script:DysonHostnameWssEvidenceTypes[$index] `
            -ExpectedCollectorId $script:DysonHostnameWssCollectorIds[$index] `
            -ExpectedQualificationId ([string]$Document.qualificationId) -ExpectedRunId ([string]$Document.runId) `
            -ExpectedChallengeIds $challengeIds -ExpectedSessionId $sessionId `
            -ExpectedPreviousReceiptSha256 $previous -ExpectedEvidenceSha256 $expectedEvidence[$index] `
            -DocumentIssuedAtUtc $DocumentIssuedAtUtc -DocumentExpiresAtUtc $DocumentExpiresAtUtc `
            -NowUtc $NowUtc -KeyResolver $KeyResolver
        foreach ($uniqueField in @('receiptId','nonce')) {
            $value = [string]$receipt.$uniqueField
            $set = if ($uniqueField -ceq 'receiptId') { $receiptIds } else { $nonces }
            if ($set.ContainsKey($value)) {
                Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_REPLAYED'
            }
            $set[$value] = $true
        }
        $keyId = [string]$receipt.keyId
        if ($keyIds.ContainsKey($keyId)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_COLLECTOR_KEY_REUSED'
        }
        $keyIds[$keyId] = $true
        if ($timing.observedAtUtc -lt $previousObserved) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_CHAIN_INVALID'
        }
        $previousObserved = $timing.observedAtUtc
        $previous = [string]$receipt.receiptSha256
    }
    if ($keyIds.ContainsKey([string]$Document.protection.keyId)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_SIGNER_ROLE_NOT_SEPARATED'
    }
    if ([string]$Document.transportBinding.sessionBindingSha256 -cne $ExpectedSessionBindingSha256 -or
        [string]$Document.routeBinding.sessionBindingSha256 -cne $ExpectedSessionBindingSha256) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_SESSION_BINDING_INVALID'
    }
    return [pscustomobject][ordered]@{ sessionId = $sessionId; terminalReceiptSha256 = $previous }
}

function Assert-DysonHostnameWssCanonicalAuthority {
    param(
        [Parameter(Mandatory)][string]$Authority,
        [Parameter(Mandatory)][string]$Code
    )
    try {
        if ([string]::IsNullOrWhiteSpace($Authority) -or $Authority.Length -gt 253 -or
            $Authority.EndsWith('.') -or $Authority.Contains('..') -or $Authority -ceq 'localhost') {
            throw 'invalid authority'
        }
        $idn = New-Object System.Globalization.IdnMapping
        $ascii = $idn.GetAscii($Authority).ToLowerInvariant()
        if ($Authority -cne $ascii -or
            $ascii -cnotmatch '^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$') {
            throw 'authority is not a canonical public DNS name'
        }
        foreach ($label in @($ascii.Split('.'))) {
            if ($label.Length -lt 1 -or $label.Length -gt 63) { throw 'invalid label length' }
        }
        return $ascii
    }
    catch { Throw-DysonHostnameWssError -Code $Code }
}

function Assert-DysonHostnameWssDigestProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    foreach ($name in $Names) {
        if (-not (Test-DysonHostnameWssDigest -Value ([string]$Value.$name))) {
            Throw-DysonHostnameWssError -Code $Code
        }
    }
}

function Assert-DysonHostnameWssSubject {
    param(
        [Parameter(Mandatory)]$Subject,
        [Parameter(Mandatory)][string]$ExpectedAuthority,
        [Parameter(Mandatory)][int]$ExpectedPort
    )
    $code = 'DYSON_HOSTNAME_WSS_SUBJECT_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Subject -Names @(
        'topology','transport','authority','port','websocketPath','authoritySemantics'
    ) -Code $code
    $canonicalExpected = Assert-DysonHostnameWssCanonicalAuthority -Authority $ExpectedAuthority -Code $code
    $canonicalActual = Assert-DysonHostnameWssCanonicalAuthority -Authority ([string]$Subject.authority) -Code $code
    if ($ExpectedPort -ne 443 -or -not (Test-DysonHostnameWssJsonInteger -Value $Subject.port -Minimum 443 -Maximum 443) -or
        $canonicalActual -cne $canonicalExpected -or [string]$Subject.topology -cne 'http-websocket-tunnel' -or
        [string]$Subject.transport -cne 'wss' -or [string]$Subject.websocketPath -cne '/socket' -or
        [string]$Subject.authoritySemantics -cne 'hostname-preserved') {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssContractBinding {
    param([Parameter(Mandatory)]$Binding)
    $code = 'DYSON_HOSTNAME_WSS_CONTRACT_BINDING_INVALID'
    $names = @(
        'sourcePatchContractSha256','privateBuildContractSha256','upstreamCommit','patchSha256',
        'binaryMetadataASha256','binaryMetadataBSha256','candidateManifestSha256','candidateTreeSha256',
        'clientManifestSha256','clientPackageSha256','profileInputSha256','serverLockSha256',
        'clientParitySha256','compatibilityPolicySha256'
    )
    Assert-DysonHostnameWssExactProperties -Value $Binding -Names $names -Code $code
    Assert-DysonHostnameWssDigestProperties -Value $Binding -Names @(
        'sourcePatchContractSha256','privateBuildContractSha256','patchSha256','binaryMetadataASha256',
        'binaryMetadataBSha256','candidateManifestSha256','candidateTreeSha256','clientManifestSha256',
        'clientPackageSha256','profileInputSha256','serverLockSha256','clientParitySha256',
        'compatibilityPolicySha256'
    ) -Code $code
    if ([string]$Binding.upstreamCommit -cnotmatch '^[0-9a-f]{40}$') {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssBinaryEntry {
    param(
        [Parameter(Mandatory)]$Entry,
        [Parameter(Mandatory)][string]$ExpectedRole,
        [Parameter(Mandatory)][string]$ExpectedFileName
    )
    $code = 'DYSON_HOSTNAME_WSS_BINARY_BINDING_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Entry -Names @('role','fileName','sha256','mvid') -Code $code
    if ([string]$Entry.role -cne $ExpectedRole -or [string]$Entry.fileName -cne $ExpectedFileName -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Entry.sha256)) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Entry.mvid))) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssBinaryBinding {
    param([Parameter(Mandatory)]$Binding)
    $code = 'DYSON_HOSTNAME_WSS_BINARY_BINDING_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Binding -Names @('candidate','client') -Code $code
    if (@($Binding.candidate).Count -ne 2 -or @($Binding.client).Count -ne 2) {
        Throw-DysonHostnameWssError -Code $code
    }
    $roles = @('nebula-network','nebula-patcher')
    $files = @('NebulaNetwork.dll','NebulaPatcher.dll')
    for ($index = 0; $index -lt 2; $index++) {
        Assert-DysonHostnameWssBinaryEntry -Entry $Binding.candidate[$index] -ExpectedRole $roles[$index] -ExpectedFileName $files[$index]
        Assert-DysonHostnameWssBinaryEntry -Entry $Binding.client[$index] -ExpectedRole $roles[$index] -ExpectedFileName $files[$index]
        if ([string]$Binding.client[$index].sha256 -cne [string]$Binding.candidate[$index].sha256 -or
            [string]$Binding.client[$index].mvid -cne [string]$Binding.candidate[$index].mvid) {
            Throw-DysonHostnameWssError -Code $code
        }
    }
}

function Assert-DysonHostnameWssTransportBinding {
    param([Parameter(Mandatory)]$Document)
    $code = 'DYSON_HOSTNAME_WSS_TRANSPORT_BINDING_INVALID'
    $binding = $Document.transportBinding
    Assert-DysonHostnameWssExactProperties -Value $binding -Names @(
        'sniAuthority','hostHeaderAuthority','websocketPath','tlsProtocol','httpStatusCode','ingressProvider',
        'ingressConfigSha256','originBindingSha256','websocketTranscriptSha256','sessionBindingSha256'
    ) -Code $code
    Assert-DysonHostnameWssDigestProperties -Value $binding -Names @(
        'ingressConfigSha256','originBindingSha256','websocketTranscriptSha256','sessionBindingSha256'
    ) -Code $code
    $authority = [string]$Document.subject.authority
    if ([string]$binding.sniAuthority -cne $authority -or
        [string]$binding.hostHeaderAuthority -cne ($authority + ':443') -or
        [string]$binding.websocketPath -cne '/socket' -or
        [string]$binding.tlsProtocol -cnotin @('tls12','tls13') -or
        -not (Test-DysonHostnameWssJsonInteger -Value $binding.httpStatusCode -Minimum 101 -Maximum 101) -or
        [string]$binding.ingressProvider -cne 'cloudflare-tunnel') {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssRouteCounters {
    param([Parameter(Mandatory)]$Counters, [Parameter(Mandatory)][string]$Code)
    Assert-DysonHostnameWssExactProperties -Value $Counters -Names @(
        'packetsBefore','packetsAfter','bytesBefore','bytesAfter'
    ) -Code $Code
    foreach ($name in @('packetsBefore','packetsAfter','bytesBefore','bytesAfter')) {
        if (-not (Test-DysonHostnameWssJsonInteger -Value $Counters.$name)) {
            Throw-DysonHostnameWssError -Code $Code
        }
    }
}

function Assert-DysonHostnameWssRouteBinding {
    param([Parameter(Mandatory)]$Binding)
    $code = 'DYSON_HOSTNAME_WSS_ROUTE_BINDING_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Binding -Names @(
        'ruleRevisionBefore','ruleRevisionAfter','ruleIdentitySha256','flowBindingSha256','sessionBindingSha256',
        'directCounters','proxyCounters'
    ) -Code $code
    Assert-DysonHostnameWssDigestProperties -Value $Binding -Names @(
        'ruleIdentitySha256','flowBindingSha256','sessionBindingSha256'
    ) -Code $code
    Assert-DysonHostnameWssRouteCounters -Counters $Binding.directCounters -Code $code
    Assert-DysonHostnameWssRouteCounters -Counters $Binding.proxyCounters -Code $code
    if (-not (Test-DysonHostnameWssJsonInteger -Value $Binding.ruleRevisionBefore -Minimum 1) -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Binding.ruleRevisionAfter -Minimum 1) -or
        [int64]$Binding.ruleRevisionBefore -ne [int64]$Binding.ruleRevisionAfter -or
        [int64]$Binding.directCounters.packetsAfter -le [int64]$Binding.directCounters.packetsBefore -or
        [int64]$Binding.directCounters.bytesAfter -le [int64]$Binding.directCounters.bytesBefore -or
        [int64]$Binding.proxyCounters.packetsAfter -ne [int64]$Binding.proxyCounters.packetsBefore -or
        [int64]$Binding.proxyCounters.bytesAfter -ne [int64]$Binding.proxyCounters.bytesBefore) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssExternalClientBinding {
    param([Parameter(Mandatory)]$Binding)
    $code = 'DYSON_HOSTNAME_WSS_EXTERNAL_BINDING_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Binding -Names @(
        'receiptChainSha256','receiptCount','terminalReceiptSha256','joinReceiptSha256','reconnectReceiptSha256',
        'initialChallengeId','reconnectChallengeId','transcriptBindingSha256','sessionBindingSha256',
        'observedAtUtc','expiresAtUtc'
    ) -Code $code
    Assert-DysonHostnameWssDigestProperties -Value $Binding -Names @(
        'receiptChainSha256','terminalReceiptSha256','joinReceiptSha256','reconnectReceiptSha256',
        'transcriptBindingSha256','sessionBindingSha256'
    ) -Code $code
    if (-not (Test-DysonHostnameWssJsonInteger -Value $Binding.receiptCount -Minimum 11 -Maximum 11) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Binding.initialChallengeId)) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Binding.reconnectChallengeId)) -or
        [string]$Binding.initialChallengeId -ceq [string]$Binding.reconnectChallengeId) {
        Throw-DysonHostnameWssError -Code $code
    }
    $observed = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Binding.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Binding.expiresAtUtc) -Code $code
    if ($expires -le $observed -or $expires -gt $observed.AddHours(24)) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Get-DysonHostnameWssSessionBindingDigest {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$SessionId
    )
    return Get-DysonHostnameWssObjectDigest -Value ([ordered]@{
        protocol = $script:DysonHostnameWssSessionBindingProtocol
        qualificationId = [string]$Document.qualificationId
        runId = [string]$Document.runId
        sessionId = $SessionId
        initialChallengeId = [string]$Document.externalClientBinding.initialChallengeId
        reconnectChallengeId = [string]$Document.externalClientBinding.reconnectChallengeId
        externalReceiptChainSha256 = [string]$Document.externalClientBinding.receiptChainSha256
        externalTerminalReceiptSha256 = [string]$Document.externalClientBinding.terminalReceiptSha256
    })
}

function Get-DysonHostnameWssFlowBindingDigest {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$SessionBindingSha256
    )
    return Get-DysonHostnameWssObjectDigest -Value ([ordered]@{
        protocol = $script:DysonHostnameWssFlowBindingProtocol
        qualificationId = [string]$Document.qualificationId
        runId = [string]$Document.runId
        sessionId = $SessionId
        sessionBindingSha256 = $SessionBindingSha256
        websocketTranscriptSha256 = [string]$Document.transportBinding.websocketTranscriptSha256
        ruleIdentitySha256 = [string]$Document.routeBinding.ruleIdentitySha256
    })
}

function Assert-DysonHostnameWssDocumentStructure {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ExpectedQualificationId,
        [Parameter(Mandatory)][string]$ExpectedAuthority,
        [Parameter(Mandatory)][int]$ExpectedPort,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )
    $code = 'DYSON_HOSTNAME_WSS_DOCUMENT_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Document -Names @(
        'protocol','schemaVersion','qualificationId','runId','issuedAtUtc','expiresAtUtc','subject',
        'contractBinding','binaryBinding','transportBinding','routeBinding','externalClientBinding',
        'receiptChain','documentSha256','protection'
    ) -Code $code
    if ([string]$Document.protocol -cne $script:DysonHostnameWssProtocol -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Document.schemaVersion -Minimum 1 -Maximum 1) -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Document.qualificationId)) -or
        [string]$Document.qualificationId -cne $ExpectedQualificationId -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Document.runId)) -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Document.documentSha256))) {
        Throw-DysonHostnameWssError -Code $code
    }
    $issued = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.issuedAtUtc) -Code $code
    $expires = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.expiresAtUtc) -Code $code
    if ($expires -le $issued -or $expires -gt $issued.AddHours(2) -or $issued -gt $NowUtc.AddMinutes(1) -or
        $NowUtc -lt $issued -or $NowUtc -ge $expires) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_DOCUMENT_STALE'
    }
    Assert-DysonHostnameWssSubject -Subject $Document.subject -ExpectedAuthority $ExpectedAuthority -ExpectedPort $ExpectedPort
    Assert-DysonHostnameWssContractBinding -Binding $Document.contractBinding
    Assert-DysonHostnameWssBinaryBinding -Binding $Document.binaryBinding
    Assert-DysonHostnameWssTransportBinding -Document $Document
    Assert-DysonHostnameWssRouteBinding -Binding $Document.routeBinding
    Assert-DysonHostnameWssExternalClientBinding -Binding $Document.externalClientBinding
    Assert-DysonHostnameWssExactProperties -Value $Document.protection -Names @('algorithm','keyId','hmacSha256') -Code $code
    if ([string]$Document.protection.algorithm -cne 'hmac-sha256' -or
        -not (Test-DysonHostnameWssIdentifier -Value ([string]$Document.protection.keyId)) -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Document.protection.hmacSha256))) {
        Throw-DysonHostnameWssError -Code $code
    }
    return [pscustomobject][ordered]@{ issuedAtUtc = $issued; expiresAtUtc = $expires }
}

function Assert-DysonHostnameWssDocumentProtection {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][scriptblock]$KeyResolver
    )
    $core = Get-DysonHostnameWssUnsignedValue -Value $Document -ExcludedNames @('documentSha256','protection')
    $expectedDigest = Get-DysonHostnameWssObjectDigest -Value $core
    if (-not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Document.documentSha256) -Expected $expectedDigest)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_DOCUMENT_DIGEST_INVALID'
    }
    try { [byte[]]$key = & $KeyResolver ([string]$Document.protection.keyId) }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID' }
    $payload = [ordered]@{
        domain = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1_DOCUMENT'
        keyId = [string]$Document.protection.keyId
        documentSha256 = [string]$Document.documentSha256
    }
    try {
        $expectedHmac = Get-DysonHostnameWssHmac -Value $payload -Key $key
        if (-not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Document.protection.hmacSha256) -Expected $expectedHmac)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_DOCUMENT_HMAC_INVALID'
        }
    }
    finally { if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) } }
}

function Get-DysonHostnameWssExternalClientMaterial {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )
    $code = 'DYSON_HOSTNAME_WSS_EXTERNAL_RECEIPTS_INVALID'
    try {
        $file = Read-DysonHostnameWssJsonFile -Path $Path -RequireCanonical
        [object[]]$receipts = @($file.value)
        if ($receipts.Count -ne 11) { throw $code }
        [void](Assert-DysonExternalClientReceiptSequence -Receipts $receipts -NowUtc $NowUtc)
        $transcript = Test-DysonExternalClientTranscript -Receipts $receipts -NowUtc $NowUtc
        if (-not $transcript.valid -or -not $transcript.realJoinProven -or
            -not $transcript.independentSaveAcknowledgementProven -or -not $transcript.reconnectProven) {
            throw $code
        }
        for ($index = 0; $index -lt $receipts.Count; $index++) {
            $expectedStatus = if ($index -eq 10) { 'passed' } else { 'observed' }
            if ([string]$receipts[$index].status -cne $expectedStatus -or
                [string]$receipts[$index].runId -cne [string]$Document.runId) {
                throw $code
            }
        }
        $firstObserved = ConvertFrom-DysonQualificationUtcTimestamp `
            ([string]$receipts[0].evidenceRef.observedAtUtc) 'evidenceRef.observedAtUtc'
        $earliestExpiry = [datetimeoffset]::MaxValue
        foreach ($receipt in $receipts) {
            foreach ($expiryValue in @([string]$receipt.expiresAtUtc, [string]$receipt.evidenceRef.expiresAtUtc)) {
                $expiry = ConvertFrom-DysonQualificationUtcTimestamp $expiryValue 'external expiry'
                if ($expiry -lt $earliestExpiry) { $earliestExpiry = $expiry }
            }
        }
        if ($firstObserved -gt $NowUtc -or $NowUtc -ge $earliestExpiry) { throw $code }
        $receiptChainSha256 = Get-DysonHostnameWssObjectDigest -Value $receipts
        if ($receiptChainSha256 -cne [string]$file.sha256) { throw $code }
        $material = [pscustomobject][ordered]@{
            receiptChainSha256 = $receiptChainSha256
            receiptCount = 11
            terminalReceiptSha256 = 'sha256:' + [string]$receipts[10].receiptSha256
            joinReceiptSha256 = 'sha256:' + [string]$receipts[3].receiptSha256
            reconnectReceiptSha256 = 'sha256:' + [string]$receipts[9].receiptSha256
            initialChallengeId = [string]$receipts[0].challengeId
            reconnectChallengeId = [string]$receipts[8].challengeId
            transcriptBindingSha256 = 'sha256:' + [string]$receipts[10].publicSummary.transcriptBindingSha256
            sessionBindingSha256 = $null
            observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $firstObserved
            expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $earliestExpiry
        }
        $bindingDocument = [pscustomobject][ordered]@{
            qualificationId = [string]$Document.qualificationId
            runId = [string]$Document.runId
            externalClientBinding = $material
        }
        $material.sessionBindingSha256 = Get-DysonHostnameWssSessionBindingDigest `
            -Document $bindingDocument -SessionId $SessionId
        return [pscustomobject][ordered]@{ binding = $material; receipts = $receipts; fileSha256 = $file.sha256 }
    }
    catch {
        if ($_.Exception.Message -cmatch '^DYSON_HOSTNAME_WSS_') { throw }
        Throw-DysonHostnameWssError -Code $code
    }
}

function ConvertTo-DysonHostnameWssPrettyJsonValue {
    param(
        [Parameter(Mandatory)][AllowNull()]$Value,
        [int]$Depth = 0
    )
    if ($Depth -gt 32) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_PROFILE_MANIFEST_INVALID'
    }
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [int] -or $Value -is [long]) {
        return ([int64]$Value).ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [string]) {
        return ConvertTo-DysonQualificationV2CanonicalJson -Value ([string]$Value)
    }
    if ($Value -is [array]) {
        [object[]]$items = @($Value)
        if ($items.Count -eq 0) { return '[]' }
        $lines = New-Object 'System.Collections.Generic.List[string]'
        foreach ($item in $items) {
            $lines.Add(('  ' * ($Depth + 1)) +
                (ConvertTo-DysonHostnameWssPrettyJsonValue -Value $item -Depth ($Depth + 1)))
        }
        return "[`n" + ($lines -join ",`n") + "`n" + ('  ' * $Depth) + ']'
    }
    if ($Value -is [Collections.IDictionary] -or $Value -is [pscustomobject]) {
        $properties = @($Value.PSObject.Properties)
        if ($Value -is [Collections.IDictionary]) {
            $properties = @($Value.GetEnumerator() | ForEach-Object {
                [pscustomobject][ordered]@{ Name = [string]$_.Key; Value = $_.Value }
            })
        }
        if ($properties.Count -eq 0) { return '{}' }
        $lines = New-Object 'System.Collections.Generic.List[string]'
        foreach ($property in $properties) {
            $name = ConvertTo-DysonQualificationV2CanonicalJson -Value ([string]$property.Name)
            $rendered = ConvertTo-DysonHostnameWssPrettyJsonValue -Value $property.Value -Depth ($Depth + 1)
            $lines.Add(('  ' * ($Depth + 1)) + $name + ': ' + $rendered)
        }
        return "{`n" + ($lines -join ",`n") + "`n" + ('  ' * $Depth) + '}'
    }
    Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_PROFILE_MANIFEST_INVALID'
}

function Get-DysonHostnameWssPrettyJsonDigest {
    param([Parameter(Mandatory)]$Value)
    $json = (ConvertTo-DysonHostnameWssPrettyJsonValue -Value $Value) + "`n"
    return Get-DysonQualificationV2Sha256 -Value $json
}

function Test-DysonHostnameWssThunderstoreVersion {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value -cnotmatch '^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$') {
        return $false
    }
    foreach ($part in @($Value.Split('.'))) {
        [int64]$number = 0
        if (-not [int64]::TryParse($part, [Globalization.NumberStyles]::None,
                [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or
            $number -gt 2147483647) { return $false }
    }
    return $true
}

function Get-DysonHostnameWssProfileManifestDigests {
    param(
        [Parameter(Mandatory)]$ServerLock,
        [Parameter(Mandatory)]$ClientParity
    )
    $code = 'DYSON_HOSTNAME_WSS_PROFILE_MANIFEST_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $ServerLock -Names @('format','schemaVersion','mods') -Code $code
    Assert-DysonHostnameWssExactProperties -Value $ClientParity `
        -Names @('format','schemaVersion','serverLockSha256','mods') -Code $code
    if ([string]$ServerLock.format -cne 'dyson-control-server-mod-lock' -or
        -not (Test-DysonHostnameWssJsonInteger -Value $ServerLock.schemaVersion -Minimum 1 -Maximum 1) -or
        [string]$ClientParity.format -cne 'dyson-control-client-parity' -or
        -not (Test-DysonHostnameWssJsonInteger -Value $ClientParity.schemaVersion -Minimum 1 -Maximum 1) -or
        [string]$ClientParity.serverLockSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $ServerLock.mods -isnot [array] -or $ClientParity.mods -isnot [array]) {
        Throw-DysonHostnameWssError -Code $code
    }
    [object[]]$serverMods = @($ServerLock.mods)
    [object[]]$clientMods = @($ClientParity.mods)
    if ($serverMods.Count -lt 1 -or $serverMods.Count -gt 512 -or $clientMods.Count -ne $serverMods.Count) {
        Throw-DysonHostnameWssError -Code $code
    }
    $normalizedServerMods = New-Object 'System.Collections.Generic.List[object]'
    $normalizedClientMods = New-Object 'System.Collections.Generic.List[object]'
    $dependencyById = @{}
    $sourceIds = @{}
    for ($index = 0; $index -lt $serverMods.Count; $index++) {
        $entry = $serverMods[$index]
        Assert-DysonHostnameWssExactProperties -Value $entry -Names @(
            'dependencyId','sourceId','version','sha256','dependencies','loadOrder','root','serverRequired','clientRequirement'
        ) -Code $code
        $dependencyId = [string]$entry.dependencyId
        if ($dependencyId -cnotmatch '^([A-Za-z0-9_]{1,64})-([A-Za-z0-9_]{1,64})-([0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10})$') {
            Throw-DysonHostnameWssError -Code $code
        }
        $namespace = [string]$Matches[1]
        $name = [string]$Matches[2]
        $dependencyVersion = [string]$Matches[3]
        $sourceId = [string]$entry.sourceId
        $version = [string]$entry.version
        $expectedSourceId = 'thunderstore:' + $namespace + '/' + $name
        if ($sourceId.Length -gt 160 -or
            -not $sourceId.Equals($expectedSourceId, [StringComparison]::OrdinalIgnoreCase) -or
            $version -cne $dependencyVersion -or -not (Test-DysonHostnameWssThunderstoreVersion -Value $version) -or
            [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            -not (Test-DysonHostnameWssJsonInteger -Value $entry.loadOrder -Minimum $index -Maximum $index) -or
            $entry.root -isnot [bool] -or $entry.serverRequired -isnot [bool] -or
            [string]$entry.clientRequirement -cnotin @('required','optional','not-required') -or
            (-not [bool]$entry.serverRequired -and [string]$entry.clientRequirement -ceq 'not-required') -or
            $entry.dependencies -isnot [array]) {
            Throw-DysonHostnameWssError -Code $code
        }
        $dependencyKey = $dependencyId.ToLowerInvariant()
        $sourceKey = $sourceId.ToLowerInvariant()
        if ($dependencyById.ContainsKey($dependencyKey) -or $sourceIds.ContainsKey($sourceKey)) {
            Throw-DysonHostnameWssError -Code $code
        }
        [object[]]$dependencies = @($entry.dependencies)
        if ($dependencies.Count -gt 64) { Throw-DysonHostnameWssError -Code $code }
        $dependencySeen = @{}
        $previousDependency = $null
        $normalizedDependencies = New-Object 'System.Collections.Generic.List[object]'
        foreach ($dependencyValue in $dependencies) {
            if ($dependencyValue -isnot [string]) { Throw-DysonHostnameWssError -Code $code }
            $dependency = [string]$dependencyValue
            $dependencyLower = $dependency.ToLowerInvariant()
            if ($dependency -cnotmatch '^[A-Za-z0-9_]{1,64}-[A-Za-z0-9_]{1,64}-[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}$' -or
                $dependencySeen.ContainsKey($dependencyLower) -or
                ($null -ne $previousDependency -and
                    [StringComparer]::Ordinal.Compare([string]$previousDependency, $dependency) -ge 0) -or
                -not $dependencyById.ContainsKey($dependencyLower)) {
                Throw-DysonHostnameWssError -Code $code
            }
            $dependencySeen[$dependencyLower] = $true
            $previousDependency = $dependency
            $normalizedDependencies.Add($dependency)
        }
        $dependencyById[$dependencyKey] = $index
        $sourceIds[$sourceKey] = $true
        $normalizedServerMods.Add([pscustomobject][ordered]@{
            dependencyId = $dependencyId
            sourceId = $sourceId
            version = $version
            sha256 = [string]$entry.sha256
            dependencies = [object[]]$normalizedDependencies.ToArray()
            loadOrder = [int]$entry.loadOrder
            root = [bool]$entry.root
            serverRequired = [bool]$entry.serverRequired
            clientRequirement = [string]$entry.clientRequirement
        })
    }
    $normalizedServerLock = [pscustomobject][ordered]@{
        format = 'dyson-control-server-mod-lock'
        schemaVersion = 1
        mods = [object[]]$normalizedServerMods.ToArray()
    }
    $serverLockSha256 = Get-DysonHostnameWssPrettyJsonDigest -Value $normalizedServerLock
    if ([string]$ClientParity.serverLockSha256 -cne $serverLockSha256.Substring(7)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_SERVER_LOCK_DIGEST_INVALID'
    }
    $clientSources = @{}
    for ($index = 0; $index -lt $clientMods.Count; $index++) {
        $entry = $clientMods[$index]
        $server = $normalizedServerMods[$index]
        Assert-DysonHostnameWssExactProperties -Value $entry -Names @(
            'sourceId','version','sha256','serverRequired','clientRequirement'
        ) -Code $code
        $sourceId = [string]$entry.sourceId
        $sourceKey = $sourceId.ToLowerInvariant()
        if ($clientSources.ContainsKey($sourceKey) -or
            $sourceId -cne [string]$server.sourceId -or [string]$entry.version -cne [string]$server.version -or
            [string]$entry.sha256 -cne [string]$server.sha256 -or
            $entry.serverRequired -isnot [bool] -or [bool]$entry.serverRequired -ne [bool]$server.serverRequired -or
            [string]$entry.clientRequirement -cne [string]$server.clientRequirement) {
            Throw-DysonHostnameWssError -Code $code
        }
        $clientSources[$sourceKey] = $true
        $normalizedClientMods.Add([pscustomobject][ordered]@{
            sourceId = $sourceId
            version = [string]$entry.version
            sha256 = [string]$entry.sha256
            serverRequired = [bool]$entry.serverRequired
            clientRequirement = [string]$entry.clientRequirement
        })
    }
    $normalizedClientParity = [pscustomobject][ordered]@{
        format = 'dyson-control-client-parity'
        schemaVersion = 1
        serverLockSha256 = $serverLockSha256.Substring(7)
        mods = [object[]]$normalizedClientMods.ToArray()
    }
    return [pscustomobject][ordered]@{
        serverLockSha256 = $serverLockSha256
        clientParitySha256 = Get-DysonHostnameWssPrettyJsonDigest -Value $normalizedClientParity
        serverLock = $normalizedServerLock
        clientParity = $normalizedClientParity
    }
}

function Assert-DysonHostnameWssClientManifest {
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$ManifestSha256,
        [Parameter(Mandatory)][string]$ClientRoot,
        [Parameter(Mandatory)][string]$ExpectedQualificationId,
        [Parameter(Mandatory)][string]$ExpectedPackageSha256
    )
    $code = 'DYSON_HOSTNAME_WSS_CLIENT_MANIFEST_INVALID'
    Assert-DysonHostnameWssExactProperties -Value $Manifest -Names @(
        'protocol','schemaVersion','qualificationId','createdAtUtc','files','treeSha256','packageSha256','manifestSha256'
    ) -Code $code
    if ([string]$Manifest.protocol -cne 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1' -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Manifest.schemaVersion -Minimum 1 -Maximum 1) -or
        [string]$Manifest.qualificationId -cne $ExpectedQualificationId -or
        -not (Test-DysonHostnameWssUuid -Value ([string]$Manifest.qualificationId)) -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Manifest.treeSha256)) -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Manifest.packageSha256)) -or
        [string]$Manifest.packageSha256 -cne $ExpectedPackageSha256 -or
        -not (Test-DysonHostnameWssDigest -Value ([string]$Manifest.manifestSha256)) -or
        -not (Test-DysonHostnameWssDigest -Value $ManifestSha256)) {
        Throw-DysonHostnameWssError -Code $code
    }
    [void](ConvertFrom-DysonHostnameWssUtc -Value ([string]$Manifest.createdAtUtc) -Code $code)
    $core = Get-DysonHostnameWssUnsignedValue -Value $Manifest -ExcludedNames @('manifestSha256')
    if ((Get-DysonHostnameWssObjectDigest -Value $core) -cne [string]$Manifest.manifestSha256) {
        Throw-DysonHostnameWssError -Code $code
    }
    [object[]]$files = @($Manifest.files)
    if ($files.Count -lt 2 -or $files.Count -gt 4096) { Throw-DysonHostnameWssError -Code $code }
    try { $inventory = Get-DysonPrivateEvidenceInventory -Root $ClientRoot }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_FILES_INVALID' }
    if ([int]$inventory.fileCount -ne $files.Count) { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_FILES_INVALID' }
    $inventoryByPath = @{}
    foreach ($entry in @($inventory.files)) { $inventoryByPath[[string]$entry.path] = $entry }
    $paths = New-Object 'System.Collections.Generic.List[string]'
    $caseKeys = @{}
    $records = New-Object System.Text.StringBuilder
    foreach ($file in $files) {
        Assert-DysonHostnameWssExactProperties -Value $file -Names @('path','size','sha256') -Code $code
        $path = [string]$file.path
        try { [void](Assert-DysonPrivateEvidenceRelativePath -Path $path) }
        catch { Throw-DysonHostnameWssError -Code $code }
        if (-not (Test-DysonHostnameWssJsonInteger -Value $file.size -Minimum 1) -or
            -not (Test-DysonHostnameWssDigest -Value ([string]$file.sha256))) {
            Throw-DysonHostnameWssError -Code $code
        }
        $caseKey = $path.ToLowerInvariant()
        if ($caseKeys.ContainsKey($caseKey) -or -not $inventoryByPath.ContainsKey($path)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_FILES_INVALID'
        }
        $caseKeys[$caseKey] = $true
        $actual = $inventoryByPath[$path]
        if ([int64]$file.size -ne [int64]$actual.length -or
            [string]$file.sha256 -cne ('sha256:' + [string]$actual.sha256)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_FILES_INVALID'
        }
        $paths.Add($path)
        [void]$records.Append($path).Append([char]0).Append(
            ([int64]$file.size).ToString([Globalization.CultureInfo]::InvariantCulture)).Append([char]0).Append(
            ([string]$file.sha256).Substring(7)).Append("`n")
    }
    [string[]]$sorted = @($paths)
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    if (($paths -join "`n") -cne ($sorted -join "`n")) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_FILE_ORDER_INVALID'
    }
    $tree = Get-DysonQualificationV2Sha256 -Value $records.ToString()
    if ($tree -cne [string]$Manifest.treeSha256) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CLIENT_TREE_INVALID'
    }
    return [pscustomobject][ordered]@{ files = $files; treeSha256 = $tree }
}

function Get-DysonHostnameWssStreamDigest {
    param([Parameter(Mandatory)][System.IO.Stream]$Stream)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return 'sha256:' + ([BitConverter]::ToString($hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Assert-DysonHostnameWssClientPackage {
    param(
        [Parameter(Mandatory)][string]$PackagePath,
        [Parameter(Mandatory)][object[]]$ManifestFiles
    )
    $code = 'DYSON_HOSTNAME_WSS_CLIENT_PACKAGE_INVALID'
    try {
        [void](Assert-DysonPrivateEvidencePlainFile -Path $PackagePath -MaximumBytes $script:DysonHostnameWssMaximumArtifactBytes)
        Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $stream = [IO.File]::Open($PackagePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $archive = New-Object System.IO.Compression.ZipArchive(
                $stream, [IO.Compression.ZipArchiveMode]::Read, $false
            )
            try {
                $entries = @($archive.Entries)
                if ($entries.Count -ne $ManifestFiles.Count) { throw $code }
                $manifestMap = @{}
                foreach ($file in $ManifestFiles) { $manifestMap[[string]$file.path] = $file }
                $seen = @{}
                foreach ($entry in $entries) {
                    $path = [string]$entry.FullName
                    [void](Assert-DysonPrivateEvidenceRelativePath -Path $path)
                    $caseKey = $path.ToLowerInvariant()
                    $unixMode = ([int64]$entry.ExternalAttributes -shr 16) -band 0xf000
                    if ($seen.ContainsKey($caseKey) -or -not $manifestMap.ContainsKey($path) -or
                        [string]::IsNullOrEmpty([string]$entry.Name) -or $unixMode -eq 0xa000) { throw $code }
                    $seen[$caseKey] = $true
                    $expected = $manifestMap[$path]
                    if ([int64]$entry.Length -ne [int64]$expected.size) { throw $code }
                    $entryStream = $entry.Open()
                    try { $digest = Get-DysonHostnameWssStreamDigest -Stream $entryStream }
                    finally { $entryStream.Dispose() }
                    if ($digest -cne [string]$expected.sha256) { throw $code }
                }
            }
            finally { $archive.Dispose() }
        }
        finally { $stream.Dispose() }
    }
    catch {
        if ($_.Exception.Message -cmatch '^DYSON_HOSTNAME_WSS_') { throw }
        Throw-DysonHostnameWssError -Code $code
    }
}

function Get-DysonHostnameWssFixedChildPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )
    try {
        [void](Assert-DysonPrivateEvidenceRelativePath -Path $RelativePath)
        $full = [IO.Path]::GetFullPath((Join-Path $Root ($RelativePath.Replace('/', '\'))))
        if ((Get-DysonPrivateEvidenceRelativePath -Root $Root -File $full) -cne $RelativePath) {
            throw 'fixed child mismatch'
        }
        return $full
    }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EVIDENCE_PATH_INVALID' }
}

function Assert-DysonHostnameWssMetadataHarvestPlain {
    param(
        [Parameter(Mandatory)]$Metadata,
        [Parameter(Mandatory)][string]$HarvestRoot
    )
    try {
        $root = Assert-DysonPrivateEvidenceSafeRoot -Path $HarvestRoot -Name 'BuildHarvestRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $root)
        foreach ($artifact in @($Metadata.artifacts)) {
            $path = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath ([string]$artifact.path)
            [void](Assert-DysonPrivateEvidencePlainFile -Path $path -MaximumBytes ([int64](128MB)))
        }
        return $root
    }
    catch {
        if ($_.Exception.Message -cmatch '^DYSON_HOSTNAME_WSS_') { throw }
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_BUILD_HARVEST_INVALID'
    }
}

function Get-DysonHostnameWssAssemblyMvid {
    param([Parameter(Mandatory)][string]$Path)
    try {
        [void](Assert-DysonPrivateEvidencePlainFile -Path $Path -MaximumBytes ([int64](128MB)))
        # Use the same CLR metadata source as Get-NebulaPrivateAssemblyInfo; no PE
        # metadata is reimplemented in this qualification layer.
        $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($Path)
        return $assembly.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant()
    }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_ACTUAL_MVID_INVALID' }
}

function Get-DysonHostnameWssBuildMaterial {
    param(
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$BuildHarvestRootA,
        [Parameter(Mandatory)][string]$BuildHarvestRootB,
        [Parameter(Mandatory)]$Document
    )
    $code = 'DYSON_HOSTNAME_WSS_BUILD_EVIDENCE_INVALID'
    try {
        $sourceFixed = Get-DysonHostnameWssFixedChildPath -Root $script:DysonHostnameWssRepositoryRoot `
            -RelativePath 'integrations/nebula-hostname-wss/contract.json'
        $patchFixed = Get-DysonHostnameWssFixedChildPath -Root $script:DysonHostnameWssRepositoryRoot `
            -RelativePath 'integrations/nebula-hostname-wss/patches/nebula-v0.9.22-hostname-wss.patch'
        $privateBuildFixed = Get-DysonHostnameWssFixedChildPath -Root $script:DysonHostnameWssRepositoryRoot `
            -RelativePath 'scripts/windows/nebula-private-build/private-build-contract.v1.json'
        foreach ($fixedFile in @($sourceFixed,$patchFixed,$privateBuildFixed)) {
            [void](Assert-DysonPrivateEvidencePlainFile -Path $fixedFile -MaximumBytes ([int64](16MB)))
        }
        [void](Assert-NebulaPrivateContractAnchors -SourceContractPath $sourceFixed -PatchPath $patchFixed)

        $paths = [ordered]@{}
        foreach ($pair in @(
            @('sourcePatch','source-patch-contract.json'),
            @('privateBuild','private-build-contract.json'),
            @('metadataA','binary-metadata-a.json'),
            @('metadataB','binary-metadata-b.json'),
            @('candidateManifest','candidate-manifest.json'),
            @('clientManifest','client-manifest.json'),
            @('profileInput','profile-input.json'),
            @('clientPackage','client-package.zip')
        )) { $paths[$pair[0]] = Get-DysonHostnameWssFixedChildPath -Root $EvidenceRoot -RelativePath $pair[1] }
        $candidateRoot = Get-DysonHostnameWssFixedChildPath -Root $EvidenceRoot -RelativePath 'candidate'
        $clientRoot = Get-DysonHostnameWssFixedChildPath -Root $EvidenceRoot -RelativePath 'client'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $candidateRoot)
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $clientRoot)

        $source = Read-DysonHostnameWssJsonFile -Path $paths.sourcePatch
        $privateBuild = Read-DysonHostnameWssJsonFile -Path $paths.privateBuild
        $metadataA = Read-DysonHostnameWssJsonFile -Path $paths.metadataA
        $metadataB = Read-DysonHostnameWssJsonFile -Path $paths.metadataB
        $candidateManifest = Read-DysonHostnameWssJsonFile -Path $paths.candidateManifest
        $clientManifest = Read-DysonHostnameWssJsonFile -Path $paths.clientManifest -RequireCanonical
        $profileInput = Read-DysonHostnameWssJsonFile -Path $paths.profileInput
        [void](Assert-DysonPrivateEvidencePlainFile -Path $paths.clientPackage `
            -MaximumBytes $script:DysonHostnameWssMaximumArtifactBytes)
        $clientPackageSha256 = Get-DysonHostnameWssFileDigest -Path $paths.clientPackage

        if ($source.sha256 -cne (Get-DysonHostnameWssFileDigest -Path $sourceFixed) -or
            $privateBuild.sha256 -cne (Get-DysonHostnameWssFileDigest -Path $privateBuildFixed)) { throw $code }
        if ([string]$source.value.upstream.commit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
            [string]$source.value.patch.sha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256 -or
            [string]$privateBuild.value.upstream.commit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
            [string]$privateBuild.value.sourcePatch.contractSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.contractSha256 -or
            [string]$privateBuild.value.sourcePatch.patchSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256 -or
            (Get-DysonHostnameWssFileDigest -Path $patchFixed) -cne ('sha256:' + [string]$script:NebulaPrivateContract.sourcePatch.patchSha256)) {
            throw $code
        }

        $harvestA = Assert-DysonHostnameWssMetadataHarvestPlain -Metadata $metadataA.value -HarvestRoot $BuildHarvestRootA
        $harvestB = Assert-DysonHostnameWssMetadataHarvestPlain -Metadata $metadataB.value -HarvestRoot $BuildHarvestRootB
        if ([string]::Equals($harvestA, $harvestB, [StringComparison]::OrdinalIgnoreCase)) { throw $code }
        [void](Assert-NebulaPrivateDeterministicBuilds -MetadataA $metadataA.value -MetadataB $metadataB.value `
            -HarvestRootA $harvestA -HarvestRootB $harvestB)
        $candidateResult = Assert-NebulaPrivateCandidateManifest -Manifest $candidateManifest.value -CandidateRoot $candidateRoot
        if ([string]$candidateManifest.value.deterministicBuildEvidence.metadataASha256 -cne $metadataA.sha256.Substring(7) -or
            [string]$candidateManifest.value.deterministicBuildEvidence.metadataBSha256 -cne $metadataB.sha256.Substring(7)) {
            throw $code
        }

        $clientResult = Assert-DysonHostnameWssClientManifest -Manifest $clientManifest.value `
            -ManifestSha256 $clientManifest.sha256 -ClientRoot $clientRoot `
            -ExpectedQualificationId ([string]$Document.qualificationId) -ExpectedPackageSha256 $clientPackageSha256
        Assert-DysonHostnameWssClientPackage -PackagePath $paths.clientPackage -ManifestFiles $clientResult.files
        Assert-DysonHostnameWssExactProperties -Value $profileInput.value `
            -Names @('schemaVersion','profile','compatibility','serverLock','clientParity') `
            -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        Assert-DysonHostnameWssExactProperties -Value $profileInput.value.profile `
            -Names @('profileId','displayName','connection') -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        Assert-DysonHostnameWssExactProperties -Value $profileInput.value.profile.connection `
            -Names @('host','port') -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        Assert-DysonHostnameWssExactProperties -Value $profileInput.value.compatibility `
            -Names @('inventory','matrix') -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        if (-not (Test-DysonHostnameWssJsonInteger -Value $profileInput.value.schemaVersion -Minimum 1 -Maximum 1)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        }
        if ([string]$profileInput.value.profile.connection.host -cne [string]$Document.subject.authority -or
            -not (Test-DysonHostnameWssJsonInteger -Value $profileInput.value.profile.connection.port -Minimum 443 -Maximum 443)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_PROFILE_BINDING_INVALID'
        }
        $profileManifestDigests = Get-DysonHostnameWssProfileManifestDigests `
            -ServerLock $profileInput.value.serverLock -ClientParity $profileInput.value.clientParity
        if ((Get-DysonHostnameWssObjectDigest -Value $profileInput.value.compatibility.matrix) -cne
                [string]$Document.contractBinding.compatibilityPolicySha256 -or
            [string]$profileManifestDigests.serverLockSha256 -cne
                [string]$Document.contractBinding.serverLockSha256 -or
            [string]$profileManifestDigests.clientParitySha256 -cne
                [string]$Document.contractBinding.clientParitySha256) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_PROFILE_POLICY_BINDING_INVALID'
        }

        $expectedContract = [pscustomobject][ordered]@{
            sourcePatchContractSha256 = $source.sha256
            privateBuildContractSha256 = $privateBuild.sha256
            upstreamCommit = [string]$script:NebulaPrivateContract.upstream.commit
            patchSha256 = 'sha256:' + [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
            binaryMetadataASha256 = $metadataA.sha256
            binaryMetadataBSha256 = $metadataB.sha256
            candidateManifestSha256 = $candidateManifest.sha256
            candidateTreeSha256 = 'sha256:' + [string]$candidateResult.candidateTreeSha256
            clientManifestSha256 = $clientManifest.sha256
            clientPackageSha256 = $clientPackageSha256
            profileInputSha256 = $profileInput.sha256
            serverLockSha256 = [string]$profileManifestDigests.serverLockSha256
            clientParitySha256 = [string]$profileManifestDigests.clientParitySha256
            compatibilityPolicySha256 = [string]$Document.contractBinding.compatibilityPolicySha256
        }

        $candidateEntries = @()
        $clientEntries = @()
        foreach ($definition in @(
            [pscustomobject]@{ role = 'nebula-network'; assembly = 'NebulaNetwork'; fileName = 'NebulaNetwork.dll'; path = 'nebula-NebulaMultiplayerMod/NebulaNetwork.dll' },
            [pscustomobject]@{ role = 'nebula-patcher'; assembly = 'NebulaPatcher'; fileName = 'NebulaPatcher.dll'; path = 'nebula-NebulaMultiplayerMod/NebulaPatcher.dll' }
        )) {
            $assemblyA = @($metadataA.value.assemblies | Where-Object { [string]$_.name -ceq $definition.assembly })
            $assemblyB = @($metadataB.value.assemblies | Where-Object { [string]$_.name -ceq $definition.assembly })
            $artifactA = @($metadataA.value.artifacts | Where-Object { [string]$_.path -ceq $definition.path })
            $artifactB = @($metadataB.value.artifacts | Where-Object { [string]$_.path -ceq $definition.path })
            $candidateFile = @($candidateManifest.value.files | Where-Object { [string]$_.path -ceq $definition.path })
            $clientFile = @($clientManifest.value.files | Where-Object {
                $normalized = ([string]$_.path).Replace('\','/')
                [string]$normalized -ceq $definition.fileName -or $normalized.EndsWith('/' + $definition.fileName, [StringComparison]::Ordinal)
            })
            if ($assemblyA.Count -ne 1 -or $assemblyB.Count -ne 1 -or $artifactA.Count -ne 1 -or
                $artifactB.Count -ne 1 -or $candidateFile.Count -ne 1 -or $clientFile.Count -ne 1 -or
                [string]$assemblyA[0].mvid -cne [string]$assemblyB[0].mvid -or
                [string]$artifactA[0].sha256 -cne [string]$artifactB[0].sha256 -or
                [string]$artifactA[0].sha256 -cne [string]$candidateFile[0].sha256 -or
                ('sha256:' + [string]$candidateFile[0].sha256) -cne [string]$clientFile[0].sha256) {
                throw $code
            }
            $candidateDll = Get-DysonHostnameWssFixedChildPath -Root $candidateRoot -RelativePath ([string]$definition.path)
            $actualMvid = Get-DysonHostnameWssAssemblyMvid -Path $candidateDll
            if ($actualMvid -cne [string]$assemblyA[0].mvid) {
                Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_ACTUAL_MVID_MISMATCH'
            }
            $candidateEntries += ,[pscustomobject][ordered]@{
                role = [string]$definition.role
                fileName = [string]$definition.fileName
                sha256 = 'sha256:' + [string]$candidateFile[0].sha256
                mvid = [string]$assemblyA[0].mvid
            }
            $clientEntries += ,[pscustomobject][ordered]@{
                role = [string]$definition.role
                fileName = [string]$definition.fileName
                sha256 = [string]$clientFile[0].sha256
                mvid = [string]$assemblyA[0].mvid
            }
        }
        return [pscustomobject][ordered]@{
            contractBinding = $expectedContract
            binaryBinding = [pscustomobject][ordered]@{ candidate = $candidateEntries; client = $clientEntries }
        }
    }
    catch {
        if ($_.Exception.Message -cmatch '^DYSON_HOSTNAME_WSS_') { throw }
        Throw-DysonHostnameWssError -Code $code
    }
}

function Assert-DysonHostnameWssActualBindings {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)]$BuildMaterial,
        [Parameter(Mandatory)]$ExternalMaterial,
        [Parameter(Mandatory)][string]$SessionId
    )
    if ((Get-DysonHostnameWssObjectDigest -Value $Document.contractBinding) -cne
            (Get-DysonHostnameWssObjectDigest -Value $BuildMaterial.contractBinding) -or
        (Get-DysonHostnameWssObjectDigest -Value $Document.binaryBinding) -cne
            (Get-DysonHostnameWssObjectDigest -Value $BuildMaterial.binaryBinding)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_ACTUAL_BINARY_MISMATCH'
    }
    if ((Get-DysonHostnameWssObjectDigest -Value $Document.externalClientBinding) -cne
        (Get-DysonHostnameWssObjectDigest -Value $ExternalMaterial.binding)) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EXTERNAL_BINDING_MISMATCH'
    }
    $externalObserved = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.externalClientBinding.observedAtUtc) `
        -Code 'DYSON_HOSTNAME_WSS_EXTERNAL_BINDING_INVALID'
    $externalExpires = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.externalClientBinding.expiresAtUtc) `
        -Code 'DYSON_HOSTNAME_WSS_EXTERNAL_BINDING_INVALID'
    $documentIssued = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.issuedAtUtc) `
        -Code 'DYSON_HOSTNAME_WSS_DOCUMENT_INVALID'
    $documentExpires = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.expiresAtUtc) `
        -Code 'DYSON_HOSTNAME_WSS_DOCUMENT_INVALID'
    if ($externalObserved -lt $documentIssued -or $externalExpires -gt $documentExpires) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EXTERNAL_TIMING_INVALID'
    }
    $sessionBinding = Get-DysonHostnameWssSessionBindingDigest -Document $Document -SessionId $SessionId
    if ([string]$Document.externalClientBinding.sessionBindingSha256 -cne $sessionBinding -or
        [string]$Document.transportBinding.sessionBindingSha256 -cne $sessionBinding -or
        [string]$Document.routeBinding.sessionBindingSha256 -cne $sessionBinding) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_SESSION_BINDING_INVALID'
    }
    $flowBinding = Get-DysonHostnameWssFlowBindingDigest -Document $Document -SessionId $SessionId `
        -SessionBindingSha256 $sessionBinding
    if ([string]$Document.routeBinding.flowBindingSha256 -cne $flowBinding) {
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_FLOW_BINDING_INVALID'
    }
    return $sessionBinding
}

function Get-DysonHostnameWssReceiptMaterial {
    param([Parameter(Mandatory)][object[]]$Receipts)
    $items = @()
    foreach ($receipt in $Receipts) {
        $items += ,[pscustomobject][ordered]@{
            receiptId = [string]$receipt.receiptId
            receiptSha256 = [string]$receipt.receiptSha256
            nonce = [string]$receipt.nonce
        }
    }
    return [pscustomobject][ordered]@{
        items = $items
        sha256 = Get-DysonHostnameWssObjectDigest -Value $items
    }
}

function Get-DysonHostnameWssReplayLayout {
    param([Parameter(Mandatory)][string]$ReplayRoot)
    try {
        $root = Assert-DysonPrivateEvidenceSafeRoot -Path $ReplayRoot -Name 'ReplayRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $root)
        [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $root)
        $acceptances = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath 'acceptances'
        $receiptClaims = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath 'claims/receipt-id'
        $nonceClaims = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath 'claims/nonce'
        foreach ($directory in @($acceptances,$receiptClaims,$nonceClaims)) {
            [void](Assert-DysonPrivateEvidencePlainDirectory -Path $directory)
            [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $directory)
        }
        return [pscustomobject][ordered]@{
            root = $root
            acceptances = $acceptances
            receiptClaims = $receiptClaims
            nonceClaims = $nonceClaims
        }
    }
    catch {
        if ($_.Exception.Message -cmatch '^DYSON_HOSTNAME_WSS_') { throw }
        Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_REPLAY_ROOT_INVALID'
    }
}

function Write-DysonHostnameWssCanonicalCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )
    $text = ConvertTo-DysonQualificationV2CanonicalJson -Value $Value
    $bytes = (New-Object Text.UTF8Encoding -ArgumentList $false).GetBytes($text)
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        return $true
    }
    catch [IO.IOException] { return $false }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_REPLAY_STATE_WRITE_FAILED' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function New-DysonHostnameWssReplayClaim {
    param(
        [Parameter(Mandatory)][ValidateSet('receipt-id','nonce')][string]$ClaimType,
        [Parameter(Mandatory)][string]$ClaimId,
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ReceiptMaterialSha256,
        [Parameter(Mandatory)][byte[]]$Key
    )
    $claim = [pscustomobject][ordered]@{
        protocol = $script:DysonHostnameWssClaimProtocol
        schemaVersion = 1
        claimType = $ClaimType
        claimId = $ClaimId
        qualificationId = [string]$Document.qualificationId
        runId = [string]$Document.runId
        bindingSha256 = [string]$Document.documentSha256
        authority = [string]$Document.subject.authority
        port = 443
        receiptMaterialSha256 = $ReceiptMaterialSha256
        expiresAtUtc = [string]$Document.expiresAtUtc
        keyId = [string]$Document.protection.keyId
        claimSha256 = $null
        hmacSha256 = $null
    }
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $claim -ExcludedNames @('claimSha256','hmacSha256')
    $claim.claimSha256 = Get-DysonHostnameWssObjectDigest -Value $unsigned
    $claim.hmacSha256 = Get-DysonHostnameWssHmac -Value $unsigned -Key $Key
    return $claim
}

function Assert-DysonHostnameWssReplayClaim {
    param(
        [Parameter(Mandatory)]$Claim,
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)][byte[]]$Key
    )
    $code = 'DYSON_HOSTNAME_WSS_RECEIPT_REPLAYED'
    Assert-DysonHostnameWssExactProperties -Value $Claim -Names @(
        'protocol','schemaVersion','claimType','claimId','qualificationId','runId','bindingSha256','authority','port',
        'receiptMaterialSha256','expiresAtUtc','keyId','claimSha256','hmacSha256'
    ) -Code $code
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $Claim -ExcludedNames @('claimSha256','hmacSha256')
    $expectedClaimDigest = Get-DysonHostnameWssObjectDigest -Value $unsigned
    $expectedClaimHmac = Get-DysonHostnameWssHmac -Value $unsigned -Key $Key
    if ([string]$Claim.protocol -cne $script:DysonHostnameWssClaimProtocol -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Claim.schemaVersion -Minimum 1 -Maximum 1) -or
        -not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Claim.claimSha256) -Expected $expectedClaimDigest) -or
        -not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Claim.hmacSha256) -Expected $expectedClaimHmac) -or
        (Get-DysonHostnameWssObjectDigest -Value $unsigned) -cne
            (Get-DysonHostnameWssObjectDigest -Value (Get-DysonHostnameWssUnsignedValue `
                -Value $Expected -ExcludedNames @('claimSha256','hmacSha256')))) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function New-DysonHostnameWssAcceptance {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ReceiptMaterialSha256,
        [Parameter(Mandatory)][datetimeoffset]$AcceptedAtUtc,
        [Parameter(Mandatory)][byte[]]$Key
    )
    $acceptance = [pscustomobject][ordered]@{
        protocol = $script:DysonHostnameWssAcceptanceProtocol
        schemaVersion = 1
        qualificationId = [string]$Document.qualificationId
        runId = [string]$Document.runId
        bindingSha256 = [string]$Document.documentSha256
        authority = [string]$Document.subject.authority
        port = 443
        receiptMaterialSha256 = $ReceiptMaterialSha256
        expiresAtUtc = [string]$Document.expiresAtUtc
        acceptedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $AcceptedAtUtc
        keyId = [string]$Document.protection.keyId
        acceptanceSha256 = $null
        hmacSha256 = $null
    }
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $acceptance -ExcludedNames @('acceptanceSha256','hmacSha256')
    $acceptance.acceptanceSha256 = Get-DysonHostnameWssObjectDigest -Value $unsigned
    $acceptance.hmacSha256 = Get-DysonHostnameWssHmac -Value $unsigned -Key $Key
    return $acceptance
}

function Assert-DysonHostnameWssAcceptance {
    param(
        [Parameter(Mandatory)]$Acceptance,
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ReceiptMaterialSha256,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][byte[]]$Key
    )
    $code = 'DYSON_HOSTNAME_WSS_ACCEPTANCE_REPLAY_CONFLICT'
    Assert-DysonHostnameWssExactProperties -Value $Acceptance -Names @(
        'protocol','schemaVersion','qualificationId','runId','bindingSha256','authority','port','receiptMaterialSha256',
        'expiresAtUtc','acceptedAtUtc','keyId','acceptanceSha256','hmacSha256'
    ) -Code $code
    $acceptedAt = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Acceptance.acceptedAtUtc) -Code $code
    $issued = ConvertFrom-DysonHostnameWssUtc -Value ([string]$Document.issuedAtUtc) -Code $code
    $unsigned = Get-DysonHostnameWssUnsignedValue -Value $Acceptance `
        -ExcludedNames @('acceptanceSha256','hmacSha256')
    $expectedAcceptanceDigest = Get-DysonHostnameWssObjectDigest -Value $unsigned
    $expectedAcceptanceHmac = Get-DysonHostnameWssHmac -Value $unsigned -Key $Key
    if ([string]$Acceptance.protocol -cne $script:DysonHostnameWssAcceptanceProtocol -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Acceptance.schemaVersion -Minimum 1 -Maximum 1) -or
        [string]$Acceptance.qualificationId -cne [string]$Document.qualificationId -or
        [string]$Acceptance.runId -cne [string]$Document.runId -or
        [string]$Acceptance.bindingSha256 -cne [string]$Document.documentSha256 -or
        [string]$Acceptance.authority -cne [string]$Document.subject.authority -or
        -not (Test-DysonHostnameWssJsonInteger -Value $Acceptance.port -Minimum 443 -Maximum 443) -or
        [string]$Acceptance.receiptMaterialSha256 -cne $ReceiptMaterialSha256 -or
        [string]$Acceptance.expiresAtUtc -cne [string]$Document.expiresAtUtc -or
        [string]$Acceptance.keyId -cne [string]$Document.protection.keyId -or
        $acceptedAt -lt $issued -or $acceptedAt -gt $NowUtc -or
        -not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Acceptance.acceptanceSha256) `
            -Expected $expectedAcceptanceDigest) -or
        -not (Test-DysonHostnameWssFixedTimeDigest -Actual ([string]$Acceptance.hmacSha256) `
            -Expected $expectedAcceptanceHmac)) {
        Throw-DysonHostnameWssError -Code $code
    }
}

function Read-DysonHostnameWssReplayJson {
    param([Parameter(Mandatory)][string]$Path)
    try { return (Read-DysonHostnameWssJsonFile -Path $Path -RequireCanonical).value }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_REPLAY_STATE_INVALID' }
}

function Acquire-DysonHostnameWssAcceptanceCore {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$KeyResolver
    )
    try { [byte[]]$key = & $KeyResolver ([string]$Document.protection.keyId) }
    catch { Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_HMAC_KEY_INVALID' }
    try {
        $material = Get-DysonHostnameWssReceiptMaterial -Receipts @($Document.receiptChain)
        foreach ($receipt in @($Document.receiptChain)) {
            foreach ($claimType in @('receipt-id','nonce')) {
                $claimId = if ($claimType -ceq 'receipt-id') {
                    [string]$receipt.receiptId
                } else {
                    Get-DysonQualificationV2Sha256 -Value ([string]$receipt.nonce)
                }
                $claim = New-DysonHostnameWssReplayClaim -ClaimType $claimType -ClaimId $claimId `
                    -Document $Document -ReceiptMaterialSha256 $material.sha256 -Key $key
                $directory = if ($claimType -ceq 'receipt-id') { $layout.receiptClaims } else { $layout.nonceClaims }
                $safeName = if ($claimType -ceq 'receipt-id') { $claimId } else { $claimId.Substring(7) }
                $claimPath = Get-DysonHostnameWssFixedChildPath -Root $directory -RelativePath ($safeName + '.json')
                $created = Write-DysonHostnameWssCanonicalCreateNew -Path $claimPath -Value $claim
                if (-not $created) {
                    $existing = Read-DysonHostnameWssReplayJson -Path $claimPath
                    Assert-DysonHostnameWssReplayClaim -Claim $existing -Expected $claim -Key $key
                }
            }
        }
        $acceptance = New-DysonHostnameWssAcceptance -Document $Document `
            -ReceiptMaterialSha256 $material.sha256 -AcceptedAtUtc $NowUtc -Key $key
        $acceptancePath = Get-DysonHostnameWssFixedChildPath -Root $layout.acceptances `
            -RelativePath (([string]$Document.qualificationId) + '.json')
        $createdAcceptance = Write-DysonHostnameWssCanonicalCreateNew -Path $acceptancePath -Value $acceptance
        if (-not $createdAcceptance) {
            $existingAcceptance = Read-DysonHostnameWssReplayJson -Path $acceptancePath
            Assert-DysonHostnameWssAcceptance -Acceptance $existingAcceptance -Document $Document `
                -ReceiptMaterialSha256 $material.sha256 -NowUtc $NowUtc -Key $key
        }
        return [pscustomobject][ordered]@{ qualified = $true; created = $createdAcceptance }
    }
    finally { if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) } }
}

function Acquire-DysonHostnameWssAcceptance {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$ReplayRoot,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$KeyResolver
    )
    $layout = Get-DysonHostnameWssReplayLayout -ReplayRoot $ReplayRoot
    return Acquire-DysonHostnameWssAcceptanceCore -Document $Document -Layout $layout `
        -NowUtc $NowUtc -KeyResolver $KeyResolver
}

function New-DysonHostnameWssProjection {
    param(
        [Parameter(Mandatory)][string]$QualificationId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$BindingSha256,
        [Parameter(Mandatory)][string]$ExpiresAtUtc,
        [Parameter(Mandatory)][ValidateSet('qualified','preview-valid','blocked')][string]$Decision,
        [Parameter(Mandatory)][string[]]$BlockerCodes
    )
    $projection = [pscustomobject][ordered]@{
        qualificationId = $QualificationId
        runId = $RunId
        bindingSha256 = $BindingSha256
        expiresAtUtc = $ExpiresAtUtc
        decision = $Decision
        blockerCodes = @($BlockerCodes)
    }
    Assert-DysonHostnameWssExactProperties -Value $projection -Names $script:DysonHostnameWssProjectionProperties `
        -Code 'DYSON_HOSTNAME_WSS_PROJECTION_INVALID'
    return $projection
}

function Invoke-DysonHostnameWssQualificationValidation {
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
        [string]$Confirmation,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $runId = '00000000-0000-0000-0000-000000000000'
    $bindingSha256 = 'sha256:' + ('0' * 64)
    $expiresAtUtc = '1970-01-01T00:00:00.000Z'
    try {
        if (-not (Test-DysonHostnameWssUuid -Value $ExpectedQualificationId)) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EXPECTED_QUALIFICATION_ID_INVALID'
        }
        [void](Assert-DysonHostnameWssCanonicalAuthority -Authority $ExpectedAuthority `
            -Code 'DYSON_HOSTNAME_WSS_EXPECTED_AUTHORITY_INVALID')
        if ($Consume -and $Confirmation -cne $script:DysonHostnameWssConfirmation) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_CONSUME_CONFIRMATION_REQUIRED'
        }
        $root = Assert-DysonPrivateEvidenceSafeRoot -Path $EvidenceRoot -Name 'EvidenceRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $root)
        [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $root)
        $rootLeaf = [IO.Path]::GetFileName($root.TrimEnd([char[]]@('\','/')))
        if ($rootLeaf -cne $ExpectedQualificationId) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_EVIDENCE_ROOT_ID_MISMATCH'
        }
        $qualificationPath = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath 'qualification.json'
        $documentFile = Read-DysonHostnameWssJsonFile -Path $qualificationPath -RequireCanonical
        $document = $documentFile.value
        if ($null -ne $document.PSObject.Properties['runId']) { $runId = [string]$document.runId }
        if ($null -ne $document.PSObject.Properties['documentSha256']) { $bindingSha256 = [string]$document.documentSha256 }
        if ($null -ne $document.PSObject.Properties['expiresAtUtc']) { $expiresAtUtc = [string]$document.expiresAtUtc }
        $timing = Assert-DysonHostnameWssDocumentStructure -Document $document `
            -ExpectedQualificationId $ExpectedQualificationId -ExpectedAuthority $ExpectedAuthority `
            -ExpectedPort $ExpectedPort -NowUtc $NowUtc
        $keyRing = Assert-DysonPrivateEvidenceSafeRoot -Path $KeyRingRoot -Name 'KeyRingRoot'
        $keyResolver = { param($keyId) Get-DysonHostnameWssKeyFromRing -KeyRingRoot $keyRing -KeyId $keyId }.GetNewClosure()
        Assert-DysonHostnameWssDocumentProtection -Document $document -KeyResolver $keyResolver
        if (@($document.receiptChain).Count -ne 4 -or
            -not (Test-DysonHostnameWssUuid -Value ([string]$document.receiptChain[0].sessionId))) {
            Throw-DysonHostnameWssError -Code 'DYSON_HOSTNAME_WSS_RECEIPT_CHAIN_INVALID'
        }
        $sessionId = [string]$document.receiptChain[0].sessionId
        $externalPath = Get-DysonHostnameWssFixedChildPath -Root $root -RelativePath 'external-client-receipts.json'
        $external = Get-DysonHostnameWssExternalClientMaterial -Path $externalPath -Document $document `
            -SessionId $sessionId -NowUtc $NowUtc
        $build = Get-DysonHostnameWssBuildMaterial -EvidenceRoot $root -BuildHarvestRootA $BuildHarvestRootA `
            -BuildHarvestRootB $BuildHarvestRootB -Document $document
        $sessionBinding = Assert-DysonHostnameWssActualBindings -Document $document `
            -BuildMaterial $build -ExternalMaterial $external -SessionId $sessionId
        [void](Assert-DysonHostnameWssCollectorReceiptChain -Receipts @($document.receiptChain) -Document $document `
            -ExpectedSessionBindingSha256 $sessionBinding -DocumentIssuedAtUtc $timing.issuedAtUtc `
            -DocumentExpiresAtUtc $timing.expiresAtUtc -NowUtc $NowUtc -KeyResolver $keyResolver)
        if (-not $Consume) {
            return New-DysonHostnameWssProjection -QualificationId $ExpectedQualificationId -RunId $runId `
                -BindingSha256 $bindingSha256 -ExpiresAtUtc $expiresAtUtc -Decision 'preview-valid' `
                -BlockerCodes @('DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED')
        }
        [void](Acquire-DysonHostnameWssAcceptance -Document $document -ReplayRoot $ReplayRoot `
            -NowUtc $NowUtc -KeyResolver $keyResolver)
        return New-DysonHostnameWssProjection -QualificationId $ExpectedQualificationId -RunId $runId `
            -BindingSha256 $bindingSha256 -ExpiresAtUtc $expiresAtUtc -Decision 'qualified' -BlockerCodes @()
    }
    catch {
        $code = Get-DysonHostnameWssErrorCode -Exception $_.Exception
        if (-not (Test-DysonHostnameWssUuid -Value $runId)) { $runId = '00000000-0000-0000-0000-000000000000' }
        if (-not (Test-DysonHostnameWssDigest -Value $bindingSha256)) { $bindingSha256 = 'sha256:' + ('0' * 64) }
        try { [void](ConvertFrom-DysonHostnameWssUtc -Value $expiresAtUtc -Code 'invalid') }
        catch { $expiresAtUtc = '1970-01-01T00:00:00.000Z' }
        $safeQualificationId = if (Test-DysonHostnameWssUuid -Value $ExpectedQualificationId) {
            $ExpectedQualificationId
        } else { '00000000-0000-0000-0000-000000000000' }
        return New-DysonHostnameWssProjection -QualificationId $safeQualificationId -RunId $runId `
            -BindingSha256 $bindingSha256 -ExpiresAtUtc $expiresAtUtc -Decision 'blocked' -BlockerCodes @($code)
    }
}
