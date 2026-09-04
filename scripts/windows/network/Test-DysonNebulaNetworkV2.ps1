[CmdletBinding()]
param(
    [ValidateSet('stock', 'preview', 'consume')][string]$QualificationMode = 'stock',
    [string]$QualificationId = '',
    [string]$EvidenceRoot = '',
    [string]$BuildHarvestRootA = '',
    [string]$BuildHarvestRootB = '',
    [string]$KeyRingRoot = '',
    [string]$ReplayRoot = '',
    [AllowEmptyString()][string]$QualificationConsumeConfirmation = '',
    [string]$GameDataHost = '',
    [ValidateRange(1, 65535)][int]$LocalGamePort = 8469,
    [string]$ManagementHost = '',
    [ValidateRange(1, 65535)][int]$ManagementPort = 443,
    [ValidateSet('tcp', 'http', 'https')][string]$ManagementTransport = 'https',
    [ValidateRange(250, 30000)][int]$TimeoutMilliseconds = 5000,
    [switch]$EnableRemoteProbes,
    [AllowEmptyString()][string]$RemoteProbeConfirmation = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$QualificationMode = $QualificationMode.ToLowerInvariant()
$ManagementTransport = $ManagementTransport.ToLowerInvariant()

function Get-DysonNetworkV2FixedSameTreeFile {
    param([Parameter(Mandatory)][string]$Name)

    if ($Name -cnotmatch '^[A-Za-z0-9._-]{1,128}$') {
        throw 'DYSON_NETWORK_V2_FIXED_DEPENDENCY_NAME_INVALID'
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Name))
    try {
        $rootItem = Get-Item -LiteralPath $PSScriptRoot -Force -ErrorAction Stop
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    }
    catch { throw 'DYSON_NETWORK_V2_FIXED_DEPENDENCY_UNAVAILABLE' }
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath($item.DirectoryName).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'DYSON_NETWORK_V2_FIXED_DEPENDENCY_REDIRECTED'
    }
    return $item
}

$commonItem = Get-DysonNetworkV2FixedSameTreeFile -Name 'DysonNetworkV2.Common.ps1'
. $commonItem.FullName

Assert-DysonNetworkRemoteProbeGate -Enabled ([bool]$EnableRemoteProbes) `
    -Confirmation $RemoteProbeConfirmation
Assert-DysonNetworkMutationDenied -Requested $false

$gameDataTarget = $null
$managementTarget = $null
if (-not [string]::IsNullOrWhiteSpace($ManagementHost)) {
    $managementTarget = Resolve-DysonNetworkTarget -Value $ManagementHost
}

$qualificationInputNames = @(
    'QualificationId', 'EvidenceRoot', 'BuildHarvestRootA', 'BuildHarvestRootB',
    'KeyRingRoot', 'ReplayRoot', 'GameDataHost'
)
$qualificationInputValues = @(
    $QualificationId, $EvidenceRoot, $BuildHarvestRootA, $BuildHarvestRootB,
    $KeyRingRoot, $ReplayRoot, $GameDataHost
)

if ($QualificationMode -ceq 'stock') {
    foreach ($value in $qualificationInputValues) {
        if (-not [string]::IsNullOrEmpty([string]$value)) {
            throw 'DYSON_NETWORK_V2_STOCK_MODE_REJECTS_QUALIFICATION_INPUTS'
        }
    }
    if (-not [string]::IsNullOrEmpty($QualificationConsumeConfirmation)) {
        throw 'DYSON_NETWORK_V2_STOCK_MODE_REJECTS_CONSUME_CONFIRMATION'
    }
    $qualification = New-DysonNetworkV2StockQualification
}
else {
    for ($index = 0; $index -lt $qualificationInputValues.Count; $index += 1) {
        if ([string]::IsNullOrWhiteSpace([string]$qualificationInputValues[$index])) {
            throw ('DYSON_NETWORK_V2_REQUIRED_INPUT_MISSING_' + $qualificationInputNames[$index].ToUpperInvariant())
        }
    }
    Assert-DysonNetworkV2CanonicalQualificationId -QualificationId $QualificationId
    if ($QualificationMode -ceq 'consume' -and -not $EnableRemoteProbes) {
        throw 'DYSON_NETWORK_V2_CONSUME_REQUIRES_REMOTE_PROBES'
    }
    $gameDataTarget = Resolve-DysonNetworkTarget -Value $GameDataHost
    if ([string]$gameDataTarget.kind -cne 'hostname' -or
        [string]$gameDataTarget.value -cne $GameDataHost) {
        throw 'DYSON_NETWORK_V2_GAME_AUTHORITY_NOT_CANONICAL'
    }

    $verifierItem = Get-DysonNetworkV2FixedSameTreeFile `
        -Name 'Test-DysonHostnameWssQualification.ps1'
    $powershellPath = [System.IO.Path]::GetFullPath((Join-Path $PSHOME 'powershell.exe'))
    try { $powershellItem = Get-Item -LiteralPath $powershellPath -Force -ErrorAction Stop }
    catch { throw 'DYSON_NETWORK_V2_FIXED_POWERSHELL_UNAVAILABLE' }
    if ($powershellItem.PSIsContainer -or
        ($powershellItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_NETWORK_V2_FIXED_POWERSHELL_REDIRECTED'
    }
    $verifierArguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $verifierItem.FullName,
        '-EvidenceRoot', $EvidenceRoot,
        '-BuildHarvestRootA', $BuildHarvestRootA,
        '-BuildHarvestRootB', $BuildHarvestRootB,
        '-KeyRingRoot', $KeyRingRoot,
        '-ReplayRoot', $ReplayRoot,
        '-ExpectedQualificationId', $QualificationId,
        '-ExpectedAuthority', [string]$gameDataTarget.value,
        '-ExpectedPort', '443'
    )
    if ($QualificationMode -ceq 'consume') {
        if (-not [string]::Equals(
            $QualificationConsumeConfirmation,
            'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1',
            [System.StringComparison]::Ordinal
        )) { throw 'DYSON_NETWORK_V2_CONSUME_CONFIRMATION_INVALID' }
        $verifierArguments += @('-Consume', '-Confirmation', $QualificationConsumeConfirmation)
    }
    elseif (-not [string]::IsNullOrEmpty($QualificationConsumeConfirmation)) {
        throw 'DYSON_NETWORK_V2_PREVIEW_REJECTS_CONSUME_CONFIRMATION'
    }

    try {
        # The verifier has intentional non-zero preview/blocked exit codes, so it
        # must run in a fixed child host rather than `exit` our assessment process.
        $verifierOutput = [string]::Join("`n", @(
            & $powershellItem.FullName @verifierArguments 2>$null
        ))
        $verifierExitCode = [int]$LASTEXITCODE
    }
    catch {
        # The fixed verifier emits bounded error codes. Do not copy private paths or evidence values.
        $message = [string]$_.Exception.Message
        if ($message -cmatch 'DYSON_[A-Z0-9_]{1,120}') {
            throw $Matches[0]
        }
        throw 'DYSON_NETWORK_V2_QUALIFICATION_VERIFIER_REJECTED'
    }
    if ([string]::IsNullOrWhiteSpace($verifierOutput) -or $verifierOutput.Length -gt 65536) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_PROJECTION_INVALID'
    }
    try { $rawProjection = $verifierOutput | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'DYSON_NETWORK_V2_QUALIFICATION_PROJECTION_INVALID' }
    $qualification = ConvertFrom-DysonNetworkV2QualificationProjection `
        -Projection $rawProjection -ExpectedQualificationId $QualificationId `
        -NowUtc ([DateTimeOffset]::UtcNow) -ValidationMode $QualificationMode
    $expectedExitCode = switch ([string]$qualification.decision) {
        'qualified' { 0; break }
        'preview-valid' { 3; break }
        'blocked' { 2; break }
        default { -1 }
    }
    if ($verifierExitCode -ne $expectedExitCode -or
        ($QualificationMode -ceq 'consume' -and
            [string]$qualification.decision -eq 'preview-valid') -or
        ($QualificationMode -ceq 'preview' -and
            [string]$qualification.decision -eq 'qualified')) {
        throw 'DYSON_NETWORK_V2_QUALIFICATION_EXIT_DECISION_MISMATCH'
    }
}

if ($EnableRemoteProbes -and $QualificationMode -ne 'stock' -and $null -eq $gameDataTarget) {
    throw 'DYSON_NETWORK_V2_GAME_DATA_TARGET_REQUIRED'
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
    Get-DysonRawTcpObservation -Address $Address -Port $Port `
        -TimeoutMilliseconds $TimeoutMilliseconds
}.GetNewClosure()
$webSocketProbe = {
    param([System.Net.IPAddress]$Address, [string]$Authority, [int]$Port)
    Get-DysonRawHostnamePreservedWebSocketObservationV2 -Address $Address `
        -Authority $Authority -Port $Port -TimeoutMilliseconds $TimeoutMilliseconds
}.GetNewClosure()
$addressClassProbe = {
    param([System.Net.IPAddress]$Address)
    Get-DysonNetworkV2AddressClass -Address $Address
}

$mode = if ($EnableRemoteProbes) { 'remote-read-only' } else { 'local-read-only' }
$result = Invoke-DysonNetworkAssessmentV2 -Mode $mode `
    -RemoteProbesEnabled ([bool]$EnableRemoteProbes) -GameDataTarget $gameDataTarget `
    -ManagementTarget $managementTarget -ManagementPort $ManagementPort `
    -ManagementTransport $ManagementTransport -LocalGamePort $LocalGamePort `
    -Qualification $qualification `
    -NowUtc ([DateTimeOffset]::UtcNow) -LocalListenerProbe $localListenerProbe `
    -DnsProbe $dnsProbe -TcpProbe $tcpProbe -WebSocketProbe $webSocketProbe `
    -AddressClassProbe $addressClassProbe

ConvertTo-DysonNetworkV2Json -Value $result
