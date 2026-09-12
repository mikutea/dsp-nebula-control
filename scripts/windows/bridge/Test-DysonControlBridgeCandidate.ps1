[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidatePath,
    [Parameter(Mandatory)][string]$DysonServerRoot,
    [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

Test-DysonBridgeCandidateCore -CandidateRoot $CandidatePath -DysonServerRoot $DysonServerRoot `
    -ExpectedVersion $ExpectedVersion | ConvertTo-DysonBridgeJsonLine
