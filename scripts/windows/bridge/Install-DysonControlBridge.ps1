[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$CandidatePath,
    [Parameter(Mandatory)][string]$DysonServerRoot,
    [string]$ConfigurationTemplate,
    [string]$PrivateRuntimeRoot,
    [Parameter(Mandatory)][string]$ControlServiceSid,
    [Parameter(Mandatory)][string]$GameServiceSid,
    [Parameter(DontShow)][switch]$SelfTestFailureAfterPluginPublish
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$installerSid = Get-DysonBridgeCurrentInstallerSid
Assert-DysonBridgeSeparatedServiceSids -ControlServiceSid $ControlServiceSid -GameServiceSid $GameServiceSid
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
$usesPrivateRuntime = -not [string]::IsNullOrWhiteSpace($PrivateRuntimeRoot)
$runtimeContainer = $null
$runtimeRoot = $null
if ($usesPrivateRuntime) {
    $runtimeRoot = Assert-DysonBridgePrivateRuntimeRoot -Path $PrivateRuntimeRoot -DysonServerRoot $serverRoot -AllowMissing
    $runtimeContainer = Get-DysonBridgePrivateRuntimeContainer -RuntimeRoot $runtimeRoot
    $secretPath = Get-DysonBridgeFullPath -Path (Join-Path $runtimeRoot $script:DysonBridgeSecretName)
    $controlRoot = Get-DysonBridgeFullPath -Path (Join-Path $runtimeRoot 'control')
}
else {
    $secretPath = Join-Path $configRoot $script:DysonBridgeSecretName
    $controlRoot = Get-DysonBridgeFullPath -Path (Join-Path $serverRoot 'BepInEx\dyson-control-bridge')
}
$controlTreePaths = Get-DysonBridgeControlTreePaths -ControlRoot $controlRoot
$snapshotParent = Get-DysonBridgeFullPath -Path (Join-Path $configRoot 'dyson-control-bridge-snapshots')
$auditPath = Join-Path $configRoot 'dyson-control-bridge.audit.jsonl'
foreach ($fixed in @($pluginRoot, $pluginPath, $configPath, $statePath, $snapshotParent, $auditPath)) {
    if (-not (Test-DysonBridgePathWithin -Candidate $fixed -Parent $serverRoot)) { throw 'A fixed Bridge installation path escaped the DSP server root.' }
    [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
}
if (-not $usesPrivateRuntime) {
    foreach ($fixed in @($secretPath, $controlRoot)) {
        if (-not (Test-DysonBridgePathWithin -Candidate $fixed -Parent $serverRoot)) { throw 'A fixed Bridge runtime path escaped the DSP server root.' }
        [void](Assert-DysonBridgePathComponentsPlain -Path $fixed -Root $serverRoot)
    }
}

$plan = [ordered]@{
    protocol = $script:DysonBridgeInstallProtocol
    state = 'preview'
    dryRun = $true
    version = $candidate.version
    enabled = $false
    runtimeLayout = if ($usesPrivateRuntime) { 'private-ntfs' } else { 'legacy-server-tree' }
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
$runtimeContainerExisted = $usesPrivateRuntime -and (Test-Path -LiteralPath $runtimeContainer -PathType Container)
$originalRuntimeContainerSddl = $null
$runtimeRootExisted = $usesPrivateRuntime -and (Test-Path -LiteralPath $runtimeRoot -PathType Container)
$originalRuntimeRootSddl = $null
$controlTreeAclSnapshots = @()
$mutationStarted = $false
try {
    if ($stateExisted) {
        $priorState = Read-DysonBridgeInstallState -Path $statePath
        $priorRuntime = Get-DysonBridgeInstallRuntimePaths -State $priorState -DysonServerRoot $serverRoot
        if (($usesPrivateRuntime -and [string]$priorRuntime.layout -cne 'private-ntfs') -or
            (-not $usesPrivateRuntime -and [string]$priorRuntime.layout -cne 'legacy-server-tree') -or
            ($usesPrivateRuntime -and -not [string]::Equals(
                [string]$priorRuntime.runtimeRoot,
                $runtimeRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ))) {
            throw 'The existing Bridge installation is bound to a different runtime root.'
        }
    }
    elseif ($usesPrivateRuntime) {
        if ($runtimeContainerExisted) {
            [void](Assert-DysonBridgePrivateRuntimeContainerInventory -RuntimeContainer $runtimeContainer -RuntimeRoot $runtimeRoot)
        }
        if ($runtimeRootExisted) {
            [void](Assert-DysonBridgePrivateRuntimeInventory -RuntimeRoot $runtimeRoot)
            if (@(Get-ChildItem -LiteralPath $runtimeRoot -Force -ErrorAction Stop).Count -ne 0) {
                throw 'An unowned Bridge private runtime root cannot be reused.'
            }
        }
    }
    foreach ($existing in @($pluginPath, $configPath, $statePath, $secretPath)) {
        if (Test-Path -LiteralPath $existing) { [void](Assert-DysonBridgePlainFile -Path $existing -MaximumBytes 64MB) }
    }
    if ($secretExisted) {
        $originalSecretSddl = Get-DysonBridgeAccessSddl -Path $secretPath
    }
    if ($runtimeRootExisted) {
        [void](Assert-DysonBridgePrivateRuntimeInventory -RuntimeRoot $runtimeRoot)
        $originalRuntimeRootSddl = Get-DysonBridgeAccessSddl -Path $runtimeRoot
    }
    if ($runtimeContainerExisted) {
        [void](Assert-DysonBridgePrivateRuntimeContainerInventory -RuntimeContainer $runtimeContainer -RuntimeRoot $runtimeRoot)
        $originalRuntimeContainerSddl = Get-DysonBridgeAccessSddl -Path $runtimeContainer
    }
    foreach ($name in @('root', 'requests', 'processing', 'receipts', 'processed', 'rejected')) {
        $path = [string]$controlTreePaths[$name]
        $existed = Test-Path -LiteralPath $path -PathType Container
        if ((Test-Path -LiteralPath $path) -and -not $existed) { throw 'A fixed Bridge control path is not a directory.' }
        $controlTreeAclSnapshots += [ordered]@{
            name = $name
            path = $path
            existed = $existed
            sddl = if ($existed) {
                [void](Assert-DysonBridgePlainDirectory -Path $path)
                Get-DysonBridgeAccessSddl -Path $path
            }
            else { $null }
        }
    }
    [System.IO.Directory]::CreateDirectory($pluginRoot) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $pluginRoot)
    [System.IO.Directory]::CreateDirectory($snapshotParent) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotParent)
    [System.IO.Directory]::CreateDirectory($snapshotRoot) | Out-Null
    [void](Assert-DysonBridgePlainDirectory -Path $snapshotRoot)
    $mutationStarted = $true
    if ($usesPrivateRuntime) {
        [System.IO.Directory]::CreateDirectory($runtimeContainer) | Out-Null
        [void](Assert-DysonBridgePlainDirectory -Path $runtimeContainer)
        Protect-DysonBridgePrivateRuntimeRootAcl -RuntimeRoot $runtimeContainer -InstallerSid $installerSid `
            -ControlServiceSid $ControlServiceSid -GameServiceSid $GameServiceSid
        [System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
        [void](Assert-DysonBridgePlainDirectory -Path $runtimeRoot)
        Protect-DysonBridgePrivateRuntimeRootAcl -RuntimeRoot $runtimeRoot -InstallerSid $installerSid `
            -ControlServiceSid $ControlServiceSid -GameServiceSid $GameServiceSid
        [void](Assert-DysonBridgePrivateRuntimeContainerInventory -RuntimeContainer $runtimeContainer -RuntimeRoot $runtimeRoot)
        [void](Assert-DysonBridgePrivateRuntimeInventory -RuntimeRoot $runtimeRoot)
    }
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
    Protect-DysonBridgeSecretAcl -SecretPath $secretPath -InstallerSid $installerSid `
        -ControlServiceSid $ControlServiceSid -GameServiceSid $GameServiceSid
    [void](Initialize-DysonBridgeControlTreeAcl -ControlRoot $controlRoot -InstallerSid $installerSid `
        -ControlServiceSid $ControlServiceSid -GameServiceSid $GameServiceSid)

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
        schemaVersion = if ($usesPrivateRuntime) { 3 } else { 2 }
        guid = $script:DysonBridgeGuid
        version = $candidate.version
        dllSha256 = $candidate.dllSha256
        configSha256 = Get-DysonBridgeSha256 -Path $configPath
        templateSha256 = Get-DysonBridgeSha256 -Path $templateItem.FullName
        installedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        snapshotId = $snapshotId
        enabledDefault = $false
        aclContract = if ($usesPrivateRuntime) { $script:DysonBridgePrivateRuntimeAclContract } else { $script:DysonBridgeAclContract }
        installerSid = $installerSid
        controlServiceSid = $ControlServiceSid
        gameServiceSid = $GameServiceSid
    }
    if ($usesPrivateRuntime) {
        $state.runtimeLayout = 'private-ntfs'
        $state.serverRoot = $serverRoot
        $state.runtimeContainer = $runtimeContainer
        $state.runtimeRoot = $runtimeRoot
        $state.secretPath = $secretPath
        $state.controlRoot = $controlRoot
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
            Restore-DysonBridgeAccessSddl -Path $secretPath -Sddl $originalSecretSddl
        }
        foreach ($snapshot in @($controlTreeAclSnapshots | Where-Object { [bool]$_.existed })) {
            if (Test-Path -LiteralPath ([string]$snapshot.path) -PathType Container) {
                Restore-DysonBridgeAccessSddl -Path ([string]$snapshot.path) -Sddl ([string]$snapshot.sddl) -Directory
            }
        }
        foreach ($name in @('rejected', 'processed', 'receipts', 'processing', 'requests', 'root')) {
            $snapshot = @($controlTreeAclSnapshots | Where-Object { [string]$_.name -ceq $name })[0]
            if ($null -ne $snapshot -and -not [bool]$snapshot.existed) {
                $path = [string]$snapshot.path
                if (Test-Path -LiteralPath $path -PathType Container) {
                    [void](Assert-DysonBridgePlainDirectory -Path $path)
                    if (@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count -eq 0) {
                        [System.IO.Directory]::Delete($path, $false)
                    }
                }
            }
        }
        if ($usesPrivateRuntime -and $runtimeRootExisted -and $originalRuntimeRootSddl -and
            (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
            Restore-DysonBridgeAccessSddl -Path $runtimeRoot -Sddl $originalRuntimeRootSddl -Directory
        }
        elseif ($usesPrivateRuntime -and -not $runtimeRootExisted -and
            (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
            [void](Assert-DysonBridgePlainDirectory -Path $runtimeRoot)
            if (@(Get-ChildItem -LiteralPath $runtimeRoot -Force -ErrorAction Stop).Count -eq 0) {
                [System.IO.Directory]::Delete($runtimeRoot, $false)
            }
        }
        if ($usesPrivateRuntime -and $runtimeContainerExisted -and $originalRuntimeContainerSddl -and
            (Test-Path -LiteralPath $runtimeContainer -PathType Container)) {
            Restore-DysonBridgeAccessSddl -Path $runtimeContainer -Sddl $originalRuntimeContainerSddl -Directory
        }
        elseif ($usesPrivateRuntime -and -not $runtimeContainerExisted -and
            (Test-Path -LiteralPath $runtimeContainer -PathType Container)) {
            [void](Assert-DysonBridgePlainDirectory -Path $runtimeContainer)
            if (@(Get-ChildItem -LiteralPath $runtimeContainer -Force -ErrorAction Stop).Count -eq 0) {
                [System.IO.Directory]::Delete($runtimeContainer, $false)
            }
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
    runtimeLayout = if ($usesPrivateRuntime) { 'private-ntfs' } else { 'legacy-server-tree' }
    snapshotId = $snapshotId
    secretGeneratedOrPreserved = $true
    secretDisclosed = $false
    gameRestarted = $false
    savesChanged = $false
    nebulaChanged = $false
    gsmChanged = $false
} | ConvertTo-DysonBridgeJsonLine
