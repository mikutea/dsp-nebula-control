# Copyright (c) Dyson Control contributors.
# Materializes a canonical read-only panel observation from already collected facts.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'PanelObservationV2.Common.ps1')

$inputValue = Read-DysonControlPanelObservationV2JsonFile -Path $InputPath
$observation = New-DysonControlPanelObservationV2 -InputValue $inputValue
$validation = Assert-DysonControlPanelObservationV2 -Observation $observation -NowUtc $NowUtc
$json = ConvertTo-DysonQualificationV2CanonicalJson -Value $observation
$fullOutputPath = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Path $fullOutputPath -Parent
if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container) -or
    [IO.Path]::GetExtension($fullOutputPath) -cne '.json') {
    Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_OUTPUT_INVALID'
}
$parentItem = Get-Item -LiteralPath $parent -Force
if ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_OUTPUT_INVALID'
}
if (Test-Path -LiteralPath $fullOutputPath) {
    Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_OUTPUT_EXISTS'
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
    if (Test-Path -LiteralPath $fullOutputPath) {
        Throw-DysonControlPanelObservationV2Error -Code 'DYSON_CONTROL_PANEL_OBSERVATION_V2_OUTPUT_EXISTS'
    }
    throw
}
finally {
    if ($null -ne $writer) { $writer.Dispose() }
    elseif ($null -ne $stream) { $stream.Dispose() }
}

[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_PANEL_OBSERVATION_GENERATOR_RESULT_V2'
    schemaVersion = 2
    qualified = [bool]$validation.qualified
    receiptId = [string]$validation.receiptId
    publicHost = [string]$validation.publicHost
    receiptSha256 = [string]$validation.receiptSha256
    outputPath = $fullOutputPath
    networkTouched = $false
    productionChanged = $false
} | ConvertTo-Json -Depth 4 -Compress
