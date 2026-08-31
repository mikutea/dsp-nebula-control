Set-StrictMode -Version 2.0

$script:DysonArtifactProtocol = 'DYSON_CONTROL_RELEASE_ARTIFACT_V1'
$script:DysonArtifactManifestName = 'artifact-manifest.json'
$script:DysonArtifactEntryPoint = 'apps/api/dist/index.js'
$script:DysonArtifactMaximumFiles = 50000
$script:DysonArtifactMaximumBytes = [int64](2GB)
$script:DysonArtifactRequiredBridgeSources = @(
    'integrations/dyson-control-bridge/BridgeFileStore.cs',
    'integrations/dyson-control-bridge/BridgeProtocol.cs',
    'integrations/dyson-control-bridge/DysonControlBridge.csproj',
    'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
    'integrations/dyson-control-bridge/GameSaveAdapter.cs',
    'integrations/dyson-control-bridge/PlayerRosterPublisher.cs',
    'integrations/dyson-control-bridge/README.md',
    'integrations/dyson-control-bridge/dyson-control-bridge.cfg.example'
)
$script:DysonArtifactRequiredBridgeScripts = @(
    'scripts/windows/bridge/Build-DysonControlBridgeCandidate.ps1',
    'scripts/windows/bridge/DysonBridge.Common.ps1',
    'scripts/windows/bridge/Install-DysonControlBridge.ps1',
    'scripts/windows/bridge/Test-DysonControlBridgeCandidate.ps1',
    'scripts/windows/bridge/Test-DysonControlBridgeInstallation.ps1',
    'scripts/windows/bridge/Uninstall-DysonControlBridge.ps1'
)
$script:DysonArtifactRequiredMigrationScripts = @(
    'scripts/windows/migration/DysonGsManagerMigration.Common.ps1',
    'scripts/windows/migration/Get-DysonGsManagerMigration.ps1',
    'scripts/windows/migration/New-DysonGsManagerSnapshot.ps1',
    'scripts/windows/migration/Restore-DysonGsManagerSnapshot.ps1',
    'scripts/windows/migration/SelfTest-DysonGsManagerMigration.ps1',
    'scripts/windows/migration/Test-DysonGsManagerSnapshot.ps1'
)
$script:DysonArtifactRequiredMigrationDocs = @(
    'docs/GSM-EVALUATION.md',
    'docs/WINDOWS-DEPLOYMENT-DRAFT.md'
)

function ConvertTo-DysonArtifactJsonLine {
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)

    process { return $Value | ConvertTo-Json -Depth 12 -Compress }
}

function Get-DysonArtifactFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An artifact path cannot be empty.' }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Assert-DysonArtifactVersion {
    param([Parameter(Mandatory)][string]$Version)

    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
        throw 'The artifact version must contain only letters, numbers, dot, underscore, plus, or hyphen.'
    }
}

function Assert-DysonArtifactSafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $full = Get-DysonArtifactFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $full
}

function Test-DysonArtifactPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonArtifactFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonArtifactFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonArtifactPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Artifact directory is unavailable or redirected: $Path"
    }
    return $item.FullName
}

function New-DysonArtifactDirectory {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    return Assert-DysonArtifactPlainDirectory -Path $Path
}

function Assert-DysonArtifactRelativePath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or [System.IO.Path]::IsPathRooted($Path) -or
        $Path -match '(^|[\/])\.\.([\/]|$)' -or $Path.IndexOf([char]0) -ge 0 -or $Path -match '["\r\n]') {
        throw 'Artifact inventory paths must be bounded and relative.'
    }
}

function Get-DysonArtifactRelativePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$File
    )

    $rootFull = (Get-DysonArtifactFullPath -Path $Root).TrimEnd('\', '/')
    $fileFull = Get-DysonArtifactFullPath -Path $File
    if (-not (Test-DysonArtifactPathWithin -Candidate $fileFull -Parent $rootFull)) {
        throw 'An artifact file escaped its expected root.'
    }
    $relative = $fileFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
    Assert-DysonArtifactRelativePath -Path $relative
    return $relative
}

function Get-DysonArtifactPlainFiles {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonArtifactPlainDirectory -Path $Root
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
    $pending.Push($rootFull)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Release artifacts cannot contain reparse points: $($item.Name)"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            elseif ($item -is [System.IO.FileInfo]) { $files.Add($item) }
            else { throw "Unsupported artifact filesystem entry: $($item.Name)" }
        }
    }
    return @($files)
}

function Get-DysonArtifactFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::Open(
        (Get-DysonArtifactFullPath -Path $Path),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Assert-DysonArtifactAllowedFile {
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$FullPath
    )

    Assert-DysonArtifactRelativePath -Path $RelativePath
    $normalized = $RelativePath.Replace('\', '/')
    $lower = $normalized.ToLowerInvariant()
    $segments = @($lower.Split('/'))
    $name = $segments[$segments.Count - 1]
    $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()

    if ($name -eq '.env' -or $name.StartsWith('.env.') -or
        $name -in @('credentials.json', 'id_rsa', 'id_ed25519') -or
        $extension -in @('.log', '.dsv', '.server', '.bak', '.backup', '.zip')) {
        throw "A forbidden secret, log, save, or archive file entered the artifact: $RelativePath"
    }
    if ($segments[0] -in @('.git', 'data', 'logs', 'userdata', 'server', 'steam', 'steamapps', 'coverage', 'screenshots')) {
        throw "A forbidden mutable top-level directory entered the artifact: $RelativePath"
    }
    $nodeModuleIndexes = for ($index = 0; $index -lt $segments.Count; $index++) {
        if ($segments[$index] -eq 'node_modules') { $index }
    }
    if (@($nodeModuleIndexes).Count -gt 0 -and
        -not ($segments.Count -ge 4 -and $segments[0] -eq 'apps' -and $segments[1] -eq 'api' -and $segments[2] -eq 'node_modules')) {
        throw "node_modules is allowed only for API production dependencies: $RelativePath"
    }
    if ($lower -eq $script:DysonArtifactManifestName -or $lower -eq 'release-manifest.json') {
        throw 'Input payloads cannot provide packaging or deployment manifests.'
    }

    $allowedBridgeSources = @($script:DysonArtifactRequiredBridgeSources | ForEach-Object { $_.ToLowerInvariant() })
    $allowedBridgeScripts = @($script:DysonArtifactRequiredBridgeScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedMigrationScripts = @($script:DysonArtifactRequiredMigrationScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedMigrationDocs = @($script:DysonArtifactRequiredMigrationDocs | ForEach-Object { $_.ToLowerInvariant() })
    if ($lower.StartsWith('integrations/dyson-control-bridge/') -and $lower -notin $allowedBridgeSources) {
        throw "The public Bridge source package contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/bridge/') -and $lower -notin $allowedBridgeScripts) {
        throw "The Bridge delivery tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/migration/') -and $lower -notin $allowedMigrationScripts) {
        throw "The GSManager migration tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('docs/') -and $lower -notin $allowedMigrationDocs) {
        throw "The release documentation contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('integrations/dyson-control-bridge/') -and $extension -in @('.dll', '.pdb', '.exe')) {
        throw "A compiled or proprietary assembly entered the public Bridge source package: $RelativePath"
    }

    $allowed = $lower -eq 'license' -or $lower.StartsWith('license.') -or
        $lower -eq 'notice' -or $lower.StartsWith('notice.') -or
        $lower -eq 'apps/api/package.json' -or $lower -eq 'apps/api/package-lock.json' -or
        $lower.StartsWith('apps/api/dist/') -or $lower.StartsWith('apps/api/node_modules/') -or
        $lower.StartsWith('apps/web/dist/') -or $lower.StartsWith('scripts/windows/') -or
        $lower -in $allowedBridgeSources -or $lower -in $allowedMigrationDocs
    if (-not $allowed) { throw "The artifact contains a path outside the release allowlist: $RelativePath" }

    $textExtensions = @('.js', '.json', '.ps1', '.cs', '.csproj', '.cfg', '.example', '.html', '.css', '.txt', '.md', '.xml', '.yml', '.yaml', '.pem', '.key')
    $fileInfo = Get-Item -LiteralPath $FullPath -Force -ErrorAction Stop
    if ($textExtensions -contains $extension -and $fileInfo.Length -le 2MB) {
        $content = [System.IO.File]::ReadAllText($fileInfo.FullName, [System.Text.Encoding]::UTF8)
        if ($content -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' -or
            $content -match '(?m)^\s*DYSON_(?:SESSION_SECRET|ADMIN_PASSWORD_HASH)\s*=') {
            throw "Secret material entered the release artifact: $RelativePath"
        }
    }
}

function Get-DysonArtifactInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonArtifactPlainDirectory -Path $Root
    $byPath = @{}
    $totalBytes = [int64]0
    foreach ($file in @(Get-DysonArtifactPlainFiles -Root $rootFull)) {
        $relative = Get-DysonArtifactRelativePath -Root $rootFull -File $file.FullName
        if ([string]::Equals($relative, $script:DysonArtifactManifestName, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        Assert-DysonArtifactAllowedFile -RelativePath $relative -FullPath $file.FullName
        if ($byPath.ContainsKey($relative)) { throw "Duplicate artifact path: $relative" }
        $totalBytes += [int64]$file.Length
        if ($totalBytes -gt $script:DysonArtifactMaximumBytes) { throw 'The release artifact exceeds its size limit.' }
        $byPath[$relative] = [ordered]@{
            path = $relative
            length = [int64]$file.Length
            sha256 = Get-DysonArtifactFileSha256 -Path $file.FullName
        }
    }
    if ($byPath.Count -eq 0) { throw 'The release artifact is empty.' }
    if ($byPath.Count -gt $script:DysonArtifactMaximumFiles) { throw 'The release artifact contains too many files.' }
    $paths = [string[]]@($byPath.Keys)
    [System.Array]::Sort($paths, [System.StringComparer]::Ordinal)
    $files = @($paths | ForEach-Object { $byPath[$_] })
    $canonical = [string]::Join("`n", @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 }))
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $payloadSha256 = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    return [ordered]@{
        files = $files
        fileCount = [int]$files.Count
        totalBytes = $totalBytes
        payloadSha256 = $payloadSha256
    }
}

function Write-DysonArtifactManifest {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$DevDependenciesExcluded
    )

    Assert-DysonArtifactVersion -Version $Version
    $inventory = Get-DysonArtifactInventory -Root $ArtifactRoot
    $devDependencies = [string[]]@($DevDependenciesExcluded)
    [System.Array]::Sort($devDependencies, [System.StringComparer]::Ordinal)
    $manifest = [ordered]@{
        protocol = $script:DysonArtifactProtocol
        version = $Version
        entryPoint = $script:DysonArtifactEntryPoint
        nodeMinimumMajor = 24
        dependencyInstall = 'npm-ci-omit-dev-ignore-scripts'
        dependencyPruning = 'non-runtime-package-content-v1'
        devDependenciesExcluded = $devDependencies
        payloadSha256 = $inventory.payloadSha256
        fileCount = $inventory.fileCount
        totalBytes = $inventory.totalBytes
        files = $inventory.files
    }
    $manifestPath = Join-Path $ArtifactRoot $script:DysonArtifactManifestName
    $json = $manifest | ConvertTo-Json -Depth 12 -Compress
    [System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
    return $manifest
}

function Read-DysonArtifactManifest {
    param([Parameter(Mandatory)][string]$ArtifactRoot)

    $manifestPath = Join-Path $ArtifactRoot $script:DysonArtifactManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The artifact manifest is missing.' }
    $item = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 32MB) {
        throw 'The artifact manifest is redirected or too large.'
    }
    try { return [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'The artifact manifest is invalid JSON.' }
}

function Assert-DysonArtifactExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    $actual = [string[]]@($Value.PSObject.Properties.Name)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $actual) -ne [string]::Join("`n", $expectedSorted)) {
        throw "$Name contains missing or unknown fields."
    }
}

function Test-DysonControlReleaseArtifactCore {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [string]$ExpectedVersion
    )

    $root = Assert-DysonArtifactPlainDirectory -Path $ArtifactRoot
    $manifest = Read-DysonArtifactManifest -ArtifactRoot $root
    Assert-DysonArtifactExactProperties -Value $manifest -Expected @(
        'protocol', 'version', 'entryPoint', 'nodeMinimumMajor', 'dependencyInstall',
        'dependencyPruning', 'devDependenciesExcluded', 'payloadSha256', 'fileCount', 'totalBytes', 'files'
    ) -Name 'Artifact manifest'
    if (-not [string]::Equals([string]$manifest.protocol, $script:DysonArtifactProtocol, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.entryPoint, $script:DysonArtifactEntryPoint, [System.StringComparison]::Ordinal) -or
        [int]$manifest.nodeMinimumMajor -ne 24 -or
        -not [string]::Equals([string]$manifest.dependencyInstall, 'npm-ci-omit-dev-ignore-scripts', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.dependencyPruning, 'non-runtime-package-content-v1', [System.StringComparison]::Ordinal)) {
        throw 'The artifact manifest contract is unsupported.'
    }
    Assert-DysonArtifactVersion -Version ([string]$manifest.version)
    if ($ExpectedVersion -and -not [string]::Equals([string]$manifest.version, $ExpectedVersion, [System.StringComparison]::Ordinal)) {
        throw 'The artifact version does not match the expected version.'
    }
    if ([string]$manifest.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        [int64]$manifest.fileCount -lt 1 -or [int64]$manifest.fileCount -gt $script:DysonArtifactMaximumFiles -or
        [int64]$manifest.totalBytes -lt 1 -or [int64]$manifest.totalBytes -gt $script:DysonArtifactMaximumBytes) {
        throw 'The artifact manifest summary is invalid.'
    }

    $entryPoint = Get-DysonArtifactFullPath -Path (Join-Path $root $script:DysonArtifactEntryPoint)
    if (-not (Test-DysonArtifactPathWithin -Candidate $entryPoint -Parent $root) -or
        -not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw 'The packaged API entry point is missing.'
    }
    foreach ($requiredBridgePath in @($script:DysonArtifactRequiredBridgeSources + $script:DysonArtifactRequiredBridgeScripts)) {
        $requiredBridgeFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredBridgePath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredBridgeFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredBridgeFile -PathType Leaf)) {
            throw 'The public Bridge source/build delivery package is incomplete.'
        }
    }
    foreach ($requiredMigrationPath in @($script:DysonArtifactRequiredMigrationScripts + $script:DysonArtifactRequiredMigrationDocs)) {
        $requiredMigrationFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredMigrationPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredMigrationFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredMigrationFile -PathType Leaf)) {
            throw 'The GSManager parallel-migration delivery package is incomplete.'
        }
    }
    $inventory = Get-DysonArtifactInventory -Root $root
    if ($inventory.payloadSha256 -ne [string]$manifest.payloadSha256 -or
        $inventory.fileCount -ne [int]$manifest.fileCount -or
        $inventory.totalBytes -ne [int64]$manifest.totalBytes) {
        throw 'The artifact inventory no longer matches its manifest.'
    }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne $inventory.fileCount) { throw 'The artifact manifest file count is inconsistent.' }
    for ($index = 0; $index -lt $manifestFiles.Count; $index++) {
        $expectedFile = $manifestFiles[$index]
        Assert-DysonArtifactExactProperties -Value $expectedFile -Expected @('path', 'length', 'sha256') -Name 'Artifact file entry'
        $actualFile = $inventory.files[$index]
        if ($expectedFile.path -ne $actualFile.path -or [int64]$expectedFile.length -ne $actualFile.length -or
            $expectedFile.sha256 -ne $actualFile.sha256) {
            throw 'The artifact file inventory is inconsistent.'
        }
    }
    $excludedDependencies = [string[]]@($manifest.devDependenciesExcluded)
    if ($excludedDependencies.Count -gt 256) { throw 'The excluded development dependency list is too large.' }
    $excludedSet = @{}
    for ($dependencyIndex = 0; $dependencyIndex -lt $excludedDependencies.Count; $dependencyIndex++) {
        $dependency = $excludedDependencies[$dependencyIndex]
        if ([string]$dependency -notmatch '^(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+$') {
            throw 'The excluded development dependency list is invalid.'
        }
        if ($excludedSet.ContainsKey($dependency) -or
            ($dependencyIndex -gt 0 -and [System.StringComparer]::Ordinal.Compare($excludedDependencies[$dependencyIndex - 1], $dependency) -ge 0)) {
            throw 'The excluded development dependency list is duplicated or unsorted.'
        }
        $excludedSet[$dependency] = $true
        $dependencyPath = Join-Path (Join-Path $root 'apps\api\node_modules') ([string]$dependency).Replace('/', '\')
        if (Test-Path -LiteralPath $dependencyPath) { throw "A development dependency entered the runtime artifact: $dependency" }
    }
    return [ordered]@{
        protocol = $script:DysonArtifactProtocol
        ready = $true
        version = [string]$manifest.version
        entryPoint = $script:DysonArtifactEntryPoint
        nodeMinimumMajor = [int]$manifest.nodeMinimumMajor
        payloadSha256 = $inventory.payloadSha256
        fileCount = $inventory.fileCount
        totalBytes = $inventory.totalBytes
        productionOnlyNodeModules = $true
        deploymentSourceCompatible = $true
        publicBridgeSourcePackaged = $true
        privateBridgeBinariesPackaged = $false
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
    }
}
