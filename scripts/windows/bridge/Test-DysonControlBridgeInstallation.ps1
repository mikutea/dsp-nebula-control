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
$secretPath = Join-Path $configRoot $script:DysonBridgeSecretName
foreach ($fixed in @($pluginPath, $configPath, $statePath, $secretPath)) {
    [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
}
$state = Read-DysonBridgeInstallState -Path $statePath
$plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath $pluginPath -DysonServerRoot $serverRoot
if ($plugin.guid -ne $script:DysonBridgeGuid -or $plugin.version -ne [string]$state.version -or
    $plugin.sha256 -ne [string]$state.dllSha256) {
    throw 'The installed Bridge DLL no longer matches installation state.'
}
$configItem = Assert-DysonBridgePlainFile -Path $configPath -MaximumBytes 64KB
$configText = [System.IO.File]::ReadAllText($configItem.FullName, [System.Text.Encoding]::UTF8)
$enabledMatches = [regex]::Matches($configText, '(?m)^Enabled = (?<value>true|false)$')
$controlMatches = [regex]::Matches($configText, '(?m)^ControlRoot = (?<value>[^\r\n]+)$')
$secretMatches = [regex]::Matches($configText, '(?m)^SecretFile = (?<value>[^\r\n]+)$')
if ($enabledMatches.Count -ne 1 -or $controlMatches.Count -ne 1 -or $secretMatches.Count -ne 1 -or
    $secretMatches[0].Groups['value'].Value -ne $secretPath -or
    $controlMatches[0].Groups['value'].Value -ne (Join-Path $serverRoot 'BepInEx\dyson-control-bridge')) {
    throw 'The installed Bridge configuration no longer matches its fixed path contract.'
}
$secretItem = Assert-DysonBridgePlainFile -Path $secretPath -MaximumBytes 4096
try { $secretBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($secretItem.FullName, [System.Text.Encoding]::UTF8).Trim()) }
catch { throw 'The installed Bridge secret is invalid.' }
if ($secretBytes.Length -lt 32) { throw 'The installed Bridge secret is too short.' }
$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $secretItem.FullName -ErrorAction Stop
if (-not $acl.AreAccessRulesProtected) { throw 'The installed Bridge secret ACL is not protected.' }
foreach ($rule in @($acl.Access)) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($sid -in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')) { throw 'The installed Bridge secret ACL grants a broad reader.' }
}

[ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'verified'
    ready = $true
    guid = $plugin.guid
    version = $plugin.version
    enabled = ($enabledMatches[0].Groups['value'].Value -eq 'true')
    dllSha256 = $plugin.sha256
    secretBytesAtLeast32 = $true
    secretDisclosed = $false
    secretAclProtected = $true
    gameRestarted = $false
} | ConvertTo-DysonBridgeJsonLine
