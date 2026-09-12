Set-StrictMode -Version 2.0

$script:NebulaPrivateBuildProtocol = 'DYSON_NEBULA_PRIVATE_BUILD_V1'
$script:NebulaPrivateMetadataProtocol = 'DYSON_NEBULA_PRIVATE_BINARY_METADATA_V1'
$script:NebulaPrivateCandidateProtocol = 'DYSON_NEBULA_PRIVATE_CANDIDATE_V1'
$script:NebulaPrivateCutoverProtocol = 'DYSON_NEBULA_PLUGIN_CUTOVER_PLAN_V1'
$script:NebulaPrivateContractPath = Join-Path $PSScriptRoot 'private-build-contract.v1.json'
$script:NebulaPrivateContract = Get-Content -LiteralPath $script:NebulaPrivateContractPath -Raw -Encoding UTF8 | ConvertFrom-Json

$script:NebulaPrivateMainFiles = @(
    'nebula-NebulaMultiplayerMod/CHANGELOG.md',
    'nebula-NebulaMultiplayerMod/discord_game_sdk_dotnet.dll',
    'nebula-NebulaMultiplayerMod/discord_game_sdk_dotnet.pdb',
    'nebula-NebulaMultiplayerMod/discord_game_sdk.bundle',
    'nebula-NebulaMultiplayerMod/discord_game_sdk.dll',
    'nebula-NebulaMultiplayerMod/discord_game_sdk.dll.lib',
    'nebula-NebulaMultiplayerMod/discord_game_sdk.dylib',
    'nebula-NebulaMultiplayerMod/discord_game_sdk.so',
    'nebula-NebulaMultiplayerMod/icon.png',
    'nebula-NebulaMultiplayerMod/K4os.Compression.LZ4.dll',
    'nebula-NebulaMultiplayerMod/K4os.Compression.LZ4.License',
    'nebula-NebulaMultiplayerMod/K4os.Compression.LZ4.Streams.dll',
    'nebula-NebulaMultiplayerMod/K4os.Hash.xxHash.dll',
    'nebula-NebulaMultiplayerMod/K4os.Hash.xxHash.License',
    'nebula-NebulaMultiplayerMod/manifest.json',
    'nebula-NebulaMultiplayerMod/nebula.LICENSE',
    'nebula-NebulaMultiplayerMod/nebulabundle',
    'nebula-NebulaMultiplayerMod/NebulaModel.dll',
    'nebula-NebulaMultiplayerMod/NebulaModel.pdb',
    'nebula-NebulaMultiplayerMod/NebulaNetwork.dll',
    'nebula-NebulaMultiplayerMod/NebulaNetwork.pdb',
    'nebula-NebulaMultiplayerMod/NebulaPatcher.dll',
    'nebula-NebulaMultiplayerMod/NebulaPatcher.pdb',
    'nebula-NebulaMultiplayerMod/NebulaWorld.dll',
    'nebula-NebulaMultiplayerMod/NebulaWorld.pdb',
    'nebula-NebulaMultiplayerMod/Networking/Serialization/LICENSE.txt',
    'nebula-NebulaMultiplayerMod/Networking/Serialization/README.txt',
    'nebula-NebulaMultiplayerMod/Open.Nat.dll',
    'nebula-NebulaMultiplayerMod/README.md',
    'nebula-NebulaMultiplayerMod/System.Buffers.dll',
    'nebula-NebulaMultiplayerMod/System.IO.Pipelines.dll',
    'nebula-NebulaMultiplayerMod/System.Memory.dll',
    'nebula-NebulaMultiplayerMod/System.Numerics.Vectors.dll',
    'nebula-NebulaMultiplayerMod/System.Runtime.CompilerServices.Unsafe.dll',
    'nebula-NebulaMultiplayerMod/System.Threading.Tasks.Extensions.dll',
    'nebula-NebulaMultiplayerMod/Unity.TextMeshPro.dll',
    'nebula-NebulaMultiplayerMod/websocket-sharp.dll',
    'nebula-NebulaMultiplayerMod/websocket-sharp.License'
)
$script:NebulaPrivateApiFiles = @(
    'nebula-NebulaMultiplayerModApi/icon.png',
    'nebula-NebulaMultiplayerModApi/manifest.json',
    'nebula-NebulaMultiplayerModApi/nebula.LICENSE',
    'nebula-NebulaMultiplayerModApi/NebulaAPI.dll',
    'nebula-NebulaMultiplayerModApi/NebulaAPI.pdb',
    'nebula-NebulaMultiplayerModApi/README.md'
)
$script:NebulaPrivateExpectedFiles = @($script:NebulaPrivateMainFiles + $script:NebulaPrivateApiFiles)
$script:NebulaPrivateCustomFiles = @($script:NebulaPrivateContract.candidate.customFiles | ForEach-Object { [string]$_ })
$script:NebulaPrivateMetadataName = 'binary-metadata.json'

function New-NebulaPrivateException {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-NebulaPrivateError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-NebulaPrivateException -Code $Code)
}

function Get-NebulaPrivateErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ($Exception.Message -cmatch '^(?:NEBULA_PRIVATE|NEBULA_PLUGIN)_[A-Z0-9_]+$') { return [string]$Exception.Message }
    return 'NEBULA_PRIVATE_UNEXPECTED_FAILURE'
}

function Test-NebulaPrivateUuid {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) { return $false }
    return $parsed.ToString('D').ToLowerInvariant() -ceq $Value
}

function Test-NebulaPrivateSha256 {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^[0-9a-f]{64}$'
}

function Get-NebulaPrivateFileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function ConvertTo-NebulaPrivateCanonicalValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or
        $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or
        $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) { return $Value }
    if ($Value -is [datetime] -or $Value -is [datetimeoffset] -or $Value -is [guid]) { return [string]$Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $ordered[$key] = ConvertTo-NebulaPrivateCanonicalValue -Value $Value[$key]
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-NebulaPrivateCanonicalValue -Value $item) }
        return ,$items
    }
    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -match 'Property' } |
        Sort-Object -Property Name -CaseSensitive)
    $result = [ordered]@{}
    foreach ($property in $properties) {
        $result[$property.Name] = ConvertTo-NebulaPrivateCanonicalValue -Value $property.Value
    }
    return [pscustomobject]$result
}

function ConvertTo-NebulaPrivateCanonicalJson {
    param([Parameter(Mandatory)]$Value)
    return ConvertTo-Json -InputObject (ConvertTo-NebulaPrivateCanonicalValue -Value $Value) -Depth 64 -Compress
}

function Get-NebulaPrivateObjectSha256 {
    param([Parameter(Mandatory)]$Value)
    $text = ConvertTo-NebulaPrivateCanonicalJson -Value $Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-NebulaPrivateExpectedBuildInputs {
    return [ordered]@{
        upstream = $script:NebulaPrivateContract.upstream
        sourcePatch = [ordered]@{
            contractSha256 = [string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256 = [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
            patchedSources = @($script:NebulaPrivateContract.sourcePatch.patchedSources)
        }
        game = $script:NebulaPrivateContract.game
        officialMainArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256
        buildStockReferences = @($script:NebulaPrivateContract.candidate.buildStockReferences)
        projectGraph = @($script:NebulaPrivateContract.build.projects)
        restore = $script:NebulaPrivateContract.restore
        pathMapTarget = [string]$script:NebulaPrivateContract.pathMapTarget
        pathMapIntermediateTarget = [string]$script:NebulaPrivateContract.pathMapIntermediateTarget
        pathMapOutputTarget = [string]$script:NebulaPrivateContract.pathMapOutputTarget
    }
}

function Get-NebulaPrivateExpectedBuildInputFingerprint {
    return Get-NebulaPrivateObjectSha256 -Value (Get-NebulaPrivateExpectedBuildInputs)
}

function Assert-NebulaPrivateExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    if ($null -eq $Value) { Throw-NebulaPrivateError -Code $Code }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $Names.Count) { Throw-NebulaPrivateError -Code $Code }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { Throw-NebulaPrivateError -Code $Code }
    }
}

function Get-NebulaPrivateFullPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 240 -or
        $Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[*?]' -or
        $Path -match '(^|\\)\.\.(\\|$)' -or $Path -match '(?i)^(\\\\|\\[.?]\\)' -or
        $Path.Substring(2).Contains(':') -or $Path.Contains('/') -or $Path -match '[\x00-\x1f]') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
    }
    $tail = $Path.Substring(3)
    foreach ($segment in @($tail.Split('\'))) {
        if ([string]::IsNullOrEmpty($segment)) {
            if (-not [string]::IsNullOrEmpty($tail)) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
            }
            continue
        }
        if ($segment.EndsWith(' ', [StringComparison]::Ordinal) -or
            $segment.EndsWith('.', [StringComparison]::Ordinal) -or
            $segment -match '(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        }
    }
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $root = [IO.Path]::GetPathRoot($full)
        if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
        return $full.TrimEnd('\')
    }
    catch { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE' }
}

function Test-NebulaPrivatePathWithin {
    param([Parameter(Mandatory)][string]$Candidate, [Parameter(Mandatory)][string]$Parent)
    $candidateFull = (Get-NebulaPrivateFullPath -Path $Candidate)
    $parentFull = (Get-NebulaPrivateFullPath -Path $Parent)
    if ($candidateFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = if ($parentFull.EndsWith('\', [StringComparison]::Ordinal)) { $parentFull } else { $parentFull + '\' }
    return $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NebulaPrivateNoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)
    $full = Get-NebulaPrivateFullPath -Path $Path
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    $current = $full
    while ($current.Length -gt $root.Length) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent.TrimEnd('\')
    }
}

function Assert-NebulaPrivateSafeLocalRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string[]]$DeniedRoots = @()
    )
    $full = Get-NebulaPrivateFullPath -Path $Path
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed -or
        -not [string]::Equals($drive.DriveFormat, 'NTFS', [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_JOB_ROOT_NOT_FIXED_NTFS'
    }
    $forbiddenFragments = @('\program files\', '\program files (x86)\', '\windows\', '\steam\',
        '\steamapps\', '\dyson sphere program\')
    $probe = ('\' + $full.Trim('\') + '\').ToLowerInvariant()
    foreach ($fragment in $forbiddenFragments) {
        if ($probe.Contains($fragment)) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PROTECTED_PATH_REJECTED' }
    }
    foreach ($denied in @($DeniedRoots)) {
        if ([string]::IsNullOrWhiteSpace($denied)) { continue }
        $deniedFull = Get-NebulaPrivateFullPath -Path $denied
        if ((Test-NebulaPrivatePathWithin -Candidate $full -Parent $deniedFull) -or
            (Test-NebulaPrivatePathWithin -Candidate $deniedFull -Parent $full)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_SHARED_PATH_REJECTED'
        }
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $full
    return $full
}

function Assert-NebulaPrivateJobRoot {
    param(
        [Parameter(Mandatory)][string]$JobRoot,
        [Parameter(Mandatory)][string]$JobBase,
        [Parameter(Mandatory)][string]$RequestId,
        [string[]]$DeniedRoots = @()
    )
    if (-not (Test-NebulaPrivateUuid -Value $RequestId)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_REQUEST_ID_INVALID'
    }
    $base = Assert-NebulaPrivateSafeLocalRoot -Path $JobBase -DeniedRoots $DeniedRoots
    $expected = [IO.Path]::GetFullPath((Join-Path $base $RequestId)).TrimEnd('\')
    $actual = Get-NebulaPrivateFullPath -Path $JobRoot
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_JOB_ROOT_NOT_REQUEST_SCOPED'
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $actual
    return $actual
}

function Assert-NebulaPrivateJobPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$JobRoot,
        [switch]$AllowJobRoot
    )
    $full = Get-NebulaPrivateFullPath -Path $Path
    $root = Get-NebulaPrivateFullPath -Path $JobRoot
    if (-not (Test-NebulaPrivatePathWithin -Candidate $full -Parent $root) -or
        (-not $AllowJobRoot -and $full.Equals($root, [StringComparison]::OrdinalIgnoreCase))) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_WRITE_OUTSIDE_JOB_ROOT'
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $full
    return $full
}

function Write-NebulaPrivateJsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$JobRoot
    )
    $target = Assert-NebulaPrivateJobPath -Path $Path -JobRoot $JobRoot
    $parent = [IO.Path]::GetDirectoryName($target)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $parent
    if (Test-Path -LiteralPath $target) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OUTPUT_ALREADY_EXISTS' }
    $temporary = $target + '.tmp.' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, (ConvertTo-NebulaPrivateCanonicalJson -Value $Value) + "`n",
        [Text.UTF8Encoding]::new($false))
    try { [IO.File]::Move($temporary, $target) }
    finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
    return $target
}

function Write-NebulaPrivateTextAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$JobRoot
    )
    $target = Assert-NebulaPrivateJobPath -Path $Path -JobRoot $JobRoot
    $parent = [IO.Path]::GetDirectoryName($target)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $parent
    if (Test-Path -LiteralPath $target) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OUTPUT_ALREADY_EXISTS' }
    $temporary = $target + '.tmp.' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, $Value, [Text.UTF8Encoding]::new($false))
    try { [IO.File]::Move($temporary, $target) }
    finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
    return $target
}

function Copy-NebulaPrivateFileNew {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$JobRoot
    )
    $target = Assert-NebulaPrivateJobPath -Path $Destination -JobRoot $JobRoot
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_COPY_SOURCE_MISSING'
    }
    $parent = [IO.Path]::GetDirectoryName($target)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $parent
    if (Test-Path -LiteralPath $target) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OUTPUT_ALREADY_EXISTS' }
    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $input.CopyTo($output) }
    finally { $output.Dispose(); $input.Dispose() }
    return $target
}

function Assert-NebulaPrivateContractAnchors {
    param(
        [Parameter(Mandatory)][string]$SourceContractPath,
        [Parameter(Mandatory)][string]$PatchPath
    )
    if (-not (Test-Path -LiteralPath $SourceContractPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_SOURCE_ANCHOR_MISSING'
    }
    $contractHash = Get-NebulaPrivateFileSha256 -Path $SourceContractPath
    $patchHash = Get-NebulaPrivateFileSha256 -Path $PatchPath
    if ($contractHash -cne [string]$script:NebulaPrivateContract.sourcePatch.contractSha256 -or
        $patchHash -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_SOURCE_ANCHOR_MISMATCH'
    }
    $sourceContract = Get-Content -LiteralPath $SourceContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$sourceContract.upstream.repository -cne [string]$script:NebulaPrivateContract.upstream.repository -or
        [string]$sourceContract.upstream.tag -cne [string]$script:NebulaPrivateContract.upstream.tag -or
        [string]$sourceContract.upstream.commit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
        [string]$sourceContract.patch.sha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_SOURCE_CONTRACT_INVALID'
    }
    $actualPatched = @($sourceContract.sources | ForEach-Object { [string]$_.path } | Sort-Object -CaseSensitive)
    $expectedPatched = @($script:NebulaPrivateContract.sourcePatch.patchedFiles | ForEach-Object { [string]$_ } |
        Sort-Object -CaseSensitive)
    if (($actualPatched -join "`n") -cne ($expectedPatched -join "`n")) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PATCH_SCOPE_INVALID'
    }
    $actualCandidate = @($sourceContract.candidate.patchedSources | Sort-Object -Property path | ForEach-Object {
        [ordered]@{ path = [string]$_.path; size = [int64]$_.sizeBytes; sha256 = [string]$_.sha256 }
    })
    $expectedCandidate = @($script:NebulaPrivateContract.sourcePatch.patchedSources | Sort-Object -Property path | ForEach-Object {
        [ordered]@{ path = [string]$_.path; size = [int64]$_.size; sha256 = [string]$_.sha256 }
    })
    if ((Get-NebulaPrivateObjectSha256 -Value $actualCandidate) -cne
        (Get-NebulaPrivateObjectSha256 -Value $expectedCandidate)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_SOURCE_CONTRACT_INVALID'
    }
}

function Assert-NebulaPrivateBuildPlan {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$JobRoot
    )
    Assert-NebulaPrivateExactProperties -Value $Plan -Names @(
        'protocol','schemaVersion','requestId','executionEnabled','executorIncluded','generatedArtifactsOnly',
        'inputs','inputFingerprintSha256','anchors','preparation','gameGate','isolation','builds',
        'deterministicComparison','candidate','previewDigest'
    ) -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    if ([string]$Plan.protocol -cne $script:NebulaPrivateBuildProtocol -or [int]$Plan.schemaVersion -ne 1 -or
        [string]$Plan.requestId -cne $RequestId -or $Plan.executionEnabled -isnot [bool] -or $Plan.executionEnabled -or
        $Plan.executorIncluded -isnot [bool] -or $Plan.executorIncluded -or
        $Plan.generatedArtifactsOnly -isnot [bool] -or -not $Plan.generatedArtifactsOnly -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Plan.previewDigest))) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    $expectedInputs = Get-NebulaPrivateExpectedBuildInputs
    $expectedInputFingerprint = Get-NebulaPrivateExpectedBuildInputFingerprint
    if (-not (Test-NebulaPrivateSha256 -Value ([string]$Plan.inputFingerprintSha256)) -or
        [string]$Plan.inputFingerprintSha256 -cne $expectedInputFingerprint -or
        (Get-NebulaPrivateObjectSha256 -Value $Plan.inputs) -cne $expectedInputFingerprint -or
        (Get-NebulaPrivateObjectSha256 -Value $Plan.inputs) -cne
            (Get-NebulaPrivateObjectSha256 -Value $expectedInputs)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_INPUT_INVALID'
    }
    $withoutDigest = [ordered]@{}
    foreach ($property in $Plan.PSObject.Properties) {
        if ($property.Name -cne 'previewDigest') { $withoutDigest[$property.Name] = $property.Value }
    }
    if ([string]$Plan.previewDigest -cne (Get-NebulaPrivateObjectSha256 -Value $withoutDigest)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    if ([string]$Plan.anchors.repository -cne [string]$script:NebulaPrivateContract.upstream.repository -or
        [string]$Plan.anchors.tag -cne [string]$script:NebulaPrivateContract.upstream.tag -or
        [string]$Plan.anchors.commit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
        [string]$Plan.anchors.websocketSubmoduleCommit -cne [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit -or
        [string]$Plan.anchors.sourceContractSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.contractSha256 -or
        [string]$Plan.anchors.patchSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256 -or
        [string]$Plan.gameGate.packageVersion -cne [string]$script:NebulaPrivateContract.game.gameLibVersion -or
        [string]$Plan.gameGate.gameVersion -cne [string]$script:NebulaPrivateContract.game.gameVersion -or
        [string]$Plan.gameGate.assemblyCSharpMvid -cne [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    if ($Plan.isolation.requestScopedFixedNtfsJobRoot -isnot [bool] -or -not $Plan.isolation.requestScopedFixedNtfsJobRoot -or
        $Plan.isolation.noAutoResponse -isnot [bool] -or -not $Plan.isolation.noAutoResponse -or
        $Plan.isolation.directoryBuildPropsIsolated -isnot [bool] -or -not $Plan.isolation.directoryBuildPropsIsolated -or
        $Plan.isolation.directoryBuildTargetsIsolated -isnot [bool] -or -not $Plan.isolation.directoryBuildTargetsIsolated -or
        $Plan.isolation.outputsIsolated -isnot [bool] -or -not $Plan.isolation.outputsIsolated -or
        $Plan.isolation.nugetIsolated -isnot [bool] -or -not $Plan.isolation.nugetIsolated -or
        $Plan.isolation.tempIsolated -isnot [bool] -or -not $Plan.isolation.tempIsolated -or
        [string]$Plan.isolation.pathMapTarget -cne [string]$script:NebulaPrivateContract.pathMapTarget) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    if ([string]$Plan.isolation.pathMapIntermediateTarget -cne
            [string]$script:NebulaPrivateContract.pathMapIntermediateTarget -or
        [string]$Plan.isolation.pathMapOutputTarget -cne
            [string]$script:NebulaPrivateContract.pathMapOutputTarget) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    foreach ($pathProperty in $Plan.isolation.paths.PSObject.Properties) {
        $path = [string]$pathProperty.Value
        [void](Assert-NebulaPrivateJobPath -Path $path -JobRoot $JobRoot -AllowJobRoot)
    }
    if (@($Plan.builds).Count -ne 2) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID' }
    $slots = @($Plan.builds | ForEach-Object { [string]$_.slot })
    if (($slots -join "`n") -cne "a`nb") { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID' }
    $expectedProjects = @('websocket-sharp','discord_game_sdk_dotnet','NebulaAPI','NebulaModel','NebulaWorld','NebulaNetwork','NebulaPatcher')
    $expectedModes = @('verified-stock-reference','msbuild','msbuild','msbuild','msbuild','msbuild','msbuild')
    $scopedBuildPaths = @()
    foreach ($build in @($Plan.builds)) {
        if ([string]$build.invocation.executable -cne 'dotnet' -or [string]$build.invocation.verb -cne 'msbuild' -or
            [string]$build.inputFingerprintSha256 -cne $expectedInputFingerprint -or
            @($build.invocation.mandatoryArguments) -cnotcontains '-noAutoResponse' -or
            [string]$build.invocation.properties.BuildProjectReferences -cne 'false' -or
            [string]$build.invocation.properties.RestoreRecursive -cne 'false' -or
            @($build.invocation.allowedHarvest).Count -ne 4 -or
            (@($build.invocation.allowedHarvest | Sort-Object -CaseSensitive) -join "`n") -cne
                (@($script:NebulaPrivateCustomFiles | Sort-Object -CaseSensitive) -join "`n") -or
            (@($build.invocation.projectsInOrder | ForEach-Object { [string]$_.name }) -join "`n") -cne
                ($expectedProjects -join "`n") -or
            (@($build.invocation.projectsInOrder | ForEach-Object { [string]$_.mode }) -join "`n") -cne
                ($expectedModes -join "`n")) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        }
        $stockProject = @($build.invocation.projectsInOrder | Where-Object {
            [string]$_.mode -ceq 'verified-stock-reference'
        })
        $stockContract = @($script:NebulaPrivateContract.candidate.buildStockReferences)
        if ($stockProject.Count -ne 1 -or $stockContract.Count -ne 1 -or
            [string]$stockProject[0].name -cne [string]$stockContract[0].project -or
            [string]$stockProject[0].stockReference.archivePath -cne [string]$stockContract[0].archivePath -or
            [string]$stockProject[0].stockReference.outputPath -cne
                (Join-Path ([string]$build.outputRoot) ([string]$stockContract[0].outputFileName)) -or
            [int64]$stockProject[0].stockReference.size -ne [int64]$stockContract[0].size -or
            [string]$stockProject[0].stockReference.sha256 -cne [string]$stockContract[0].sha256 -or
            [string]$stockProject[0].stockReference.sourceArchiveSha256 -cne
                [string]$stockContract[0].sourceArchiveSha256 -or
            (Get-NebulaPrivateObjectSha256 -Value $stockProject[0].stockReference.assemblyIdentity) -cne
                (Get-NebulaPrivateObjectSha256 -Value $stockContract[0].assemblyIdentity)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        }
        [void](Assert-NebulaPrivateJobPath -Path ([string]$stockProject[0].stockReference.outputPath) -JobRoot $JobRoot)
        if (-not (Test-NebulaPrivatePathWithin -Candidate ([string]$build.invocation.properties.NebulaPrivateReferenceRoot) `
            -Parent ([string]$build.sourceRoot))) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        }
        foreach ($path in @($build.sourceRoot,$build.outputRoot,$build.intermediateRoot,$build.harvestRoot,
            $build.environment.DOTNET_CLI_HOME,$build.environment.NUGET_PACKAGES,$build.environment.NUGET_HTTP_CACHE_PATH,
            $build.environment.TEMP,$build.invocation.properties.DirectoryBuildPropsPath,
            $build.invocation.properties.RestoreConfigFile)) {
            $scopedBuildPaths += Assert-NebulaPrivateJobPath -Path ([string]$path) -JobRoot $JobRoot
        }
        if ([string]$build.environment.TEMP -cne [string]$build.environment.TMP -or
            [string]$build.environment.DOTNET_CLI_TELEMETRY_OPTOUT -cne '1' -or
            [string]$build.environment.DOTNET_SKIP_FIRST_TIME_EXPERIENCE -cne '1' -or
            [string]$build.environment.DOTNET_NOLOGO -cne '1' -or
            [string]$build.environment.DOTNET_MULTILEVEL_LOOKUP -cne '0' -or
            [string]$build.environment.NUGET_XMLDOC_MODE -cne 'skip' -or
            [string]$build.environment.NUGET_PACKAGES -cne [string]$build.invocation.properties.RestorePackagesPath -or
            [string]$build.invocation.properties.OutputPath -cne ([string]$build.outputRoot + '\') -or
            [string]$build.invocation.properties.BaseOutputPath -cne ([string]$build.outputRoot + '\') -or
            [string]$build.invocation.properties.PathMap -cne
                (([string]$build.sourceRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapTarget + '%2C' +
                ([string]$build.intermediateRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapIntermediateTarget + '%2C' +
                ([string]$build.outputRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapOutputTarget)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        }
        try {
            [xml]$nugetConfig = Get-Content -LiteralPath ([string]$build.invocation.properties.RestoreConfigFile) `
                -Raw -Encoding UTF8
            [xml]$props = Get-Content -LiteralPath ([string]$build.invocation.properties.DirectoryBuildPropsPath) `
                -Raw -Encoding UTF8
        }
        catch { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID' }
        $configNodes = @($nugetConfig.configuration.config.add)
        $globalFolder = @($configNodes | Where-Object { [string]$_.key -ceq 'globalPackagesFolder' })
        $repositoryFolder = @($configNodes | Where-Object { [string]$_.key -ceq 'repositoryPath' })
        if ($globalFolder.Count -ne 1 -or $repositoryFolder.Count -ne 1 -or
            [string]$globalFolder[0].value -cne [string]$build.environment.NUGET_PACKAGES -or
            [string]$repositoryFolder[0].value -cne [string]$build.environment.NUGET_PACKAGES) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID'
        }
        $actualSources = @($nugetConfig.configuration.packageSources.add | ForEach-Object {
            [ordered]@{ key = [string]$_.key; url = [string]$_.value }
        })
        $expectedSources = @($script:NebulaPrivateContract.restore.packageSources | ForEach-Object {
            [ordered]@{ key = [string]$_.key; url = [string]$_.url }
        })
        if ((Get-NebulaPrivateObjectSha256 -Value $actualSources) -cne
            (Get-NebulaPrivateObjectSha256 -Value $expectedSources)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID'
        }
        $actualMappings = @($nugetConfig.configuration.packageSourceMapping.packageSource | ForEach-Object {
            [ordered]@{
                key = [string]$_.key
                packageIds = @($_.package | ForEach-Object { [string]$_.pattern })
            }
        })
        $expectedMappings = @($script:NebulaPrivateContract.restore.packageSources | ForEach-Object {
            [ordered]@{ key = [string]$_.key; packageIds = @($_.packageIds | ForEach-Object { [string]$_ }) }
        })
        if ((Get-NebulaPrivateObjectSha256 -Value $actualMappings) -cne
            (Get-NebulaPrivateObjectSha256 -Value $expectedMappings) -or
            @($actualMappings.packageIds | Where-Object { $_ -match '[*?\[\]]' }).Count -ne 0) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID'
        }
        $actualPropsPackages = @($props.Project.ItemGroup.PackageReference | ForEach-Object {
            [ordered]@{ id = [string]$_.Include; version = [string]$_.Version }
        })
        $expectedPropsPackages = @($script:NebulaPrivateContract.restore.directPackages | Where-Object {
            [string]$_.declaration -ceq 'isolated-props'
        } | ForEach-Object { [ordered]@{ id = [string]$_.id; version = [string]$_.version } })
        if (@($actualPropsPackages | Where-Object { [string]$_.version -match '[*?\[\]\(\),]' }).Count -ne 0) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID'
        }
        foreach ($actualPackage in $actualPropsPackages) {
            if (@($expectedPropsPackages | Where-Object {
                [string]$_.id -ceq [string]$actualPackage.id -and
                [string]$_.version -ceq [string]$actualPackage.version
            }).Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID' }
        }
        foreach ($expectedPackage in $expectedPropsPackages) {
            if (@($actualPropsPackages | Where-Object {
                [string]$_.id -ceq [string]$expectedPackage.id -and
                [string]$_.version -ceq [string]$expectedPackage.version
            }).Count -lt 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID' }
        }
        $intermediateRoots = @()
        foreach ($project in @($build.invocation.projectsInOrder)) {
            $projectRoot = Assert-NebulaPrivateJobPath -Path ([string]$project.intermediateRoot) -JobRoot $JobRoot
            if (-not (Test-NebulaPrivatePathWithin -Candidate $projectRoot -Parent ([string]$build.intermediateRoot))) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
            }
            $intermediateRoots += $projectRoot
        }
        if (@($intermediateRoots | Sort-Object -Unique).Count -ne 7) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        }
    }
    if (@($scopedBuildPaths | Sort-Object -Unique).Count -ne $scopedBuildPaths.Count) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
    }
    return $Plan
}

function Get-NebulaPrivatePlainFiles {
    param([Parameter(Mandatory)][string]$Root)
    $rootFull = Get-NebulaPrivateFullPath -Path $Root
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_TREE_MISSING'
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $rootFull
    $queue = New-Object Collections.Generic.Queue[string]
    $queue.Enqueue($rootFull)
    $files = @()
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
            $relative = $item.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^|/)\.\.(/|$)') {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_TREE_PATH_INVALID'
            }
            $files += [pscustomobject][ordered]@{
                path = $relative
                size = [int64]$item.Length
                sha256 = Get-NebulaPrivateFileSha256 -Path $item.FullName
                fullPath = $item.FullName
            }
        }
    }
    return @($files | Sort-Object -Property path -CaseSensitive)
}

function Assert-NebulaPrivateExactFileSet {
    param(
        [Parameter(Mandatory)]$Records,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Code
    )
    $actual = @($Records | ForEach-Object { [string]$_.path } | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count -or ($actual -join "`n") -cne ($wanted -join "`n")) {
        Throw-NebulaPrivateError -Code $Code
    }
}

function Get-NebulaPrivateTreeDigest {
    param([Parameter(Mandatory)]$Records)
    $map = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($record in @($Records)) {
        $path = [string]$record.path
        if ([string]::IsNullOrWhiteSpace($path) -or $map.ContainsKey($path)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_TREE_PATH_INVALID'
        }
        $map.Add($path, $record)
    }
    [string[]]$paths = @($map.Keys)
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    $lines = @($paths | ForEach-Object {
        $record = $map[$_]
        ([string]$record.path) + [char]0 +
            ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', [int64]$record.size)) + [char]0 +
            ([string]$record.sha256).ToLowerInvariant() + "`n"
    }) -join ''
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($lines)))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Test-NebulaPrivateMagic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Expected)
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt $Expected.Length) { return $false }
        foreach ($value in $Expected) {
            if ($stream.ReadByte() -ne [int]$value) { return $false }
        }
        return $true
    }
    finally { $stream.Dispose() }
}

function Find-NebulaPrivateReference {
    param([Parameter(Mandatory)]$References, [Parameter(Mandatory)][string]$Name)
    $matches = @($References | Where-Object { [string]$_.name -ceq $Name })
    if ($matches.Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID' }
    return $matches[0]
}

function Assert-NebulaPrivateReference {
    param(
        [Parameter(Mandatory)]$References,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$PublicKeyToken
    )
    $reference = Find-NebulaPrivateReference -References $References -Name $Name
    if ([string]$reference.version -cne $Version -or [string]$reference.publicKeyToken -cne $PublicKeyToken) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
    }
}

function Assert-NebulaPrivateMetadata {
    param(
        [Parameter(Mandatory)]$Metadata,
        [Parameter(Mandatory)][string]$HarvestRoot
    )
    Assert-NebulaPrivateExactProperties -Value $Metadata -Names @(
        'protocol','schemaVersion','source','game','build','artifacts','assemblies','publicHygieneFindings'
    ) -Code 'NEBULA_PRIVATE_METADATA_SCHEMA_INVALID'
    if ([string]$Metadata.protocol -cne $script:NebulaPrivateMetadataProtocol -or
        [int]$Metadata.schemaVersion -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_SCHEMA_INVALID' }
    Assert-NebulaPrivateExactProperties -Value $Metadata.source -Names @(
        'upstreamCommit','websocketSubmoduleCommit','sourceContractSha256','patchSha256','patchedFiles'
    ) -Code 'NEBULA_PRIVATE_METADATA_SOURCE_INVALID'
    if ([string]$Metadata.source.upstreamCommit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
        [string]$Metadata.source.websocketSubmoduleCommit -cne [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit -or
        [string]$Metadata.source.sourceContractSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.contractSha256 -or
        [string]$Metadata.source.patchSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_SOURCE_INVALID'
    }
    $patched = @($Metadata.source.patchedFiles | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    $expectedPatched = @($script:NebulaPrivateContract.sourcePatch.patchedFiles | ForEach-Object { [string]$_ } |
        Sort-Object -CaseSensitive)
    if (($patched -join "`n") -cne ($expectedPatched -join "`n")) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_SOURCE_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Metadata.game -Names @(
        'gameLibPackage','gameLibVersion','gameVersion','assemblyCSharpMvid'
    ) -Code 'NEBULA_PRIVATE_GAME_VERSION_INVALID'
    if ([string]$Metadata.game.gameLibPackage -cne [string]$script:NebulaPrivateContract.game.gameLibPackage -or
        [string]$Metadata.game.gameLibVersion -cne [string]$script:NebulaPrivateContract.game.gameLibVersion -or
        [string]$Metadata.game.gameVersion -cne [string]$script:NebulaPrivateContract.game.gameVersion -or
        [string]$Metadata.game.assemblyCSharpMvid -cne [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_GAME_VERSION_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Metadata.build -Names @(
        'configuration','buildPlanDigest','inputFingerprintSha256','stockReferences','noAutoResponse',
        'buildProjectReferences','restoreRecursive','directoryBuildTargetsIsolated','outputsIsolated','nugetIsolated',
        'tempIsolated','pathMapTarget','pathMapIntermediateTarget','pathMapOutputTarget'
    ) -Code 'NEBULA_PRIVATE_BUILD_GUARDS_INVALID'
    if ([string]$Metadata.build.configuration -cne 'Release' -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Metadata.build.buildPlanDigest)) -or
        [string]$Metadata.build.inputFingerprintSha256 -cne (Get-NebulaPrivateExpectedBuildInputFingerprint) -or
        $Metadata.build.noAutoResponse -isnot [bool] -or -not $Metadata.build.noAutoResponse -or
        $Metadata.build.buildProjectReferences -isnot [bool] -or $Metadata.build.buildProjectReferences -or
        $Metadata.build.restoreRecursive -isnot [bool] -or $Metadata.build.restoreRecursive -or
        $Metadata.build.directoryBuildTargetsIsolated -isnot [bool] -or -not $Metadata.build.directoryBuildTargetsIsolated -or
        $Metadata.build.outputsIsolated -isnot [bool] -or -not $Metadata.build.outputsIsolated -or
        $Metadata.build.nugetIsolated -isnot [bool] -or -not $Metadata.build.nugetIsolated -or
        $Metadata.build.tempIsolated -isnot [bool] -or -not $Metadata.build.tempIsolated -or
        [string]$Metadata.build.pathMapTarget -cne [string]$script:NebulaPrivateContract.pathMapTarget -or
        [string]$Metadata.build.pathMapIntermediateTarget -cne
            [string]$script:NebulaPrivateContract.pathMapIntermediateTarget -or
        [string]$Metadata.build.pathMapOutputTarget -cne
            [string]$script:NebulaPrivateContract.pathMapOutputTarget) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_GUARDS_INVALID'
    }
    $expectedStockReferences = @($script:NebulaPrivateContract.candidate.buildStockReferences | ForEach-Object {
        [ordered]@{
            project = [string]$_.project
            archivePath = [string]$_.archivePath
            sourceArchiveSha256 = [string]$_.sourceArchiveSha256
            outputFileName = [string]$_.outputFileName
            size = [int64]$_.size
            sha256 = [string]$_.sha256
            assemblyIdentity = $_.assemblyIdentity
        }
    })
    if (@($Metadata.build.stockReferences).Count -ne 1 -or
        (Get-NebulaPrivateObjectSha256 -Value @($Metadata.build.stockReferences)) -cne
            (Get-NebulaPrivateObjectSha256 -Value $expectedStockReferences)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_STOCK_REFERENCE_INVALID'
    }
    if (@($Metadata.publicHygieneFindings).Count -ne 0) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PUBLIC_HYGIENE_FAILED'
    }
    $harvest = Get-NebulaPrivateFullPath -Path $HarvestRoot
    $artifactPaths = @($Metadata.artifacts | ForEach-Object { [string]$_.path } | Sort-Object -CaseSensitive)
    $expectedArtifacts = @($script:NebulaPrivateCustomFiles | Sort-Object -CaseSensitive)
    if ($artifactPaths.Count -ne 4 -or ($artifactPaths -join "`n") -cne ($expectedArtifacts -join "`n")) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
    }
    foreach ($artifact in @($Metadata.artifacts)) {
        Assert-NebulaPrivateExactProperties -Value $artifact -Names @('path','kind','size','sha256') `
            -Code 'NEBULA_PRIVATE_METADATA_ARTIFACT_INVALID'
        $relative = ([string]$artifact.path).Replace('/', '\')
        $file = [IO.Path]::GetFullPath((Join-Path $harvest $relative))
        if (-not (Test-NebulaPrivatePathWithin -Candidate $file -Parent $harvest) -or
            -not (Test-Path -LiteralPath $file -PathType Leaf) -or
            [int64](Get-Item -LiteralPath $file).Length -ne [int64]$artifact.size -or
            (Get-NebulaPrivateFileSha256 -Path $file) -cne [string]$artifact.sha256) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_ARTIFACT_INVALID'
        }
        if ([string]$artifact.kind -ceq 'managed-dll') {
            if (-not (Test-NebulaPrivateMagic -Path $file -Expected ([byte[]](0x4d,0x5a)))) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_DLL_MAGIC_INVALID'
            }
        }
        elseif ([string]$artifact.kind -ceq 'portable-pdb') {
            if (-not (Test-NebulaPrivateMagic -Path $file -Expected ([byte[]](0x42,0x53,0x4a,0x42)))) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PDB_MAGIC_INVALID'
            }
        }
        else { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_ARTIFACT_INVALID' }
    }
    if (@($Metadata.assemblies).Count -ne 2) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_METADATA_INVALID' }
    foreach ($assembly in @($Metadata.assemblies)) {
        Assert-NebulaPrivateExactProperties -Value $assembly -Names @(
            'path','name','assemblyVersion','fileVersion','productVersion','publicKeyToken','mvid','references','debug'
        ) -Code 'NEBULA_PRIVATE_ASSEMBLY_METADATA_INVALID'
        if ([string]$assembly.assemblyVersion -cne [string]$script:NebulaPrivateContract.assemblies.nebulaAssemblyVersion -or
            [string]$assembly.fileVersion -cne [string]$script:NebulaPrivateContract.assemblies.nebulaFileVersion -or
            [string]$assembly.publicKeyToken -cne 'none' -or
            [string]$assembly.productVersion -cnotmatch '^0\.9\.22\.2(?:\+3cdf95c.*)?$' -or
            [string]$assembly.mvid -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_METADATA_INVALID'
        }
        $expectedName = if ([string]$assembly.path -ceq 'nebula-NebulaMultiplayerMod/NebulaNetwork.dll') {
            'NebulaNetwork'
        } elseif ([string]$assembly.path -ceq 'nebula-NebulaMultiplayerMod/NebulaPatcher.dll') {
            'NebulaPatcher'
        } else { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_METADATA_INVALID' }
        if ([string]$assembly.name -cne $expectedName) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_METADATA_INVALID' }
        $referenceNames = @($assembly.references | ForEach-Object { [string]$_.name })
        if ($referenceNames.Count -eq 0 -or
            @($referenceNames | Sort-Object -Unique -CaseSensitive).Count -ne $referenceNames.Count) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
        }
        foreach ($reference in @($assembly.references)) {
            Assert-NebulaPrivateExactProperties -Value $reference -Names @('name','version','publicKeyToken') -Code 'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
            if ([string]::IsNullOrWhiteSpace([string]$reference.name) -or
                [string]$reference.version -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or
                [string]$reference.publicKeyToken -cnotmatch '^(?:none|[0-9a-f]{16})$') {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
            }
        }
        if (($expectedName -ceq 'NebulaNetwork' -and [string]$assembly.mvid -ceq [string]$script:NebulaPrivateContract.assemblies.officialNetworkMvid) -or
            ($expectedName -ceq 'NebulaPatcher' -and [string]$assembly.mvid -ceq [string]$script:NebulaPrivateContract.assemblies.officialPatcherMvid)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CUSTOM_MVID_NOT_CUSTOM'
        }
        Assert-NebulaPrivateReference -References $assembly.references -Name 'NebulaAPI' -Version '2.1.0.0' -PublicKeyToken 'none'
        Assert-NebulaPrivateReference -References $assembly.references -Name 'NebulaModel' -Version '0.9.22.0' -PublicKeyToken 'none'
        Assert-NebulaPrivateReference -References $assembly.references -Name 'NebulaWorld' -Version '0.9.22.0' -PublicKeyToken 'none'
        if ($expectedName -ceq 'NebulaNetwork') {
            Assert-NebulaPrivateReference -References $assembly.references `
                -Name ([string]$script:NebulaPrivateContract.assemblies.websocket.name) `
                -Version ([string]$script:NebulaPrivateContract.assemblies.websocket.version) `
                -PublicKeyToken ([string]$script:NebulaPrivateContract.assemblies.websocket.publicKeyToken)
            Assert-NebulaPrivateReference -References $assembly.references -Name 'Open.Nat' -Version '1.0.0.0' `
                -PublicKeyToken 'f22a6a4582336c76'
        }
        else {
            Assert-NebulaPrivateReference -References $assembly.references -Name 'NebulaNetwork' -Version '0.9.22.0' `
                -PublicKeyToken 'none'
        }
        Assert-NebulaPrivateExactProperties -Value $assembly.debug -Names @(
            'pdbPath','codeViewGuid','codeViewAge','codeViewTimestamp','pdbIdGuid','pdbIdStamp','codeViewPath'
        ) -Code 'NEBULA_PRIVATE_PDB_IDENTITY_INVALID'
        if ([string]$assembly.debug.pdbPath -cne ([string]$assembly.path -replace '\.dll$','.pdb') -or
            [string]$assembly.debug.codeViewGuid -cne [string]$assembly.debug.pdbIdGuid -or
            [int]$assembly.debug.codeViewAge -ne 1 -or
            [string]$assembly.debug.codeViewTimestamp -cne [string]$assembly.debug.pdbIdStamp -or
            [string]$assembly.debug.codeViewGuid -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
            [string]$assembly.debug.codeViewTimestamp -cnotmatch '^[0-9a-f]{8}$') {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PDB_IDENTITY_INVALID'
        }
        $codeViewPath = [string]$assembly.debug.codeViewPath
        if ($codeViewPath -match '(?i)^[A-Z]:\\|^\\\\|Users[\\/]|Program Files|Steam[\\/]|steamapps|Dyson Sphere Program' -or
            $codeViewPath -match '[\x00-\x1f]' -or
            -not ($codeViewPath -ceq [IO.Path]::GetFileName($codeViewPath) -or $codeViewPath.StartsWith('/_/'))) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PDB_PATH_HYGIENE_FAILED'
        }
    }
    return $Metadata
}

function Assert-NebulaPrivateDeterministicBuilds {
    param(
        [Parameter(Mandatory)]$MetadataA,
        [Parameter(Mandatory)]$MetadataB,
        [Parameter(Mandatory)][string]$HarvestRootA,
        [Parameter(Mandatory)][string]$HarvestRootB
    )
    [void](Assert-NebulaPrivateMetadata -Metadata $MetadataA -HarvestRoot $HarvestRootA)
    [void](Assert-NebulaPrivateMetadata -Metadata $MetadataB -HarvestRoot $HarvestRootB)
    $projection = {
        param($Metadata)
        return [ordered]@{
            source = $Metadata.source
            game = $Metadata.game
            build = $Metadata.build
            artifacts = @($Metadata.artifacts | Sort-Object -Property path)
            assemblies = @($Metadata.assemblies | Sort-Object -Property path)
            publicHygieneFindings = @($Metadata.publicHygieneFindings)
        }
    }
    if ((Get-NebulaPrivateObjectSha256 -Value (& $projection $MetadataA)) -cne
        (Get-NebulaPrivateObjectSha256 -Value (& $projection $MetadataB))) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILDS_NOT_DETERMINISTIC'
    }
}

function Assert-NebulaPrivateCandidateTrees {
    param(
        [Parameter(Mandatory)][string]$BaselineRoot,
        [Parameter(Mandatory)][string]$CandidateRoot
    )
    $baseline = Get-NebulaPrivatePlainFiles -Root $BaselineRoot
    $candidate = Get-NebulaPrivatePlainFiles -Root $CandidateRoot
    Assert-NebulaPrivateExactFileSet -Records $baseline -Expected $script:NebulaPrivateExpectedFiles `
        -Code 'NEBULA_PRIVATE_BASELINE_FILE_SET_INVALID'
    Assert-NebulaPrivateExactFileSet -Records $candidate -Expected $script:NebulaPrivateExpectedFiles `
        -Code 'NEBULA_PRIVATE_CANDIDATE_FILE_SET_INVALID'
    $baselineMap = @{}
    foreach ($record in $baseline) { $baselineMap[[string]$record.path] = $record }
    $customChanges = 0
    $stockMatches = 0
    foreach ($record in $candidate) {
        $before = $baselineMap[[string]$record.path]
        $isCustom = [string]$record.path -cin $script:NebulaPrivateCustomFiles
        $same = [string]$record.sha256 -ceq [string]$before.sha256 -and [int64]$record.size -eq [int64]$before.size
        if ($isCustom) {
            if ($same) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CUSTOM_FILE_NOT_REPLACED' }
            $customChanges++
        }
        else {
            if (-not $same) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STOCK_BYTES_CHANGED' }
            $stockMatches++
        }
    }
    if ($customChanges -ne 4 -or $stockMatches -ne 40) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_COUNTS_INVALID'
    }
    return [pscustomobject][ordered]@{
        baselineTreeSha256 = Get-NebulaPrivateTreeDigest -Records $baseline
        candidateTreeSha256 = Get-NebulaPrivateTreeDigest -Records $candidate
        totalFiles = 44
        stockFiles = 40
        customFiles = 4
    }
}

function Assert-NebulaPrivateCandidateManifest {
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$CandidateRoot
    )
    Assert-NebulaPrivateExactProperties -Value $Manifest -Names @(
        'protocol','schemaVersion','source','game','baseline','candidate','deterministicBuildEvidence','files','manifestDigest'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    if ([string]$Manifest.protocol -cne $script:NebulaPrivateCandidateProtocol -or [int]$Manifest.schemaVersion -ne 1) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Manifest.source -Names @(
        'upstreamCommit','websocketSubmoduleCommit','sourceContractSha256','patchSha256'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    if ([string]$Manifest.source.upstreamCommit -cne [string]$script:NebulaPrivateContract.upstream.commit -or
        [string]$Manifest.source.websocketSubmoduleCommit -cne [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit -or
        [string]$Manifest.source.sourceContractSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.contractSha256 -or
        [string]$Manifest.source.patchSha256 -cne [string]$script:NebulaPrivateContract.sourcePatch.patchSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Manifest.game -Names @(
        'gameVersion','gameLibVersion','assemblyCSharpMvid'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    if ([string]$Manifest.game.gameVersion -cne [string]$script:NebulaPrivateContract.game.gameVersion -or
        [string]$Manifest.game.gameLibVersion -cne [string]$script:NebulaPrivateContract.game.gameLibVersion -or
        [string]$Manifest.game.assemblyCSharpMvid -cne [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Manifest.baseline -Names @(
        'mainArchiveSha256','apiArchiveSha256','sourceManifestSha256','treeSha256','treeDigestAlgorithm'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    if ([string]$Manifest.baseline.mainArchiveSha256 -cne [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256 -or
        [string]$Manifest.baseline.apiArchiveSha256 -cne [string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256 -or
        [string]$Manifest.baseline.sourceManifestSha256 -cne [string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256 -or
        [string]$Manifest.baseline.treeSha256 -cne [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256 -or
        [string]$Manifest.baseline.treeDigestAlgorithm -cne [string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $Manifest.candidate -Names @(
        'treeSha256','totalFiles','stockFilesExact','customFiles'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    Assert-NebulaPrivateExactProperties -Value $Manifest.deterministicBuildEvidence -Names @(
        'buildPlanDigest','inputFingerprintSha256','metadataASha256','metadataBSha256','matched'
    ) -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    if (-not (Test-NebulaPrivateSha256 -Value ([string]$Manifest.deterministicBuildEvidence.buildPlanDigest)) -or
        [string]$Manifest.deterministicBuildEvidence.inputFingerprintSha256 -cne
            (Get-NebulaPrivateExpectedBuildInputFingerprint) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Manifest.deterministicBuildEvidence.metadataASha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Manifest.deterministicBuildEvidence.metadataBSha256)) -or
        $Manifest.deterministicBuildEvidence.matched -isnot [bool] -or -not $Manifest.deterministicBuildEvidence.matched -or
        [int]$Manifest.candidate.totalFiles -ne 44 -or [int]$Manifest.candidate.stockFilesExact -ne 40 -or
        [int]$Manifest.candidate.customFiles -ne 4) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    $candidateRecords = Get-NebulaPrivatePlainFiles -Root $CandidateRoot
    Assert-NebulaPrivateExactFileSet -Records $candidateRecords -Expected $script:NebulaPrivateExpectedFiles `
        -Code 'NEBULA_PRIVATE_CANDIDATE_FILE_SET_INVALID'
    $candidateTree = Get-NebulaPrivateTreeDigest -Records $candidateRecords
    if ([string]$Manifest.candidate.treeSha256 -cne $candidateTree -or @($Manifest.files).Count -ne 44) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    $recordMap = @{}
    foreach ($record in $candidateRecords) { $recordMap[[string]$record.path] = $record }
    $manifestPaths = @()
    foreach ($file in @($Manifest.files)) {
        Assert-NebulaPrivateExactProperties -Value $file -Names @('path','size','sha256','origin') `
            -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
        $path = [string]$file.path
        $manifestPaths += $path
        if (-not $recordMap.ContainsKey($path)) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID' }
        $record = $recordMap[$path]
        $expectedOrigin = if ($path -cin $script:NebulaPrivateCustomFiles) { 'private-build' } else { 'official-stock' }
        if ([int64]$file.size -ne [int64]$record.size -or [string]$file.sha256 -cne [string]$record.sha256 -or
            [string]$file.origin -cne $expectedOrigin) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
        }
    }
    $expectedPaths = @($script:NebulaPrivateExpectedFiles | Sort-Object -CaseSensitive)
    if (($manifestPaths -join "`n") -cne ($expectedPaths -join "`n")) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    $withoutDigest = [ordered]@{}
    foreach ($property in $Manifest.PSObject.Properties) {
        if ($property.Name -cne 'manifestDigest') { $withoutDigest[$property.Name] = $property.Value }
    }
    if (-not (Test-NebulaPrivateSha256 -Value ([string]$Manifest.manifestDigest)) -or
        [string]$Manifest.manifestDigest -cne (Get-NebulaPrivateObjectSha256 -Value $withoutDigest)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }
    Test-NebulaPrivatePublicText -Value (ConvertTo-NebulaPrivateCanonicalJson -Value $Manifest)
    return [pscustomobject][ordered]@{ candidateTreeSha256 = $candidateTree; files = 44; stockFiles = 40; customFiles = 4 }
}

function Expand-NebulaPrivateZipExact {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)][string]$PackageDirectory,
        [Parameter(Mandatory)][string[]]$ExpectedRelativeFiles,
        [Parameter(Mandatory)][string]$ExpectedArchiveSha256,
        [Parameter(Mandatory)][string]$JobRoot
    )
    $archive = Assert-NebulaPrivateJobPath -Path $ArchivePath -JobRoot $JobRoot
    $destination = Assert-NebulaPrivateJobPath -Path $DestinationRoot -JobRoot $JobRoot
    if ((Get-NebulaPrivateFileSha256 -Path $archive) -cne $ExpectedArchiveSha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OFFICIAL_ARCHIVE_HASH_INVALID'
    }
    if (Test-Path -LiteralPath $destination) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_OUTPUT_ALREADY_EXISTS' }
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $seen = @{}
        foreach ($entry in $zip.Entries) {
            $name = ([string]$entry.FullName).Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ($name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:' -or $name.StartsWith('/') -or
                $name -match '(^|/)[^/]*:' -or $name -match '[\x00-\x1f]') {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
            }
            if ($name.EndsWith('/')) {
                $directoryName = $name.TrimEnd('/')
                $candidateDirectories = @($directoryName)
                if ($directoryName.StartsWith($PackageDirectory + '/', [StringComparison]::OrdinalIgnoreCase)) {
                    $candidateDirectories += $directoryName.Substring($PackageDirectory.Length + 1)
                }
                elseif ($directoryName.Equals($PackageDirectory, [StringComparison]::OrdinalIgnoreCase)) {
                    $candidateDirectories += ''
                }
                $acceptedDirectory = @($candidateDirectories | Where-Object {
                    $relativeDirectory = [string]$_
                    $targetPrefix = if ([string]::IsNullOrEmpty($relativeDirectory)) {
                        $PackageDirectory + '/'
                    } else { $PackageDirectory + '/' + $relativeDirectory + '/' }
                    @($ExpectedRelativeFiles | Where-Object {
                        $_.StartsWith($targetPrefix, [StringComparison]::Ordinal)
                    }).Count -gt 0
                }) | Select-Object -First 1
                if ($null -eq $acceptedDirectory) {
                    Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
                }
                continue
            }
            $candidateNames = @($name)
            if ($name.StartsWith($PackageDirectory + '/', [StringComparison]::OrdinalIgnoreCase)) {
                $candidateNames += $name.Substring($PackageDirectory.Length + 1)
            }
            $relativeInside = @($candidateNames | Where-Object {
                ($PackageDirectory + '/' + $_) -cin $ExpectedRelativeFiles
            }) | Select-Object -First 1
            if ($null -eq $relativeInside) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID' }
            $targetRelative = $PackageDirectory + '/' + [string]$relativeInside
            if ($seen.ContainsKey($targetRelative.ToLowerInvariant())) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ARCHIVE_DUPLICATE_ENTRY'
            }
            $seen[$targetRelative.ToLowerInvariant()] = $true
            $target = [IO.Path]::GetFullPath((Join-Path $destination $targetRelative.Replace('/', '\')))
            if (-not (Test-NebulaPrivatePathWithin -Candidate $target -Parent $destination)) {
                Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
            }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            $input = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $input.CopyTo($output) }
            finally { $output.Dispose(); $input.Dispose() }
        }
    }
    catch {
        if (Test-Path -LiteralPath $destination) { [IO.Directory]::Delete($destination, $true) }
        throw
    }
    finally { $zip.Dispose() }
    $records = Get-NebulaPrivatePlainFiles -Root $destination
    Assert-NebulaPrivateExactFileSet -Records $records -Expected $ExpectedRelativeFiles `
        -Code 'NEBULA_PRIVATE_BASELINE_FILE_SET_INVALID'
    return $destination
}

function Test-NebulaPrivatePublicText {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -match '(?i)C:\\Users\\|Program Files|Steam\\steamapps|\\\\[A-Za-z0-9]|(?<![A-Za-z0-9_])(?:password|api[_-]?key|bearer|secret|access[_-]?token)["'']?\s*[:=]') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PUBLIC_HYGIENE_FAILED'
    }
}

function Assert-NebulaPrivateStaticContract {
    if ([string]$script:NebulaPrivateContract.protocol -cne 'DYSON_NEBULA_PRIVATE_BUILD_CONTRACT_V1' -or
        [int]$script:NebulaPrivateContract.schemaVersion -ne 1 -or
        $script:NebulaPrivateMainFiles.Count -ne 38 -or $script:NebulaPrivateApiFiles.Count -ne 6 -or
        $script:NebulaPrivateExpectedFiles.Count -ne 44 -or $script:NebulaPrivateCustomFiles.Count -ne 4 -or
        [int]$script:NebulaPrivateContract.candidate.mainFileCount -ne 38 -or
        [int]$script:NebulaPrivateContract.candidate.apiFileCount -ne 6 -or
        [int]$script:NebulaPrivateContract.candidate.totalFileCount -ne 44 -or
        [int]$script:NebulaPrivateContract.candidate.stockFileCount -ne 40) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STATIC_CONTRACT_INVALID'
    }
    foreach ($collection in @(
        @($script:NebulaPrivateExpectedFiles),
        @($script:NebulaPrivateCustomFiles),
        @($script:NebulaPrivateContract.sourcePatch.patchedFiles)
    )) {
        $values = @($collection | ForEach-Object { [string]$_ })
        if (@($values | Sort-Object -Unique -CaseSensitive).Count -ne $values.Count) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STATIC_CONTRACT_INVALID'
        }
    }
    foreach ($custom in $script:NebulaPrivateCustomFiles) {
        if ([string]$custom -cnotin $script:NebulaPrivateExpectedFiles) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STATIC_CONTRACT_INVALID'
        }
    }
    foreach ($digest in @(
        [string]$script:NebulaPrivateContract.sourcePatch.contractSha256,
        [string]$script:NebulaPrivateContract.sourcePatch.patchSha256,
        [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256,
        [string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256,
        [string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256,
        [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256
    )) {
        if (-not (Test-NebulaPrivateSha256 -Value $digest)) {
            Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STATIC_CONTRACT_INVALID'
        }
    }
    if ([string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm -cne
        'sha256(ordinal-sorted(path + NUL + invariant-decimal-size + NUL + lowercase-file-sha256 + LF))') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_STATIC_CONTRACT_INVALID'
    }
}

Assert-NebulaPrivateStaticContract
