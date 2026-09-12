# Copyright (c) Dyson Control contributors.
# Fixed, public-safe protocol primitives for production qualification.

$script:DysonQualificationProtocol = 'DYSON_PRODUCTION_QUALIFICATION_V1'
$script:DysonQualificationSchemaVersion = 1
$script:DysonQualificationProtocolExecuteEnvironmentName = 'DYSON_QUALIFICATION_EXECUTE_ENABLED'
$script:DysonQualificationProtocolExecuteEnvironmentValue = 'ALLOW_BOUNDED_PRODUCTION_QUALIFICATION_V1'
$script:DysonQualificationProtocolActions = @(
    'windows-restart','control-plane-restart','dsp-crash-recovery','storage-interruption',
    'disk-pressure','update-rollback','gsmanager-switch','save-restore'
)

function Throw-DysonQualificationProtocolError {
    param([Parameter(Mandatory)][string]$Code, [Parameter(Mandatory)][string]$Message)
    throw ($Code + ': ' + $Message)
}

function Get-DysonQualificationProtocolInfo {
    [CmdletBinding()]
    param()

    [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationProtocol
        schemaVersion = $script:DysonQualificationSchemaVersion
        executeEnvironmentName = $script:DysonQualificationProtocolExecuteEnvironmentName
        executeEnvironmentValue = $script:DysonQualificationProtocolExecuteEnvironmentValue
        actions = @($script:DysonQualificationProtocolActions)
        productionChanged = $false
    }
}

function Test-DysonQualificationUuid {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $parsed = [Guid]::Empty
    if (-not [Guid]::TryParseExact($Value, 'D', [ref]$parsed)) { return $false }
    return $Value -ceq $parsed.ToString('D')
}

function Test-DysonQualificationDigest {
    param([AllowNull()][string]$Value, [switch]$AllowNull)
    if ($AllowNull -and [string]::IsNullOrEmpty($Value)) { return $true }
    return $Value -cmatch '^[0-9a-f]{64}$'
}

function ConvertTo-DysonQualificationCanonicalNode {
    param([AllowNull()]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [char] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
        $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64] -or $Value -is [single] -or
        $Value -is [double] -or $Value -is [decimal]) {
        return $Value
    }
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    if ($Value -is [DateTime]) { return ([DateTimeOffset]$Value).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            $result[$key] = ConvertTo-DysonQualificationCanonicalNode $Value[$key]
        }
        return $result
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-DysonQualificationCanonicalNode $item) }
        return ,$items
    }

    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property') } | Sort-Object Name)
    if ($properties.Count -gt 0 -or $Value -is [pscustomobject]) {
        $result = [ordered]@{}
        foreach ($property in $properties) {
            $result[$property.Name] = ConvertTo-DysonQualificationCanonicalNode $property.Value
        }
        return $result
    }

    return [string]$Value
}

function ConvertTo-DysonQualificationCanonicalJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()]$InputObject)

    $canonical = ConvertTo-DysonQualificationCanonicalNode $InputObject
    return (ConvertTo-Json -InputObject $canonical -Compress -Depth 64)
}

function Get-DysonQualificationSha256 {
    [CmdletBinding(DefaultParameterSetName = 'Text')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Text')][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory, ParameterSetName = 'Object')][AllowEmptyCollection()]$InputObject
    )

    if ($PSCmdlet.ParameterSetName -eq 'Object') {
        $Text = ConvertTo-DysonQualificationCanonicalJson -InputObject $InputObject
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return (($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $algorithm.Dispose()
    }
}

function ConvertFrom-DysonQualificationUtcTimestamp {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Field)

    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_TIMESTAMP_INVALID' ($Field + ' must be an explicit UTC timestamp.')
    }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal,
            [ref]$parsed)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_TIMESTAMP_INVALID' ($Field + ' is invalid.')
    }
    return $parsed.ToUniversalTime()
}

function Get-DysonQualificationProperty {
    param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Name, [switch]$Required)

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        if ($Required) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_FIELD_MISSING' ($Name + ' is required.') }
        return $null
    }
    return $property.Value
}

function Assert-DysonQualificationExactProperties {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string[]]$Allowed,
        [Parameter(Mandatory)][string]$Context
    )

    $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $actual) {
        if ($name -cnotin $Allowed) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_UNKNOWN_FIELD' ($Context + ' contains unknown field ' + $name + '.')
        }
    }
    foreach ($name in $Allowed) {
        if ($name -cnotin $actual) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_FIELD_MISSING' ($Context + '.' + $name + ' is required.')
        }
    }
}

function Test-DysonQualificationPublicValue {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$InputObject)

    $reasons = New-Object System.Collections.Generic.List[string]
    $forbiddenNamePart = '(?i)^(path|file|directory|root|host|hostname|domain|endpoint|address|ip|ipaddress|player|userid|username|credential|password|secret|token|cookie|savename|log|raw|steam|tunnel)$'
    $forbiddenValue = '(?i)(^[a-z]:\\|^\\\\|^/|https?://|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+\.(?:com|net|org|cn|io|local)\b|\.dsv\b|\.server\b|BEGIN [A-Z ]+PRIVATE KEY)'

    function Visit-DysonQualificationPublicNode {
        param($Value, [string]$Location)
        if ($null -eq $Value) { return }
        if ($Value -is [string]) {
            if ($Value -cmatch $forbiddenValue) { $reasons.Add('forbidden-value:' + $Location) }
            if ($Value.Length -gt 256) { $reasons.Add('oversized-value:' + $Location) }
            return
        }
        if ($Value -is [System.Collections.IDictionary]) {
            foreach ($key in $Value.Keys) {
                $name = [string]$key
                $normalizedName = ($name -creplace '([a-z0-9])([A-Z])', '$1-$2') -replace '_', '-'
                $parts = @($normalizedName -split '-')
                if (@($parts | Where-Object { $_ -match $forbiddenNamePart }).Count -gt 0) { $reasons.Add('forbidden-field:' + $Location + '.' + $name) }
                Visit-DysonQualificationPublicNode $Value[$key] ($Location + '.' + $name)
            }
            return
        }
        if ($Value -is [System.Collections.IEnumerable]) {
            $index = 0
            foreach ($item in $Value) {
                Visit-DysonQualificationPublicNode $item ($Location + '[' + $index + ']')
                $index++
            }
            return
        }
        foreach ($property in @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property') })) {
            $normalizedName = ($property.Name -creplace '([a-z0-9])([A-Z])', '$1-$2') -replace '_', '-'
            $parts = @($normalizedName -split '-')
            if (@($parts | Where-Object { $_ -match $forbiddenNamePart }).Count -gt 0) { $reasons.Add('forbidden-field:' + $Location + '.' + $property.Name) }
            Visit-DysonQualificationPublicNode $property.Value ($Location + '.' + $property.Name)
        }
    }

    Visit-DysonQualificationPublicNode $InputObject '$'
    [pscustomobject][ordered]@{ valid = ($reasons.Count -eq 0); reasons = @($reasons); productionChanged = $false }
}

function Get-DysonQualificationReceiptDigest {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Receipt)

    $unsigned = [ordered]@{}
    foreach ($property in @($Receipt.PSObject.Properties | Where-Object { $_.Name -cne 'receiptSha256' } | Sort-Object Name)) {
        $unsigned[$property.Name] = $property.Value
    }
    return Get-DysonQualificationSha256 -InputObject $unsigned
}

function New-DysonQualificationReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ReceiptId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$IdempotencyKey,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{2,63}$')][string]$StepId,
        [Parameter(Mandatory)][int]$Sequence,
        [Parameter(Mandatory)][string]$Event,
        [Parameter(Mandatory)][ValidateSet('observed', 'passed', 'failed', 'interrupted', 'rolled-back')][string]$Status,
        [Parameter(Mandatory)][DateTimeOffset]$IssuedAtUtc,
        [Parameter(Mandatory)][DateTimeOffset]$ExpiresAtUtc,
        [AllowNull()][string]$PredecessorSha256,
        [Parameter(Mandatory)][string]$EvidenceOpaqueId,
        [Parameter(Mandatory)][string]$EvidenceType,
        [Parameter(Mandatory)][string]$EvidenceSha256,
        [Parameter(Mandatory)][DateTimeOffset]$EvidenceObservedAtUtc,
        [Parameter(Mandatory)][DateTimeOffset]$EvidenceExpiresAtUtc,
        [Parameter(Mandatory)][string]$AttestationClass,
        [string[]]$CheckCodes = @(),
        [AllowNull()][string]$ChallengeId,
        [AllowNull()][string]$TranscriptBindingSha256
    )

    $receipt = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationProtocol
        schemaVersion = $script:DysonQualificationSchemaVersion
        receiptId = $ReceiptId
        runId = $RunId
        idempotencyKey = $IdempotencyKey
        stepId = $StepId
        sequence = $Sequence
        event = $Event
        status = $Status
        issuedAtUtc = $IssuedAtUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        expiresAtUtc = $ExpiresAtUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        predecessorSha256 = $PredecessorSha256
        challengeId = $ChallengeId
        evidenceRef = [pscustomobject][ordered]@{
            opaqueId = $EvidenceOpaqueId
            type = $EvidenceType
            sha256 = $EvidenceSha256
            observedAtUtc = $EvidenceObservedAtUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            expiresAtUtc = $EvidenceExpiresAtUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            attestationClass = $AttestationClass
        }
        publicSummary = [pscustomobject][ordered]@{
            checkCodes = @($CheckCodes | Sort-Object -Unique)
            transcriptBindingSha256 = $TranscriptBindingSha256
        }
        receiptSha256 = $null
    }
    $receipt.receiptSha256 = Get-DysonQualificationReceiptDigest -Receipt $receipt
    [void](Assert-DysonQualificationReceipt -Receipt $receipt -NowUtc $IssuedAtUtc)
    return $receipt
}

function Assert-DysonQualificationReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Receipt,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [switch]$AllowExpired
    )

    foreach ($name in @('protocol','schemaVersion','receiptId','runId','idempotencyKey','stepId','sequence','event','status',
            'issuedAtUtc','expiresAtUtc','predecessorSha256','evidenceRef','publicSummary','receiptSha256')) {
        [void](Get-DysonQualificationProperty -Object $Receipt -Name $name -Required)
    }
    Assert-DysonQualificationExactProperties -Object $Receipt -Context 'receipt' -Allowed @(
        'protocol','schemaVersion','receiptId','runId','idempotencyKey','stepId','sequence','event','status',
        'issuedAtUtc','expiresAtUtc','predecessorSha256','challengeId','evidenceRef','publicSummary','receiptSha256'
    )
    if ([string]$Receipt.protocol -cne $script:DysonQualificationProtocol -or [int]$Receipt.schemaVersion -ne $script:DysonQualificationSchemaVersion) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PROTOCOL_MISMATCH' 'Receipt protocol or schema version is not supported.'
    }
    foreach ($field in @('receiptId','runId','idempotencyKey')) {
        if (-not (Test-DysonQualificationUuid -Value ([string]$Receipt.$field))) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_UUID_INVALID' ($field + ' must be a canonical lower-case D UUID.')
        }
    }
    if ([int]$Receipt.sequence -lt 1 -or [string]$Receipt.stepId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$') {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'Receipt sequence or stepId is invalid.'
    }
    if ([string]$Receipt.event -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$') {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'Receipt event must be a bounded fixed code.'
    }
    if (-not [string]::IsNullOrEmpty([string]$Receipt.challengeId) -and
        -not (Test-DysonQualificationUuid -Value ([string]$Receipt.challengeId))) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_UUID_INVALID' 'challengeId must be null or a canonical lower-case D UUID.'
    }
    if ([string]$Receipt.status -cnotin @('observed','passed','failed','interrupted','rolled-back')) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'Receipt status is not allowed.'
    }
    $issued = ConvertFrom-DysonQualificationUtcTimestamp ([string]$Receipt.issuedAtUtc) 'issuedAtUtc'
    $expires = ConvertFrom-DysonQualificationUtcTimestamp ([string]$Receipt.expiresAtUtc) 'expiresAtUtc'
    if ($expires -le $issued -or $expires -gt $issued.AddHours(24)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'Receipt expiry must be after issue and no more than 24 hours later.'
    }
    if (-not $AllowExpired -and $NowUtc.ToUniversalTime() -gt $expires) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_EXPIRED' 'Receipt has expired.'
    }
    if ($issued -gt $NowUtc.ToUniversalTime().AddMinutes(1)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'Receipt issue time is in the future.'
    }
    if ([int]$Receipt.sequence -eq 1) {
        if (-not [string]::IsNullOrEmpty([string]$Receipt.predecessorSha256)) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHAIN_INVALID' 'The first receipt cannot have a predecessor.'
        }
    }
    elseif (-not (Test-DysonQualificationDigest ([string]$Receipt.predecessorSha256))) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHAIN_INVALID' 'A non-initial receipt requires a predecessor digest.'
    }

    $evidence = $Receipt.evidenceRef
    Assert-DysonQualificationExactProperties -Object $evidence -Context 'receipt.evidenceRef' -Allowed @(
        'opaqueId','type','sha256','observedAtUtc','expiresAtUtc','attestationClass'
    )
    Assert-DysonQualificationExactProperties -Object $Receipt.publicSummary -Context 'receipt.publicSummary' -Allowed @(
        'checkCodes','transcriptBindingSha256'
    )
    foreach ($name in @('opaqueId','type','sha256','observedAtUtc','expiresAtUtc','attestationClass')) {
        [void](Get-DysonQualificationProperty -Object $evidence -Name $name -Required)
    }
    if (-not (Test-DysonQualificationUuid -Value ([string]$evidence.opaqueId) -ErrorAction SilentlyContinue)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Evidence opaqueId must be a canonical UUID.'
    }
    if (-not (Test-DysonQualificationDigest ([string]$evidence.sha256))) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Evidence digest must be lower-case SHA-256.'
    }
    if ([string]$evidence.type -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        [string]$evidence.attestationClass -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$') {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Evidence type and attestationClass must be fixed public codes.'
    }
    foreach ($code in @($Receipt.publicSummary.checkCodes)) {
        if ([string]$code -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$') {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PUBLIC_DATA_REJECTED' 'checkCodes must contain bounded public codes.'
        }
    }
    if ($Receipt.publicSummary.checkCodes -is [string] -or
        -not ($Receipt.publicSummary.checkCodes -is [System.Collections.IEnumerable])) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_RECEIPT_INVALID' 'publicSummary.checkCodes must be a JSON array.'
    }
    $binding = [string]$Receipt.publicSummary.transcriptBindingSha256
    if (-not [string]::IsNullOrEmpty($binding) -and -not (Test-DysonQualificationDigest $binding)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_DIGEST_INVALID' 'Transcript binding digest is invalid.'
    }
    $observed = ConvertFrom-DysonQualificationUtcTimestamp ([string]$evidence.observedAtUtc) 'evidenceRef.observedAtUtc'
    $evidenceExpires = ConvertFrom-DysonQualificationUtcTimestamp ([string]$evidence.expiresAtUtc) 'evidenceRef.expiresAtUtc'
    if ($observed -gt $issued.AddMinutes(5) -or $evidenceExpires -le $observed -or $evidenceExpires -gt $observed.AddHours(24)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Evidence timing is invalid.'
    }
    if ($observed -gt $NowUtc.ToUniversalTime().AddMinutes(1)) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_INVALID' 'Evidence observation time is in the future.'
    }
    if (-not $AllowExpired -and $NowUtc.ToUniversalTime() -gt $evidenceExpires) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_EXPIRED' 'Private evidence reference has expired.'
    }
    if (-not (Test-DysonQualificationDigest ([string]$Receipt.receiptSha256))) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_DIGEST_INVALID' 'Receipt digest is invalid.'
    }
    $expected = Get-DysonQualificationReceiptDigest -Receipt $Receipt
    if ($expected -cne [string]$Receipt.receiptSha256) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EVIDENCE_TAMPERED' 'Receipt digest does not match its content.'
    }
    $public = Test-DysonQualificationPublicValue -InputObject $Receipt
    if (-not $public.valid) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_PUBLIC_DATA_REJECTED' (($public.reasons | Select-Object -First 4) -join ',')
    }
    return $Receipt
}

function Test-DysonQualificationReceiptChain {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Receipts,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [switch]$AllowExpired,
        [switch]$AllowSegment
    )

    $reasons = New-Object System.Collections.Generic.List[string]
    $seenReceipt = @{}
    $seenIdempotency = @{}
    $previous = $null
    $expectedSequence = if ($AllowSegment -and @($Receipts).Count -gt 0) { [int]$Receipts[0].sequence } else { 1 }
    foreach ($receipt in @($Receipts)) {
        try { [void](Assert-DysonQualificationReceipt -Receipt $receipt -NowUtc $NowUtc -AllowExpired:$AllowExpired) }
        catch { $reasons.Add($_.Exception.Message); continue }
        if ([int]$receipt.sequence -ne $expectedSequence) { $reasons.Add('sequence-gap:' + $expectedSequence) }
        if ($null -ne $previous -and [string]$receipt.predecessorSha256 -cne [string]$previous.receiptSha256) {
            $reasons.Add('predecessor-mismatch:' + $expectedSequence)
        }
        foreach ($keyName in @('receiptId','idempotencyKey')) {
            $key = [string]$receipt.$keyName
            $set = if ($keyName -eq 'receiptId') { $seenReceipt } else { $seenIdempotency }
            if ($set.ContainsKey($key)) {
                if ([string]$set[$key] -cne [string]$receipt.receiptSha256) { $reasons.Add('conflicting-duplicate:' + $keyName) }
                else { $reasons.Add('duplicate-in-chain:' + $keyName) }
            }
            else { $set[$key] = [string]$receipt.receiptSha256 }
        }
        $previous = $receipt
        $expectedSequence++
    }
    [pscustomobject][ordered]@{
        valid = ($reasons.Count -eq 0)
        count = @($Receipts).Count
        lastReceiptSha256 = if ($null -eq $previous) { $null } else { [string]$previous.receiptSha256 }
        reasons = @($reasons)
        productionChanged = $false
    }
}

function Add-DysonQualificationReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Receipts,
        [Parameter(Mandatory)]$Receipt,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    [void](Assert-DysonQualificationReceipt -Receipt $Receipt -NowUtc $NowUtc)
    foreach ($existing in @($Receipts)) {
        if ([string]$existing.receiptId -ceq [string]$Receipt.receiptId -or
            [string]$existing.idempotencyKey -ceq [string]$Receipt.idempotencyKey) {
            if ([string]$existing.receiptSha256 -ceq [string]$Receipt.receiptSha256) {
                return [pscustomobject][ordered]@{ receipts = @($Receipts); duplicate = $true; accepted = $true; productionChanged = $false }
            }
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_DUPLICATE_CONFLICT' 'A receipt or idempotency key was reused with different content.'
        }
    }
    $expectedSequence = @($Receipts).Count + 1
    if ([int]$Receipt.sequence -ne $expectedSequence) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_OUT_OF_ORDER' 'Receipt sequence is not the next checkpoint sequence.'
    }
    $expectedPredecessor = if (@($Receipts).Count -eq 0) { $null } else { [string]$Receipts[-1].receiptSha256 }
    if ([string]$Receipt.predecessorSha256 -cne [string]$expectedPredecessor) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHAIN_INVALID' 'Receipt predecessor does not match the current checkpoint.'
    }
    $next = @($Receipts) + @($Receipt)
    $test = Test-DysonQualificationReceiptChain -Receipts $next -NowUtc $NowUtc
    if (-not $test.valid) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_CHAIN_INVALID' ($test.reasons -join ',') }
    [pscustomobject][ordered]@{ receipts = $next; duplicate = $false; accepted = $true; productionChanged = $false }
}

function Assert-DysonExternalClientReceiptSequence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$Receipts,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [int]$MaximumTotalSeconds = 2400
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
    $maximumLegSeconds = @(300,300,300,300,300,300,600,300,300,600,120)
    if (@($Receipts).Count -ne $events.Count) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_SEQUENCE_INVALID' 'The external sequence must contain exactly 11 receipts.'
    }
    $chain = Test-DysonQualificationReceiptChain -Receipts @($Receipts) -NowUtc $NowUtc -AllowSegment
    if (-not $chain.valid) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_CHAIN_INVALID' ($chain.reasons -join ',')
    }
    $firstChallenge = $null
    $secondChallenge = $null
    $firstObserved = $null
    $previousObserved = $null
    $transcriptRunId = $null
    for ($index = 0; $index -lt $events.Count; $index++) {
        $receipt = $Receipts[$index]
        [void](Assert-DysonQualificationReceipt -Receipt $receipt -NowUtc $NowUtc)
        if ($null -eq $transcriptRunId) { $transcriptRunId = [string]$receipt.runId }
        elseif ([string]$receipt.runId -cne $transcriptRunId) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_RUN_INVALID' 'Every external receipt must belong to one run.'
        }
        $expectedStatus = if ($index -eq ($events.Count - 1)) { 'passed' } else { 'observed' }
        if ([string]$receipt.status -cne $expectedStatus) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_STATUS_INVALID' ('External event did not reach its required success status at ' + $events[$index] + '.')
        }
        if ([string]$receipt.stepId -cne 'external-client-e2e' -or [string]$receipt.event -cne $events[$index]) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_OUT_OF_ORDER' ('Expected ' + $events[$index] + ' at external sequence index ' + $index + '.')
        }
        if ([string]$receipt.evidenceRef.type -cne $types[$index] -or [string]$receipt.evidenceRef.attestationClass -cne $classes[$index]) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_EVIDENCE_INVALID' ('Evidence class is not authoritative for ' + $events[$index] + '.')
        }
        if ([string]$receipt.evidenceRef.type -in @('http-status','tcp-port-open','client-self-report')) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_EVIDENCE_INVALID' 'Transport reachability or a self-report cannot prove a real game join.'
        }
        if (-not (Test-DysonQualificationUuid -Value ([string]$receipt.challengeId))) {
            Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_CHALLENGE_INVALID' 'Each external receipt requires a canonical challenge ID.'
        }
        if ($index -le 7) {
            if ($null -eq $firstChallenge) { $firstChallenge = [string]$receipt.challengeId }
            elseif ([string]$receipt.challengeId -cne $firstChallenge) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_CHALLENGE_INVALID' 'Initial join receipts changed challenge ID.' }
        }
        else {
            if ($null -eq $secondChallenge) { $secondChallenge = [string]$receipt.challengeId }
            elseif ([string]$receipt.challengeId -cne $secondChallenge) { Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_CHALLENGE_INVALID' 'Reconnect receipts changed challenge ID.' }
        }
        $observed = ConvertFrom-DysonQualificationUtcTimestamp ([string]$receipt.evidenceRef.observedAtUtc) 'evidenceRef.observedAtUtc'
        if ($null -eq $firstObserved) { $firstObserved = $observed }
        if ($null -ne $previousObserved) {
            $delta = ($observed - $previousObserved).TotalSeconds
            if ($delta -lt 0 -or $delta -gt $maximumLegSeconds[$index]) {
                Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_TIMING_INVALID' ('External event timing failed at ' + $events[$index] + '.')
            }
        }
        $previousObserved = $observed
    }
    if ($firstChallenge -ceq $secondChallenge) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_CHALLENGE_INVALID' 'Reconnect must use a fresh challenge ID.'
    }
    $expectedBinding = Get-DysonQualificationSha256 -InputObject ([ordered]@{
        protocol = 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1'
        firstChallengeId = $firstChallenge
        reconnectChallengeId = $secondChallenge
        predecessorSha256 = [string]$Receipts[9].receiptSha256
    })
    if ([string]$Receipts[10].publicSummary.transcriptBindingSha256 -cne $expectedBinding) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_BINDING_INVALID' 'Final dual-party attestation is not bound to both challenges and the preceding transcript hash.'
    }
    if (($previousObserved - $firstObserved).TotalSeconds -gt $MaximumTotalSeconds) {
        Throw-DysonQualificationProtocolError 'DYSON_QUALIFICATION_EXTERNAL_TIMING_INVALID' 'External sequence exceeded its total time bound.'
    }
    [pscustomobject][ordered]@{
        valid = $true
        realJoinProven = $true
        independentSaveAcknowledgementProven = $true
        reconnectProven = $true
        identityCollected = $false
        networkAddressCollected = $false
        productionChanged = $false
    }
}

function Test-DysonExternalClientTranscript {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$Receipts,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [int]$MaximumTotalSeconds = 2400
    )

    try {
        $result = Assert-DysonExternalClientReceiptSequence -Receipts $Receipts -NowUtc $NowUtc -MaximumTotalSeconds $MaximumTotalSeconds
        return [pscustomobject][ordered]@{
            valid = $true
            realJoinProven = [bool]$result.realJoinProven
            independentSaveAcknowledgementProven = [bool]$result.independentSaveAcknowledgementProven
            reconnectProven = [bool]$result.reconnectProven
            reasons = @()
            productionChanged = $false
        }
    }
    catch {
        return [pscustomobject][ordered]@{
            valid = $false
            realJoinProven = $false
            independentSaveAcknowledgementProven = $false
            reconnectProven = $false
            reasons = @($_.Exception.Message)
            productionChanged = $false
        }
    }
}

function Test-DysonQualificationSoakWindow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][DateTimeOffset]$StartUtc,
        [Parameter(Mandatory)][DateTimeOffset]$EndUtc,
        [Parameter(Mandatory)][ValidateSet('real-monotonic','shadow-virtual')][string]$ClockClass,
        [int]$MinimumElapsedSeconds = 21600
    )

    $elapsed = [Math]::Floor(($EndUtc.ToUniversalTime() - $StartUtc.ToUniversalTime()).TotalSeconds)
    $reasons = New-Object System.Collections.Generic.List[string]
    if ($MinimumElapsedSeconds -lt 21600) { $reasons.Add('minimum-below-six-hours') }
    if ($elapsed -lt 0) { $reasons.Add('clock-reversed') }
    if ($elapsed -lt $MinimumElapsedSeconds) { $reasons.Add('elapsed-time-insufficient') }
    $durationSatisfied = $reasons.Count -eq 0
    [pscustomobject][ordered]@{
        valid = $durationSatisfied
        durationSatisfied = $durationSatisfied
        clockClass = $ClockClass
        elapsedSeconds = [int64]$elapsed
        productionQualified = ($durationSatisfied -and $ClockClass -ceq 'real-monotonic')
        virtualClockOnly = ($ClockClass -ceq 'shadow-virtual')
        reasons = @($reasons)
        productionChanged = $false
    }
}

function Normalize-DysonQualificationTargetIdentity {
    param([AllowNull()][string]$Value)
    if ($Value -cmatch '^sha256:([0-9a-f]{64})$') { return 'sha256:' + $Matches[1] }
    if ($Value -cmatch '^[0-9a-f]{64}$') { return 'sha256:' + $Value }
    return $null
}

function Test-DysonQualificationExecutionGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Request,
        [Alias('Now')][DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [string]$RequiredEnvironmentValue = $script:DysonQualificationProtocolExecuteEnvironmentValue,
        [string]$EnvironmentName = $script:DysonQualificationProtocolExecuteEnvironmentName
    )

    $reasons = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('protocol','schemaVersion','requestId','action','mode','targetIdentity','issuedAt','maintenanceWindow','protectionPoint','confirmationPhrase')) {
        if ($null -eq $Request.PSObject.Properties[$name]) { $reasons.Add('missing-' + $name) }
    }
    $mode = [string](Get-DysonQualificationProperty -Object $Request -Name 'mode')
    $requestId = [string](Get-DysonQualificationProperty -Object $Request -Name 'requestId')
    if ([string]$Request.protocol -cne 'DYSON_QUALIFICATION_ACTION_REQUEST_V1' -or [int]$Request.schemaVersion -ne 1) { $reasons.Add('request-protocol-invalid') }
    if (-not (Test-DysonQualificationUuid -Value $requestId)) { $reasons.Add('request-id-invalid') }
    if ($mode -cnotin @('preview','execute')) { $reasons.Add('mode-invalid') }
    if ([string]$Request.action -cnotin $script:DysonQualificationProtocolActions) { $reasons.Add('action-not-allowlisted') }
    $expectedIdentity = Normalize-DysonQualificationTargetIdentity $ExpectedTargetIdentity
    $actualIdentity = Normalize-DysonQualificationTargetIdentity ([string]$Request.targetIdentity)
    if ($null -eq $expectedIdentity -or $null -eq $actualIdentity -or $expectedIdentity -cne $actualIdentity) { $reasons.Add('target-identity-mismatch') }

    if ($mode -eq 'execute') {
        if ([Environment]::GetEnvironmentVariable($EnvironmentName, 'Process') -cne $RequiredEnvironmentValue) { $reasons.Add('execution-disabled') }
        $expectedConfirmation = 'EXECUTE DYSON QUALIFICATION SHADOW ' + ([string]$Request.action).ToUpperInvariant() + ' ' + $requestId
        if ([string]$Request.confirmationPhrase -cne $expectedConfirmation) { $reasons.Add('confirmation-phrase-invalid') }
        try {
            $issued = ConvertFrom-DysonQualificationUtcTimestamp ([string]$Request.issuedAt) 'issuedAt'
            if ($issued -gt $NowUtc.AddMinutes(1) -or $issued -lt $NowUtc.AddMinutes(-15)) { $reasons.Add('request-stale') }
            $windowStart = ConvertFrom-DysonQualificationUtcTimestamp ([string]$Request.maintenanceWindow.startAt) 'maintenanceWindow.startAt'
            $windowEnd = ConvertFrom-DysonQualificationUtcTimestamp ([string]$Request.maintenanceWindow.endAt) 'maintenanceWindow.endAt'
            if ($windowEnd -le $windowStart -or $windowEnd -gt $windowStart.AddHours(4) -or $NowUtc -lt $windowStart -or $NowUtc -gt $windowEnd) { $reasons.Add('maintenance-window-invalid') }
        }
        catch { $reasons.Add('request-time-invalid') }

        $point = $Request.protectionPoint
        if ($null -eq $point) { $reasons.Add('protection-point-missing') }
        else {
            if ([string]$point.protocol -cne 'DYSON_QUALIFICATION_PROTECTION_POINT_V1' -or [int]$point.schemaVersion -ne 1) { $reasons.Add('protection-point-protocol-invalid') }
            if (-not (Test-DysonQualificationUuid -Value ([string]$point.protectionPointId))) { $reasons.Add('protection-point-id-invalid') }
            if ((Normalize-DysonQualificationTargetIdentity ([string]$point.targetIdentity)) -cne $expectedIdentity) { $reasons.Add('protection-point-target-mismatch') }
            if ($null -eq (Normalize-DysonQualificationTargetIdentity ([string]$point.savePairDigest)) -or
                $null -eq (Normalize-DysonQualificationTargetIdentity ([string]$point.evidenceDigest))) {
                $reasons.Add('protection-point-digest-invalid')
            }
            try {
                $pointCreated = ConvertFrom-DysonQualificationUtcTimestamp ([string]$point.createdAt) 'protectionPoint.createdAt'
                $pointExpires = ConvertFrom-DysonQualificationUtcTimestamp ([string]$point.expiresAt) 'protectionPoint.expiresAt'
                if ($pointCreated -gt $NowUtc.AddMinutes(1) -or $pointCreated -lt $NowUtc.AddMinutes(-30) -or $pointExpires -le $NowUtc -or $pointExpires -gt $pointCreated.AddHours(2)) { $reasons.Add('protection-point-stale') }
            }
            catch { $reasons.Add('protection-point-time-invalid') }
        }
    }

    [pscustomobject][ordered]@{
        enabled = ($reasons.Count -eq 0)
        allowed = ($reasons.Count -eq 0)
        mode = $mode
        requestId = $requestId
        reasons = @($reasons | Sort-Object -Unique)
        checkCodes = @($reasons | Sort-Object -Unique)
        productionChanged = $false
    }
}
