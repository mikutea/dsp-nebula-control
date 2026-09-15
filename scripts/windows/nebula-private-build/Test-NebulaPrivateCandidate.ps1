[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [string]$MetadataAPath,
    [string]$MetadataBPath,
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')

try {
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $baselineRoot = Join-Path $jobRoot 'baseline'
    $candidateRoot = Join-Path $jobRoot 'candidate'
    if ([string]::IsNullOrWhiteSpace($MetadataAPath)) { $MetadataAPath = Join-Path $jobRoot 'evidence\binary-metadata-a.json' }
    if ([string]::IsNullOrWhiteSpace($MetadataBPath)) { $MetadataBPath = Join-Path $jobRoot 'evidence\binary-metadata-b.json' }
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path $jobRoot 'evidence\candidate-manifest.json' }
    $metadataAFile = Assert-NebulaPrivateJobPath -Path $MetadataAPath -JobRoot $jobRoot
    $metadataBFile = Assert-NebulaPrivateJobPath -Path $MetadataBPath -JobRoot $jobRoot
    $manifestFile = Assert-NebulaPrivateJobPath -Path $ManifestPath -JobRoot $jobRoot
    foreach ($entry in @(
        @($metadataAFile, (Join-Path $jobRoot 'evidence\binary-metadata-a.json')),
        @($metadataBFile, (Join-Path $jobRoot 'evidence\binary-metadata-b.json')),
        @($manifestFile, (Join-Path $jobRoot 'evidence\candidate-manifest.json'))
    )) {
        if (-not ([IO.Path]::GetFullPath([string]$entry[0])).Equals([IO.Path]::GetFullPath([string]$entry[1]),
            [StringComparison]::OrdinalIgnoreCase)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_EVIDENCE_PATH_INVALID'
        }
    }
    $metadataA = Get-Content -LiteralPath $metadataAFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadataB = Get-Content -LiteralPath $metadataBFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-NebulaPrivateDeterministicBuilds -MetadataA $metadataA -MetadataB $metadataB `
        -HarvestRootA (Join-Path $jobRoot 'harvest-a') -HarvestRootB (Join-Path $jobRoot 'harvest-b')
    $tree = Assert-NebulaPrivateCandidateTrees -BaselineRoot $baselineRoot -CandidateRoot $candidateRoot
    if ([string]$tree.baselineTreeSha256 -cne [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OFFICIAL_TREE_HASH_INVALID'
    }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    [void](Assert-NebulaPrivateCandidateManifest -Manifest $manifest -CandidateRoot $candidateRoot)
    [pscustomobject][ordered]@{
        protocol = $script:NebulaPrivateCandidateProtocol
        result = 'qualified'
        baselineTreeSha256 = [string]$tree.baselineTreeSha256
        candidateTreeSha256 = [string]$tree.candidateTreeSha256
        files = 44
        stockFilesExact = 40
        customFiles = 4
        deterministicBuilds = $true
    } | ConvertTo-Json -Compress
}
catch {
    $code = Get-NebulaPrivateErrorCode -Exception $_.Exception
    [Console]::Error.WriteLine($code)
    exit 1
}
