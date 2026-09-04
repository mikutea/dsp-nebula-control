#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationPath,
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
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Qualification.PairedSaveLoad.ps1')

$observation = Read-DysonPairedSaveLoadJson -Path $ObservationPath
$result = Assert-DysonQualificationPairedSaveLoadObservationV2 `
    -Observation $observation `
    -RestoreReceiptPath $RestoreReceiptPath `
    -ProtectionPointManifestPath $ProtectionPointManifestPath `
    -LoadedSaveEvidencePath $LoadedSaveEvidencePath `
    -SaveAcknowledgementPath $SaveAcknowledgementPath `
    -BridgeSecretPath $BridgeSecretPath `
    -DsvPath $DsvPath `
    -ServerPath $ServerPath `
    -RollbackReceiptPath $RollbackReceiptPath `
    -ExpectedQualificationRunId $ExpectedQualificationRunId `
    -ExpectedControlRelease $ExpectedControlRelease `
    -ExpectedSubjectCommit $ExpectedSubjectCommit `
    -NowUtc $NowUtc
$result | ConvertTo-Json -Compress
