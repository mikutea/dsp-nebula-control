[CmdletBinding()]
param([Parameter(Mandatory)][string]$DysonServerRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$serverRoot = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
$pluginPath = Join-Path $serverRoot ('BepInEx\plugins\dyson-control-bridge\' + $script:DysonBridgeDllName)
$configRoot = Assert-DysonBridgePlainDirectory -Path (Join-Path $serverRoot 'BepInEx\config')
$configPath = Join-Path $configRoot $script:DysonBridgeConfigName
$statePath = Join-Path $configRoot $script:DysonBridgeStateName
foreach ($fixed in @($pluginPath, $configPath, $statePath)) {
    [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
}
$state = Read-DysonBridgeInstallState -Path $statePath
$runtime = Get-DysonBridgeInstallRuntimePaths -State $state -DysonServerRoot $serverRoot
$secretPath = [string]$runtime.secretPath
$controlRoot = [string]$runtime.controlRoot
if ([int]$state.schemaVersion -eq 2) {
    foreach ($fixed in @($secretPath, $controlRoot)) {
        [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
    }
}
$privateRuntimeAclProtected = $false
if ([int]$state.schemaVersion -eq 3) {
    [void](Test-DysonBridgePrivateRuntimeContainerAcl -RuntimeContainer ([string]$runtime.runtimeContainer) `
        -InstallerSid ([string]$state.installerSid) -ControlServiceSid ([string]$state.controlServiceSid) `
        -GameServiceSid ([string]$state.gameServiceSid))
    [void](Assert-DysonBridgeExactAcl -Path ([string]$runtime.runtimeRoot) -Kind runtime `
        -InstallerSid ([string]$state.installerSid) -ControlServiceSid ([string]$state.controlServiceSid) `
        -GameServiceSid ([string]$state.gameServiceSid))
    $privateRuntimeAclProtected = $true
}
$plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath $pluginPath -DysonServerRoot $serverRoot
if ($plugin.guid -ne $script:DysonBridgeGuid -or $plugin.version -ne [string]$state.version -or
    $plugin.sha256 -ne [string]$state.dllSha256) {
    throw 'The installed Bridge DLL no longer matches installation state.'
}
$configItem = Assert-DysonBridgePlainFile -Path $configPath -MaximumBytes 64KB
$configText = [System.IO.File]::ReadAllText($configItem.FullName, [System.Text.Encoding]::UTF8)
# BepInEx rewrites this file using native Windows line endings. Normalize only
# CRLF in memory; leave field spelling, values and fixed paths strictly bound.
$configText = $configText.Replace("`r`n", "`n")
$fixedFieldMatches = [regex]::Matches($configText, '(?m)^[ \t]*(?:Enabled|ControlRoot|SecretFile)[ \t]*=')
$enabledMatches = [regex]::Matches($configText, '(?m)^Enabled = (?<value>true|false)$')
$controlMatches = [regex]::Matches($configText, '(?m)^ControlRoot = (?<value>[^\r\n]+)$')
$secretMatches = [regex]::Matches($configText, '(?m)^SecretFile = (?<value>[^\r\n]+)$')
if ($fixedFieldMatches.Count -ne 3 -or $enabledMatches.Count -ne 1 -or $controlMatches.Count -ne 1 -or $secretMatches.Count -ne 1 -or
    $secretMatches[0].Groups['value'].Value -ne $secretPath -or
    $controlMatches[0].Groups['value'].Value -ne $controlRoot) {
    throw 'The installed Bridge configuration no longer matches its fixed path contract.'
}
$secretItem = Assert-DysonBridgePlainFile -Path $secretPath -MaximumBytes 4096
try { $secretBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($secretItem.FullName, [System.Text.Encoding]::UTF8).Trim()) }
catch { throw 'The installed Bridge secret is invalid.' }
if ($secretBytes.Length -lt 32) { throw 'The installed Bridge secret is too short.' }
[void](Assert-DysonBridgeExactAcl -Path $secretItem.FullName -Kind secret -InstallerSid ([string]$state.installerSid) `
    -ControlServiceSid ([string]$state.controlServiceSid) -GameServiceSid ([string]$state.gameServiceSid))
[void](Test-DysonBridgeControlTreeAcl -ControlRoot $controlRoot -InstallerSid ([string]$state.installerSid) `
    -ControlServiceSid ([string]$state.controlServiceSid) -GameServiceSid ([string]$state.gameServiceSid))

[ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'verified'
    ready = $true
    guid = $plugin.guid
    version = $plugin.version
    enabled = ($enabledMatches[0].Groups['value'].Value -eq 'true')
    runtimeLayout = [string]$runtime.layout
    dllSha256 = $plugin.sha256
    secretBytesAtLeast32 = $true
    secretDisclosed = $false
    secretAclProtected = $true
    twoIdentityAclContractVerified = $true
    privateRuntimeAclProtected = $privateRuntimeAclProtected
    controlServiceSid = $state.controlServiceSid
    gameServiceSid = $state.gameServiceSid
    gameRestarted = $false
} | ConvertTo-DysonBridgeJsonLine
