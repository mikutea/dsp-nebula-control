Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DysonPairedSaveLoadProtocol = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'
$script:DysonPairedSaveLoadPairProtocol = 'DYSON_QUALIFICATION_PAIRED_SAVE_PAIR_V2'
$script:DysonPairedSaveLoadRecoveryReceiptProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'
$script:DysonPairedSaveLoadRecoveryBundleProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_BUNDLE_V1'
$script:DysonPairedSaveLoadBridgeEvidenceProtocol = 'DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1'
$script:DysonPairedSaveLoadBridgeReceiptProtocol = 'DYSON_CONTROL_RECEIPT_V2'
$script:DysonPairedSaveLoadSaveSlot = '_lastexit_'
$script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds = 14400

function Throw-DysonPairedSaveLoadError {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.IO.InvalidDataException($Code)
    $exception.Data['Code'] = $Code
    throw $exception
}

function Assert-DysonPairedSaveLoadExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    )
    if ($null -eq $Value) { Throw-DysonPairedSaveLoadError $Code }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $Names.Count) { Throw-DysonPairedSaveLoadError $Code }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { Throw-DysonPairedSaveLoadError $Code }
    }
}

function Test-DysonPairedSaveLoadInteger {
    param($Value)
    return ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or
        $Value -is [uint16] -or $Value -is [uint32])
}

function Assert-DysonPairedSaveLoadPositiveInteger {
    param($Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    if (-not (Test-DysonPairedSaveLoadInteger $Value) -or [int64]$Value -le 0) {
        Throw-DysonPairedSaveLoadError $Code
    }
    return [int64]$Value
}

function Assert-DysonPairedSaveLoadNonNegativeInteger {
    param($Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    if (-not (Test-DysonPairedSaveLoadInteger $Value) -or [int64]$Value -lt 0) {
        Throw-DysonPairedSaveLoadError $Code
    }
    return [int64]$Value
}

function Assert-DysonPairedSaveLoadGuid {
    param([Parameter(Mandatory)][string]$Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    $parsed = [guid]::Empty
    if ($Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
        -not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) {
        Throw-DysonPairedSaveLoadError $Code
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonPairedSaveLoadDigest {
    param([Parameter(Mandatory)][string]$Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    if ($Value -cnotmatch '^[0-9a-f]{64}$') { Throw-DysonPairedSaveLoadError $Code }
    return $Value
}

function Assert-DysonPairedSaveLoadIdentityDigest {
    param([Parameter(Mandatory)][string]$Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    if ($Value -cnotmatch '^sha256:[0-9a-f]{64}$') { Throw-DysonPairedSaveLoadError $Code }
    return $Value
}

function ConvertTo-DysonPairedSaveLoadUtc {
    param($Value, [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID')
    try {
        $parsed = if ($Value -is [datetimeoffset]) {
            [datetimeoffset]$Value
        }
        elseif ($Value -is [datetime]) {
            [datetimeoffset]([datetime]$Value)
        }
        elseif ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$Value)) {
            [datetimeoffset]::Parse(
                [string]$Value,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
        }
        else { throw 'timestamp' }
        return $parsed.ToUniversalTime()
    }
    catch { Throw-DysonPairedSaveLoadError $Code }
}

function Format-DysonPairedSaveLoadUtc {
    param([Parameter(Mandatory)][datetimeoffset]$Value)
    return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-DysonPairedSaveLoadCanonicalValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
        $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) {
        return $Value
    }
    if ($Value -is [datetime] -or $Value -is [datetimeoffset] -or $Value -is [guid]) { return [string]$Value }
    if ($Value -is [Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $result[$key] = ConvertTo-DysonPairedSaveLoadCanonicalValue $Value[$key]
        }
        return [pscustomobject]$result
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-DysonPairedSaveLoadCanonicalValue $item) }
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
        $result[$property.Name] = ConvertTo-DysonPairedSaveLoadCanonicalValue $property.Value
    }
    return [pscustomobject]$result
}

function ConvertTo-DysonPairedSaveLoadCanonicalJson {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonPairedSaveLoadCanonicalValue $Value | ConvertTo-Json -Depth 24 -Compress)
}

function Get-DysonPairedSaveLoadTextSha256 {
    param([Parameter(Mandatory)][string]$Value)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Read-DysonPairedSaveLoadBridgeSecret {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-DysonPairedSaveLoadFile -Path $Path -MaximumBytes 4096
    try {
        $raw = [IO.File]::ReadAllText($item.FullName, (New-Object Text.UTF8Encoding($false, $true)))
        $secret = $raw.Trim()
        if ($secret.Length -lt 32 -or $secret.Length -gt 512 -or $secret.Contains("`r") -or
            $secret.Contains("`n") -or $secret.IndexOf([char]0) -ge 0) {
            throw 'secret'
        }
        return $secret
    }
    catch { Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BRIDGE_SECRET_INVALID' }
}

function Get-DysonPairedSaveLoadHmacSha256 {
    param([Parameter(Mandatory)][string]$Secret, [Parameter(Mandatory)][string[]]$Parts)
    $algorithm = New-Object Security.Cryptography.HMACSHA256
    try {
        $algorithm.Key = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($Secret)
        $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes(($Parts -join "`n"))
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Test-DysonPairedSaveLoadFixedDigestEqual {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ([int][char]$Left[$index] -bxor [int][char]$Right[$index])
    }
    return $difference -eq 0
}

function Get-DysonPairedSaveLoadFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = [int64]::MaxValue,
        [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    )
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            [int64]$item.Length -le 0 -or [int64]$item.Length -gt $MaximumBytes) {
            throw 'file'
        }
        return $item
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonPairedSaveLoadError $Code
    }
}

function Get-DysonPairedSaveLoadFileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-DysonPairedSaveLoadFile -Path $Path -Code 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    catch { Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID' }
    finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Read-DysonPairedSaveLoadJson {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 1048576)
    $item = Get-DysonPairedSaveLoadFile -Path $Path -MaximumBytes $MaximumBytes
    try {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        $text = [IO.File]::ReadAllText($item.FullName, $encoding)
        return ($text | ConvertFrom-Json)
    }
    catch { Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID' }
}

function Read-DysonPairedSaveLoadKeyValueFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Keys
    )
    $item = Get-DysonPairedSaveLoadFile -Path $Path -MaximumBytes 65536
    try {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        $text = [IO.File]::ReadAllText($item.FullName, $encoding)
        if ($text.Contains("`r") -or -not $text.EndsWith("`n", [StringComparison]::Ordinal)) { throw 'wire' }
        $lines = @($text.Split([char]10))
        if ($lines.Count -ne ($Keys.Count + 1) -or $lines[$lines.Count - 1] -cne '') { throw 'wire' }
        $result = [ordered]@{}
        for ($index = 0; $index -lt $Keys.Count; $index++) {
            $prefix = $Keys[$index] + '='
            if (-not $lines[$index].StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'wire' }
            $value = $lines[$index].Substring($prefix.Length)
            if ([string]::IsNullOrEmpty($value) -or $value.Contains('=')) { throw 'wire' }
            $result[$Keys[$index]] = $value
        }
        return [pscustomobject]$result
    }
    catch { Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID' }
}

function ConvertFrom-DysonPairedSaveLoadCanonicalInt64 {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^(?:0|[1-9][0-9]{0,18})$') {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $parsed = 0L
    if (-not [int64]::TryParse($Value, [ref]$parsed)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    return $parsed
}

function Read-DysonPairedSaveLoadRecoveryReceipt {
    param([Parameter(Mandatory)][string]$Path)
    $raw = Read-DysonPairedSaveLoadJson -Path $Path
    Assert-DysonPairedSaveLoadExactProperties $raw @(
        'protocol','schemaVersion','recordKind','operation','operationId','requestFingerprint',
        'dataRootIdentity','bundleId','outcome','manifestSha256','protectionManifestSha256',
        'errorCode','completedAt'
    )
    if ($raw.protocol -isnot [string] -or [string]$raw.protocol -cne $script:DysonPairedSaveLoadRecoveryReceiptProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $raw.schemaVersion) -or [int64]$raw.schemaVersion -ne 1 -or
        $raw.recordKind -isnot [string] -or [string]$raw.recordKind -cne 'receipt' -or
        $raw.operation -isnot [string] -or [string]$raw.operation -cne 'restore' -or
        $raw.outcome -isnot [string] -or [string]$raw.outcome -cne 'succeeded' -or
        $null -ne $raw.errorCode) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $completed = ConvertTo-DysonPairedSaveLoadUtc $raw.completedAt
    return [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadRecoveryReceiptProtocol
        schemaVersion = 1
        sourceSha256 = Get-DysonPairedSaveLoadFileSha256 $Path
        operationId = Assert-DysonPairedSaveLoadGuid ([string]$raw.operationId)
        requestFingerprint = Assert-DysonPairedSaveLoadDigest ([string]$raw.requestFingerprint)
        dataRootIdentity = Assert-DysonPairedSaveLoadIdentityDigest ([string]$raw.dataRootIdentity)
        bundleId = Assert-DysonPairedSaveLoadGuid ([string]$raw.bundleId)
        manifestSha256 = Assert-DysonPairedSaveLoadDigest ([string]$raw.manifestSha256)
        protectionManifestSha256 = Assert-DysonPairedSaveLoadDigest ([string]$raw.protectionManifestSha256)
        completedAtUtc = Format-DysonPairedSaveLoadUtc $completed
    }
}

function Read-DysonPairedSaveLoadProtectionPoint {
    param([Parameter(Mandatory)][string]$Path)
    $raw = Read-DysonPairedSaveLoadJson -Path $Path -MaximumBytes 16777216
    Assert-DysonPairedSaveLoadExactProperties $raw @(
        'protocol','schemaVersion','bundleId','bundleKind','dataRootIdentity','createdAt',
        'fileCount','directoryCount','totalBytes','inventorySha256','entries'
    )
    if ($raw.protocol -isnot [string] -or [string]$raw.protocol -cne $script:DysonPairedSaveLoadRecoveryBundleProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $raw.schemaVersion) -or [int64]$raw.schemaVersion -ne 1 -or
        $raw.bundleKind -isnot [string] -or [string]$raw.bundleKind -cne 'protection-point' -or
        $raw.entries -isnot [System.Array]) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $fileCount = Assert-DysonPairedSaveLoadNonNegativeInteger $raw.fileCount
    $directoryCount = Assert-DysonPairedSaveLoadPositiveInteger $raw.directoryCount
    $totalBytes = Assert-DysonPairedSaveLoadNonNegativeInteger $raw.totalBytes
    if ($fileCount -gt 100000 -or $directoryCount -gt 100000 -or
        ($fileCount + $directoryCount) -gt 100000 -or $totalBytes -gt 1099511627776 -or
        @($raw.entries).Count -ne ($fileCount + $directoryCount)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $observedFiles = 0L
    $observedDirectories = 0L
    $observedBytes = 0L
    $rootSeen = $false
    foreach ($entry in @($raw.entries)) {
        Assert-DysonPairedSaveLoadExactProperties $entry @('relativePath','type','length','sha256','aclIntent')
        if ($entry.relativePath -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$entry.relativePath) -or
            $entry.type -isnot [string]) {
            Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
        }
        $length = Assert-DysonPairedSaveLoadNonNegativeInteger $entry.length
        [void](Assert-DysonPairedSaveLoadDigest ([string]$entry.sha256))
        if ([string]$entry.type -ceq 'file') {
            if ($length -gt (1099511627776 - $observedBytes)) {
                Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
            }
            $observedFiles++
            $observedBytes += $length
        }
        elseif ([string]$entry.type -ceq 'directory' -and $length -eq 0) {
            $observedDirectories++
            if ([string]$entry.relativePath -ceq '.') { $rootSeen = $true }
        }
        else { Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID' }
    }
    if (-not $rootSeen -or $observedFiles -ne $fileCount -or $observedDirectories -ne $directoryCount -or
        $observedBytes -ne $totalBytes) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadRecoveryBundleProtocol
        schemaVersion = 1
        sourceSha256 = Get-DysonPairedSaveLoadFileSha256 $Path
        protectionPointId = Assert-DysonPairedSaveLoadGuid ([string]$raw.bundleId)
        dataRootIdentity = Assert-DysonPairedSaveLoadIdentityDigest ([string]$raw.dataRootIdentity)
        createdAtUtc = Format-DysonPairedSaveLoadUtc (ConvertTo-DysonPairedSaveLoadUtc $raw.createdAt)
        inventorySha256 = Assert-DysonPairedSaveLoadDigest ([string]$raw.inventorySha256)
        fileCount = $fileCount
        totalBytes = $totalBytes
    }
}

function Read-DysonPairedSaveLoadBridgeEvidence {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$BridgeSecret)
    $keys = @(
        'protocol','sessionId','pluginVersion','processId','processStartedAtUnixMs','bridgeStartedAtUnixMs',
        'observationGeneration','observedAtUnixMs','writtenAtUnixMs','saveName','dsvBytes',
        'dsvWriteTimeUtcTicks','dsvSha256','serverBytes','serverWriteTimeUtcTicks','serverSha256','hmac'
    )
    $raw = Read-DysonPairedSaveLoadKeyValueFile -Path $Path -Keys $keys
    if ([string]$raw.protocol -cne $script:DysonPairedSaveLoadBridgeEvidenceProtocol -or
        [string]$raw.pluginVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?$' -or
        [string]$raw.saveName -cne $script:DysonPairedSaveLoadSaveSlot -or
        [string]$raw.hmac -cnotmatch '^[0-9a-f]{64}$') {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $expectedHmac = Get-DysonPairedSaveLoadHmacSha256 -Secret $BridgeSecret `
        -Parts @($keys[0..($keys.Count - 2)] | ForEach-Object { [string]$raw.$_ })
    if (-not (Test-DysonPairedSaveLoadFixedDigestEqual ([string]$raw.hmac) $expectedHmac)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BRIDGE_SIGNATURE_INVALID'
    }
    $processId = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.processId)
    $processStarted = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.processStartedAtUnixMs)
    $bridgeStarted = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.bridgeStartedAtUnixMs)
    $generation = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.observationGeneration)
    $observed = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.observedAtUnixMs)
    $written = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.writtenAtUnixMs)
    $dsvBytes = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.dsvBytes)
    $dsvTicks = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.dsvWriteTimeUtcTicks)
    $serverBytes = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.serverBytes)
    $serverTicks = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.serverWriteTimeUtcTicks)
    if ($processId -le 0 -or $processId -gt [int]::MaxValue -or $processStarted -le 0 -or
        $bridgeStarted -lt $processStarted -or $generation -le 0 -or $observed -lt $bridgeStarted -or
        $written -lt $observed -or ($written - $observed) -gt 5000 -or
        $dsvBytes -le 0 -or $dsvTicks -le 0 -or $serverBytes -le 0 -or $serverTicks -le 0) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadBridgeEvidenceProtocol
        sourceSha256 = Get-DysonPairedSaveLoadFileSha256 $Path
        sessionId = Assert-DysonPairedSaveLoadGuid ([string]$raw.sessionId)
        pluginVersion = [string]$raw.pluginVersion
        processId = $processId
        processStartedAtUnixMs = $processStarted
        bridgeStartedAtUnixMs = $bridgeStarted
        observationGeneration = $generation
        observedAtUnixMs = $observed
        writtenAtUnixMs = $written
        saveName = $script:DysonPairedSaveLoadSaveSlot
        dsvBytes = $dsvBytes
        dsvWriteTimeUtcTicks = $dsvTicks
        dsvSha256 = Assert-DysonPairedSaveLoadDigest ([string]$raw.dsvSha256)
        serverBytes = $serverBytes
        serverWriteTimeUtcTicks = $serverTicks
        serverSha256 = Assert-DysonPairedSaveLoadDigest ([string]$raw.serverSha256)
    }
}

function Get-DysonPairedSaveLoadGenerationId {
    param([Parameter(Mandatory)]$Receipt)
    $input = @(
        'dyson-control-save-generation-v1',
        $script:DysonPairedSaveLoadSaveSlot,
        ([string]$Receipt.saveTimeAfter),
        ([string]$Receipt.dsvBytes),
        ([string]$Receipt.dsvWriteTimeUtcTicks),
        ([string]$Receipt.serverBytes),
        ([string]$Receipt.serverWriteTimeUtcTicks)
    ) -join "`n"
    return 'generation-v1:' + (Get-DysonPairedSaveLoadTextSha256 $input)
}

function Read-DysonPairedSaveLoadSaveAcknowledgement {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$BridgeSecret)
    $keys = @(
        'protocol','requestId','action','state','startedAtUnixMs','finishedAtUnixMs','saveName',
        'saveTimeBefore','saveTimeAfter','dsvBytes','dsvWriteTimeUtcTicks','serverBytes',
        'serverWriteTimeUtcTicks','dsvChanged','serverChanged','errorCode','hmac'
    )
    $raw = Read-DysonPairedSaveLoadKeyValueFile -Path $Path -Keys $keys
    if ([string]$raw.protocol -cne $script:DysonPairedSaveLoadBridgeReceiptProtocol -or
        [string]$raw.action -cne 'save' -or [string]$raw.state -cne 'succeeded' -or
        [string]$raw.saveName -cne $script:DysonPairedSaveLoadSaveSlot -or
        [string]$raw.dsvChanged -cne 'true' -or [string]$raw.serverChanged -cne 'true' -or
        [string]$raw.errorCode -cne 'NONE' -or [string]$raw.hmac -cnotmatch '^[0-9a-f]{64}$') {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $expectedHmac = Get-DysonPairedSaveLoadHmacSha256 -Secret $BridgeSecret `
        -Parts @($keys[0..($keys.Count - 2)] | ForEach-Object { [string]$raw.$_ })
    if (-not (Test-DysonPairedSaveLoadFixedDigestEqual ([string]$raw.hmac) $expectedHmac)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BRIDGE_SIGNATURE_INVALID'
    }
    $started = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.startedAtUnixMs)
    $finished = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.finishedAtUnixMs)
    $before = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.saveTimeBefore)
    $after = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.saveTimeAfter)
    $receipt = [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadBridgeReceiptProtocol
        sourceSha256 = Get-DysonPairedSaveLoadFileSha256 $Path
        requestId = Assert-DysonPairedSaveLoadGuid ([string]$raw.requestId)
        startedAtUnixMs = $started
        finishedAtUnixMs = $finished
        saveTimeBefore = $before
        saveTimeAfter = $after
        dsvBytes = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.dsvBytes)
        dsvWriteTimeUtcTicks = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.dsvWriteTimeUtcTicks)
        serverBytes = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.serverBytes)
        serverWriteTimeUtcTicks = ConvertFrom-DysonPairedSaveLoadCanonicalInt64 ([string]$raw.serverWriteTimeUtcTicks)
        saveGenerationId = $null
    }
    if ($started -le 0 -or $finished -lt $started -or $before -lt 0 -or $after -le $before -or
        $receipt.dsvBytes -le 0 -or $receipt.dsvWriteTimeUtcTicks -le 0 -or
        $receipt.serverBytes -le 0 -or $receipt.serverWriteTimeUtcTicks -le 0) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SOURCE_INVALID'
    }
    $receipt.saveGenerationId = Get-DysonPairedSaveLoadGenerationId $receipt
    return $receipt
}

function Get-DysonPairedSaveLoadStablePair {
    param(
        [Parameter(Mandatory)][string]$DsvPath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)]$LoadedSave,
        [Parameter(Mandatory)]$SaveAcknowledgement
    )
    $dsv = Get-DysonPairedSaveLoadFile -Path $DsvPath -Code 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_INVALID'
    $server = Get-DysonPairedSaveLoadFile -Path $ServerPath -Code 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_INVALID'
    if ([IO.Path]::GetExtension($dsv.Name) -cne '.dsv' -or [IO.Path]::GetExtension($server.Name) -cne '.server' -or
        [IO.Path]::GetFileNameWithoutExtension($dsv.Name) -cne $script:DysonPairedSaveLoadSaveSlot -or
        [IO.Path]::GetFileNameWithoutExtension($server.Name) -cne $script:DysonPairedSaveLoadSaveSlot -or
        $dsv.FullName -ieq $server.FullName) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_INVALID'
    }
    $dsvLengthBefore = [int64]$dsv.Length
    $dsvTicksBefore = [int64]$dsv.LastWriteTimeUtc.Ticks
    $serverLengthBefore = [int64]$server.Length
    $serverTicksBefore = [int64]$server.LastWriteTimeUtc.Ticks
    $dsvSha256 = Get-DysonPairedSaveLoadFileSha256 $dsv.FullName
    $serverSha256 = Get-DysonPairedSaveLoadFileSha256 $server.FullName
    $dsv.Refresh()
    $server.Refresh()
    if ([int64]$dsv.Length -ne $dsvLengthBefore -or [int64]$dsv.LastWriteTimeUtc.Ticks -ne $dsvTicksBefore -or
        [int64]$server.Length -ne $serverLengthBefore -or [int64]$server.LastWriteTimeUtc.Ticks -ne $serverTicksBefore) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_UNSTABLE'
    }
    if ($dsvLengthBefore -ne [int64]$LoadedSave.dsvBytes -or $dsvTicksBefore -ne [int64]$LoadedSave.dsvWriteTimeUtcTicks -or
        $dsvSha256 -cne [string]$LoadedSave.dsvSha256 -or
        $serverLengthBefore -ne [int64]$LoadedSave.serverBytes -or
        $serverTicksBefore -ne [int64]$LoadedSave.serverWriteTimeUtcTicks -or
        $serverSha256 -cne [string]$LoadedSave.serverSha256 -or
        $dsvLengthBefore -ne [int64]$SaveAcknowledgement.dsvBytes -or
        $dsvTicksBefore -ne [int64]$SaveAcknowledgement.dsvWriteTimeUtcTicks -or
        $serverLengthBefore -ne [int64]$SaveAcknowledgement.serverBytes -or
        $serverTicksBefore -ne [int64]$SaveAcknowledgement.serverWriteTimeUtcTicks) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'
    }
    $pair = [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadPairProtocol
        saveName = $script:DysonPairedSaveLoadSaveSlot
        dsvLength = $dsvLengthBefore
        dsvWriteTimeUtcTicks = $dsvTicksBefore
        dsvSha256 = $dsvSha256
        serverLength = $serverLengthBefore
        serverWriteTimeUtcTicks = $serverTicksBefore
        serverSha256 = $serverSha256
        pairSha256 = $null
    }
    $pair.pairSha256 = Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson (
        [pscustomobject][ordered]@{
            protocol = $pair.protocol
            saveName = $pair.saveName
            dsvLength = $pair.dsvLength
            dsvWriteTimeUtcTicks = $pair.dsvWriteTimeUtcTicks
            dsvSha256 = $pair.dsvSha256
            serverLength = $pair.serverLength
            serverWriteTimeUtcTicks = $pair.serverWriteTimeUtcTicks
            serverSha256 = $pair.serverSha256
        }
    ))
    return $pair
}

function Get-DysonPairedSaveLoadUnsignedObservation {
    param([Parameter(Mandatory)]$Observation)
    return [pscustomobject][ordered]@{
        protocol = $Observation.protocol
        schemaVersion = $Observation.schemaVersion
        observationId = $Observation.observationId
        qualificationRunId = $Observation.qualificationRunId
        controlRelease = $Observation.controlRelease
        subjectCommit = $Observation.subjectCommit
        restoreReceipt = $Observation.restoreReceipt
        protectionPoint = $Observation.protectionPoint
        bridgeLoadedSave = $Observation.bridgeLoadedSave
        newSaveAcknowledgement = $Observation.newSaveAcknowledgement
        stableSavePair = $Observation.stableSavePair
        rollbackReceipt = $Observation.rollbackReceipt
        observedAtUtc = $Observation.observedAtUtc
        expiresAtUtc = $Observation.expiresAtUtc
    }
}

function Get-DysonPairedSaveLoadObservationDigest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson (
        Get-DysonPairedSaveLoadUnsignedObservation $Observation
    ))
}

function New-DysonPairedSaveLoadObservationValue {
    param(
        [Parameter(Mandatory)][string]$RestoreReceiptPath,
        [Parameter(Mandatory)][string]$ProtectionPointManifestPath,
        [Parameter(Mandatory)][string]$LoadedSaveEvidencePath,
        [Parameter(Mandatory)][string]$SaveAcknowledgementPath,
        [Parameter(Mandatory)][string]$BridgeSecretPath,
        [Parameter(Mandatory)][string]$DsvPath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][string]$RollbackReceiptPath,
        [Parameter(Mandatory)][string]$ObservationId,
        [Parameter(Mandatory)][string]$QualificationRunId,
        [Parameter(Mandatory)][string]$ControlRelease,
        [Parameter(Mandatory)][string]$SubjectCommit,
        [Parameter(Mandatory)][datetimeoffset]$ObservedAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$ExpiresAtUtc
    )
    $observationIdValue = Assert-DysonPairedSaveLoadGuid $ObservationId
    $runIdValue = Assert-DysonPairedSaveLoadGuid $QualificationRunId
    if ($ControlRelease -cnotmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$' -or
        $SubjectCommit -cnotmatch '^[0-9a-f]{40}$') {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_RELEASE_INVALID'
    }
    $observed = $ObservedAtUtc.ToUniversalTime()
    $expires = $ExpiresAtUtc.ToUniversalTime()
    if ($expires -le $observed -or ($expires - $observed).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_TIME_INVALID'
    }
    $restore = Read-DysonPairedSaveLoadRecoveryReceipt $RestoreReceiptPath
    $protection = Read-DysonPairedSaveLoadProtectionPoint $ProtectionPointManifestPath
    $bridgeSecret = Read-DysonPairedSaveLoadBridgeSecret $BridgeSecretPath
    $loaded = Read-DysonPairedSaveLoadBridgeEvidence $LoadedSaveEvidencePath $bridgeSecret
    $save = Read-DysonPairedSaveLoadSaveAcknowledgement $SaveAcknowledgementPath $bridgeSecret
    $rollback = Read-DysonPairedSaveLoadRecoveryReceipt $RollbackReceiptPath
    if ([string]$restore.operationId -cne [string]$protection.protectionPointId -or
        [string]$restore.protectionManifestSha256 -cne [string]$protection.sourceSha256 -or
        [string]$restore.dataRootIdentity -cne [string]$protection.dataRootIdentity -or
        [string]$rollback.operationId -ceq [string]$restore.operationId -or
        [string]$rollback.bundleId -cne [string]$protection.protectionPointId -or
        [string]$rollback.manifestSha256 -cne [string]$protection.sourceSha256 -or
        [string]$rollback.dataRootIdentity -cne [string]$restore.dataRootIdentity) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_RESTORE_BINDING_INVALID'
    }
    if ([int64]$save.startedAtUnixMs -lt (ConvertTo-DysonPairedSaveLoadUtc $restore.completedAtUtc).ToUnixTimeMilliseconds() -or
        [int64]$loaded.observedAtUnixMs -lt [int64]$save.finishedAtUnixMs -or
        (ConvertTo-DysonPairedSaveLoadUtc $rollback.completedAtUtc).ToUnixTimeMilliseconds() -lt [int64]$loaded.writtenAtUnixMs) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'
    }
    $pair = Get-DysonPairedSaveLoadStablePair -DsvPath $DsvPath -ServerPath $ServerPath `
        -LoadedSave $loaded -SaveAcknowledgement $save
    $sourceTimes = @(
        (ConvertTo-DysonPairedSaveLoadUtc $restore.completedAtUtc),
        [datetimeoffset]::FromUnixTimeMilliseconds([int64]$save.finishedAtUnixMs),
        [datetimeoffset]::FromUnixTimeMilliseconds([int64]$loaded.writtenAtUnixMs),
        (ConvertTo-DysonPairedSaveLoadUtc $rollback.completedAtUtc)
    )
    foreach ($sourceTime in $sourceTimes) {
        if ($sourceTime -gt $observed -or ($observed - $sourceTime).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds) {
            Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_STALE'
        }
    }
    $observation = [pscustomobject][ordered]@{
        protocol = $script:DysonPairedSaveLoadProtocol
        schemaVersion = 2
        observationId = $observationIdValue
        qualificationRunId = $runIdValue
        controlRelease = $ControlRelease
        subjectCommit = $SubjectCommit
        restoreReceipt = $restore
        protectionPoint = $protection
        bridgeLoadedSave = $loaded
        newSaveAcknowledgement = $save
        stableSavePair = $pair
        rollbackReceipt = $rollback
        observedAtUtc = Format-DysonPairedSaveLoadUtc $observed
        expiresAtUtc = Format-DysonPairedSaveLoadUtc $expires
        observationSha256 = $null
    }
    $observation.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $observation
    return $observation
}

function ConvertTo-DysonPairedSaveLoadExpectedRawDigest {
    param(
        [Parameter(Mandatory)][string]$Value,
        [string]$Code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    )
    if ($Value -cmatch '^sha256:([0-9a-f]{64})$') { return [string]$Matches[1] }
    if ($Value -cmatch '^[0-9a-f]{64}$') { return $Value }
    Throw-DysonPairedSaveLoadError $Code
}

function Assert-DysonPairedSaveLoadEmbeddedRecoveryReceiptV2 {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Value @(
        'protocol','schemaVersion','sourceSha256','operationId','requestFingerprint','dataRootIdentity',
        'bundleId','manifestSha256','protectionManifestSha256','completedAtUtc'
    ) $code
    if ($Value.protocol -isnot [string] -or [string]$Value.protocol -cne $script:DysonPairedSaveLoadRecoveryReceiptProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $Value.schemaVersion) -or [int64]$Value.schemaVersion -ne 1) {
        Throw-DysonPairedSaveLoadError $code
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.sourceSha256) $code)
    [void](Assert-DysonPairedSaveLoadGuid ([string]$Value.operationId) $code)
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.requestFingerprint) $code)
    [void](Assert-DysonPairedSaveLoadIdentityDigest ([string]$Value.dataRootIdentity) $code)
    [void](Assert-DysonPairedSaveLoadGuid ([string]$Value.bundleId) $code)
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.manifestSha256) $code)
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.protectionManifestSha256) $code)
    return ConvertTo-DysonPairedSaveLoadUtc $Value.completedAtUtc $code
}

function Assert-DysonPairedSaveLoadEmbeddedProtectionPointV2 {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Value @(
        'protocol','schemaVersion','sourceSha256','protectionPointId','dataRootIdentity','createdAtUtc',
        'inventorySha256','fileCount','totalBytes'
    ) $code
    if ($Value.protocol -isnot [string] -or [string]$Value.protocol -cne $script:DysonPairedSaveLoadRecoveryBundleProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $Value.schemaVersion) -or [int64]$Value.schemaVersion -ne 1) {
        Throw-DysonPairedSaveLoadError $code
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.sourceSha256) $code)
    [void](Assert-DysonPairedSaveLoadGuid ([string]$Value.protectionPointId) $code)
    [void](Assert-DysonPairedSaveLoadIdentityDigest ([string]$Value.dataRootIdentity) $code)
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.inventorySha256) $code)
    [void](Assert-DysonPairedSaveLoadNonNegativeInteger $Value.fileCount $code)
    [void](Assert-DysonPairedSaveLoadNonNegativeInteger $Value.totalBytes $code)
    return ConvertTo-DysonPairedSaveLoadUtc $Value.createdAtUtc $code
}

function Assert-DysonPairedSaveLoadEmbeddedLoadedSaveV2 {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Value @(
        'protocol','sourceSha256','sessionId','pluginVersion','processId','processStartedAtUnixMs',
        'bridgeStartedAtUnixMs','observationGeneration','observedAtUnixMs','writtenAtUnixMs','saveName',
        'dsvBytes','dsvWriteTimeUtcTicks','dsvSha256','serverBytes','serverWriteTimeUtcTicks','serverSha256'
    ) $code
    if ($Value.protocol -isnot [string] -or [string]$Value.protocol -cne $script:DysonPairedSaveLoadBridgeEvidenceProtocol -or
        $Value.pluginVersion -isnot [string] -or [string]$Value.pluginVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?$' -or
        $Value.saveName -isnot [string] -or [string]$Value.saveName -cne $script:DysonPairedSaveLoadSaveSlot) {
        Throw-DysonPairedSaveLoadError $code
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.sourceSha256) $code)
    [void](Assert-DysonPairedSaveLoadGuid ([string]$Value.sessionId) $code)
    $positiveNames = @('processId','processStartedAtUnixMs','bridgeStartedAtUnixMs','observationGeneration',
        'observedAtUnixMs','writtenAtUnixMs','dsvBytes','dsvWriteTimeUtcTicks','serverBytes','serverWriteTimeUtcTicks')
    foreach ($name in $positiveNames) { [void](Assert-DysonPairedSaveLoadPositiveInteger $Value.$name $code) }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.dsvSha256) $code)
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.serverSha256) $code)
    if ([int64]$Value.processId -gt [int]::MaxValue -or
        [int64]$Value.bridgeStartedAtUnixMs -lt [int64]$Value.processStartedAtUnixMs -or
        [int64]$Value.observedAtUnixMs -lt [int64]$Value.bridgeStartedAtUnixMs -or
        [int64]$Value.writtenAtUnixMs -lt [int64]$Value.observedAtUnixMs -or
        ([int64]$Value.writtenAtUnixMs - [int64]$Value.observedAtUnixMs) -gt 5000) {
        Throw-DysonPairedSaveLoadError $code
    }
}

function Assert-DysonPairedSaveLoadEmbeddedSaveAcknowledgementV2 {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Value @(
        'protocol','sourceSha256','requestId','startedAtUnixMs','finishedAtUnixMs','saveTimeBefore',
        'saveTimeAfter','dsvBytes','dsvWriteTimeUtcTicks','serverBytes','serverWriteTimeUtcTicks','saveGenerationId'
    ) $code
    if ($Value.protocol -isnot [string] -or [string]$Value.protocol -cne $script:DysonPairedSaveLoadBridgeReceiptProtocol -or
        $Value.saveGenerationId -isnot [string] -or [string]$Value.saveGenerationId -cnotmatch '^generation-v1:[0-9a-f]{64}$') {
        Throw-DysonPairedSaveLoadError $code
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.sourceSha256) $code)
    [void](Assert-DysonPairedSaveLoadGuid ([string]$Value.requestId) $code)
    foreach ($name in @('startedAtUnixMs','finishedAtUnixMs','saveTimeAfter','dsvBytes','dsvWriteTimeUtcTicks','serverBytes','serverWriteTimeUtcTicks')) {
        [void](Assert-DysonPairedSaveLoadPositiveInteger $Value.$name $code)
    }
    [void](Assert-DysonPairedSaveLoadNonNegativeInteger $Value.saveTimeBefore $code)
    if ([int64]$Value.finishedAtUnixMs -lt [int64]$Value.startedAtUnixMs -or
        [int64]$Value.saveTimeAfter -le [int64]$Value.saveTimeBefore -or
        [string]$Value.saveGenerationId -cne (Get-DysonPairedSaveLoadGenerationId $Value)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'
    }
}

function Assert-DysonPairedSaveLoadEmbeddedStablePairV2 {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Value @(
        'protocol','saveName','dsvLength','dsvWriteTimeUtcTicks','dsvSha256',
        'serverLength','serverWriteTimeUtcTicks','serverSha256','pairSha256'
    ) $code
    if ($Value.protocol -isnot [string] -or [string]$Value.protocol -cne $script:DysonPairedSaveLoadPairProtocol -or
        $Value.saveName -isnot [string] -or [string]$Value.saveName -cne $script:DysonPairedSaveLoadSaveSlot) {
        Throw-DysonPairedSaveLoadError $code
    }
    foreach ($name in @('dsvLength','dsvWriteTimeUtcTicks','serverLength','serverWriteTimeUtcTicks')) {
        [void](Assert-DysonPairedSaveLoadPositiveInteger $Value.$name $code)
    }
    foreach ($name in @('dsvSha256','serverSha256','pairSha256')) {
        [void](Assert-DysonPairedSaveLoadDigest ([string]$Value.$name) $code)
    }
    $expectedPairSha256 = Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson (
        [pscustomobject][ordered]@{
            protocol = $script:DysonPairedSaveLoadPairProtocol
            saveName = $script:DysonPairedSaveLoadSaveSlot
            dsvLength = [int64]$Value.dsvLength
            dsvWriteTimeUtcTicks = [int64]$Value.dsvWriteTimeUtcTicks
            dsvSha256 = [string]$Value.dsvSha256
            serverLength = [int64]$Value.serverLength
            serverWriteTimeUtcTicks = [int64]$Value.serverWriteTimeUtcTicks
            serverSha256 = [string]$Value.serverSha256
        }
    ))
    if ([string]$Value.pairSha256 -cne $expectedPairSha256) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_INVALID'
    }
}

function Assert-DysonQualificationPairedSaveLoadRecordV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)][string]$ExpectedObservationId,
        [Parameter(Mandatory)][string]$ExpectedQualificationRunId,
        [Parameter(Mandatory)][string]$ExpectedControlRelease,
        [Parameter(Mandatory)][string]$ExpectedSubjectCommit,
        [Parameter(Mandatory)][string]$ExpectedRestoreSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedProtectionSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedRollbackSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedObservationSha256,
        [Parameter(Mandatory)][datetimeoffset]$ExpectedObservedAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$ExpectedExpiresAtUtc,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )
    $code = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    Assert-DysonPairedSaveLoadExactProperties $Observation @(
        'protocol','schemaVersion','observationId','qualificationRunId','controlRelease','subjectCommit',
        'restoreReceipt','protectionPoint','bridgeLoadedSave','newSaveAcknowledgement','stableSavePair',
        'rollbackReceipt','observedAtUtc','expiresAtUtc','observationSha256'
    ) $code
    if ($Observation.protocol -isnot [string] -or [string]$Observation.protocol -cne $script:DysonPairedSaveLoadProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $Observation.schemaVersion) -or [int64]$Observation.schemaVersion -ne 2) {
        Throw-DysonPairedSaveLoadError $code
    }
    $expectedId = Assert-DysonPairedSaveLoadGuid $ExpectedObservationId 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    $expectedRun = Assert-DysonPairedSaveLoadGuid $ExpectedQualificationRunId 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    if ($ExpectedControlRelease -cnotmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$' -or
        $ExpectedSubjectCommit -cnotmatch '^[0-9a-f]{40}$' -or
        [string]$Observation.observationId -cne $expectedId -or
        [string]$Observation.qualificationRunId -cne $expectedRun -or
        [string]$Observation.controlRelease -cne $ExpectedControlRelease -or
        [string]$Observation.subjectCommit -cne $ExpectedSubjectCommit) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    }
    $expectedRestore = ConvertTo-DysonPairedSaveLoadExpectedRawDigest $ExpectedRestoreSourceSha256
    $expectedProtection = ConvertTo-DysonPairedSaveLoadExpectedRawDigest $ExpectedProtectionSourceSha256
    $expectedRollback = ConvertTo-DysonPairedSaveLoadExpectedRawDigest $ExpectedRollbackSourceSha256
    $expectedObservation = ConvertTo-DysonPairedSaveLoadExpectedRawDigest $ExpectedObservationSha256

    $restoreAt = Assert-DysonPairedSaveLoadEmbeddedRecoveryReceiptV2 $Observation.restoreReceipt
    $protectionAt = Assert-DysonPairedSaveLoadEmbeddedProtectionPointV2 $Observation.protectionPoint
    Assert-DysonPairedSaveLoadEmbeddedLoadedSaveV2 $Observation.bridgeLoadedSave
    Assert-DysonPairedSaveLoadEmbeddedSaveAcknowledgementV2 $Observation.newSaveAcknowledgement
    Assert-DysonPairedSaveLoadEmbeddedStablePairV2 $Observation.stableSavePair
    $rollbackAt = Assert-DysonPairedSaveLoadEmbeddedRecoveryReceiptV2 $Observation.rollbackReceipt

    if ([string]$Observation.restoreReceipt.sourceSha256 -cne $expectedRestore -or
        [string]$Observation.protectionPoint.sourceSha256 -cne $expectedProtection -or
        [string]$Observation.rollbackReceipt.sourceSha256 -cne $expectedRollback -or
        [string]$Observation.restoreReceipt.operationId -cne [string]$Observation.protectionPoint.protectionPointId -or
        [string]$Observation.restoreReceipt.protectionManifestSha256 -cne [string]$Observation.protectionPoint.sourceSha256 -or
        [string]$Observation.restoreReceipt.dataRootIdentity -cne [string]$Observation.protectionPoint.dataRootIdentity -or
        [string]$Observation.rollbackReceipt.operationId -ceq [string]$Observation.restoreReceipt.operationId -or
        [string]$Observation.rollbackReceipt.bundleId -cne [string]$Observation.protectionPoint.protectionPointId -or
        [string]$Observation.rollbackReceipt.manifestSha256 -cne [string]$Observation.protectionPoint.sourceSha256 -or
        [string]$Observation.rollbackReceipt.dataRootIdentity -cne [string]$Observation.restoreReceipt.dataRootIdentity) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_RESTORE_BINDING_INVALID'
    }
    $loaded = $Observation.bridgeLoadedSave
    $save = $Observation.newSaveAcknowledgement
    $pair = $Observation.stableSavePair
    if ([int64]$pair.dsvLength -ne [int64]$loaded.dsvBytes -or
        [int64]$pair.dsvWriteTimeUtcTicks -ne [int64]$loaded.dsvWriteTimeUtcTicks -or
        [string]$pair.dsvSha256 -cne [string]$loaded.dsvSha256 -or
        [int64]$pair.serverLength -ne [int64]$loaded.serverBytes -or
        [int64]$pair.serverWriteTimeUtcTicks -ne [int64]$loaded.serverWriteTimeUtcTicks -or
        [string]$pair.serverSha256 -cne [string]$loaded.serverSha256 -or
        [int64]$pair.dsvLength -ne [int64]$save.dsvBytes -or
        [int64]$pair.dsvWriteTimeUtcTicks -ne [int64]$save.dsvWriteTimeUtcTicks -or
        [int64]$pair.serverLength -ne [int64]$save.serverBytes -or
        [int64]$pair.serverWriteTimeUtcTicks -ne [int64]$save.serverWriteTimeUtcTicks) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'
    }
    $observed = ConvertTo-DysonPairedSaveLoadUtc $Observation.observedAtUtc $code
    $expires = ConvertTo-DysonPairedSaveLoadUtc $Observation.expiresAtUtc $code
    $saveStarted = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$save.startedAtUnixMs)
    $saveFinished = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$save.finishedAtUnixMs)
    $loadedObserved = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$loaded.observedAtUnixMs)
    $loadedWritten = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$loaded.writtenAtUnixMs)
    if ($protectionAt -gt $restoreAt -or $restoreAt -gt $saveStarted -or $saveStarted -gt $saveFinished -or
        $saveFinished -gt $loadedObserved -or $loadedObserved -gt $loadedWritten -or
        $loadedWritten -gt $rollbackAt -or $rollbackAt -gt $observed -or
        $expires -le $observed -or ($expires - $observed).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds -or
        $NowUtc.ToUniversalTime() -ge $expires -or $NowUtc.ToUniversalTime() -lt $observed.AddMinutes(-1) -or
        ($NowUtc.ToUniversalTime() - $observed).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_STALE'
    }
    foreach ($sourceAt in @($protectionAt,$restoreAt,$saveFinished,$loadedWritten,$rollbackAt)) {
        if ($sourceAt -gt $observed -or ($observed - $sourceAt).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds) {
            Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_STALE'
        }
    }
    if ($observed -ne $ExpectedObservedAtUtc.ToUniversalTime() -or
        $expires -ne $ExpectedExpiresAtUtc.ToUniversalTime()) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Observation.observationSha256) $code)
    $actualObservationSha256 = Get-DysonPairedSaveLoadObservationDigest $Observation
    if ([string]$Observation.observationSha256 -cne $actualObservationSha256) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_HASH_MISMATCH'
    }
    if ([string]$Observation.observationSha256 -cne $expectedObservation) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    }
    return [pscustomobject][ordered]@{
        valid = $true
        protocol = $script:DysonPairedSaveLoadProtocol
        schemaVersion = 2
        observationId = [string]$Observation.observationId
        qualificationRunId = [string]$Observation.qualificationRunId
        controlRelease = [string]$Observation.controlRelease
        subjectCommit = [string]$Observation.subjectCommit
        dataRootIdentity = [string]$Observation.restoreReceipt.dataRootIdentity
        saveGenerationId = [string]$Observation.newSaveAcknowledgement.saveGenerationId
        protectionPointSha256 = [string]$Observation.protectionPoint.sourceSha256
        rollbackReceiptSha256 = [string]$Observation.rollbackReceipt.sourceSha256
        stablePairSha256 = [string]$Observation.stableSavePair.pairSha256
        observationSha256 = [string]$Observation.observationSha256
        observedAtUtc = Format-DysonPairedSaveLoadUtc $observed
        expiresAtUtc = Format-DysonPairedSaveLoadUtc $expires
    }
}

function Assert-DysonQualificationPairedSaveLoadObservationV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)][string]$RestoreReceiptPath,
        [Parameter(Mandatory)][string]$ProtectionPointManifestPath,
        [Parameter(Mandatory)][string]$LoadedSaveEvidencePath,
        [Parameter(Mandatory)][string]$SaveAcknowledgementPath,
        [Parameter(Mandatory)][string]$BridgeSecretPath,
        [Parameter(Mandatory)][string]$DsvPath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][string]$RollbackReceiptPath,
        [Parameter(Mandatory)][string]$ExpectedQualificationRunId,
        [Parameter(Mandatory)][string]$ExpectedControlRelease,
        [Parameter(Mandatory)][string]$ExpectedSubjectCommit,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc
    )
    Assert-DysonPairedSaveLoadExactProperties $Observation @(
        'protocol','schemaVersion','observationId','qualificationRunId','controlRelease','subjectCommit',
        'restoreReceipt','protectionPoint','bridgeLoadedSave','newSaveAcknowledgement','stableSavePair',
        'rollbackReceipt','observedAtUtc','expiresAtUtc','observationSha256'
    ) 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    if ($Observation.protocol -isnot [string] -or [string]$Observation.protocol -cne $script:DysonPairedSaveLoadProtocol -or
        -not (Test-DysonPairedSaveLoadInteger $Observation.schemaVersion) -or [int64]$Observation.schemaVersion -ne 2) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    }
    $expectedRunId = Assert-DysonPairedSaveLoadGuid $ExpectedQualificationRunId `
        'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    if ($ExpectedControlRelease -cnotmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$' -or
        $ExpectedSubjectCommit -cnotmatch '^[0-9a-f]{40}$' -or
        [string]$Observation.qualificationRunId -cne $expectedRunId -or
        [string]$Observation.controlRelease -cne $ExpectedControlRelease -or
        [string]$Observation.subjectCommit -cne $ExpectedSubjectCommit) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    }
    [void](Assert-DysonPairedSaveLoadDigest ([string]$Observation.observationSha256) `
        'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID')
    $observed = ConvertTo-DysonPairedSaveLoadUtc $Observation.observedAtUtc `
        'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    $expires = ConvertTo-DysonPairedSaveLoadUtc $Observation.expiresAtUtc `
        'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_INVALID'
    $now = $NowUtc.ToUniversalTime()
    if ($expires -le $observed -or $now -ge $expires -or $now -lt $observed.AddMinutes(-1) -or
        ($now - $observed).TotalSeconds -gt $script:DysonPairedSaveLoadMaximumEvidenceAgeSeconds) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_STALE'
    }
    $actualDigest = Get-DysonPairedSaveLoadObservationDigest $Observation
    if ([string]$Observation.observationSha256 -cne $actualDigest) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_HASH_MISMATCH'
    }
    $expected = New-DysonPairedSaveLoadObservationValue `
        -RestoreReceiptPath $RestoreReceiptPath `
        -ProtectionPointManifestPath $ProtectionPointManifestPath `
        -LoadedSaveEvidencePath $LoadedSaveEvidencePath `
        -SaveAcknowledgementPath $SaveAcknowledgementPath `
        -BridgeSecretPath $BridgeSecretPath `
        -DsvPath $DsvPath `
        -ServerPath $ServerPath `
        -RollbackReceiptPath $RollbackReceiptPath `
        -ObservationId ([string]$Observation.observationId) `
        -QualificationRunId $expectedRunId `
        -ControlRelease $ExpectedControlRelease `
        -SubjectCommit $ExpectedSubjectCommit `
        -ObservedAtUtc $observed `
        -ExpiresAtUtc $expires
    if ((ConvertTo-DysonPairedSaveLoadCanonicalJson $Observation) -cne
        (ConvertTo-DysonPairedSaveLoadCanonicalJson $expected)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'
    }
    return [pscustomobject][ordered]@{
        valid = $true
        protocol = $script:DysonPairedSaveLoadProtocol
        schemaVersion = 2
        observationId = [string]$Observation.observationId
        qualificationRunId = [string]$Observation.qualificationRunId
        observationSha256 = [string]$Observation.observationSha256
        expiresAtUtc = Format-DysonPairedSaveLoadUtc $expires
    }
}

function Write-DysonPairedSaveLoadJsonNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $full = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OUTPUT_EXISTS'
    }
    $parent = Split-Path -Parent $full
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OUTPUT_INVALID'
    }
    $partial = Join-Path $parent ('.' + [IO.Path]::GetFileName($full) + '.partial-' + [guid]::NewGuid().ToString('N'))
    try {
        $json = (ConvertTo-DysonPairedSaveLoadCanonicalJson $Value) + "`n"
        [IO.File]::WriteAllText($partial, $json, (New-Object Text.UTF8Encoding($false, $true)))
        [IO.File]::Move($partial, $full)
    }
    catch {
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonPairedSaveLoadError 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OUTPUT_INVALID'
    }
    return $full
}
