[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-bridge-selftest-' + [guid]::NewGuid().ToString('N'))
$serverRoot = Join-Path $testRoot 'fictional-dsp-server'
$sourceRoot = Join-Path $testRoot 'public-source'
$sourceTampered = Join-Path $testRoot 'public-source-tampered'
$sourceTargetInjected = Join-Path $testRoot 'public-source-target-injected'
$candidateRoot = Join-Path $testRoot 'private-candidate'
$candidateExtra = Join-Path $testRoot 'private-candidate-extra'
$candidateTampered = Join-Path $testRoot 'private-candidate-tampered'
$candidateRedirect = Join-Path $testRoot 'private-candidate-redirect'
$redirectTarget = Join-Path $testRoot 'redirect-target'
$redirectCreated = $false

function Assert-BridgeSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Bridge delivery self-test failed: $Message" }
}

function Copy-BridgeTree {
    param([string]$Source, [string]$Destination)
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($file in @(Assert-DysonBridgeTreePlain -Root $Source)) {
        $relative = $file.FullName.Substring((Get-DysonBridgeFullPath -Path $Source).TrimEnd('\', '/').Length).TrimStart('\', '/')
        $target = Join-Path $Destination $relative
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
        [System.IO.File]::Copy($file.FullName, $target, $false)
    }
}

function Get-LastBridgeJson {
    param($Output)
    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'A Bridge self-test command returned no JSON.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json
}

function Assert-BridgeRejected {
    param([scriptblock]$Action, [string]$Message)
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-BridgeSelfTest -Condition $rejected -Message $Message
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $serverRoot 'BepInEx\core')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $serverRoot 'BepInEx\config')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $serverRoot 'BepInEx\plugins\nebula-NebulaMultiplayerModApi')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $serverRoot 'BepInEx\plugins\nebula-NebulaMultiplayerMod')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $serverRoot 'DSPGAME_Data\Managed')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $serverRoot 'DSPGAME.exe'), 'fictional stopped process image', [System.Text.UTF8Encoding]::new($false))

    $referenceIndex = 0
    foreach ($specification in @(Get-DysonBridgeReferenceSpecifications)) {
        $referenceIndex++
        $path = Join-Path $serverRoot ([string]$specification.relativePath)
        $source = @"
using System.Reflection;
[assembly: AssemblyVersion("1.$referenceIndex.0.0")]
[assembly: AssemblyFileVersion("1.$referenceIndex.0.0")]
namespace FictionalReference$referenceIndex { public sealed class Marker$referenceIndex { } }
"@
        Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $path -OutputType Library
    }

    $processFixtureTemplate = Join-Path $testRoot 'bridge-process-fixture.exe'
    $processFixtureSource = @'
using System;
using System.IO;
using System.Threading;
public static class BridgeProcessFixture {
    public static int Main(string[] args) {
        string name = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (name.Contains("huge")) { Console.Write(new string('x', 4096)); return 0; }
        if (name.Contains("timeout")) { Thread.Sleep(10000); return 0; }
        if (name.Contains("nonzero")) { Console.Error.Write("private fixture detail"); return 7; }
        Console.Write("bounded"); return 0;
    }
}
'@
    Add-Type -TypeDefinition $processFixtureSource -Language CSharp -OutputAssembly $processFixtureTemplate -OutputType ConsoleApplication
    $processOk = Join-Path $testRoot 'controlled-ok.exe'
    $processHuge = Join-Path $testRoot 'controlled-huge.exe'
    $processTimeout = Join-Path $testRoot 'controlled-timeout.exe'
    $processNonzero = Join-Path $testRoot 'controlled-nonzero.exe'
    foreach ($target in @($processOk, $processHuge, $processTimeout, $processNonzero)) {
        [System.IO.File]::Copy($processFixtureTemplate, $target, $false)
    }
    $boundedProcess = Invoke-DysonBridgeProcess -Executable $processOk -Arguments '--fixed' -WorkingDirectory $testRoot `
        -TimeoutMilliseconds 2000 -MaximumOutputCharacters 1024
    Assert-BridgeSelfTest -Condition ($boundedProcess.stdout -eq 'bounded') -Message 'the controlled build process fixture did not complete'
    Assert-BridgeRejected -Action {
        Invoke-DysonBridgeProcess -Executable $processHuge -Arguments '--fixed' -WorkingDirectory $testRoot `
            -TimeoutMilliseconds 2000 -MaximumOutputCharacters 1024
    } -Message 'oversized controlled build output was accepted'
    Assert-BridgeRejected -Action {
        Invoke-DysonBridgeProcess -Executable $processTimeout -Arguments '--fixed' -WorkingDirectory $testRoot `
            -TimeoutMilliseconds 1000 -MaximumOutputCharacters 1024
    } -Message 'a timed-out controlled build process was accepted'
    Assert-BridgeRejected -Action {
        Invoke-DysonBridgeProcess -Executable $processNonzero -Arguments '--fixed' -WorkingDirectory $testRoot `
            -TimeoutMilliseconds 2000 -MaximumOutputCharacters 1024
    } -Message 'a nonzero controlled build process was accepted'

    $publicSource = Join-Path $PSScriptRoot '..\..\..\integrations\dyson-control-bridge'
    foreach ($name in @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridgePlugin.cs',
        'GameSaveAdapter.cs', 'PlayerRosterPublisher.cs', 'DysonControlBridge.csproj',
        'dyson-control-bridge.cfg.example', 'README.md'
    )) {
        $target = Join-Path $sourceRoot $name
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
        [System.IO.File]::Copy((Join-Path $publicSource $name), $target, $false)
    }
    $sourceContract = Get-DysonBridgeSourceContract -SourceRoot $sourceRoot
    Assert-BridgeSelfTest -Condition ($sourceContract.version -eq '0.1.0') -Message 'the public source contract was not accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourceTampered
    $tamperedPluginSource = Join-Path $sourceTampered 'DysonControlBridgePlugin.cs'
    $tamperedPluginText = [System.IO.File]::ReadAllText($tamperedPluginSource, [System.Text.Encoding]::UTF8).Replace(
        'public const string PluginVersion = "0.1.0";',
        'public const string PluginVersion = "0.1.1";'
    )
    [System.IO.File]::WriteAllText($tamperedPluginSource, $tamperedPluginText, [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourceTampered } `
        -Message 'a source package with mismatched PluginVersion was accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourceTargetInjected
    $injectedProjectPath = Join-Path $sourceTargetInjected 'DysonControlBridge.csproj'
    $injectedProject = [System.IO.File]::ReadAllText($injectedProjectPath, [System.Text.Encoding]::UTF8).Replace(
        '</Project>',
        '  <Target Name="Unexpected"><Exec Command="not-allowed" /></Target></Project>'
    )
    [System.IO.File]::WriteAllText($injectedProjectPath, $injectedProject, [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourceTargetInjected } `
        -Message 'a source project with an executable MSBuild target was accepted'

    [System.IO.Directory]::CreateDirectory($candidateRoot) | Out-Null
    $pluginSource = @'
using System.Reflection;
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]
namespace DysonControl.Bridge {
    public sealed class DysonControlBridgePlugin {
        public const string PluginGuid = "io.github.mikutea.dyson-control-bridge";
        public const string PluginName = "Dyson Control Bridge";
        public const string PluginVersion = "0.1.0";
    }
}
'@
    Add-Type -TypeDefinition $pluginSource -Language CSharp -OutputAssembly (Join-Path $candidateRoot $script:DysonBridgeDllName) -OutputType Library
    $references = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $serverRoot)
    $plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath (Join-Path $candidateRoot $script:DysonBridgeDllName) -DysonServerRoot $serverRoot
    [void](Write-DysonBridgeCandidateManifest -CandidateRoot $candidateRoot -Plugin $plugin -References $references -Sources $sourceContract.files)
    $verified = Test-DysonBridgeCandidateCore -CandidateRoot $candidateRoot -DysonServerRoot $serverRoot -ExpectedVersion '0.1.0'
    Assert-BridgeSelfTest -Condition ([bool]$verified.ready -and $verified.guid -eq $script:DysonBridgeGuid) -Message 'the controlled private candidate was not verified'

    $referenceToTamper = Join-Path $serverRoot 'BepInEx\core\BepInEx.dll'
    $referenceBackup = Join-Path $testRoot 'BepInEx.reference.backup.dll'
    [System.IO.File]::Copy($referenceToTamper, $referenceBackup, $false)
    [System.IO.File]::AppendAllText($referenceToTamper, 'tampered', [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Test-DysonBridgeCandidateCore -CandidateRoot $candidateRoot -DysonServerRoot $serverRoot } `
        -Message 'a candidate was accepted after a local reference assembly changed'
    [System.IO.File]::Copy($referenceBackup, $referenceToTamper, $true)

    Copy-BridgeTree -Source $candidateRoot -Destination $candidateExtra
    [System.IO.File]::WriteAllText((Join-Path $candidateExtra 'unexpected.pdb'), 'not a real pdb', [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Test-DysonBridgeCandidateCore -CandidateRoot $candidateExtra -DysonServerRoot $serverRoot } `
        -Message 'an extra private candidate file was accepted'

    Copy-BridgeTree -Source $candidateRoot -Destination $candidateTampered
    [System.IO.File]::AppendAllText((Join-Path $candidateTampered $script:DysonBridgeDllName), 'tampered', [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Test-DysonBridgeCandidateCore -CandidateRoot $candidateTampered -DysonServerRoot $serverRoot } `
        -Message 'a tampered private candidate DLL was accepted'

    [System.IO.Directory]::CreateDirectory($redirectTarget) | Out-Null
    [void](New-Item -ItemType Junction -Path $candidateRedirect -Target $redirectTarget -ErrorAction Stop)
    $redirectCreated = $true
    Assert-BridgeRejected -Action { Test-DysonBridgeCandidateCore -CandidateRoot $candidateRedirect -DysonServerRoot $serverRoot } `
        -Message 'a redirected private candidate root was accepted'
    Remove-Item -LiteralPath $candidateRedirect -Force
    $redirectCreated = $false

    $buildScript = Join-Path $PSScriptRoot 'Build-DysonControlBridgeCandidate.ps1'
    $buildPreviewPath = Join-Path $testRoot 'build-preview-must-not-exist'
    $buildPreview = Get-LastBridgeJson -Output (& $buildScript -SourcePath $sourceRoot -DysonServerRoot $serverRoot `
        -OutputPath $buildPreviewPath -ExpectedVersion '0.1.0' -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($buildPreview.state -eq 'preview' -and -not (Test-Path -LiteralPath $buildPreviewPath)) `
        -Message 'the private builder WhatIf changed the filesystem'

    $installScript = Join-Path $PSScriptRoot 'Install-DysonControlBridge.ps1'
    $testScript = Join-Path $PSScriptRoot 'Test-DysonControlBridgeInstallation.ps1'
    $uninstallScript = Join-Path $PSScriptRoot 'Uninstall-DysonControlBridge.ps1'
    $pluginPath = Join-Path $serverRoot ('BepInEx\plugins\dyson-control-bridge\' + $script:DysonBridgeDllName)
    $configPath = Join-Path $serverRoot ('BepInEx\config\' + $script:DysonBridgeConfigName)
    $secretPath = Join-Path $serverRoot ('BepInEx\config\' + $script:DysonBridgeSecretName)
    $installPreview = Get-LastBridgeJson -Output (& $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($installPreview.state -eq 'preview' -and -not (Test-Path -LiteralPath $pluginPath) -and
        -not (Test-Path -LiteralPath $configPath) -and -not (Test-Path -LiteralPath $secretPath)) `
        -Message 'Bridge install WhatIf changed the game tree'

    $installed = Get-LastBridgeJson -Output (& $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot -Confirm:$false)
    Assert-BridgeSelfTest -Condition ($installed.state -eq 'installed' -and $installed.enabled -eq $false -and
        $installed.secretDisclosed -eq $false -and $installed.gameRestarted -eq $false) -Message 'Bridge installation did not complete fail-closed'
    $installation = Get-LastBridgeJson -Output (& $testScript -DysonServerRoot $serverRoot)
    Assert-BridgeSelfTest -Condition ([bool]$installation.ready -and $installation.enabled -eq $false -and
        [bool]$installation.secretBytesAtLeast32 -and [bool]$installation.secretAclProtected) `
        -Message 'the installed Bridge did not verify'

    $beforeRollbackDll = Get-DysonBridgeSha256 -Path $pluginPath
    $beforeRollbackConfig = Get-DysonBridgeSha256 -Path $configPath
    $env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE = 'true'
    try {
        Assert-BridgeRejected -Action {
            & $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot -SelfTestFailureAfterPluginPublish -Confirm:$false
        } -Message 'the isolated install failure hook did not fail'
    }
    finally { Remove-Item Env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE -ErrorAction SilentlyContinue }
    Assert-BridgeSelfTest -Condition ((Get-DysonBridgeSha256 -Path $pluginPath) -eq $beforeRollbackDll -and
        (Get-DysonBridgeSha256 -Path $configPath) -eq $beforeRollbackConfig) -Message 'a failed Bridge install did not restore the prior DLL/config'

    $uninstallPreview = Get-LastBridgeJson -Output (& $uninstallScript -DysonServerRoot $serverRoot -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($uninstallPreview.state -eq 'uninstall-preview' -and
        (Test-Path -LiteralPath $pluginPath) -and (Test-Path -LiteralPath $configPath)) -Message 'Bridge uninstall WhatIf changed installed files'
    $uninstalled = Get-LastBridgeJson -Output (& $uninstallScript -DysonServerRoot $serverRoot -Confirm:$false)
    Assert-BridgeSelfTest -Condition ($uninstalled.state -eq 'uninstalled-recoverable' -and
        -not (Test-Path -LiteralPath $pluginPath) -and -not (Test-Path -LiteralPath $configPath) -and
        (Test-Path -LiteralPath $secretPath)) -Message 'recoverable Bridge uninstall did not preserve its boundary'
    $restored = Get-LastBridgeJson -Output (& $uninstallScript -DysonServerRoot $serverRoot `
        -RestoreSnapshotId ([string]$uninstalled.snapshotId) -Confirm:$false)
    $restoredVerification = Get-LastBridgeJson -Output (& $testScript -DysonServerRoot $serverRoot)
    Assert-BridgeSelfTest -Condition ($restored.state -eq 'restored' -and [bool]$restoredVerification.ready) `
        -Message 'the recoverable Bridge uninstall snapshot could not be restored'

    $reparseServer = Join-Path $testRoot 'reparse-reference-server'
    [System.IO.Directory]::CreateDirectory((Join-Path $reparseServer 'BepInEx')) | Out-Null
    $reparseCore = Join-Path $reparseServer 'BepInEx\core'
    [void](New-Item -ItemType Junction -Path $reparseCore -Target (Join-Path $serverRoot 'BepInEx\core') -ErrorAction Stop)
    try {
        Assert-BridgeRejected -Action { Get-DysonBridgeReferenceReceipts -DysonServerRoot $reparseServer } `
            -Message 'a fixed reference path traversing a reparse point was accepted'
    }
    finally { [System.IO.Directory]::Delete($reparseCore, $false) }

    [ordered]@{
        protocol = 'DYSON_CONTROL_BRIDGE_DELIVERY_SELFTEST_V1'
        state = 'passed'
        publicSourceContractValidated = $true
        sourceVersionAndExecutableTargetTamperRejected = $true
        buildBoundaryPreviewValidated = $true
        controlledBuildProcessTimeoutAndOutputBounded = $true
        fullBuildRequiresLawfulLocalAssemblies = $true
        candidateMetadataAndReferencesValidated = $true
        changedAndRedirectedReferencesRejected = $true
        candidateTamperExtraAndReparseRejected = $true
        installWhatIfWasNonMutating = $true
        installDefaultedDisabled = $true
        secretWasRandomProtectedAndUndisclosed = $true
        failedInstallRolledBack = $true
        uninstallWasRecoverable = $true
        saveGameNebulaAndGsmWereUntouched = $true
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Remove-Item Env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE -ErrorAction SilentlyContinue
    if ($redirectCreated -and (Test-Path -LiteralPath $candidateRedirect)) {
        $item = Get-Item -LiteralPath $candidateRedirect -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $candidateRedirect -Force -ErrorAction SilentlyContinue
        }
    }
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-bridge-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
