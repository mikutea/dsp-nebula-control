Set-StrictMode -Version 2.0

$script:DysonBridgePlatformSecurityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $script:DysonBridgePlatformSecurityModulePath -PathType Leaf)) {
    throw 'The platform security module required by Dyson Control Bridge is unavailable.'
}
$script:DysonBridgePlatformSecurityModules = @(
    Import-Module -Name $script:DysonBridgePlatformSecurityModulePath -PassThru -ErrorAction Stop
)
if ($script:DysonBridgePlatformSecurityModules.Count -ne 1 -or
    -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$script:DysonBridgePlatformSecurityModules[0].Path),
        [System.IO.Path]::GetFullPath($script:DysonBridgePlatformSecurityModulePath),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not $script:DysonBridgePlatformSecurityModules[0].ExportedCommands.ContainsKey('Get-Acl') -or
    -not $script:DysonBridgePlatformSecurityModules[0].ExportedCommands.ContainsKey('Set-Acl')) {
    throw 'The platform security module required by Dyson Control Bridge has an invalid identity.'
}

$script:DysonBridgeCandidateProtocol = 'DYSON_CONTROL_BRIDGE_CANDIDATE_V1'
$script:DysonBridgeInstallProtocol = 'DYSON_CONTROL_BRIDGE_INSTALL_V1'
$script:DysonBridgeGuid = 'io.github.mikutea.dyson-control-bridge'
$script:DysonBridgeName = 'Dyson Control Bridge'
$script:DysonBridgeAssemblyName = 'DysonControlBridge'
$script:DysonBridgeDllName = 'DysonControlBridge.dll'
$script:DysonBridgeManifestName = 'bridge-manifest.json'
$script:DysonBridgeConfigName = 'io.github.mikutea.dyson-control-bridge.cfg'
$script:DysonBridgeStateName = 'dyson-control-bridge.install.json'
$script:DysonBridgeSecretName = 'dyson-control-bridge.secret'
$script:DysonBridgeMaximumAssemblyBytes = [int64](64MB)

function ConvertTo-DysonBridgeJsonLine {
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)
    process { return $Value | ConvertTo-Json -Depth 12 -Compress }
}

function Get-DysonBridgeFullPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0) {
        throw 'A Bridge path is invalid.'
    }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Test-DysonBridgePathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )
    $candidateFull = (Get-DysonBridgeFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonBridgeFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonBridgeSafeRoot {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
    $full = Get-DysonBridgeFullPath -Path $Path
    $volume = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\', '/'), $volume.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $full
}

function Assert-DysonBridgePathComponentsPlain {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )
    $rootFull = Assert-DysonBridgePlainDirectory -Path $Root
    $target = Get-DysonBridgeFullPath -Path $Path
    if (-not (Test-DysonBridgePathWithin -Candidate $target -Parent $rootFull -AllowEqual)) {
        throw 'A Bridge path escaped its fixed root.'
    }
    $relative = $target.Substring($rootFull.TrimEnd('\', '/').Length).TrimStart('\', '/')
    $current = $rootFull
    foreach ($segment in @($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -in @('.', '..')) { throw 'A Bridge path component is invalid.' }
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'A Bridge path traverses a redirected filesystem entry.'
        }
    }
    return $target
}

function Assert-DysonBridgePlainDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A required Bridge directory is unavailable or redirected.'
    }
    return $item.FullName
}

function Assert-DysonBridgePlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 536870912,
        [switch]$AllowEmpty
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        (-not $AllowEmpty -and $item.Length -lt 1) -or $item.Length -gt $MaximumBytes) {
        throw 'A required Bridge file is unavailable, redirected, or outside its size limit.'
    }
    return $item
}

function Assert-DysonBridgeTreePlain {
    param([Parameter(Mandatory)][string]$Root)
    $rootFull = Assert-DysonBridgePlainDirectory -Path $Root
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
    $pending.Push($rootFull)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'A Bridge tree contains a redirected filesystem entry.'
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            elseif ($item -is [System.IO.FileInfo]) { $files.Add($item) }
            else { throw 'A Bridge tree contains an unsupported filesystem entry.' }
        }
    }
    return @($files)
}

function Get-DysonBridgeSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $item = Assert-DysonBridgePlainFile -Path $Path
    $stream = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}

function Assert-DysonBridgeVersion {
    param([Parameter(Mandatory)][string]$Version)
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        throw 'The Bridge version must be canonical stable semantic version text.'
    }
}

function Assert-DysonBridgeExactProperties {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Expected, [Parameter(Mandatory)][string]$Name)
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $actual) -ne [string]::Join("`n", $expectedSorted)) {
        throw "$Name contains missing or unknown fields."
    }
}

function Get-DysonBridgeReferenceSpecifications {
    return @(
        [ordered]@{ name = 'BepInEx.dll'; relativePath = 'BepInEx\core\BepInEx.dll' },
        [ordered]@{ name = '0Harmony.dll'; relativePath = 'BepInEx\core\0Harmony.dll' },
        [ordered]@{ name = 'UnityEngine.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.dll' },
        [ordered]@{ name = 'UnityEngine.CoreModule.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.CoreModule.dll' },
        [ordered]@{ name = 'Assembly-CSharp.dll'; relativePath = 'DSPGAME_Data\Managed\Assembly-CSharp.dll' },
        [ordered]@{ name = 'NebulaAPI.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerModApi\NebulaAPI.dll' },
        [ordered]@{ name = 'NebulaModel.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaModel.dll' }
    )
}

function Get-DysonBridgeReferenceReceipts {
    param([Parameter(Mandatory)][string]$DysonServerRoot)
    $root = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
    $receipts = @()
    foreach ($specification in @(Get-DysonBridgeReferenceSpecifications)) {
        $path = Get-DysonBridgeFullPath -Path (Join-Path $root ([string]$specification.relativePath))
        if (-not (Test-DysonBridgePathWithin -Candidate $path -Parent $root)) {
            throw 'A fixed Bridge reference escaped the DSP server root.'
        }
        [void](Assert-DysonBridgePathComponentsPlain -Path $path -Root $root)
        $item = Assert-DysonBridgePlainFile -Path $path -MaximumBytes $script:DysonBridgeMaximumAssemblyBytes
        try { $assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($item.FullName) }
        catch { throw 'A fixed Bridge reference is not a managed assembly.' }
        $receipts += [ordered]@{
            name = [string]$specification.name
            relativePath = ([string]$specification.relativePath).Replace('\', '/')
            assemblyName = [string]$assemblyName.Name
            assemblyVersion = [string]$assemblyName.Version
            length = [int64]$item.Length
            sha256 = Get-DysonBridgeSha256 -Path $item.FullName
        }
    }
    return @($receipts)
}

function Get-DysonBridgeSourceContract {
    param([Parameter(Mandatory)][string]$SourceRoot)
    $root = Assert-DysonBridgePlainDirectory -Path $SourceRoot
    $required = @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridgePlugin.cs',
        'GameSaveAdapter.cs', 'PlayerRosterPublisher.cs', 'DysonControlBridge.csproj',
        'dyson-control-bridge.cfg.example', 'README.md'
    )
    $actual = @(Assert-DysonBridgeTreePlain -Root $root | ForEach-Object {
        $_.FullName.Substring($root.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
    } | Sort-Object -CaseSensitive)
    $expected = @($required | Sort-Object -CaseSensitive)
    if ([string]::Join("`n", $actual) -ne [string]::Join("`n", $expected)) {
        throw 'The public Bridge source package contains missing or unexpected files.'
    }

    $projectPath = Join-Path $root 'DysonControlBridge.csproj'
    try { [xml]$project = [System.IO.File]::ReadAllText($projectPath, [System.Text.Encoding]::UTF8) }
    catch { throw 'The Bridge project file is invalid XML.' }
    $projectElement = $project.DocumentElement
    if ($projectElement.LocalName -ne 'Project' -or $projectElement.GetAttribute('Sdk') -ne 'Microsoft.NET.Sdk') {
        throw 'The Bridge project SDK contract is unsupported.'
    }
    $projectChildren = @($projectElement.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
    if (@($projectChildren | Where-Object { $_.LocalName -notin @('PropertyGroup', 'ItemGroup') }).Count -gt 0 -or
        @($projectChildren | Where-Object { $_.LocalName -eq 'PropertyGroup' }).Count -ne 1 -or
        @($projectChildren | Where-Object { $_.LocalName -eq 'ItemGroup' }).Count -ne 1) {
        throw 'The Bridge project may contain only its fixed property and item groups.'
    }
    $properties = @($project.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1)
    if ($properties.Count -ne 1) { throw 'The Bridge project must define one version.' }
    $version = [string]$properties[0].Version
    Assert-DysonBridgeVersion -Version $version
    if ([string]$properties[0].TargetFramework -ne 'net472' -or
        [string]$properties[0].AssemblyName -ne $script:DysonBridgeAssemblyName) {
        throw 'The Bridge project identity or target framework is unsupported.'
    }
    $propertyElements = @($projectChildren | Where-Object { $_.LocalName -eq 'PropertyGroup' } |
        ForEach-Object { $_.ChildNodes } | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
    $expectedPropertyNames = @('AssemblyName', 'DysonServerRoot', 'LangVersion', 'Nullable', 'RootNamespace', 'TargetFramework', 'Version') | Sort-Object -CaseSensitive
    $actualPropertyNames = @($propertyElements | ForEach-Object { $_.LocalName } | Sort-Object -CaseSensitive)
    if ([string]::Join("`n", $actualPropertyNames) -ne [string]::Join("`n", $expectedPropertyNames) -or
        [string]$properties[0].LangVersion -ne '9.0' -or [string]$properties[0].Nullable -ne 'disable' -or
        [string]$properties[0].RootNamespace -ne 'DysonControl.Bridge') {
        throw 'The Bridge project property set is not fixed.'
    }
    foreach ($property in $propertyElements) {
        $condition = $property.GetAttribute('Condition')
        if ($property.LocalName -eq 'DysonServerRoot') {
            if ($condition -ne "'`$(DysonServerRoot)' == ''" -or $property.InnerText -ne '$(MSBuildThisFileDirectory)..\..\..\server') {
                throw 'The Bridge project reference-root fallback is not fixed.'
            }
        }
        elseif (-not [string]::IsNullOrEmpty($condition)) { throw 'A Bridge project property has an unsupported condition.' }
    }

    $pluginText = [System.IO.File]::ReadAllText((Join-Path $root 'DysonControlBridgePlugin.cs'), [System.Text.Encoding]::UTF8)
    $guidMatch = [regex]::Match($pluginText, 'public\s+const\s+string\s+PluginGuid\s*=\s*"(?<value>[^"]+)"\s*;')
    $versionMatch = [regex]::Match($pluginText, 'public\s+const\s+string\s+PluginVersion\s*=\s*"(?<value>[^"]+)"\s*;')
    if (-not $guidMatch.Success -or $guidMatch.Groups['value'].Value -ne $script:DysonBridgeGuid -or
        -not $versionMatch.Success -or $versionMatch.Groups['value'].Value -ne $version -or
        $pluginText -notmatch '\[BepInPlugin\(PluginGuid,\s*PluginName,\s*PluginVersion\)\]') {
        throw 'The Bridge source GUID, plugin attribute, project version, and PluginVersion are inconsistent.'
    }

    $expectedHints = @(Get-DysonBridgeReferenceSpecifications | ForEach-Object { '$(DysonServerRoot)\' + $_.relativePath })
    $itemElements = @($projectChildren | Where-Object { $_.LocalName -eq 'ItemGroup' } |
        ForEach-Object { $_.ChildNodes } | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
    if (@($itemElements | Where-Object { $_.LocalName -eq 'Compile' }).Count -ne 1 -or
        @($itemElements | Where-Object { $_.LocalName -eq 'PackageReference' }).Count -ne 1 -or
        @($itemElements | Where-Object { $_.LocalName -eq 'Reference' }).Count -ne $expectedHints.Count -or
        @($itemElements | Where-Object { $_.LocalName -notin @('Compile', 'PackageReference', 'Reference') }).Count -gt 0) {
        throw 'The Bridge project item set is not fixed.'
    }
    $compile = @($itemElements | Where-Object { $_.LocalName -eq 'Compile' })[0]
    $packageReference = @($itemElements | Where-Object { $_.LocalName -eq 'PackageReference' })[0]
    if ($compile.GetAttribute('Remove') -ne 'protocol-tests\**\*.cs' -or $compile.Attributes.Count -ne 1 -or
        $packageReference.GetAttribute('Include') -ne 'Microsoft.NETFramework.ReferenceAssemblies' -or
        $packageReference.GetAttribute('Version') -ne '1.0.3' -or $packageReference.GetAttribute('PrivateAssets') -ne 'all' -or
        $packageReference.Attributes.Count -ne 3) {
        throw 'The Bridge project compile/package reference set is not fixed.'
    }
    $referenceElements = @($itemElements | Where-Object { $_.LocalName -eq 'Reference' })
    $actualHints = @($referenceElements | ForEach-Object { [string]$_.HintPath })
    if ($actualHints.Count -ne $expectedHints.Count) { throw 'The Bridge project reference set is not fixed.' }
    for ($index = 0; $index -lt $expectedHints.Count; $index++) {
        $expectedInclude = [System.IO.Path]::GetFileNameWithoutExtension((Get-DysonBridgeReferenceSpecifications)[$index].name)
        if ($actualHints[$index] -ne $expectedHints[$index] -or
            $referenceElements[$index].GetAttribute('Include') -ne $expectedInclude -or
            [string]$referenceElements[$index].Private -ne 'false' -or
            $referenceElements[$index].Attributes.Count -ne 1) { throw 'The Bridge project reference set is not fixed.' }
    }

    $sourceReceipts = @()
    foreach ($relative in @($required | Sort-Object -CaseSensitive)) {
        $item = Assert-DysonBridgePlainFile -Path (Join-Path $root $relative) -MaximumBytes 2MB
        $sourceReceipts += [ordered]@{
            path = $relative
            length = [int64]$item.Length
            sha256 = Get-DysonBridgeSha256 -Path $item.FullName
        }
    }
    return [ordered]@{ root = $root; projectPath = $projectPath; version = $version; files = $sourceReceipts }
}

function Get-DysonBridgeAssemblyMetadata {
    param(
        [Parameter(Mandatory)][string]$AssemblyPath,
        [Parameter(Mandatory)][string]$DysonServerRoot
    )
    $item = Assert-DysonBridgePlainFile -Path $AssemblyPath -MaximumBytes $script:DysonBridgeMaximumAssemblyBytes
    try { $assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($item.FullName) }
    catch { throw 'The Bridge candidate DLL is not a managed assembly.' }
    $references = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $DysonServerRoot)
    $referenceByName = @{}
    foreach ($receipt in $references) {
        $path = Join-Path (Get-DysonBridgeFullPath -Path $DysonServerRoot) ([string]$receipt.relativePath).Replace('/', '\')
        $referenceByName[[string]$receipt.assemblyName] = $path
    }
    $handler = [System.ResolveEventHandler]{
        param($sender, $eventArgs)
        try {
            $requested = [System.Reflection.AssemblyName]::new($eventArgs.Name).Name
            if ($referenceByName.ContainsKey($requested)) {
                return [System.Reflection.Assembly]::Load(
                    [System.IO.File]::ReadAllBytes([string]$referenceByName[$requested])
                )
            }
        }
        catch {}
        return $null
    }
    [System.AppDomain]::CurrentDomain.add_AssemblyResolve($handler)
    try {
        $assembly = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($item.FullName))
        $pluginType = $assembly.GetType('DysonControl.Bridge.DysonControlBridgePlugin', $true, $false)
        $guidField = $pluginType.GetField('PluginGuid', [System.Reflection.BindingFlags]'Public, Static')
        $versionField = $pluginType.GetField('PluginVersion', [System.Reflection.BindingFlags]'Public, Static')
        $nameField = $pluginType.GetField('PluginName', [System.Reflection.BindingFlags]'Public, Static')
        if (-not $guidField.IsLiteral -or -not $versionField.IsLiteral -or -not $nameField.IsLiteral) {
            throw 'Bridge identity fields are not compile-time constants.'
        }
        $guid = [string]$guidField.GetRawConstantValue()
        $version = [string]$versionField.GetRawConstantValue()
        $pluginName = [string]$nameField.GetRawConstantValue()
    }
    catch { throw 'The Bridge candidate DLL metadata is invalid.' }
    finally { [System.AppDomain]::CurrentDomain.remove_AssemblyResolve($handler) }
    Assert-DysonBridgeVersion -Version $version
    $fileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName).FileVersion
    return [ordered]@{
        guid = $guid
        name = $pluginName
        version = $version
        assemblyName = [string]$assemblyName.Name
        assemblyVersion = [string]$assemblyName.Version
        fileVersion = [string]$fileVersion
        dllName = $script:DysonBridgeDllName
        length = [int64]$item.Length
        sha256 = Get-DysonBridgeSha256 -Path $item.FullName
    }
}

function Write-DysonBridgeCandidateManifest {
    param(
        [Parameter(Mandatory)][string]$CandidateRoot,
        [Parameter(Mandatory)]$Plugin,
        [Parameter(Mandatory)]$References,
        [Parameter(Mandatory)]$Sources
    )
    $manifest = [ordered]@{
        protocol = $script:DysonBridgeCandidateProtocol
        schemaVersion = 1
        plugin = $Plugin
        references = @($References)
        sources = @($Sources)
        build = [ordered]@{ configuration = 'Release'; targetFramework = 'net472'; deterministic = $true }
        files = @([ordered]@{ path = $script:DysonBridgeDllName; length = [int64]$Plugin.length; sha256 = [string]$Plugin.sha256 })
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $CandidateRoot $script:DysonBridgeManifestName),
        ($manifest | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    return $manifest
}

function Read-DysonBridgeCandidateManifest {
    param([Parameter(Mandatory)][string]$CandidateRoot)
    $item = Assert-DysonBridgePlainFile -Path (Join-Path $CandidateRoot $script:DysonBridgeManifestName) -MaximumBytes 1MB
    try { return [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'The Bridge candidate manifest is invalid JSON.' }
}

function Test-DysonBridgeCandidateCore {
    param(
        [Parameter(Mandatory)][string]$CandidateRoot,
        [Parameter(Mandatory)][string]$DysonServerRoot,
        [string]$ExpectedVersion
    )
    $root = Assert-DysonBridgePlainDirectory -Path $CandidateRoot
    $rootEntries = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
    if ($rootEntries.Count -ne 2 -or @($rootEntries | Where-Object { $_.PSIsContainer }).Count -ne 0) {
        throw 'The Bridge candidate contains unexpected filesystem entries.'
    }
    $files = @(Assert-DysonBridgeTreePlain -Root $root)
    $names = @($files | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $expectedNames = @($script:DysonBridgeDllName, $script:DysonBridgeManifestName) | Sort-Object -CaseSensitive
    if ([string]::Join("`n", $names) -ne [string]::Join("`n", $expectedNames) -or $files.Count -ne 2) {
        throw 'The Bridge candidate contains missing or unexpected files.'
    }
    if (@($files | Where-Object { $_.Extension -in @('.pdb', '.exe') }).Count -gt 0) {
        throw 'The Bridge candidate contains a forbidden build output.'
    }
    $manifest = Read-DysonBridgeCandidateManifest -CandidateRoot $root
    Assert-DysonBridgeExactProperties -Value $manifest -Expected @('protocol', 'schemaVersion', 'plugin', 'references', 'sources', 'build', 'files') -Name 'Bridge candidate manifest'
    Assert-DysonBridgeExactProperties -Value $manifest.plugin -Expected @('guid', 'name', 'version', 'assemblyName', 'assemblyVersion', 'fileVersion', 'dllName', 'length', 'sha256') -Name 'Bridge plugin manifest'
    Assert-DysonBridgeExactProperties -Value $manifest.build -Expected @('configuration', 'targetFramework', 'deterministic') -Name 'Bridge build manifest'
    if ([string]$manifest.protocol -ne $script:DysonBridgeCandidateProtocol -or [int]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.plugin.guid -ne $script:DysonBridgeGuid -or [string]$manifest.plugin.name -ne $script:DysonBridgeName -or
        [string]$manifest.plugin.assemblyName -ne $script:DysonBridgeAssemblyName -or
        [string]$manifest.plugin.dllName -ne $script:DysonBridgeDllName -or
        [string]$manifest.build.configuration -ne 'Release' -or [string]$manifest.build.targetFramework -ne 'net472' -or
        -not [bool]$manifest.build.deterministic) {
        throw 'The Bridge candidate manifest contract is unsupported.'
    }
    Assert-DysonBridgeVersion -Version ([string]$manifest.plugin.version)
    if ($ExpectedVersion -and [string]$manifest.plugin.version -cne $ExpectedVersion) { throw 'The Bridge candidate version does not match.' }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne 1) { throw 'The Bridge candidate file inventory is invalid.' }
    Assert-DysonBridgeExactProperties -Value $manifestFiles[0] -Expected @('path', 'length', 'sha256') -Name 'Bridge candidate file entry'
    $dll = Join-Path $root $script:DysonBridgeDllName
    $plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath $dll -DysonServerRoot $DysonServerRoot
    foreach ($property in @('guid', 'name', 'version', 'assemblyName', 'assemblyVersion', 'fileVersion', 'dllName', 'sha256')) {
        if ([string]$manifest.plugin.$property -cne [string]$plugin.$property) { throw 'The Bridge candidate DLL metadata no longer matches its manifest.' }
    }
    if ([int64]$manifest.plugin.length -ne [int64]$plugin.length -or
        [string]$manifestFiles[0].path -ne $script:DysonBridgeDllName -or
        [int64]$manifestFiles[0].length -ne [int64]$plugin.length -or
        [string]$manifestFiles[0].sha256 -ne [string]$plugin.sha256) {
        throw 'The Bridge candidate DLL inventory no longer matches its manifest.'
    }
    if ($plugin.guid -ne $script:DysonBridgeGuid -or $plugin.name -ne $script:DysonBridgeName -or
        $plugin.assemblyName -ne $script:DysonBridgeAssemblyName -or $plugin.version -ne [string]$manifest.plugin.version -or
        $plugin.assemblyVersion -ne ($plugin.version + '.0') -or $plugin.fileVersion -ne ($plugin.version + '.0')) {
        throw 'The Bridge candidate DLL identity is unsupported.'
    }
    $actualReferences = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $DysonServerRoot)
    $expectedReferences = @($manifest.references)
    if ($expectedReferences.Count -ne $actualReferences.Count) { throw 'The Bridge reference receipt set is incomplete.' }
    for ($index = 0; $index -lt $expectedReferences.Count; $index++) {
        Assert-DysonBridgeExactProperties -Value $expectedReferences[$index] -Expected @('name', 'relativePath', 'assemblyName', 'assemblyVersion', 'length', 'sha256') -Name 'Bridge reference receipt'
        foreach ($property in @('name', 'relativePath', 'assemblyName', 'assemblyVersion', 'sha256')) {
            if ([string]$expectedReferences[$index].$property -cne [string]$actualReferences[$index].$property) {
                throw 'The local Bridge reference assemblies no longer match the candidate.'
            }
        }
        if ([int64]$expectedReferences[$index].length -ne [int64]$actualReferences[$index].length) {
            throw 'The local Bridge reference assemblies no longer match the candidate.'
        }
    }
    $sources = @($manifest.sources)
    $expectedSourceNames = @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridge.csproj',
        'DysonControlBridgePlugin.cs', 'GameSaveAdapter.cs', 'PlayerRosterPublisher.cs',
        'README.md', 'dyson-control-bridge.cfg.example'
    ) | Sort-Object -CaseSensitive
    if ($sources.Count -ne $expectedSourceNames.Count) { throw 'The Bridge source receipt set is incomplete.' }
    for ($sourceIndex = 0; $sourceIndex -lt $sources.Count; $sourceIndex++) {
        $source = $sources[$sourceIndex]
        Assert-DysonBridgeExactProperties -Value $source -Expected @('path', 'length', 'sha256') -Name 'Bridge source receipt'
        if ([string]$source.path -cne $expectedSourceNames[$sourceIndex] -or
            [int64]$source.length -lt 1 -or [int64]$source.length -gt 2MB -or
            [string]$source.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'A Bridge source receipt is invalid.' }
    }
    return [ordered]@{
        protocol = $script:DysonBridgeCandidateProtocol
        ready = $true
        guid = $plugin.guid
        version = $plugin.version
        dllSha256 = $plugin.sha256
        referenceCount = $actualReferences.Count
        proprietaryAssembliesPackaged = $false
    }
}

function Assert-DysonBridgeGameStopped {
    param([Parameter(Mandatory)][string]$DysonServerRoot)
    $root = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
    $gamePath = Get-DysonBridgeFullPath -Path (Join-Path $root 'DSPGAME.exe')
    [void](Assert-DysonBridgePathComponentsPlain -Path $gamePath -Root $root)
    [void](Assert-DysonBridgePlainFile -Path $gamePath -MaximumBytes 2GB)
    try { $processes = @([System.Diagnostics.Process]::GetProcessesByName('DSPGAME')) }
    catch { throw 'DSP process state could not be verified.' }
    foreach ($process in $processes) {
        try {
            try { $processPath = [string]$process.MainModule.FileName } catch { throw 'DSP process state could not be verified.' }
            if ([string]::IsNullOrWhiteSpace($processPath)) {
                throw 'DSP process state could not be verified.'
            }
            $runningPath = Get-DysonBridgeFullPath -Path $processPath
            if ([string]::Equals($runningPath, $gamePath, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The exact DSPGAME.exe target must be stopped before this operation.'
            }
        }
        finally { $process.Dispose() }
    }
    return $gamePath
}

function Write-DysonBridgeAtomicText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Value)
    $parent = Assert-DysonBridgePlainDirectory -Path ([System.IO.Path]::GetDirectoryName($Path))
    $target = Get-DysonBridgeFullPath -Path $Path
    if (-not (Test-DysonBridgePathWithin -Candidate $target -Parent $parent)) { throw 'A Bridge write escaped its fixed directory.' }
    $temporary = Join-Path $parent ('.dyson-bridge-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporary, $Value, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            [System.IO.File]::Replace($temporary, $target, $null, $true)
        }
        elseif (Test-Path -LiteralPath $target) { throw 'A Bridge text publish target is not a regular file.' }
        else { [System.IO.File]::Move($temporary, $target) }
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Publish-DysonBridgeFile {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    $sourceItem = Assert-DysonBridgePlainFile -Path $Source -MaximumBytes 64MB
    $parent = Assert-DysonBridgePlainDirectory -Path ([System.IO.Path]::GetDirectoryName($Destination))
    $target = Get-DysonBridgeFullPath -Path $Destination
    if (-not (Test-DysonBridgePathWithin -Candidate $target -Parent $parent)) { throw 'A Bridge publish escaped its fixed directory.' }
    $temporary = Join-Path $parent ('.dyson-bridge-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::Copy($sourceItem.FullName, $temporary, $false)
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            [System.IO.File]::Replace($temporary, $target, $null, $true)
        }
        elseif (Test-Path -LiteralPath $target) { throw 'A Bridge publish target is not a regular file.' }
        else { [System.IO.File]::Move($temporary, $target) }
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Read-DysonBridgeInstallState {
    param([Parameter(Mandatory)][string]$Path)
    $item = Assert-DysonBridgePlainFile -Path $Path -MaximumBytes 1MB
    try { $state = [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'The Bridge installation state is invalid JSON.' }
    Assert-DysonBridgeExactProperties -Value $state -Expected @(
        'protocol', 'schemaVersion', 'guid', 'version', 'dllSha256', 'configSha256',
        'templateSha256', 'installedAtUtc', 'snapshotId', 'enabledDefault'
    ) -Name 'Bridge installation state'
    if ([string]$state.protocol -ne $script:DysonBridgeInstallProtocol -or [int]$state.schemaVersion -ne 1 -or
        [string]$state.guid -ne $script:DysonBridgeGuid -or [string]$state.dllSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$state.configSha256 -notmatch '^[0-9a-f]{64}$' -or [string]$state.templateSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$state.snapshotId -notmatch '^[0-9]{17}-[0-9a-f]{8}$' -or [bool]$state.enabledDefault -ne $false) {
        throw 'The Bridge installation state contract is unsupported.'
    }
    Assert-DysonBridgeVersion -Version ([string]$state.version)
    return $state
}

function Protect-DysonBridgeSecretAcl {
    param([Parameter(Mandatory)][string]$SecretPath, [string[]]$ReaderSids)
    $item = Assert-DysonBridgePlainFile -Path $SecretPath -MaximumBytes 4096
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sids = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    [void]$sids.Add($identity.User.Value)
    [void]$sids.Add('S-1-5-18')
    [void]$sids.Add('S-1-5-32-544')
    foreach ($sid in @($ReaderSids)) {
        if ([string]$sid -notmatch '^S-1-(?:[0-9]+-){1,14}[0-9]+$') { throw 'A Bridge secret reader SID is invalid.' }
        [void]$sids.Add([string]$sid)
    }
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sidText in $sids) {
        $sidObject = [System.Security.Principal.SecurityIdentifier]::new($sidText)
        $rights = if ($sidText -in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            [System.Security.AccessControl.FileSystemRights]::FullControl
        }
        else { [System.Security.AccessControl.FileSystemRights]::Read }
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sidObject, $rights, [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule) | Out-Null
    }
    Microsoft.PowerShell.Security\Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
    $verified = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if (-not $verified.AreAccessRulesProtected) { throw 'The Bridge secret ACL could not be restricted.' }
    foreach ($rule in @($verified.Access)) {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if (-not $sids.Contains($sid) -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            throw 'The Bridge secret ACL could not be verified.'
        }
    }
}

function Invoke-DysonBridgeProcess {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [ValidateRange(1000, 600000)][int]$TimeoutMilliseconds = 180000,
        [ValidateRange(1024, 1048576)][int]$MaximumOutputCharacters = 262144,
        [hashtable]$Environment = @{}
    )
    $executablePath = (Assert-DysonBridgePlainFile -Path $Executable -MaximumBytes 512MB).FullName
    $working = Assert-DysonBridgePlainDirectory -Path $WorkingDirectory
    $process = $null
    try {
        $info = [System.Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $executablePath
        $info.Arguments = $Arguments
        $info.WorkingDirectory = $working
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        foreach ($name in @($info.EnvironmentVariables.Keys | ForEach-Object { [string]$_ })) {
            if ($name -match '^(?i:MSBUILD|DOTNET|NUGET|COMPLUS_)') { [void]$info.EnvironmentVariables.Remove($name) }
        }
        foreach ($entry in @($Environment.GetEnumerator())) { $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value }
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $info
        if (-not $process.Start()) { throw 'start failed' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            try { $process.WaitForExit() } catch {}
            throw 'timeout'
        }
        $process.WaitForExit()
        $stdout = [string]$stdoutTask.GetAwaiter().GetResult()
        $stderr = [string]$stderrTask.GetAwaiter().GetResult()
        if ($stdout.Length -gt $MaximumOutputCharacters -or $stderr.Length -gt $MaximumOutputCharacters -or $process.ExitCode -ne 0) {
            throw 'process rejected'
        }
        return [ordered]@{ exitCode = 0; stdout = $stdout; stderr = $stderr }
    }
    catch { throw 'The controlled Bridge build process failed.' }
    finally { if ($process) { $process.Dispose() } }
}
