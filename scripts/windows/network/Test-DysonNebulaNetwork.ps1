[CmdletBinding()]
param(
    [string]$GameDataHost = '',
    [ValidateRange(1, 65535)][int]$GameDataPort = 8469,
    [ValidateSet('tcp', 'ws', 'wss')][string]$GameDataTransport = 'ws',
    [string]$ManagementHost = '',
    [ValidateRange(1, 65535)][int]$ManagementPort = 443,
    [ValidateSet('tcp', 'http', 'https')][string]$ManagementTransport = 'https',
    [ValidateRange(250, 30000)][int]$TimeoutMilliseconds = 5000,
    [string[]]$ExpectedProcessNames = @('DSPGAME'),
    [string]$PassWallEvidencePath = '',
    [switch]$EnableRemoteProbes,
    [AllowEmptyString()][string]$RemoteProbeConfirmation = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'DysonNetwork.Common.ps1'))
try {
    $scriptRootItem = Get-Item -LiteralPath $PSScriptRoot -Force -ErrorAction Stop
    $commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
}
catch { throw 'The fixed network preflight script dependency is unavailable.' }
if (-not $scriptRootItem.PSIsContainer -or
    ($scriptRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    -not [string]::Equals(
        [System.IO.Path]::GetFullPath($commonItem.DirectoryName).TrimEnd('\', '/'),
        [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/'),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'The fixed network preflight script dependency is unavailable or redirected.'
}
. $commonItem.FullName

Assert-DysonNetworkRemoteProbeGate -Enabled ([bool]$EnableRemoteProbes) `
    -Confirmation $RemoteProbeConfirmation
Assert-DysonNetworkMutationDenied -Requested $false

if ($ExpectedProcessNames.Count -eq 0 -or $ExpectedProcessNames.Count -gt 8) {
    throw 'Expected process identity must contain between one and eight allowlisted names.'
}
foreach ($name in $ExpectedProcessNames) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -notmatch '^[A-Za-z0-9._-]{1,64}$') {
        throw 'Expected process identity contains a non-portable name.'
    }
}

$gameDataTarget = $null
if (-not [string]::IsNullOrWhiteSpace($GameDataHost)) {
    $gameDataTarget = Resolve-DysonNetworkTarget -Value $GameDataHost
}
$managementTarget = $null
if (-not [string]::IsNullOrWhiteSpace($ManagementHost)) {
    $managementTarget = Resolve-DysonNetworkTarget -Value $ManagementHost
}
if ($EnableRemoteProbes -and $null -eq $gameDataTarget) {
    throw 'A game-data target is required when remote probes are enabled.'
}

$passWallEvidence = if ([string]::IsNullOrWhiteSpace($PassWallEvidencePath)) {
    New-DysonPassWallEvidence
}
else {
    Read-DysonPassWallEvidenceFile -Path $PassWallEvidencePath
}

$localListenerProbe = {
    param([int]$Port, [string[]]$Names)
    Get-DysonLocalListenerObservation -Port $Port -ExpectedProcessNames $Names
}
$dnsProbe = {
    param([object]$Target)
    Get-DysonRawDnsObservation -Target $Target
}
$tcpProbe = {
    param([System.Net.IPAddress]$Address, [int]$Port)
    Get-DysonRawTcpObservation -Address $Address -Port $Port -TimeoutMilliseconds $TimeoutMilliseconds
}.GetNewClosure()
$webSocketProbe = {
    param([System.Net.IPAddress]$Address, [int]$Port, [string]$Transport)
    Get-DysonRawWebSocketObservation -Address $Address -Port $Port -Transport $Transport `
        -TimeoutMilliseconds $TimeoutMilliseconds
}.GetNewClosure()

$mode = if ($EnableRemoteProbes) { 'remote-read-only' } else { 'local-read-only' }
$result = Invoke-DysonNetworkAssessment -Mode $mode -RemoteProbesEnabled ([bool]$EnableRemoteProbes) `
    -GameDataTarget $gameDataTarget -GameDataPort $GameDataPort -GameDataTransport $GameDataTransport `
    -ManagementTarget $managementTarget -ManagementPort $ManagementPort `
    -ManagementTransport $ManagementTransport -ExpectedProcessNames $ExpectedProcessNames `
    -PassWallEvidence $passWallEvidence -LocalListenerProbe $localListenerProbe -DnsProbe $dnsProbe `
    -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe

ConvertTo-DysonNetworkJson -Value $result
