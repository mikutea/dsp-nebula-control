[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$Commit,
    [Parameter(Mandatory)][string]$NodeVersion
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleaseArchive.Common.ps1')

$version = Assert-DysonReleaseTag -Tag $Tag
Assert-DysonReleaseCommit -Commit $Commit
Assert-DysonReleaseNodeVersion -NodeVersion $NodeVersion
$artifactRoot = Assert-DysonArtifactPlainDirectory -Path $ArtifactPath
$outputFull = Assert-DysonArtifactSafeRoot -Path $OutputDirectory -Name 'OutputDirectory'
if (Test-Path -LiteralPath $outputFull) { throw 'OutputDirectory already exists; release packages are never overwritten.' }
if ((Test-DysonArtifactPathWithin -Candidate $outputFull -Parent $artifactRoot -AllowEqual) -or
    (Test-DysonArtifactPathWithin -Candidate $artifactRoot -Parent $outputFull -AllowEqual)) {
    throw 'OutputDirectory cannot overlap the verified artifact.'
}
$outputParent = [System.IO.Path]::GetDirectoryName($outputFull)
if ([string]::IsNullOrWhiteSpace($outputParent)) { throw 'OutputDirectory must have a parent directory.' }

$artifactVerification = Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version
$manifest = Read-DysonArtifactManifest -ArtifactRoot $artifactRoot
$assetNames = Get-DysonReleaseAssetNames -Tag $Tag
$preview = [ordered]@{
    protocol = $script:DysonReleasePackageProtocol
    state = 'preview'
    dryRun = $true
    tag = $Tag
    commit = $Commit
    artifactVersion = $version
    artifactPayloadSha256 = [string]$artifactVerification.payloadSha256
    archiveName = [string]$assetNames.archive
    checksumName = [string]$assetNames.checksum
    provenanceName = [string]$assetNames.provenance
    overwrite = $false
    productionChanged = $false
}
if (-not $PSCmdlet.ShouldProcess($outputFull, "create deterministic release package for $Tag")) {
    $preview | ConvertTo-DysonArtifactJsonLine
    exit 0
}

[void](New-DysonArtifactDirectory -Path $outputParent)
$temporaryRoot = Join-Path $outputParent ('.partial-dyson-release-package-' + [guid]::NewGuid().ToString('N'))
if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent)) {
    throw 'The temporary package directory escaped OutputDirectory parent.'
}
$published = $false
try {
    [void](New-DysonArtifactDirectory -Path $temporaryRoot)
    $archivePath = Join-Path $temporaryRoot $assetNames.archive
    $archiveResult = Write-DysonDeterministicReleaseArchive -ArtifactRoot $artifactRoot -Manifest $manifest -ArchivePath $archivePath

    $postArchiveVerification = Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version
    if (-not [string]::Equals([string]$postArchiveVerification.payloadSha256, [string]$artifactVerification.payloadSha256, [System.StringComparison]::Ordinal) -or
        [int]$postArchiveVerification.fileCount -ne [int]$artifactVerification.fileCount -or
        [int64]$postArchiveVerification.totalBytes -ne [int64]$artifactVerification.totalBytes) {
        throw 'The verified artifact changed during release packaging.'
    }

    $provenance = New-DysonReleaseProvenance -Tag $Tag -Commit $Commit -NodeVersion $NodeVersion `
        -ArtifactVerification $artifactVerification -ArchiveName $assetNames.archive -ArchiveResult $archiveResult
    $provenanceJson = $provenance | ConvertTo-Json -Depth 12 -Compress
    [System.IO.File]::WriteAllText(
        (Join-Path $temporaryRoot $assetNames.provenance),
        $provenanceJson,
        [System.Text.UTF8Encoding]::new($false)
    )
    $checksumLine = "{0}  {1}`n" -f ([string]$archiveResult.sha256), ([string]$assetNames.archive)
    [System.IO.File]::WriteAllText(
        (Join-Path $temporaryRoot $assetNames.checksum),
        $checksumLine,
        [System.Text.ASCIIEncoding]::new()
    )

    [void](Test-DysonReleasePackageDirectoryCore -PackageDirectory $temporaryRoot -ExpectedTag $Tag -ExpectedCommit $Commit)
    [System.IO.Directory]::Move($temporaryRoot, $outputFull)
    $published = $true
    [ordered]@{
        protocol = $script:DysonReleasePackageProtocol
        state = 'created'
        tag = $Tag
        commit = $Commit
        artifactVersion = $version
        artifactPayloadSha256 = [string]$artifactVerification.payloadSha256
        archiveName = [string]$assetNames.archive
        archiveSha256 = [string]$archiveResult.sha256
        archiveBytes = [int64]$archiveResult.bytes
        checksumName = [string]$assetNames.checksum
        provenanceName = [string]$assetNames.provenance
        deterministic = $true
        productionChanged = $false
    } | ConvertTo-DysonArtifactJsonLine
}
finally {
    if (-not $published -and (Test-Path -LiteralPath $temporaryRoot)) {
        if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent) -or
            -not ([System.IO.Path]::GetFileName($temporaryRoot).StartsWith('.partial-dyson-release-package-', [System.StringComparison]::Ordinal))) {
            throw 'Refusing to clean an unexpected package path.'
        }
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
