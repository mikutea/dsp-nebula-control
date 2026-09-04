# Copyright (c) Dyson Control contributors.
# Creates one immutable, HMAC-protected PRD-001 side-by-side observation.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CapturePath,
    [Parameter(Mandatory)][string]$ExpectationPath,
    [Parameter(Mandatory)][string]$KeyPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Qualification.SideBySideV2.ps1')

$key = $null
try {
    $capture = Read-DysonSideBySideV2JsonFile -Path $CapturePath -MaximumBytes 1048576
    $expectation = Read-DysonSideBySideV2JsonFile -Path $ExpectationPath -MaximumBytes 131072
    [void](Assert-DysonSideBySideV2Expectation -Value $expectation)
    $key = Import-DysonSideBySideV2Key -Path $KeyPath -ExpectedKeyId ([string]$expectation.keyId)
    $observation = New-DysonSideBySideV2Observation -Capture $capture -Expectation $expectation -Key $key -NowUtc $NowUtc
    $written = Write-DysonSideBySideV2JsonCreateNew -Path $OutputPath -Value $observation
    [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_GENERATION_RESULT_V2'
        state = 'created'
        productionChanged = $false
        receiptId = [string]$observation.receiptId
        receiptSha256 = [string]$observation.receiptSha256
        observedAtUtc = [string]$observation.observationWindow.observedAtUtc
        expiresAtUtc = [string]$observation.observationWindow.expiresAtUtc
        outputFileName = [IO.Path]::GetFileName($written)
    } | ConvertTo-Json -Compress
}
catch {
    $code = Get-DysonSideBySideV2ErrorCode -Exception $_.Exception
    Write-Error -Message $code -ErrorAction Continue
    exit 1
}
finally {
    if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) }
}
