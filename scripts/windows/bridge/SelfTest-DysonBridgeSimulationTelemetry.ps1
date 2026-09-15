[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Telemetry.ps1')

$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$script:ShadowCallCount = 0

function Write-SelfTestText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, $script:Utf8NoBom)
}

function New-SignedPayload {
    param(
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string[]]$Values,
        [Parameter(Mandatory)][string]$Secret
    )
    if ($Names.Length -ne $Values.Length + 1 -or $Names[$Names.Length - 1] -cne 'hmac') {
        throw 'SELFTEST_FIXTURE_INVALID'
    }
    $signature = Get-DysonBridgeTelemetryHmac -Secret $Secret -Parts $Values
    $lines = for ($index = 0; $index -lt $Values.Length; $index++) {
        $Names[$index] + '=' + $Values[$index]
    }
    return [string]::Join("`n", @($lines) + @('hmac=' + $signature)) + "`n"
}

function New-HeartbeatFixture {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$ProcessId,
        [Parameter(Mandatory)][string]$BridgeStartedAtUnixMs,
        [Parameter(Mandatory)][string]$WrittenAtUnixMs
    )
    return New-SignedPayload -Secret $Secret `
        -Names @('protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state', 'hmac') `
        -Values @('DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', $ProcessId, $BridgeStartedAtUnixMs, $WrittenAtUnixMs, 'ready')
}

function New-RuntimeSessionFixture {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$ProcessId,
        [Parameter(Mandatory)][string]$ProcessStartedAtUnixMs,
        [Parameter(Mandatory)][string]$BridgeStartedAtUnixMs,
        [Parameter(Mandatory)][string]$IssuedAtUnixMs
    )
    return New-SignedPayload -Secret $Secret `
        -Names @('protocol', 'sessionId', 'pluginVersion', 'processId', 'processStartedAtUnixMs',
            'bridgeStartedAtUnixMs', 'issuedAtUnixMs', 'hmac') `
        -Values @('DYSON_CONTROL_RUNTIME_SESSION_V1', $SessionId, '0.1.0', $ProcessId,
            $ProcessStartedAtUnixMs, $BridgeStartedAtUnixMs, $IssuedAtUnixMs)
}

function New-TelemetryFixture {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$ProcessId,
        [Parameter(Mandatory)][string]$ProcessStartedAtUnixMs,
        [Parameter(Mandatory)][string]$BridgeStartedAtUnixMs,
        [Parameter(Mandatory)][string]$Sequence,
        [Parameter(Mandatory)][string]$SampleStartedAtUnixMs,
        [Parameter(Mandatory)][string]$SampleFinishedAtUnixMs,
        [Parameter(Mandatory)][string]$WrittenAtUnixMs,
        [Parameter(Mandatory)][string]$WindowDurationMs,
        [Parameter(Mandatory)][string]$TickStarted,
        [Parameter(Mandatory)][string]$TickFinished,
        [Parameter(Mandatory)][string]$UpsMilli,
        [Parameter(Mandatory)][string]$TpsMilli
    )
    return New-SignedPayload -Secret $Secret `
        -Names @('protocol', 'sessionId', 'processId', 'processStartedAtUnixMs', 'bridgeStartedAtUnixMs',
            'sequence', 'sampleStartedAtUnixMs', 'sampleFinishedAtUnixMs', 'writtenAtUnixMs',
            'windowDurationMs', 'tickStarted', 'tickFinished', 'upsMilli', 'tpsMilli',
            'upsSource', 'tpsSource', 'hmac') `
        -Values @('DYSON_CONTROL_SIMULATION_TELEMETRY_V1', $SessionId, $ProcessId,
            $ProcessStartedAtUnixMs, $BridgeStartedAtUnixMs, $Sequence, $SampleStartedAtUnixMs,
            $SampleFinishedAtUnixMs, $WrittenAtUnixMs, $WindowDurationMs, $TickStarted,
            $TickFinished, $UpsMilli, $TpsMilli, 'fpscontroller-stopwatch', 'gamemain-tick-wallclock')
}

function Assert-SelfTestThrows {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$ExpectedMessage)
    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -cne $ExpectedMessage) {
            throw ('Expected {0}, received {1}' -f $ExpectedMessage, $_.Exception.Message)
        }
        return
    }
    throw ('Expected failure was not raised: ' + $ExpectedMessage)
}

$testRoot = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(), 'dyson-bridge-telemetry-selftest-' + [guid]::NewGuid().ToString('N'))
$controlRoot = [System.IO.Path]::Combine($testRoot, 'control')
$secretPath = [System.IO.Path]::Combine($testRoot, 'secret')
[void][System.IO.Directory]::CreateDirectory($controlRoot)

$secret = 'fictional-cross-runtime-secret-0123456789'
$originalSessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
$originalProcessId = '4242'
$originalProcessStartedAt = '1788080000000'
$originalBridgeStartedAt = '1788081000000'
$originalWrittenAt = '1788081003000'
$newSessionId = '123e4567-e89b-42d3-a456-426614174001'

try {
    Write-SelfTestText -Path $secretPath -Value ($secret + "`n")
    $heartbeat = New-HeartbeatFixture -Secret $secret -ProcessId $originalProcessId `
        -BridgeStartedAtUnixMs $originalBridgeStartedAt -WrittenAtUnixMs $originalWrittenAt
    $runtimeSession = New-RuntimeSessionFixture -Secret $secret -SessionId $originalSessionId `
        -ProcessId $originalProcessId -ProcessStartedAtUnixMs $originalProcessStartedAt `
        -BridgeStartedAtUnixMs $originalBridgeStartedAt -IssuedAtUnixMs $originalBridgeStartedAt
    $telemetry = New-TelemetryFixture -Secret $secret -SessionId $originalSessionId `
        -ProcessId $originalProcessId -ProcessStartedAtUnixMs $originalProcessStartedAt `
        -BridgeStartedAtUnixMs $originalBridgeStartedAt -Sequence '7' `
        -SampleStartedAtUnixMs '1788081001000' -SampleFinishedAtUnixMs $originalWrittenAt `
        -WrittenAtUnixMs $originalWrittenAt -WindowDurationMs '2000' -TickStarted '1000' `
        -TickFinished '1120' -UpsMilli '59875' -TpsMilli '60000'
    if ($runtimeSession -cnotmatch 'hmac=95fd6dfd32fca0deed984c68cdcd475d65a842004f596c5e5874a938c75e4b28' -or
        $telemetry -cnotmatch 'hmac=1142702c6adc9c87e93de149922017b4d26465e7923a5aab109035f104d75a95') {
        throw 'CROSS_RUNTIME_VECTOR_MISMATCH'
    }
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'heartbeat')) -Value $heartbeat
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'runtime-session')) -Value $runtimeSession
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $telemetry

    $wrapperJson = & (Join-Path $PSScriptRoot 'Get-DysonBridgeSimulationTelemetry.ps1') `
        -ControlRoot $controlRoot -SecretFile $secretPath -ExpectedProcessId 4242 `
        -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000
    $wrapperReading = $wrapperJson | Microsoft.PowerShell.Utility\ConvertFrom-Json
    if ($wrapperReading.status -cne 'actual' -or $wrapperReading.actualUps -ne 59.875 -or
        $wrapperReading.actualTps -ne 60.0) { throw 'WRAPPER_READING_REJECTED' }

    # These names are deliberately shadowed after fixture setup. The production
    # reader must keep using bounded .NET file APIs and must never invoke them.
    function Get-Content { $script:ShadowCallCount++; throw 'SHADOW_GET_CONTENT_CALLED' }
    function Get-Item { $script:ShadowCallCount++; throw 'SHADOW_GET_ITEM_CALLED' }
    function Test-Path { $script:ShadowCallCount++; throw 'SHADOW_TEST_PATH_CALLED' }
    function ConvertFrom-Json { $script:ShadowCallCount++; throw 'SHADOW_CONVERT_FROM_JSON_CALLED' }
    function Get-FileHash { $script:ShadowCallCount++; throw 'SHADOW_GET_FILE_HASH_CALLED' }
    function Get-Process { $script:ShadowCallCount++; throw 'SHADOW_GET_PROCESS_CALLED' }

    $reading = Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
        -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000
    if ($reading.status -cne 'actual' -or $reading.actualUps -ne 59.875 -or $reading.actualTps -ne 60.0 -or
        $reading.upsSource -cne 'fpscontroller-stopwatch' -or
        $reading.tpsSource -cne 'gamemain-tick-wallclock') { throw 'VALID_READING_REJECTED' }

    $tampered = $telemetry.Replace('upsMilli=59875', 'upsMilli=59876')
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $tampered
    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_SIGNATURE_INVALID' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000)
    }
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $telemetry

    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_TELEMETRY_REPLAY' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000 `
            -LastAcceptedSessionId $originalSessionId -LastAcceptedSequence 7)
    }
    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_TELEMETRY_STALE' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081006001 `
            -HeartbeatMaxAgeMs 20000 -TelemetryMaxAgeMs 2000)
    }

    $wrongSessionTelemetry = New-TelemetryFixture -Secret $secret -SessionId $newSessionId `
        -ProcessId $originalProcessId -ProcessStartedAtUnixMs $originalProcessStartedAt `
        -BridgeStartedAtUnixMs $originalBridgeStartedAt -Sequence '8' `
        -SampleStartedAtUnixMs '1788081001000' -SampleFinishedAtUnixMs $originalWrittenAt `
        -WrittenAtUnixMs $originalWrittenAt -WindowDurationMs '2000' -TickStarted '1000' `
        -TickFinished '1120' -UpsMilli '59875' -TpsMilli '60000'
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $wrongSessionTelemetry
    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_TELEMETRY_IDENTITY_MISMATCH' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000)
    }
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $telemetry

    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_RUNTIME_IDENTITY_MISMATCH' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4243 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788081003000)
    }

    $restartProcessStartedAt = '1788082000000'
    $restartBridgeStartedAt = '1788082001000'
    $restartWrittenAt = '1788082004000'
    $restartHeartbeat = New-HeartbeatFixture -Secret $secret -ProcessId $originalProcessId `
        -BridgeStartedAtUnixMs $restartBridgeStartedAt -WrittenAtUnixMs $restartWrittenAt
    $restartSession = New-RuntimeSessionFixture -Secret $secret -SessionId $newSessionId `
        -ProcessId $originalProcessId -ProcessStartedAtUnixMs $restartProcessStartedAt `
        -BridgeStartedAtUnixMs $restartBridgeStartedAt -IssuedAtUnixMs $restartBridgeStartedAt
    $restartTelemetry = New-TelemetryFixture -Secret $secret -SessionId $newSessionId `
        -ProcessId $originalProcessId -ProcessStartedAtUnixMs $restartProcessStartedAt `
        -BridgeStartedAtUnixMs $restartBridgeStartedAt -Sequence '1' `
        -SampleStartedAtUnixMs '1788082002000' -SampleFinishedAtUnixMs $restartWrittenAt `
        -WrittenAtUnixMs $restartWrittenAt -WindowDurationMs '2000' -TickStarted '2000' `
        -TickFinished '2120' -UpsMilli '59750' -TpsMilli '60000'
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'heartbeat')) -Value $restartHeartbeat
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'runtime-session')) -Value $restartSession
    Write-SelfTestText -Path ([System.IO.Path]::Combine($controlRoot, 'simulation-telemetry')) -Value $restartTelemetry
    Assert-SelfTestThrows -ExpectedMessage 'BRIDGE_RUNTIME_IDENTITY_MISMATCH' -Action {
        [void](Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
            -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788080000000 -NowUnixMs 1788082004000)
    }
    $restartReading = Get-DysonBridgeActualSimulationTelemetry -ControlRoot $controlRoot -SecretFile $secretPath `
        -ExpectedProcessId 4242 -ExpectedProcessStartedAtUnixMs 1788082000000 -NowUnixMs 1788082004000 `
        -LastAcceptedSessionId $originalSessionId -LastAcceptedSequence 7
    if ($restartReading.sessionId -cne $newSessionId -or $restartReading.sequence -ne 1 -or
        $restartReading.actualUps -ne 59.75) { throw 'RESTART_GENERATION_REJECTED' }
    if ($script:ShadowCallCount -ne 0) { throw 'SHADOW_COMMAND_WAS_INVOKED' }

    $result = [ordered]@{
        protocol = 'DYSON_CONTROL_SIMULATION_TELEMETRY_SELFTEST_V1'
        state = 'passed'
        powershell51Compatible = ($PSVersionTable.PSVersion.Major -eq 5)
        crossRuntimeVectors = $true
        productionWrapper = $true
        actualUpsAndTps = $true
        tamperRejected = $true
        replayRejected = $true
        staleRejected = $true
        sessionMismatchRejected = $true
        pidMismatchRejected = $true
        restartGenerationBound = $true
        shadowCommandsInvoked = $script:ShadowCallCount
    }
}
finally {
    if ([System.IO.Directory]::Exists($testRoot)) {
        [System.IO.Directory]::Delete($testRoot, $true)
    }
}

$result | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
