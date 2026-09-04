[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationPath,
    [AllowNull()][string]$ExpectedObservationId,
    [AllowNull()][string]$ExpectedKind,
    [AllowNull()][string]$ExpectedRunId,
    [AllowNull()][string]$ExpectedTargetIdentity,
    [AllowNull()][string]$ExpectedReleaseVersion,
    [AllowNull()][string]$ExpectedSubjectCommit,
    [AllowNull()][string]$ExpectedRuntimePayloadSha256,
    [AllowNull()][string]$ExpectedReleaseManifestSha256,
    [AllowNull()][string]$ExpectedWorkloadProfileSha256,
    [AllowNull()][string]$ExpectedSavePairSha256,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'SoakObservationV2.Common.ps1')

$observation = Read-DysonSoakV2JsonFile -Path $ObservationPath
$result = Assert-DysonSoakObservationV2 -Observation $observation -ExpectedObservationId $ExpectedObservationId -ExpectedKind $ExpectedKind -ExpectedRunId $ExpectedRunId -ExpectedTargetIdentity $ExpectedTargetIdentity -ExpectedReleaseVersion $ExpectedReleaseVersion -ExpectedSubjectCommit $ExpectedSubjectCommit -ExpectedRuntimePayloadSha256 $ExpectedRuntimePayloadSha256 -ExpectedReleaseManifestSha256 $ExpectedReleaseManifestSha256 -ExpectedWorkloadProfileSha256 $ExpectedWorkloadProfileSha256 -ExpectedSavePairSha256 $ExpectedSavePairSha256 -NowUtc $NowUtc
[pscustomobject][ordered]@{
    protocol = 'DYSON_SOAK_OBSERVATION_VALIDATION_RESULT_V2'
    schemaVersion = 2
    qualified = [bool]$result.qualified
    observationId = [string]$result.observationId
    kind = [string]$result.kind
    runId = [string]$result.runId
    targetIdentity = [string]$result.targetIdentity
    releaseVersion = [string]$result.releaseVersion
    subjectBindingSha256 = [string]$result.subjectBindingSha256
    observedAtUtc = [string]$result.observedAtUtc
    expiresAtUtc = [string]$result.expiresAtUtc
    observationSha256 = [string]$result.observationSha256
    networkTouched = $false
    productionChanged = $false
} | ConvertTo-Json -Depth 4 -Compress
