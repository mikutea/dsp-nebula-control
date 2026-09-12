Set-StrictMode -Version 2.0

$script:DysonRuntimeSessionProtocol = 'DYSON_CONTROL_RUNTIME_SESSION_V1'
$script:DysonSimulationTelemetryProtocol = 'DYSON_CONTROL_SIMULATION_TELEMETRY_V1'
$script:DysonHeartbeatProtocol = 'DYSON_CONTROL_HEARTBEAT_V1'
$script:DysonSimulationUpsSource = 'fpscontroller-stopwatch'
$script:DysonSimulationTpsSource = 'gamemain-tick-wallclock'
$script:DysonMaximumSimulationMilliRate = [int64]10000000

function Get-DysonBridgeTelemetryHmac {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Parts
    )
    $normalized = $Secret.Trim()
    if ($normalized.Length -lt 32 -or $normalized.Length -gt 512 -or $normalized.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) {
        throw 'BRIDGE_SECRET_INVALID'
    }
    $algorithm = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($normalized))
    try {
        $hash = $algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $Parts)))
        return ([System.BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
    }
    finally { $algorithm.Dispose() }
}

function Test-DysonBridgeTelemetryFixedTimeHex {
    param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Expected)
    if ($Actual.Length -ne $Expected.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Actual.Length; $index++) {
        $difference = $difference -bor ([int][char]::ToLowerInvariant($Actual[$index]) -bxor [int][char]::ToLowerInvariant($Expected[$index]))
    }
    return $difference -eq 0
}

function Read-DysonBridgeTelemetryFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$CodePrefix)
    if (-not [System.IO.Path]::IsPathRooted($Path)) { throw ($CodePrefix + '_PATH_INVALID') }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $info = [System.IO.FileInfo]::new($fullPath)
    $info.Refresh()
    if (-not $info.Exists) { throw ($CodePrefix + '_UNAVAILABLE') }
    if (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -le 0 -or $info.Length -gt 4096) {
        throw ($CodePrefix + '_FILE_INVALID')
    }
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    if ($bytes.Length -le 0 -or $bytes.Length -gt 4096 -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
        throw ($CodePrefix + '_FILE_INVALID')
    }
    try { return [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
    catch { throw ($CodePrefix + '_UTF8_INVALID') }
}

function Read-DysonBridgeTelemetrySecret {
    param([Parameter(Mandatory)][string]$Path)
    $secret = (Read-DysonBridgeTelemetryFile -Path $Path -CodePrefix 'BRIDGE_SECRET').Trim()
    if ($secret.Length -lt 32 -or $secret.Length -gt 512 -or $secret.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) {
        throw 'BRIDGE_SECRET_INVALID'
    }
    return $secret
}

function ConvertFrom-DysonBridgeTelemetryOrderedPayload {
    param(
        [Parameter(Mandatory)][string]$Payload,
        [Parameter(Mandatory)][string[]]$Keys,
        [Parameter(Mandatory)][string]$Code
    )
    if ([System.Text.Encoding]::UTF8.GetByteCount($Payload) -gt 4096 -or
        $Payload.IndexOf([char]0) -ge 0 -or $Payload.IndexOf([char]0xFEFF) -ge 0) { throw $Code }
    $lines = $Payload.Split([string[]]@("`r`n", "`n"), [System.StringSplitOptions]::None)
    $lineCount = $lines.Length
    if ($lineCount -gt 0 -and $lines[$lineCount - 1].Length -eq 0) { $lineCount-- }
    if ($lineCount -ne $Keys.Length) { throw $Code }
    $values = [ordered]@{}
    for ($index = 0; $index -lt $Keys.Length; $index++) {
        $prefix = $Keys[$index] + '='
        if (-not $lines[$index].StartsWith($prefix, [System.StringComparison]::Ordinal)) { throw $Code }
        $value = $lines[$index].Substring($prefix.Length)
        if ($value.Length -eq 0 -or $value.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) { throw $Code }
        $values[$Keys[$index]] = $value
    }
    return $values
}

function ConvertTo-DysonBridgeTelemetryInt64 {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][bool]$Positive)
    if ($Value -cnotmatch '^(?:0|[1-9][0-9]*)$') { throw 'BRIDGE_NUMBER_INVALID' }
    $parsed = [int64]0
    if (-not [int64]::TryParse($Value, [System.Globalization.NumberStyles]::None,
        [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -or ($Positive -and $parsed -le 0)) {
        throw 'BRIDGE_NUMBER_INVALID'
    }
    return $parsed
}

function ConvertTo-DysonBridgeTelemetryGuid {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
        throw 'BRIDGE_SESSION_ID_INVALID'
    }
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) { throw 'BRIDGE_SESSION_ID_INVALID' }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonBridgeTelemetrySignature {
    param(
        [Parameter(Mandatory)][string]$Actual,
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string[]]$Parts
    )
    if ($Actual -cnotmatch '^[0-9a-fA-F]{64}$') { throw 'BRIDGE_HMAC_INVALID' }
    $expected = Get-DysonBridgeTelemetryHmac -Secret $Secret -Parts $Parts
    if (-not (Test-DysonBridgeTelemetryFixedTimeHex -Actual $Actual -Expected $expected)) {
        throw 'BRIDGE_SIGNATURE_INVALID'
    }
}

function ConvertFrom-DysonBridgeHeartbeatPayload {
    param([Parameter(Mandatory)][string]$Payload, [Parameter(Mandatory)][string]$Secret)
    $keys = @('protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state', 'hmac')
    $value = ConvertFrom-DysonBridgeTelemetryOrderedPayload -Payload $Payload -Keys $keys -Code 'BRIDGE_HEARTBEAT_INVALID'
    if ($value.protocol -cne $script:DysonHeartbeatProtocol -or $value.pluginVersion -cnotmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$' -or
        $value.state -cne 'ready') { throw 'BRIDGE_HEARTBEAT_INVALID' }
    $processId = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.processId -Positive $true
    $startedAt = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.startedAtUnixMs -Positive $true
    $writtenAt = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.writtenAtUnixMs -Positive $true
    if ($processId -gt [int]::MaxValue -or $writtenAt -lt $startedAt) { throw 'BRIDGE_HEARTBEAT_INVALID' }
    Assert-DysonBridgeTelemetrySignature -Actual $value.hmac -Secret $Secret -Parts @(
        $script:DysonHeartbeatProtocol, $value.pluginVersion, $value.processId,
        $value.startedAtUnixMs, $value.writtenAtUnixMs, 'ready'
    )
    return [pscustomobject][ordered]@{
        pluginVersion = $value.pluginVersion; processId = [int]$processId
        startedAtUnixMs = $startedAt; writtenAtUnixMs = $writtenAt
    }
}

function ConvertFrom-DysonBridgeRuntimeSessionPayload {
    param([Parameter(Mandatory)][string]$Payload, [Parameter(Mandatory)][string]$Secret)
    $keys = @('protocol', 'sessionId', 'pluginVersion', 'processId', 'processStartedAtUnixMs',
        'bridgeStartedAtUnixMs', 'issuedAtUnixMs', 'hmac')
    $value = ConvertFrom-DysonBridgeTelemetryOrderedPayload -Payload $Payload -Keys $keys -Code 'BRIDGE_RUNTIME_SESSION_INVALID'
    if ($value.protocol -cne $script:DysonRuntimeSessionProtocol -or
        $value.pluginVersion -cnotmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$') { throw 'BRIDGE_RUNTIME_SESSION_INVALID' }
    $sessionId = ConvertTo-DysonBridgeTelemetryGuid -Value $value.sessionId
    $processId = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.processId -Positive $true
    $processStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.processStartedAtUnixMs -Positive $true
    $bridgeStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.bridgeStartedAtUnixMs -Positive $true
    $issuedAt = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.issuedAtUnixMs -Positive $true
    if ($processId -gt [int]::MaxValue -or $bridgeStarted -lt $processStarted -or
        $issuedAt -lt $bridgeStarted - 5000 -or $issuedAt -gt $bridgeStarted + 120000) {
        throw 'BRIDGE_RUNTIME_SESSION_INCONSISTENT'
    }
    Assert-DysonBridgeTelemetrySignature -Actual $value.hmac -Secret $Secret -Parts @(
        $script:DysonRuntimeSessionProtocol, $sessionId, $value.pluginVersion, $value.processId,
        $value.processStartedAtUnixMs, $value.bridgeStartedAtUnixMs, $value.issuedAtUnixMs
    )
    return [pscustomobject][ordered]@{
        sessionId = $sessionId; pluginVersion = $value.pluginVersion; processId = [int]$processId
        processStartedAtUnixMs = $processStarted; bridgeStartedAtUnixMs = $bridgeStarted; issuedAtUnixMs = $issuedAt
    }
}

function ConvertFrom-DysonBridgeSimulationTelemetryPayload {
    param([Parameter(Mandatory)][string]$Payload, [Parameter(Mandatory)][string]$Secret)
    $keys = @('protocol', 'sessionId', 'processId', 'processStartedAtUnixMs', 'bridgeStartedAtUnixMs',
        'sequence', 'sampleStartedAtUnixMs', 'sampleFinishedAtUnixMs', 'writtenAtUnixMs',
        'windowDurationMs', 'tickStarted', 'tickFinished', 'upsMilli', 'tpsMilli',
        'upsSource', 'tpsSource', 'hmac')
    $value = ConvertFrom-DysonBridgeTelemetryOrderedPayload -Payload $Payload -Keys $keys -Code 'BRIDGE_TELEMETRY_INVALID'
    if ($value.protocol -cne $script:DysonSimulationTelemetryProtocol -or
        $value.upsSource -cne $script:DysonSimulationUpsSource -or $value.tpsSource -cne $script:DysonSimulationTpsSource) {
        throw 'BRIDGE_TELEMETRY_INVALID'
    }
    $sessionId = ConvertTo-DysonBridgeTelemetryGuid -Value $value.sessionId
    $processId = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.processId -Positive $true
    $processStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.processStartedAtUnixMs -Positive $true
    $bridgeStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.bridgeStartedAtUnixMs -Positive $true
    $sequence = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.sequence -Positive $true
    $sampleStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.sampleStartedAtUnixMs -Positive $true
    $sampleFinished = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.sampleFinishedAtUnixMs -Positive $true
    $writtenAt = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.writtenAtUnixMs -Positive $true
    $windowDuration = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.windowDurationMs -Positive $true
    $tickStarted = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.tickStarted -Positive $false
    $tickFinished = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.tickFinished -Positive $false
    $upsMilli = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.upsMilli -Positive $false
    $tpsMilli = ConvertTo-DysonBridgeTelemetryInt64 -Value $value.tpsMilli -Positive $false
    if ($processId -gt [int]::MaxValue -or $bridgeStarted -lt $processStarted -or
        $sampleFinished -lt $sampleStarted -or $writtenAt -lt $sampleFinished -or
        $writtenAt - $sampleFinished -gt 5000 -or $sampleFinished - $sampleStarted -gt 120000 -or
        $sampleStarted -lt $bridgeStarted - 5000 -or $windowDuration -lt 1000 -or $windowDuration -gt 10000 -or
        $tickFinished -lt $tickStarted -or $upsMilli -gt $script:DysonMaximumSimulationMilliRate -or
        $tpsMilli -gt $script:DysonMaximumSimulationMilliRate) { throw 'BRIDGE_TELEMETRY_INCONSISTENT' }
    $expectedTpsMilli = ([double]($tickFinished - $tickStarted) * 1000000.0) / [double]$windowDuration
    if ([double]::IsNaN($expectedTpsMilli) -or [double]::IsInfinity($expectedTpsMilli) -or
        [math]::Abs($expectedTpsMilli - [double]$tpsMilli) -gt 1.0) { throw 'BRIDGE_TELEMETRY_INCONSISTENT' }
    Assert-DysonBridgeTelemetrySignature -Actual $value.hmac -Secret $Secret -Parts @(
        $script:DysonSimulationTelemetryProtocol, $sessionId, $value.processId,
        $value.processStartedAtUnixMs, $value.bridgeStartedAtUnixMs, $value.sequence,
        $value.sampleStartedAtUnixMs, $value.sampleFinishedAtUnixMs, $value.writtenAtUnixMs,
        $value.windowDurationMs, $value.tickStarted, $value.tickFinished, $value.upsMilli,
        $value.tpsMilli, $script:DysonSimulationUpsSource, $script:DysonSimulationTpsSource
    )
    return [pscustomobject][ordered]@{
        sessionId = $sessionId; processId = [int]$processId; processStartedAtUnixMs = $processStarted
        bridgeStartedAtUnixMs = $bridgeStarted; sequence = $sequence; sampleStartedAtUnixMs = $sampleStarted
        sampleFinishedAtUnixMs = $sampleFinished; writtenAtUnixMs = $writtenAt; windowDurationMs = $windowDuration
        tickStarted = $tickStarted; tickFinished = $tickFinished; upsMilli = $upsMilli; tpsMilli = $tpsMilli
    }
}

function Get-DysonBridgeActualSimulationTelemetry {
    param(
        [Parameter(Mandatory)][string]$ControlRoot,
        [Parameter(Mandatory)][string]$SecretFile,
        [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ExpectedProcessId,
        [Parameter(Mandatory)][ValidateRange(1, [long]::MaxValue)][long]$ExpectedProcessStartedAtUnixMs,
        [ValidateRange(1, [long]::MaxValue)][long]$NowUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),
        [ValidateRange(2000, 120000)][int]$HeartbeatMaxAgeMs = 10000,
        [ValidateRange(2000, 120000)][int]$TelemetryMaxAgeMs = 10000,
        [string]$LastAcceptedSessionId,
        [ValidateRange(0, [long]::MaxValue)][long]$LastAcceptedSequence = 0
    )
    if (-not [System.IO.Path]::IsPathRooted($ControlRoot)) { throw 'BRIDGE_ROOT_INVALID' }
    $root = [System.IO.Path]::GetFullPath($ControlRoot).TrimEnd([char]'\', [char]'/')
    if ($root -eq [System.IO.Path]::GetPathRoot($root).TrimEnd([char]'\', [char]'/')) { throw 'BRIDGE_ROOT_INVALID' }
    $rootInfo = [System.IO.DirectoryInfo]::new($root)
    $rootInfo.Refresh()
    if (-not $rootInfo.Exists -or ($rootInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'BRIDGE_DIRECTORY_INVALID'
    }
    $secret = Read-DysonBridgeTelemetrySecret -Path $SecretFile
    $heartbeatPath = [System.IO.Path]::Combine($root, 'heartbeat')
    $before = ConvertFrom-DysonBridgeHeartbeatPayload -Secret $secret -Payload (
        Read-DysonBridgeTelemetryFile -Path $heartbeatPath -CodePrefix 'BRIDGE_HEARTBEAT')
    $session = ConvertFrom-DysonBridgeRuntimeSessionPayload -Secret $secret -Payload (
        Read-DysonBridgeTelemetryFile -Path ([System.IO.Path]::Combine($root, 'runtime-session')) -CodePrefix 'BRIDGE_RUNTIME_SESSION')
    $telemetry = ConvertFrom-DysonBridgeSimulationTelemetryPayload -Secret $secret -Payload (
        Read-DysonBridgeTelemetryFile -Path ([System.IO.Path]::Combine($root, 'simulation-telemetry')) -CodePrefix 'BRIDGE_TELEMETRY')
    $after = ConvertFrom-DysonBridgeHeartbeatPayload -Secret $secret -Payload (
        Read-DysonBridgeTelemetryFile -Path $heartbeatPath -CodePrefix 'BRIDGE_HEARTBEAT')
    foreach ($heartbeat in @($before, $after)) {
        $age = $NowUnixMs - [long]$heartbeat.writtenAtUnixMs
        if ($age -lt -5000 -or $age -gt $HeartbeatMaxAgeMs) { throw 'BRIDGE_HEARTBEAT_STALE' }
    }
    if ($before.processId -ne $after.processId -or $before.startedAtUnixMs -ne $after.startedAtUnixMs -or
        $before.pluginVersion -cne $after.pluginVersion) { throw 'BRIDGE_SESSION_CHANGED' }
    if ($session.processId -ne $after.processId -or $session.bridgeStartedAtUnixMs -ne $after.startedAtUnixMs -or
        $session.pluginVersion -cne $after.pluginVersion -or $session.processId -ne $ExpectedProcessId -or
        $session.processStartedAtUnixMs -ne $ExpectedProcessStartedAtUnixMs) {
        throw 'BRIDGE_RUNTIME_IDENTITY_MISMATCH'
    }
    if ($telemetry.sessionId -cne $session.sessionId -or $telemetry.processId -ne $session.processId -or
        $telemetry.processStartedAtUnixMs -ne $session.processStartedAtUnixMs -or
        $telemetry.bridgeStartedAtUnixMs -ne $session.bridgeStartedAtUnixMs) {
        throw 'BRIDGE_TELEMETRY_IDENTITY_MISMATCH'
    }
    if ($session.issuedAtUnixMs -gt $NowUnixMs + 5000 -or $session.bridgeStartedAtUnixMs -gt $NowUnixMs + 5000) {
        throw 'BRIDGE_RUNTIME_SESSION_FUTURE'
    }
    $telemetryAge = $NowUnixMs - [long]$telemetry.writtenAtUnixMs
    if ($telemetryAge -lt -5000 -or $telemetryAge -gt $TelemetryMaxAgeMs) { throw 'BRIDGE_TELEMETRY_STALE' }
    if (-not [string]::IsNullOrWhiteSpace($LastAcceptedSessionId)) {
        $normalizedLastSession = ConvertTo-DysonBridgeTelemetryGuid -Value $LastAcceptedSessionId
        if ($normalizedLastSession -ceq $session.sessionId -and $telemetry.sequence -le $LastAcceptedSequence) {
            throw 'BRIDGE_TELEMETRY_REPLAY'
        }
    }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_ACTUAL_SIMULATION_READING_V1'
        status = 'actual'
        sessionId = $session.sessionId
        processId = $session.processId
        processStartedAtUnixMs = $session.processStartedAtUnixMs
        bridgeStartedAtUnixMs = $session.bridgeStartedAtUnixMs
        sequence = $telemetry.sequence
        writtenAtUnixMs = $telemetry.writtenAtUnixMs
        actualUps = [double]$telemetry.upsMilli / 1000.0
        actualTps = [double]$telemetry.tpsMilli / 1000.0
        upsSource = $script:DysonSimulationUpsSource
        tpsSource = $script:DysonSimulationTpsSource
    }
}
