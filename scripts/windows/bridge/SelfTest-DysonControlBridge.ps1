[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-bridge-selftest-' + [guid]::NewGuid().ToString('N'))
$serverRoot = Join-Path $testRoot 'fictional-dsp-server'
$snapshotIdBoundary = ('0' * 17) + '-' + ('a' * 8)
$legacyAtomicNameBoundary = '.dyson-bridge-' + ('a' * 32) + '.tmp'
$legacyAtomicSuffixBoundary = Join-Path `
    (Join-Path 'BepInEx\config\dyson-control-bridge-snapshots' $snapshotIdBoundary) `
    $legacyAtomicNameBoundary
$boundaryServerRootLength = 260 - 1 - $legacyAtomicSuffixBoundary.Length
if ($serverRoot.Length -lt $boundaryServerRootLength) {
    $serverRoot += 'x' * ($boundaryServerRootLength - $serverRoot.Length)
}
$sourceRoot = Join-Path $testRoot 'public-source'
$sourceTampered = Join-Path $testRoot 'public-source-tampered'
$sourcePluginTampered = Join-Path $testRoot 'public-source-plugin-tampered'
$sourceMissing = Join-Path $testRoot 'public-source-missing'
$sourceExtra = Join-Path $testRoot 'public-source-extra'
$sourceTargetInjected = Join-Path $testRoot 'public-source-target-injected'
$candidateRoot = Join-Path $testRoot 'private-candidate'
$candidateExtra = Join-Path $testRoot 'private-candidate-extra'
$candidateTampered = Join-Path $testRoot 'private-candidate-tampered'
$candidateManifestVersionTampered = Join-Path $testRoot 'private-candidate-manifest-version-tampered'
$candidateRedirect = Join-Path $testRoot 'private-candidate-redirect'
$candidateProductVersionMismatch = Join-Path $testRoot 'private-candidate-product-version-mismatch'
$builtCandidateRoot = Join-Path $testRoot 'build path with spaces\private-candidate-built'
$fakeDotnetRoot = Join-Path $testRoot 'controlled-dotnet'
$redirectTarget = Join-Path $testRoot 'redirect-target'
$redirectCreated = $false
$controlServiceSid = 'S-1-5-19'
$gameServiceSid = 'S-1-5-21-42424242-42424242-42424242-1001'

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

$global:DysonBridgeSelfTestAclShadowCalls = 0
function Get-Acl {
    $global:DysonBridgeSelfTestAclShadowCalls++
    throw 'The untrusted self-test Get-Acl shadow must never be invoked.'
}
function Set-Acl {
    $global:DysonBridgeSelfTestAclShadowCalls++
    throw 'The untrusted self-test Set-Acl shadow must never be invoked.'
}

try {
    $telemetrySelfTest = Get-LastBridgeJson -Output (& (Join-Path $PSScriptRoot 'SelfTest-DysonBridgeSimulationTelemetry.ps1'))
    Assert-BridgeSelfTest -Condition ($telemetrySelfTest.state -eq 'passed' -and
        [bool]$telemetrySelfTest.crossRuntimeVectors -and [bool]$telemetrySelfTest.productionWrapper -and
        [bool]$telemetrySelfTest.actualUpsAndTps -and
        [bool]$telemetrySelfTest.tamperRejected -and [bool]$telemetrySelfTest.replayRejected -and
        [bool]$telemetrySelfTest.staleRejected -and [bool]$telemetrySelfTest.sessionMismatchRejected -and
        [bool]$telemetrySelfTest.pidMismatchRejected -and [bool]$telemetrySelfTest.restartGenerationBound -and
        [int]$telemetrySelfTest.shadowCommandsInvoked -eq 0) `
        -Message 'the signed simulation telemetry protocol self-test did not pass'

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

    foreach ($versionCase in @(
        [ordered]@{ version = '1.2.3'; pluginVersion = '1.2.3'; assemblyVersion = '1.2.3.0' },
        [ordered]@{ version = '1.2.3-rc.0'; pluginVersion = '1.2.3'; assemblyVersion = '1.2.3.0' },
        [ordered]@{ version = '40.20.30-rc.12'; pluginVersion = '40.20.30'; assemblyVersion = '40.20.30.0' },
        [ordered]@{ version = '65534.65534.65534'; pluginVersion = '65534.65534.65534'; assemblyVersion = '65534.65534.65534.0' },
        [ordered]@{ version = '65534.0.1-rc.999999'; pluginVersion = '65534.0.1'; assemblyVersion = '65534.0.1.0' }
    )) {
        Assert-DysonBridgeVersion -Version ([string]$versionCase.version)
        Assert-BridgeSelfTest `
            -Condition ((Get-DysonBridgeBepInExVersion -Version ([string]$versionCase.version)) -ceq
                [string]$versionCase.pluginVersion) `
            -Message "the Bridge release-to-BepInEx mapping rejected $($versionCase.version)"
        Assert-BridgeSelfTest `
            -Condition ((Get-DysonBridgeAssemblyVersion -Version ([string]$versionCase.version)) -ceq
                [string]$versionCase.assemblyVersion) `
            -Message "the Bridge version-to-assembly mapping rejected $($versionCase.version)"
    }
    foreach ($invalidVersion in @(
        '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3.4',
        '1.2.3-alpha.1', '1.2.3+build.1', '1.2.3-rc.01', '1.2.3-RC.1',
        '65535.0.0', '1.65535.0', '1.2.65535', '1.2.3-rc.1000000'
    )) {
        Assert-BridgeRejected -Action {
            Get-DysonBridgeAssemblyVersion -Version $invalidVersion
        } -Message "a non-canonical Bridge version was accepted: $invalidVersion"
    }

    $publicSource = Join-Path $PSScriptRoot '..\..\..\integrations\dyson-control-bridge'
    foreach ($name in @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridgePlugin.cs',
        'GameSaveAdapter.cs', 'LoadedSaveEvidencePublisher.cs', 'PlayerRosterPublisher.cs',
        'SimulationTelemetrySampler.cs', 'DysonControlBridge.csproj',
        'dyson-control-bridge.cfg.example', 'README.md'
    )) {
        $target = Join-Path $sourceRoot $name
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
        [System.IO.File]::Copy((Join-Path $publicSource $name), $target, $false)
    }
    $sourceContract = Get-DysonBridgeSourceContract -SourceRoot $sourceRoot
    $sourceVersion = [string]$sourceContract.version
    $sourcePluginVersion = [string]$sourceContract.pluginVersion
    $sourceAssemblyVersion = Get-DysonBridgeAssemblyVersion -Version $sourceVersion
    Assert-BridgeSelfTest -Condition ($sourceVersion -cmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$' -and
        $sourcePluginVersion -ceq (Get-DysonBridgeBepInExVersion -Version $sourceVersion)) `
        -Message 'the public source contract was not accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourceMissing
    [System.IO.File]::Delete((Join-Path $sourceMissing 'LoadedSaveEvidencePublisher.cs'))
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourceMissing } `
        -Message 'a real artifact layout missing LoadedSaveEvidencePublisher.cs was accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourceExtra
    [System.IO.File]::WriteAllText(
        (Join-Path $sourceExtra 'UnexpectedBridgeSource.cs'),
        'namespace DysonControl.Bridge { internal sealed class UnexpectedBridgeSource {} }',
        [System.Text.UTF8Encoding]::new($false)
    )
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourceExtra } `
        -Message 'a real artifact layout with an unexpected source file was accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourceTampered
    $tamperedPluginSource = Join-Path $sourceTampered 'DysonControlBridgePlugin.cs'
    $mismatchedSourceVersion = if ($sourceVersion -ceq '9.9.9') { '9.9.8' } else { '9.9.9' }
    $tamperedPluginText = [System.IO.File]::ReadAllText($tamperedPluginSource, [System.Text.Encoding]::UTF8).Replace(
        "public const string ReleaseVersion = `"$sourceVersion`";",
        "public const string ReleaseVersion = `"$mismatchedSourceVersion`";"
    )
    [System.IO.File]::WriteAllText($tamperedPluginSource, $tamperedPluginText, [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourceTampered } `
        -Message 'a source package with mismatched ReleaseVersion was accepted'
    Copy-BridgeTree -Source $sourceRoot -Destination $sourcePluginTampered
    $tamperedPluginSource = Join-Path $sourcePluginTampered 'DysonControlBridgePlugin.cs'
    $mismatchedPluginVersion = if ($sourcePluginVersion -ceq '9.9.9') { '9.9.8' } else { '9.9.9' }
    $tamperedPluginText = [System.IO.File]::ReadAllText($tamperedPluginSource, [System.Text.Encoding]::UTF8).Replace(
        "public const string PluginVersion = `"$sourcePluginVersion`";",
        "public const string PluginVersion = `"$mismatchedPluginVersion`";"
    )
    [System.IO.File]::WriteAllText($tamperedPluginSource, $tamperedPluginText, [System.Text.UTF8Encoding]::new($false))
    Assert-BridgeRejected -Action { Get-DysonBridgeSourceContract -SourceRoot $sourcePluginTampered } `
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
    $pluginSource = @"
using System.Reflection;
[assembly: AssemblyVersion("$sourceAssemblyVersion")]
[assembly: AssemblyFileVersion("$sourceAssemblyVersion")]
[assembly: AssemblyInformationalVersion("$sourceVersion")]
namespace DysonControl.Bridge {
    public sealed class DysonControlBridgePlugin {
        public const string PluginGuid = "io.github.mikutea.dyson-control-bridge";
        public const string PluginName = "Dyson Control Bridge";
        public const string PluginVersion = "$sourcePluginVersion";
        public const string ReleaseVersion = "$sourceVersion";
    }
}
"@
    Add-Type -TypeDefinition $pluginSource -Language CSharp -OutputAssembly (Join-Path $candidateRoot $script:DysonBridgeDllName) -OutputType Library
    $references = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $serverRoot)
    $plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath (Join-Path $candidateRoot $script:DysonBridgeDllName) -DysonServerRoot $serverRoot
    [void](Write-DysonBridgeCandidateManifest -CandidateRoot $candidateRoot -Plugin $plugin -References $references -Sources $sourceContract.files)
    $verified = Test-DysonBridgeCandidateCore -CandidateRoot $candidateRoot -DysonServerRoot $serverRoot `
        -ExpectedVersion $sourceVersion
    Assert-BridgeSelfTest -Condition ([bool]$verified.ready -and $verified.guid -eq $script:DysonBridgeGuid) -Message 'the controlled private candidate was not verified'

    [System.IO.Directory]::CreateDirectory($candidateProductVersionMismatch) | Out-Null
    $mismatchedProductVersion = if ($sourceVersion -cne $sourcePluginVersion) { $sourcePluginVersion } else { '9.9.9' }
    $mismatchedProductSource = @"
using System.Reflection;
[assembly: AssemblyVersion("$sourceAssemblyVersion")]
[assembly: AssemblyFileVersion("$sourceAssemblyVersion")]
[assembly: AssemblyInformationalVersion("$mismatchedProductVersion")]
namespace DysonControl.Bridge {
    public sealed class DysonControlBridgePlugin {
        public const string PluginGuid = "io.github.mikutea.dyson-control-bridge";
        public const string PluginName = "Dyson Control Bridge";
        public const string PluginVersion = "$sourcePluginVersion";
        public const string ReleaseVersion = "$sourceVersion";
    }
}
"@
    Add-Type -TypeDefinition $mismatchedProductSource -Language CSharp `
        -OutputAssembly (Join-Path $candidateProductVersionMismatch $script:DysonBridgeDllName) -OutputType Library
    Assert-BridgeRejected -Action {
        Get-DysonBridgeAssemblyMetadata `
            -AssemblyPath (Join-Path $candidateProductVersionMismatch $script:DysonBridgeDllName) `
            -DysonServerRoot $serverRoot
    } -Message 'a candidate whose ProductVersion did not exactly match ReleaseVersion was accepted'

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

    Copy-BridgeTree -Source $candidateRoot -Destination $candidateManifestVersionTampered
    $tamperedManifestPath = Join-Path $candidateManifestVersionTampered $script:DysonBridgeManifestName
    $tamperedManifest = [System.IO.File]::ReadAllText($tamperedManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $tamperedManifest.plugin.informationalVersion = $mismatchedProductVersion
    [System.IO.File]::WriteAllText(
        $tamperedManifestPath,
        ($tamperedManifest | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    Assert-BridgeRejected -Action {
        Test-DysonBridgeCandidateCore -CandidateRoot $candidateManifestVersionTampered -DysonServerRoot $serverRoot
    } -Message 'a candidate manifest with a changed informational release version was accepted'

    $buildScript = Join-Path $PSScriptRoot 'Build-DysonControlBridgeCandidate.ps1'
    $netstandardReference = Join-Path $serverRoot 'DSPGAME_Data\Managed\netstandard.dll'
    $netstandardBackup = Join-Path $testRoot 'netstandard.reference.backup.dll'
    $missingNetstandardOutput = Join-Path $testRoot 'missing-netstandard-build-must-not-exist'
    [System.IO.File]::Move($netstandardReference, $netstandardBackup)
    try {
        Assert-BridgeRejected -Action {
            Get-DysonBridgeReferenceReceipts -DysonServerRoot $serverRoot
        } -Message 'reference receipts were issued without the fixed netstandard.dll dependency'
        Assert-BridgeRejected -Action {
            & $buildScript -SourcePath $sourceRoot -DysonServerRoot $serverRoot `
                -OutputPath $missingNetstandardOutput -ExpectedVersion $sourceVersion -WhatIf 6>$null
        } -Message 'the target builder accepted a server root missing the fixed netstandard.dll dependency'
        Assert-BridgeSelfTest -Condition (-not (Test-Path -LiteralPath $missingNetstandardOutput)) `
            -Message 'the rejected missing-netstandard target build published output'
    }
    finally {
        [System.IO.File]::Move($netstandardBackup, $netstandardReference)
    }
    $restoredReferenceReceipts = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $serverRoot)
    Assert-BridgeSelfTest -Condition (
        $restoredReferenceReceipts.Count -eq @(Get-DysonBridgeReferenceSpecifications).Count -and
        @($restoredReferenceReceipts | Where-Object {
            $_.name -ceq 'netstandard.dll' -and $_.relativePath -ceq 'DSPGAME_Data/Managed/netstandard.dll'
        }).Count -eq 1
    ) -Message 'restoring the fixed netstandard.dll dependency did not restore reference receipt validation'

    [System.IO.Directory]::CreateDirectory($redirectTarget) | Out-Null
    [void](New-Item -ItemType Junction -Path $candidateRedirect -Target $redirectTarget -ErrorAction Stop)
    $redirectCreated = $true
    Assert-BridgeRejected -Action { Test-DysonBridgeCandidateCore -CandidateRoot $candidateRedirect -DysonServerRoot $serverRoot } `
        -Message 'a redirected private candidate root was accepted'
    Remove-Item -LiteralPath $candidateRedirect -Force
    $redirectCreated = $false

    $buildPreviewPath = Join-Path $testRoot 'build-preview-must-not-exist'
    $buildPreview = Get-LastBridgeJson -Output (& $buildScript -SourcePath $sourceRoot -DysonServerRoot $serverRoot `
        -OutputPath $buildPreviewPath -ExpectedVersion $sourceVersion -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($buildPreview.state -eq 'preview' -and -not (Test-Path -LiteralPath $buildPreviewPath)) `
        -Message 'the private builder WhatIf changed the filesystem'

    $realDotnetCommand = Get-Command 'dotnet.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $realDotnetPath = (Assert-DysonBridgePlainFile -Path $realDotnetCommand.Source -MaximumBytes 512MB).FullName
    $dotnetVersionResult = Invoke-DysonBridgeProcess -Executable $realDotnetPath -Arguments '--version' `
        -WorkingDirectory $sourceRoot -TimeoutMilliseconds 30000 -MaximumOutputCharacters 4096
    $dotnetMajorText = ([string]$dotnetVersionResult.stdout).Trim().Split('.')[0]
    if ($dotnetMajorText -notmatch '^[0-9]{1,2}$' -or [int]$dotnetMajorText -lt 8) {
        throw 'The controlled real dotnet build requires SDK major version 8 or newer.'
    }
    $realBuildRoot = Join-Path $testRoot 'real dotnet path with spaces'
    $realProjectRoot = Join-Path $realBuildRoot 'project source'
    [System.IO.Directory]::CreateDirectory($realProjectRoot) | Out-Null
    $realProjectPath = Join-Path $realProjectRoot 'ProcessStartInfoVersionFixture.csproj'
    $realProjectSource = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net$dotnetMajorText.0</TargetFramework>
    <AssemblyName>ProcessStartInfoVersionFixture</AssemblyName>
    <Version>$sourceVersion</Version>
    <AssemblyVersion>$sourceAssemblyVersion</AssemblyVersion>
    <FileVersion>$sourceAssemblyVersion</FileVersion>
    <InformationalVersion>$sourceVersion</InformationalVersion>
    <IncludeSourceRevisionInInformationalVersion>false</IncludeSourceRevisionInInformationalVersion>
  </PropertyGroup>
</Project>
"@
    [System.IO.File]::WriteAllText($realProjectPath, $realProjectSource, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText(
        (Join-Path $realProjectRoot 'VersionFixture.cs'),
        'public sealed class VersionFixture { }',
        [System.Text.UTF8Encoding]::new($false)
    )
    $realObjRoot = [System.IO.Path]::GetFullPath((Join-Path $realBuildRoot 'obj output')).TrimEnd('\', '/') + '/'
    $realBinRoot = [System.IO.Path]::GetFullPath((Join-Path $realBuildRoot 'bin output')).TrimEnd('\', '/') + '/'
    $realPackagesRoot = [System.IO.Path]::GetFullPath((Join-Path $realBuildRoot 'packages cache')).TrimEnd('\', '/') + '/'
    $realCliHome = Join-Path $realBuildRoot 'dotnet cli home'
    foreach ($directory in @($realObjRoot, $realBinRoot, $realPackagesRoot, $realCliHome)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $realBuildArguments = @(
        'build', ('"{0}"' -f $realProjectPath), '--configuration', 'Release', '--nologo', '--verbosity', 'quiet',
        '--disable-build-servers', ('--property:BaseIntermediateOutputPath="{0}"' -f $realObjRoot),
        ('--property:MSBuildProjectExtensionsPath="{0}"' -f $realObjRoot),
        ('--property:OutputPath="{0}"' -f $realBinRoot),
        ('--property:RestorePackagesPath="{0}"' -f $realPackagesRoot),
        '--property:RestoreIgnoreFailedSources=true', '--property:ImportDirectoryBuildProps=false',
        '--property:ImportDirectoryBuildTargets=false', '--property:UseSharedCompilation=false',
        '--property:ContinuousIntegrationBuild=true', '--property:Deterministic=true',
        '--property:IncludeSourceRevisionInInformationalVersion=false'
    ) -join ' '
    [void](Invoke-DysonBridgeProcess -Executable $realDotnetPath -Arguments $realBuildArguments `
        -WorkingDirectory $realProjectRoot -TimeoutMilliseconds 120000 -MaximumOutputCharacters 262144 `
        -Environment @{
            DOTNET_CLI_HOME = $realCliHome
            DOTNET_NOLOGO = '1'
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
            DOTNET_CLI_TELEMETRY_OPTOUT = '1'
        })
    $realBuiltDlls = @(Assert-DysonBridgeTreePlain -Root $realBinRoot | Where-Object {
        $_.Name -ceq 'ProcessStartInfoVersionFixture.dll'
    })
    Assert-BridgeSelfTest -Condition ($realBuiltDlls.Count -eq 1) `
        -Message 'the real dotnet ProcessStartInfo fixture did not produce exactly one DLL'
    $realBuiltAssemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($realBuiltDlls[0].FullName)
    $realBuiltVersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($realBuiltDlls[0].FullName)
    Assert-BridgeSelfTest -Condition (
        [string]$realBuiltAssemblyName.Version -ceq $sourceAssemblyVersion -and
        [string]$realBuiltVersionInfo.FileVersion -ceq $sourceAssemblyVersion -and
        [string]$realBuiltVersionInfo.ProductVersion -ceq $sourceVersion
    ) -Message 'the real dotnet build did not preserve the numeric and full RC version layers'

    [System.IO.Directory]::CreateDirectory($fakeDotnetRoot) | Out-Null
    $fakeDotnetPath = Join-Path $fakeDotnetRoot 'dotnet.exe'
    $fakeDotnetFixturePath = Join-Path $fakeDotnetRoot 'DysonControlBridge.fixture.dll'
    [System.IO.File]::Copy((Join-Path $candidateRoot $script:DysonBridgeDllName), $fakeDotnetFixturePath, $false)
    $fakeDotnetSource = @'
using System;
using System.IO;

public static class ControlledDotnetFixture
{
    private static string ReadDirectory(string[] arguments, string name)
    {
        var prefix = "--property:" + name + "=";
        string value = null;
        foreach (var argument in arguments)
        {
            if (!argument.StartsWith(prefix, StringComparison.Ordinal)) continue;
            if (value != null) throw new InvalidOperationException("duplicate build directory");
            value = argument.Substring(prefix.Length);
        }
        if (value == null || value.IndexOf('"') >= 0)
            throw new InvalidOperationException("missing or incorrectly tokenized build directory");
        if (!Path.IsPathRooted(value) ||
            !value.EndsWith(Path.AltDirectorySeparatorChar.ToString(), StringComparison.Ordinal))
        {
            throw new InvalidOperationException("build directory is not normalized with a safe trailing separator");
        }
        return value;
    }

    public static int Main(string[] arguments)
    {
        try
        {
            ReadDirectory(arguments, "BaseIntermediateOutputPath");
            ReadDirectory(arguments, "MSBuildProjectExtensionsPath");
            var output = ReadDirectory(arguments, "OutputPath");
            ReadDirectory(arguments, "RestorePackagesPath");
            if (Array.FindAll(arguments, value =>
                    value == "--property:IncludeSourceRevisionInInformationalVersion=false").Length != 1)
                throw new InvalidOperationException("informational version stability was not pinned");
            Directory.CreateDirectory(output);
            File.Copy(
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DysonControlBridge.fixture.dll"),
                Path.Combine(output, "DysonControlBridge.dll"),
                false
            );
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.GetType().Name);
            return 19;
        }
    }
}
'@
    Add-Type -TypeDefinition $fakeDotnetSource -Language CSharp -OutputAssembly $fakeDotnetPath -OutputType ConsoleApplication
    $builtCandidate = Get-LastBridgeJson -Output (& $buildScript -SourcePath $sourceRoot -DysonServerRoot $serverRoot `
        -OutputPath $builtCandidateRoot -DotnetExecutable $fakeDotnetPath -ExpectedVersion $sourceVersion `
        -BuildTimeoutSeconds 30 -Confirm:$false)
    $builtCandidateVerification = Test-DysonBridgeCandidateCore -CandidateRoot $builtCandidateRoot `
        -DysonServerRoot $serverRoot -ExpectedVersion $sourceVersion
    Assert-BridgeSelfTest -Condition ($builtCandidate.state -eq 'created' -and
        $builtCandidate.version -ceq $sourceVersion -and [bool]$builtCandidateVerification.ready -and
        $builtCandidateVerification.version -ceq $sourceVersion) `
        -Message 'the controlled non-WhatIf builder fixture did not produce a verified RC candidate'

    $installScript = Join-Path $PSScriptRoot 'Install-DysonControlBridge.ps1'
    $testScript = Join-Path $PSScriptRoot 'Test-DysonControlBridgeInstallation.ps1'
    $uninstallScript = Join-Path $PSScriptRoot 'Uninstall-DysonControlBridge.ps1'
    $pluginPath = Join-Path $serverRoot ('BepInEx\plugins\dyson-control-bridge\' + $script:DysonBridgeDllName)
    $configPath = Join-Path $serverRoot ('BepInEx\config\' + $script:DysonBridgeConfigName)
    $secretPath = Join-Path $serverRoot ('BepInEx\config\' + $script:DysonBridgeSecretName)
    $installPreview = Get-LastBridgeJson -Output (& $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot `
        -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($installPreview.state -eq 'preview' -and -not (Test-Path -LiteralPath $pluginPath) -and
        -not (Test-Path -LiteralPath $configPath) -and -not (Test-Path -LiteralPath $secretPath)) `
        -Message 'Bridge install WhatIf changed the game tree'

    $installed = Get-LastBridgeJson -Output (& $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot `
        -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid -Confirm:$false)
    Assert-BridgeSelfTest -Condition ($installed.state -eq 'installed' -and $installed.enabled -eq $false -and
        $installed.secretDisclosed -eq $false -and $installed.gameRestarted -eq $false) -Message 'Bridge installation did not complete fail-closed'
    $installation = Get-LastBridgeJson -Output (& $testScript -DysonServerRoot $serverRoot)
    Assert-BridgeSelfTest -Condition ([bool]$installation.ready -and $installation.enabled -eq $false -and
        [bool]$installation.secretBytesAtLeast32 -and [bool]$installation.secretAclProtected -and
        [bool]$installation.twoIdentityAclContractVerified -and $installation.controlServiceSid -eq $controlServiceSid -and
        $installation.gameServiceSid -eq $gameServiceSid) `
        -Message 'the installed Bridge did not verify'
    Assert-BridgeSelfTest -Condition ($global:DysonBridgeSelfTestAclShadowCalls -eq 0) `
        -Message 'a Bridge ACL operation resolved through an untrusted command shadow'

    $beforeRollbackDll = Get-DysonBridgeSha256 -Path $pluginPath
    $beforeRollbackConfig = Get-DysonBridgeSha256 -Path $configPath
    $controlRoot = Join-Path $serverRoot 'BepInEx\dyson-control-bridge'
    $controlPaths = Get-DysonBridgeControlTreePaths -ControlRoot $controlRoot
    $beforeRollbackAcls = @{}
    foreach ($entry in @($controlPaths.GetEnumerator())) {
        $beforeRollbackAcls[[string]$entry.Key] = Get-DysonBridgeAccessSddl -Path ([string]$entry.Value)
    }
    $beforeRollbackSecretAcl = Get-DysonBridgeAccessSddl -Path $secretPath
    $env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE = 'true'
    try {
        Assert-BridgeRejected -Action {
            & $installScript -CandidatePath $candidateRoot -DysonServerRoot $serverRoot `
                -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid `
                -SelfTestFailureAfterPluginPublish -Confirm:$false
        } -Message 'the isolated install failure hook did not fail'
    }
    finally { Remove-Item Env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE -ErrorAction SilentlyContinue }
    Assert-BridgeSelfTest -Condition ((Get-DysonBridgeSha256 -Path $pluginPath) -eq $beforeRollbackDll -and
        (Get-DysonBridgeSha256 -Path $configPath) -eq $beforeRollbackConfig) -Message 'a failed Bridge install did not restore the prior DLL/config'
    Assert-BridgeSelfTest -Condition ((Get-DysonBridgeAccessSddl -Path $secretPath) -eq $beforeRollbackSecretAcl) `
        -Message 'a failed Bridge install did not restore the prior secret ACL'
    foreach ($entry in @($controlPaths.GetEnumerator())) {
        Assert-BridgeSelfTest -Condition ((Get-DysonBridgeAccessSddl -Path ([string]$entry.Value)) -eq $beforeRollbackAcls[[string]$entry.Key]) `
            -Message "a failed Bridge install did not restore the prior $($entry.Key) ACL"
    }

    $requestsAcl = New-DysonBridgeAclObject -Kind requests -InstallerSid (Get-DysonBridgeCurrentInstallerSid) `
        -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid
    $requestsAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($controlServiceSid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )) | Out-Null
    Set-DysonBridgeExactAclObject -Path ([string]$controlPaths.requests) -Acl $requestsAcl -Directory
    Assert-BridgeRejected -Action { & $testScript -DysonServerRoot $serverRoot } `
        -Message 'a Bridge request directory granting control-service FullControl was accepted'
    [void](Initialize-DysonBridgeControlTreeAcl -ControlRoot $controlRoot `
        -InstallerSid (Get-DysonBridgeCurrentInstallerSid) -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid)
    [void](& $testScript -DysonServerRoot $serverRoot)

    $uninstallPreview = Get-LastBridgeJson -Output (& $uninstallScript -DysonServerRoot $serverRoot -WhatIf 6>$null)
    Assert-BridgeSelfTest -Condition ($uninstallPreview.state -eq 'uninstall-preview' -and
        (Test-Path -LiteralPath $pluginPath) -and (Test-Path -LiteralPath $configPath)) -Message 'Bridge uninstall WhatIf changed installed files'
    $uninstalled = Get-LastBridgeJson -Output (& $uninstallScript -DysonServerRoot $serverRoot -Confirm:$false)
    Assert-BridgeSelfTest -Condition ($uninstalled.state -eq 'uninstalled-recoverable' -and
        -not (Test-Path -LiteralPath $pluginPath) -and -not (Test-Path -LiteralPath $configPath) -and
        (Test-Path -LiteralPath $secretPath)) -Message 'recoverable Bridge uninstall did not preserve its boundary'
    $uninstallSnapshotRoot = Join-Path `
        (Join-Path $serverRoot 'BepInEx\config\dyson-control-bridge-snapshots') `
        ([string]$uninstalled.snapshotId)
    $uninstallManifestPath = Join-Path $uninstallSnapshotRoot 'uninstall-manifest.json'
    $legacyAtomicBoundaryPath = Join-Path $uninstallSnapshotRoot $legacyAtomicNameBoundary
    $atomicResidue = @(Get-ChildItem -LiteralPath $uninstallSnapshotRoot -Force | Where-Object {
        $_.Name -match '^(?:\.dyson-bridge-[0-9a-f]{32}\.(?:tmp|bak)|[a-z0-9]{8}\.[a-z0-9]{3})$' -and
        $_.Name -ne 'uninstall-manifest.json'
    })
    Assert-BridgeSelfTest -Condition (
        $legacyAtomicBoundaryPath.Length -ge 260 -and
        $uninstallManifestPath.Length -lt $legacyAtomicBoundaryPath.Length -and
        (Test-Path -LiteralPath $uninstallManifestPath -PathType Leaf) -and
        $atomicResidue.Count -eq 0
    ) -Message 'the recoverable uninstall did not cover the long-path atomic manifest boundary without residue'
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
        realArtifactSourceLayoutValidated = $true
        missingAndUnexpectedSourceLayoutRejected = $true
        stableAndPrereleaseVersionsValidated = $true
        prereleaseBepInExVersionCoreMappingValidated = $true
        prereleaseAssemblyVersionCoreMappingValidated = $true
        informationalProductVersionBoundToReleaseVersion = $true
        productVersionMismatchRejected = $true
        sourceVersionAndExecutableTargetTamperRejected = $true
        buildBoundaryPreviewValidated = $true
        nonWhatIfBuildDirectoryArgumentsValidated = $true
        realDotnetProcessStartInfoBuildWithSpacesValidated = $true
        sourceRevisionSuffixDisabledDuringBuild = $true
        controlledBuildProcessTimeoutAndOutputBounded = $true
        fullBuildRequiresLawfulLocalAssemblies = $true
        missingFixedNetstandardDependencyRejected = $true
        restoredFixedNetstandardDependencyValidated = $true
        candidateMetadataAndReferencesValidated = $true
        candidateInformationalVersionTamperRejected = $true
        changedAndRedirectedReferencesRejected = $true
        candidateTamperExtraAndReparseRejected = $true
        signedSimulationTelemetryValidated = $true
        installWhatIfWasNonMutating = $true
        installDefaultedDisabled = $true
        platformSecurityModuleBound = $true
        secretWasRandomProtectedAndUndisclosed = $true
        exactTwoIdentityAclContractValidated = $true
        controlServiceFullControlDriftRejected = $true
        failedInstallRolledBack = $true
        uninstallWasRecoverable = $true
        saveGameNebulaAndGsmWereUntouched = $true
        productionChanged = $false
    } | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Remove-Item Env:DYSON_BRIDGE_ALLOW_SELFTEST_FAILURE -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonBridgeSelfTestAclShadowCalls -Scope Global -ErrorAction SilentlyContinue
    if ($redirectCreated -and (Test-Path -LiteralPath $candidateRedirect)) {
        $item = Get-Item -LiteralPath $candidateRedirect -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $candidateRedirect -Force -ErrorAction SilentlyContinue
        }
    }
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-bridge-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testFull)) {
        $separator = [string][System.IO.Path]::DirectorySeparatorChar
        $doubleSeparator = $separator + $separator
        $extendedPrefix = $doubleSeparator + '?' + $separator
        $extendedTestFull = if ($testFull.StartsWith($doubleSeparator, [System.StringComparison]::Ordinal)) {
            $extendedPrefix + 'UNC' + $separator + $testFull.Substring(2)
        }
        else { $extendedPrefix + $testFull }
        [System.IO.Directory]::Delete($extendedTestFull, $true)
    }
}
