[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageDirectory,
    [Parameter(Mandatory)][string]$ExpectedTag,
    [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleaseArchive.Common.ps1')

$result = Test-DysonReleasePackageDirectoryCore -PackageDirectory $PackageDirectory `
    -ExpectedTag $ExpectedTag -ExpectedCommit $ExpectedCommit
$result | ConvertTo-DysonArtifactJsonLine
