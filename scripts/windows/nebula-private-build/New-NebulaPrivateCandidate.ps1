[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][string]$BuildPlanPath,
    [Parameter(Mandatory)][string]$OfficialMainArchivePath,
    [Parameter(Mandatory)][string]$OfficialApiArchivePath,
    [Parameter(Mandatory)][string]$MetadataAPath,
    [Parameter(Mandatory)][string]$MetadataBPath,
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')

try {
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $planFile = Assert-NebulaPrivateJobPath -Path $BuildPlanPath -JobRoot $jobRoot
    $plan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json
    [void](Assert-NebulaPrivateBuildPlan -Plan $plan -RequestId $RequestId -JobRoot $jobRoot)

    $mainArchive = Assert-NebulaPrivateJobPath -Path $OfficialMainArchivePath -JobRoot $jobRoot
    $apiArchive = Assert-NebulaPrivateJobPath -Path $OfficialApiArchivePath -JobRoot $jobRoot
    $expectedMainArchive = Join-Path $jobRoot 'archives\official-nebula-v0.9.22.zip'
    $expectedApiArchive = Join-Path $jobRoot 'archives\official-nebula-api-v2.1.0.zip'
    if (-not $mainArchive.Equals([IO.Path]::GetFullPath($expectedMainArchive), [StringComparison]::OrdinalIgnoreCase) -or
        -not $apiArchive.Equals([IO.Path]::GetFullPath($expectedApiArchive), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OFFICIAL_ARCHIVE_PATH_INVALID'
    }

    $metadataAFile = Assert-NebulaPrivateJobPath -Path $MetadataAPath -JobRoot $jobRoot
    $metadataBFile = Assert-NebulaPrivateJobPath -Path $MetadataBPath -JobRoot $jobRoot
    $expectedMetadataA = Join-Path $jobRoot 'evidence\binary-metadata-a.json'
    $expectedMetadataB = Join-Path $jobRoot 'evidence\binary-metadata-b.json'
    if (-not $metadataAFile.Equals([IO.Path]::GetFullPath($expectedMetadataA), [StringComparison]::OrdinalIgnoreCase) -or
        -not $metadataBFile.Equals([IO.Path]::GetFullPath($expectedMetadataB), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_PATH_INVALID'
    }
    $metadataA = Get-Content -LiteralPath $metadataAFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadataB = Get-Content -LiteralPath $metadataBFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $harvestA = Join-Path $jobRoot 'harvest-a'
    $harvestB = Join-Path $jobRoot 'harvest-b'
    Assert-NebulaPrivateDeterministicBuilds -MetadataA $metadataA -MetadataB $metadataB `
        -HarvestRootA $harvestA -HarvestRootB $harvestB
    if ([string]$metadataA.build.buildPlanDigest -cne [string]$plan.previewDigest -or
        [string]$metadataB.build.buildPlanDigest -cne [string]$plan.previewDigest -or
        [string]$metadataA.build.inputFingerprintSha256 -cne [string]$plan.inputFingerprintSha256 -or
        [string]$metadataB.build.inputFingerprintSha256 -cne [string]$plan.inputFingerprintSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_BINDING_INVALID'
    }

    $extractMain = Join-Path $jobRoot 'extract-main'
    $extractApi = Join-Path $jobRoot 'extract-api'
    $baselineStage = Join-Path $jobRoot ('baseline.stage.' + $RequestId)
    $candidateStage = Join-Path $jobRoot ('candidate.stage.' + $RequestId)
    $baselineRoot = Join-Path $jobRoot 'baseline'
    $candidateRoot = Join-Path $jobRoot 'candidate'
    foreach ($path in @($extractMain,$extractApi,$baselineStage,$candidateStage,$baselineRoot,$candidateRoot)) {
        [void](Assert-NebulaPrivateJobPath -Path $path -JobRoot $jobRoot)
        if (Test-Path -LiteralPath $path) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OUTPUT_ALREADY_EXISTS' }
    }

    [void](Expand-NebulaPrivateZipExact -ArchivePath $mainArchive -DestinationRoot $extractMain `
        -PackageDirectory 'nebula-NebulaMultiplayerMod' -ExpectedRelativeFiles $script:NebulaPrivateMainFiles `
        -ExpectedArchiveSha256 ([string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256) -JobRoot $jobRoot)
    [void](Expand-NebulaPrivateZipExact -ArchivePath $apiArchive -DestinationRoot $extractApi `
        -PackageDirectory 'nebula-NebulaMultiplayerModApi' -ExpectedRelativeFiles $script:NebulaPrivateApiFiles `
        -ExpectedArchiveSha256 ([string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256) -JobRoot $jobRoot)

    [IO.Directory]::CreateDirectory($baselineStage) | Out-Null
    foreach ($relative in $script:NebulaPrivateExpectedFiles) {
        $sourceRoot = if ($relative.StartsWith('nebula-NebulaMultiplayerModApi/', [StringComparison]::Ordinal)) {
            $extractApi
        } else { $extractMain }
        $source = Join-Path $sourceRoot $relative.Replace('/', '\')
        $destination = Join-Path $baselineStage $relative.Replace('/', '\')
        [void](Copy-NebulaPrivateFileNew -Source $source -Destination $destination -JobRoot $jobRoot)
    }
    $baselineRecords = Get-NebulaPrivatePlainFiles -Root $baselineStage
    Assert-NebulaPrivateExactFileSet -Records $baselineRecords -Expected $script:NebulaPrivateExpectedFiles `
        -Code 'NEBULA_PRIVATE_BASELINE_FILE_SET_INVALID'
    $baselineTree = Get-NebulaPrivateTreeDigest -Records $baselineRecords
    if ($baselineTree -cne [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OFFICIAL_TREE_HASH_INVALID'
    }
    [IO.Directory]::Move($baselineStage, $baselineRoot)

    [IO.Directory]::CreateDirectory($candidateStage) | Out-Null
    foreach ($relative in $script:NebulaPrivateExpectedFiles) {
        $source = if ($relative -cin $script:NebulaPrivateCustomFiles) {
            Join-Path $harvestA $relative.Replace('/', '\')
        } else {
            Join-Path $baselineRoot $relative.Replace('/', '\')
        }
        $destination = Join-Path $candidateStage $relative.Replace('/', '\')
        [void](Copy-NebulaPrivateFileNew -Source $source -Destination $destination -JobRoot $jobRoot)
    }
    $treeResult = Assert-NebulaPrivateCandidateTrees -BaselineRoot $baselineRoot -CandidateRoot $candidateStage
    [IO.Directory]::Move($candidateStage, $candidateRoot)

    $candidateRecords = Get-NebulaPrivatePlainFiles -Root $candidateRoot
    $files = @($candidateRecords | ForEach-Object {
        [pscustomobject][ordered]@{
            path = [string]$_.path
            size = [int64]$_.size
            sha256 = [string]$_.sha256
            origin = if ([string]$_.path -cin $script:NebulaPrivateCustomFiles) { 'private-build' } else { 'official-stock' }
        }
    })
    $manifestCore = [ordered]@{
        protocol = $script:NebulaPrivateCandidateProtocol
        schemaVersion = 1
        source = [ordered]@{
            upstreamCommit = [string]$script:NebulaPrivateContract.upstream.commit
            websocketSubmoduleCommit = [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit
            sourceContractSha256 = [string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256 = [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
        }
        game = [ordered]@{
            gameVersion = [string]$script:NebulaPrivateContract.game.gameVersion
            gameLibVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            assemblyCSharpMvid = [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid
        }
        baseline = [ordered]@{
            mainArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256
            apiArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256
            sourceManifestSha256 = [string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256
            treeSha256 = [string]$treeResult.baselineTreeSha256
            treeDigestAlgorithm = [string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm
        }
        candidate = [ordered]@{
            treeSha256 = [string]$treeResult.candidateTreeSha256
            totalFiles = 44
            stockFilesExact = 40
            customFiles = 4
        }
        deterministicBuildEvidence = [ordered]@{
            buildPlanDigest = [string]$plan.previewDigest
            inputFingerprintSha256 = [string]$plan.inputFingerprintSha256
            metadataASha256 = Get-NebulaPrivateFileSha256 -Path $metadataAFile
            metadataBSha256 = Get-NebulaPrivateFileSha256 -Path $metadataBFile
            matched = $true
        }
        files = $files
    }
    $manifest = [ordered]@{}
    foreach ($key in $manifestCore.Keys) { $manifest[$key] = $manifestCore[$key] }
    $manifest.manifestDigest = Get-NebulaPrivateObjectSha256 -Value $manifestCore
    $manifestText = ConvertTo-NebulaPrivateCanonicalJson -Value $manifest
    Test-NebulaPrivatePublicText -Value $manifestText
    $manifestForValidation = $manifestText | ConvertFrom-Json
    [void](Assert-NebulaPrivateCandidateManifest -Manifest $manifestForValidation -CandidateRoot $candidateRoot)
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        $ManifestPath = Join-Path $jobRoot 'evidence\candidate-manifest.json'
    }
    [void](Write-NebulaPrivateJsonAtomic -Path $ManifestPath -Value $manifest -JobRoot $jobRoot)
    [pscustomobject][ordered]@{
        protocol = $script:NebulaPrivateCandidateProtocol
        candidateTreeSha256 = [string]$treeResult.candidateTreeSha256
        files = 44
        stockFilesExact = 40
        customFiles = 4
        manifestDigest = $manifest.manifestDigest
    } | ConvertTo-Json -Compress
}
catch {
    $code = Get-NebulaPrivateErrorCode -Exception $_.Exception
    [Console]::Error.WriteLine($code)
    exit 1
}
