[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleaseArchive.Common.ps1')

$newPackageScript = Join-Path $PSScriptRoot 'New-DysonControlReleasePackage.ps1'
$testPackageScript = Join-Path $PSScriptRoot 'Test-DysonControlReleasePackage.ps1'
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-release-package-selftest-' + [guid]::NewGuid().ToString('N'))
$artifactRoot = Join-Path $testRoot 'artifact'
$packageA = Join-Path $testRoot 'package-a'
$packageB = Join-Path $testRoot 'package-b'
$packagePreview = Join-Path $testRoot 'package-preview'
$packageInvalidTag = Join-Path $testRoot 'package-invalid-tag'
$packageInvalidArtifact = Join-Path $testRoot 'package-invalid-artifact'
$packageArchiveTamper = Join-Path $testRoot 'package-archive-tamper'
$packageChecksumTamper = Join-Path $testRoot 'package-checksum-tamper'
$packageProvenanceTamper = Join-Path $testRoot 'package-provenance-tamper'
$tag = 'v1.2.3-rc.4'
$version = '1.2.3-rc.4'
$commit = '0123456789abcdef0123456789abcdef01234567'
$nodeVersion = '24.14.0'

function Assert-PackageSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Release package self-test failed: $Message" }
}

function Write-FixtureText {
    param([string]$Path, [string]$Value)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Copy-FixturePackage {
    param([string]$Source, [string]$Destination)
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -File -Force -ErrorAction Stop)) {
        [System.IO.File]::Copy($item.FullName, (Join-Path $Destination $item.Name), $false)
    }
}

function Convert-LastJsonResult {
    param($Output)
    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'A release package self-test command returned no JSON.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json
}

function Test-CommandRejected {
    param([scriptblock]$Command)
    try { & $Command; return $false }
    catch { return $true }
}

function Get-FixtureArchiveEntryNames {
    param([Parameter(Mandatory)][string]$Path)

    Add-Type -AssemblyName System.IO.Compression
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $archive = $null
    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $stream,
            [System.IO.Compression.ZipArchiveMode]::Read,
            $true,
            [System.Text.UTF8Encoding]::new($false)
        )
        return [string[]]@($archive.Entries | ForEach-Object { [string]$_.FullName })
    }
    finally {
        if ($null -ne $archive) { $archive.Dispose() }
        $stream.Dispose()
    }
}

[System.IO.Directory]::CreateDirectory($artifactRoot) | Out-Null
try {
    Write-FixtureText -Path (Join-Path $artifactRoot 'LICENSE') -Value "Fictional release fixture license.`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\package.json') -Value @'
{"name":"@example/dyson-control-package-fixture","version":"1.2.3-rc.4","private":true,"type":"module","main":"dist/index.js","dependencies":{}}
'@
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\package-lock.json') -Value @'
{"name":"@example/dyson-control-package-fixture","version":"1.2.3-rc.4","lockfileVersion":3,"requires":true,"packages":{"":{"name":"@example/dyson-control-package-fixture","version":"1.2.3-rc.4","dependencies":{}}}}
'@
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\dist\index.js') -Value "console.log('fictional package fixture')`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\dist\lifecycle\game-runtime-receipts.js') `
        -Value "export const fictionalGameRuntimeReceipts = true`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\web\dist\index.html') -Value "<!doctype html><title>Fictional package fixture</title>`n"
    foreach ($relative in @(
        $script:DysonArtifactRequiredApiUpdateRuntimeFiles +
        $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles +
        $script:DysonArtifactRequiredApiObservabilityRuntimeFiles +
        $script:DysonArtifactRequiredTopLevelWindowsScripts +
        $script:DysonArtifactRequiredReleaseScripts +
        $script:DysonArtifactRequiredDeploymentScripts +
        $script:DysonArtifactRequiredConfigurationFiles +
        $script:DysonArtifactRequiredSessionScripts +
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredGsManagerRemovalScripts +
        $script:DysonArtifactRequiredEvidenceScripts +
        $script:DysonArtifactRequiredHostMutationScripts +
        $script:DysonArtifactRequiredGameBootstrapScripts +
        $script:DysonArtifactRequiredCutoverScripts +
        $script:DysonArtifactRequiredCutoverBrokerScripts +
        $script:DysonArtifactRequiredLifecycleBrokerScripts +
        $script:DysonArtifactRequiredDataRecoveryScripts +
        $script:DysonArtifactRequiredNetworkFiles +
        $script:DysonArtifactRequiredQualificationRuntimeFiles +
        $script:DysonArtifactRequiredNebulaHostnameWssSources +
        $script:DysonArtifactRequiredMigrationDocs +
        $script:DysonArtifactRequiredGsManagerRemovalDocs +
        $script:DysonArtifactRequiredRecoveryDocs +
        $script:DysonArtifactRequiredNetworkDocs +
        $script:DysonArtifactRequiredQualificationDocs
    )) {
        Write-FixtureText -Path (Join-Path $artifactRoot $relative.Replace('/', '\')) `
            -Value "Fictional required release fixture: $relative`n"
    }
    Write-FixtureText -Path (Join-Path $artifactRoot `
        'integrations\dyson-control-bridge\DysonControlBridge.csproj') -Value @'
<Project><ItemGroup>
<Reference Include="BepInEx"><HintPath>$(DysonServerRoot)\BepInEx\core\BepInEx.dll</HintPath><Private>false</Private></Reference>
<Reference Include="0Harmony"><HintPath>$(DysonServerRoot)\BepInEx\core\0Harmony.dll</HintPath><Private>false</Private></Reference>
<Reference Include="UnityEngine"><HintPath>$(DysonServerRoot)\DSPGAME_Data\Managed\UnityEngine.dll</HintPath><Private>false</Private></Reference>
<Reference Include="UnityEngine.CoreModule"><HintPath>$(DysonServerRoot)\DSPGAME_Data\Managed\UnityEngine.CoreModule.dll</HintPath><Private>false</Private></Reference>
<Reference Include="netstandard"><HintPath>$(DysonServerRoot)\DSPGAME_Data\Managed\netstandard.dll</HintPath><Private>false</Private></Reference>
<Reference Include="Assembly-CSharp"><HintPath>$(DysonServerRoot)\DSPGAME_Data\Managed\Assembly-CSharp.dll</HintPath><Private>false</Private></Reference>
<Reference Include="NebulaAPI"><HintPath>$(DysonServerRoot)\BepInEx\plugins\nebula-NebulaMultiplayerModApi\NebulaAPI.dll</HintPath><Private>false</Private></Reference>
<Reference Include="NebulaModel"><HintPath>$(DysonServerRoot)\BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaModel.dll</HintPath><Private>false</Private></Reference>
</ItemGroup></Project>
'@
    Write-FixtureText -Path (Join-Path $artifactRoot `
        'scripts\windows\bridge\DysonBridge.Common.ps1') -Value @'
function Get-DysonBridgeReferenceSpecifications {
    return @(
        [ordered]@{ name = 'BepInEx.dll'; relativePath = 'BepInEx\core\BepInEx.dll' },
        [ordered]@{ name = '0Harmony.dll'; relativePath = 'BepInEx\core\0Harmony.dll' },
        [ordered]@{ name = 'UnityEngine.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.dll' },
        [ordered]@{ name = 'UnityEngine.CoreModule.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.CoreModule.dll' },
        [ordered]@{ name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard.dll' },
        [ordered]@{ name = 'Assembly-CSharp.dll'; relativePath = 'DSPGAME_Data\Managed\Assembly-CSharp.dll' },
        [ordered]@{ name = 'NebulaAPI.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerModApi\NebulaAPI.dll' },
        [ordered]@{ name = 'NebulaModel.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaModel.dll' }
    )
}
'@
    [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version -DevDependenciesExcluded @())
    [void](Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version)

    $preview = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packagePreview `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -WhatIf)
    Assert-PackageSelfTest -Condition ($preview.state -eq 'preview' -and [bool]$preview.dryRun) -Message 'WhatIf did not return a preview'
    Assert-PackageSelfTest -Condition (-not (Test-Path -LiteralPath $packagePreview)) -Message 'WhatIf created an output directory'

    $createdA = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageA `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -Confirm:$false)
    $createdB = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageB `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -Confirm:$false)
    $verifiedA = Convert-LastJsonResult -Output (& $testPackageScript -PackageDirectory $packageA -ExpectedTag $tag -ExpectedCommit $commit)
    $verifiedB = Convert-LastJsonResult -Output (& $testPackageScript -PackageDirectory $packageB -ExpectedTag $tag -ExpectedCommit $commit)
    Assert-PackageSelfTest -Condition ($createdA.state -eq 'created' -and $createdB.state -eq 'created' -and
        [bool]$verifiedA.ready -and [bool]$verifiedB.ready) -Message 'valid release packages did not verify'

    $names = Get-DysonReleaseAssetNames -Tag $tag
    $archiveEntries = @(Get-FixtureArchiveEntryNames -Path (Join-Path $packageA $names.archive))
    Assert-PackageSelfTest -Condition ($archiveEntries -ccontains `
        'apps/api/dist/lifecycle/game-runtime-receipts.js') `
        -Message 'the compiled game-runtime receipt API was omitted from the release archive'
    Assert-PackageSelfTest -Condition ($archiveEntries -cnotcontains `
        'apps/api/dist/lifecycle/game-runtime-receipts.test.js') `
        -Message 'the game-runtime receipt API test entered the release archive'
    foreach ($relative in $script:DysonArtifactRequiredApiUpdateRuntimeFiles) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "a required Windows update runtime API file was omitted from the release archive: $relative"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "a required hostname-WSS client qualification API file was omitted from the release archive: $relative"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiObservabilityRuntimeFiles) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "a required observability runtime API file was omitted from the release archive: $relative"
    }
    foreach ($relative in @($script:DysonArtifactRequiredNetworkFiles + $script:DysonArtifactRequiredNetworkDocs)) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "the required network assessment file was omitted from the release archive: $relative"
    }
    foreach ($relative in @(
        $script:DysonArtifactRequiredQualificationRuntimeFiles +
        $script:DysonArtifactRequiredNebulaHostnameWssSources +
        $script:DysonArtifactRequiredQualificationDocs
    )) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "the required qualification runtime, hostname-WSS source contract, or public guide was omitted from the release archive: $relative"
    }
    Assert-PackageSelfTest -Condition (@($archiveEntries | Where-Object {
        $_ -like 'scripts/windows/qualification/.codex-temp/*' -or
        $_ -like 'scripts/windows/qualification/*private-evidence*' -or
        $_ -like 'scripts/windows/qualification/*cache*'
    }).Count -eq 0) -Message 'private qualification evidence or cache content entered the release archive'
    foreach ($relative in $script:DysonArtifactRequiredConfigurationFiles) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "a required protected configuration file was omitted from the release archive: $relative"
    }
    foreach ($relative in @(
        'scripts/windows/deployment/DysonNodeRuntime.Transaction.ps1',
        'scripts/windows/deployment/Install-DysonNodeRuntime.ps1',
        'scripts/windows/deployment/Repair-DysonNodeRuntime.ps1'
    )) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "the protected Node runtime delivery chain omitted $relative"
    }
    foreach ($relative in $script:DysonArtifactRequiredBridgeSimulationTelemetryFiles) {
        Assert-PackageSelfTest -Condition ($archiveEntries -ccontains $relative) `
            -Message "the required Bridge simulation telemetry file was omitted from the release archive: $relative"
    }
    Assert-PackageSelfTest -Condition ($archiveEntries -ccontains `
        'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.cs') `
        -Message 'LoadedSaveEvidencePublisher.cs was omitted from the release archive'

    $observabilityMissingCases = 0
    foreach ($relative in $script:DysonArtifactRequiredApiObservabilityRuntimeFiles) {
        $requiredPath = Join-Path $artifactRoot $relative.Replace('/', '\')
        $backupPath = Join-Path $testRoot ("observability-$observabilityMissingCases.backup")
        [System.IO.File]::Move($requiredPath, $backupPath)
        try {
            Assert-PackageSelfTest -Condition (Test-CommandRejected {
                Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
            }) -Message "a release artifact missing required observability runtime was accepted: $relative"
        }
        finally { [System.IO.File]::Move($backupPath, $requiredPath) }
        $observabilityMissingCases++
    }
    $unexpectedObservabilityPath = Join-Path $artifactRoot `
        'apps\api\dist\observability\unreviewed-runtime.js'
    Write-FixtureText -Path $unexpectedObservabilityPath -Value "export const unreviewed = true`n"
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a release artifact with an extra observability runtime file was accepted'
    }
    finally { Remove-Item -LiteralPath $unexpectedObservabilityPath -Force }
    $observabilityTamperPath = Join-Path $artifactRoot 'apps\api\dist\observability\long-window.js'
    $observabilityTamperBytes = [System.IO.File]::ReadAllBytes($observabilityTamperPath)
    try {
        [System.IO.File]::AppendAllText($observabilityTamperPath, "tampered`n", [System.Text.UTF8Encoding]::new($false))
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'observability runtime hash tampering was accepted'
    }
    finally { [System.IO.File]::WriteAllBytes($observabilityTamperPath, $observabilityTamperBytes) }

    $canonicalManifestPath = Join-Path $artifactRoot 'artifact-manifest.json'
    $canonicalManifestBytes = [System.IO.File]::ReadAllBytes($canonicalManifestPath)
    $observabilityCanonicalPath = Join-Path $artifactRoot `
        'apps\api\dist\observability\long-window.js'
    $observabilityCaseTemporaryPath = Join-Path $artifactRoot `
        'apps\api\dist\observability\long-window.case-temporary'
    $observabilityWrongCasePath = Join-Path $artifactRoot `
        'apps\api\dist\observability\Long-Window.js'
    [System.IO.File]::Move($observabilityCanonicalPath, $observabilityCaseTemporaryPath)
    [System.IO.File]::Move($observabilityCaseTemporaryPath, $observabilityWrongCasePath)
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version `
                -DevDependenciesExcluded @())
        }) -Message 'a case-drifted observability runtime could be re-manifested'
    }
    finally {
        [System.IO.File]::Move($observabilityWrongCasePath, $observabilityCaseTemporaryPath)
        [System.IO.File]::Move($observabilityCaseTemporaryPath, $observabilityCanonicalPath)
        [System.IO.File]::WriteAllBytes($canonicalManifestPath, $canonicalManifestBytes)
    }

    $separatorManifest = [System.IO.File]::ReadAllText(
        $canonicalManifestPath,
        [System.Text.Encoding]::UTF8
    ) | ConvertFrom-Json
    $separatorEntry = @($separatorManifest.files | Where-Object {
        [string]$_.path -ceq 'apps/api/dist/observability/long-window.js'
    })[0]
    $separatorEntry.path = ([string]$separatorEntry.path).Replace('/', '\')
    [System.IO.File]::WriteAllText(
        $canonicalManifestPath,
        ($separatorManifest | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a manifest entry using non-canonical path separators was accepted'
    }
    finally { [System.IO.File]::WriteAllBytes($canonicalManifestPath, $canonicalManifestBytes) }

    $qualificationOrchestrationMissingCases = 0
    foreach ($relative in $script:DysonArtifactRequiredQualificationOrchestrationV2Files) {
        $requiredPath = Join-Path $artifactRoot $relative.Replace('/', '\')
        $backupPath = Join-Path $testRoot ("qualification-$qualificationOrchestrationMissingCases.backup")
        [System.IO.File]::Move($requiredPath, $backupPath)
        try {
            Assert-PackageSelfTest -Condition (Test-CommandRejected {
                Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
            }) -Message "a release artifact missing qualification orchestration V2 runtime was accepted: $relative"
        }
        finally { [System.IO.File]::Move($backupPath, $requiredPath) }
        $qualificationOrchestrationMissingCases++
    }
    $qualificationFrameworkMissingCases = 0
    foreach ($relative in $script:DysonArtifactRequiredQualificationFrameworkFiles) {
        $requiredPath = Join-Path $artifactRoot $relative.Replace('/', '\')
        $backupPath = Join-Path $testRoot `
            ("qualification-framework-$qualificationFrameworkMissingCases.backup")
        [System.IO.File]::Move($requiredPath, $backupPath)
        try {
            Assert-PackageSelfTest -Condition (Test-CommandRejected {
                Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot `
                    -ExpectedVersion $version | Out-Null
            }) -Message "a release artifact missing a qualification V1/V2 framework dependency was accepted: $relative"
        }
        finally { [System.IO.File]::Move($backupPath, $requiredPath) }
        $qualificationFrameworkMissingCases++
    }
    $strictQualificationRepresentativeMissingCases = 0
    foreach ($relative in @(
        'scripts/windows/qualification/SelfTest-DysonSideBySideObservationV2.ps1',
        'scripts/windows/qualification/SelfTest-DysonQualificationPairedSaveLoadRecordV2.ps1',
        'scripts/windows/qualification/dyson-control-panel-observation-v2.schema.json',
        'scripts/windows/qualification/README.ExternalJoinObservationV2.md',
        'scripts/windows/qualification/Qualification.ReversibleCutover.ps1',
        'scripts/windows/qualification/dyson-post-gsmanager-removal-observation-v2.schema.json',
        'scripts/windows/qualification/SelfTest-DysonSoakObservationV2.ps1'
    )) {
        $requiredPath = Join-Path $artifactRoot $relative.Replace('/', '\')
        $backupPath = Join-Path $testRoot `
            ("strict-qualification-$strictQualificationRepresentativeMissingCases.backup")
        [System.IO.File]::Move($requiredPath, $backupPath)
        try {
            Assert-PackageSelfTest -Condition (Test-CommandRejected {
                Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot `
                    -ExpectedVersion $version | Out-Null
            }) -Message "a release artifact missing representative strict qualification V2 content was accepted: $relative"
        }
        finally { [System.IO.File]::Move($backupPath, $requiredPath) }
        $strictQualificationRepresentativeMissingCases++
    }
    $qualificationDocRelative = $script:DysonArtifactRequiredQualificationDocs[0]
    $qualificationDocPath = Join-Path $artifactRoot $qualificationDocRelative.Replace('/', '\')
    $qualificationDocBackup = Join-Path $testRoot 'qualification-document.backup'
    [System.IO.File]::Move($qualificationDocPath, $qualificationDocBackup)
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot `
                -ExpectedVersion $version | Out-Null
        }) -Message 'a release artifact missing the production qualification guide was accepted'
    }
    finally { [System.IO.File]::Move($qualificationDocBackup, $qualificationDocPath) }
    $unexpectedQualificationPath = Join-Path $artifactRoot `
        'scripts\windows\qualification\Unexpected-OrchestrationV2.ps1'
    Write-FixtureText -Path $unexpectedQualificationPath -Value "throw 'unexpected qualification runtime'`n"
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a release artifact with an extra qualification orchestration V2 file was accepted'
    }
    finally { Remove-Item -LiteralPath $unexpectedQualificationPath -Force }
    $qualificationTamperPath = Join-Path $artifactRoot `
        'scripts\windows\qualification\fixtures\orchestration-adapter-contract.v2.json'
    $qualificationTamperBytes = [System.IO.File]::ReadAllBytes($qualificationTamperPath)
    try {
        [System.IO.File]::AppendAllText($qualificationTamperPath, "tampered`n", [System.Text.UTF8Encoding]::new($false))
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'qualification orchestration V2 hash tampering was accepted'
    }
    finally { [System.IO.File]::WriteAllBytes($qualificationTamperPath, $qualificationTamperBytes) }

    $qualificationCanonicalPath = Join-Path $artifactRoot `
        'scripts\windows\qualification\Qualification.OrchestrationV2.ps1'
    $qualificationCaseTemporaryPath = Join-Path $artifactRoot `
        'scripts\windows\qualification\qualification-orchestration.case-temporary'
    $qualificationWrongCasePath = Join-Path $artifactRoot `
        'scripts\windows\qualification\qualification.OrchestrationV2.ps1'
    [System.IO.File]::Move($qualificationCanonicalPath, $qualificationCaseTemporaryPath)
    [System.IO.File]::Move($qualificationCaseTemporaryPath, $qualificationWrongCasePath)
    try {
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version `
                -DevDependenciesExcluded @())
        }) -Message 'a case-drifted qualification orchestration V2 runtime could be re-manifested'
    }
    finally {
        [System.IO.File]::Move($qualificationWrongCasePath, $qualificationCaseTemporaryPath)
        [System.IO.File]::Move($qualificationCaseTemporaryPath, $qualificationCanonicalPath)
        [System.IO.File]::WriteAllBytes($canonicalManifestPath, $canonicalManifestBytes)
    }

    $bridgeProjectPath = Join-Path $artifactRoot `
        'integrations\dyson-control-bridge\DysonControlBridge.csproj'
    $bridgeManifestPath = Join-Path $artifactRoot 'artifact-manifest.json'
    $bridgeProjectBytes = [System.IO.File]::ReadAllBytes($bridgeProjectPath)
    $bridgeManifestBytes = [System.IO.File]::ReadAllBytes($bridgeManifestPath)
    try {
        $bridgeProjectText = [System.IO.File]::ReadAllText($bridgeProjectPath, [System.Text.Encoding]::UTF8).Replace(
            'DSPGAME_Data\Managed\netstandard.dll',
            'DSPGAME_Data\Managed\netstandard-missing.dll'
        )
        [System.IO.File]::WriteAllText($bridgeProjectPath, $bridgeProjectText, [System.Text.UTF8Encoding]::new($false))
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version -DevDependenciesExcluded @())
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a re-manifested artifact with a tampered Bridge netstandard dependency was accepted'
    }
    finally {
        [System.IO.File]::WriteAllBytes($bridgeProjectPath, $bridgeProjectBytes)
        [System.IO.File]::WriteAllBytes($bridgeManifestPath, $bridgeManifestBytes)
    }

    try {
        $bridgeProjectText = [System.IO.File]::ReadAllText(
            $bridgeProjectPath,
            [System.Text.Encoding]::UTF8
        ).Replace(
            '<Reference Include="netstandard">',
            '<Reference Include="netstandard" Condition="''1'' == ''0''">'
        ).Replace(
            '</ItemGroup>',
            "<!-- <Reference Include=`"netstandard`"><HintPath>`$(DysonServerRoot)\DSPGAME_Data\Managed\netstandard.dll</HintPath><Private>false</Private></Reference> --></ItemGroup>"
        )
        [System.IO.File]::WriteAllText(
            $bridgeProjectPath,
            $bridgeProjectText,
            [System.Text.UTF8Encoding]::new($false)
        )
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version `
            -DevDependenciesExcluded @())
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a conditional Bridge netstandard reference hidden by a textual decoy was accepted after re-manifesting'
    }
    finally {
        [System.IO.File]::WriteAllBytes($bridgeProjectPath, $bridgeProjectBytes)
        [System.IO.File]::WriteAllBytes($bridgeManifestPath, $bridgeManifestBytes)
    }

    $bridgeCommonPath = Join-Path $artifactRoot 'scripts\windows\bridge\DysonBridge.Common.ps1'
    $bridgeCommonBytes = [System.IO.File]::ReadAllBytes($bridgeCommonPath)
    try {
        $fixedNetstandardSpecification = `
            "name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard.dll'"
        $bridgeCommonText = [System.IO.File]::ReadAllText(
            $bridgeCommonPath,
            [System.Text.Encoding]::UTF8
        ).Replace(
            $fixedNetstandardSpecification,
            "name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard-missing.dll'"
        )
        $bridgeCommonText = "# $fixedNetstandardSpecification`n" + $bridgeCommonText
        [System.IO.File]::WriteAllText(
            $bridgeCommonPath,
            $bridgeCommonText,
            [System.Text.UTF8Encoding]::new($false)
        )
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version `
            -DevDependenciesExcluded @())
        Assert-PackageSelfTest -Condition (Test-CommandRejected {
            Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version | Out-Null
        }) -Message 'a Bridge common-script reference drift hidden by a comment decoy was accepted after re-manifesting'
    }
    finally {
        [System.IO.File]::WriteAllBytes($bridgeCommonPath, $bridgeCommonBytes)
        [System.IO.File]::WriteAllBytes($bridgeManifestPath, $bridgeManifestBytes)
    }

    foreach ($relative in $script:DysonArtifactRepositoryOnlyPaths) {
        Assert-PackageSelfTest -Condition ($archiveEntries -cnotcontains $relative) `
            -Message "an explicit repository-only path entered the release archive: $relative"
    }
    $repositoryOnlyArchiveEntries = @($archiveEntries | Where-Object {
        Test-DysonArtifactRepositoryOnlyPath -RelativePath $_
    })
    Assert-PackageSelfTest -Condition ($repositoryOnlyArchiveEntries.Count -eq 0) `
        -Message ('the release archive contains repository-only paths: ' +
            [string]::Join(', ', $repositoryOnlyArchiveEntries))
    foreach ($name in @($names.archive, $names.checksum, $names.provenance)) {
        $bytesA = [System.IO.File]::ReadAllBytes((Join-Path $packageA $name))
        $bytesB = [System.IO.File]::ReadAllBytes((Join-Path $packageB $name))
        Assert-PackageSelfTest -Condition ($bytesA.Length -eq $bytesB.Length -and
            [System.Convert]::ToBase64String($bytesA) -ceq [System.Convert]::ToBase64String($bytesB)) `
            -Message "repeated packaging changed asset bytes: $name"
    }

    $overwriteRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageA -Tag $tag `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition $overwriteRejected -Message 'an existing package directory was overwritten'

    $invalidTagRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageInvalidTag -Tag 'v01.2.3' `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition ($invalidTagRejected -and -not (Test-Path -LiteralPath $packageInvalidTag)) `
        -Message 'a non-canonical release tag was accepted'

    Copy-FixturePackage -Source $packageA -Destination $packageArchiveTamper
    [System.IO.File]::AppendAllText((Join-Path $packageArchiveTamper $names.archive), 'tamper', [System.Text.UTF8Encoding]::new($false))
    $archiveTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageArchiveTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $archiveTamperRejected -Message 'archive tampering was not detected'

    Copy-FixturePackage -Source $packageA -Destination $packageChecksumTamper
    [System.IO.File]::WriteAllText(
        (Join-Path $packageChecksumTamper $names.checksum),
        (('f' * 64) + "  $($names.archive)`n"),
        [System.Text.ASCIIEncoding]::new()
    )
    $checksumTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageChecksumTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $checksumTamperRejected -Message 'checksum tampering was not detected'

    Copy-FixturePackage -Source $packageA -Destination $packageProvenanceTamper
    $provenancePath = Join-Path $packageProvenanceTamper $names.provenance
    $provenance = [System.IO.File]::ReadAllText($provenancePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $provenance | Add-Member -NotePropertyName unexpected -NotePropertyValue 'fictional'
    [System.IO.File]::WriteAllText(
        $provenancePath,
        ($provenance | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $provenanceTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageProvenanceTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $provenanceTamperRejected -Message 'unknown provenance data was accepted'

    $commitMismatchRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageA -ExpectedTag $tag `
            -ExpectedCommit 'fedcba9876543210fedcba9876543210fedcba98' | Out-Null
    }
    Assert-PackageSelfTest -Condition $commitMismatchRejected -Message 'a provenance commit mismatch was accepted'

    [System.IO.File]::AppendAllText((Join-Path $artifactRoot 'apps\api\dist\index.js'), 'tamper', [System.Text.UTF8Encoding]::new($false))
    $invalidArtifactRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageInvalidArtifact -Tag $tag `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition ($invalidArtifactRejected -and -not (Test-Path -LiteralPath $packageInvalidArtifact)) `
        -Message 'a tampered artifact was packaged'

    [ordered]@{
        protocol = 'DYSON_CONTROL_RELEASE_PACKAGE_SELFTEST_V1'
        state = 'passed'
        dryRunWasNonMutating = $true
        deterministicZip = $true
        deterministicChecksum = $true
        deterministicProvenance = $true
        exactThreeAssetContract = $true
        validPackageVerified = $true
        overwriteRejected = $true
        invalidTagRejected = $true
        archiveTamperRejected = $true
        checksumTamperRejected = $true
        provenanceTamperRejected = $true
        commitMismatchRejected = $true
        tamperedArtifactRejected = $true
        gameRuntimeReceiptApiIncluded = $true
        hostnameWssClientQualificationApiIncluded = $true
        hostnameWssClientQualificationApiRequiredFiles = `
            $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count
        observabilityRuntimeApiIncluded = $true
        observabilityRuntimeApiRequiredFiles = $script:DysonArtifactRequiredApiObservabilityRuntimeFiles.Count
        observabilityRuntimeApiMissingFileCases = $observabilityMissingCases
        observabilityRuntimeApiMissingExtraAndTamperRejected = $true
        observabilityCaseDriftRemanifestRejected = $true
        manifestPathSeparatorDriftRejected = $true
        windowsUpdateRuntimeApiIncluded = $true
        updateRuntimeApiRequiredFiles = $script:DysonArtifactRequiredApiUpdateRuntimeFiles.Count
        gsManagerRecoverableRemovalIncluded = $true
        nebulaNetworkAssessmentIncluded = $true
        hostnameWssQualificationRuntimeIncluded = $true
        hostnameWssQualificationRuntimeRequiredFiles = `
            ($script:DysonArtifactRequiredHostnameWssQualificationFiles.Count +
                $script:DysonArtifactRequiredNebulaHostnameWssSources.Count)
        qualificationOrchestrationV2Included = $true
        qualificationOrchestrationV2RequiredFiles = `
            $script:DysonArtifactRequiredQualificationOrchestrationV2Files.Count
        qualificationOrchestrationV2MissingFileCases = $qualificationOrchestrationMissingCases
        qualificationOrchestrationV2MissingExtraAndTamperRejected = $true
        qualificationOrchestrationV2CaseDriftRemanifestRejected = $true
        qualificationFrameworkIncluded = $true
        qualificationFrameworkRequiredFiles = $script:DysonArtifactRequiredQualificationFrameworkFiles.Count
        qualificationFrameworkMissingFileCases = $qualificationFrameworkMissingCases
        strictQualificationV2Included = $true
        strictQualificationV2RequiredFiles = $script:DysonArtifactRequiredStrictQualificationV2Files.Count
        strictQualificationV2RepresentativeMissingFileCases = `
            $strictQualificationRepresentativeMissingCases
        productionQualificationDocumentationIncluded = $true
        productionQualificationDocumentationMissingRejected = $true
        privateQualificationEvidenceAndCacheExcluded = $true
        networkConnectivityDocumentationIncluded = $true
        bridgeSimulationTelemetryIncluded = $true
        bridgeFixedReferenceContractIncluded = $true
        bridgeFixedReferenceContractRemanifestedTamperRejected = $true
        bridgeFixedReferenceConditionalDecoyRejected = $true
        bridgeFixedReferenceCommentDecoyRejected = $true
        loadedSaveEvidencePublisherIncluded = $true
        repositoryBridgeSelfTestsExcluded = $true
        repositoryOnlyPathsExcluded = $true
        repositoryOnlyPathCases = $script:DysonArtifactRepositoryOnlyPaths.Count
        archiveSha256 = [string]$verifiedA.archiveSha256
        productionChanged = $false
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-release-package-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
