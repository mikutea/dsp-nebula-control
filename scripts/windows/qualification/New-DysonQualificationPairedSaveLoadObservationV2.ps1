#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RestoreReceiptPath,
    [Parameter(Mandatory)][string]$ProtectionPointManifestPath,
    [Parameter(Mandatory)][string]$LoadedSaveEvidencePath,
    [Parameter(Mandatory)][string]$SaveAcknowledgementPath,
    [Parameter(Mandatory)][string]$BridgeSecretPath,
    [Parameter(Mandatory)][string]$DsvPath,
    [Parameter(Mandatory)][string]$ServerPath,
    [Parameter(Mandatory)][string]$RollbackReceiptPath,
    [Parameter(Mandatory)][string]$ObservationId,
    [Parameter(Mandatory)][string]$QualificationRunId,
    [Parameter(Mandatory)][string]$ControlRelease,
    [Parameter(Mandatory)][string]$SubjectCommit,
    [Parameter(Mandatory)][datetimeoffset]$ObservedAtUtc,
    [Parameter(Mandatory)][datetimeoffset]$ExpiresAtUtc,
    [Parameter(Mandatory)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Qualification.PairedSaveLoad.ps1')

$observation = New-DysonPairedSaveLoadObservationValue `
    -RestoreReceiptPath $RestoreReceiptPath `
    -ProtectionPointManifestPath $ProtectionPointManifestPath `
    -LoadedSaveEvidencePath $LoadedSaveEvidencePath `
    -SaveAcknowledgementPath $SaveAcknowledgementPath `
    -BridgeSecretPath $BridgeSecretPath `
    -DsvPath $DsvPath `
    -ServerPath $ServerPath `
    -RollbackReceiptPath $RollbackReceiptPath `
    -ObservationId $ObservationId `
    -QualificationRunId $QualificationRunId `
    -ControlRelease $ControlRelease `
    -SubjectCommit $SubjectCommit `
    -ObservedAtUtc $ObservedAtUtc `
    -ExpiresAtUtc $ExpiresAtUtc

$writtenPath = Write-DysonPairedSaveLoadJsonNew -Path $OutputPath -Value $observation
[pscustomobject][ordered]@{
    created = $true
    protocol = [string]$observation.protocol
    schemaVersion = [int]$observation.schemaVersion
    observationId = [string]$observation.observationId
    qualificationRunId = [string]$observation.qualificationRunId
    observationSha256 = [string]$observation.observationSha256
    outputPath = $writtenPath
} | ConvertTo-Json -Compress
