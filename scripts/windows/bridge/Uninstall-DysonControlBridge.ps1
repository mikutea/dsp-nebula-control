[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$DysonServerRoot,
    [ValidatePattern('^[0-9]{17}-[0-9a-f]{8}$')][string]$RestoreSnapshotId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$serverRoot = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
[void](Assert-DysonBridgeGameStopped -DysonServerRoot $serverRoot)
$pluginRoot = Get-DysonBridgeFullPath -Path (Join-Path $serverRoot 'BepInEx\plugins\dyson-control-bridge')
$pluginPath = Join-Path $pluginRoot $script:DysonBridgeDllName
$configRoot = Assert-DysonBridgePlainDirectory -Path (Join-Path $serverRoot 'BepInEx\config')
$configPath = Join-Path $configRoot $script:DysonBridgeConfigName
$statePath = Join-Path $configRoot $script:DysonBridgeStateName
$snapshotParent = Get-DysonBridgeFullPath -Path (Join-Path $configRoot 'dyson-control-bridge-snapshots')
$auditPath = Join-Path $configRoot 'dyson-control-bridge.audit.jsonl'
foreach ($fixed in @($pluginRoot, $pluginPath, $configPath, $statePath, $snapshotParent, $auditPath)) {
    [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
}

if ($RestoreSnapshotId) {
    $snapshotRoot = Get-DysonBridgeFullPath -Path (Join-Path $snapshotParent $RestoreSnapshotId)
    if (-not (Test-DysonBridgePathWithin -Candidate $snapshotRoot -Parent $snapshotParent)) { throw 'RestoreSnapshotId escaped the fixed snapshot directory.' }
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotRoot)
    $manifestPath = Join-Path $snapshotRoot 'uninstall-manifest.json'
    $manifestItem = Assert-DysonBridgePlainFile -Path $manifestPath -MaximumBytes 1MB
    try { $manifest = [System.IO.File]::ReadAllText($manifestItem.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'The Bridge uninstall snapshot manifest is invalid JSON.' }
    Assert-DysonBridgeExactProperties -Value $manifest -Expected @('protocol', 'schemaVersion', 'snapshotId', 'files') -Name 'Bridge uninstall snapshot'
    if ([string]$manifest.protocol -ne $script:DysonBridgeInstallProtocol -or [int]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.snapshotId -ne $RestoreSnapshotId) { throw 'The Bridge uninstall snapshot contract is unsupported.' }
    $fileMap = @{}
    foreach ($file in @($manifest.files)) {
        Assert-DysonBridgeExactProperties -Value $file -Expected @('name', 'length', 'sha256') -Name 'Bridge uninstall snapshot file'
        if ([string]$file.name -notin @($script:DysonBridgeDllName, $script:DysonBridgeConfigName, $script:DysonBridgeStateName) -or
            $fileMap.ContainsKey([string]$file.name) -or [string]$file.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'The Bridge uninstall snapshot file inventory is invalid.'
        }
        $source = Join-Path $snapshotRoot ([string]$file.name)
        $item = Assert-DysonBridgePlainFile -Path $source -MaximumBytes 64MB
        if ($item.Length -ne [int64]$file.length -or (Get-DysonBridgeSha256 -Path $source) -ne [string]$file.sha256) {
            throw 'The Bridge uninstall snapshot has changed.'
        }
        $fileMap[[string]$file.name] = $source
    }
    foreach ($required in @($script:DysonBridgeDllName, $script:DysonBridgeConfigName, $script:DysonBridgeStateName)) {
        if (-not $fileMap.ContainsKey($required)) { throw 'The Bridge uninstall snapshot is incomplete.' }
    }
    foreach ($target in @($pluginPath, $configPath, $statePath)) {
        if (Test-Path -LiteralPath $target) { throw 'A Bridge uninstall snapshot can be restored only while the fixed install files are absent.' }
    }
    $snapshotState = Read-DysonBridgeInstallState -Path $fileMap[$script:DysonBridgeStateName]
    $snapshotPlugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath $fileMap[$script:DysonBridgeDllName] -DysonServerRoot $serverRoot
    if ($snapshotPlugin.guid -ne $script:DysonBridgeGuid -or $snapshotPlugin.version -ne [string]$snapshotState.version -or
        $snapshotPlugin.sha256 -ne [string]$snapshotState.dllSha256) {
        throw 'The Bridge uninstall snapshot DLL does not match its saved installation state.'
    }
    if (-not $PSCmdlet.ShouldProcess($script:DysonBridgeGuid, "restore Bridge uninstall snapshot $RestoreSnapshotId")) {
        [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; state = 'restore-preview'; dryRun = $true; snapshotId = $RestoreSnapshotId; productionChanged = $false } |
            ConvertTo-DysonBridgeJsonLine
        exit 0
    }
    try {
        [System.IO.Directory]::CreateDirectory($pluginRoot) | Out-Null
        [void](Assert-DysonBridgePlainDirectory -Path $pluginRoot)
        Publish-DysonBridgeFile -Source $fileMap[$script:DysonBridgeDllName] -Destination $pluginPath
        Publish-DysonBridgeFile -Source $fileMap[$script:DysonBridgeConfigName] -Destination $configPath
        Publish-DysonBridgeFile -Source $fileMap[$script:DysonBridgeStateName] -Destination $statePath
        [void](& (Join-Path $PSScriptRoot 'Test-DysonControlBridgeInstallation.ps1') -DysonServerRoot $serverRoot)
    }
    catch {
        foreach ($target in @($pluginPath, $configPath, $statePath)) {
            if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        }
        throw
    }
    $audit = [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; operation = 'restore-uninstall'; outcome = 'succeeded'; snapshotId = $RestoreSnapshotId; atUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($auditPath, $audit + "`r`n", [System.Text.UTF8Encoding]::new($false))
    [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; state = 'restored'; snapshotId = $RestoreSnapshotId; gameRestarted = $false; savesChanged = $false; nebulaChanged = $false; gsmChanged = $false } |
        ConvertTo-DysonBridgeJsonLine
    exit 0
}

$state = Read-DysonBridgeInstallState -Path $statePath
[void](& (Join-Path $PSScriptRoot 'Test-DysonControlBridgeInstallation.ps1') -DysonServerRoot $serverRoot)
if (-not $PSCmdlet.ShouldProcess($script:DysonBridgeGuid, 'snapshot and uninstall only the Dyson Control Bridge plugin and fixed configuration')) {
    [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; state = 'uninstall-preview'; dryRun = $true; version = $state.version; secretWillBePreserved = $true; gameWillBeRestarted = $false; productionChanged = $false } |
        ConvertTo-DysonBridgeJsonLine
    exit 0
}

$snapshotId = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$snapshotRoot = Join-Path $snapshotParent $snapshotId
$removed = $false
try {
    [System.IO.Directory]::CreateDirectory($snapshotParent) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotParent)
    [System.IO.Directory]::CreateDirectory($snapshotRoot) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotRoot)
    $inventory = @()
    foreach ($entry in @(
        [ordered]@{ path = $pluginPath; name = $script:DysonBridgeDllName },
        [ordered]@{ path = $configPath; name = $script:DysonBridgeConfigName },
        [ordered]@{ path = $statePath; name = $script:DysonBridgeStateName }
    )) {
        $item = Assert-DysonBridgePlainFile -Path $entry.path -MaximumBytes 64MB
        $target = Join-Path $snapshotRoot ([string]$entry.name)
        [System.IO.File]::Copy($item.FullName, $target, $false)
        $inventory += [ordered]@{ name = [string]$entry.name; length = [int64]$item.Length; sha256 = Get-DysonBridgeSha256 -Path $target }
    }
    $snapshotManifest = [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; schemaVersion = 1; snapshotId = $snapshotId; files = $inventory }
    Write-DysonBridgeAtomicText -Path (Join-Path $snapshotRoot 'uninstall-manifest.json') -Value (($snapshotManifest | ConvertTo-Json -Depth 8 -Compress) + "`r`n")
    foreach ($path in @($pluginPath, $configPath, $statePath)) { Remove-Item -LiteralPath $path -Force }
    $removed = $true
    if (Test-Path -LiteralPath $pluginRoot -PathType Container) {
        $remaining = @(Get-ChildItem -LiteralPath $pluginRoot -Force -ErrorAction Stop)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $pluginRoot -Force }
    }
    $audit = [ordered]@{ protocol = $script:DysonBridgeInstallProtocol; operation = 'uninstall'; outcome = 'succeeded'; version = $state.version; snapshotId = $snapshotId; atUtc = (Get-Date).ToUniversalTime().ToString('o'); secretPreserved = $true } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($auditPath, $audit + "`r`n", [System.Text.UTF8Encoding]::new($false))
}
catch {
    $uninstallError = $_
    if ($removed -or (Test-Path -LiteralPath $snapshotRoot -PathType Container)) {
        foreach ($entry in @(
            [ordered]@{ source = Join-Path $snapshotRoot $script:DysonBridgeDllName; target = $pluginPath },
            [ordered]@{ source = Join-Path $snapshotRoot $script:DysonBridgeConfigName; target = $configPath },
            [ordered]@{ source = Join-Path $snapshotRoot $script:DysonBridgeStateName; target = $statePath }
        )) {
            if (Test-Path -LiteralPath $entry.source -PathType Leaf) {
                if ([string]$entry.target -eq $pluginPath -and -not (Test-Path -LiteralPath $pluginRoot)) { [System.IO.Directory]::CreateDirectory($pluginRoot) | Out-Null }
                Publish-DysonBridgeFile -Source $entry.source -Destination $entry.target
            }
        }
    }
    throw $uninstallError
}

[ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'uninstalled-recoverable'
    version = $state.version
    snapshotId = $snapshotId
    restoreCommandAvailable = $true
    secretPreserved = $true
    gameRestarted = $false
    savesChanged = $false
    nebulaChanged = $false
    gsmChanged = $false
} | ConvertTo-DysonBridgeJsonLine
