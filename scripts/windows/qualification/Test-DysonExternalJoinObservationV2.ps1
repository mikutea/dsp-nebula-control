# Copyright (c) Dyson Control contributors.
# Read-only validation of an external-join observation v2 document.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationPath,
    [AllowNull()][string]$ExpectedObservationId,
    [AllowNull()][string]$ExpectedRunId,
    [AllowNull()][string]$ExpectedSubjectCommit,
    [AllowNull()][string]$ExpectedRuntimePayloadSha256,
    [AllowNull()][string]$ExpectedReleaseManifestSha256,
    [AllowNull()][string]$ExpectedPublicHost,
    [AllowNull()][string]$ExpectedClientPseudonym,
    [AllowNull()][string]$ExpectedSaveReceiptSha256,
    [AllowNull()][string]$ExpectedSavePairSha256,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'ExternalJoinObservationV2.Common.ps1')

$observation = Read-DysonExternalJoinObservationV2JsonFile -Path $ObservationPath
$result = Assert-DysonExternalJoinObservationV2 -Observation $observation -ExpectedObservationId $ExpectedObservationId -ExpectedRunId $ExpectedRunId -ExpectedSubjectCommit $ExpectedSubjectCommit -ExpectedRuntimePayloadSha256 $ExpectedRuntimePayloadSha256 -ExpectedReleaseManifestSha256 $ExpectedReleaseManifestSha256 -ExpectedPublicHost $ExpectedPublicHost -ExpectedClientPseudonym $ExpectedClientPseudonym -ExpectedSaveReceiptSha256 $ExpectedSaveReceiptSha256 -ExpectedSavePairSha256 $ExpectedSavePairSha256 -NowUtc $NowUtc

[pscustomobject][ordered]@{
    protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_VALIDATION_RESULT_V2'
    schemaVersion = 2
    qualified = [bool]$result.qualified
    observationId = [string]$result.observationId
    runId = [string]$result.runId
    publicHost = [string]$result.publicHost
    clientPseudonym = [string]$result.clientPseudonym
    saveReceiptSha256 = [string]$result.saveReceiptSha256
    terminalEventSha256 = [string]$result.terminalEventSha256
    observedAtUtc = [string]$result.observedAtUtc
    expiresAtUtc = [string]$result.expiresAtUtc
    observationSha256 = [string]$result.observationSha256
    identityCollected = [bool]$result.identityCollected
    networkAddressCollected = [bool]$result.networkAddressCollected
    networkTouched = $false
    productionChanged = $false
} | ConvertTo-Json -Depth 4 -Compress
