# Copyright (c) Dyson Control contributors.
# Strictly verifies one PRD-001 observation against an independently supplied expectation.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ObservationPath,
    [Parameter(Mandatory)][string]$ExpectationPath,
    [Parameter(Mandatory)][string]$KeyPath,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Qualification.SideBySideV2.ps1')

$key = $null
try {
    $observation = Read-DysonSideBySideV2JsonFile -Path $ObservationPath -MaximumBytes 1048576
    $expectation = Read-DysonSideBySideV2JsonFile -Path $ExpectationPath -MaximumBytes 131072
    [void](Assert-DysonSideBySideV2Expectation -Value $expectation)
    $key = Import-DysonSideBySideV2Key -Path $KeyPath -ExpectedKeyId ([string]$expectation.keyId)
    Assert-DysonSideBySideV2Observation -Observation $observation -Expectation $expectation -Key $key -NowUtc $NowUtc |
        ConvertTo-Json -Compress
}
catch {
    $code = Get-DysonSideBySideV2ErrorCode -Exception $_.Exception
    Write-Error -Message $code -ErrorAction Continue
    exit 1
}
finally {
    if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) }
}
