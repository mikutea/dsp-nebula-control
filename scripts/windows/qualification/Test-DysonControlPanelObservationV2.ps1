# Copyright (c) Dyson Control contributors.
# Validates a panel observation without contacting or modifying the target.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationPath,
    [AllowNull()][string]$ExpectedReceiptId,
    [AllowNull()][string]$ExpectedRunId,
    [AllowNull()][string]$ExpectedActionTargetId,
    [AllowNull()][string]$ExpectedTargetIdentity,
    [AllowNull()][string]$ExpectedSubjectCommit,
    [AllowNull()][string]$ExpectedRuntimePayloadSha256,
    [AllowNull()][string]$ExpectedPublicHost,
    [AllowNull()][string]$ExpectedReleaseVersion,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'PanelObservationV2.Common.ps1')

$observation = Read-DysonControlPanelObservationV2JsonFile -Path $ObservationPath
$result = Assert-DysonControlPanelObservationV2 -Observation $observation -ExpectedReceiptId $ExpectedReceiptId -ExpectedRunId $ExpectedRunId -ExpectedActionTargetId $ExpectedActionTargetId -ExpectedTargetIdentity $ExpectedTargetIdentity -ExpectedSubjectCommit $ExpectedSubjectCommit -ExpectedRuntimePayloadSha256 $ExpectedRuntimePayloadSha256 -ExpectedPublicHost $ExpectedPublicHost -ExpectedReleaseVersion $ExpectedReleaseVersion -NowUtc $NowUtc

[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_VALIDATION_RESULT_V2'
    schemaVersion = 2
    qualified = [bool]$result.qualified
    receiptId = [string]$result.receiptId
    runId = [string]$result.runId
    publicHost = [string]$result.publicHost
    observedAtUtc = [string]$result.observedAtUtc
    expiresAtUtc = [string]$result.expiresAtUtc
    receiptSha256 = [string]$result.receiptSha256
    networkTouched = $false
    productionChanged = $false
} | ConvertTo-Json -Depth 4 -Compress
