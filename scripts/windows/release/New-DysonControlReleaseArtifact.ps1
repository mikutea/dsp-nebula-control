[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$RepositoryRoot,
    [string]$NpmExecutable = 'npm.cmd'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleasePackaging.Common.ps1')

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Join-Path $PSScriptRoot '..\..\..'
}

function Get-SelectedTreeFiles {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][ValidateSet('api', 'web')][string]$Kind
    )

    $selected = @()
    foreach ($file in @(Get-DysonArtifactPlainFiles -Root $SourceRoot)) {
        $relative = Get-DysonArtifactRelativePath -Root $SourceRoot -File $file.FullName
        $lower = $relative.ToLowerInvariant()
        if ($lower.EndsWith('.map')) { continue }
        $artifactRelative = "apps/$Kind/dist/$relative"
        if (Test-DysonArtifactRepositoryOnlyPath -RelativePath $artifactRelative) { continue }
        $selected += [ordered]@{ source = $file.FullName; relative = $relative }
    }
    return @($selected)
}

function Copy-SelectedFiles {
    param(
        [Parameter(Mandatory)]$Files,
        [Parameter(Mandatory)][string]$DestinationRoot
    )

    foreach ($file in @($Files)) {
        $destination = Get-DysonArtifactFullPath -Path (Join-Path $DestinationRoot ([string]$file.relative))
        if (-not (Test-DysonArtifactPathWithin -Candidate $destination -Parent $DestinationRoot)) {
            throw 'A selected release file escaped its destination root.'
        }
        [void](New-DysonArtifactDirectory -Path ([System.IO.Path]::GetDirectoryName($destination)))
        [System.IO.File]::Copy([string]$file.source, $destination, $false)
    }
}

function Resolve-DysonNpmExecutable {
    param([Parameter(Mandatory)][string]$Path)

    if ([System.IO.Path]::IsPathRooted($Path)) {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
    }
    else {
        $command = Get-Command $Path -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $resolved = $command.Source
    }
    if ([System.IO.Path]::GetFileName($resolved).ToLowerInvariant() -notin @('npm.cmd', 'npm.exe', 'npm')) {
        throw 'NpmExecutable must resolve to the npm executable.'
    }
    return $resolved
}

function Assert-SelectedFileAllowed {
    param(
        [Parameter(Mandatory)][string]$ArtifactRelativePath,
        [Parameter(Mandatory)][string]$SourcePath
    )

    Assert-DysonArtifactAllowedFile -RelativePath $ArtifactRelativePath -FullPath $SourcePath
}

function Remove-DysonNonRuntimeDependencyContent {
    param([Parameter(Mandatory)][string]$NodeModulesRoot)

    if (-not (Test-Path -LiteralPath $NodeModulesRoot -PathType Container)) { return 0 }
    $root = Assert-DysonArtifactPlainDirectory -Path $NodeModulesRoot
    [void](Get-DysonArtifactPlainFiles -Root $root)
    $nonRuntimeNames = @(
        '.github', '.cache', '__tests__', 'benchmark', 'benchmarks', 'coverage',
        'doc', 'docs', 'example', 'examples', 'fixture', 'fixtures', 'test', 'tests'
    )
    $directories = @(
        Get-ChildItem -LiteralPath $root -Directory -Recurse -Force -ErrorAction Stop |
            Where-Object { $_.Name.ToLowerInvariant() -in $nonRuntimeNames } |
            Sort-Object { $_.FullName.Length } -Descending
    )
    $removed = 0
    foreach ($directory in $directories) {
        if (-not (Test-Path -LiteralPath $directory.FullName)) { continue }
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            -not (Test-DysonArtifactPathWithin -Candidate $directory.FullName -Parent $root)) {
            throw 'Refusing to prune a redirected or out-of-root dependency directory.'
        }
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        $removed++
    }
    return $removed
}

Assert-DysonArtifactVersion -Version $Version
$repository = Assert-DysonArtifactPlainDirectory -Path $RepositoryRoot
$outputFull = Assert-DysonArtifactSafeRoot -Path $OutputPath -Name 'OutputPath'
if (Test-Path -LiteralPath $outputFull) { throw 'OutputPath already exists; release artifacts are never overwritten.' }
$outputParent = [System.IO.Path]::GetDirectoryName($outputFull)
if ([string]::IsNullOrWhiteSpace($outputParent)) { throw 'OutputPath must have a parent directory.' }

$apiDist = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'apps\api\dist')
$apiObservabilitySourceRoot = Assert-DysonArtifactPlainDirectory -Path `
    (Join-Path $repository 'apps\api\src\observability')
$webDist = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'apps\web\dist')
$windowsScripts = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'scripts\windows')
$configurationScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'configuration')
$gameBootstrapScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'bootstrap')
$cutoverScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'cutover')
$cutoverBrokerScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'cutover-broker')
$lifecycleBrokerScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'lifecycle-broker')
$dataRecoveryScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'data-recovery')
$networkScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'network')
$qualificationScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'qualification')
$migrationScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'migration')
$evidenceScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'evidence')
$bridgeSourceRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'integrations\dyson-control-bridge')
$hostnameWssSourceRoot = Assert-DysonArtifactPlainDirectory -Path `
    (Join-Path $repository 'integrations\nebula-hostname-wss')
$apiPackagePath = Join-Path $repository 'apps\api\package.json'
$apiLockPath = Join-Path $repository 'apps\api\package-lock.json'
$licensePath = Join-Path $repository 'LICENSE'
$hashPasswordTestPath = Join-Path $repository 'apps\api\src\cli\hash-password.test.ts'
$apiLifecycleFiles = @($script:DysonArtifactRequiredApiLifecycleFiles | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$apiHostnameWssRuntimeFiles = @($script:DysonArtifactRequiredApiHostnameWssRuntimeFiles | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$apiUpdateRuntimeFiles = @($script:DysonArtifactRequiredApiUpdateRuntimeFiles | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$migrationDocFiles = @($script:DysonArtifactRequiredMigrationDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$gsManagerRemovalDocFiles = @($script:DysonArtifactRequiredGsManagerRemovalDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$recoveryDocFiles = @($script:DysonArtifactRequiredRecoveryDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$networkDocFiles = @($script:DysonArtifactRequiredNetworkDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
$qualificationDocFiles = @($script:DysonArtifactRequiredQualificationDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
foreach ($requiredFile in @($apiPackagePath, $apiLockPath, $licensePath, $hashPasswordTestPath, (Join-Path $apiDist 'index.js'), (Join-Path $webDist 'index.html')) +
    @($apiLifecycleFiles | ForEach-Object { $_.source }) +
    @($apiHostnameWssRuntimeFiles | ForEach-Object { $_.source }) +
    @($apiUpdateRuntimeFiles | ForEach-Object { $_.source }) +
    @($script:DysonArtifactRequiredApiObservabilityRuntimeFiles | ForEach-Object {
        Join-Path $repository $_.Replace('/', '\')
    }) +
    @($script:DysonArtifactRequiredApiObservabilitySourceFiles | ForEach-Object {
        Join-Path $repository $_.Replace('/', '\')
    }) +
    @($script:DysonArtifactRequiredQualificationRuntimeFiles | ForEach-Object {
        Join-Path $repository $_.Replace('/', '\')
    }) +
    @($script:DysonArtifactRequiredNebulaHostnameWssSources | ForEach-Object {
        Join-Path $repository $_.Replace('/', '\')
    }) +
    @($migrationDocFiles | ForEach-Object { $_.source }) +
    @($gsManagerRemovalDocFiles | ForEach-Object { $_.source }) +
    @($recoveryDocFiles | ForEach-Object { $_.source }) +
    @($networkDocFiles | ForEach-Object { $_.source }) +
    @($qualificationDocFiles | ForEach-Object { $_.source })) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Required built release input is missing: $requiredFile" }
    $requiredItem = Get-Item -LiteralPath $requiredFile -Force -ErrorAction Stop
    if ($requiredItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Required release inputs cannot be redirected.' }
}
[void](Test-DysonArtifactPackageVersionBinding -ArtifactRoot $repository -ExpectedVersion $Version)
[void](Assert-DysonArtifactBridgeFixedReferenceContract `
    -ProjectPath (Join-Path $bridgeSourceRoot 'DysonControlBridge.csproj') `
    -CommonScriptPath (Join-Path $windowsScripts 'bridge\DysonBridge.Common.ps1'))

$observabilitySourcePrefixLength = 'apps/api/src/observability/'.Length
$expectedObservabilitySourceFiles = @($script:DysonArtifactRequiredApiObservabilitySourceFiles |
    ForEach-Object { $_.Substring($observabilitySourcePrefixLength) } |
    Sort-Object -CaseSensitive)
$actualObservabilitySourceFiles = @(Get-DysonArtifactPlainFiles -Root $apiObservabilitySourceRoot |
    ForEach-Object { Get-DysonArtifactRelativePath -Root $apiObservabilitySourceRoot -File $_.FullName } |
    Where-Object {
        $_.EndsWith('.ts', [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $_.EndsWith('.d.ts', [System.StringComparison]::OrdinalIgnoreCase) -and
        $_ -cnotmatch '\.(?:test|spec|fixture|fixtures)\.ts$'
    } | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualObservabilitySourceFiles) -cne
    [string]::Join("`n", $expectedObservabilitySourceFiles)) {
    throw 'The observability production source tree and fixed dist package are inconsistent.'
}

foreach ($sourceRoot in @($apiDist, $webDist, $windowsScripts, $bridgeSourceRoot)) {
    if ((Test-DysonArtifactPathWithin -Candidate $outputFull -Parent $sourceRoot -AllowEqual) -or
        (Test-DysonArtifactPathWithin -Candidate $sourceRoot -Parent $outputFull -AllowEqual)) {
        throw 'OutputPath cannot overlap a selected release source tree.'
    }
}

try { $apiPackage = [System.IO.File]::ReadAllText($apiPackagePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
catch { throw 'apps/api/package.json is invalid JSON.' }
if ($apiPackage.type -ne 'module' -or $apiPackage.main -ne 'dist/index.js') {
    throw 'The API package does not expose the expected production entry point.'
}
$devDependencies = [string[]]@(
    if ($apiPackage.devDependencies) {
        $apiPackage.devDependencies.PSObject.Properties | ForEach-Object { $_.Name }
    }
    else { @() }
)
[System.Array]::Sort($devDependencies, [System.StringComparer]::Ordinal)

$apiFiles = @(Get-SelectedTreeFiles -SourceRoot $apiDist -Kind api)
$webFiles = @(Get-SelectedTreeFiles -SourceRoot $webDist -Kind web)
if ($apiFiles.Count -eq 0 -or $webFiles.Count -eq 0) { throw 'The built API or web release input is empty.' }

$runtimeTopLevelScripts = @($script:DysonArtifactRequiredTopLevelWindowsScripts | ForEach-Object {
    [System.IO.Path]::GetFileName($_)
})
$runtimeReleaseScripts = @($script:DysonArtifactRequiredReleaseScripts | ForEach-Object {
    [System.IO.Path]::GetFileName($_)
})
$runtimeDeploymentScripts = @($script:DysonArtifactRequiredDeploymentScripts | ForEach-Object {
    [System.IO.Path]::GetFileName($_)
})
$runtimeConfigurationFiles = @($script:DysonArtifactRequiredConfigurationFiles)
$runtimeSessionScripts = @($script:DysonArtifactRequiredSessionScripts | ForEach-Object {
    [System.IO.Path]::GetFileName($_)
})
$runtimeMigrationScripts = @($script:DysonArtifactRequiredMigrationScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeGsManagerRemovalScripts = @($script:DysonArtifactRequiredGsManagerRemovalScripts | ForEach-Object {
    [System.IO.Path]::GetFileName($_)
})
$runtimeEvidenceScripts = @($script:DysonArtifactRequiredEvidenceScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeHostMutationScripts = @($script:DysonArtifactRequiredHostMutationScripts)
$runtimeGameBootstrapScripts = @($script:DysonArtifactRequiredGameBootstrapScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeCutoverScripts = @($script:DysonArtifactRequiredCutoverScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeCutoverBrokerScripts = @($script:DysonArtifactRequiredCutoverBrokerScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeLifecycleBrokerScripts = @($script:DysonArtifactRequiredLifecycleBrokerScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeDataRecoveryScripts = @($script:DysonArtifactRequiredDataRecoveryScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeNetworkFiles = @($script:DysonArtifactRequiredNetworkFiles)
$runtimeQualificationFiles = @($script:DysonArtifactRequiredQualificationRuntimeFiles)
$runtimeBridgeScripts = @($script:DysonArtifactRequiredBridgeScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$bridgeSourceFiles = @($script:DysonArtifactRequiredBridgeSources | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$scriptFiles = @()
foreach ($name in $runtimeTopLevelScripts) {
    $source = Join-Path $windowsScripts $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required Windows runtime script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/$name" }
}
foreach ($relative in $runtimeHostMutationScripts) {
    $name = [System.IO.Path]::GetFileName($relative)
    $source = Join-Path $repository $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required host-mutation lease script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = $relative }
}
foreach ($name in $runtimeGameBootstrapScripts) {
    $source = Join-Path $gameBootstrapScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required stable game bootstrap script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/bootstrap/$name" }
}
foreach ($name in $runtimeCutoverScripts) {
    $source = Join-Path $cutoverScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required cutover host script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/cutover/$name" }
}
foreach ($name in $runtimeCutoverBrokerScripts) {
    $source = Join-Path $cutoverBrokerScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required cutover broker script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/cutover-broker/$name" }
}
foreach ($name in $runtimeLifecycleBrokerScripts) {
    $source = Join-Path $lifecycleBrokerScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required lifecycle broker script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/lifecycle-broker/$name" }
}
foreach ($name in $runtimeDataRecoveryScripts) {
    $source = Join-Path $dataRecoveryScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required DataRoot recovery script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/data-recovery/$name" }
}
foreach ($relative in $runtimeNetworkFiles) {
    $source = Join-Path $repository $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required Nebula network assessment file is missing: $relative"
    }
    $scriptFiles += [ordered]@{ source = $source; relative = $relative }
}
foreach ($relative in $runtimeQualificationFiles) {
    $source = Join-Path $repository $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required qualification runtime file is missing: $relative"
    }
    $scriptFiles += [ordered]@{ source = $source; relative = $relative }
}
foreach ($name in $runtimeReleaseScripts) {
    $source = Join-Path (Join-Path $windowsScripts 'release') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required release verifier script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/release/$name" }
}
foreach ($name in $runtimeDeploymentScripts) {
    $source = Join-Path (Join-Path $windowsScripts 'deployment') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required deployment script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/deployment/$name" }
}
foreach ($relative in $runtimeConfigurationFiles) {
    $source = Join-Path $repository $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required protected configuration file is missing: $relative"
    }
    $scriptFiles += [ordered]@{ source = $source; relative = $relative }
}
foreach ($name in $runtimeSessionScripts) {
    $source = Join-Path (Join-Path $windowsScripts 'session') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required interactive-session script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/session/$name" }
}
foreach ($name in @($runtimeMigrationScripts + $runtimeGsManagerRemovalScripts)) {
    $source = Join-Path $migrationScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required GSManager migration script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/migration/$name" }
}
foreach ($name in $runtimeEvidenceScripts) {
    $source = Join-Path $evidenceScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required private acceptance evidence script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/evidence/$name" }
}
foreach ($name in $runtimeBridgeScripts) {
    $source = Join-Path (Join-Path $windowsScripts 'bridge') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required Bridge delivery script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/bridge/$name" }
}
$actualMigrationFiles = @(Get-DysonArtifactPlainFiles -Root $migrationScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $migrationScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedMigrationFiles = @(@($runtimeMigrationScripts + $runtimeGsManagerRemovalScripts) | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualMigrationFiles) -ne [string]::Join("`n", $expectedMigrationFiles)) {
    throw 'The GSManager migration source tree contains files outside its release allowlist.'
}
$actualEvidenceFiles = @(Get-DysonArtifactPlainFiles -Root $evidenceScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $evidenceScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedEvidenceFiles = @($runtimeEvidenceScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualEvidenceFiles) -ne [string]::Join("`n", $expectedEvidenceFiles)) {
    throw 'The private acceptance evidence source tree contains files outside its release allowlist.'
}
$actualCutoverFiles = @(Get-DysonArtifactPlainFiles -Root $cutoverScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $cutoverScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedCutoverFiles = @($runtimeCutoverScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualCutoverFiles) -ne [string]::Join("`n", $expectedCutoverFiles)) {
    throw 'The cutover host source tree contains files outside its release allowlist.'
}
$actualCutoverBrokerFiles = @(Get-DysonArtifactPlainFiles -Root $cutoverBrokerScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $cutoverBrokerScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedCutoverBrokerFiles = @($runtimeCutoverBrokerScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualCutoverBrokerFiles) -ne [string]::Join("`n", $expectedCutoverBrokerFiles)) {
    throw 'The cutover broker source tree contains files outside its release allowlist.'
}
$actualLifecycleBrokerFiles = @(Get-DysonArtifactPlainFiles -Root $lifecycleBrokerScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $lifecycleBrokerScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedLifecycleBrokerFiles = @($runtimeLifecycleBrokerScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualLifecycleBrokerFiles) -ne [string]::Join("`n", $expectedLifecycleBrokerFiles)) {
    throw 'The lifecycle broker source tree contains files outside its release allowlist.'
}
$actualDataRecoveryFiles = @(Get-DysonArtifactPlainFiles -Root $dataRecoveryScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $dataRecoveryScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedDataRecoveryFiles = @($runtimeDataRecoveryScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualDataRecoveryFiles) -ne [string]::Join("`n", $expectedDataRecoveryFiles)) {
    throw 'The DataRoot recovery source tree contains files outside its release allowlist.'
}
$actualConfigurationFiles = @(Get-DysonArtifactPlainFiles -Root $configurationScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $configurationScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$configurationPrefixLength = 'scripts/windows/configuration/'.Length
$expectedConfigurationFiles = @($runtimeConfigurationFiles | ForEach-Object {
    $_.Substring($configurationPrefixLength)
} | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualConfigurationFiles) -ne
    [string]::Join("`n", $expectedConfigurationFiles)) {
    throw 'The protected configuration source tree contains files outside its release allowlist.'
}
$actualNetworkFiles = @(Get-DysonArtifactPlainFiles -Root $networkScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $networkScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$networkPrefixLength = 'scripts/windows/network/'.Length
$expectedNetworkFiles = @($runtimeNetworkFiles | ForEach-Object {
    $_.Substring($networkPrefixLength)
} | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualNetworkFiles) -ne [string]::Join("`n", $expectedNetworkFiles)) {
    throw 'The Nebula network assessment source tree contains files outside its release allowlist.'
}
$hostnameWssFiles = @()
foreach ($relative in $script:DysonArtifactRequiredNebulaHostnameWssSources) {
    $source = Join-Path $repository $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required hostname-WSS source contract file is missing: $relative"
    }
    $hostnameWssFiles += [ordered]@{ source = $source; relative = $relative }
}
$actualHostnameWssFiles = @(Get-DysonArtifactPlainFiles -Root $hostnameWssSourceRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $hostnameWssSourceRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$hostnameWssPrefix = 'integrations/nebula-hostname-wss/'
$expectedHostnameWssFiles = @((
    $script:DysonArtifactRequiredNebulaHostnameWssSources +
    @($script:DysonArtifactRepositoryOnlyPaths | Where-Object {
        $_.StartsWith($hostnameWssPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
) | ForEach-Object { $_.Substring($hostnameWssPrefix.Length) } | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualHostnameWssFiles) -ne
    [string]::Join("`n", $expectedHostnameWssFiles)) {
    throw 'The hostname-WSS source contract tree contains files outside its exact release policy.'
}
$bridgeFiles = @()
foreach ($name in $bridgeSourceFiles) {
    $source = Join-Path $bridgeSourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required public Bridge source file is missing: $name" }
    $bridgeFiles += [ordered]@{ source = $source; relative = "integrations/dyson-control-bridge/$name" }
}
$actualBridgeSourceFiles = @(Get-DysonArtifactPlainFiles -Root $bridgeSourceRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $bridgeSourceRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$bridgeRepositoryOnlyPrefix = 'integrations/dyson-control-bridge/'
$bridgeRepositoryOnlyFiles = @($script:DysonArtifactRepositoryOnlyPaths | Where-Object {
    $_.StartsWith($bridgeRepositoryOnlyPrefix, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    $_.Substring($bridgeRepositoryOnlyPrefix.Length)
} | Sort-Object -CaseSensitive)
$actualBridgeContractFiles = @($actualBridgeSourceFiles | Where-Object {
    -not ($_.StartsWith('bin/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('obj/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('protocol-tests/bin/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('protocol-tests/obj/', [System.StringComparison]::Ordinal))
})
$actualGameBootstrapFiles = @(Get-DysonArtifactPlainFiles -Root $gameBootstrapScriptRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $gameBootstrapScriptRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$expectedGameBootstrapFiles = @($runtimeGameBootstrapScripts | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualGameBootstrapFiles) -ne [string]::Join("`n", $expectedGameBootstrapFiles)) {
    throw 'The stable game bootstrap source tree contains files outside its release allowlist.'
}
$expectedBridgeSourceFiles = @(@($bridgeSourceFiles + $bridgeRepositoryOnlyFiles) | Sort-Object -CaseSensitive)
if ([string]::Join("`n", $actualBridgeContractFiles) -ne [string]::Join("`n", $expectedBridgeSourceFiles)) {
    throw 'The public Bridge source tree contains files outside its release allowlist.'
}

$selected = @(
    $apiFiles | ForEach-Object {
        [ordered]@{ source = $_.source; relative = "apps/api/dist/$($_.relative)" }
    }
    $webFiles | ForEach-Object {
        [ordered]@{ source = $_.source; relative = "apps/web/dist/$($_.relative)" }
    }
    $scriptFiles
    $bridgeFiles
    $hostnameWssFiles
    $migrationDocFiles
    $gsManagerRemovalDocFiles
    $recoveryDocFiles
    $networkDocFiles
    $qualificationDocFiles
    [ordered]@{ source = $apiPackagePath; relative = 'apps/api/package.json' }
    [ordered]@{ source = $apiLockPath; relative = 'apps/api/package-lock.json' }
    [ordered]@{ source = $licensePath; relative = 'LICENSE' }
)
foreach ($file in $selected) {
    $item = Get-Item -LiteralPath ([string]$file.source) -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "A selected release file is redirected or not regular: $($file.relative)"
    }
    Assert-SelectedFileAllowed -ArtifactRelativePath ([string]$file.relative) -SourcePath $item.FullName
}
$selectedPaths = [string[]]@($selected | ForEach-Object { [string]$_.relative })
$selectedPathSet = @{}
foreach ($selectedPath in $selectedPaths) {
    if ($selectedPathSet.ContainsKey($selectedPath)) { throw 'The release selection contains duplicate target paths.' }
    $selectedPathSet[$selectedPath] = $true
}

$preview = [ordered]@{
    protocol = $script:DysonArtifactProtocol
    state = 'preview'
    dryRun = $true
    version = $Version
    outputPath = $outputFull
    entryPoint = $script:DysonArtifactEntryPoint
    builtApiFiles = $apiFiles.Count
    requiredApiLifecycleFiles = $apiLifecycleFiles.Count
    requiredApiHostnameWssRuntimeFiles = $apiHostnameWssRuntimeFiles.Count
    requiredApiUpdateRuntimeFiles = $apiUpdateRuntimeFiles.Count
    requiredApiObservabilityRuntimeFiles = $script:DysonArtifactRequiredApiObservabilityRuntimeFiles.Count
    builtWebFiles = $webFiles.Count
    runtimeWindowsScripts = $scriptFiles.Count
    hostMutationLeaseScripts = $runtimeHostMutationScripts.Count
    cutoverHostScripts = $runtimeCutoverScripts.Count
    cutoverBrokerScripts = $runtimeCutoverBrokerScripts.Count
    lifecycleBrokerScripts = $runtimeLifecycleBrokerScripts.Count
    dataRootRecoveryScripts = $runtimeDataRecoveryScripts.Count
    nebulaNetworkAssessmentFiles = $runtimeNetworkFiles.Count
    hostnameWssQualificationProtocolFiles = $script:DysonArtifactRequiredHostnameWssQualificationFiles.Count
    qualificationOrchestrationV2Files = $script:DysonArtifactRequiredQualificationOrchestrationV2Files.Count
    qualificationFrameworkFiles = $script:DysonArtifactRequiredQualificationFrameworkFiles.Count
    strictQualificationV2Files = $script:DysonArtifactRequiredStrictQualificationV2Files.Count
    qualificationRuntimeFiles = $runtimeQualificationFiles.Count
    hostnameWssSourceContractFiles = $hostnameWssFiles.Count
    gsManagerMigrationScripts = $runtimeMigrationScripts.Count
    gsManagerRemovalScripts = $runtimeGsManagerRemovalScripts.Count
    privateAcceptanceEvidenceScripts = $runtimeEvidenceScripts.Count
    migrationDocuments = $migrationDocFiles.Count
    gsManagerRemovalDocuments = $gsManagerRemovalDocFiles.Count
    recoveryDocuments = $recoveryDocFiles.Count
    networkDocuments = $networkDocFiles.Count
    qualificationDocuments = $qualificationDocFiles.Count
    publicBridgeSourceFiles = $bridgeFiles.Count
    bridgeSimulationTelemetryFiles = $script:DysonArtifactRequiredBridgeSimulationTelemetryFiles.Count
    privateBridgeDllPackaged = $false
    dependencyInstall = 'npm-ci-omit-dev-ignore-scripts'
    dependencyPruning = 'non-runtime-package-content-v1'
    sourceNodeModulesCopied = $false
    devDependenciesExcluded = $devDependencies
    productionChanged = $false
    rollback = 'remove-bounded-partial-directory; never overwrite an existing published artifact'
}
if (-not $PSCmdlet.ShouldProcess($outputFull, "build verified Dyson Control release artifact $Version")) {
    $preview | ConvertTo-DysonArtifactJsonLine
    exit 0
}

$npmPath = Resolve-DysonNpmExecutable -Path $NpmExecutable
[void](New-DysonArtifactDirectory -Path $outputParent)
$temporaryToken = [Convert]::ToBase64String([guid]::NewGuid().ToByteArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$temporaryRoot = Join-Path $outputParent ('.p-' + $temporaryToken)
if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent)) {
    throw 'The temporary artifact directory escaped OutputPath parent.'
}
$published = $false
try {
    [void](New-DysonArtifactDirectory -Path $temporaryRoot)
    Copy-SelectedFiles -Files $selected -DestinationRoot $temporaryRoot

    $apiTarget = Join-Path $temporaryRoot 'apps\api'
    $npmExitCode = $null
    Push-Location -LiteralPath $apiTarget
    try {
        $npmOutput = & $npmPath 'ci' '--omit=dev' '--ignore-scripts' '--no-audit' '--no-fund' `
            '--loglevel=error' '--prefix' $apiTarget 2>&1
        $npmExitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
    if ($npmExitCode -ne 0) { throw 'npm ci failed while assembling production-only API dependencies.' }
    $npmInternalLock = Join-Path $apiTarget 'node_modules\.package-lock.json'
    if (Test-Path -LiteralPath $npmInternalLock -PathType Leaf) { Remove-Item -LiteralPath $npmInternalLock -Force }
    $prunedDependencyDirectories = Remove-DysonNonRuntimeDependencyContent -NodeModulesRoot (Join-Path $apiTarget 'node_modules')

    $manifest = Write-DysonArtifactManifest -ArtifactRoot $temporaryRoot -Version $Version -DevDependenciesExcluded $devDependencies
    $verified = Test-DysonControlReleaseArtifactCore -ArtifactRoot $temporaryRoot -ExpectedVersion $Version
    [System.IO.Directory]::Move($temporaryRoot, $outputFull)
    $published = $true
    [ordered]@{
        protocol = $script:DysonArtifactProtocol
        state = 'created'
        version = $Version
        outputPath = $outputFull
        entryPoint = $verified.entryPoint
        payloadSha256 = $manifest.payloadSha256
        fileCount = $manifest.fileCount
        totalBytes = $manifest.totalBytes
        productionOnlyNodeModules = $true
        prunedDependencyDirectories = $prunedDependencyDirectories
        deploymentSourceCompatible = $true
        packageLockManifestVersionBound = $true
        coreWindowsRuntimeAllowlistVerified = $true
        publicBridgeSourcePackaged = $true
        bridgeSimulationTelemetryPackaged = $true
        bridgeFixedReferenceContractPackaged = $true
        privateBridgeBinariesPackaged = $false
        gameRuntimeReceiptApiPackaged = $true
        hostnameWssClientQualificationApiPackaged = $true
        observabilityRuntimeApiPackaged = $true
        windowsUpdateRuntimeApiPackaged = $true
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
        gsManagerRecoverableRemovalPackaged = $true
        gsManagerRemovalDocumentationPackaged = $true
        privateAcceptanceEvidenceToolingPackaged = $true
        hostMutationLeaseToolingPackaged = $true
        stableGameBootstrapPackaged = $true
        cutoverHostToolingPackaged = $true
        cutoverBrokerToolingPackaged = $true
        lifecycleBrokerToolingPackaged = $true
        dataRootRecoveryToolingPackaged = $true
        dataRootRecoveryDocumentationPackaged = $true
        nebulaNetworkAssessmentPackaged = $true
        hostnameWssQualificationRuntimePackaged = $true
        qualificationOrchestrationV2Packaged = $true
        qualificationFrameworkPackaged = $true
        strictQualificationV2Packaged = $true
        productionQualificationDocumentationPackaged = $true
        networkConnectivityDocumentationPackaged = $true
        productionChanged = $false
    } | ConvertTo-DysonArtifactJsonLine
}
finally {
    if (-not $published -and (Test-Path -LiteralPath $temporaryRoot)) {
        if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent) -or
            [System.IO.Path]::GetFileName($temporaryRoot) -cnotmatch '^\.p-[A-Za-z0-9_-]{22}$') {
            throw 'Refusing to clean an unexpected artifact path.'
        }
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
