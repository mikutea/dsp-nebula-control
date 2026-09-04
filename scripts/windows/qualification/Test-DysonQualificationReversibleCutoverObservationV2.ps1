[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationFile,
    [Parameter(Mandatory)][string]$MaintenanceWindowFile,
    [Parameter(Mandatory)][string]$ReleaseManifestFile,
    [Parameter(Mandatory)][string]$ProtectionPointFile,
    [Parameter(Mandatory)][string]$AuthoritySnapshotFile,
    [Parameter(Mandatory)][string]$SwitchToDysonReceiptFile,
    [Parameter(Mandatory)][string]$DysonHealthFile,
    [Parameter(Mandatory)][string]$SwitchBackReceiptFile,
    [Parameter(Mandatory)][string]$RestoredHealthFile,
    [Parameter(Mandatory)][string]$AuditFile,
    [Parameter(Mandatory)][string]$DsvPath,
    [Parameter(Mandatory)][string]$ServerPath,
    [Parameter(Mandatory)][string]$ExpectedApprovalId,
    [Parameter(Mandatory)][string]$ExpectedWindowId,
    [Parameter(Mandatory)][string]$ExpectedQualificationRunId,
    [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
    [Parameter(Mandatory)][string]$ExpectedControlRelease,
    [Parameter(Mandatory)][string]$ExpectedSubjectCommit,
    [Parameter(Mandatory)][string]$ExpectedRuntimePayloadSha256,
    [Parameter(Mandatory)][string]$ExpectedReleaseManifestSha256,
    [Parameter(Mandatory)][string]$ObservedAtUtc,
    [Parameter(Mandatory)][string]$ExpiresAtUtc
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    . (Join-Path $PSScriptRoot 'Qualification.ReversibleCutover.ps1')
    $arguments = @{}
    foreach ($name in @(
        'MaintenanceWindowFile','ReleaseManifestFile','ProtectionPointFile','AuthoritySnapshotFile',
        'SwitchToDysonReceiptFile','DysonHealthFile','SwitchBackReceiptFile','RestoredHealthFile','AuditFile',
        'DsvPath','ServerPath','ExpectedApprovalId','ExpectedWindowId','ExpectedQualificationRunId','ExpectedTargetIdentity',
        'ExpectedControlRelease','ExpectedSubjectCommit','ExpectedRuntimePayloadSha256','ExpectedReleaseManifestSha256',
        'ObservedAtUtc','ExpiresAtUtc'
    )) { $arguments[$name] = Get-Variable -Name $name -ValueOnly }
    $validated = Test-ReversibleCutoverObservation -ObservationFile $ObservationFile -SourceArguments $arguments
    [pscustomobject][ordered]@{
        ok=$true; protocol=$validated.protocol; qualificationRunId=$validated.qualificationRunId
        observationSha256=$validated.observationSha256; networkTouched=$false; productionChanged=$false
    } | ConvertTo-Json -Compress
    exit 0
}
catch {
    $code = if (Get-Command Get-ReversibleCutoverErrorCode -ErrorAction SilentlyContinue) { Get-ReversibleCutoverErrorCode $_.Exception } else { 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID' }
    [pscustomobject][ordered]@{ ok=$false; error=[pscustomobject][ordered]@{ code=$code }; networkTouched=$false; productionChanged=$false } | ConvertTo-Json -Compress
    exit 1
}
