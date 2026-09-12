[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleasePackaging.Common.ps1')

$result = Test-DysonControlReleaseArtifactCore -ArtifactRoot $ArtifactPath -ExpectedVersion $ExpectedVersion
$result | ConvertTo-DysonArtifactJsonLine
