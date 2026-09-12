Set-StrictMode -Version 2.0

$script:DysonQualificationActionRequestProtocol = 'DYSON_QUALIFICATION_ACTION_REQUEST_V1'
$script:DysonQualificationActionReceiptProtocol = 'DYSON_QUALIFICATION_ACTION_RECEIPT_V1'
$script:DysonQualificationProtectionPointProtocol = 'DYSON_QUALIFICATION_PROTECTION_POINT_V1'
$script:DysonQualificationExecutorProtocol = 'DYSON_QUALIFICATION_EXECUTOR_V1'
$script:DysonQualificationExecutorEnvironmentName = 'DYSON_QUALIFICATION_EXECUTE'
$script:DysonQualificationExecutorEnvironmentValue = 'SHADOW_FIXTURE_ONLY_V1'
$script:DysonQualificationActions = @(
    'windows-restart',
    'control-plane-restart',
    'dsp-crash-recovery',
    'storage-interruption',
    'disk-pressure',
    'update-rollback',
    'gsmanager-switch',
    'save-restore'
)

function New-DysonQualificationExecutorException {
    param([Parameter(Mandatory)][string]$Code)

    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonQualificationExecutorError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonQualificationExecutorException -Code $Code)
}

function Get-DysonQualificationExecutorErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)

    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '^DYSON_QUALIFICATION_[A-Z0-9_]+$') {
        return [string]$Exception.Message
    }
    return 'DYSON_QUALIFICATION_UNEXPECTED_FAILURE'
}

function Test-DysonQualificationExecutorGuid {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) { return $false }
    return $parsed.ToString('D').ToLowerInvariant() -ceq $Value
}

function Test-DysonQualificationExecutorIdentity {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^sha256:[0-9a-f]{64}$'
}

function Test-DysonQualificationExecutorDigest {
    param([AllowNull()][string]$Value)
    return Test-DysonQualificationExecutorIdentity -Value $Value
}

function ConvertTo-DysonQualificationExecutorCanonicalValue {
    param([AllowNull()]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or
        $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or
        $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) {
        return $Value
    }
    if ($Value -is [datetime] -or $Value -is [datetimeoffset] -or $Value -is [guid]) {
        return [string]$Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $ordered[$key] = ConvertTo-DysonQualificationExecutorCanonicalValue -Value $Value[$key]
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(ConvertTo-DysonQualificationExecutorCanonicalValue -Value $item)
        }
        return ,$items
    }
    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -match 'Property' } |
        Sort-Object -Property Name -CaseSensitive)
    if ($properties.Count -eq 0) {
        if ($Value -is [pscustomobject]) { return [pscustomobject][ordered]@{} }
        return [string]$Value
    }
    $result = [ordered]@{}
    foreach ($property in $properties) {
        $result[$property.Name] = ConvertTo-DysonQualificationExecutorCanonicalValue -Value $property.Value
    }
    return [pscustomobject]$result
}

function ConvertTo-DysonQualificationExecutorCanonicalJson {
    param([Parameter(Mandatory)][AllowEmptyCollection()]$Value)
    $canonical = ConvertTo-DysonQualificationExecutorCanonicalValue -Value $Value
    return ConvertTo-Json -InputObject $canonical -Depth 64 -Compress
}

function Get-DysonQualificationExecutorSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
        $digest = $sha.ComputeHash($bytes)
        return 'sha256:' + ([System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
    }
    finally { $sha.Dispose() }
}

function Get-DysonQualificationExecutorObjectDigest {
    param([Parameter(Mandatory)]$Value)
    return Get-DysonQualificationExecutorSha256 -Value (
        ConvertTo-DysonQualificationExecutorCanonicalJson -Value $Value
    )
}

function ConvertFrom-DysonQualificationExecutorUtc {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Code)

    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
        Throw-DysonQualificationExecutorError -Code $Code
    }
    $parsed = [datetimeoffset]::MinValue
    $valid = [datetimeoffset]::TryParseExact(
        $Value,
        'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsed
    )
    if (-not $valid) { Throw-DysonQualificationExecutorError -Code $Code }
    return $parsed.ToUniversalTime()
}

function ConvertTo-DysonQualificationExecutorUtc {
    param([Parameter(Mandatory)][datetimeoffset]$Value)
    return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-DysonQualificationRequiredConfirmationPhrase {
    param(
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$RequestId
    )
    return 'EXECUTE DYSON QUALIFICATION SHADOW ' + $Action.ToUpperInvariant() + ' ' + $RequestId
}

function Get-DysonQualificationAdapterContract {
    param([Parameter(Mandatory)][string]$Action)

    if ($script:DysonQualificationActions -cnotcontains $Action) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ACTION_NOT_ALLOWLISTED'
    }
    $contractPath = Join-Path $PSScriptRoot 'fixtures\adapter-contract.v1.json'
    try {
        $item = Get-Item -LiteralPath $contractPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 65536) {
            throw 'invalid contract'
        }
        $contract = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    }
    catch { Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ADAPTER_CONTRACT_INVALID' }
    if ([string]$contract.protocol -cne 'DYSON_QUALIFICATION_ADAPTER_CONTRACT_V1' -or
        [int]$contract.schemaVersion -ne 1) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ADAPTER_CONTRACT_INVALID'
    }
    $matches = @($contract.actions | Where-Object { [string]$_.action -ceq $Action })
    if ($matches.Count -ne 1) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ADAPTER_CONTRACT_INVALID'
    }
    return $matches[0]
}

function Assert-DysonQualificationActionParameters {
    param([Parameter(Mandatory)]$Request)

    $parameters = $Request.parameters
    if ($null -eq $parameters) { return }
    $propertyNames = @($parameters.PSObject.Properties | ForEach-Object { [string]$_.Name })
    switch ([string]$Request.action) {
        'storage-interruption' {
            if ($propertyNames.Count -ne 1 -or $propertyNames -cnotcontains 'durationSeconds' -or
                [int]$parameters.durationSeconds -lt 1 -or [int]$parameters.durationSeconds -gt 300) {
                Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ACTION_BOUNDS_INVALID'
            }
        }
        'disk-pressure' {
            if ($propertyNames.Count -ne 2 -or $propertyNames -cnotcontains 'durationSeconds' -or
                $propertyNames -cnotcontains 'targetPercent' -or
                [int]$parameters.durationSeconds -lt 1 -or [int]$parameters.durationSeconds -gt 300 -or
                [int]$parameters.targetPercent -lt 1 -or [int]$parameters.targetPercent -gt 85) {
                Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ACTION_BOUNDS_INVALID'
            }
        }
        default {
            if ($propertyNames.Count -gt 0) {
                Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_ACTION_BOUNDS_INVALID'
            }
        }
    }
}

function Assert-DysonQualificationActionRequest {
    param([Parameter(Mandatory)]$Request)

    $required = @(
        'protocol', 'schemaVersion', 'requestId', 'action', 'mode', 'targetIdentity',
        'issuedAt', 'maintenanceWindow', 'protectionPoint', 'confirmationPhrase', 'parameters'
    )
    $names = @($Request.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $required) {
        if ($names -cnotcontains $name) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
        }
    }
    if ($names.Count -ne $required.Count -or
        [string]$Request.protocol -cne $script:DysonQualificationActionRequestProtocol -or
        [int]$Request.schemaVersion -ne 1 -or
        -not (Test-DysonQualificationExecutorGuid -Value ([string]$Request.requestId)) -or
        $script:DysonQualificationActions -cnotcontains [string]$Request.action -or
        @('preview', 'execute') -cnotcontains [string]$Request.mode -or
        -not (Test-DysonQualificationExecutorIdentity -Value ([string]$Request.targetIdentity))) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
    }
    [void](ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$Request.issuedAt) `
        -Code 'DYSON_QUALIFICATION_REQUEST_INVALID')
    Assert-DysonQualificationActionParameters -Request $Request
}

function Get-DysonQualificationProtectionPointUnsigned {
    param([Parameter(Mandatory)]$ProtectionPoint)
    return [pscustomobject][ordered]@{
        protocol = [string]$ProtectionPoint.protocol
        schemaVersion = [int]$ProtectionPoint.schemaVersion
        protectionPointId = [string]$ProtectionPoint.protectionPointId
        targetIdentity = [string]$ProtectionPoint.targetIdentity
        createdAt = [string]$ProtectionPoint.createdAt
        expiresAt = [string]$ProtectionPoint.expiresAt
        savePairDigest = [string]$ProtectionPoint.savePairDigest
    }
}

function Test-DysonQualificationProtectionPoint {
    param(
        [Parameter(Mandatory)]$ProtectionPoint,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )

    $required = @('protocol', 'schemaVersion', 'protectionPointId', 'targetIdentity', 'createdAt',
        'expiresAt', 'savePairDigest', 'evidenceDigest')
    $names = @($ProtectionPoint.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $required) {
        if ($names -cnotcontains $name) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
        }
    }
    if ($names.Count -ne $required.Count -or
        [string]$ProtectionPoint.protocol -cne $script:DysonQualificationProtectionPointProtocol -or
        [int]$ProtectionPoint.schemaVersion -ne 1 -or
        -not (Test-DysonQualificationExecutorGuid -Value ([string]$ProtectionPoint.protectionPointId)) -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$ProtectionPoint.savePairDigest)) -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$ProtectionPoint.evidenceDigest))) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    }
    if ([string]$ProtectionPoint.targetIdentity -cne $ExpectedTargetIdentity) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_TARGET_IDENTITY_MISMATCH'
    }
    $created = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$ProtectionPoint.createdAt) `
        -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    $expires = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$ProtectionPoint.expiresAt) `
        -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    if ($created -gt $NowUtc.AddMinutes(1) -or $expires -le $created -or
        $expires -gt $created.AddHours(2)) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    }
    if ($created -lt $NowUtc.AddMinutes(-30) -or $expires -lt $NowUtc) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_STALE'
    }
    $expected = Get-DysonQualificationExecutorObjectDigest -Value (
        Get-DysonQualificationProtectionPointUnsigned -ProtectionPoint $ProtectionPoint
    )
    if ([string]$ProtectionPoint.evidenceDigest -cne $expected) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_PROTECTION_POINT_INVALID'
    }
    return $true
}

function Assert-DysonQualificationExecutionGate {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )

    if ([string]$Request.mode -cne 'execute') {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EXECUTE_MODE_REQUIRED'
    }
    $environmentValue = [Environment]::GetEnvironmentVariable(
        $script:DysonQualificationExecutorEnvironmentName,
        [EnvironmentVariableTarget]::Process
    )
    if ([string]$environmentValue -cne $script:DysonQualificationExecutorEnvironmentValue) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EXECUTION_DISABLED'
    }
    if ([string]$Request.targetIdentity -cne $ExpectedTargetIdentity) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_TARGET_IDENTITY_MISMATCH'
    }
    $expectedPhrase = Get-DysonQualificationRequiredConfirmationPhrase `
        -Action ([string]$Request.action) -RequestId ([string]$Request.requestId)
    if ([string]$Request.confirmationPhrase -cne $expectedPhrase) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_CONFIRMATION_INVALID'
    }
    $issued = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$Request.issuedAt) `
        -Code 'DYSON_QUALIFICATION_REQUEST_INVALID'
    if ($issued -lt $NowUtc.AddMinutes(-30) -or $issued -gt $NowUtc.AddMinutes(1)) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_REQUEST_STALE'
    }
    $window = $Request.maintenanceWindow
    $windowNames = @($window.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($windowNames.Count -ne 2 -or $windowNames -cnotcontains 'startAt' -or
        $windowNames -cnotcontains 'endAt') {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_MAINTENANCE_WINDOW_INVALID'
    }
    $start = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$window.startAt) `
        -Code 'DYSON_QUALIFICATION_MAINTENANCE_WINDOW_INVALID'
    $end = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$window.endAt) `
        -Code 'DYSON_QUALIFICATION_MAINTENANCE_WINDOW_INVALID'
    if ($end -le $start -or $end -gt $start.AddHours(4) -or $NowUtc -lt $start -or $NowUtc -gt $end) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_MAINTENANCE_WINDOW_INVALID'
    }
    [void](Test-DysonQualificationProtectionPoint -ProtectionPoint $Request.protectionPoint `
        -ExpectedTargetIdentity $ExpectedTargetIdentity -NowUtc $NowUtc)
    return [pscustomobject][ordered]@{
        enabled = $true
        canonicalRequestId = $true
        environmentGate = $true
        exactConfirmation = $true
        targetMatched = $true
        maintenanceWindowActive = $true
        protectionPointFresh = $true
        productionChanged = $false
    }
}

function Get-DysonQualificationActionRequestDigest {
    param([Parameter(Mandatory)]$Request)

    $unsigned = [pscustomobject][ordered]@{
        protocol = [string]$Request.protocol
        schemaVersion = [int]$Request.schemaVersion
        requestId = [string]$Request.requestId
        action = [string]$Request.action
        mode = [string]$Request.mode
        targetIdentity = [string]$Request.targetIdentity
        issuedAt = [string]$Request.issuedAt
        maintenanceWindow = $Request.maintenanceWindow
        protectionPoint = $Request.protectionPoint
        confirmationPhrase = [string]$Request.confirmationPhrase
        parameters = $Request.parameters
    }
    return Get-DysonQualificationExecutorObjectDigest -Value $unsigned
}

function Get-DysonQualificationActionReceiptUnsigned {
    param([Parameter(Mandatory)]$Receipt)

    return [pscustomobject][ordered]@{
        protocol = [string]$Receipt.protocol
        schemaVersion = [int]$Receipt.schemaVersion
        requestId = [string]$Receipt.requestId
        requestDigest = [string]$Receipt.requestDigest
        action = [string]$Receipt.action
        mode = [string]$Receipt.mode
        status = [string]$Receipt.status
        targetIdentity = [string]$Receipt.targetIdentity
        executedInShadow = [bool]$Receipt.executedInShadow
        productionChanged = [bool]$Receipt.productionChanged
        sequence = [int64]$Receipt.sequence
        observedAt = [string]$Receipt.observedAt
        expiresAt = [string]$Receipt.expiresAt
        checkpointId = [string]$Receipt.checkpointId
        previousEvidenceDigest = [string]$Receipt.previousEvidenceDigest
        rollback = $Receipt.rollback
        outcome = $Receipt.outcome
    }
}

function Assert-DysonQualificationActionReceipt {
    param([Parameter(Mandatory)]$Receipt)

    try {
    $topLevel = @(
        'protocol', 'schemaVersion', 'requestId', 'requestDigest', 'action', 'mode', 'status',
        'reused', 'targetIdentity', 'executedInShadow', 'productionChanged', 'sequence',
        'observedAt', 'expiresAt', 'checkpointId', 'previousEvidenceDigest', 'rollback',
        'outcome', 'evidenceDigest'
    )
    $names = @($Receipt.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $topLevel) {
        if ($names -cnotcontains $name) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
        }
    }
    if ($names.Count -ne $topLevel.Count -or
        [string]$Receipt.protocol -cne $script:DysonQualificationActionReceiptProtocol -or
        [int]$Receipt.schemaVersion -ne 1 -or
        -not (Test-DysonQualificationExecutorGuid -Value ([string]$Receipt.requestId)) -or
        [string]$Receipt.checkpointId -cne [string]$Receipt.requestId -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$Receipt.requestDigest)) -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$Receipt.previousEvidenceDigest)) -or
        -not (Test-DysonQualificationExecutorDigest -Value ([string]$Receipt.evidenceDigest)) -or
        -not (Test-DysonQualificationExecutorIdentity -Value ([string]$Receipt.targetIdentity)) -or
        $script:DysonQualificationActions -cnotcontains [string]$Receipt.action -or
        [string]$Receipt.mode -cne 'execute' -or
        @('passed', 'failed') -cnotcontains [string]$Receipt.status -or
        -not [bool]$Receipt.executedInShadow -or [bool]$Receipt.productionChanged -or
        [int64]$Receipt.sequence -lt 1) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    $observed = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$Receipt.observedAt) `
        -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    $expires = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$Receipt.expiresAt) `
        -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    if ($expires -le $observed -or $expires -gt $observed.AddHours(24)) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    $rollbackNames = @($Receipt.rollback.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($rollbackNames.Count -ne 2 -or $rollbackNames -cnotcontains 'defined' -or
        $rollbackNames -cnotcontains 'status' -or -not [bool]$Receipt.rollback.defined -or
        @('not-required', 'failed') -cnotcontains [string]$Receipt.rollback.status) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    $expectedOutcomeNames = @(switch ([string]$Receipt.action) {
        'windows-restart' { @('recovered', 'bootIdentityChanged') }
        'control-plane-restart' { @('recovered') }
        'dsp-crash-recovery' { @('recovered', 'pairedSaveRevision') }
        'storage-interruption' { @('recovered', 'interruptionSeconds') }
        'disk-pressure' { @('relieved', 'peakPercent') }
        'update-rollback' {
            if ([string]$Receipt.status -ceq 'failed') { @('code', 'manualRecoveryRequired') }
            else { @('previousReleaseActivated') }
        }
        'gsmanager-switch' { @('recoverable', 'state') }
        'save-restore' { @('pairedSaveRestored', 'pairedSaveRevision') }
    })
    $outcomeNames = @($Receipt.outcome.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($outcomeNames.Count -ne $expectedOutcomeNames.Count) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    foreach ($name in $expectedOutcomeNames) {
        if ($outcomeNames -cnotcontains $name) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
        }
    }
    if ([string]$Receipt.status -ceq 'failed') {
        if ([string]$Receipt.action -cne 'update-rollback' -or
            [string]$Receipt.rollback.status -cne 'failed' -or
            [string]$Receipt.outcome.code -cne 'DYSON_QUALIFICATION_SHADOW_ROLLBACK_FAILED' -or
            -not [bool]$Receipt.outcome.manualRecoveryRequired) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
        }
    }
    elseif ([string]$Receipt.rollback.status -cne 'not-required') {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    $expectedDigest = Get-DysonQualificationExecutorObjectDigest -Value (
        Get-DysonQualificationActionReceiptUnsigned -Receipt $Receipt
    )
    if ([string]$Receipt.evidenceDigest -cne $expectedDigest) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
    return $true
    }
    catch {
        if ((Get-DysonQualificationExecutorErrorCode -Exception $_.Exception) -ceq
            'DYSON_QUALIFICATION_RECEIPT_INVALID') {
            throw
        }
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_RECEIPT_INVALID'
    }
}

function Test-DysonQualificationActionReceiptChain {
    param(
        [Parameter(Mandatory)][object[]]$Receipts,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [switch]$RequireFresh
    )

    $previousDigest = 'sha256:' + ('0' * 64)
    $previousObserved = [datetimeoffset]::MinValue
    $expectedSequence = [int64]1
    foreach ($receipt in @($Receipts)) {
        try { [void](Assert-DysonQualificationActionReceipt -Receipt $receipt) }
        catch { Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID' }
        if ([int64]$receipt.sequence -ne $expectedSequence -or
            [string]$receipt.previousEvidenceDigest -cne $previousDigest -or
            -not (Test-DysonQualificationExecutorDigest -Value ([string]$receipt.evidenceDigest))) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
        }
        $observed = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$receipt.observedAt) `
            -Code 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
        $expires = ConvertFrom-DysonQualificationExecutorUtc -Value ([string]$receipt.expiresAt) `
            -Code 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
        if ($observed -lt $previousObserved -or $expires -le $observed) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EVIDENCE_CHAIN_INVALID'
        }
        if ($RequireFresh -and $expires -lt $NowUtc) {
            Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_EVIDENCE_EXPIRED'
        }
        $previousDigest = [string]$receipt.evidenceDigest
        $previousObserved = $observed
        $expectedSequence++
    }
    return [pscustomobject][ordered]@{
        valid = $true
        receiptCount = @($Receipts).Count
        lastEvidenceDigest = $previousDigest
        productionChanged = $false
    }
}

function Invoke-DysonQualificationAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][ValidateSet('Contract', 'Shadow')][string]$Backend,
        [string]$ShadowRoot,
        [switch]$Resume,
        [ValidateSet('None', 'HardExitAfterCheckpoint', 'RollbackFailure')][string]$Injection = 'None'
    )

    Assert-DysonQualificationActionRequest -Request $Request
    $adapter = Get-DysonQualificationAdapterContract -Action ([string]$Request.action)
    if ([string]$Request.mode -ceq 'preview') {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualificationExecutorProtocol
            schemaVersion = 1
            requestId = [string]$Request.requestId
            action = [string]$Request.action
            mode = 'preview'
            status = 'preview'
            backend = $Backend.ToLowerInvariant()
            wouldMutate = $true
            executed = $false
            productionChanged = $false
            requiredEnvironment = $script:DysonQualificationExecutorEnvironmentName
            requiredEnvironmentValue = $script:DysonQualificationExecutorEnvironmentValue
            requiredConfirmationPhrase = Get-DysonQualificationRequiredConfirmationPhrase `
                -Action ([string]$Request.action) -RequestId ([string]$Request.requestId)
            adapter = $adapter
        }
    }
    if ($Backend -ceq 'Contract') {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualificationExecutorProtocol
            schemaVersion = 1
            requestId = [string]$Request.requestId
            action = [string]$Request.action
            mode = 'execute'
            status = 'unsupported'
            backend = 'contract'
            executed = $false
            productionChanged = $false
            reasonCode = 'DYSON_QUALIFICATION_REAL_ADAPTER_NOT_INTEGRATED'
            adapter = $adapter
        }
    }
    if ([string]::IsNullOrWhiteSpace($ShadowRoot)) {
        Throw-DysonQualificationExecutorError -Code 'DYSON_QUALIFICATION_SHADOW_ROOT_REQUIRED'
    }
    if ($null -eq (Get-Command Invoke-DysonQualificationShadowAdapter -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'Qualification.Shadow.ps1')
    }
    return Invoke-DysonQualificationShadowAdapter -Request $Request -ShadowRoot $ShadowRoot `
        -Resume:$Resume -Injection $Injection
}
