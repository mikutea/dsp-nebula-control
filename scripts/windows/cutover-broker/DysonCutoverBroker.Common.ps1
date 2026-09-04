Set-StrictMode -Version 2.0

$script:DysonCutoverBrokerProfileProtocol = 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_V1'
$script:DysonCutoverBrokerRequestProtocol = 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_V1'
$script:DysonCutoverBrokerIntentProtocol = 'DYSON_CONTROL_CUTOVER_BROKER_INTENT_V1'
$script:DysonCutoverBrokerReceiptProtocol = 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1'
$script:DysonCutoverBrokerResultProtocol = 'DYSON_CONTROL_CUTOVER_BROKER_RESULT_V1'
$script:DysonCutoverBrokerSchemaVersion = 1
$script:DysonCutoverBrokerMaximumProfileBytes = 32768
$script:DysonCutoverBrokerMaximumRequestBytes = 16384
$script:DysonCutoverBrokerMaximumReceiptBytes = 262144
$script:DysonCutoverBrokerMaximumChildOutputBytes = 65536
$script:DysonCutoverBrokerMaximumPendingRequests = 64
$script:DysonCutoverBrokerTaskName = 'Dyson-Control-Cutover-Broker'
$script:DysonCutoverBrokerTaskPath = '\'
$script:DysonCutoverBrokerTaskSddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
$script:DysonCutoverBrokerCapabilities = @(
    'CandidateTaskTransaction',
    'DisablePreviousAuthority',
    'StopPreviousRuntime',
    'EnablePreviousAuthority',
    'StartPreviousRuntime',
    'StartCandidateRuntime',
    'StopCandidateRuntime'
)
$script:DysonCutoverBrokerErrorCodes = @(
    'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH',
    'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT',
    'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE',
    'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_TASK_TRIGGER_FAILED',
    'DYSON_CONTROL_CUTOVER_BROKER_TIMEOUT',
    'DYSON_CONTROL_CUTOVER_BROKER_CANCELLED',
    'DYSON_CONTROL_CUTOVER_BROKER_LEASE_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_CAPABILITY_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED',
    'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID',
    'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_LIMIT',
    'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED',
    'DYSON_CONTROL_CUTOVER_BROKER_ACCESS_CONTROL_FAILED',
    'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_FAILED',
    'DYSON_CONTROL_CUTOVER_BROKER_COMPENSATION_REJECTED',
    'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN',
    'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
)

function New-DysonCutoverBrokerException {
    param([Parameter(Mandatory)][string]$Code)

    if ($Code -notin $script:DysonCutoverBrokerErrorCodes) {
        $Code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
    }
    $exception = [InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonCutoverBrokerError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonCutoverBrokerException $Code)
}

function Get-DysonCutoverBrokerErrorCode {
    param([Parameter(Mandatory)][Exception]$Exception)

    $candidate = $Exception
    while ($null -ne $candidate) {
        if ($candidate.Data.Contains('Code') -and
            [string]$candidate.Data['Code'] -in $script:DysonCutoverBrokerErrorCodes) {
            return [string]$candidate.Data['Code']
        }
        if ([string]$candidate.Message -in $script:DysonCutoverBrokerErrorCodes) {
            return [string]$candidate.Message
        }
        $candidate = $candidate.InnerException
    }
    return 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
}

function Write-DysonCutoverBrokerFailureEnvelope {
    param([Parameter(Mandatory)][string]$Code)

    if ($Code -notin $script:DysonCutoverBrokerErrorCodes) {
        $Code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
    }
    [pscustomobject][ordered]@{
        ok = $false
        error = [pscustomobject][ordered]@{ code = $Code }
    } | ConvertTo-Json -Depth 4 -Compress
}

function Get-DysonCutoverBrokerSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Get-DysonCutoverBrokerSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return Get-DysonCutoverBrokerSha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Get-DysonCutoverBrokerSha256File {
    param([Parameter(Mandatory)][string]$Path)

    $file = Assert-DysonCutoverBrokerPlainFile -Path $Path -MaximumBytes 16777216
    $stream = $null
    $hasher = $null
    try {
        $stream = [IO.File]::Open(
            (ConvertTo-DysonCutoverBrokerExtendedPath $file),
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        $hasher = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    }
    finally {
        if ($null -ne $hasher) { $hasher.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function ConvertTo-DysonCutoverBrokerJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Assert-DysonCutoverBrokerExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [Collections.IDictionary]) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if ([string]$actual[$index] -cne [string]$Expected[$index]) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
        }
    }
}

function ConvertTo-DysonCutoverBrokerGuid {
    param(
        [AllowNull()]$Value,
        [string]$ErrorCode = 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
    )

    $parsed = [guid]::Empty
    if ($Value -isnot [string] -or -not [guid]::TryParseExact([string]$Value, 'D', [ref]$parsed)) {
        Throw-DysonCutoverBrokerError $ErrorCode
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonCutoverBrokerTimestamp {
    param(
        [AllowNull()]$Value,
        [string]$ErrorCode = 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    )

    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') {
        Throw-DysonCutoverBrokerError $ErrorCode
    }
    try {
        [void][DateTime]::ParseExact(
            [string]$Value,
            'o',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch { Throw-DysonCutoverBrokerError $ErrorCode }
}

function Get-DysonCutoverBrokerFullPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 4096 -or
            $Path.IndexOf([char]0) -ge 0 -or $Path -match '["\r\n]' -or
            $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or
            -not [IO.Path]::IsPathRooted($Path)) {
            throw 'invalid path'
        }
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $root = [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
        if ([string]::IsNullOrWhiteSpace($root) -or
            [string]::Equals($full, $root, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'broad path'
        }
        return $full
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID' }
}

function ConvertTo-DysonCutoverBrokerExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $separator = [IO.Path]::DirectorySeparatorChar
        $doubleSeparator = [string]::Concat($separator, $separator)
        $extendedPrefix = [string]::Concat($doubleSeparator, '?', $separator)
        $devicePrefix = [string]::Concat($doubleSeparator, '.', $separator)
        if ($Path.StartsWith($extendedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $Path.StartsWith($devicePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'device paths are not accepted'
        }
        $full = Get-DysonCutoverBrokerFullPath $Path
        if ($full.StartsWith($doubleSeparator, [StringComparison]::Ordinal)) {
            return [string]::Concat($extendedPrefix, 'UNC', $separator, $full.Substring(2))
        }
        return [string]::Concat($extendedPrefix, $full)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    }
}

function Test-DysonCutoverBrokerFileExists {
    param([Parameter(Mandatory)][string]$Path)
    return [IO.File]::Exists((ConvertTo-DysonCutoverBrokerExtendedPath $Path))
}

function Test-DysonCutoverBrokerDirectoryExists {
    param([Parameter(Mandatory)][string]$Path)
    return [IO.Directory]::Exists((ConvertTo-DysonCutoverBrokerExtendedPath $Path))
}

function Test-DysonCutoverBrokerPathExists {
    param([Parameter(Mandatory)][string]$Path)
    return (Test-DysonCutoverBrokerFileExists $Path) -or
        (Test-DysonCutoverBrokerDirectoryExists $Path)
}

function Get-DysonCutoverBrokerEntryInfo {
    param([Parameter(Mandatory)][string]$Path)

    $full = Get-DysonCutoverBrokerFullPath $Path
    $native = ConvertTo-DysonCutoverBrokerExtendedPath $full
    $attributes = [IO.File]::GetAttributes($native)
    $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
    $length = if ($isDirectory) { 0L } else { [int64]([IO.FileInfo]::new($native).Length) }
    return [pscustomobject][ordered]@{
        FullName = $full
        PSIsContainer = $isDirectory
        Attributes = $attributes
        Length = $length
    }
}

function Assert-DysonCutoverBrokerNoReparsePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$AllowMissingLeaf
    )

    try {
        $full = Get-DysonCutoverBrokerFullPath $Path
        $root = [IO.Path]::GetPathRoot($full)
        $relative = $full.Substring($root.Length).TrimStart('\', '/')
        $segments = @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })
        $current = $root
        for ($index = 0; $index -lt $segments.Count; $index++) {
            $current = Join-Path $current $segments[$index]
            if (-not (Test-DysonCutoverBrokerPathExists $current)) {
                if ($AllowMissingLeaf -and $index -eq ($segments.Count - 1)) { return $full }
                throw 'missing component'
            }
            $item = Get-DysonCutoverBrokerEntryInfo $current
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse point' }
        }
        return $full
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    }
}

function Assert-DysonCutoverBrokerPlainDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Create
    )

    try {
        $full = Get-DysonCutoverBrokerFullPath $Path
        if ($Create -and -not (Test-DysonCutoverBrokerPathExists $full)) {
            $parent = [IO.Path]::GetDirectoryName($full)
            [void](Assert-DysonCutoverBrokerNoReparsePath -Path $parent)
            [void][IO.Directory]::CreateDirectory((ConvertTo-DysonCutoverBrokerExtendedPath $full))
        }
        [void](Assert-DysonCutoverBrokerNoReparsePath -Path $full)
        $item = Get-DysonCutoverBrokerEntryInfo $full
        if (-not $item.PSIsContainer) { throw 'not directory' }
        return $full.TrimEnd('\', '/')
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    }
}

function Assert-DysonCutoverBrokerPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 262144
    )

    try {
        $full = Get-DysonCutoverBrokerFullPath $Path
        [void](Assert-DysonCutoverBrokerNoReparsePath -Path $full)
        $item = Get-DysonCutoverBrokerEntryInfo $full
        if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
            throw 'invalid file'
        }
        return $item.FullName
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID'
    }
}

function Test-DysonCutoverBrokerSamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    return [string]::Equals(
        (Get-DysonCutoverBrokerFullPath $Left),
        (Get-DysonCutoverBrokerFullPath $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Read-DysonCutoverBrokerJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$MaximumBytes,
        [switch]$AllowMissing,
        [string]$InvalidCode = 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    )

    if (-not (Test-DysonCutoverBrokerFileExists $Path)) {
        if ($AllowMissing) { return $null }
        Throw-DysonCutoverBrokerError $InvalidCode
    }
    try {
        $file = Assert-DysonCutoverBrokerPlainFile -Path $Path -MaximumBytes $MaximumBytes
        $bytes = [IO.File]::ReadAllBytes((ConvertTo-DysonCutoverBrokerExtendedPath $file))
        if ($bytes.Length -lt 2 -or $bytes.Length -gt $MaximumBytes -or
            [Array]::IndexOf($bytes, [byte]0) -ge 0) {
            throw 'invalid bytes'
        }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $convertCommand = Get-Command -Name ConvertFrom-Json -CommandType Cmdlet -ErrorAction Stop
        if ($convertCommand.Parameters.ContainsKey('DateKind')) {
            return $text | ConvertFrom-Json -DateKind String -ErrorAction Stop
        }
        return $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) {
            if ([string]$_.Exception.Data['Code'] -eq 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID') {
                Throw-DysonCutoverBrokerError $InvalidCode
            }
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError $InvalidCode
    }
}

function Write-DysonCutoverBrokerJsonNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $temporary = $null
    try {
        $directory = Assert-DysonCutoverBrokerPlainDirectory -Path ([IO.Path]::GetDirectoryName($Path))
        $expectedPath = Join-Path $directory ([IO.Path]::GetFileName($Path))
        if (-not (Test-DysonCutoverBrokerSamePath $expectedPath $Path)) { throw 'path changed' }
        if (Test-DysonCutoverBrokerPathExists $expectedPath) {
            throw [IO.IOException]::new('target exists')
        }
        $text = (ConvertTo-DysonCutoverBrokerJson $Value) + "`n"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        if ($bytes.Length -lt 2 -or $bytes.Length -gt $MaximumBytes) { throw 'payload too large' }
        $temporary = Join-Path $directory ('.broker-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $stream = [IO.FileStream]::new(
            (ConvertTo-DysonCutoverBrokerExtendedPath $temporary),
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [void](Assert-DysonCutoverBrokerPlainFile -Path $temporary -MaximumBytes $MaximumBytes)
        [IO.File]::Move(
            (ConvertTo-DysonCutoverBrokerExtendedPath $temporary),
            (ConvertTo-DysonCutoverBrokerExtendedPath $expectedPath)
        )
        $temporary = $null
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        if ($_.Exception -is [IO.IOException] -and (Test-DysonCutoverBrokerFileExists $Path)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE'
    }
    finally {
        if ($null -ne $temporary -and (Test-DysonCutoverBrokerFileExists $temporary)) {
            try { [IO.File]::Delete((ConvertTo-DysonCutoverBrokerExtendedPath $temporary)) } catch {}
        }
    }
}

function Remove-DysonCutoverBrokerPlainFile {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if (-not (Test-DysonCutoverBrokerPathExists $Path)) { return }
        [void](Assert-DysonCutoverBrokerPlainFile -Path $Path -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes)
        [IO.File]::Delete((ConvertTo-DysonCutoverBrokerExtendedPath $Path))
        if (Test-DysonCutoverBrokerPathExists $Path) { throw 'file survived removal' }
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_STORAGE_UNAVAILABLE' }
}

function Get-DysonCutoverBrokerStorage {
    param(
        [Parameter(Mandatory)][string]$BrokerRoot,
        [switch]$Create
    )

    $root = Assert-DysonCutoverBrokerPlainDirectory -Path $BrokerRoot -Create:$Create
    $requests = Assert-DysonCutoverBrokerPlainDirectory -Path (Join-Path $root 'requests') -Create:$Create
    $receipts = Assert-DysonCutoverBrokerPlainDirectory -Path (Join-Path $root 'receipts') -Create:$Create
    $intents = Assert-DysonCutoverBrokerPlainDirectory -Path (Join-Path $root 'intents') -Create:$Create
    $work = Assert-DysonCutoverBrokerPlainDirectory -Path (Join-Path $root 'work') -Create:$Create
    return [pscustomobject][ordered]@{
        brokerRoot = $root
        requestsRoot = $requests
        receiptsRoot = $receipts
        intentsRoot = $intents
        workRoot = $work
        profileFile = Join-Path $root 'broker-profile.json'
    }
}

function Get-DysonCutoverBrokerRecordPaths {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$BrokerRequestId
    )

    $id = ConvertTo-DysonCutoverBrokerGuid $BrokerRequestId 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    return [pscustomobject][ordered]@{
        request = Join-Path $Storage.requestsRoot ($id + '.json')
        receipt = Join-Path $Storage.receiptsRoot ($id + '.json')
        intent = Join-Path $Storage.intentsRoot ($id + '.json')
    }
}

function ConvertTo-DysonCutoverBrokerValidatedProfile {
    param([Parameter(Mandatory)]$Raw)

    try {
        Assert-DysonCutoverBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRoot', 'brokerScriptRoot', 'projectRoot', 'dataRoot',
            'authorityProfileFile', 'authorityProfileSha256', 'cutoverScriptRoot', 'leaseCommonSha256',
            'cutoverHostCommonSha256', 'cutoverActionScriptSha256', 'runtimeTaskInstallerSha256', 'runtimeBootstrapRoot',
            'runtimeTaskTransactionRoot', 'serviceUser', 'gamePort', 'taskName', 'taskPath',
            'localServiceSid', 'commonScriptSha256', 'taskAclScriptSha256', 'installerScriptSha256',
            'workerScriptSha256', 'submitScriptSha256', 'profileFingerprint'
        )
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonCutoverBrokerProfileProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or
            [int64]$Raw.schemaVersion -ne $script:DysonCutoverBrokerSchemaVersion -or
            $Raw.authorityProfileSha256 -isnot [string] -or [string]$Raw.authorityProfileSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.leaseCommonSha256 -isnot [string] -or [string]$Raw.leaseCommonSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.cutoverHostCommonSha256 -isnot [string] -or [string]$Raw.cutoverHostCommonSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.cutoverActionScriptSha256 -isnot [string] -or [string]$Raw.cutoverActionScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.runtimeTaskInstallerSha256 -isnot [string] -or [string]$Raw.runtimeTaskInstallerSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.commonScriptSha256 -isnot [string] -or [string]$Raw.commonScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.taskAclScriptSha256 -isnot [string] -or [string]$Raw.taskAclScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.installerScriptSha256 -isnot [string] -or [string]$Raw.installerScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.workerScriptSha256 -isnot [string] -or [string]$Raw.workerScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.submitScriptSha256 -isnot [string] -or [string]$Raw.submitScriptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.profileFingerprint -isnot [string] -or [string]$Raw.profileFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.serviceUser -isnot [string] -or [string]$Raw.serviceUser -notmatch '^[^"\r\n]{3,128}$' -or
            (($Raw.gamePort -isnot [int]) -and ($Raw.gamePort -isnot [long])) -or
            [int64]$Raw.gamePort -lt 1 -or [int64]$Raw.gamePort -gt 65535 -or
            $Raw.taskName -isnot [string] -or [string]$Raw.taskName -cne $script:DysonCutoverBrokerTaskName -or
            $Raw.taskPath -isnot [string] -or [string]$Raw.taskPath -cne $script:DysonCutoverBrokerTaskPath -or
            $Raw.localServiceSid -isnot [string] -or [string]$Raw.localServiceSid -cne 'S-1-5-19') {
            throw 'profile value'
        }
        $profile = [pscustomobject][ordered]@{
            protocol = $script:DysonCutoverBrokerProfileProtocol
            schemaVersion = $script:DysonCutoverBrokerSchemaVersion
            brokerRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.brokerRoot)
            brokerScriptRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.brokerScriptRoot)
            projectRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.projectRoot)
            dataRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.dataRoot)
            authorityProfileFile = Assert-DysonCutoverBrokerPlainFile ([string]$Raw.authorityProfileFile) $script:DysonCutoverBrokerMaximumProfileBytes
            authorityProfileSha256 = [string]$Raw.authorityProfileSha256
            cutoverScriptRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.cutoverScriptRoot)
            leaseCommonSha256 = [string]$Raw.leaseCommonSha256
            cutoverHostCommonSha256 = [string]$Raw.cutoverHostCommonSha256
            cutoverActionScriptSha256 = [string]$Raw.cutoverActionScriptSha256
            runtimeTaskInstallerSha256 = [string]$Raw.runtimeTaskInstallerSha256
            runtimeBootstrapRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.runtimeBootstrapRoot)
            runtimeTaskTransactionRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.runtimeTaskTransactionRoot)
            serviceUser = [string]$Raw.serviceUser
            gamePort = [int]$Raw.gamePort
            taskName = $script:DysonCutoverBrokerTaskName
            taskPath = $script:DysonCutoverBrokerTaskPath
            localServiceSid = 'S-1-5-19'
            commonScriptSha256 = [string]$Raw.commonScriptSha256
            taskAclScriptSha256 = [string]$Raw.taskAclScriptSha256
            installerScriptSha256 = [string]$Raw.installerScriptSha256
            workerScriptSha256 = [string]$Raw.workerScriptSha256
            submitScriptSha256 = [string]$Raw.submitScriptSha256
            profileFingerprint = [string]$Raw.profileFingerprint
        }
        $core = [ordered]@{}
        foreach ($property in $profile.PSObject.Properties) {
            if ($property.Name -cne 'profileFingerprint') { $core[$property.Name] = $property.Value }
        }
        if ((Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $core)) -cne $profile.profileFingerprint) {
            throw 'profile fingerprint'
        }
        $storage = Get-DysonCutoverBrokerStorage $profile.brokerRoot
        if (-not (Test-DysonCutoverBrokerSamePath $storage.profileFile (Join-Path $profile.brokerRoot 'broker-profile.json')) -or
            -not (Test-DysonCutoverBrokerSamePath $profile.brokerScriptRoot (Join-Path $profile.cutoverScriptRoot 'cutover-broker')) -or
            (Get-DysonCutoverBrokerSha256File $profile.authorityProfileFile) -cne $profile.authorityProfileSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.cutoverScriptRoot 'DysonHostMutationLease.Common.ps1')) -cne $profile.leaseCommonSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.cutoverScriptRoot 'cutover\DysonCutoverHost.Common.ps1')) -cne $profile.cutoverHostCommonSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.cutoverScriptRoot 'cutover\Invoke-DysonCutoverAction.ps1')) -cne $profile.cutoverActionScriptSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.cutoverScriptRoot 'Install-DysonRuntimeTasks.ps1')) -cne $profile.runtimeTaskInstallerSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.brokerScriptRoot 'DysonCutoverBroker.Common.ps1')) -cne $profile.commonScriptSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.brokerScriptRoot 'DysonCutoverBroker.TaskAcl.ps1')) -cne $profile.taskAclScriptSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.brokerScriptRoot 'Install-DysonCutoverBrokerTask.ps1')) -cne $profile.installerScriptSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.brokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1')) -cne $profile.workerScriptSha256 -or
            (Get-DysonCutoverBrokerSha256File (Join-Path $profile.brokerScriptRoot 'Submit-DysonCutoverBrokerRequest.ps1')) -cne $profile.submitScriptSha256) {
            throw 'profile binding'
        }
        return $profile
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) {
            $code = [string]$_.Exception.Data['Code']
            if ($code -eq 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID') {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID'
            }
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID'
    }
}

function Read-DysonCutoverBrokerProfile {
    param(
        [Parameter(Mandatory)][string]$BrokerRoot,
        [Parameter(Mandatory)][string]$BrokerProfileFile
    )

    try {
        $storage = Get-DysonCutoverBrokerStorage $BrokerRoot
        if (-not (Test-DysonCutoverBrokerSamePath $storage.profileFile $BrokerProfileFile) -or
            [IO.Path]::GetFileName($BrokerProfileFile) -cne 'broker-profile.json') {
            throw 'profile location'
        }
        $raw = Read-DysonCutoverBrokerJson $storage.profileFile $script:DysonCutoverBrokerMaximumProfileBytes `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID'
        $profile = ConvertTo-DysonCutoverBrokerValidatedProfile $raw
        if (-not (Test-DysonCutoverBrokerSamePath $profile.brokerRoot $storage.brokerRoot)) {
            throw 'profile root'
        }
        return $profile
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_INVALID'
    }
}

function Get-DysonCutoverBrokerRequestFingerprint {
    param([Parameter(Mandatory)]$Request)

    $core = [ordered]@{
        protocol = $script:DysonCutoverBrokerRequestProtocol
        schemaVersion = $script:DysonCutoverBrokerSchemaVersion
        brokerRequestId = [string]$Request.brokerRequestId
        capability = [string]$Request.capability
        requestId = [string]$Request.requestId
        authorityInventoryRevision = [string]$Request.authorityInventoryRevision
        projectRoot = [string]$Request.projectRoot
        dataRoot = [string]$Request.dataRoot
        authorityProfileFile = [string]$Request.authorityProfileFile
        cutoverScriptRoot = [string]$Request.cutoverScriptRoot
        runtimeBootstrapRoot = [string]$Request.runtimeBootstrapRoot
        runtimeTaskTransactionRoot = [string]$Request.runtimeTaskTransactionRoot
        serviceUser = [string]$Request.serviceUser
        gamePort = [int]$Request.gamePort
        leaseInstanceId = [string]$Request.leaseInstanceId
        leaseToken = [string]$Request.leaseToken
        candidateMode = $Request.candidateMode
        candidateRecover = [bool]$Request.candidateRecover
    }
    return Get-DysonCutoverBrokerSha256Text (ConvertTo-DysonCutoverBrokerJson $core)
}

function ConvertTo-DysonCutoverBrokerValidatedRequest {
    param([Parameter(Mandatory)]$Raw)

    try {
        Assert-DysonCutoverBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRequestId', 'capability', 'requestId',
            'authorityInventoryRevision', 'projectRoot', 'dataRoot', 'authorityProfileFile',
            'cutoverScriptRoot', 'runtimeBootstrapRoot', 'runtimeTaskTransactionRoot', 'serviceUser',
            'gamePort', 'leaseInstanceId', 'leaseToken', 'candidateMode', 'candidateRecover',
            'requestFingerprint', 'createdAt'
        )
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonCutoverBrokerRequestProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or
            [int64]$Raw.schemaVersion -ne $script:DysonCutoverBrokerSchemaVersion -or
            $Raw.capability -isnot [string] -or [string]$Raw.capability -notin $script:DysonCutoverBrokerCapabilities -or
            $Raw.authorityInventoryRevision -isnot [string] -or [string]$Raw.authorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.serviceUser -isnot [string] -or [string]$Raw.serviceUser -notmatch '^[^"\r\n]{3,128}$' -or
            (($Raw.gamePort -isnot [int]) -and ($Raw.gamePort -isnot [long])) -or
            [int64]$Raw.gamePort -lt 1 -or [int64]$Raw.gamePort -gt 65535 -or
            $Raw.leaseInstanceId -isnot [string] -or [string]$Raw.leaseInstanceId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
            $Raw.leaseToken -isnot [string] -or [string]$Raw.leaseToken -cnotmatch '^[A-Za-z0-9_-]{43}$' -or
            $Raw.candidateRecover -isnot [bool] -or
            $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$') {
            throw 'request value'
        }
        Assert-DysonCutoverBrokerTimestamp $Raw.createdAt
        $capability = [string]$Raw.capability
        if ($capability -ceq 'CandidateTaskTransaction') {
            if ($Raw.candidateMode -isnot [string] -or
                [string]$Raw.candidateMode -notin @('PrepareDisabled', 'Activate')) {
                throw 'candidate mode'
            }
        }
        elseif ($null -ne $Raw.candidateMode -or [bool]$Raw.candidateRecover) {
            throw 'unexpected candidate options'
        }
        $request = [pscustomobject][ordered]@{
            protocol = $script:DysonCutoverBrokerRequestProtocol
            schemaVersion = $script:DysonCutoverBrokerSchemaVersion
            brokerRequestId = ConvertTo-DysonCutoverBrokerGuid $Raw.brokerRequestId 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
            capability = $capability
            requestId = ConvertTo-DysonCutoverBrokerGuid $Raw.requestId 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
            authorityInventoryRevision = [string]$Raw.authorityInventoryRevision
            projectRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.projectRoot)
            dataRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.dataRoot)
            authorityProfileFile = Assert-DysonCutoverBrokerPlainFile ([string]$Raw.authorityProfileFile) $script:DysonCutoverBrokerMaximumProfileBytes
            cutoverScriptRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.cutoverScriptRoot)
            runtimeBootstrapRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.runtimeBootstrapRoot)
            runtimeTaskTransactionRoot = Assert-DysonCutoverBrokerPlainDirectory ([string]$Raw.runtimeTaskTransactionRoot)
            serviceUser = [string]$Raw.serviceUser
            gamePort = [int]$Raw.gamePort
            leaseInstanceId = [string]$Raw.leaseInstanceId
            leaseToken = [string]$Raw.leaseToken
            candidateMode = $Raw.candidateMode
            candidateRecover = [bool]$Raw.candidateRecover
            requestFingerprint = [string]$Raw.requestFingerprint
            createdAt = [string]$Raw.createdAt
        }
        if ((Get-DysonCutoverBrokerRequestFingerprint $request) -cne $request.requestFingerprint) {
            throw 'request fingerprint'
        }
        return $request
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) {
            $code = [string]$_.Exception.Data['Code']
            if ($code -eq 'DYSON_CONTROL_CUTOVER_BROKER_PATH_INVALID' -or
                $code -eq 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID') {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
            }
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    }
}

function New-DysonCutoverBrokerRequest {
    param(
        [Parameter(Mandatory)][string]$BrokerRequestId,
        [Parameter(Mandatory)][string]$Capability,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$AuthorityProfileFile,
        [Parameter(Mandatory)][string]$CutoverScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
        [Parameter(Mandatory)][string]$ServiceUser,
        [Parameter(Mandatory)][int]$GamePort,
        [Parameter(Mandatory)][string]$LeaseInstanceId,
        [Parameter(Mandatory)][string]$LeaseToken,
        [AllowNull()]$CandidateMode,
        [bool]$CandidateRecover
    )

    $request = [pscustomobject][ordered]@{
        protocol = $script:DysonCutoverBrokerRequestProtocol
        schemaVersion = $script:DysonCutoverBrokerSchemaVersion
        brokerRequestId = ConvertTo-DysonCutoverBrokerGuid $BrokerRequestId
        capability = $Capability
        requestId = ConvertTo-DysonCutoverBrokerGuid $RequestId
        authorityInventoryRevision = $AuthorityInventoryRevision
        projectRoot = $ProjectRoot
        dataRoot = $DataRoot
        authorityProfileFile = $AuthorityProfileFile
        cutoverScriptRoot = $CutoverScriptRoot
        runtimeBootstrapRoot = $RuntimeBootstrapRoot
        runtimeTaskTransactionRoot = $RuntimeTaskTransactionRoot
        serviceUser = $ServiceUser
        gamePort = $GamePort
        leaseInstanceId = $LeaseInstanceId
        leaseToken = $LeaseToken
        candidateMode = $CandidateMode
        candidateRecover = $CandidateRecover
        requestFingerprint = ('0' * 64)
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $request.requestFingerprint = Get-DysonCutoverBrokerRequestFingerprint $request
    return ConvertTo-DysonCutoverBrokerValidatedRequest $request
}

function Assert-DysonCutoverBrokerRequestBinding {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile
    )

    $matches =
        (Test-DysonCutoverBrokerSamePath $Request.projectRoot $Profile.projectRoot) -and
        (Test-DysonCutoverBrokerSamePath $Request.dataRoot $Profile.dataRoot) -and
        (Test-DysonCutoverBrokerSamePath $Request.authorityProfileFile $Profile.authorityProfileFile) -and
        (Test-DysonCutoverBrokerSamePath $Request.cutoverScriptRoot $Profile.cutoverScriptRoot) -and
        (Test-DysonCutoverBrokerSamePath $Request.runtimeBootstrapRoot $Profile.runtimeBootstrapRoot) -and
        (Test-DysonCutoverBrokerSamePath $Request.runtimeTaskTransactionRoot $Profile.runtimeTaskTransactionRoot) -and
        [string]::Equals($Request.serviceUser, $Profile.serviceUser, [StringComparison]::OrdinalIgnoreCase) -and
        [int]$Request.gamePort -eq [int]$Profile.gamePort
    if (-not $matches) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
    $authorityRaw = Read-DysonCutoverBrokerJson $Profile.authorityProfileFile `
        $script:DysonCutoverBrokerMaximumProfileBytes -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    if ($null -eq $authorityRaw.PSObject.Properties['inventoryRevision'] -or
        $authorityRaw.inventoryRevision -isnot [string] -or
        [string]$authorityRaw.inventoryRevision -cne [string]$Request.authorityInventoryRevision -or
        (Get-DysonCutoverBrokerSha256File $Profile.authorityProfileFile) -cne $Profile.authorityProfileSha256) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
}

function Assert-DysonCutoverBrokerLease {
    param([Parameter(Mandatory)]$Request)

    try {
        $leaseCommon = Join-Path $Request.cutoverScriptRoot 'DysonHostMutationLease.Common.ps1'
        [void](Assert-DysonCutoverBrokerPlainFile -Path $leaseCommon -MaximumBytes 2097152)
        . $leaseCommon
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $Request.dataRoot `
            -InstanceId $Request.leaseInstanceId -Token $Request.leaseToken)
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_LEASE_INVALID' }
}

function ConvertTo-DysonCutoverBrokerValidatedReceipt {
    param([Parameter(Mandatory)]$Raw)

    try {
        Assert-DysonCutoverBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRequestId', 'requestFingerprint', 'capability',
            'requestId', 'authorityInventoryRevision', 'state', 'errorCode', 'childReceipt',
            'createdAt', 'completedAt'
        )
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonCutoverBrokerReceiptProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or
            [int64]$Raw.schemaVersion -ne $script:DysonCutoverBrokerSchemaVersion -or
            $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.capability -isnot [string] -or [string]$Raw.capability -notin $script:DysonCutoverBrokerCapabilities -or
            $Raw.authorityInventoryRevision -isnot [string] -or [string]$Raw.authorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.state -isnot [string] -or [string]$Raw.state -notin @('succeeded', 'failed')) {
            throw 'receipt value'
        }
        Assert-DysonCutoverBrokerTimestamp $Raw.createdAt 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
        Assert-DysonCutoverBrokerTimestamp $Raw.completedAt 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
        if ([string]$Raw.state -ceq 'succeeded') {
            if ($null -ne $Raw.errorCode -or $null -eq $Raw.childReceipt) { throw 'receipt success layout' }
        }
        else {
            if ($Raw.errorCode -isnot [string] -or [string]$Raw.errorCode -notin $script:DysonCutoverBrokerErrorCodes -or
                $null -ne $Raw.childReceipt) { throw 'receipt failure layout' }
        }
        return [pscustomobject][ordered]@{
            protocol = $script:DysonCutoverBrokerReceiptProtocol
            schemaVersion = $script:DysonCutoverBrokerSchemaVersion
            brokerRequestId = ConvertTo-DysonCutoverBrokerGuid $Raw.brokerRequestId 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
            requestFingerprint = [string]$Raw.requestFingerprint
            capability = [string]$Raw.capability
            requestId = ConvertTo-DysonCutoverBrokerGuid $Raw.requestId 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
            authorityInventoryRevision = [string]$Raw.authorityInventoryRevision
            state = [string]$Raw.state
            errorCode = $Raw.errorCode
            childReceipt = $Raw.childReceipt
            createdAt = [string]$Raw.createdAt
            completedAt = [string]$Raw.completedAt
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and
            [string]$_.Exception.Data['Code'] -eq 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID') {
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
    }
}

function New-DysonCutoverBrokerReceipt {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][ValidateSet('succeeded', 'failed')][string]$State,
        [AllowNull()]$ErrorCode,
        [AllowNull()]$ChildReceipt
    )

    $receipt = [pscustomobject][ordered]@{
        protocol = $script:DysonCutoverBrokerReceiptProtocol
        schemaVersion = $script:DysonCutoverBrokerSchemaVersion
        brokerRequestId = $Request.brokerRequestId
        requestFingerprint = $Request.requestFingerprint
        capability = $Request.capability
        requestId = $Request.requestId
        authorityInventoryRevision = $Request.authorityInventoryRevision
        state = $State
        errorCode = $ErrorCode
        childReceipt = $ChildReceipt
        createdAt = $Request.createdAt
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    return ConvertTo-DysonCutoverBrokerValidatedReceipt $receipt
}

function ConvertTo-DysonCutoverBrokerResultEnvelope {
    param(
        [Parameter(Mandatory)]$Receipt,
        [bool]$Reused
    )

    if ([string]$Receipt.state -cne 'succeeded') {
        Throw-DysonCutoverBrokerError ([string]$Receipt.errorCode)
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonCutoverBrokerResultProtocol
        schemaVersion = $script:DysonCutoverBrokerSchemaVersion
        brokerRequestId = $Receipt.brokerRequestId
        capability = $Receipt.capability
        requestId = $Receipt.requestId
        authorityInventoryRevision = $Receipt.authorityInventoryRevision
        reused = $Reused
        childReceipt = $Receipt.childReceipt
    }
}

function Get-DysonCutoverBrokerTaskArguments {
    param([Parameter(Mandatory)]$Profile)

    $worker = Join-Path $Profile.brokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -BrokerRoot "{1}" -BrokerProfileFile "{2}"' -f `
        $worker, $Profile.brokerRoot, (Join-Path $Profile.brokerRoot 'broker-profile.json')
}

function Get-DysonCutoverBrokerTaskAclIntent {
    return [pscustomobject][ordered]@{
        sddl = $script:DysonCutoverBrokerTaskSddl
        system = 'full'
        administrators = 'full'
        localService = 'read-execute'
        localServiceWrite = $false
        localServiceDelete = $false
        protected = $true
    }
}
