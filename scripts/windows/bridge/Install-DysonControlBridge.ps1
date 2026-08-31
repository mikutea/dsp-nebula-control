[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$CandidatePath,
    [Parameter(Mandatory)][string]$DysonServerRoot,
    [string]$ConfigurationTemplate,
    [ValidateCount(0, 8)][string[]]$SecretReaderSid = @(),
    [Parameter(DontShow)][switch]$SelfTestFailureAfterPluginPublish
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$serverRoot = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
$candidate = Test-DysonBridgeCandidateCore -CandidateRoot $CandidatePath -DysonServerRoot $serverRoot
[void](Assert-DysonBridgeGameStopped -DysonServerRoot $serverRoot)
if (-not $ConfigurationTemplate) {
    $ConfigurationTemplate = Join-Path $PSScriptRoot '..\..\..\integrations\dyson-control-bridge\dyson-control-bridge.cfg.example'
}
$templateItem = Assert-DysonBridgePlainFile -Path $ConfigurationTemplate -MaximumBytes 64KB
$templateText = [System.IO.File]::ReadAllText($templateItem.FullName, [System.Text.Encoding]::UTF8)
if ($templateText -notmatch '(?m)^Enabled = false$' -or
    ([regex]::Matches($templateText, '\{\{CONTROL_ROOT\}\}')).Count -ne 1 -or
    ([regex]::Matches($templateText, '\{\{SECRET_FILE\}\}')).Count -ne 1 -or
    $templateText -match '(?i)secret\s*=\s*[^\{\r\n]') {
    throw 'The public Bridge configuration template is not fail-closed or contains secret material.'
}

$pluginRoot = Get-DysonBridgeFullPath -Path (Join-Path $serverRoot 'BepInEx\plugins\dyson-control-bridge')
$pluginPath = Join-Path $pluginRoot $script:DysonBridgeDllName
$configRoot = Assert-DysonBridgePlainDirectory -Path (Join-Path $serverRoot 'BepInEx\config')
$configPath = Join-Path $configRoot $script:DysonBridgeConfigName
$statePath = Join-Path $configRoot $script:DysonBridgeStateName
$secretPath = Join-Path $configRoot $script:DysonBridgeSecretName
$controlRoot = Get-DysonBridgeFullPath -Path (Join-Path $serverRoot 'BepInEx\dyson-control-bridge')
$snapshotParent = Get-DysonBridgeFullPath -Path (Join-Path $configRoot 'dyson-control-bridge-snapshots')
$auditPath = Join-Path $configRoot 'dyson-control-bridge.audit.jsonl'
foreach ($fixed in @($pluginRoot, $pluginPath, $configPath, $statePath, $secretPath, $controlRoot, $snapshotParent, $auditPath)) {
    if (-not (Test-DysonBridgePathWithin -Candidate $fixed -Parent $serverRoot)) { throw 'A fixed Bridge installation path escaped the DSP server root.' }
    [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
}

$plan = [ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'preview'
    dryRun = $true
    version = $candidate.version
    enabled = $false
    exactGameProcessStopped = $true
    oldPluginAndConfigWillBeSnapshotted = $true
    gameWillBeRestarted = $false
    savesWillBeChanged = $false
    nebulaWillBeChanged = $false
    gsmWillBeChanged = $false
    productionChanged = $false
}
if (-not $PSCmdlet.ShouldProcess($script:DysonBridgeGuid, "install private Bridge candidate $($candidate.version) disabled by default")) {
    $plan | ConvertTo-DysonBridgeJsonLine
    exit 0
}

$snapshotId = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$snapshotRoot = Join-Path $snapshotParent $snapshotId
$pluginExisted = Test-Path -LiteralPath $pluginPath -PathType Leaf
$configExisted = Test-Path -LiteralPath $configPath -PathType Leaf
$stateExisted = Test-Path -LiteralPath $statePath -PathType Leaf
$secretExisted = Test-Path -LiteralPath $secretPath -PathType Leaf
$originalSecretSddl = $null
$mutationStarted = $false
try {
    foreach ($existing in @($pluginPath, $configPath, $statePath, $secretPath)) {
        if (Test-Path -LiteralPath $existing) { [void](Assert-DysonBridgePlainFile -Path $existing -MaximumBytes 64MB) }
    }
    if ($secretExisted) { $originalSecretSddl = (Get-Acl -LiteralPath $secretPath -ErrorAction Stop).Sddl }
    [System.IO.Directory]::CreateDirectory($pluginRoot) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $pluginRoot)
    [System.IO.Directory]::CreateDirectory($snapshotParent) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotParent)
    [System.IO.Directory]::CreateDirectory($snapshotRoot) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotRoot)
    $mutationStarted = $true
    foreach ($entry in @(
        [ordered]@{ source = $pluginPath; name = $script:DysonBridgeDllName },
        [ordered]@{ source = $configPath; name = $script:DysonBridgeConfigName },
        [ordered]@{ source = $statePath; name = $script:DysonBridgeStateName }
    )) {
        if (Test-Path -LiteralPath $entry.source -PathType Leaf) {
            [System.IO.File]::Copy([string]$entry.source, (Join-Path $snapshotRoot ([string]$entry.name)), $false)
        }
    }

    if (-not $secretExisted) {
        $bytes = New-Object byte[] 48
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        Write-DysonBridgeAtomicText -Path $secretPath -Value ([Convert]::ToBase64String($bytes))
    }
    $secretItem = Assert-DysonBridgePlainFile -Path $secretPath -MaximumBytes 4096
    $secretText = [System.IO.File]::ReadAllText($secretItem.FullName, [System.Text.Encoding]::UTF8).Trim()
    $decoded = $null
    try { $decoded = [Convert]::FromBase64String($secretText) } catch { throw 'The existing Bridge secret is not canonical base64.' }
    if ($decoded.Length -lt 32) { throw 'The Bridge secret must contain at least 32 random bytes.' }
    Protect-DysonBridgeSecretAcl -SecretPath $secretPath -ReaderSids $SecretReaderSid

    $renderedConfig = $templateText.Replace('{{CONTROL_ROOT}}', $controlRoot).Replace('{{SECRET_FILE}}', $secretPath)
    if ($renderedConfig -notmatch '(?m)^Enabled = false$') { throw 'The rendered Bridge configuration is not disabled.' }
    Publish-DysonBridgeFile -Source (Join-Path (Get-DysonBridgeFullPath -Path $CandidatePath) $script:DysonBridgeDllName) -Destination $pluginPath
    if ($SelfTestFailureAfterPluginPublish) {
        if ($env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE -ne 'true') { throw 'The Bridge failure hook is reserved for isolated self-tests.' }
        throw 'Isolated Bridge rollback self-test.'
    }
    Write-DysonBridgeAtomicText -Path $configPath -Value $renderedConfig
    $state = [ordered]@{
        protocol = $script:DysonBridgeInstallProtocol
        schemaVersion = 1
        guid = $script:DysonBridgeGuid
        version = $candidate.version
        dllSha256 = $candidate.dllSha256
        configSha256 = Get-DysonBridgeSha256 -Path $configPath
        templateSha256 = Get-DysonBridgeSha256 -Path $templateItem.FullName
        installedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        snapshotId = $snapshotId
        enabledDefault = $false
    }
    Write-DysonBridgeAtomicText -Path $statePath -Value (($state | ConvertTo-Json -Depth 8 -Compress) + "`r`n")
    [void](Read-DysonBridgeInstallState -Path $statePath)
    [void](& (Join-Path $PSScriptRoot 'Test-DysonControlBridgeInstallation.ps1') -DysonServerRoot $serverRoot)
    $audit = [ordered]@{
        protocol = $script:DysonBridgeInstallProtocol
        operation = 'install'
        outcome = 'succeeded'
        version = $candidate.version
        snapshotId = $snapshotId
        atUtc = (Get-Date).ToUniversalTime().ToString('o')
        gameRestarted = $false
    } | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::AppendAllText($auditPath, $audit + "`r`n", [System.Text.UTF8Encoding]::new($false))
}
catch {
    $installError = $_
    if ($mutationStarted) {
        foreach ($entry in @(
            [ordered]@{ target = $pluginPath; name = $script:DysonBridgeDllName; existed = $pluginExisted },
            [ordered]@{ target = $configPath; name = $script:DysonBridgeConfigName; existed = $configExisted },
            [ordered]@{ target = $statePath; name = $script:DysonBridgeStateName; existed = $stateExisted }
        )) {
            $backup = Join-Path $snapshotRoot ([string]$entry.name)
            if ([bool]$entry.existed -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
                Publish-DysonBridgeFile -Source $backup -Destination ([string]$entry.target)
            }
            elseif (-not [bool]$entry.existed -and (Test-Path -LiteralPath $entry.target -PathType Leaf)) {
                Remove-Item -LiteralPath $entry.target -Force
            }
        }
        if (-not $secretExisted -and (Test-Path -LiteralPath $secretPath -PathType Leaf)) { Remove-Item -LiteralPath $secretPath -Force }
        elseif ($secretExisted -and $originalSecretSddl -and (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
            $secretAcl = Get-Acl -LiteralPath $secretPath -ErrorAction Stop
            $secretAcl.SetSecurityDescriptorSddlForm($originalSecretSddl)
            Set-Acl -LiteralPath $secretPath -AclObject $secretAcl -ErrorAction Stop
        }
    }
    throw $installError
}

[ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'installed'
    version = $candidate.version
    guid = $script:DysonBridgeGuid
    enabled = $false
    snapshotId = $snapshotId
    secretGeneratedOrPreserved = $true
    secretDisclosed = $false
    gameRestarted = $false
    savesChanged = $false
    nebulaChanged = $false
    gsmChanged = $false
} | ConvertTo-DysonBridgeJsonLine
