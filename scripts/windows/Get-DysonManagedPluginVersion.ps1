[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][ValidateSet('bridge', 'control')][string]$Component
)

# DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1: read one fixed managed DLL informational release version only.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$fixedPlugins = @{
    bridge = [ordered]@{
        directoryName = 'dyson-control-bridge'
        fileName = 'DysonControlBridge.dll'
        assemblyName = 'DysonControlBridge'
        relativePath = 'plugins/dyson-control-bridge/DysonControlBridge.dll'
    }
    control = [ordered]@{
        directoryName = 'dyson-control'
        fileName = 'DysonControl.dll'
        assemblyName = 'DysonControl'
        relativePath = 'plugins/dyson-control/DysonControl.dll'
    }
}

function Get-NormalDirectory {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child
    )

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Parent $Child))
    try { $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop }
    catch { throw 'A fixed managed plugin directory is unavailable.' }
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A fixed managed plugin directory is redirected or invalid.'
    }
    return $item.FullName
}

try { $projectItem = Get-Item -LiteralPath ([System.IO.Path]::GetFullPath($ProjectRoot)) -Force -ErrorAction Stop }
catch { throw 'The fixed project root is unavailable.' }
if (-not $projectItem.PSIsContainer -or ($projectItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed project root is redirected or invalid.'
}
$resolvedProjectRoot = $projectItem.FullName
$serverRoot = Get-NormalDirectory -Parent $resolvedProjectRoot -Child 'server'
$bepInExRoot = Get-NormalDirectory -Parent $serverRoot -Child 'BepInEx'
$pluginsRoot = Get-NormalDirectory -Parent $bepInExRoot -Child 'plugins'

$identity = $fixedPlugins[$Component]
$directoryName = [string]$identity.directoryName
$fileName = [string]$identity.fileName
$assemblyName = [string]$identity.assemblyName
$relativePath = [string]$identity.relativePath
$pluginDirectory = [System.IO.Path]::GetFullPath((Join-Path $pluginsRoot $directoryName))
if (-not [System.IO.Path]::GetDirectoryName($pluginDirectory).Equals(
    $pluginsRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The fixed managed plugin path escaped its allowlisted directory.'
}

try { $pluginDirectoryItem = Get-Item -LiteralPath $pluginDirectory -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] {
    [ordered]@{
        protocol = 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1'
        component = $Component
        fileName = $fileName
        relativePath = $relativePath
        state = 'absent'
        version = $null
    } | ConvertTo-Json -Depth 2 -Compress
    exit 0
}
catch { throw 'The fixed managed plugin directory is unavailable.' }
if (-not $pluginDirectoryItem.PSIsContainer -or
    ($pluginDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    -not $pluginDirectoryItem.Name.Equals($directoryName, [System.StringComparison]::Ordinal)) {
    throw 'The fixed managed plugin directory is redirected or invalid.'
}
$pluginDirectory = $pluginDirectoryItem.FullName
$expectedPath = [System.IO.Path]::GetFullPath((Join-Path $pluginDirectory $fileName))
if (-not [System.IO.Path]::GetDirectoryName($expectedPath).Equals(
    $pluginDirectory,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The fixed managed plugin file escaped its allowlisted directory.'
}

try {
    $matches = @(
        [System.IO.Directory]::EnumerateFileSystemEntries($pluginDirectory) |
            Where-Object {
                [System.IO.Path]::GetFileName($_).Equals($fileName, [System.StringComparison]::OrdinalIgnoreCase)
            }
    )
}
catch { throw 'The fixed managed plugin file is unavailable.' }
if ($matches.Count -eq 0) {
    [ordered]@{
        protocol = 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1'
        component = $Component
        fileName = $fileName
        relativePath = $relativePath
        state = 'absent'
        version = $null
    } | ConvertTo-Json -Depth 2 -Compress
    exit 0
}
if ($matches.Count -ne 1) { throw 'The fixed managed plugin file is ambiguous.' }
try { $pluginItem = Get-Item -LiteralPath $matches[0] -Force -ErrorAction Stop }
catch { throw 'The fixed managed plugin file is unavailable.' }
if ($pluginItem.PSIsContainer -or ($pluginItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed managed plugin file is redirected or not a regular file.'
}
if (-not $pluginItem.Directory.FullName.Equals($pluginDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $pluginItem.Name.Equals($fileName, [System.StringComparison]::Ordinal)) {
    throw 'The fixed managed plugin identity is invalid.'
}

try {
    $managedIdentity = [System.Reflection.AssemblyName]::GetAssemblyName($pluginItem.FullName)
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($pluginItem.FullName)
}
catch { throw 'The fixed managed plugin version is unavailable.' }
if ([string]$managedIdentity.Name -cne $assemblyName) {
    throw 'The fixed managed plugin assembly identity is invalid.'
}
$version = [string]$versionInfo.ProductVersion
if ([string]::IsNullOrWhiteSpace($version) -or $version.Length -gt 64 -or
    $version -notmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.(?:0|[1-9][0-9]*))?$') {
    throw 'The fixed managed plugin version is invalid.'
}

[ordered]@{
    protocol = 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1'
    component = $Component
    fileName = $fileName
    relativePath = $relativePath
    state = 'available'
    version = $version
} | ConvertTo-Json -Depth 2 -Compress
