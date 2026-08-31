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
        if ($Kind -eq 'api' -and ($lower -match '(^|/)[^/]+\.(test|spec)\.js$' -or
            $lower.StartsWith('cli/') -or $lower.StartsWith('unused/'))) { continue }
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
$webDist = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'apps\web\dist')
$windowsScripts = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'scripts\windows')
$migrationScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'migration')
$evidenceScriptRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $windowsScripts 'evidence')
$bridgeSourceRoot = Assert-DysonArtifactPlainDirectory -Path (Join-Path $repository 'integrations\dyson-control-bridge')
$apiPackagePath = Join-Path $repository 'apps\api\package.json'
$apiLockPath = Join-Path $repository 'apps\api\package-lock.json'
$licensePath = Join-Path $repository 'LICENSE'
$migrationDocFiles = @($script:DysonArtifactRequiredMigrationDocs | ForEach-Object {
    [ordered]@{ source = Join-Path $repository $_.Replace('/', '\'); relative = $_ }
})
foreach ($requiredFile in @($apiPackagePath, $apiLockPath, $licensePath, (Join-Path $apiDist 'index.js'), (Join-Path $webDist 'index.html')) + @($migrationDocFiles | ForEach-Object { $_.source })) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Required built release input is missing: $requiredFile" }
    $requiredItem = Get-Item -LiteralPath $requiredFile -Force -ErrorAction Stop
    if ($requiredItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Required release inputs cannot be redirected.' }
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

$runtimeTopLevelScripts = @(
    'Get-DysonLifecyclePreflight.ps1',
    'Get-DysonManagedPluginVersion.ps1',
    'Get-DysonStatus.ps1',
    'Install-DysonRuntimeTasks.ps1',
    'Invoke-DysonScheduledTask.ps1',
    'New-DysonSaveProtectionPoint.ps1',
    'Start-DysonServer.ps1',
    'Stop-DysonServer.ps1',
    'Test-DysonRuntimeState.ps1'
)
$runtimeReleaseScripts = @(
    'DysonReleasePackaging.Common.ps1',
    'Test-DysonControlReleaseArtifact.ps1'
)
$runtimeDeploymentScripts = @(
    'DysonDeployment.Common.ps1',
    'Install-DysonControl.ps1',
    'Install-DysonControlTask.ps1',
    'Invoke-DysonControlDeployment.ps1',
    'Start-DysonControl.ps1',
    'Test-DysonControlDeployment.ps1',
    'Uninstall-DysonControl.ps1'
)
$runtimeSessionScripts = @(
    'Configure-DysonInteractiveSession.ps1',
    'Disable-DysonInteractiveSession.ps1',
    'DysonSession.Common.ps1',
    'Test-DysonInteractiveSession.ps1'
)
$runtimeMigrationScripts = @($script:DysonArtifactRequiredMigrationScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeEvidenceScripts = @($script:DysonArtifactRequiredEvidenceScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$runtimeBridgeScripts = @($script:DysonArtifactRequiredBridgeScripts | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$bridgeSourceFiles = @($script:DysonArtifactRequiredBridgeSources | ForEach-Object { [System.IO.Path]::GetFileName($_) })
$scriptFiles = @()
foreach ($name in $runtimeTopLevelScripts) {
    $source = Join-Path $windowsScripts $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required Windows runtime script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/$name" }
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
foreach ($name in $runtimeSessionScripts) {
    $source = Join-Path (Join-Path $windowsScripts 'session') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required interactive-session script is missing: $name" }
    $scriptFiles += [ordered]@{ source = $source; relative = "scripts/windows/session/$name" }
}
foreach ($name in $runtimeMigrationScripts) {
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
$expectedMigrationFiles = @($runtimeMigrationScripts | Sort-Object -CaseSensitive)
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
$bridgeFiles = @()
foreach ($name in $bridgeSourceFiles) {
    $source = Join-Path $bridgeSourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required public Bridge source file is missing: $name" }
    $bridgeFiles += [ordered]@{ source = $source; relative = "integrations/dyson-control-bridge/$name" }
}
$actualBridgeSourceFiles = @(Get-DysonArtifactPlainFiles -Root $bridgeSourceRoot | ForEach-Object {
    Get-DysonArtifactRelativePath -Root $bridgeSourceRoot -File $_.FullName
} | Sort-Object -CaseSensitive)
$bridgeRepositoryOnlyFiles = @(
    'protocol-tests/DysonControlBridge.ProtocolTests.csproj',
    'protocol-tests/Program.cs'
)
$actualBridgeContractFiles = @($actualBridgeSourceFiles | Where-Object {
    -not ($_.StartsWith('bin/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('obj/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('protocol-tests/bin/', [System.StringComparison]::Ordinal) -or
        $_.StartsWith('protocol-tests/obj/', [System.StringComparison]::Ordinal))
})
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
    $migrationDocFiles
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
    builtWebFiles = $webFiles.Count
    runtimeWindowsScripts = $scriptFiles.Count
    gsManagerMigrationScripts = $runtimeMigrationScripts.Count
    privateAcceptanceEvidenceScripts = $runtimeEvidenceScripts.Count
    migrationDocuments = $migrationDocFiles.Count
    publicBridgeSourceFiles = $bridgeFiles.Count
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
$temporaryRoot = Join-Path $outputParent ('.partial-dyson-control-' + [guid]::NewGuid().ToString('N'))
if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent)) {
    throw 'The temporary artifact directory escaped OutputPath parent.'
}
$published = $false
try {
    [void](New-DysonArtifactDirectory -Path $temporaryRoot)
    Copy-SelectedFiles -Files $selected -DestinationRoot $temporaryRoot

    $apiTarget = Join-Path $temporaryRoot 'apps\api'
    $npmOutput = & $npmPath 'ci' '--omit=dev' '--ignore-scripts' '--no-audit' '--no-fund' '--loglevel=error' '--prefix' $apiTarget 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while assembling production-only API dependencies.' }
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
        publicBridgeSourcePackaged = $true
        privateBridgeBinariesPackaged = $false
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
        privateAcceptanceEvidenceToolingPackaged = $true
        productionChanged = $false
    } | ConvertTo-DysonArtifactJsonLine
}
finally {
    if (-not $published -and (Test-Path -LiteralPath $temporaryRoot)) {
        if (-not (Test-DysonArtifactPathWithin -Candidate $temporaryRoot -Parent $outputParent) -or
            -not ([System.IO.Path]::GetFileName($temporaryRoot).StartsWith('.partial-dyson-control-', [System.StringComparison]::Ordinal))) {
            throw 'Refusing to clean an unexpected artifact path.'
        }
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
