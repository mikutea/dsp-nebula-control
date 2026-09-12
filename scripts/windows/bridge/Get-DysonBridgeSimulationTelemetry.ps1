[CmdletBinding()]
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

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Telemetry.ps1')

$parameters = @{
    ControlRoot = $ControlRoot
    SecretFile = $SecretFile
    ExpectedProcessId = $ExpectedProcessId
    ExpectedProcessStartedAtUnixMs = $ExpectedProcessStartedAtUnixMs
    NowUnixMs = $NowUnixMs
    HeartbeatMaxAgeMs = $HeartbeatMaxAgeMs
    TelemetryMaxAgeMs = $TelemetryMaxAgeMs
    LastAcceptedSequence = $LastAcceptedSequence
}
if (-not [string]::IsNullOrWhiteSpace($LastAcceptedSessionId)) {
    $parameters.LastAcceptedSessionId = $LastAcceptedSessionId
}

Get-DysonBridgeActualSimulationTelemetry @parameters |
    Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
