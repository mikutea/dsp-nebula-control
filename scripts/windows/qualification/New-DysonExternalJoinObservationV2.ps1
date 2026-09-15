# Copyright (c) Dyson Control contributors.
# Creates one canonical external-join observation from pre-collected facts.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'ExternalJoinObservationV2.Common.ps1')

$inputValue = Read-DysonExternalJoinObservationV2JsonFile -Path $InputPath
$observation = New-DysonExternalJoinObservationV2 -InputValue $inputValue
$validation = Assert-DysonExternalJoinObservationV2 -Observation $observation -NowUtc $NowUtc
$json = ConvertTo-DysonQualificationV2CanonicalJson -Value $observation
$fullOutputPath = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Path $fullOutputPath -Parent
if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container) -or [IO.Path]::GetExtension($fullOutputPath) -cne '.json') {
    Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_OUTPUT_INVALID'
}
$parentItem = Get-Item -LiteralPath $parent -Force
if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath $fullOutputPath)) {
    $outputCode = if (Test-Path -LiteralPath $fullOutputPath) { 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_OUTPUT_EXISTS' } else { 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_OUTPUT_INVALID' }
    Throw-DysonExternalJoinObservationV2Error -Code $outputCode
}
$stream = $null
$writer = $null
try {
    $stream = New-Object IO.FileStream -ArgumentList $fullOutputPath, ([IO.FileMode]::CreateNew), ([IO.FileAccess]::Write), ([IO.FileShare]::None)
    $writer = New-Object IO.StreamWriter -ArgumentList $stream, (New-Object Text.UTF8Encoding -ArgumentList $false)
    $writer.Write($json)
    $writer.Flush()
    $stream.Flush($true)
}
catch {
    if (Test-Path -LiteralPath $fullOutputPath) { Throw-DysonExternalJoinObservationV2Error -Code 'DYSON_EXTERNAL_JOIN_OBSERVATION_V2_OUTPUT_EXISTS' }
    throw
}
finally {
    if ($null -ne $writer) { $writer.Dispose() }
    elseif ($null -ne $stream) { $stream.Dispose() }
}

[pscustomobject][ordered]@{
    protocol = 'DYSON_EXTERNAL_JOIN_OBSERVATION_GENERATOR_RESULT_V2'
    schemaVersion = 2
    qualified = [bool]$validation.qualified
    observationId = [string]$validation.observationId
    publicHost = [string]$validation.publicHost
    eventCount = @($observation.events).Count
    observationSha256 = [string]$validation.observationSha256
    outputPath = $fullOutputPath
    networkTouched = $false
    productionChanged = $false
} | ConvertTo-Json -Depth 4 -Compress
