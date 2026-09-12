[CmdletBinding()]
param(
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
    [Parameter(Mandatory)][string]$ExpiresAtUtc,
    [Parameter(Mandatory)][string]$OutputPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    . (Join-Path $PSScriptRoot 'Qualification.ReversibleCutover.ps1')
    if (Test-Path -LiteralPath $OutputPath) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OUTPUT_EXISTS' }
    $arguments = @{}
    foreach ($name in @(
        'MaintenanceWindowFile','ReleaseManifestFile','ProtectionPointFile','AuthoritySnapshotFile',
        'SwitchToDysonReceiptFile','DysonHealthFile','SwitchBackReceiptFile','RestoredHealthFile','AuditFile',
        'DsvPath','ServerPath','ExpectedApprovalId','ExpectedWindowId','ExpectedQualificationRunId','ExpectedTargetIdentity',
        'ExpectedControlRelease','ExpectedSubjectCommit','ExpectedRuntimePayloadSha256','ExpectedReleaseManifestSha256',
        'ObservedAtUtc','ExpiresAtUtc'
    )) { $arguments[$name] = Get-Variable -Name $name -ValueOnly }
    $observation = New-ReversibleCutoverObservation @arguments
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($OutputPath) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, (($observation | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, [IO.Path]::GetFullPath($OutputPath))
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    $observation | ConvertTo-Json -Depth 12 -Compress
    exit 0
}
catch {
    $code = if (Get-Command Get-ReversibleCutoverErrorCode -ErrorAction SilentlyContinue) { Get-ReversibleCutoverErrorCode $_.Exception } else { 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID' }
    [pscustomobject][ordered]@{ ok=$false; error=[pscustomobject][ordered]@{ code=$code } } | ConvertTo-Json -Compress
    exit 1
}
